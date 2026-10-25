// "Appearance" section: the palette that comes from the wallpaper, which
// apps take it, and how Atelier's glass looks.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {PRESETS, VARIANTS, buildPalette} from '../lib/palette.js';
import {isTerminalAvailable, restoreTerminal} from '../lib/terminal.js';
import {OptionCards, schemePreview, swatchesPreview} from './optionCards.js';
import {naturalWidth} from './widgets.js';

const SOURCES = [['wallpaper', 'Wallpaper'], ['swatch', 'Swatch'], ['preset', 'Fixed']];
const VARIANT_LABELS = {vibrant: 'Vibrant', muted: 'Muted', monochrome: 'Monochrome'};
// The glass's variants (lib/glassLook.js), with what each is.
const GLASS = [
    ['regular', 'Regular', 'What is behind it bends at its edges, as through a lens, and they catch the light'],
    ['clear', 'Clear', 'More see-through, a little darker under it to keep what is on it legible'],
    ['off', 'Off', 'Solid surfaces, without blur or light'],
];

export const AppearancePage = GObject.registerClass(
class AtelierAppearancePage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Appearance'});
        this._settings = settings;
        this._palette = settings.get_child('palette');
        this._ids = [];

        // Rows of a group come before other widgets, so the preview gets its own group.
        const previewGroup = new Adw.PreferencesGroup({
            title: 'Palette',
            description: 'The colors come from the wallpaper and change with it. They color Atelier and, ' +
                'if you want, GTK apps and GNOME Terminal.',
        });
        this._previewBox = new Gtk.Box({spacing: 18, halign: Gtk.Align.CENTER, margin_top: 6});
        previewGroup.add(this._previewBox);
        this.add(previewGroup);
        this.add(this._buildPaletteGroup());
        this.add(this._buildGlassGroup());
        this.add(this._buildAppsGroup());

        this._ids.push(
            [this._palette, this._palette.connect('changed::current', () => this._syncPalette())],
            [this._palette, this._palette.connect('changed::source', () => this._syncSource())],
            [this._palette, this._palette.connect('changed::variant',
                () => this._variants.setSelected(this._palette.get_string('variant')))],
            [this._settings, this._settings.connect('changed::gtk-css-problem', () => this._syncProblem())],
            [this._settings, this._settings.connect('changed::glass-variant', () => this._syncGlass())],
            [this._settings, this._settings.connect('changed::glass-dim', () => this._syncDim())]);
        if (this._a11y)
            this._ids.push([this._a11y, this._a11y.connect('changed::high-contrast', () => this._syncGlass())]);
        this._syncPalette();
        this._syncSource();
        this._syncProblem();
        this._syncGlass();
        this._syncDim();
    }

    disconnectSettings() {
        this._ids.forEach(([object, id]) => object.disconnect(id));
        this._ids = [];
    }

    _current() {
        try {
            return JSON.parse(this._palette.get_string('current'));
        } catch {
            return null;
        }
    }

    _buildPaletteGroup() {
        const group = new Adw.PreferencesGroup();

        const sourceRow = new Adw.ActionRow({title: 'Colors from'});
        this._sourceToggles = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});
        for (const [name, label] of SOURCES)
            this._sourceToggles.add(new Adw.Toggle({name, label}));
        this._sourceToggles.connect('notify::active-name', () => {
            const name = this._sourceToggles.active_name;
            if (name && name !== this._palette.get_string('source'))
                this._palette.set_string('source', name);
        });
        sourceRow.add_suffix(this._sourceToggles);
        group.add(sourceRow);

        this._swatchRow = new Adw.ActionRow({title: 'Swatch', subtitle: 'One of the wallpaper\'s colors'});
        this._swatchBox = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
        this._swatchRow.add_suffix(this._swatchBox);
        group.add(this._swatchRow);

        this._presetRow = new Adw.PreferencesRow({activatable: false});
        const presets = new Adw.WrapBox({
            child_spacing: 10, line_spacing: 10,
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
        });
        let first = null;
        this._presetButtons = new Map();
        for (const [id, preset] of Object.entries(PRESETS)) {
            const button = new Gtk.ToggleButton({
                tooltip_text: preset.name,
                css_classes: ['atelier-color-button'],
                child: swatchesPreview([preset.color], 24),
                active: this._palette.get_string('preset') === id,
            });
            if (first)
                button.set_group(first);
            first ??= button;
            button.connect('toggled', () => {
                if (button.active)
                    this._palette.set_string('preset', id);
            });
            presets.append(button);
            this._presetButtons.set(id, button);
        }
        this._presetRow.set_child(presets);
        group.add(this._presetRow);

        const variantsRow = new Adw.PreferencesRow({activatable: false});
        const source = this._current()?.source ?? PRESETS.ochre.color;
        this._variants = new OptionCards({
            options: VARIANTS.map(id => ({
                id,
                label: VARIANT_LABELS[id],
                preview: schemePreview(buildPalette({source, variant: id}).dark),
            })),
            selected: this._palette.get_string('variant'),
        });
        this._variants.margin_top = this._variants.margin_bottom = 12;
        this._variants.margin_start = this._variants.margin_end = 12;
        this._variants.connect('changed', (_, id) => this._palette.set_string('variant', id));
        variantsRow.set_child(this._variants);
        group.add(variantsRow);
        return group;
    }

    // Regular, clear or off – which GNOME's high contrast always turns off –
    // and how much darker all of it is.
    _buildGlassGroup() {
        const group = new Adw.PreferencesGroup();
        this._glassRow = new Adw.ActionRow({title: 'Glass'});
        this._glassToggles = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});
        for (const [name, label] of GLASS)
            this._glassToggles.add(new Adw.Toggle({name, label}));
        this._glassToggles.connect('notify::active-name', () => {
            const name = this._glassToggles.active_name;
            if (name && name !== this._settings.get_string('glass-variant'))
                this._settings.set_string('glass-variant', name);
        });
        this._glassRow.add_suffix(naturalWidth(this._glassToggles));
        group.add(this._glassRow);

        // The same on every surface of glass, written as it is moved.
        this._dimRow = new Adw.ActionRow({
            title: 'Darkening',
            subtitle: 'The same on all of the glass. More keeps light type legible over bright wallpapers',
        });
        this._dimScale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, page_increment: 10}),
            draw_value: true,
            value_pos: Gtk.PositionType.LEFT,
            digits: 0,
            width_request: 220,
            valign: Gtk.Align.CENTER,
        });
        this._dimScale.set_format_value_func((_, value) => `${Math.round(value)} %`);
        this._dimScale.connect('value-changed', () => {
            const dim = Math.round(this._dimScale.get_value()) / 100;
            if (Math.abs(dim - this._settings.get_double('glass-dim')) > 1e-6)
                this._settings.set_double('glass-dim', dim);
        });
        this._dimRow.add_suffix(this._dimScale);
        group.add(this._dimRow);
        const a11y = Gio.SettingsSchemaSource.get_default().lookup('org.gnome.desktop.a11y.interface', true);
        this._a11y = a11y?.has_key('high-contrast')
            ? new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'}) : null;
        return group;
    }

    _syncGlass() {
        const variant = this._settings.get_string('glass-variant');
        if (this._glassToggles.active_name !== variant)
            this._glassToggles.active_name = variant;
        const what = GLASS.find(([name]) => name === variant)?.[2] ?? '';
        this._glassRow.subtitle = this._a11y?.get_boolean('high-contrast') && variant !== 'off'
            ? `${what}. GNOME's high contrast keeps it off for now.` : what;
        // (Solid surfaces are not darkened.)
        this._dimRow.sensitive = variant !== 'off';
    }

    _syncDim() {
        const percent = Math.round(this._settings.get_double('glass-dim') * 100);
        if (Math.round(this._dimScale.get_value()) !== percent)
            this._dimScale.set_value(percent);
    }

    _buildAppsGroup() {
        const group = new Adw.PreferencesGroup({title: 'Apps'});

        const gtk = new Adw.SwitchRow({
            title: 'Color GTK apps',
            subtitle: 'Files, Settings and other GTK apps take the palette\'s accent and a hint of its color. ' +
                'Open apps need a restart.',
            active: this._palette.get_boolean('gtk-apps'),
        });
        gtk.connect('notify::active', () => this._palette.set_boolean('gtk-apps', gtk.active));
        group.add(gtk);

        this._problemRow = new Adw.ActionRow({title: 'GTK apps can\'t be colored', css_classes: ['warning']});
        this._problemRow.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
        group.add(this._problemRow);

        const available = isTerminalAvailable();
        const terminal = new Adw.SwitchRow({
            title: 'Color GNOME Terminal',
            subtitle: available
                ? 'A terminal profile “Atelier” with the palette\'s colors becomes the default. ' +
                  'Switching this off brings your own profile back.'
                : 'GNOME Terminal is not installed',
            active: this._palette.get_boolean('terminal'),
            sensitive: available,
        });
        terminal.connect('notify::active', () => {
            this._palette.set_boolean('terminal', terminal.active);
            // Also when the shell part isn't running: give the user's profile back.
            if (!terminal.active)
                restoreTerminal(this._palette);
        });
        group.add(terminal);
        return group;
    }

    _syncPalette() {
        const palette = this._current();
        let child;
        while ((child = this._previewBox.get_first_child()))
            this._previewBox.remove(child);
        if (!palette) {
            this._previewBox.append(new Gtk.Label({label: 'The palette appears once Atelier runs.', css_classes: ['dim-label']}));
            return;
        }
        for (const [scheme, label] of [['dark', 'Dark'], ['light', 'Light']]) {
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
            box.append(schemePreview(palette[scheme], 150, 86));
            box.append(new Gtk.Label({label, css_classes: ['dim-label']}));
            this._previewBox.append(box);
        }

        while ((child = this._swatchBox.get_first_child()))
            this._swatchBox.remove(child);
        let group = null;
        palette.swatches.forEach((color, index) => {
            const button = new Gtk.ToggleButton({
                css_classes: ['atelier-color-button'],
                child: swatchesPreview([color], 22),
                tooltip_text: color,
                active: this._palette.get_int('swatch') === index,
            });
            if (group)
                button.set_group(group);
            group ??= button;
            button.connect('toggled', () => {
                if (button.active)
                    this._palette.set_int('swatch', index);
            });
            this._swatchBox.append(button);
        });
    }

    _syncSource() {
        const source = this._palette.get_string('source');
        if (this._sourceToggles.active_name !== source)
            this._sourceToggles.active_name = source;
        this._swatchRow.visible = source === 'swatch';
        this._presetRow.visible = source === 'preset';
    }

    _syncProblem() {
        const problem = this._settings.get_string('gtk-css-problem');
        this._problemRow.visible = problem !== '';
        this._problemRow.subtitle = problem;
    }
});
