// A sheet that drips from the island: as the island has all but drawn back
// (from the page it showed), a drop swells out of its bottom and hangs from
// it on a neck, which thins out until it snaps; the drop falls and spreads
// into a panel of what the island is made of (its glass, or black), which
// holds a form.
// Closing, the panel gathers into a drop again that rises back into the
// island – or runs off to a place on the screen's edge and into it (where a
// new note's paper then comes out). The drop and the panel are drawn by a
// surface that shows the island as well, so they flow into each other where
// they meet; the sheet itself is only the form on it.
//
// The form may implement focus(); Esc and a click outside the sheet emit
// 'dismissed' – what that means is up to whoever opened it.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const OPEN_TIME = 1150;
const CLOSE_TIME = 760;
const AWAY_TIME = 950;
const FADE_TIME = 140;
// Parts of the way: the island has all but drawn back from the page it
// showed (its morph does most of the way early), the drop has swollen out
// of it, it hangs from it, its neck has snapped, it has landed, and the
// form shows on its way in.
const BACK = 0.1;
const SWOLLEN = 0.24;
const HANG = 0.44;
const SNAPPED = 0.52;
const LANDED = 0.74;
const SHOWN = 0.9;
// Off to the edge, parts of the way: gathered into a drop where the panel
// was, at the edge, gone into it.
const GATHERED = 0.3;
const ARRIVED = 0.82;
// Logical pixels the drop arcs up on its way there.
const ARC = 40;
// Logical pixels: the drop, how near things melt into each other, the
// panel's corners (as the island's pages have them), and how far below the
// island at rest the panel is at least.
const DROP = 20;
const BLEND = 18;
const RADIUS = 26;
const FALL = 72;

// With animations off, GNOME makes every duration 0 – and a timeline of no
// time never starts, nor ends: the sheet would neither show nor close. One
// millisecond is over within a frame.
const timelineTime = msecs => Math.max(1, adjustAnimationTime(msecs));

const lerp = (a, b, t) => a + (b - a) * t;
const easeOutQuad = t => 1 - (1 - t) ** 2;
const easeInQuad = t => t * t;
const easeInOutQuad = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
// Past the end a little and back, like liquid settling.
const easeOutBack = t => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2;

