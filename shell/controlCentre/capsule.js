// Brightness and volume as iOS's Control Center has them: a tall capsule
// filled from the bottom as far as the level goes, the icon low in it, no
// knob (lib/levelCapsule.js). It is GNOME's own slider (a QuickSlider:
// GNOME's brightness, its volume, its microphone) shown so: its value both
// ways, its icon, its mute (a click on the icon), its menu (the outputs: a
// chevron at the top, a right click, the Menu key). GNOME's slider itself
// is kept off the stage meanwhile, alive (shell/controlCentre/host.js).
//
// Drawn without painting anything anew: the fill is a rounded rect as big
// as the capsule, clipped to the part under the level (its bottom corners
// the capsule's, its top edge straight); the icon is there twice, light
// on the glass and dark on the fill, each clipped to its side of the
// fill's edge. A change of level moves the clips, eased.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {PAGE, STEP, dragLevel, fillTop, levelAt, levelOf, splitAt, stepped, valueOf} from '../../lib/levelCapsule.js';

// The level eased to a new value (ms); not while dragged.
const EASE = 160;

/**
 * An icon twice over: light on the glass, dark on the fill.
 */
const SplitIcon = GObject.registerClass(
class AtelierSplitIcon extends St.Widget {
    /**
     * @param {string} style - the class of the one on the glass (the
     *   other's is it with -filled)
     * @param {object} [params] - St.Widget's
     */
    _init(style, params = {}) {
        super._init({layout_manager: new Clutter.BinLayout(), ...params});
        this.glass = new St.Icon({style_class: style});
        this.filled = new St.Icon({style_class: `${style}-filled`});
        this.add_child(this.glass);
        this.add_child(this.filled);
    }

    /** @param {Gio.Icon|null} gicon */
    set gicon(gicon) {
        this.glass.gicon = gicon;
        this.filled.gicon = gicon;
    }

    /** @param {string} name */
    set iconName(name) {
        this.glass.icon_name = name;
        this.filled.icon_name = name;
    }

    /**
     * @param {number} top - the fill's top edge, from this one's top
     */
    split(top) {
        const width = this.width;
        const {glass, fill} = splitAt(top, 0, this.height);
        this.glass.set_clip(0, glass.y, width, glass.height);
        this.filled.set_clip(0, fill.y, width, fill.height);
        // (Not drawn, not read as type, where it is not.)
        this.glass.opacity = glass.height > 0 ? 255 : 0;
        this.filled.opacity = fill.height > 0 ? 255 : 0;
    }
});

/**
 * GNOME's QuickSlider as a capsule.
 */
