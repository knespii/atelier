// A sheet that drips from the island: a drop forms under it, falls, and
// spreads into a panel of what the island is made of (its glass, or black),
// which holds a form. Closing, the panel gathers into a drop again that
// rises back into the island. The drop and the panel are drawn by a surface
// that shows the island as well, so the two flow into each other where they
// meet; the sheet itself is only the form on it.
//
// The form may implement focus(); Esc and a click outside the sheet emit
// 'dismissed' – what that means is up to whoever opened it.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const OPEN_TIME = 820;
const CLOSE_TIME = 640;
const FADE_TIME = 140;
// Parts of the way: the drop is formed, then it lands, then it has spread.
const FORMED = 0.26;
const LANDED = 0.6;
// When the form shows on its way in.
const SHOWN = 0.84;
// Logical pixels: the drop, how near it melts into the island, the panel's
// corners (as the island's pages have them), and how far below the island
// the panel is at least.
const DROP = 20;
const BLEND = 18;
const RADIUS = 26;
const FALL = 72;

const lerp = (a, b, t) => a + (b - a) * t;
const easeOutQuad = t => 1 - (1 - t) ** 2;
const easeInQuad = t => t * t;
// Past the end a little and back, like liquid settling.
const easeOutBack = t => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;

export const LiquidSheet = GObject.registerClass({
    Signals: {
        'dismissed': {},
        'closed': {},
    },
}, class AtelierLiquidSheet extends St.Bin {
    /**
     * @param {Island} island - where it drips from
     * @param {GlassSurface} liquid - what the drop and the panel are made of;
     *   it shows the island too
     * @param {St.Widget} form - what the sheet holds
     */
    _init(island, liquid, form) {
        super._init({
            style_class: 'atelier-sheet',
            reactive: true,
            opacity: 0,
            child: form,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.form = form;
        this._island = island;
        this._liquid = liquid;
        this._grab = null;
        this._closing = null;
        this.opened = false;
        this._timeline = new Clutter.Timeline({actor: this, duration: OPEN_TIME});
        this._timeline.connect('new-frame', () => this._frame(this._timeline.get_progress()));
        this._timeline.connect('completed', () => this._onCompleted());
        this.connect('destroy', () => {
            this._timeline.stop();
            this._releaseGrab();
            this._closing?.();
        });
    }

    /** Drip, and spread into the panel. */
    open() {
        this._place();
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this.form.focus?.();
        this._frame(0);
        // From the island at rest: a page may be going back into it.
        const morph = this._island.get_transition('height') ?? this._island.get_transition('width');
        if (morph)
            morph.connectObject('stopped', () => this._timeline.start(), this);
        else
            this._timeline.start();
    }

    /**
     * Gather into a drop that goes back into the island.
     *
     * @returns {Promise} done when it is back
     */
    close() {
        if (this._closingPromise)
            return this._closingPromise;
        this._closingPromise = new Promise(resolve => {
            this._closing = resolve;
        });
        this._releaseGrab();
        this.opened = false;
        this.remove_transition('opacity');
        this.ease({opacity: 0, duration: FADE_TIME / 2, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._timeline.stop();
        this._timeline.duration = CLOSE_TIME;
        this._timeline.direction = Clutter.TimelineDirection.BACKWARD;
        // (From where it is: it may not have spread all the way yet.)
        this._timeline.advance(Math.round(this._progress * CLOSE_TIME));
        this._timeline.start();
        return this._closingPromise;
    }

    // Centered on the main monitor, a little above the middle, and below
    // the island far enough to fall.
    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);
        const below = this._island.y + this._island.height + FALL * scale;
        const x = Math.round(monitor.x + (monitor.width - width) / 2);
        const y = Math.round(Math.max(monitor.y + monitor.height * 0.42 - height / 2, below));
        this.set_position(x, y);
        this.set_size(Math.ceil(width), Math.ceil(height));
        this._rect = [x, y, Math.ceil(width), Math.ceil(height)];
    }

    // The drop at a point of the way, 0 (in the island) to 1 (the panel).
    _frame(t) {
        this._progress = t;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const island = this._island;
        const [x, y, width, height] = this._rect;
        const r = DROP * scale;
        const top = [island.x + island.width / 2, island.y + island.height];
        const end = [x + width / 2, y + height / 2];
        let center, half, radius;
        if (t < FORMED) {
            // Swelling out of the island's bottom edge.
            const u = easeOutQuad(t / FORMED);
            center = [top[0], top[1] - r * 0.5 + r * 0.9 * u];
            half = [r * u, r * u];
            radius = r * u;
        } else if (t < LANDED) {
            // Falling, faster and faster, drawn out on its way.
            const u = (t - FORMED) / (LANDED - FORMED);
            const stretch = Math.sin(Math.PI * u);
            center = [lerp(top[0], end[0], u), lerp(top[1] + r * 0.4, end[1], easeInQuad(u))];
            half = [r * (1 - 0.18 * stretch), r * (1 + 0.5 * stretch)];
            radius = Math.min(...half);
        } else {
            // Spreading: wide first, then tall, a little too far and back;
            // round as liquid until it settles into the panel's corners.
            const u = (t - LANDED) / (1 - LANDED);
            center = end;
            half = [lerp(r, width / 2, easeOutBack(u)), lerp(r, height / 2, easeOutBack(Math.max(0, u - 0.1) / 0.9))];
            radius = lerp(Math.min(...half), RADIUS * scale, easeInQuad(u));
        }
        this._liquid.setDrop(center[0], center[1], half[0], half[1], radius, BLEND * scale);
        if (!this._closingPromise && t >= SHOWN && this.opacity === 0 && !this.get_transition('opacity'))
            this.ease({opacity: 255, duration: FADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _onCompleted() {
        if (this._closingPromise) {
            this._liquid.clearDrop();
            this.emit('closed');
            this._closing?.();
            this._closing = null;
            return;
        }
        this._frame(1);
        this.opened = true;
    }

    _releaseGrab() {
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
    }

    vfunc_button_press_event(event) {
        // (Modal: clicks anywhere come here first.)
        if (!this.contains(global.stage.get_event_actor(event)))
            this.emit('dismissed');
        return Clutter.EVENT_STOP;
    }

    vfunc_key_press_event(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.emit('dismissed');
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});
