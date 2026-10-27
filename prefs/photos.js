// The photos, on the Desktop page: the gallery (pictures added – Atelier
// keeps copies of its own – shown in a grid, each with a button that takes
// it out again), and the photo widgets of the profile in use, each with
// its own choice of the gallery's photos and how long each shows, picked
// in a dialog as on the sheet the desktop drips from the island.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {PhotoGallery} from '../lib/gallery.js';
import {INTERVALS, cleanSelection, intervalOf, toggleSelection} from '../lib/photos.js';
import {keepWidgets} from '../lib/profiles.js';
import {parseLayout, serializeLayout, sizeName} from '../lib/widgets.js';
import {naturalWidth, toast} from './widgets.js';

Gio._promisify(Gtk.FileDialog.prototype, 'open_multiple', 'open_multiple_finish');

// Logical pixels of a tile in the grids (their small copies are twice as big).
const TILE = 96;

/**
 * A photo of the gallery as a tile: its small copy, rounded.
 *
 * @param {PhotoGallery} gallery
 * @param {string} id
 * @returns {Gtk.Widget}
 */
function photoPicture(gallery, id) {
    const picture = new Gtk.Picture({
        content_fit: Gtk.ContentFit.COVER,
        can_shrink: true,
        width_request: TILE,
        height_request: TILE,
        overflow: Gtk.Overflow.HIDDEN,
        css_classes: ['atelier-thumb'],
    });
    gallery.thumbnail(id)
        .then(path => picture.set_filename(path))
        .catch(e => console.warn(`Atelier: no thumbnail of ${id}: ${e.message}`));
    // (Gtk.Picture asks for the picture's own size; the clamp keeps it a tile.)
    return new Adw.Clamp({maximum_size: TILE, tightening_threshold: TILE, child: picture});
}

/**
 * @param {Gtk.FlowBox} grid
 * @returns {Gtk.Widget[]} what it holds
 */
function gridChildren(grid) {
    const children = [];
    for (let child = grid.get_first_child(); child; child = child.get_next_sibling())
        children.push(child.get_child());
    return children;
}

// (Tiles as big as they are, from the left, as many in a row as fit.)
const newGrid = () => new Gtk.FlowBox({
    selection_mode: Gtk.SelectionMode.NONE,
    column_spacing: 8,
    row_spacing: 8,
    min_children_per_line: 1,
    max_children_per_line: 12,
    homogeneous: true,
    halign: Gtk.Align.START,
});

/**
 * The gallery: add pictures, see them, take them out.
 */
export const PhotosGroup = GObject.registerClass(
class AtelierPhotosGroup extends Adw.PreferencesGroup {
    /**
     * @param {Gio.Settings} settings - Atelier's
     */
    _init(settings) {
        super._init({
            title: 'Photos',
            description: 'One gallery for all the photo widgets: Atelier keeps copies of its own of the pictures ' +
                'added here, so they stay when the pictures are moved. Each photo widget shows those picked for it, ' +
                'one after another while it can be seen: right-click it on the desktop to pick them.',
        });
        this._settings = settings;
        this.gallery = new PhotoGallery();

        const add = new Adw.ButtonRow({title: 'Add Photos…', start_icon_name: 'list-add-symbolic'});
        add.connect('activated', () => this._addPhotos().catch(e => toast(this, e.message)));
        this.add(add);

        const row = new Adw.PreferencesRow({activatable: false});
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        this._empty = new Gtk.Label({
            label: 'No photos yet.',
            xalign: 0,
            css_classes: ['dim-label'],
        });
        box.append(this._empty);
        this.grid = newGrid();
        box.append(this.grid);
        row.set_child(box);
        this.add(row);

        this._galleryId = this.gallery.connect(() => this._fill());
        this._fill();
    }

    // A tile for each photo, with a button that takes it out of the gallery.
    _fill() {
        this.grid.remove_all();
        const photos = this.gallery.photos();
        this._empty.visible = photos.length === 0;
        this.grid.visible = photos.length > 0;
        for (const {id} of photos) {
            const overlay = new Gtk.Overlay({child: photoPicture(this.gallery, id)});
            const remove = new Gtk.Button({
                icon_name: 'window-close-symbolic',
                tooltip_text: 'Remove from the gallery',
                halign: Gtk.Align.END,
                valign: Gtk.Align.START,
                margin_top: 4,
                margin_end: 4,
                css_classes: ['circular', 'osd', 'atelier-photo-remove'],
            });
            remove.connect('clicked', () => this.remove(id).catch(e => toast(this, e.message)));
            overlay.add_overlay(remove);
            overlay.photoId = id;
            overlay.removeButton = remove;
            this.grid.append(overlay);
        }
    }

    /** @returns {Gtk.Widget[]} the tiles, in the gallery's order (each with its photoId) */
    get tiles() {
        return gridChildren(this.grid);
    }

    /**
     * Take a photo out of the gallery, and out of every widget's choice.
     *
     * @param {string} id
     */
    async remove(id) {
        await this.gallery.remove(id, this._settings);
    }

    async _addPhotos() {
        const filter = new Gtk.FileFilter({name: 'Pictures'});
        filter.add_mime_type('image/*');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const dialog = new Gtk.FileDialog({
            title: 'Add Photos',
            filters,
            default_filter: filter,
            initial_folder: Gio.File.new_for_path(
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir()),
        });
        let files;
        try {
            files = await dialog.open_multiple(this.get_root(), null);
        } catch (e) {
            if (e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) ||
                e.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                return;
            throw e;
        }
        const paths = [];
        for (let i = 0; i < files.get_n_items(); i++)
            paths.push(files.get_item(i).get_path());
        const ids = await this.gallery.add(paths.filter(Boolean));
        toast(this, ids.length === 1 ? 'Added 1 photo' : `Added ${ids.length} photos`);
    }

    disconnectSettings() {
        this.gallery.disconnect(this._galleryId);
        this.gallery.destroy();
    }
});

