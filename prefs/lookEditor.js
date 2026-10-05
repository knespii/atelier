// Dialog for creating or editing a look.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ACCENT_COLORS, AUTO_ACCENT, PICTURE_OPTIONS} from '../lib/looks.js';
import {deleteWallpaperIfUnused, importWallpaper, isInLibrary, prettyName} from '../lib/paths.js';
import {accentForWallpaper, ensureThumbnail, removeThumbnail} from '../lib/thumbnails.js';
import {chooseImages, createThumbnail, toast} from './widgets.js';

const KEEP = 'Don’t change';

const PICTURE_OPTION_LABELS = {
    zoom: 'Zoom',
    centered: 'Centered',
    scaled: 'Scaled',
    stretched: 'Stretched',
    wallpaper: 'Tiled',
    spanned: 'Spanned (all monitors)',
    none: 'None (solid color)',
};

const capitalize = text => text[0].toUpperCase() + text.slice(1);

/**
 * A combo row whose first entry leaves the setting unchanged.
 *
 * @returns {{row: Adw.ComboRow, value: string|null}}
 */
function optionalComboRow({title, values, labels, current}) {
    const all = [null, ...values];
    const model = Gtk.StringList.new([KEEP, ...labels]);
    if (current !== null && !all.includes(current)) {
        // Keep a theme that was uninstalled selectable, so saving doesn't lose it.
        all.push(current);
        model.append(`${current} (not installed)`);
    }
    const row = new Adw.ComboRow({title, model, selected: Math.max(0, all.indexOf(current))});
    return {
        row,
        get value() {
            return all[row.selected] ?? null;
        },
    };
}

