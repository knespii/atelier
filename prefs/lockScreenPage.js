// "Lock Screen" section: what Atelier shows over GNOME's lock screen. The
// widgets are placed on a mock lock screen the shell shows when asked
// (the real one can't be edited: it is locked). Their type – its font, the
// clocks' weight and width, its colour – is set here. Each profile keeps
// its own (lib/profiles.js): nothing is written while a row only follows
// a setting, as a write would land in the profile in use.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {DepthSetup} from './depthSetup.js';
import {blend, minimumLc} from '../lib/apca.js';
import {regionPixels, tenths, typeColors} from '../lib/lockColor.js';
import {TYPE, isColor, regionIn} from '../lib/lockLook.js';
import {TYPEFACES, labelFont, styleFor, typefaceFor} from '../lib/lockType.js';
import {hexToRgb} from '../lib/palette.js';
import {sampleWallpaper} from '../lib/thumbnails.js';
import {wallpaperShown} from '../lib/wallpaperPalette.js';
import {LOCK_KINDS, cellOrigin, fitLayout, gridOrigin, gridSize, parseLayout, pixelSize} from '../lib/widgets.js';

const LOOKS = [['bare', 'Bare'], ['modern', 'Modern'], ['analogue', 'Analogue']];
// How much of the wallpaper's light is left at most while the password is
// asked (shell/lockscreen/glass.js GLASS.brightness): dark type must read
// then too.
const DIM = 0.86;
// The wallpaper looked at this small, as the lock screen looks at it
// (shell/lockscreen/typography.js).
const SAMPLE = [96, 60];
// A slider's value written this long after it was last moved, ms: a drag
// is one change (each is kept in the profile in use).
const SETTLE = 300;
const SWATCH = 34; // pixels

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

