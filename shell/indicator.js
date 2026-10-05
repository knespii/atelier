// Top bar button that opens the look switcher.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export const Indicator = GObject.registerClass({
    Signals: {'activate': {}},
}, class BgChangerIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        // No menu: the button only opens the switcher.
        super._init(0.5, 'BG Changer', true);

        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${extensionPath}/icons/bg-changer-symbolic.svg`),
            style_class: 'system-status-icon',
        }));
    }

    vfunc_event(event) {
        // Open on release: opening on press would deliver the release to the
        // switcher's backdrop, which closes it again.
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_RELEASE || type === Clutter.EventType.TOUCH_END) {
            this.emit('activate');
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_key_press_event(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter || key === Clutter.KEY_space) {
            this.emit('activate');
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});
