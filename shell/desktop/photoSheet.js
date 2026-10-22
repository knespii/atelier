// The form on the sheet that drips from the island for a photo widget: the
// gallery's photos in a grid, those the widget shows numbered in the order
// they take turns (a click picks one, or takes it out again), a tile at the
// end that adds pictures to the gallery (through the system's file
// chooser), and how long each shows. What is picked is the widget's at
// once; the gallery itself is managed in Atelier's settings.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {INTERVALS, MAX_PHOTOS, cleanSelection, intervalOf, toggleSelection} from '../../lib/photos.js';

// Tiles in a row of the grid.
const COLUMNS = 5;

export const PhotoSheet = GObject.registerClass({
    Signals: {
        'photos-changed': {},
        'interval-changed': {},
        'add': {},
        'more': {},
        'done': {},
    },
}, class AtelierPhotoSheet extends St.BoxLayout {
    /**
     * @param {PhotoGallery} gallery
     * @param {object} entry - the widget's, in the layout: {photos, interval}
     * @param {Promise<boolean>} canAdd - whether there is a file chooser to add pictures with
     */
    _init(gallery, entry, canAdd) {
        super._init({style_class: 'atelier-photo-sheet', orientation: Clutter.Orientation.VERTICAL});
        this._gallery = gallery;
        this._photos = cleanSelection(entry.photos, gallery.ids());
        this._interval = intervalOf(entry);
        this._canAdd = null;
        this._tiles = [];

        this.add_child(new St.Label({style_class: 'atelier-profile-sheet-title', text: 'Photos'}));
        this._caption = new St.Label({style_class: 'atelier-profile-sheet-caption'});
        this._caption.clutter_text.line_wrap = true;
        this.add_child(this._caption);

        // The grid: as high as it is whatever it holds (the sheet doesn't
        // grow out of its panel), scrolled when there are more.
        this._grid = new St.BoxLayout({style_class: 'atelier-photo-grid', orientation: Clutter.Orientation.VERTICAL});
        this.add_child(new St.ScrollView({
            style_class: 'atelier-photo-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._grid,
        }));
        // (The tile that adds pictures, the last one.)
        this._add = new St.Button({
            style_class: 'atelier-photo-tile atelier-photo-add',
            accessible_name: 'Add Photos',
            can_focus: true,
        });
        const addLabel = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        addLabel.add_child(new St.Icon({icon_name: 'list-add-symbolic', x_align: Clutter.ActorAlign.CENTER}));
        this._addText = new St.Label({style_class: 'atelier-photo-add-label', text: 'Add', x_align: Clutter.ActorAlign.CENTER});
        this._addText.clutter_text.line_wrap = true;
        addLabel.add_child(this._addText);
        this._add.child = addLabel;
        this._add.connect('clicked', () => this.emit('add'));
        canAdd.then(can => {
            this._canAdd = can;
            if (!this._destroyed)
                this._syncAdd();
        });

        // How long each shows.
        const row = new St.BoxLayout({style_class: 'atelier-sheet-row'});
        row.add_child(new St.Label({
            style_class: 'atelier-sheet-label',
            text: 'Each photo for',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const segments = new St.BoxLayout({style_class: 'atelier-sheet-segments', accessible_name: 'Each photo for'});
        this._intervals = INTERVALS.map(([seconds, label]) => {
            const segment = new St.Button({style_class: 'atelier-sheet-segment', label, can_focus: true});
            segment._seconds = seconds;
            segment.connect('clicked', () => {
                this._interval = seconds;
                this._sync();
                this.emit('interval-changed');
            });
            segments.add_child(segment);
            return segment;
        });
        row.add_child(segments);
        this.add_child(row);

        const buttons = new St.BoxLayout({style_class: 'atelier-sheet-buttons'});
        const button = (label, signal, style = '') => {
            const b = new St.Button({style_class: `atelier-sheet-button ${style}`, label, can_focus: true});
            b.connect('clicked', () => this.emit(signal));
            buttons.add_child(b);
            return b;
        };
        button('Manage in Settings…', 'more', 'atelier-sheet-flat');
        buttons.add_child(new St.Widget({x_expand: true}));
        this._done = button('Done', 'done', 'atelier-sheet-primary');
        this.add_child(buttons);

        this._galleryId = gallery.connect(() => this._fill());
        this.connect('destroy', () => {
            this._destroyed = true;
            gallery.disconnect(this._galleryId);
        });
        this._fill();
    }

    /** @returns {string[]} the photos picked, in the order they take turns */
    get photos() {
        return this._photos;
    }

    /** @returns {number} how long each shows, in seconds */
    get interval() {
        return this._interval;
    }

    /** @returns {St.Button[]} the gallery's tiles, in its order (not the one that adds) */
    get tiles() {
        return this._tiles;
    }

    /** @returns {St.Button} the tile that adds pictures to the gallery */
    get addTile() {
        return this._add;
    }

    focus() {
        (this._tiles[0] ?? this._done).grab_key_focus();
    }

    // The gallery's photos, in rows (anew as the gallery changes), and the
    // tile that adds more at their end.
    _fill() {
        if (this._destroyed)
            return;
        this._add.get_parent()?.remove_child(this._add);
        this._grid.destroy_all_children();
        const ids = this._gallery.ids();
        // (One taken out of the gallery is not picked any more.)
        this._photos = cleanSelection(this._photos, ids);
        this._tiles = ids.map(id => this._tile(id));
        const all = [...this._tiles, this._add];
        for (let i = 0; i < all.length; i += COLUMNS) {
            const row = new St.BoxLayout({style_class: 'atelier-photo-row'});
            all.slice(i, i + COLUMNS).forEach(tile => row.add_child(tile));
            this._grid.add_child(row);
        }
        this._sync();
    }

    _tile(id) {
        const tile = new St.Button({style_class: 'atelier-photo-tile', can_focus: true, accessible_name: id});
        tile._id = id;
        tile._badge = new St.Label({
            style_class: 'atelier-photo-badge',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
        });
        tile.child = tile._badge;
        // (Its small copy, made aside if there is none yet.)
        tile.connect('destroy', () => (tile._gone = true));
        this._gallery.thumbnail(id).then(path => {
            if (!tile._gone)
                tile.style = `background-image: url("${Gio.File.new_for_path(path).get_uri()}");`;
        }).catch(e => console.warn(`Atelier: no thumbnail of ${id}: ${e.message}`));
        tile.connect('clicked', () => {
            this._photos = toggleSelection(this._photos, id);
            this._sync();
            this.emit('photos-changed');
        });
        return tile;
    }

    _syncAdd() {
        // (Asked yet, or not there.)
        const can = this._canAdd !== false;
        this._add.reactive = can;
        this._add.can_focus = can;
        this._addText.text = can ? 'Add' : 'No file chooser';
        if (can)
            this._add.remove_style_pseudo_class('insensitive');
        else
            this._add.add_style_pseudo_class('insensitive');
    }

    _sync() {
        const full = this._photos.length >= MAX_PHOTOS;
        for (const tile of this._tiles) {
            const place = this._photos.indexOf(tile._id);
            tile.checked = place >= 0;
            tile._badge.text = place >= 0 ? `${place + 1}` : '';
            tile._badge.visible = place >= 0;
            // (When as many are picked as a widget takes, only those can go.)
            tile.reactive = place >= 0 || !full;
        }
        for (const segment of this._intervals) {
            if (segment._seconds === this._interval)
                segment.add_style_pseudo_class('checked');
            else
                segment.remove_style_pseudo_class('checked');
        }
        const count = this._photos.length;
        this._caption.text = this._tiles.length === 0
            ? 'The gallery has no photos yet: add some, and pick those this widget shows.'
            : count === 0 ? 'Pick the photos this widget shows, one after another, while you can see it.'
                : full ? `${count} picked, as many as a widget takes: they take turns in the order of their numbers.`
                    : `${count} picked: they take turns in the order of their numbers.`;
        this._syncAdd();
    }
});
