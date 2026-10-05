// A row showing a keyboard shortcut stored in GSettings, with a dialog to
// record a new one.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

const MODIFIER_KEYS = [
    Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R,
    Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
    Gdk.KEY_Super_L, Gdk.KEY_Super_R, Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
    Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock,
];

const isFunctionKey = keyval => keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35;

/**
 * Record a key combination.
 *
 * @param {Gtk.Widget} parent
 * @param {string} title
 * @returns {Promise<string|null>} the accelerator, '' to disable, null if cancelled
 */
function recordShortcut(parent, title) {
    return new Promise(resolve => {
        let result = null;
        const dialog = new Adw.Dialog({title, content_width: 420, content_height: 280});
        const toolbar = new Adw.ToolbarView({
            content: new Adw.StatusPage({
                icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
                title: 'Press a key combination',
                description: 'Esc cancels · Backspace disables the shortcut',
            }),
        });
        toolbar.add_top_bar(new Adw.HeaderBar());
        dialog.set_child(toolbar);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_controller, keyval, keycode, state) => {
            const mods = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            const key = Gdk.keyval_to_lower(keyval);

            if (mods === 0 && key === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (mods === 0 && key === Gdk.KEY_BackSpace) {
                result = '';
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (MODIFIER_KEYS.includes(key))
                return Gdk.EVENT_STOP;
            // Without Ctrl, Alt or Super a shortcut would swallow typing
            // (Shift+A is just a capital A); only F-keys may stand alone.
            const typing = (mods & ~Gdk.ModifierType.SHIFT_MASK) === 0;
            if ((typing && !isFunctionKey(key)) || !Gtk.accelerator_valid(key, mods))
                return Gdk.EVENT_STOP;

            result = Gtk.accelerator_name_with_keycode(null, key, keycode, mods);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(controller);
        dialog.connect('closed', () => resolve(result));
        dialog.present(parent);
    });
}

export const ShortcutRow = GObject.registerClass(
class BgChangerShortcutRow extends Adw.ActionRow {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings
     * @param {string} params.key - an 'as' key holding the accelerator
     * @param {string} params.title
     */
    _init({settings, key, title}) {
        super._init({title, activatable: true});
        this._settings = settings;
        this._key = key;

        this._label = new Gtk.Label({valign: Gtk.Align.CENTER, css_classes: ['dim-label']});
        this.add_suffix(this._label);

        this._clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Disable shortcut',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._clear.connect('clicked', () => settings.set_strv(key, []));
        this.add_suffix(this._clear);

        this.connect('activated', async () => {
            const accel = await recordShortcut(this, title);
            if (accel !== null)
                settings.set_strv(key, accel ? [accel] : []);
        });

        this._changedId = settings.connect(`changed::${key}`, () => this._sync());
        this._sync();
    }

    disconnectSettings() {
        this._settings.disconnect(this._changedId);
    }

    _sync() {
        const [accel] = this._settings.get_strv(this._key);
        if (accel) {
            const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
            this._label.label = ok ? Gtk.accelerator_get_label(keyval, mods) : accel;
        } else {
            this._label.label = 'Disabled';
        }
        this._clear.visible = Boolean(accel);
    }
});
