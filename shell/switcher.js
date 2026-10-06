// The switcher as a popup: a dark panel dropping from the top of the screen.
// Used when the island is turned off; otherwise the island hosts the
// switcher's content itself.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {switcherWidth} from './switcherContent.js';

const TOP_MARGIN = 10;
const OPEN_TIME = 220;
const CLOSE_TIME = 160;

export const SwitcherPopup = GObject.registerClass(
class AtelierSwitcherPopup extends St.Widget {
    /**
     * @param {SwitcherContent} content
     */
    _init(content) {
        super._init({reactive: true, visible: false});
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        this._content = content;
        this._grab = null;

        this._panel = new St.Bin({style_class: 'atelier-panel', reactive: true, child: content});
        this.add_child(this._panel);

        Main.layoutManager.uiGroup.add_child(this);
        Main.layoutManager.connectObject(
            'system-modal-opened', () => content.close(),
            'monitors-changed', () => content.close(), this);
        content.connectObject(
            'close-request', () => this._close(),
            // Gone with Atelier (turned off, or the screen locked while the
            // popup was open): the popup and its grab go too, or nothing
            // would close them and they would take every click and key.
            'destroy', () => this._onContentDestroyed(),
            this);
        this.connect('destroy', () => this._onDestroy());
    }

    _onContentDestroyed() {
        // (Out of the panel first: it is on its way out already.)
        this._panel.set_child(null);
        this.destroy();
    }

    get _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    /** @returns {boolean} whether the popup could take the keyboard */
    open() {
        const grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        if ((grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(grab);
            this.destroy();
            return false;
        }
        this._grab = grab;

        const scale = this._scale;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.currentMonitor.index);
        const width = switcherWidth(workArea.width, scale);
        const node = this._panel.get_theme_node();
        this._content.setWidth(width - node.get_horizontal_padding() - node.get_border_width(St.Side.LEFT) * 2);
        this._panel.set_position(
            workArea.x + Math.round((workArea.width - width) / 2),
            workArea.y + TOP_MARGIN * scale);
        this._panel.width = width;

        this.show();
        this._panel.opacity = 0;
        this._panel.translation_y = -16 * scale;
        this._panel.ease({
            opacity: 255,
            translation_y: 0,
            duration: OPEN_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        return true;
    }

    _close() {
        if (this._closing)
            return;
        this._closing = true;
        this._popModal();
        this._panel.ease({
            opacity: 0,
            translation_y: -12 * this._scale,
            duration: CLOSE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    _popModal() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _onDestroy() {
        this._popModal();
        Main.layoutManager.disconnectObject(this);
        this._content.disconnectObject(this);
    }

    vfunc_key_press_event(event) {
        return this._content.handleKeyPress(event) ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
    }

    vfunc_scroll_event(event) {
        this._content.handleScroll(event);
        return Clutter.EVENT_STOP;
    }

    _isOutsidePanel(event) {
        const actor = global.stage.get_event_actor(event);
        return !this._panel.contains(actor);
    }

    vfunc_button_press_event(event) {
        if (this._isOutsidePanel(event))
            this._content.close();
        return Clutter.EVENT_STOP;
    }

    vfunc_touch_event(event) {
        if (event.type() === Clutter.EventType.TOUCH_BEGIN && this._isOutsidePanel(event))
            this._content.close();
        return Clutter.EVENT_STOP;
    }
});
