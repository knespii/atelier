// "Desktop" section: the widgets on the desktop – their look, and what the
// GitHub and photo widgets show. Where they are is edited on the desktop
// itself (right-click it, Edit Widgets).

import Adw from 'gi://Adw';
import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {validUser} from '../lib/github.js';
import {ProfileStore, keepWidgets} from '../lib/profiles.js';
import {OptionCards} from './optionCards.js';
import {ShortcutRow} from './shortcutRow.js';

Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');

const STYLES = [
    ['modern', 'Modern', 'Dark cards in the palette\'s colors'],
    ['analogue', 'Analogue', 'Light paper, and a clock with hands'],
];

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// A widget of each look on a bit of wallpaper.
function stylePicture(style) {
    const area = new Gtk.DrawingArea({content_width: 120, content_height: 64});
    area.set_draw_func((_area, cr, w, h) => {
        roundedRect(cr, 0, 0, w, h, 8);
        cr.save();
        cr.clip();
        const wallpaper = new Cairo.LinearGradient(0, 0, w, h);
        wallpaper.addColorStopRGB(0, 0.66, 0.6, 0.5);
        wallpaper.addColorStopRGB(1, 0.24, 0.3, 0.22);
        cr.setSource(wallpaper);
        cr.paint();
        const [x, y, size] = [(w - 48) / 2, (h - 48) / 2, 48];
        roundedRect(cr, x, y, size, size, 10);
        if (style === 'analogue') {
            cr.setSourceRGBA(0.965, 0.945, 0.906, 1);
            cr.fill();
            const [cx, cy, r] = [x + size / 2, y + size / 2, 16];
            cr.setSourceRGBA(0.165, 0.145, 0.122, 1);
            cr.setLineWidth(1.5);
            cr.arc(cx, cy, r, 0, 2 * Math.PI);
            cr.stroke();
            cr.setLineWidth(2.2);
            cr.moveTo(cx, cy);
            cr.lineTo(cx + 7, cy - 4);
            cr.stroke();
            cr.setSourceRGBA(0.75, 0.22, 0.17, 1);
            cr.setLineWidth(1.5);
            cr.moveTo(cx, cy);
            cr.lineTo(cx - 2, cy - 13);
            cr.stroke();
        } else {
            cr.setSourceRGBA(0.07, 0.07, 0.09, 0.85);
            cr.fill();
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(14);
            const extents = cr.textExtents('9:41');
            cr.moveTo(x + (size - extents.width) / 2 - extents.xBearing, y + (size - extents.height) / 2 - extents.yBearing);
            cr.setSourceRGBA(1, 1, 1, 0.95);
            cr.showText('9:41');
        }
        cr.restore();
    });
    return area;
}

