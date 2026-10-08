// The dock's delayed work, all of it in one place: timeouts, work for the
// next frame and work for when the shell is idle, each under a name. When
// the shell quits, GNOME takes its UI down with uiGroup while JS still
// runs, then turns the main loop a while longer: from then on nothing that
// waits runs, and nothing new is started.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class Timers {
    constructor() {
        this._sources = new Map(); // name → GLib source id
        this._laters = new Map(); // name → {id, callback}
        this._stopped = false;
        Main.layoutManager.uiGroup.connectObject('destroy', () => this.stop(), this);
    }

    /** @returns {boolean} whether it waits for nothing any more (the shell quits, or it is gone) */
    get stopped() {
        return this._stopped;
    }

    /**
     * Run a callback after a while, in place of one waiting under the same
     * name. It runs again after as long while it returns true.
     *
     * @param {string} name
     * @param {number} ms
     * @param {Function} callback
     */
    after(name, ms, callback) {
        this.clear(name);
        if (this._stopped)
            return;
        this._sources.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (callback() === true)
                return GLib.SOURCE_CONTINUE;
            this._sources.delete(name);
            return GLib.SOURCE_REMOVE;
        }));
    }

    /**
     * Run a callback before the next frame is drawn: once, however often it
     * is asked for until then (the latest callback asked for).
     *
     * @param {string} name
     * @param {Function} callback
     */
    later(name, callback) {
        if (this._stopped)
            return;
        const queued = this._laters.get(name);
        if (queued) {
            queued.callback = callback;
            return;
        }
        const entry = {callback, id: 0};
        entry.id = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laters.delete(name);
            entry.callback();
            return GLib.SOURCE_REMOVE;
        });
        this._laters.set(name, entry);
    }

    /**
     * Run a callback when the shell is idle, in place of one waiting under
     * the same name.
     *
     * @param {string} name
     * @param {Function} callback
     */
    idle(name, callback) {
        this.clear(name);
        if (this._stopped)
            return;
        this._sources.set(name, GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._sources.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    /**
     * @param {string} name
     * @returns {boolean} whether something waits under the name
     */
    has(name) {
        return this._sources.has(name) || this._laters.has(name);
    }

    /** @param {string} name - of what no longer runs */
    clear(name) {
        const id = this._sources.get(name);
        if (id)
            GLib.source_remove(id);
        this._sources.delete(name);
        const later = this._laters.get(name);
        if (later)
            global.compositor.get_laters().remove(later.id);
        this._laters.delete(name);
    }

    /** Nothing waiting runs, and nothing new is started. */
    stop() {
        this._stopped = true;
        this._sources.forEach(id => GLib.source_remove(id));
        this._sources.clear();
        this._laters.forEach(({id}) => global.compositor.get_laters().remove(id));
        this._laters.clear();
    }

    destroy() {
        this.stop();
        Main.layoutManager.uiGroup.disconnectObject(this);
    }
}
