// "Lock Screen" section: what Atelier shows over GNOME's lock screen. The
// widgets are placed on a mock lock screen the shell shows when asked
// (the real one can't be edited: it is locked).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {DepthSetup} from './depthSetup.js';
import {isColor} from '../lib/lockLook.js';
import {TYPEFACES, labelFont, styleFor, typefaceFor} from '../lib/lockType.js';

/**
 * @param {object} typeface - lib/lockType.js typefaceFor()
 * @param {object} style - lib/lockType.js styleFor()
 * @returns {Pango.AttrList} a label's text in it (Inter and Roboto Flex are
 *   in this process: prefs.js registers them), at the label's own size
 */
function fontAttributes(typeface, style) {
    const attributes = new Pango.AttrList();
    attributes.insert(Pango.attr_font_desc_new(Pango.FontDescription.from_string(labelFont(typeface, style).description)));
    return attributes;
}

const LOOKS = [['bare', 'Bare'], ['modern', 'Modern'], ['analogue', 'Analogue']];

export const LockScreenPage = GObject.registerClass(
class AtelierLockScreenPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Lock Screen', name: 'lock-screen'});
        this._lock = settings.get_child('lockscreen');
        this._bound = [];

        const group = new Adw.PreferencesGroup({
            title: 'Lock Screen',
            description: 'Atelier\'s things over GNOME\'s lock screen. GNOME still checks the password ' +
                '(and a fingerprint or a face, when they are set up); Atelier only follows it.',
        });
        this.add(group);
        this._switch(group, 'enabled', 'Atelier on the lock screen');
        const island = this._switch(group, 'island', 'Island with a padlock',
            'A wave runs round it while GNOME checks; it shakes on a failure, opens in a green ring');
        const field = this._switch(group, 'password-field', 'Own password field',
            'A popup in the middle of the screen; GNOME still checks what is typed');
        this._lock.bind('island', field, 'sensitive', Gio.SettingsBindFlags.GET);
        this._bound.push([field, 'sensitive']);

        const widgets = new Adw.PreferencesGroup({
            title: 'Widgets',
            description: 'Clocks, the date, the weather and the battery, anywhere on the main monitor.',
        });
        this.add(widgets);
        const edit = new Adw.ActionRow({
            title: 'Place the widgets',
            subtitle: 'On a mock lock screen, as on the desktop',
        });
        const button = new Gtk.Button({label: 'Edit Lock Screen…', valign: Gtk.Align.CENTER});
        button.connect('clicked', () => this._lock.set_string('edit-request', GLib.uuid_string_random()));
        edit.add_suffix(button);
        edit.activatable_widget = button;
        widgets.add(edit);

        const look = new Adw.ComboRow({
            title: 'Look',
            subtitle: 'Bare: just what they show, on the wallpaper',
            model: Gtk.StringList.new(LOOKS.map(([, name]) => name)),
        });
        const syncLook = () => {
            const index = LOOKS.findIndex(([id]) => id === this._lock.get_string('style'));
            if (look.selected !== Math.max(0, index))
                look.selected = Math.max(0, index);
        };
        syncLook();
        look.connect('notify::selected', () => this._lock.set_string('style', LOOKS[look.selected][0]));
        this._styleId = this._lock.connect('changed::style', syncLook);
        widgets.add(look);
        const clock = this._switch(widgets, 'gnome-clock', 'GNOME\'s clock',
            'Off when your own clocks take its place');
        const color = this._colorRow(widgets);
        const font = this._fontRow(widgets);

        const depth = new Adw.PreferencesGroup({
            title: 'Depth Effect',
            description: 'As on an iPhone: what stands near in the wallpaper (a hill, a town, a person) in front of ' +
                'the lock screen\'s own clocks, the sky and the distance behind them. A depth model sees how near ' +
                'each part is, on this computer, whenever the wallpaper changes; where what stands in front would ' +
                'cover too much of a clock, the clock stays whole.',
        });
        this.add(depth);
        this._depthGroup = depth;
        this._depth = new DepthSetup(depth, this._lock);

        for (const row of [island, edit, look, clock, color, font, depth]) {
            this._lock.bind('enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            this._bound.push([row, 'sensitive']);
        }
    }

    // Auto (a tone legible on the wallpaper behind each widget) or a
    // colour of one's own.
    _colorRow(group) {
        const row = new Adw.ActionRow({title: 'Color'});
        const box = new Gtk.Box({css_classes: ['linked'], valign: Gtk.Align.CENTER});
        const auto = new Gtk.ToggleButton({label: 'Auto'});
        const button = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: false})});
        // (White, until a colour is chosen.)
        const white = new Gdk.RGBA();
        white.parse('#ffffff');
        button.rgba = white;
        box.append(auto);
        box.append(button);
        row.add_suffix(box);
        this._colorAuto = auto;
        this._colorButton = button;
        const hex = rgba => `#${[rgba.red, rgba.green, rgba.blue]
            .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
        let syncing = false;
        const sync = () => {
            const value = this._lock.get_string('clock-color');
            syncing = true;
            auto.active = !isColor(value);
            const rgba = new Gdk.RGBA();
            if (isColor(value) && rgba.parse(value))
                button.rgba = rgba;
            syncing = false;
            row.subtitle = auto.active
                ? 'A tone of the wallpaper, legible on it, for each widget on it'
                : 'On the wallpaper (the Bare look); cards keep their own';
        };
        // (Off, the colour the button has.)
        auto.connect('toggled', () => {
            if (!syncing)
                this._lock.set_string('clock-color', auto.active ? 'auto' : hex(button.rgba));
        });
        button.connect('notify::rgba', () => {
            if (!syncing)
                this._lock.set_string('clock-color', hex(button.rgba));
        });
        this._colorId = this._lock.connect('changed::clock-color', sync);
        sync();
        group.add(row);
        return row;
    }

    // The font families there are, listed once.
    _installed() {
        if (this._families === undefined) {
            try {
                this._families = this.get_pango_context().get_font_map().list_families().map(f => f.get_name());
            } catch {
                this._families = null;
            }
        }
        return this._families;
    }

    /** @returns {object} the typeface the settings choose, as there is (lib/lockType.js typefaceFor()) */
    get typeface() {
        return typefaceFor(this._lock.get_string('clock-font'), this._installed());
    }

    // The typefaces on offer, each in itself and said as it is there (or
    // isn't). Thin and Heavy, from before the weight could be set, show as
    // Default (their weight in the Weight row). Nothing is written while
    // the row only follows the setting: each profile keeps its own, and a
    // write would land in the one in use.
    _fontRow(group) {
        const row = new Adw.ComboRow({
            title: 'Font',
            model: Gtk.StringList.new(TYPEFACES.map(t => t.name)),
        });
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_, item) => item.set_child(new Gtk.Label({xalign: 0})));
        factory.connect('bind', (_, item) => {
            const typeface = typefaceFor(TYPEFACES[item.get_position()].id, this._installed());
            item.get_child().set({label: typeface.name, attributes: fontAttributes(typeface, styleFor(typeface, 'text'))});
        });
        row.factory = factory;
        let syncing = false;
        const sync = () => {
            const typeface = this.typeface;
            syncing = true;
            row.selected = Math.max(0, TYPEFACES.findIndex(t => t.id === typeface.id));
            syncing = false;
            row.subtitle = typeface.missing ? 'None installed here: the shell\'s font'
                : typeface.file ? 'A variable font that comes with Atelier'
                    : typeface.family ?? 'The shell\'s font';
        };
        row.connect('notify::selected', () => {
            const id = TYPEFACES[row.selected]?.id;
            // (Default for Thin or Heavy: as it is.)
            if (!syncing && id && id !== this.typeface.id)
                this._lock.set_string('clock-font', id);
        });
        this._fontId = this._lock.connect('changed::clock-font', sync);
        sync();
        group.add(row);
        this._fontCombo = row;
        return row;
    }

    _switch(group, key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        this._lock.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push([row, 'active']);
        group.add(row);
        return row;
    }

    disconnectSettings() {
        this._depth.disconnectSettings();
        this._bound.forEach(([row, property]) => Gio.Settings.unbind(row, property));
        this._bound = [];
        for (const id of [this._styleId, this._colorId, this._fontId].filter(Boolean))
            this._lock.disconnect(id);
        this._styleId = this._colorId = this._fontId = 0;
    }
});
