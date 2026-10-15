// While the screen is locked, this is all of Atelier that runs: the island
// with the padlock over GNOME's lock screen, following GNOME's check of who
// is there (lib/lockState.js). Nothing here launches anything, reads the
// network, shows notifications or takes the keyboard.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Phase, initialState, look, reduce} from '../../lib/lockState.js';
import {dialogOf, showPrompt} from './gnome.js';
import {LockIsland} from './island.js';
import {AuthObserver} from './observer.js';

const SETTLE_TIME = 900; // how long a failure shows, ms

export class LockModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     */
    constructor({settings}) {
        this._settings = settings;
        this._dialog = null;
        this._island = null;
        this._observer = null;
        this._settleId = 0;
        this.state = initialState();
    }

    /** @returns {LockIsland|null} the island with the padlock */
    get island() {
        return this._island;
    }

    enable() {
        // (Not in GDM's greeter, nor without a lock screen to follow.)
        this._dialog = Main.sessionMode.isGreeter ? null : dialogOf();
        if (!this._dialog)
            return;
        if (this._settings.get_child('lockscreen').get_boolean('island')) {
            this._island = new LockIsland(this._settings.get_child('bar'));
            this._island.actor.connectObject('clicked', () => showPrompt(this._dialog), this);
        }
        this._observer = new AuthObserver(this._dialog, event => this._dispatch(event));
        this._show();
    }

    _dispatch(event) {
        const before = this.state.phase;
        this.state = reduce(this.state, event);
        if (this.state.phase === Phase.FAILED && before !== Phase.FAILED) {
            this._island?.shake();
            this._settleLater();
        }
        this._show();
    }

    _settleLater() {
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_TIME, () => {
            this._settleId = 0;
            this._dispatch({type: 'settle'});
            return GLib.SOURCE_REMOVE;
        });
    }

    _show() {
        this._island?.setLook(look(this.state));
    }

    /**
     * The screen unlocked: the island stays a moment longer on its own.
     *
     * @returns {LockIsland|null} the island, for Atelier to destroy if it
     *   goes before the island has
     */
    handOver() {
        const island = this._island;
        this._island = null;
        island?.actor?.disconnectObject(this);
        island?.handOver();
        return island;
    }

    disable() {
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
        this._observer?.destroy();
        this._observer = null;
        this._island?.destroy();
        this._island = null;
        this._dialog = null;
    }
}