export const LevelCapsule = GObject.registerClass({
    Properties: {
        // How full it shows, 0 … 1 (eased to the slider's).
        'level': GObject.ParamSpec.double('level', null, null, GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
}, class AtelierLevelCapsule extends St.Widget {
    /**
     * @param {QuickSettings.QuickSlider} item - GNOME's
     * @param {string} name - 'brightness', 'volume', 'microphone'
     */
    _init(item, name) {
        super._init({
            style_class: `atelier-cc-capsule atelier-cc-capsule-${name}`,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
            accessible_role: Atk.Role.SLIDER,
        });
        this._level = 0;
        this.item = item;
        this.slider = item.slider;
        this._press = null;
        this._grab = null;

        this._fill = new St.Widget({style_class: 'atelier-cc-capsule-fill', x_expand: true, y_expand: true});
        this.add_child(this._fill);
        this.icon = new SplitIcon('atelier-cc-capsule-icon', {
            style_class: 'atelier-cc-capsule-icon-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this.icon);
        // The menu (Sound's outputs), where GNOME has one.
        this._chevron = new SplitIcon('atelier-cc-capsule-menu-icon');
        this._chevron.iconName = 'go-next-symbolic';
        this.menuButton = new St.Button({
            style_class: 'atelier-cc-capsule-menu',
            child: this._chevron,
            can_focus: true,
            accessible_name: 'Open menu',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        this.menuButton.connect('clicked', () => this.openMenu());
        this.add_child(this.menuButton);

        this._customAccessible = St.GenericAccessible.new_for_actor(this);
        this.set_accessible(this._customAccessible);
        this._customAccessible.connectObject(
            'get-current-value', () => this.slider.value,
            'get-minimum-value', () => 0,
            'get-maximum-value', () => this.slider.maximum_value,
            'set-current-value', (_, value) => (this.slider.value = value),
            this);

        // GNOME's icon (the volume's turns with it), its menu, its name.
        const sync = () => {
            this.icon.gicon = item.gicon ?? null;
            this.menuButton.visible = Boolean(item.menuEnabled && item.menu);
            this.accessible_name = this.slider.accessible_name ?? '';
        };
        sync();
        item.connectObject(
            'notify::gicon', sync,
            'notify::icon-name', sync,
            'notify::menu-enabled', sync,
            this);
        this.slider.connectObject(
            'notify::value', () => this._follow(),
            'notify::maximum-value', () => this._follow(),
            this);
        this.level = this._target();

        this.connect('destroy', () => {
            this._endPress();
            this.remove_transition('level');
            item.disconnectObject(this);
            this.slider.disconnectObject(this);
            this._customAccessible.disconnectObject(this);
        });
    }

    get level() {
        return this._level;
    }

    set level(level) {
        if (level === this._level)
            return;
        this._level = level;
        this.notify('level');
        this._split();
        this._customAccessible?.notify('accessible-value');
    }

    /** @returns {number} the level GNOME's slider is at */
    _target() {
        return levelOf(this.slider.value, this.slider.maximum_value);
    }

    // GNOME's slider moved (by this one, a key, GNOME): there, eased
    // unless dragged.
    _follow() {
        const target = this._target();
        this.remove_transition('level');
        if (this._press?.dragging || !this.mapped) {
            this.level = target;
            return;
        }
        this.ease_property('level', target, {duration: EASE, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    /**
     * Set GNOME's slider (which tells GNOME: the brightness, the volume).
     *
     * @param {number} level - 0 … 1
     */
    setLevel(level) {
        this.slider.value = valueOf(level, this.slider.maximum_value);
    }

    /** Open GNOME's menu (Sound's outputs), where it has one. */
    openMenu() {
        if (this.item.menuEnabled && this.item.menu)
            this.item.menu.open(true);
    }

    // The fill and the icons as the level has them: clips only.
    _split() {
        const height = this.height;
        if (!(height > 0))
            return;
        const top = fillTop(this._level, height);
        this._fill.set_clip(0, top, this._fill.width, height - top);
        this._fill.opacity = top < height ? 255 : 0;
        for (const split of [this.icon, this._chevron]) {
            let y = 0;
            for (let a = split; a && a !== this; a = a.get_parent())
                y += a.get_allocation_box().y1;
            split.split(top - y);
        }
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        this._split();
    }

    // The icon's part of it: a click there mutes (where GNOME's does).
    _onIcon(y) {
        const box = this.icon.get_allocation_box();
        return this.item.iconReactive && y >= box.y1 - 12 && y <= box.y2 + 12;
    }

    // GNOME's volume plays its sound as a drag ends, from its stream: told
    // of drags only while it has one (as its own slider only shows then).
    _tellsDrags() {
        return !('stream' in this.item) || Boolean(this.item.stream);
    }

    _localY(event) {
        const [x, y] = event.get_coords();
        const [, , ly] = this.transform_stage_point(x, y);
        return ly;
    }

    _beginPress(event) {
        this._endPress();
        this._press = {y: this._localY(event), start: this._target(), dragging: false};
        this._grab = global.stage.grab(this);
        this.add_style_pseudo_class('active');
    }

    _movePress(event) {
        const press = this._press;
        if (!press)
            return;
        const dy = this._localY(event) - press.y;
        const threshold = Clutter.Settings.get_default().dnd_drag_threshold ?? 8;
        if (!press.dragging && Math.abs(dy) < threshold)
            return;
        if (!press.dragging) {
            press.dragging = true;
            // (GNOME plays its sound for the volume once it is let go.)
            if (this._tellsDrags())
                this.slider.emit('drag-begin');
        }
        this.setLevel(dragLevel(press.start, dy, this.height));
    }

    _releasePress(event) {
        const press = this._press;
        if (!press)
            return;
        // (Dragged: its end told GNOME.)
        this._endPress();
        if (press.dragging)
            return;
        if (this._onIcon(press.y))
            this.item.emit('icon-clicked');
        else
            this.setLevel(levelAt(this._localY(event), this.height));
    }

    _endPress() {
        this._grab?.dismiss();
        this._grab = null;
        const dragged = this._press?.dragging;
        this._press = null;
        if (dragged && this._tellsDrags())
            this.slider.emit('drag-end');
        this.remove_style_pseudo_class('active');
    }

    vfunc_button_press_event(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this.openMenu();
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._beginPress(event);
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._press)
            return Clutter.EVENT_PROPAGATE;
        this._movePress(event);
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._press || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._releasePress(event);
        return Clutter.EVENT_STOP;
    }

    vfunc_touch_event(event) {
        switch (event.type()) {
        case Clutter.EventType.TOUCH_BEGIN:
            this._beginPress(event);
            return Clutter.EVENT_STOP;
        case Clutter.EventType.TOUCH_UPDATE:
            this._movePress(event);
            return Clutter.EVENT_STOP;
        case Clutter.EventType.TOUCH_END:
            this._releasePress(event);
            return Clutter.EVENT_STOP;
        case Clutter.EventType.TOUCH_CANCEL:
            this._endPress();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    vfunc_scroll_event(event) {
        // (As GNOME's slider scrolls: its steps, smooth scrolling too.)
        return this.slider.scroll(event);
    }

    vfunc_key_press_event(event) {
        const steps = {
            [Clutter.KEY_Up]: STEP,
            [Clutter.KEY_KP_Up]: STEP,
            [Clutter.KEY_Down]: -STEP,
            [Clutter.KEY_KP_Down]: -STEP,
            [Clutter.KEY_Page_Up]: PAGE,
            [Clutter.KEY_KP_Page_Up]: PAGE,
            [Clutter.KEY_Page_Down]: -PAGE,
            [Clutter.KEY_KP_Page_Down]: -PAGE,
            [Clutter.KEY_End]: Infinity,
            [Clutter.KEY_Home]: -Infinity,
        };
        const symbol = event.get_key_symbol();
        if (symbol in steps) {
            this.setLevel(stepped(this._target(), steps[symbol]));
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Menu) {
            this.openMenu();
            return Clutter.EVENT_STOP;
        }
        if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter || symbol === Clutter.KEY_space) &&
            this.item.iconReactive) {
            this.item.emit('icon-clicked');
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});