export const DesktopPage = GObject.registerClass(
class AtelierDesktopPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Desktop', name: 'desktop'});
        this._ids = [];
        this._bound = [];
        this._desktop = settings.get_child('desktop');

        const widgets = new Adw.PreferencesGroup({
            title: 'Widgets',
            description: 'Right-click the desktop and choose Edit Widgets to add, move, resize or remove them. ' +
                'They lie on the wallpaper, under the windows. Each profile keeps its own widgets and look; ' +
                'the GitHub user and the photo are the same for all.',
        });
        this.add(widgets);
        this._enabled = this._switch(widgets, 'enabled', 'Widgets on the desktop', '');

        const lookRow = new Adw.PreferencesRow({activatable: false});
        const lookBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        lookBox.append(new Gtk.Label({label: 'Look', xalign: 0, css_classes: ['heading']}));
        this._styleDescription = new Gtk.Label({xalign: 0, wrap: true, css_classes: ['dim-label', 'caption']});
        lookBox.append(this._styleDescription);
        this._style = new OptionCards({
            options: STYLES.map(([id, label]) => ({id, label, preview: stylePicture(id)})),
            selected: this._desktop.get_string('style'),
        });
        this._style.margin_top = 10;
        // (The look belongs to the profile in use, like the widgets.)
        this._profiles = new ProfileStore(settings);
        this._style.connect('changed', (_, id) => {
            if (this._desktop.get_string('style') === id)
                return;
            this._desktop.set_string('style', id);
            keepWidgets(this._profiles, this._desktop);
        });
        lookBox.append(this._style);
        lookRow.set_child(lookBox);
        widgets.add(lookRow);
        this._glass = new Adw.SwitchRow({title: 'Glass', subtitle: 'The blurred wallpaper under the Modern cards'});
        this._glass.active = this._desktop.get_boolean('glass');
        this._glass.connect('notify::active', () => {
            if (this._desktop.get_boolean('glass') === this._glass.active)
                return;
            this._desktop.set_boolean('glass', this._glass.active);
            keepWidgets(this._profiles, this._desktop);
        });
        this._ids.push(this._desktop.connect('changed::glass', () => {
            this._glass.active = this._desktop.get_boolean('glass');
        }));
        widgets.add(this._glass);
        // How much of their background the cards keep, in per cent.
        this._opacity = new Adw.SpinRow({
            title: 'Card background',
            subtitle: 'Less, and the wallpaper (or the glass) shows through the cards',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, page_increment: 20}),
        });
        this._opacity.value = Math.round(this._desktop.get_double('card-opacity') * 100);
        this._opacity.connect('notify::value', () => {
            const value = this._opacity.value / 100;
            if (Math.abs(this._desktop.get_double('card-opacity') - value) < 0.001)
                return;
            this._desktop.set_double('card-opacity', value);
            keepWidgets(this._profiles, this._desktop);
        });
        this._ids.push(this._desktop.connect('changed::card-opacity', () => {
            this._opacity.value = Math.round(this._desktop.get_double('card-opacity') * 100);
        }));
        widgets.add(this._opacity);
        const syncStyle = () => {
            const style = this._desktop.get_string('style');
            this._style.setSelected(style);
            this._styleDescription.label = STYLES.find(([id]) => id === style)?.[2] ?? '';
            this._glass.sensitive = style === 'modern';
        };
        syncStyle();
        this._ids.push(this._desktop.connect('changed::style', syncStyle));

        const github = new Adw.PreferencesGroup({
            title: 'GitHub',
            description: 'The GitHub widget shows the contributions of this user, from GitHub\'s public page; ' +
                'no account or token is needed. Any user works.',
        });
        this.add(github);
        this._github = new Adw.EntryRow({title: 'GitHub user', text: this._desktop.get_string('github-user')});
        this._github.connect('changed', () => {
            const user = this._github.text.trim();
            const ok = user === '' || validUser(user);
            if (ok)
                this._github.remove_css_class('error');
            else
                this._github.add_css_class('error');
            if (ok && this._desktop.get_string('github-user') !== user)
                this._desktop.set_string('github-user', user);
        });
        this._ids.push(this._desktop.connect('changed::github-user', () => {
            if (this._github.text.trim() !== this._desktop.get_string('github-user'))
                this._github.text = this._desktop.get_string('github-user');
        }));
        github.add(this._github);

        const notes = new Adw.PreferencesGroup({
            title: 'Notes',
            description: 'Written in the island, on the control centre\'s Notes tab, or with "New Note" in the ' +
                'desktop\'s menu. They are pinned to the left edge of the screen (or the right one) as square ' +
                'papers, like sticky notes, and are the same whatever the profile.',
        });
        this.add(notes);
        this._notesSettings = settings.get_child('notes');
        this._notes = new Adw.SwitchRow({title: 'Notes'});
        this._notesSettings.bind('enabled', this._notes, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push(this._notes, 'active');
        notes.add(this._notes);
        this._edgesOnDesktop = new Adw.SwitchRow({
            title: 'Pinned notes only on the desktop',
            subtitle: 'Under the windows rather than over them',
        });
        this._notesSettings.bind('edges-on-desktop-only', this._edgesOnDesktop, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push(this._edgesOnDesktop, 'active');
        notes.add(this._edgesOnDesktop);
        this._notesShortcut = new ShortcutRow({settings: this._notesSettings, key: 'atelier-open-notes', title: 'Open the notes'});
        notes.add(this._notesShortcut);
        for (const row of [this._edgesOnDesktop, this._notesShortcut]) {
            this._notesSettings.bind('enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            this._bound.push(row, 'sensitive');
        }

        const photo = new Adw.PreferencesGroup({title: 'Photo'});
        this.add(photo);
        this._photo = new Adw.ActionRow({title: 'Picture'});
        const choose = (folder, label) => {
            const button = new Gtk.Button({label, valign: Gtk.Align.CENTER});
            button.connect('clicked', () => this._choose(folder));
            return button;
        };
        this._photo.add_suffix(choose(false, 'Picture…'));
        this._photo.add_suffix(choose(true, 'Folder…'));
        this._clearPhoto = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'No picture',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._clearPhoto.connect('clicked', () => this._desktop.set_string('photo', ''));
        this._photo.add_suffix(this._clearPhoto);
        photo.add(this._photo);
        const syncPhoto = () => {
            const path = this._desktop.get_string('photo');
            this._photo.subtitle = path
                ? GLib.filename_display_name(path)
                : 'A picture, or a folder whose pictures take turns every hour';
            this._clearPhoto.visible = Boolean(path);
        };
        syncPhoto();
        this._ids.push(this._desktop.connect('changed::photo', syncPhoto));
    }

    async _choose(folder) {
        const dialog = new Gtk.FileDialog({
            title: folder ? 'Choose a Folder of Pictures' : 'Choose a Picture',
            modal: true,
        });
        if (!folder) {
            const filter = new Gtk.FileFilter({name: 'Pictures'});
            filter.add_mime_type('image/*');
            const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
            filters.append(filter);
            dialog.filters = filters;
        }
        try {
            const file = folder
                ? await dialog.select_folder(this.get_root(), null)
                : await dialog.open(this.get_root(), null);
            if (file?.get_path())
                this._desktop.set_string('photo', file.get_path());
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                console.warn(`Atelier: choosing a picture failed: ${e.message}`);
        }
    }

    _switch(group, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        this._desktop.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push(row, 'active');
        group.add(row);
        return row;
    }

    disconnectSettings() {
        this._ids.forEach(id => this._desktop.disconnect(id));
        this._ids = [];
        this._notesShortcut.disconnectSettings();
        for (let i = 0; i < this._bound.length; i += 2)
            Gio.Settings.unbind(this._bound[i], this._bound[i + 1]);
        this._bound = [];
    }
});
