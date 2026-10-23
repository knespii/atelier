// While the screen is locked, this is all of Atelier that runs: the island
// with the padlock over GNOME's lock screen, following GNOME's check of who
// is there (lib/lockState.js), the lock screen's widgets (board.js) and its
// own password popup (password.js). The wallpaper stays sharp until the
// password is asked, and turns to glass as the prompt comes up (glass.js):
// blurred as GNOME blurs it, its colours kept.
// Nothing here launches anything, reads the network, shows notifications or
// takes the keyboard.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Phase, initialState, look, reduce} from '../../lib/lockState.js';
import {LockBoard} from './board.js';
import {LockGlass} from './glass.js';
import {
    clockLabelsOf, dialogOf, placeOverBackground, promptProgressOf, showPrompt, wallpaperBlursOf,
} from './gnome.js';
import {LockIsland} from './island.js';
import {AuthObserver} from './observer.js';
import {PasswordField} from './password.js';

const SETTLE_TIME = 900; // how long a failure shows, ms
// Unlocked, GNOME goes on once the padlock is shown open – at most this
// long after, ms (it is never held up longer, whatever happens).
const SHOWN_WAIT = 100;
const GAP = 20; // between a clock that goes up and the popup, or the island; logical pixels
// How slowly the room made follows GNOME's prompt coming up (which takes
// 300 ms): about half a second to get there, as the popup spreads out.
const LAG = 150;
// GNOME's blur of the lock screen's wallpaper (ui/unlockDialog.js), if it
// can't be read.
const BLUR = {radius: 90, brightness: 0.65};

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
        this._room = 0;
        this._following = null;
        this._glass = null;
        this.state = initialState();
    }

    /** @returns {number} how much room is made for the prompt: 0 … 1 */
    get room() {
        return this._room;
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
            // (It pops up right under the island.)
            if (this._lockSettings.get_boolean('password-field'))
                this._field = new PasswordField(this._island);
        }
        this._board = new LockBoard(this._lockSettings, {palette: this._settings.get_child('palette')});
        if (!placeOverBackground(this._dialog, this._board.layer)) {
            this._board.destroy();
            this._board = null;
        }
        // GNOME's blur at its fullest, as it has set it.
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [blur] = wallpaperBlursOf(this._dialog);
        this._glass = new LockGlass(this._dialog,
            blur?.radius > 0 ? {radius: blur.radius / scale, brightness: blur.brightness} : BLUR);
        // As the prompt comes up (or the popup asking instead), and as GNOME
        // sets its blur anew.
        promptProgressOf(this._dialog)?.connectObject('notify::value', () => this._follow(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor', () => this._makeRoom(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._makeRoom(), this);
        this._room = this._progress();
        this._makeRoom();
        this._lockSettings.connectObject('changed::gnome-clock', () => this._syncClock(), this);
        this._syncClock();
        this._observer = new AuthObserver(this._dialog, event => this._dispatch(event));
        this._show();
        // Unlocked, GNOME turns its other extensions on again and the shell
        // stops a moment: by then the padlock shows open, still – drawn
        // once before GNOME goes on (a frame later).
        this._injections = new InjectionManager();
        const module = this;
        this._injections.overrideMethod(this._dialog, 'finish', original => function (onComplete) {
            module._shownUnlocked(() => original.call(this, onComplete));
        });
    }

    // The padlock open, drawn once; then go on – also if anything fails.
    _shownUnlocked(goOn) {
        let gone = false;
        const proceed = () => {
            if (gone)
                return;
            gone = true;
            global.stage.disconnectObject(proceed);
            goOn();
        };
        try {
            this._dispatch({type: 'complete'});
            global.stage.connectObject('after-paint', () => {
                global.stage.disconnectObject(proceed);
                GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                    proceed();
                    return GLib.SOURCE_REMOVE;
                });
            }, proceed);
            global.stage.queue_redraw();
        } catch (e) {
            console.error('Atelier: showing the padlock open failed', e);
            proceed();
            return;
        }
        GLib.timeout_add(GLib.PRIORITY_HIGH, SHOWN_WAIT, () => {
            proceed();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** @returns {number} GNOME's, from the clock (0) to the prompt (1) */
    _progress() {
        return Math.min(1, Math.max(0, promptProgressOf(this._dialog)?.value ?? 0));
    }

    // Room made a little after GNOME's prompt, frame by frame (a swipe up
    // too): smoothly, whichever way it goes.
    _follow() {
        const lag = adjustAnimationTime(LAG);
        if (lag <= 0) {
            this._room = this._progress();
            this._makeRoom();
            return;
        }
        if (this._following)
            return;
        this._following = new Clutter.Timeline({actor: Main.layoutManager.uiGroup, duration: 1000, repeat_count: -1});
        this._following.connect('new-frame', timeline => {
            const target = this._progress();
            const step = 1 - Math.exp(-timeline.get_delta() / lag);
            this._room += (target - this._room) * step;
            if (Math.abs(target - this._room) < 0.002) {
                this._room = target;
                this._stopFollowing();
            }
            this._makeRoom();
        });
        this._following.start();
    }

    _stopFollowing() {
        this._following?.stop();
        this._following = null;
    }

    // GNOME's prompt comes up the same way whether it shows or the popup
    // asks instead: the wallpaper turns to glass as it does, and the
    // widgets make room in the middle.
    _makeRoom(animate = false) {
        // (Unlocked, it all slides away as it is, the wallpaper coming
        // sharp again.)
        if (this._unlocking)
            return;
        const progress = this._room;
        if (this.state.phase === Phase.SUCCESS)
            this._glass.release();
        else
            this._glass.set(progress);
        this._island?.reveal(progress);
        if (!this._board)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const island = this._island?.actor;
        const monitor = Main.layoutManager.primaryMonitor;
        const top = (island ? island.y + island.height - monitor.y : 0) + GAP * scale;
        this._board.makeRoom(progress, this._field?.standing ? this._field.rect : null, top, GAP * scale, animate);
    }

    // GNOME's time and date (and the hint under them, which would be left
    // on its own), unless the lock screen's own clocks take their place.
    _syncClock(shown = this._lockSettings.get_boolean('gnome-clock')) {
        for (const label of clockLabelsOf(this._dialog))
            label.visible = shown;
    }

    _dispatch(event) {
        const before = this.state.phase;
        this.state = reduce(this.state, event);
        this._field?.follow(event, this.state);
        // (The popup may have come up, or grown with what GNOME says.)
        this._makeRoom(true);
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
        // (Unlocked: at once, nothing moving.)
        if (this.state.phase === Phase.SUCCESS)
            this._island?.showUnlocked();
        else
            this._island?.setLook(look(this.state));
    }

    /**
     * The screen unlocked: the island stays a moment longer on its own.
     *
     * @param {Function} [onGone] - called once the island has gone up (at
     *   once without one)
     * @returns {LockIsland|null} the island, for Atelier to destroy if it
     *   goes before the island has
     */
    handOver(onGone = null) {
        // (The widgets slide away with the lock screen.)
        this._unlocking = true;
        const island = this._island;
        this._island = null;
        island?.actor?.disconnectObject(this);
        if (island)
            island.handOver(onGone);
        else
            onGone?.();
        return island;
    }

    disable() {
        this._injections?.clear();
        this._injections = null;
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
        this._observer?.destroy();
        this._observer = null;
        this._stopFollowing();
        // (Unlocked, GNOME's prompt goes as it is: hidden.)
        this._field?.destroy({restore: !this._unlocking});
        this._field = null;
        this._island?.destroy();
        this._island = null;
        this._lockSettings?.disconnectObject(this);
        promptProgressOf(this._dialog)?.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._board?.destroy({keepLayer: this._unlocking});
        this._board = null;
        // (Unlocked, the lock screen goes as it is, coming sharp; turned
        // off, GNOME's own clock and blur come back.)
        if (this._dialog && !this._unlocking) {
            this._syncClock(true);
            this._glass?.restore();
        }
        this._glass = null;
        this._lockSettings = null;
        this._dialog = null;
    }
}
