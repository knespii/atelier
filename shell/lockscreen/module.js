// While the screen is locked, this is all of Atelier that runs: the island
// with the padlock over GNOME's lock screen, following GNOME's check of who
// is there (lib/lockState.js), the lock screen's widgets (board.js) and its
// own password field (password.js).
// Nothing here launches anything, reads the network, shows notifications or
// takes the keyboard.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Phase, initialState, look, reduce} from '../../lib/lockState.js';
import {LockBoard} from './board.js';
import {clockLabelsOf, dialogOf, placeOverBackground, promptProgressOf, showPrompt} from './gnome.js';
import {LockIsland} from './island.js';
import {AuthObserver} from './observer.js';
import {PasswordField} from './password.js';

const SETTLE_TIME = 900; // how long a failure shows, ms
const DIMMED = 0.25; // what is left of the widgets while the prompt is up

export class LockModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     */
    constructor({settings}) {
        this._settings = settings;
        this._dialog = null;
        this._island = null;
        this._board = null;
        this._field = null;
        this._observer = null;
        this._settleId = 0;
        this._unlocking = false;
        this.state = initialState();
    }

    /** @returns {LockIsland|null} the island with the padlock */
    get island() {
        return this._island;
    }

    /** @returns {LockBoard|null} the widgets */
    get board() {
        return this._board;
    }

    enable() {
        // (Not in GDM's greeter, nor without a lock screen to follow.)
        this._dialog = Main.sessionMode.isGreeter ? null : dialogOf();
        if (!this._dialog)
            return;
        this._lockSettings = this._settings.get_child('lockscreen');
        if (this._lockSettings.get_boolean('island')) {
            this._island = new LockIsland(this._settings.get_child('bar'));
            this._island.actor.connectObject('clicked', () => showPrompt(this._dialog), this);
            // (The island grows into it.)
            if (this._lockSettings.get_boolean('password-field'))
                this._field = new PasswordField(this._island);
        }
        this._board = new LockBoard(this._lockSettings);
        if (placeOverBackground(this._dialog, this._board.layer)) {
            // (In the way of the prompt, in the middle: they make room.)
            promptProgressOf(this._dialog)?.connectObject('notify::value', () => this._dim(), this);
            this._dim();
        } else {
            this._board.destroy();
            this._board = null;
        }
        this._lockSettings.connectObject('changed::gnome-clock', () => this._syncClock(), this);
        this._syncClock();
        this._observer = new AuthObserver(this._dialog, event => this._dispatch(event));
        this._show();
    }

    // (With the island's own field, GNOME's prompt is hidden: the middle
    // stays free, and the widgets as they are.)
    _dim() {
        const progress = this._field?.standing
            ? 0 : Math.min(1, Math.max(0, promptProgressOf(this._dialog)?.value ?? 0));
        this._board.layer.opacity = Math.round(255 * (1 - (1 - DIMMED) * progress));
    }

    // GNOME's time and date, unless the lock screen's own clocks take their place.
    _syncClock(shown = this._lockSettings.get_boolean('gnome-clock')) {
        for (const label of clockLabelsOf(this._dialog))
            label.visible = shown;
    }

    _dispatch(event) {
        const before = this.state.phase;
        this.state = reduce(this.state, event);
        this._field?.follow(event, this.state);
        if (this._board)
            this._dim();
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
        const shown = look(this.state);
        this._island?.setLook(shown);
        this._field?.setLook(shown);
    }

    /**
     * The screen unlocked: the island stays a moment longer on its own.
     *
     * @returns {LockIsland|null} the island, for Atelier to destroy if it
     *   goes before the island has
     */
    handOver() {
        // (The widgets slide away with the lock screen.)
        this._unlocking = true;
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
        // (Unlocked, GNOME's prompt goes as it is: hidden.)
        this._field?.destroy({restore: !this._unlocking});
        this._field = null;
        this._island?.destroy();
        this._island = null;
        this._lockSettings?.disconnectObject(this);
        promptProgressOf(this._dialog)?.disconnectObject(this);
        this._board?.destroy({keepLayer: this._unlocking});
        this._board = null;
        // (Unlocked, the lock screen goes as it is; turned off, GNOME's own
        // clock comes back.)
        if (this._dialog && !this._unlocking)
            this._syncClock(true);
        this._lockSettings = null;
        this._dialog = null;
    }
}