const hexOf = rgba => `#${[rgba.red, rgba.green, rgba.blue]
    .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

const setColor = (cr, hex, alpha = 1) => cr.setSourceRGBA(...hexToRgb(hex).map(v => v / 255), alpha);

export const LockScreenPage = GObject.registerClass(
class AtelierLockScreenPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Lock Screen', name: 'lock-screen'});
        this._lock = settings.get_child('lockscreen');
        this._bound = [];
        this._ids = [];
        this._settled = new Map();

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
        let syncingLook = false;
        const syncLook = () => {
            const index = LOOKS.findIndex(([id]) => id === this._lock.get_string('style'));
            syncingLook = true;
            look.selected = Math.max(0, index);
            syncingLook = false;
        };
        syncLook();
        look.connect('notify::selected', () => {
            if (!syncingLook)
                this._lock.set_string('style', LOOKS[look.selected][0]);
        });
        this._ids.push(this._lock.connect('changed::style', syncLook));
        widgets.add(look);
        const clock = this._switch(widgets, 'gnome-clock', 'GNOME\'s clock',
            'Off when your own clocks take its place');

        const type = new Adw.PreferencesGroup({
            title: 'Type',
            description: 'How the widgets\' type is set: its font, how heavy and wide the clocks\' digits are, ' +
                'and its color. Where a part of it would not read on the wallpaper, it is set a little heavier ' +
                'or gets a soft shadow round its letters; nowhere else.',
        });
        this.add(type);
        this._typeGroup = type;
        this._fontRow(type);
        this._weight = this._sliderRow(type, {
            key: 'clock-weight',
            title: 'Weight',
            range: typeface => [typeface.axes?.wght?.min ?? 100, typeface.axes?.wght?.max ?? 900],
            own: typeface => styleFor(typeface, 'glass').weight,
            format: value => `${value}`,
            subtitle: (value, typeface) => (value === 0 ? 'As each clock face has it'
                : typeface.axes?.wght ? 'The clocks\' digits, on the font\'s weight axis'
                    : 'The clocks\' digits, in the nearest weight the font has'),
        });
        this._width = this._sliderRow(type, {
            key: 'clock-width',
            title: 'Width',
            range: () => [50, 150],
            own: typeface => styleFor(typeface, 'glass').width,
            format: value => `${value} %`,
            subtitle: value => (value === 0 ? 'As each clock face has it'
                : 'On the font\'s width axis where it has one; the glass clock is drawn narrower otherwise'),
        });
        this._colorRow(type);
        this._swatchRow(type);

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

        for (const row of [island, edit, look, clock, type, depth]) {
            this._lock.bind('enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            this._bound.push([row, 'sensitive']);
        }

        // The colours from the wallpaper: anew as it changes, or the clocks move.
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._wallpaperIds = [
            [this._background, this._background.connect('changed::picture-uri', () => this._loadSample())],
            [this._background, this._background.connect('changed::picture-uri-dark', () => this._loadSample())],
            [this._interface, this._interface.connect('changed::color-scheme', () => this._loadSample())],
        ];
        this._ids.push(this._lock.connect('changed::widgets', () => this._syncSwatches()));
        this._sample = null;
        this._serial = 0;
        this._loadSample();
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
            this._syncChosenSwatch?.();
        };
        // (Off, the colour the button has.)
        auto.connect('toggled', () => {
            if (!syncing)
                this._lock.set_string('clock-color', auto.active ? 'auto' : hexOf(button.rgba));
        });
        button.connect('notify::rgba', () => {
            if (!syncing)
                this._lock.set_string('clock-color', hexOf(button.rgba));
        });
        this._ids.push(this._lock.connect('changed::clock-color', sync));
        sync();
        group.add(row);
        return row;
    }

    // Colours from the wallpaper for the clocks' type, as an iPhone offers
    // them: tints of its colours that read where the clocks are (light
    // ones on the lighter part behind them, dark ones on the darker part,
    // dimmed as when the password is asked: lib/lockColor.js). Each shows a
    // digit in it on what it was checked against, in the font chosen; one
    // that would not read there, struck through.
    _swatchRow(group) {
        const row = new Adw.ActionRow({
            title: 'From the Wallpaper',
            subtitle: 'Checked where the clocks are; struck through where it would not read',
        });
        this._swatchBox = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        row.add_suffix(this._swatchBox);
        this._swatchRowWidget = row;
        this._swatches = [];
        group.add(row);
        this._syncChosenSwatch = () => {
            const chosen = this._lock.get_string('clock-color').toLowerCase();
            this._syncingSwatches = true;
            for (const swatch of this._swatches)
                swatch.button.active = swatch.color === chosen;
            this._syncingSwatches = false;
        };
        return row;
    }

    // The wallpaper the lock screen shows, small, as it samples it.
    async _loadSample() {
        const serial = ++this._serial;
        const path = this._background ? wallpaperShown(this._background, this._interface) : null;
        let sample = null;
        if (path) {
            try {
                sample = await sampleWallpaper(path, ...SAMPLE);
            } catch (e) {
                console.warn(`Atelier: no colours from ${path}: ${e.message}`);
            }
        }
        if (serial !== this._serial || !this._swatchBox)
            return;
        this._sample = sample;
        this._sampled = path;
        this._syncSwatches();
    }

    // Where the clocks are on the main monitor (as the lock screen fits
    // them to it), [x, y, width, height] each, 0 … 1; all of it without one.
    _clockRegions() {
        const monitor = Gdk.Display.get_default()?.get_monitors().get_item(0)?.get_geometry();
        const [width, height] = monitor ? [monitor.width, monitor.height] : [1920, 1080];
        const grid = gridSize(width, height);
        const origin = gridOrigin(width, height);
        const clocks = fitLayout(parseLayout(this._lock.get_string('widgets'), LOCK_KINDS), grid)
            .filter(entry => entry.kind === 'clock');
        const regions = clocks.map(entry => {
            const [x, y] = cellOrigin(entry.x, entry.y, origin);
            const [w, h] = pixelSize(entry.size);
            return [x / width, y / height, w / width, h / height];
        });
        return {regions: regions.length > 0 ? regions : [[0, 0, 1, 1]], aspect: width / height};
    }

    _syncSwatches() {
        const sample = this._sample;
        if (!this._swatchBox)
            return;
        let child;
        while ((child = this._swatchBox.get_first_child()))
            this._swatchBox.remove(child);
        this._swatches = [];
        this._swatchRowWidget.visible = Boolean(sample);
        if (!sample)
            return;
        const {regions, aspect} = this._clockRegions();
        const pixels = regions.flatMap(region => regionPixels(sample, regionIn(region, aspect, sample.width / sample.height)));
        const need = minimumLc(TYPE.line.size, TYPE.line.weight);
        const behind = tenths(pixels);
        for (const tint of typeColors(pixels, {need, dim: DIM, from: regionPixels(sample, [0, 0, 1, 1])})) {
            const swatch = {...tint, behind: tint.dark ? blend('#000000', 1 - DIM, behind.dark) : behind.light};
            const area = new Gtk.DrawingArea({content_width: SWATCH, content_height: SWATCH});
            area.set_draw_func((_area, cr, w, h) => this._drawSwatch(cr, w, h, swatch));
            swatch.button = new Gtk.ToggleButton({
                css_classes: ['atelier-color-button'],
                child: area,
                tooltip_text: tint.reaches
                    ? `${tint.color}: reads where the clocks are (Lc ${Math.round(tint.lc)})`
                    : `${tint.color}: faint where the clocks are (Lc ${Math.round(tint.lc)} of ${Math.round(need)})`,
            });
            swatch.button.connect('toggled', () => {
                if (this._syncingSwatches)
                    return;
                if (swatch.button.active)
                    this._lock.set_string('clock-color', swatch.color);
                else
                    this._syncChosenSwatch();
            });
            this._swatchBox.append(swatch.button);
            this._swatches.push(swatch);
        }
        this._syncChosenSwatch();
    }

    // A digit in the colour, in the font chosen (heavy enough to show the
    // colour), on what is behind the clocks where it was checked; struck
    // through when it would not read.
    _drawSwatch(cr, width, height, {color, behind, reaches}) {
        const r = 8;
        cr.newPath();
        cr.arc(width - r, r, r, -Math.PI / 2, 0);
        cr.arc(width - r, height - r, r, 0, Math.PI / 2);
        cr.arc(r, height - r, r, Math.PI / 2, Math.PI);
        cr.arc(r, r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
        setColor(cr, behind);
        cr.fill();
        const typeface = this.typeface;
        const style = this._styleNow('digits');
        const font = Pango.FontDescription.from_string(
            labelFont(typeface, {...style, weight: Math.max(600, style.weight)}).description);
        // (The shell's own font: as GTK has its, here.)
        if (!typeface.family)
            font.set_family(this.get_pango_context().get_font_description().get_family());
        font.set_absolute_size(height * 0.7 * Pango.SCALE);
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(font);
        layout.set_text('9', -1);
        const [ink] = layout.get_pixel_extents();
        cr.moveTo(width / 2 - ink.x - ink.width / 2, height / 2 - ink.y - ink.height / 2);
        setColor(cr, color);
        PangoCairo.show_layout(cr, layout);
        if (!reaches) {
            cr.moveTo(width * 0.15, height * 0.85);
            cr.lineTo(width * 0.85, height * 0.15);
            cr.setLineWidth(2.5);
            cr.stroke();
        }
    }

    _redrawSwatches() {
        this._swatches?.forEach(swatch => swatch.button.child.queue_draw());
    }

    // How a part of a role is set, as the settings say now.
    _styleNow(role) {
        return styleFor(this.typeface, role, {
            weight: this._lock.get_int('clock-weight'),
            width: this._lock.get_int('clock-width'),
        });
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
    // Default (their weight in the Weight row).
    _fontRow(group) {
        const row = new Adw.ComboRow({
            title: 'Font',
            model: Gtk.StringList.new(TYPEFACES.map(t => t.name)),
        });
        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_, item) => item.set_child(new Gtk.Label({xalign: 0})));
        // (By its name: the row's own button shows the item chosen out of the list.)
        factory.connect('bind', (_, item) => {
            const name = item.get_item().get_string();
            const typeface = typefaceFor(TYPEFACES.find(t => t.name === name)?.id ?? 'default', this._installed());
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
            // (Another font: other weights, and the swatches in it.)
            this._weight?.sync();
            this._width?.sync();
            this._redrawSwatches();
        };
        row.connect('notify::selected', () => {
            const id = TYPEFACES[row.selected]?.id;
            // (Default for Thin or Heavy: as it is.)
            if (!syncing && id && id !== this.typeface.id)
                this._lock.set_string('clock-font', id);
        });
        this._ids.push(this._lock.connect('changed::clock-font', sync));
        sync();
        group.add(row);
        this._fontCombo = row;
        return row;
    }

    // One of the clocks' digits' settings: as each clock face has it
    // (Automatic: 0), or a value on a slider, in steps of ten – written a
    // moment after it is last moved.
    _sliderRow(group, {key, title, range, own, format, subtitle}) {
        const row = new Adw.ActionRow({title});
        const box = new Gtk.Box({spacing: 10, valign: Gtk.Align.CENTER});
        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            draw_value: true,
            value_pos: Gtk.PositionType.LEFT,
            digits: 0,
            width_request: 220,
        });
        scale.set_format_value_func((_, value) => format(Math.round(value)));
        scale.set_increments(10, 100);
        const automatic = new Gtk.ToggleButton({label: 'Automatic', valign: Gtk.Align.CENTER});
        box.append(scale);
        box.append(automatic);
        row.add_suffix(box);
        let syncing = false;
        const sync = () => {
            const typeface = this.typeface;
            const value = this._lock.get_int(key);
            const [min, max] = range(typeface);
            syncing = true;
            scale.set_range(min, max);
            scale.set_value(value > 0 ? value : own(typeface));
            automatic.active = value === 0;
            scale.sensitive = value > 0;
            syncing = false;
            row.subtitle = subtitle(value, typeface);
            this._redrawSwatches();
        };
        // (Whole tens, however it is dragged.)
        scale.connect('change-value', (_, _scroll, value) => {
            const [min, max] = range(this.typeface);
            scale.set_value(Math.min(max, Math.max(min, Math.round(value / 10) * 10)));
            return true;
        });
        scale.connect('value-changed', () => {
            if (!syncing)
                this._settle(key, Math.round(scale.get_value()));
        });
        automatic.connect('toggled', () => {
            if (syncing)
                return;
            this._settle(key, null);
            this._lock.set_int(key, automatic.active ? 0 : Math.round(scale.get_value()));
        });
        this._ids.push(this._lock.connect(`changed::${key}`, sync));
        sync();
        group.add(row);
        return {row, scale, automatic, sync};
    }

    // A value written a moment after it was last asked for (null: none).
    _settle(key, value) {
        const pending = this._settled.get(key);
        if (pending)
            GLib.source_remove(pending.id);
        this._settled.delete(key);
        if (value === null)
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE, () => {
            this._settled.delete(key);
            this._lock.set_int(key, value);
            return GLib.SOURCE_REMOVE;
        });
        this._settled.set(key, {id, value});
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
        // (A value still settling is written now.)
        for (const [key, {id, value}] of this._settled) {
            GLib.source_remove(id);
            this._lock.set_int(key, value);
        }
        this._settled.clear();
        this._ids.forEach(id => this._lock.disconnect(id));
        this._ids = [];
        this._wallpaperIds?.forEach(([settings, id]) => settings.disconnect(id));
        this._wallpaperIds = null;
        this._serial++;
        this._background = this._interface = null;
    }
});