export const LiquidSheet = GObject.registerClass({
    Signals: {
        'dismissed': {},
        'closed': {},
        // Run off to the edge, its drop has reached it.
        'arrived': {},
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
        this._progress = 0;
        this.opened = false;
        this._timeline = new Clutter.Timeline({actor: this, duration: timelineTime(OPEN_TIME)});
        this._timeline.connect('new-frame', () => {
            const t = this._timeline.get_progress();
            if (this._to)
                this._frameAway(t);
            else
                this._frame(t);
        });
        this._timeline.connect('completed', () => this._onCompleted());
        this.connect('destroy', () => {
            this._timeline.stop();
            this._releaseGrab();
            this._closing?.();
        });
    }

    /**
     * Drip, and spread into the panel – right away, as a page goes back into
     * the island.
     */
    open() {
        this._place();
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this.form.focus?.();
        this._frame(0);
        this._timeline.start();
    }

    /**
     * Gather into a drop that goes back into the island – or, given a place
     * on the screen's left or right edge, runs off there and into it.
     *
     * @param {object|null} [to] - {x, y, side}: the place on the edge
     * @returns {Promise} done when it is back (or gone)
     */
    close(to = null) {
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
        if (to && this._drop) {
            // (From the drop as it is: it may not have spread all the way.)
            this._to = to;
            this._from = this._drop;
            this._timeline.duration = timelineTime(AWAY_TIME);
            this._timeline.direction = Clutter.TimelineDirection.FORWARD;
            this._timeline.rewind();
            this._timeline.start();
            return this._closingPromise;
        }
        const duration = timelineTime(CLOSE_TIME);
        this._timeline.duration = duration;
        this._timeline.direction = Clutter.TimelineDirection.BACKWARD;
        // (From where it is: it may not have spread all the way yet.)
        this._timeline.advance(Math.round(this._progress * duration));
        this._timeline.start();
        return this._closingPromise;
    }

    // Centered on the main monitor, a little above the middle, and below
    // the island at rest far enough to fall.
    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);
        const rest = this._island.restRect() ?? [0, this._island.y, 0, this._island.height];
        const below = rest[1] + rest[3] + FALL * scale;
        const x = Math.round(monitor.x + (monitor.width - width) / 2);
        const y = Math.round(Math.max(monitor.y + monitor.height * 0.42 - height / 2, below));
        this.set_position(x, y);
        this.set_size(Math.ceil(width), Math.ceil(height));
        this._rect = [x, y, Math.ceil(width), Math.ceil(height)];
    }

    // The drop at a point of the way, 0 (in the island) to 1 (the panel).
    // Until it falls, it goes with the island as it is (drawing back).
    _frame(t) {
        this._progress = t;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const island = this._island;
        const [x, y, width, height] = this._rect;
        const r = DROP * scale;
        const centerX = island.x + island.width / 2;
        const bottom = island.y + island.height;
        const bead = r * 0.6;
        const hung = [centerX, bottom + r * 1.6];
        const end = [x + width / 2, y + height / 2];
        let center, half, radius;
        if (t < BACK) {
            // Nothing yet, while the island draws back.
            center = [centerX, bottom];
            half = [0, 0];
            radius = 0;
        } else if (t < SWOLLEN) {
            // Swelling out of the island's bottom edge (with the island, the
            // last of the way it draws back).
            const size = bead * easeOutQuad((t - BACK) / (SWOLLEN - BACK));
            center = [centerX, bottom + size * 0.1];
            half = [size, size];
            radius = size;
        } else if (t < HANG) {
            // Into a drop that sags from the island.
            const u = easeInOutQuad((t - SWOLLEN) / (HANG - SWOLLEN));
            const size = lerp(bead, r, u);
            center = [centerX, bottom + lerp(bead * 0.1, r * 1.6, u)];
            half = [size, size * (1 + 0.12 * u)];
            radius = size;
        } else if (t < LANDED) {
            // Falling, faster and faster, drawn out on its way.
            const u = (t - HANG) / (LANDED - HANG);
            const stretch = Math.sin(Math.PI * u);
            center = [lerp(hung[0], end[0], u), lerp(hung[1], end[1], easeInQuad(u))];
            half = [r * (1 - 0.18 * stretch), r * (1.12 + 0.4 * stretch)];
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
        this._drop = {center, half, radius};

        // Its neck, from the island down to it as it sags: thinner the
        // further it hangs, until it snaps as the drop lets go.
        let thick = 0;
        if (t >= SWOLLEN && t < HANG)
            thick = lerp(r * 0.5, r * 0.14, (t - SWOLLEN) / (HANG - SWOLLEN));
        else if (t >= HANG && t < SNAPPED)
            thick = r * 0.14 * (1 - (t - HANG) / (SNAPPED - HANG));
        if (thick > 0.5 * scale && center[1] > bottom)
            this._liquid.setNeck(centerX, bottom - 2 * scale, center[1], thick);
        else
            this._liquid.setNeck(centerX, 0, 0, 0);

        if (!this._closingPromise && t >= SHOWN && this.opacity === 0 && !this.get_transition('opacity'))
            this.ease({opacity: 255, duration: FADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Off to the edge: the panel gathers into a drop where it is, which runs
    // there in an arc, drawn out on its way, flattens against the edge and
    // goes into it.
    _frameAway(t) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const r = DROP * scale;
        const {center: start, half: spread, radius: corners} = this._from;
        const {x, y, side} = this._to;
        const inward = side === 'left' ? 1 : -1;
        let center, half, radius;
        if (t < GATHERED) {
            const u = easeInOutQuad(t / GATHERED);
            center = start;
            half = [lerp(spread[0], r, u), lerp(spread[1], r, Math.min(1, u * 1.15))];
            radius = Math.min(lerp(corners, r, u), ...half);
        } else if (t < ARRIVED) {
            const u = (t - GATHERED) / (ARRIVED - GATHERED);
            const along = easeInOutQuad(u);
            const stretch = Math.sin(Math.PI * u);
            const end = [x + inward * r, y];
            center = [lerp(start[0], end[0], along), lerp(start[1], end[1], along) - ARC * scale * Math.sin(Math.PI * along)];
            half = [r * (1 + 0.5 * stretch), r * (1 - 0.22 * stretch)];
            radius = Math.min(...half);
        } else {
            const u = easeInQuad((t - ARRIVED) / (1 - ARRIVED));
            const width = r * (1 - u);
            center = [x + inward * width, y];
            half = [width, r * (1 + 0.6 * u)];
            radius = Math.min(width, r);
            this._arrive();
        }
        this._liquid.setDrop(center[0], center[1], half[0], half[1], radius, BLEND * scale);
        this._liquid.setNeck(center[0], 0, 0, 0);
    }

    _arrive() {
        if (this._arrived)
            return;
        this._arrived = true;
        this.emit('arrived');
    }

    _onCompleted() {
        if (this._closingPromise) {
            // (Without animations, no frame on the way said so.)
            if (this._to)
                this._arrive();
            this._liquid.clearDrop();
            this.emit('closed');
            this._closing?.();
            this._closing = null;
            return;
        }
        this._frame(1);
        this.opened = true;
        // (Without animations it never faded in on its way.)
        if (this.opacity === 0 && !this.get_transition('opacity'))
            this.opacity = 255;
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
