// The island on the lock screen: just the padlock, in the island's shape
// and place (a capsule floating in the bar, or a notch hanging from the top
// edge, as the bar's settings have it). It sits over GNOME's lock screen as
// the top bar does, tucked away above the top edge while the lock screen
// rests: it comes out as the password is asked. When the screen unlocks it
// stays a moment over the session's own island, which is built anew under
// it, and goes back up; the session's island comes out after it. The
// unlocking itself never waits for it.
// It is of the same glass as the session's (shell/core/glass.js), over the
// lock screen's wallpaper as it shows – sharp, or turned to glass as the
// prompt comes up – shaded as much as its light type needs; black, as the
// session's island is, with the glass off.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NO_SHADE} from '../../lib/glassLook.js';
import {EAR_RADIUS, capsuleHeight} from '../core/barMetrics.js';
import {NotchEars} from '../core/ears.js';
import {GlassSurface} from '../core/glass.js';
import {GlassLook} from '../core/glassMaterial.js';
import {SteadyTimeline} from '../core/steadyTimeline.js';
import {Island} from '../island/island.js';
import {Padlock} from './padlock.js';

const AFTERGLOW = 250; // how long the open padlock stays once unlocked, ms
const RETRACT_TIME = 280; // going back up, once unlocked
const PADDING = 5; // above and below the padlock's ring, logical pixels
// How far down the monitor its glass reaches: the island, its contour and
// its shadow.
const GLASS_REACH = 0.25;

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
     * @param {object} [options]
     * @param {Gio.Settings} [options.settings] - Atelier's: the glass
     *   (none: black)
     * @param {Clutter.Actor} [options.source] - what its glass shows: the
     *   lock screen's wallpapers (none: the wallpaper, sharp)
     */
    constructor(barSettings, {settings = null, source = null} = {}) {
        this._barSettings = barSettings;
        this._source = source;
        this._glass = null;
        this._shade = NO_SHADE;
        this._glassLook = settings ? new GlassLook(settings) : null;
        this.padlock = new Padlock();
        this._idle = new LockIdle(this.padlock);
        this.actor = new Island(this._idle);
        this.actor.add_style_class_name('atelier-lock-island');
        // (Until the password is asked.)
        this.actor.visible = false;
        Main.layoutManager.addChrome(this.actor);
        this._ears = null;
        this._ear = 0;
        this._notch = false;
        this._laterId = 0;
        this._leaving = null; // the open padlock's moment, then going back up
        this._onGone = null;

        barSettings.connectObject('changed::island-shape', () => this._syncLook(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._queueLayout(), this);
        Main.layoutManager.panelBox.connectObject('notify::allocation', () => this._queueLayout(), this);
        this.actor.connectObject(
            'notify::x', () => this._syncEars(),
            'notify::y', () => this._syncEars(),
            'notify::translation-y', () => this._syncEars(),
            'notify::width', () => this._syncEars(),
            'notify::height', () => this._syncEars(),
            'notify::visible', () => this._syncEars(),
            'notify::opacity', () => this._syncEars(),
            this);
        this._glassLook?.connectObject('changed', () => this._syncLook(), this);
        // However it goes: also with all of GNOME's UI when the shell quits.
        this.actor.connect('destroy', () => this._onDestroyed());
        this._syncLook();
    }

    /** @param {object} look - from lib/lockState.js look() */
    setLook(look) {
        if (this.actor)
            this.padlock.setLook(look);
    }

    /** Unlocked, at once, nothing moving (see Padlock.showUnlocked()). */
    showUnlocked() {
        if (this.actor)
            this.padlock.showUnlocked();
    }

    /**
     * Out of the top edge as the password is asked (and back).
     *
     * @param {number} progress - 0 tucked away … 1 out
     */
    reveal(progress) {
        if (!this.actor)
            return;
        const p = Math.min(1, Math.max(0, progress));
        this.actor.set({
            visible: p > 0,
            translation_y: -Math.ceil(this.actor.height) * (1 - p),
            // (Not on a monitor over this one, on its way.)
            opacity: Math.round(255 * Math.min(1, p * 2)),
        });
    }

    /** A failure: the ring cramps up, the padlock shakes its head. */
    shake() {
        if (this.actor)
            this.padlock.shake();
    }

    /** @returns {GlassSurface|null} its glass (none: black) */
    get glass() {
        return this._glass;
    }

    /** @returns {GlassLook|null} the glass as it is to be drawn (shell/core/glassMaterial.js) */
    get glassLook() {
        return this._glassLook;
    }

    /**
     * The extra shade its glass takes, where its light type would not read
     * otherwise (lib/vibrancy.js promptShade()): eased to it.
     *
     * @param {object} shade - {dim, veil}
     */
    setShade(shade) {
        this._shade = shade ?? NO_SHADE;
        this._glass?.setShade(this._shade);
    }

    // A notch curves into the top edge with ears; a capsule floats. Of
    // glass, or black with the glass off (black ears).
    _syncLook() {
        if (!this.actor)
            return;
        this._notch = this._barSettings.get_string('island-shape') === 'notch';
        this._ear = this._notch ? EAR_RADIUS : 0;
        if (this._notch)
            this.actor.add_style_class_name('atelier-island-notch');
        else
            this.actor.remove_style_class_name('atelier-island-notch');
        const glass = Boolean(this._glassLook?.glass);
        if (glass && !this._glass) {
            this._glass = new GlassSurface({reach: GLASS_REACH, look: this._glassLook.look,
                light: this._glassLook.light, source: this._source});
            this._glass.setShade(this._shade);
            Main.layoutManager.uiGroup.insert_child_below(this._glass, this.actor);
            this.actor.add_style_class_name('atelier-island-glass');
        } else if (!glass && this._glass) {
            this.actor.remove_style_class_name('atelier-island-glass');
            this._glass.destroy();
            this._glass = null;
        }
        this._glass?.setLook(this._glassLook.look, this._glassLook.light);
        const ears = this._notch && !glass;
        if (ears && !this._ears) {
            this._ears = new NotchEars(this.actor);
        } else if (!ears && this._ears) {
            this._ears.destroy();
            this._ears = null;
        }
        this._syncEars();
        this._queueLayout();
    }

    // The ears, or the glass, where the island is (out of the top edge, or
    // on its way).
    _syncEars() {
        const actor = this.actor;
        if (!actor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const shown = actor.visible && actor.opacity > 0;
        const y = actor.y + actor.translation_y;
        if (this._ears) {
            this._ears.show(shown, actor.opacity);
            this._ears.setShape(actor.x, y, actor.width, this._ear * scale);
        }
        const glass = this._glass;
        if (glass) {
            glass.visible = shown;
            glass.opacity = actor.opacity;
            if (shown) {
                const node = actor.get_theme_node();
                glass.setShape(actor.x, y, actor.width, actor.height, node.get_border_radius(St.Corner.TOPLEFT),
                    node.get_border_radius(St.Corner.BOTTOMLEFT), this._ear * scale);
            }
        }
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
     * longer (if it is out) and goes back up, then the island goes.
     *
     * @param {Function} [onGone] - called once it has gone, however it goes
     */
    handOver(onGone = null) {
        this._onGone = onGone;
        if (!this.actor?.visible) {
            this.destroy();
            return;
        }
        Main.layoutManager.uiGroup.set_child_above_sibling(this.actor, null);
        if (this._glass)
            Main.layoutManager.uiGroup.set_child_below_sibling(this._glass, this.actor);
        this.showUnlocked();
        // (Counted in frames that come, as the padlock's moves: GNOME stops
        // the shell a moment now, turning its other extensions on.)
        this._leaving = new SteadyTimeline(this.actor, AFTERGLOW, {onCompleted: () => this._retract()});
        this._leaving.start();
    }

    // Back up out of sight, then gone.
    _retract() {
        const actor = this.actor;
        const duration = adjustAnimationTime(RETRACT_TIME);
        if (!actor || duration <= 0) {
            this.destroy();
            return;
        }
        const [fromY, fromOpacity] = [actor.translation_y, actor.opacity];
        const toY = -Math.ceil(actor.y + actor.height);
        this._leaving = new SteadyTimeline(actor, duration, {
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onFrame: progress => actor.set({
                translation_y: fromY + (toY - fromY) * progress,
                opacity: Math.round(fromOpacity * (1 - progress)),
            }),
            onCompleted: () => this.destroy(),
        });
        this._leaving.start();
    }

    destroy() {
        if (!this.actor) {
            this._gone();
            return;
        }
        this._ears?.destroy();
        this._ears = null;
        this._glass?.destroy();
        this._glass = null;
        this.actor.destroy();
    }

    _onDestroyed() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._leaving?.stop();
        this._leaving = null;
        this._laterId = 0;
        this._barSettings.disconnectObject(this);
        this._glassLook?.disconnectObject(this);
        this._glassLook?.destroy();
        this._glassLook = null;
        // (Its glass went with it, or goes with the rest of the UI.)
        this._glass = null;
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.panelBox.disconnectObject(this);
        // (Ears left are going with the rest of the UI.)
        this._ears = null;
        this.actor = null;
        this._gone();
    }

    _gone() {
        const onGone = this._onGone;
        this._onGone = null;
        onGone?.();
    }
}
