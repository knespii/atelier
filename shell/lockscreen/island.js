// The island on the lock screen: just the padlock, in the island's shape
// and place (a capsule floating in the bar, or a notch hanging from the top
// edge, as the bar's settings have it). It sits over GNOME's lock screen as
// the top bar does; a click on it brings up the password prompt. When the
// screen unlocks it stays a moment over the session's own island, which is
// built anew under it, and fades: the unlocking itself never waits for it.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {wiggle} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {EAR_RADIUS, capsuleHeight} from '../core/barMetrics.js';
import {NotchEars} from '../core/ears.js';
import {Island} from '../island/island.js';
import {Padlock} from './padlock.js';

const AFTERGLOW = 450; // how long the open padlock stays once unlocked, ms
const FADE_TIME = 250;
const PADDING = 5; // above and below the padlock's ring, logical pixels

// The island at rest: the padlock.
const LockIdle = GObject.registerClass({
    Signals: {'changed': {}},
}, class AtelierLockIdle extends St.BoxLayout {
    _init(padlock) {
        super._init({style_class: 'atelier-island-idle atelier-lock-idle'});
        this.add_child(padlock);
    }
});

export class LockIsland {
    /**
     * @param {Gio.Settings} barSettings - the bar's: the island's shape
     */
    constructor(barSettings) {
        this._barSettings = barSettings;
        this.padlock = new Padlock();
        this._idle = new LockIdle(this.padlock);
        this.actor = new Island(this._idle);
        this.actor.add_style_class_name('atelier-lock-island');
        Main.layoutManager.addChrome(this.actor);
        this._ears = null;
        this._ear = 0;
        this._notch = false;
        this._laterId = 0;
        this._timeoutId = 0;

        barSettings.connectObject('changed::island-shape', () => this._syncLook(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._queueLayout(), this);
        Main.layoutManager.panelBox.connectObject('notify::allocation', () => this._queueLayout(), this);
        this.actor.connectObject(
            'notify::x', () => this._syncEars(),
            'notify::y', () => this._syncEars(),
            'notify::width', () => this._syncEars(),
            'notify::visible', () => this._syncEars(),
            'notify::opacity', () => this._syncEars(),
            this);
        // However it goes: also with all of GNOME's UI when the shell quits.
        this.actor.connect('destroy', () => this._onDestroyed());
        this._syncLook();
    }

    /** @param {object} look - from lib/lockState.js look() */
    setLook(look) {
        if (this.actor)
            this.padlock.setLook(look);
    }

    /** A failure: the padlock shakes its head. */
    shake() {
        if (this.actor)
            wiggle(this.padlock, {offset: 3, duration: 65, wiggleCount: 3});
    }

    // A notch curves into the top edge with ears; a capsule floats.
    _syncLook() {
        this._notch = this._barSettings.get_string('island-shape') === 'notch';
        this._ear = this._notch ? EAR_RADIUS : 0;
        if (this._notch)
            this.actor.add_style_class_name('atelier-island-notch');
        else
            this.actor.remove_style_class_name('atelier-island-notch');
        if (this._notch && !this._ears) {
            this._ears = new NotchEars(this.actor);
        } else if (!this._notch && this._ears) {
            this._ears.destroy();
            this._ears = null;
        }
        this._syncEars();
        this._queueLayout();
    }

    _syncEars() {
        if (!this._ears || !this.actor)
            return;
        const actor = this.actor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._ears.show(actor.visible && actor.opacity > 0, actor.opacity);
        this._ears.setShape(actor.x, actor.y, actor.width, this._ear * scale);
    }

    _queueLayout() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._layout();
            return GLib.SOURCE_REMOVE;
        });
    }

    // In the middle of the main monitor's top bar, as the session's island.
    _layout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this.actor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const panelHeight = Main.panel.height || 32 * scale;
        // Taller than the bar when the padlock's ring needs it.
        const [, padlock] = this.padlock.get_preferred_height(-1);
        const height = Math.max(this._notch ? panelHeight : capsuleHeight(panelHeight, scale),
            Math.ceil(padlock + 2 * PADDING * scale));
        const restyled = this._idle.height !== height;
        this._idle.height = height;
        const panelY = Main.panel.has_allocation() ? Main.panel.get_transformed_position()[1] : monitor.y;
        const top = this._notch ? panelY : Math.max(monitor.y, Math.round(panelY + (panelHeight - height) / 2));
        this.actor.setAnchor(Math.round(monitor.x + monitor.width / 2), top);
        if (restyled)
            this.actor.relayout();
    }

    /**
     * The screen unlocked: over everything, the open padlock stays a moment
     * longer and fades, then the island goes.
     */
    handOver() {
        if (!this.actor)
            return;
        Main.layoutManager.uiGroup.set_child_above_sibling(this.actor, null);
        this.setLook({shackle: 'open', ring: 'fill', tone: 'green'});
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, AFTERGLOW, () => {
            this._timeoutId = 0;
            this.actor?.ease({
                opacity: 0,
                duration: FADE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => this.destroy(),
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (!this.actor)
            return;
        this._ears?.destroy();
        this._ears = null;
        this.actor.destroy();
    }

    _onDestroyed() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._laterId = this._timeoutId = 0;
        this._barSettings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.panelBox.disconnectObject(this);
        // (Ears left are going with the rest of the UI.)
        this._ears = null;
        this.actor = null;
    }
}