export const LookEditor = GObject.registerClass(
class BgChangerLookEditor extends Adw.Dialog {
    /**
     * @param {object} params
     * @param {LookStore} params.store
     * @param {object|null} params.look - null for a new look
     * @param {object} [params.initial] - prefilled fields for a new look
     * @param {object} params.themes - result of scanThemes()
     * @param {boolean} params.userThemesEnabled
     */
    _init({store, look, initial = null, themes, userThemesEnabled}) {
        super._init({
            title: look ? 'Edit Look' : 'New Look',
            content_width: 600,
            content_height: 820,
        });
        this._store = store;
        this._look = look;
        this._draft = look ?? initial ?? {};
        this._themes = themes;
        this._wallpaper = this._draft.wallpaper ?? null;
        // Kept as is unless another wallpaper is chosen (e.g. GNOME's own
        // wallpapers have separate light and dark pictures).
        this._wallpaperDark = this._draft.wallpaperDark ?? null;
        this._accent = this._draft.accentColor ?? null;
        this._nameFromFile = !look && !this._draft.name;

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar({
            show_start_title_buttons: false,
            show_end_title_buttons: false,
        });
        const cancel = new Gtk.Button({label: 'Cancel'});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);
        this._saveButton = new Gtk.Button({label: 'Save', css_classes: ['suggested-action']});
        this._saveButton.connect('clicked', () => this._save());
        header.pack_end(this._saveButton);
        toolbar.add_top_bar(header);

        const page = new Adw.PreferencesPage();
        toolbar.set_content(page);
        this.set_child(toolbar);

        // Rows of a group come before other widgets, so the preview gets its own group.
        const previewGroup = new Adw.PreferencesGroup();
        this._preview = createThumbnail(this._wallpaper, 400, 'bgc-preview');
        this._preview.widget.halign = Gtk.Align.CENTER;
        previewGroup.add(this._preview.widget);
        page.add(previewGroup);
        page.add(this._buildWallpaperGroup());
        page.add(this._buildStyleGroup());
        page.add(this._buildThemeGroup(userThemesEnabled));
    }

    _buildWallpaperGroup() {
        const group = new Adw.PreferencesGroup();

        this._nameRow = new Adw.EntryRow({title: 'Name', text: this._draft.name ?? ''});
        this._nameRow.connect('changed', () => {
            if (this._nameRow.text !== this._autoName)
                this._nameFromFile = false;
        });
        group.add(this._nameRow);

        this._wallpaperRow = new Adw.ActionRow({
            title: 'Wallpaper',
            subtitle_lines: 1,
            use_markup: false, // the subtitle is a file name
        });
        const choose = new Gtk.Button({label: 'Choose…', valign: Gtk.Align.CENTER});
        choose.connect('clicked', () => this._chooseWallpaper().catch(e => toast(this, e.message)));
        this._wallpaperRow.add_suffix(choose);
        this._wallpaperRow.activatable_widget = choose;
        group.add(this._wallpaperRow);
        this._updateWallpaperRow();

        this._fitRow = new Adw.ComboRow({
            title: 'Fit',
            model: Gtk.StringList.new(PICTURE_OPTIONS.map(o => PICTURE_OPTION_LABELS[o])),
            selected: Math.max(0, PICTURE_OPTIONS.indexOf(this._draft.pictureOptions ?? 'zoom')),
        });
        group.add(this._fitRow);
        return group;
    }

    _buildStyleGroup() {
        const group = new Adw.PreferencesGroup({title: 'Style'});

        const schemeRow = new Adw.ActionRow({title: 'Light or dark'});
        this._schemeToggles = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});
        for (const [name, label] of [['keep', 'Keep'], ['default', 'Light'], ['prefer-dark', 'Dark']])
            this._schemeToggles.add(new Adw.Toggle({name, label}));
        const scheme = this._draft.colorScheme ?? null;
        this._schemeToggles.active_name =
            scheme === null ? 'keep' : scheme === 'prefer-dark' ? 'prefer-dark' : 'default';
        schemeRow.add_suffix(this._schemeToggles);
        group.add(schemeRow);

        this._accentRow = new Adw.ActionRow({title: 'Accent color'});
        group.add(this._accentRow);

        const swatches = new Adw.WrapBox({
            child_spacing: 10,
            line_spacing: 10,
            margin_top: 4,
            margin_bottom: 14,
            margin_start: 12,
            margin_end: 12,
        });
        const options = [
            [null, 'neutral', 'action-unavailable-symbolic', KEEP],
            [AUTO_ACCENT, 'neutral', 'color-select-symbolic', 'Auto: match the wallpaper'],
            ...Object.keys(ACCENT_COLORS).map(name => [name, name, null, capitalize(name)]),
        ];
        let first = null;
        for (const [value, cssClass, icon, tooltip] of options) {
            const image = new Gtk.Image({icon_name: icon ?? 'object-select-symbolic'});
            const button = new Gtk.ToggleButton({
                css_classes: ['bgc-swatch', cssClass],
                tooltip_text: tooltip,
                child: image,
                active: this._accent === value,
            });
            if (first)
                button.set_group(first);
            first ??= button;
            const sync = () => {
                image.visible = icon !== null || button.active;
                if (button.active) {
                    this._accent = value;
                    this._updateAccentRow();
                }
            };
            button.connect('toggled', sync);
            sync();
            swatches.append(button);
        }
        const swatchRow = new Adw.PreferencesRow({activatable: false, child: swatches});
        group.add(swatchRow);
        this._updateAccentRow();
        return group;
    }

    _buildThemeGroup(userThemesEnabled) {
        const themes = this._themes;
        const group = new Adw.PreferencesGroup({
            title: 'Themes',
            description: 'Anything left at “Don’t change” stays as it is when you switch to this look.',
        });

        this._gtk = optionalComboRow({
            title: 'GTK theme',
            values: themes.gtk.map(t => t.name),
            labels: themes.gtk.map(t => t.name),
            current: this._draft.gtkTheme ?? null,
        });
        this._gtk.row.connect('notify::selected', () => this._updateGtkRows());
        group.add(this._gtk.row);

        this._gtk4Row = new Adw.SwitchRow({
            title: 'Also theme GTK 4 / libadwaita apps',
            active: this._draft.gtk4 ?? false,
        });
        group.add(this._gtk4Row);

        this._shell = optionalComboRow({
            title: 'Shell theme',
            values: ['', ...themes.shell.map(t => t.name)],
            labels: ['Default (Adwaita)', ...themes.shell.map(t => t.name)],
            current: this._draft.shellTheme ?? null,
        });
        this._userThemesEnabled = userThemesEnabled;
        this._shell.row.connect('notify::selected', () => this._updateShellRow());
        group.add(this._shell.row);

        this._icons = optionalComboRow({
            title: 'Icons',
            values: themes.icons.map(t => t.name),
            labels: themes.icons.map(t => t.displayName),
            current: this._draft.iconTheme ?? null,
        });
        group.add(this._icons.row);

        this._cursor = optionalComboRow({
            title: 'Cursor',
            values: themes.cursors.map(t => t.name),
            labels: themes.cursors.map(t => t.name),
            current: this._draft.cursorTheme ?? null,
        });
        group.add(this._cursor.row);

        const font = this._draft.font ?? null;
        this._fontRow = new Adw.ExpanderRow({
            title: 'Interface font',
            use_markup: false, // the subtitle is a font name
            show_enable_switch: true,
            enable_expansion: font !== null,
            expanded: font !== null,
        });
        const currentFont = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
            .get_string('font-name');
        this._fontButton = new Gtk.FontDialogButton({
            dialog: new Gtk.FontDialog({title: 'Interface Font'}),
            level: Gtk.FontLevel.FONT,
            use_font: true,
            valign: Gtk.Align.CENTER,
            font_desc: Pango.FontDescription.from_string(font ?? currentFont),
        });
        const fontRow = new Adw.ActionRow({title: 'Font'});
        fontRow.add_suffix(this._fontButton);
        this._fontRow.add_row(fontRow);
        const syncFont = () => {
            this._fontRow.subtitle = this._fontRow.enable_expansion
                ? this._fontButton.font_desc.to_string() : KEEP;
        };
        this._fontRow.connect('notify::enable-expansion', syncFont);
        this._fontButton.connect('notify::font-desc', syncFont);
        syncFont();
        group.add(this._fontRow);

        this._updateGtkRows();
        this._updateShellRow();
        return group;
    }

    _updateWallpaperRow() {
        if (!this._wallpaper)
            this._wallpaperRow.subtitle = 'None — the look only changes themes';
        else if (this._wallpaperDark)
            this._wallpaperRow.subtitle = `${prettyName(this._wallpaper)} · with a dark-style variant`;
        else
            this._wallpaperRow.subtitle = prettyName(this._wallpaper);
    }

    _updateAccentRow() {
        const accent = this._accent;
        if (accent === null) {
            this._accentRow.subtitle = KEEP;
        } else if (accent === AUTO_ACCENT) {
            this._accentRow.subtitle = 'Auto: matches the wallpaper';
            const wallpaper = this._wallpaper;
            if (wallpaper) {
                accentForWallpaper(wallpaper).then(color => {
                    if (this._accent === AUTO_ACCENT && this._wallpaper === wallpaper)
                        this._accentRow.subtitle = `Auto: ${capitalize(color)} for this wallpaper`;
                }).catch(() => {});
            }
        } else {
            this._accentRow.subtitle = capitalize(accent);
        }
    }

    _updateGtkRows() {
        const theme = this._themes.gtk.find(t => t.name === this._gtk.value);
        this._gtk.row.subtitle = !theme ? '' : theme.gtk4 ? 'Has a GTK 4 version' : 'GTK 3 apps only';

        this._gtk4Row.sensitive = Boolean(theme?.gtk4);
        if (theme?.gtk4) {
            this._gtk4Row.subtitle = 'Links the theme into ~/.config/gtk-4.0; open apps need a ' +
                'restart. Themes not made for libadwaita 1.7 can break apps.';
        } else {
            this._gtk4Row.active = false;
            this._gtk4Row.subtitle = theme
                ? 'This theme has no GTK 4 version, so libadwaita apps (most GNOME apps) keep their look'
                : 'Pick a GTK theme first';
        }
    }

    _updateShellRow() {
        const row = this._shell.row;
        row.sensitive = this._userThemesEnabled;
        row.remove_css_class('warning');
        if (!this._userThemesEnabled) {
            row.subtitle = 'Needs the User Themes extension to be enabled';
            return;
        }
        const theme = this._themes.shell.find(t => t.name === this._shell.value);
        if (theme?.compat === 'outdated') {
            row.subtitle = '⚠ Made for GNOME 42 or older: on GNOME 48 it breaks the top bar menus, ' +
                'quick settings and notifications';
            row.add_css_class('warning');
        } else {
            row.subtitle = '';
        }
    }

    async _chooseWallpaper() {
        const [path] = await chooseImages(this, false);
        if (!path)
            return;
        this._wallpaper = path;
        this._wallpaperDark = null;
        this._preview.setWallpaper(path);
        this._updateWallpaperRow();
        this._updateAccentRow();
        if (this._nameFromFile || !this._nameRow.text.trim()) {
            this._autoName = prettyName(path);
            this._nameRow.text = this._autoName;
            this._nameFromFile = true;
        }
    }

    async _save() {
        this._saveButton.sensitive = false;
        try {
            let wallpaper = this._wallpaper;
            if (wallpaper && !isInLibrary(wallpaper)) {
                const source = wallpaper;
                wallpaper = await importWallpaper(source);
                if (wallpaper !== source)
                    removeThumbnail(source); // only made for the preview
            }
            let wallpaperDark = wallpaper ? this._wallpaperDark : null;
            if (wallpaperDark && !isInLibrary(wallpaperDark))
                wallpaperDark = await importWallpaper(wallpaperDark);

            const scheme = this._schemeToggles.active_name;
            const fields = {
                name: this._nameRow.text.trim() || (wallpaper ? prettyName(wallpaper) : 'Untitled look'),
                wallpaper,
                wallpaperDark,
                pictureOptions: PICTURE_OPTIONS[this._fitRow.selected] ?? 'zoom',
                colorScheme: scheme === 'keep' ? null : scheme,
                accentColor: this._accent,
                gtkTheme: this._gtk.value,
                gtk4: this._gtk4Row.sensitive && this._gtk4Row.active,
                shellTheme: this._shell.value,
                iconTheme: this._icons.value,
                cursorTheme: this._cursor.value,
                font: this._fontRow.enable_expansion ? this._fontButton.font_desc.to_string() : null,
            };

            if (this._look) {
                const {wallpaper: previous, wallpaperDark: previousDark} = this._look;
                this._store.update(this._look.id, fields);
                const looks = this._store.getAll();
                if (previous && previous !== wallpaper &&
                    await deleteWallpaperIfUnused(previous, looks))
                    removeThumbnail(previous);
                if (previousDark && previousDark !== wallpaperDark)
                    await deleteWallpaperIfUnused(previousDark, looks);
            } else {
                this._store.add(fields);
            }
            if (wallpaper)
                ensureThumbnail(wallpaper).catch(() => {});

            const parent = this.get_root();
            this.close();
            parent?.add_toast?.(new Adw.Toast({
                title: `Saved “${fields.name}”`,
                timeout: 2,
                use_markup: false,
            }));
        } catch (e) {
            console.error('BG Changer: saving a look failed', e);
            toast(this, `Could not save: ${e.message}`);
            this._saveButton.sensitive = true;
        }
    }
});
