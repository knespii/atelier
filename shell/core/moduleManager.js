// Starts and stops Atelier's features ("modules") independently, so a
// failing feature is reported and the others keep working. Emits 'started'
// and 'stopped' with the id of a module, for modules that build on others.

import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class ModuleManager extends EventEmitter {
    /**
     * @param {object} context - shared objects handed to every module
     */
    constructor(context) {
        super();
        this._context = context;
        this._entries = [];
        this._enabled = false;
        this._queue = null; // what is still to start, enabled in turn
        this._turnId = 0;
    }

    /**
     * Register a module. Modules start in registration order and stop in
     * reverse order, so later modules may use earlier ones.
     *
     * @param {string} id
     * @param {Function} create - (context, manager) => object with enable() and disable()
     * @param {object} [options]
     * @param {Gio.Settings} [options.settings] - settings holding the module's switch
     * @param {string} [options.key] - boolean key turning the module on and off
     */
    register(id, create, {settings = null, key = null} = {}) {
        this._entries.push({id, create, settings, key, instance: null});
    }

    /**
     * @param {string} id
     * @returns {object|null} the running module
     */
    get(id) {
        return this._entries.find(entry => entry.id === id)?.instance ?? null;
    }

    /** @returns {boolean} whether the modules are on (as their switches have it) */
    get enabled() {
        return this._enabled;
    }

    enable() {
        if (this._enabled)
            return;
        this._enabled = true;
        for (const entry of this._entries) {
            entry.settings?.connectObject(`changed::${entry.key}`, () => this._sync(entry), this);
            this._sync(entry);
        }
    }

    /**
     * Start them one at a time, each when the shell has a moment, so that
     * the frames go on in between (just unlocked, GNOME's lock screen
     * sliding away); those named in `later` only once `until` is done.
     *
     * @param {object} [options]
     * @param {string[]} [options.later] - ids of the heavier modules
     * @param {Promise} [options.until] - when they may start
     */
    enableInTurn({later = [], until = Promise.resolve()} = {}) {
        if (this._enabled)
            return;
        this._enabled = true;
        // (A switch turned meanwhile: as always.)
        for (const entry of this._entries)
            entry.settings?.connectObject(`changed::${entry.key}`, () => this._sync(entry), this);
        const queue = this._entries.filter(entry => !later.includes(entry.id));
        this._queue = queue;
        this._next();
        until.then(() => {
            if (this._queue !== queue)
                return;
            queue.push(...this._entries.filter(entry => later.includes(entry.id)));
            this._next();
        });
    }

    // The next one in turn, on the main loop's next idle moment.
    _next() {
        if (this._turnId || !this._queue?.length)
            return;
        this._turnId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._turnId = 0;
            const entry = this._queue?.shift();
            if (entry)
                this._sync(entry);
            this._next();
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._turnId)
            GLib.source_remove(this._turnId);
        this._turnId = 0;
        this._queue = null;
        this._enabled = false;
        for (const entry of [...this._entries].reverse()) {
            entry.settings?.disconnectObject(this);
            this._stop(entry);
        }
    }

    _wanted(entry) {
        return this._enabled && (!entry.settings || entry.settings.get_boolean(entry.key));
    }

    _sync(entry) {
        if (this._wanted(entry) && !entry.instance)
            this._start(entry);
        else if (!this._wanted(entry) && entry.instance)
            this._stop(entry);
    }

    _start(entry) {
        let instance = null;
        try {
            instance = entry.create(this._context, this);
            instance.enable();
            entry.instance = instance;
            this.emit('started', entry.id);
        } catch (e) {
            console.error(`Atelier: the ${entry.id} module could not start`, e);
            // (Not on the lock screen, where it would sit in its list.)
            if (!Main.sessionMode.isLocked)
                Main.notifyError('Atelier', `The ${entry.id} feature could not start: ${e.message}`);
            try {
                instance?.disable();
            } catch {
                // half-started module; nothing more to clean up
            }
        }
    }

    _stop(entry) {
        const instance = entry.instance;
        entry.instance = null;
        try {
            instance?.disable();
        } catch (e) {
            console.error(`Atelier: the ${entry.id} module did not stop cleanly`, e);
        }
        if (instance)
            this.emit('stopped', entry.id);
    }
}