/**
 * The photo widgets of the profile in use: for each, a row that says what
 * it shows, and opens a dialog to pick its photos.
 */
export const PhotoWidgetsGroup = GObject.registerClass(
class AtelierPhotoWidgetsGroup extends Adw.PreferencesGroup {
    /**
     * @param {Gio.Settings} settings - Atelier's
     * @param {ProfileStore} profiles
     * @param {PhotoGallery} gallery
     */
    _init(settings, profiles, gallery) {
        super._init({
            title: 'Photo Widgets',
            description: 'Those of the profile in use: each has its own choice of photos. ' +
                'Without one, a widget shows the picture below.',
        });
        this._desktop = settings.get_child('desktop');
        this._profiles = profiles;
        this._gallery = gallery;
        this.rows = [];
        this._none = new Adw.ActionRow({
            title: 'No photo widgets',
            subtitle: 'Right-click the desktop, choose Edit Widgets and drag a photo out of the gallery.',
        });
        this.add(this._none);
        this._widgetsId = this._desktop.connect('changed::widgets', () => this._fill());
        this._galleryId = gallery.connect(() => this._fill());
        this._fill();
    }

    /** @returns {object[]} the photo widgets on the desktop now, as kept */
    entries() {
        return parseLayout(this._desktop.get_string('widgets')).filter(entry => entry.kind === 'photo');
    }

    _fill() {
        this.rows.forEach(row => this.remove(row));
        const entries = this.entries();
        this._none.visible = entries.length === 0;
        const known = this._gallery.ids();
        this.rows = entries.map((entry, i) => {
            const photos = cleanSelection(entry.photos, known);
            const interval = INTERVALS.find(([seconds]) => seconds === intervalOf(entry))?.[1] ?? `${intervalOf(entry)} s`;
            const row = new Adw.ActionRow({
                title: `Photo ${entries.length > 1 ? `${i + 1} ` : ''}(${sizeName(entry.size)})`,
                subtitle: photos.length === 0 ? 'No photos picked: the picture below'
                    : `${photos.length} photo${photos.length === 1 ? '' : 's'}, each for ${interval}`,
            });
            const choose = new Gtk.Button({label: 'Choose…', valign: Gtk.Align.CENTER});
            choose.connect('clicked', () => this.choose(entry.id));
            row.add_suffix(choose);
            row.widgetId = entry.id;
            this.add(row);
            return row;
        });
    }

    /**
     * Set one of a photo widget's options, kept in the profile in use too.
     *
     * @param {string} id - of the widget
     * @param {string} key - photos or interval
     * @param {*} value
     */
    setOption(id, key, value) {
        const layout = parseLayout(this._desktop.get_string('widgets'));
        this._desktop.set_string('widgets', serializeLayout(layout.map(entry =>
            (entry.id === id ? {...entry, [key]: value} : entry))));
        keepWidgets(this._profiles, this._desktop);
    }

    /**
     * Pick a widget's photos, and how long each shows, in a dialog.
     *
     * @param {string} id - of the widget
     * @returns {Adw.Dialog} the dialog
     */
    choose(id) {
        const entry = this.entries().find(e => e.id === id);
        const dialog = new PhotoChooser(this._gallery, entry ?? {}, {
            photos: photos => this.setOption(id, 'photos', photos),
            interval: seconds => this.setOption(id, 'interval', seconds),
        });
        dialog.present(this);
        return dialog;
    }

    disconnectSettings() {
        this._desktop.disconnect(this._widgetsId);
        this._gallery.disconnect(this._galleryId);
    }
});

