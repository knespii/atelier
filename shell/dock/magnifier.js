// The dock's magnification (magnification, magnification-scale,
// magnification-spread): as the pointer moves along the dock, the icon
// under it grows away from the edge and those beside it less and less,
// moving apart (lib/dockMagnify.js). Only how the icons are drawn
// changes – the dock keeps its size, nothing is laid out again. When the
// pointer leaves, they ease back.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {isHorizontal} from '../../lib/dockGeometry.js';
import {magnify} from '../../lib/dockMagnify.js';

const KEYS = ['magnification', 'magnification-scale', 'magnification-spread'];
// Growing as the pointer comes onto the dock, and back to rest as it
// leaves, milliseconds; in between the icons follow it at once.
const ENTER_TIME = 90;
const REST_TIME = 140;
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
        const container = dock.container;
        container.connectObject(
            'motion-event', (_, event) => this._onMotion(event),
            'leave-event', (_, event) => this._onLeave(event),
            this);
        settings.connectObject(...KEYS.flatMap(key => [`changed::${key}`, () => this.rest()]), this);
        dock.connectObject('redisplayed', () => this.rest(true), 'placed', () => this.rest(true), this);
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
        this._apply(isHorizontal(this._dock.side) ? x : y);
        return Clutter.EVENT_PROPAGATE;
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
            scale: this._settings.get_double('magnification-scale'),
            spread: this._settings.get_double('magnification-spread'),
            // (Into the room around the icons inside the dock, a little.)
            give: this._dock.container.get_theme_node().get_padding(horizontal ? St.Side.LEFT : St.Side.TOP),
        });
        const [px, py] = PIVOTS[this._dock.side];
        const entering = !this._active;
        icons.forEach(([actor, , item], i) => {
            this._liftLabel(item, scales[i]);
            actor.set_pivot_point(px, py);
            const values = {
                scale_x: scales[i],
                scale_y: scales[i],
                translation_x: horizontal ? offsets[i] : 0,
                translation_y: horizontal ? 0 : offsets[i],
            };
            // Coming onto the dock (or still growing), briefly eased; then
            // right with the pointer, no lag behind it.
            if (entering || actor.get_transition('scale-x'))
                actor.ease({...values, duration: entering ? ENTER_TIME : 40, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            else
                actor.set(values);
        });
        this._active = true;
    }

    /** @param {boolean} [now] - at once (they were laid out anew) */
    rest(now = false) {
        if (!this._active)
            return;
        this._active = false;
        for (const [actor, , item] of this._icons()) {
            this._liftLabel(item, 1);
            actor.remove_all_transitions();
            actor.ease({
                scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0,
                duration: now ? 0 : REST_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    destroy() {
        this._dock.container?.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._dock.disconnectObject(this);
    }
}
