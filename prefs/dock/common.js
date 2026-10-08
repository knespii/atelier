// What the dock's sections of the preferences share: rows bound to
// settings, each kept in the page's rows (by key) and let go of when the
// page goes.
//
// Every section (prefs/dock/*.js) exports build(page, ctx), with ctx
// {settings (the dock's), binder (a DockBinder)}, and returns its groups
// (an Adw.PreferencesGroup, a list of them, or null for none); the page
// adds them in order and greys them out while the dock is off.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

/**
 * Add a row to a group, or to an expander row (nested).
 *
 * @param {Adw.PreferencesGroup|Adw.ExpanderRow} group
 * @param {Gtk.Widget} row
 */
export function addRow(group, row) {
    if (group instanceof Adw.ExpanderRow)
        group.add_row(row);
    else
        group.add(row);
}

export class DockBinder {
    /**
     * @param {Adw.PreferencesPage} page - its rows (a Map, key → row) get
     *   every row bound here
     */
    constructor(page) {
        this._page = page;
        page.rows ??= new Map();
        this._bound = []; // [object, property] bound with Gio.Settings.bind
        this._handlers = []; // [object, handler id]
    }

    /**
     * Connect to a signal, let go of with the page.
     *
     * @param {GObject.Object} object
     * @param {string} signal
     * @param {Function} handler
     * @returns {number} the handler's id
     */
    connect(object, signal, handler) {
        const id = object.connect(signal, handler);
        this._handlers.push([object, id]);
        return id;
    }

    /**
     * Keep a row in the page's rows under its key.
     *
     * @param {string} key
     * @param {Gtk.Widget} row
     * @returns {Gtk.Widget} the row
     */
    register(key, row) {
        this._page.rows.set(key, row);
        return row;
    }

    /**
     * Bind a property to a setting, let go of with the page.
     *
     * @param {Gio.Settings} settings
     * @param {string} key
     * @param {GObject.Object} object
     * @param {string} property
     * @param {Gio.SettingsBindFlags} [flags]
     */
    bind(settings, key, object, property, flags = Gio.SettingsBindFlags.DEFAULT) {
        settings.bind(key, object, property, flags);
        this._bound.push([object, property]);
    }

    /**
     * @param {Gtk.Widget} widget - sensitive only while the setting is on
     * @param {Gio.Settings} settings
     * @param {string} key - a boolean
     */
    bindSensitive(widget, settings, key) {
        this.bind(settings, key, widget, 'sensitive', Gio.SettingsBindFlags.GET);
    }

    /**
     * @param {Adw.PreferencesGroup|Adw.ExpanderRow} group
     * @param {Gio.Settings} settings
     * @param {string} key - a boolean
     * @param {string} title
     * @param {string} [subtitle]
     * @returns {Adw.SwitchRow}
     */
    bindSwitch(group, settings, key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        this.bind(settings, key, row, 'active');
        addRow(group, row);
        return this.register(key, row);
    }

    /**
     * A number; shown scaled (a fraction in percent, say).
     *
     * @param {Adw.PreferencesGroup|Adw.ExpanderRow} group
     * @param {Gio.Settings} settings
     * @param {string} key - an integer or a double
     * @param {string} title
     * @param {string} subtitle
     * @param {object} range - {lower, upper, step, digits, scale}: the
     *   row's (the setting's times scale)
     * @returns {Adw.SpinRow}
     */
    bindSpin(group, settings, key, title, subtitle, {lower, upper, step = 1, digits = 0, scale = 1}) {
        const row = new Adw.SpinRow({
            title, subtitle, digits,
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
        });
        const integer = settings.settings_schema.get_key(key).get_value_type().dup_string() === 'i';
        const read = () => (integer ? settings.get_int(key) : settings.get_double(key)) * scale;
        let syncing = false;
        const sync = () => {
            syncing = true;
            row.value = read();
            syncing = false;
        };
        sync();
        this.connect(settings, `changed::${key}`, sync);
        this.connect(row, 'notify::value', () => {
            if (syncing || Math.abs(row.value - read()) < 1e-9)
                return;
            if (integer)
                settings.set_int(key, Math.round(row.value / scale));
            else
                settings.set_double(key, row.value / scale);
        });
        addRow(group, row);
        return this.register(key, row);
    }

    /**
     * One of a few values (an enum's nicks, or strings).
     *
     * @param {Adw.PreferencesGroup|Adw.ExpanderRow} group
     * @param {Gio.Settings} settings
     * @param {string} key - an enum or a string
     * @param {string} title
     * @param {string} subtitle
     * @param {Array<string[]>} options - [value, label] pairs
     * @returns {Adw.ComboRow}
     */
    bindCombo(group, settings, key, title, subtitle, options) {
        const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(options.map(([, label]) => label))});
        let syncing = false;
        const sync = () => {
            const index = options.findIndex(([value]) => value === settings.get_string(key));
            syncing = true;
            if (index >= 0)
                row.selected = index;
            syncing = false;
        };
        sync();
        this.connect(settings, `changed::${key}`, sync);
        this.connect(row, 'notify::selected', () => {
            const value = options[row.selected]?.[0];
            if (!syncing && value !== undefined && value !== settings.get_string(key))
                settings.set_string(key, value);
        });
        addRow(group, row);
        return this.register(key, row);
    }

    /**
     * A colour, '#rrggbb'.
     *
     * @param {Adw.PreferencesGroup|Adw.ExpanderRow} group
     * @param {Gio.Settings} settings
     * @param {string} key - a string
     * @param {string} title
     * @param {string} [subtitle]
     * @returns {Adw.ActionRow} its button is row.button
     */
    bindColor(group, settings, key, title, subtitle = '') {
        const row = new Adw.ActionRow({title, subtitle});
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(button);
        row.activatable_widget = button;
        row.button = button;
        const hex = rgba => `#${[rgba.red, rgba.green, rgba.blue]
            .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
        let syncing = false;
        const sync = () => {
            const rgba = new Gdk.RGBA();
            if (rgba.parse(settings.get_string(key))) {
                syncing = true;
                button.rgba = rgba;
                syncing = false;
            }
        };
        sync();
        this.connect(settings, `changed::${key}`, sync);
        this.connect(button, 'notify::rgba', () => {
            if (!syncing && hex(button.rgba) !== settings.get_string(key))
                settings.set_string(key, hex(button.rgba));
        });
        addRow(group, row);
        return this.register(key, row);
    }

    /**
     * Text.
     *
     * @param {Adw.PreferencesGroup|Adw.ExpanderRow} group
     * @param {Gio.Settings} settings
     * @param {string} key - a string
     * @param {string} title
     * @returns {Adw.EntryRow}
     */
    bindEntry(group, settings, key, title) {
        const row = new Adw.EntryRow({title});
        this.bind(settings, key, row, 'text');
        addRow(group, row);
        return this.register(key, row);
    }

    /** Let go of every setting and signal. */
    disconnectSettings() {
        this._bound.forEach(([object, property]) => Gio.Settings.unbind(object, property));
        this._bound = [];
        this._handlers.forEach(([object, id]) => object.disconnect(id));
        this._handlers = [];
    }
}