/**
 * The gallery's photos to pick from, numbered in the order they take turns,
 * and how long each shows. What is picked is the widget's at once.
 */
export const PhotoChooser = GObject.registerClass(
class AtelierPhotoChooser extends Adw.Dialog {
    /**
     * @param {PhotoGallery} gallery
     * @param {object} entry - the widget's, as kept: {photos, interval}
     * @param {object} changed - {photos(ids), interval(seconds)}: told as they change
     */
    _init(gallery, entry, changed) {
        super._init({title: 'Choose Photos', content_width: 560, content_height: 520});
        this._gallery = gallery;
        this._photos = cleanSelection(entry.photos, gallery.ids());
        this._changed = changed;

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            description: 'A click picks a photo, or takes it out again: they take turns in the order of their numbers.',
        });
        page.add(group);
        const row = new Adw.PreferencesRow({activatable: false});
        this.grid = newGrid();
        this.grid.margin_top = this.grid.margin_bottom = this.grid.margin_start = this.grid.margin_end = 12;
        row.set_child(this.grid);
        group.add(row);

        const timing = new Adw.PreferencesGroup();
        page.add(timing);
        const intervalRow = new Adw.ActionRow({title: 'Each photo for'});
        this.intervals = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});
        for (const [seconds, label] of INTERVALS)
            this.intervals.add(new Adw.Toggle({name: `${seconds}`, label}));
        this.intervals.active_name = `${intervalOf(entry)}`;
        this.intervals.connect('notify::active-name', () => {
            const seconds = Number(this.intervals.active_name);
            if (seconds > 0)
                this._changed.interval(seconds);
        });
        intervalRow.add_suffix(naturalWidth(this.intervals));
        timing.add(intervalRow);

        const toolbar = new Adw.ToolbarView({content: page});
        toolbar.add_top_bar(new Adw.HeaderBar());
        this.set_child(toolbar);

        this._galleryId = gallery.connect(() => {
            this._photos = cleanSelection(this._photos, gallery.ids());
            this._fill();
        });
        this.connect('closed', () => gallery.disconnect(this._galleryId));
        this._fill();
    }

    /** @returns {Gtk.ToggleButton[]} the tiles, in the gallery's order (each with its photoId) */
    get tiles() {
        return gridChildren(this.grid);
    }

    /** @returns {string[]} the photos picked */
    get photos() {
        return this._photos;
    }

    _fill() {
        this.grid.remove_all();
        for (const {id} of this._gallery.photos()) {
            const badge = new Gtk.Label({
                halign: Gtk.Align.START,
                valign: Gtk.Align.START,
                margin_top: 6,
                margin_start: 6,
                css_classes: ['atelier-photo-badge'],
            });
            const overlay = new Gtk.Overlay({child: photoPicture(this._gallery, id)});
            overlay.add_overlay(badge);
            const tile = new Gtk.ToggleButton({child: overlay, css_classes: ['flat', 'atelier-photo-tile']});
            tile.photoId = id;
            tile.badge = badge;
            tile.connect('toggled', () => {
                // (As it is picked already, or not: nothing to change.)
                if (tile.active === this._photos.includes(id))
                    return;
                this._photos = toggleSelection(this._photos, id);
                this._sync();
                this._changed.photos(this._photos);
            });
            this.grid.append(tile);
        }
        this._sync();
    }

    _sync() {
        for (const tile of this.tiles) {
            const place = this._photos.indexOf(tile.photoId);
            tile.active = place >= 0;
            tile.badge.label = place >= 0 ? `${place + 1}` : '';
            tile.badge.visible = place >= 0;
        }
    }
});
