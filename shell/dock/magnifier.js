// The dock's magnification (magnification, magnification-scale,
// magnification-spread): as the pointer moves along the dock, the icon
// under it grows away from the edge and those beside it less and less,
// moving apart (lib/dockMagnify.js). Only how the icons are drawn
// changes – the dock keeps its size, nothing is laid out again. Coming
// onto the dock the magnification swells from nothing, and leaving it
// fades back, the icons with the pointer all the while.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {isHorizontal} from '../../lib/dockGeometry.js';
import {magnify} from '../../lib/dockMagnify.js';

const KEYS = ['magnification', 'magnification-scale', 'magnification-spread'];
// How long the magnification takes to swell as the pointer comes onto the
// dock (and to fade as it leaves), milliseconds.
const SWELL_TIME = 260;
// (Gently out of rest, gently into full: no jolt either way.)
const smooth = t => t * t * (3 - 2 * t);
// Where an icon grows from: the edge the dock is at.
const PIVOTS = {BOTTOM: [0.5, 1], TOP: [0.5, 0], LEFT: [0, 0.5], RIGHT: [1, 0.5]};

export class DockMagnifier {
    /**
     * @param {Dock} dock
     * @param {Gio.Settings} settings - the dock's
     */
    constructor(dock, settings) {
        this._dock = dock;
        this._settings = settings;
        this._active = false;
        this._pointer = null; // along the dock, as last seen there
        this._strength = 0; // how much of the magnification there is, 0–1
        const container = dock.container;
        this._swell = new Clutter.Timeline({actor: container, duration: Math.max(1, adjustAnimationTime(SWELL_TIME))});
        this._swell.connect('new-frame', () => this._onSwell());
        this._swell.connect('completed', () => this._onSwell(true));
        container.connectObject(
            'motion-event', (_, event) => this._onMotion(event),
            'leave-event', (_, event) => this._onLeave(event),
            this);
        settings.connectObject(...KEYS.flatMap(key => [`changed::${key}`, () => this.rest()]), this);
        // The apps changed (one opened – clicked, or by a shortcut – one
        // focused): fading back from where they are now, not snapping.
        dock.connectObject('redisplayed', () => this.rest(), 'placed', () => this.rest(), this);
    }

    get _enabled() {
        // (Not on a row that scrolls: it is cut off at its ends.)
        return this._settings.get_boolean('magnification') && !this._dock._scroll;
    }

    // The icons along the dock, at rest: [actor drawn, center along the
    // dock, item].
    _icons() {
        const dock = this._dock;
        const horizontal = isHorizontal(dock.side);
        return dock.orderedItems.filter(item => item.visible && item.child?.mapped).map(item => {
            const [x, y] = item.get_transformed_position();
            return [item.child, horizontal ? x + item.width / 2 : y + item.height / 2, item];
        }).sort((a, b) => a[1] - b[1]);
    }

    // An item's name over its icon as drawn: past the part that grew, away
    // from the edge.
    _liftLabel(item, scale) {
        const label = item.label;
        if (!label)
            return;
        const child = item.child;
        const grown = (scale - 1) * (isHorizontal(this._dock.side) ? child.height : child.width);
        const away = {BOTTOM: [0, -grown], TOP: [0, grown], LEFT: [grown, 0], RIGHT: [-grown, 0]}[this._dock.side];
        label.translation_x = away[0];
        label.translation_y = away[1];
    }

    _onMotion(event) {
        if (!this._enabled)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._pointer = isHorizontal(this._dock.side) ? x : y;
        // (Coming onto it, or back before it faded: swelling again from
        // where it is.)
        if (!this._active || this._swell.direction === Clutter.TimelineDirection.BACKWARD)
            this._swellTo(true);
        this._active = true;
        this._apply(this._pointer);
        return Clutter.EVENT_PROPAGATE;
    }

    // Swelling (or fading) from where it is now.
    _swellTo(full) {
        const swell = this._swell;
        const elapsed = swell.is_playing() ? swell.get_elapsed_time() : null;
        swell.stop();
        swell.direction = full ? Clutter.TimelineDirection.FORWARD : Clutter.TimelineDirection.BACKWARD;
        // (The part done already counts: on from there, either way.)
        const done = elapsed ?? (full ? 0 : swell.duration);
        swell.rewind();
        swell.advance(Math.round(done));
        swell.start();
    }

    _onSwell(completed = false) {
        const progress = this._swell.get_progress();
        this._strength = smooth(progress);
        if (completed && this._swell.direction === Clutter.TimelineDirection.BACKWARD) {
            this._strength = 0;
            this._reset();
            return;
        }
        if (this._pointer !== null)
            this._apply(this._pointer);
    }

    // Still on the dock (or on a grown icon over its edge), or gone.
    _onLeave(event) {
        const to = event.get_related();
        if (!to || !this._dock.container.contains(to))
            this.rest();
        return Clutter.EVENT_PROPAGATE;
    }

    _apply(pointer) {
        const icons = this._icons();
        if (icons.length === 0)
            return;
        // (An icon with the room around it, as it is laid out.)
        const horizontal = isHorizontal(this._dock.side);
        const size = horizontal ? icons[0][0].width : icons[0][0].height;
        const {scales, offsets} = magnify({
            centers: icons.map(([, center]) => center),
            size,
            pointer,
            scale: 1 + (this._settings.get_double('magnification-scale') - 1) * this._strength,
            spread: this._settings.get_double('magnification-spread'),
            // (Into the room around the icons inside the dock, a little.)
            give: this._dock.container.get_theme_node().get_padding(horizontal ? St.Side.LEFT : St.Side.TOP),
        });
        const [px, py] = PIVOTS[this._dock.side];
        // Right with the pointer: no easing of their own, no lag behind it.
        icons.forEach(([actor, , item], i) => {
            this._liftLabel(item, scales[i]);
            actor.set_pivot_point(px, py);
            actor.set({
                scale_x: scales[i],
                scale_y: scales[i],
                translation_x: horizontal ? offsets[i] : 0,
                translation_y: horizontal ? 0 : offsets[i],
            });
        });
    }

    // As at rest, exactly.
    _reset() {
        for (const [actor, , item] of this._icons()) {
            this._liftLabel(item, 1);
            actor.set({scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0});
        }
    }

    /** @param {boolean} [now] - at once (they were laid out anew) */
    rest(now = false) {
        if (!this._active)
            return;
        this._active = false;
        if (now) {
            this._swell.stop();
            this._strength = 0;
            this._pointer = null;
            this._reset();
            return;
        }
        // Fading back, the icons where the pointer last was.
        this._swellTo(false);
    }

    destroy() {
        this._swell.stop();
        this._dock.container?.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._dock.disconnectObject(this);
    }
}
