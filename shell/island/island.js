// The island: one black capsule in the middle of the top bar that changes
// shape. At rest it shows the time; it grows into whatever page it shows
// (a glance, a toast, the switcher, the power menu…) and back.
//
// A page is any widget that emits 'close-request' when it wants to go away.
// The island follows its size when its content changes (a menu unfolding
// in it, say); a page may also emit 'resized' to have the change animated.
// It may implement handleKeyPress(event) and handleScroll(event), which
// return whether they handled the event, and focus(), called when it opens
// with the keyboard.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/** How long the island takes to change shape, in milliseconds. */
export const MORPH_TIME = 280;
const FADE_OUT_TIME = 90;
const FADE_IN_TIME = 170;
const FADE_IN_DELAY = 70;

/**
 * @param {Clutter.Actor} page
 * @returns {number[]|null} [width, height] the page asks for, or null when it
 *   can't say (a size that isn't a number)
 */
function measure(page) {
    const [, width] = page.get_preferred_width(-1);
    const [, height] = Number.isFinite(width) ? page.get_preferred_height(width) : [0, NaN];
    return Number.isFinite(width) && Number.isFinite(height) ? [width, height] : null;
}

// The innermost actor without a size, for the log.
function culprit(actor) {
    const child = actor.get_children().find(c => !measure(c));
    if (child)
        return culprit(child);
    const style = actor instanceof St.Widget ? actor.get_style_class_name() : null;
    return `${actor.constructor.name}${style ? ` .${style.replace(/ /g, '.')}` : ''}`;
}

// Children keep their natural size whatever size the island has, centered
// at the top: while the island grows, it uncovers the page instead of
// squeezing it, and the page never reflows during the animation.
const IslandLayout = GObject.registerClass(
class AtelierIslandLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width(container, _forHeight) {
        let [min, nat] = [0, 0];
        for (const child of container.get_children()) {
            const [childMin, childNat] = child.get_preferred_width(-1);
            min = Math.max(min, childMin);
            nat = Math.max(nat, childNat);
        }
        return [min, nat];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        let [min, nat] = [0, 0];
        for (const child of container.get_children()) {
            const [, width] = child.get_preferred_width(-1);
            const [childMin, childNat] = child.get_preferred_height(width);
            min = Math.max(min, childMin);
            nat = Math.max(nat, childNat);
        }
        return [min, nat];
    }

    vfunc_allocate(container, box) {
        const available = box.get_width();
        for (const child of container.get_children()) {
            // (A page without a size is on its way out; see Island.open.)
            const [width, height] = measure(child) ?? [0, 0];
            const x = box.x1 + Math.round((available - width) / 2);
            child.allocate(new Clutter.ActorBox({x1: x, y1: box.y1, x2: x + width, y2: box.y1 + height}));
        }
    }
});

