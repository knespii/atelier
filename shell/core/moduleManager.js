// Starts and stops Atelier's features ("modules") independently, so a
// failing feature is reported and the others keep working. Emits 'started'
// and 'stopped' with the id of a module, for modules that build on others.

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

    enable() {
        this._enabled = true;
        for (const entry of this._entries) {
            entry.settings?.connectObject(`changed::${entry.key}`, () => this._sync(entry), this);
            this._sync(entry);
        }
    }

    disable() {
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