export const Island = GObject.registerClass({
    Signals: {
        'clicked': {param_types: [GObject.TYPE_UINT]},
        'page-closed': {param_types: [GObject.TYPE_OBJECT]},
        'idle-resized': {},
    },
}, class AtelierIsland extends St.Widget {
    /**
     * @param {St.Widget} idle - shown at rest; emits 'changed' when its size may
     *   have changed. It belongs to the island and is destroyed with it.
     */
    _init(idle) {
        super._init({
            style_class: 'atelier-island',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            opacity: 0, // until it knows where it belongs
            layout_manager: new IslandLayout(),
        });
        this._idle = idle;
        this._page = null;
        this._shown = idle;
        this._grab = null;
        this._anchor = null;

        this.add_child(idle);
        idle.connectObject('changed', () => {
            if (this._shown === idle)
                this._resize(idle, true);
            this.emit('idle-resized');
        }, this);
        this.connect('destroy', () => this._onDestroy());
    }

    /** @returns {St.Widget|null} the page shown instead of the idle view */
    get page() {
        return this._page;
    }

    /** @returns {boolean} whether a page has the keyboard (switcher, menus) */
    get busy() {
        return this._grab !== null;
    }

    /** @returns {number[]} [width, height] of the island at rest */
    idleSize() {
        const [, width] = this._idle.get_preferred_width(-1);
        const [, height] = this._idle.get_preferred_height(width);
        return [Math.ceil(width), Math.ceil(height)];
    }

    /**
     * Where the island sits: horizontally centered on centerX, top edge at top.
     *
     * @param {number} centerX
     * @param {number} top
     */
    setAnchor(centerX, top) {
        const first = this._anchor === null;
        if (!first && this._anchor.centerX === centerX && this._anchor.top === top)
            return;
        this._anchor = {centerX, top};
        this.y = top;
        this._resize(this._shown, false);
        if (first)
            this.opacity = 255;
    }

    /** Re-measure the shown page or idle view, e.g. after a style change. */
    relayout() {
        this._resize(this._shown, false);
    }

    /**
     * Put a page into the island without showing it yet, so it can measure
     * itself against its styles before it opens.
     *
     * @param {St.Widget} page
     */
    adopt(page) {
        if (page.get_parent() === this)
            return;
        page.opacity = 0;
        this.add_child(page);
    }

    /**
     * Grow into a page.
     *
     * @param {St.Widget} page
     * @param {object} [options]
     * @param {boolean} [options.modal] - take the keyboard; a click outside closes it
     * @returns {boolean} whether the page is shown; if not, it is no longer
     *   in the island and the caller may destroy it
     */
    open(page, {modal = false} = {}) {
        // A page that can't say how big it is would leave the island around
        // nothing, holding the keyboard.
        this.adopt(page);
        if (!this._measure(page)) {
            if (page === this._page)
                this.close(page);
            else if (page.get_parent() === this)
                this.remove_child(page);
            return false;
        }

        if (modal && !this._grab) {
            const grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
            if ((grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
                Main.popModal(grab);
                return false;
            }
            this._grab = grab;
        } else if (!modal && this._grab) {
            this._releaseGrab();
        }

        const old = this._page;
        if (old !== page) {
            old?.disconnectObject(this);
            this._page = page;
            page.connectObject(
                'close-request', () => this.close(page),
                'notify::height', () => this._queueFollow(),
                'notify::width', () => this._queueFollow(),
                this);
            if (GObject.signal_lookup('resized', page.constructor.$gtype)) {
                page.connectObject('resized', () => {
                    if (this._shown === page)
                        this._resize(page, true);
                }, this);
            }
        }
        this._show(page);
        if (modal)
            page.focus?.();
        if (old && old !== page)
            this.emit('page-closed', old);
        return true;
    }

    /**
     * Shrink back to rest. The page is destroyed once it has faded out.
     *
     * @param {St.Widget} [page] - only close if this page is shown
     */
    close(page = this._page) {
        if (!page || page !== this._page)
            return;
        this._page = null;
        page.disconnectObject(this);
        this._releaseGrab();
        this._show(this._idle);
        this.emit('page-closed', page);
    }

    _releaseGrab() {
        if (!this._grab)
            return;
        Main.popModal(this._grab);
        this._grab = null;
    }

    _show(target) {
        this.adopt(target);
        const old = this._shown;
        this._shown = target;
        if (old !== target) {
            target.remove_transition('opacity');
            target.ease({
                opacity: 255,
                delay: FADE_IN_DELAY,
                duration: FADE_IN_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            old.ease({
                opacity: 0,
                duration: FADE_OUT_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    // the idle view stays; a page that came back stays too
                    if (!this._destroyed && old !== this._idle && old !== this._shown)
                        old.destroy();
                },
            });
        }
        this._resize(target, true);
    }

    /**
     * @param {St.Widget} target
     * @returns {number[]|null} its size, or null (logged) when it has none
     */
    _measure(target) {
        const size = measure(target);
        if (!size)
            console.warn(`Atelier: an island page has no size, because of ${culprit(target)}`);
        return size;
    }

    _resize(target, animate) {
        if (!this._anchor)
            return;
        const size = this._measure(target);
        if (!size) {
            if (target === this._page)
                this.close(target);
            return;
        }
        const width = Math.ceil(size[0]);
        const height = Math.ceil(size[1]);

        // The capsule's radius would turn into a stadium as it grows; pages
        // get a fixed radius. Shrinking keeps it until the capsule is small.
        if (target !== this._idle)
            this.add_style_pseudo_class('expanded');

        this.ease({
            x: Math.round(this._anchor.centerX - width / 2),
            width,
            height,
            duration: animate ? MORPH_TIME : 0,
            mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            onStopped: () => {
                if (!this._destroyed && this._shown === this._idle)
                    this.remove_style_pseudo_class('expanded');
            },
        });
    }

    // The page is allocated at its natural size whatever the island's size,
    // so a change of its allocation is a change of its content.
    _queueFollow() {
        if (this._followId || this._destroyed)
            return;
        this._followId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._followId = 0;
            const page = this._shown;
            if (page === this._idle || this._destroyed)
                return GLib.SOURCE_REMOVE;
            const size = this._measure(page);
            if (!size) {
                this.close(page);
                return GLib.SOURCE_REMOVE;
            }
            const [width, height] = size;
            if (Math.abs(Math.ceil(width) - this.width) >= 1 || Math.abs(Math.ceil(height) - this.height) >= 1) {
                // Still growing into the page: aim the animation anew;
                // otherwise follow the content right away.
                this._resize(page, Boolean(this.get_transition('height') || this.get_transition('width')));
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _isOutside(event) {
        return !this.contains(global.stage.get_event_actor(event));
    }

    vfunc_button_press_event(event) {
        // With the keyboard taken, clicks anywhere go to the island first.
        if (this._grab) {
            if (this._isOutside(event))
                this.close();
            return Clutter.EVENT_STOP;
        }
        // Buttons inside pages handle their own clicks; this is the capsule.
        this.emit('clicked', event.get_button());
        return Clutter.EVENT_STOP;
    }

    vfunc_touch_event(event) {
        if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        if (this._grab) {
            if (this._isOutside(event))
                this.close();
        } else {
            this.emit('clicked', Clutter.BUTTON_PRIMARY);
        }
        return Clutter.EVENT_STOP;
    }

    vfunc_key_press_event(event) {
        if (!this._grab || !this._page)
            return Clutter.EVENT_PROPAGATE;
        if (this._page.handleKeyPress?.(event))
            return Clutter.EVENT_STOP;
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_scroll_event(event) {
        if (this._page?.handleScroll?.(event))
            return Clutter.EVENT_STOP;
        return Clutter.EVENT_PROPAGATE;
    }

    _onDestroy() {
        this._destroyed = true;
        if (this._followId)
            global.compositor.get_laters().remove(this._followId);
        this._followId = 0;
        this._releaseGrab();
        this._page?.disconnectObject(this);
        this._page = null;
    }
});
