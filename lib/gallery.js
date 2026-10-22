// The photos' gallery: Atelier's own copies of the pictures added, in
// ~/.local/share/atelier/photos – they keep working when the pictures
// themselves are moved or gone. What is in the folder is the gallery; a
// photo's name there says when it was added (lib/photos.js). Each has small
// copies made aside (lib/thumbnails.js): one for the galleries' grids, and
// one as big as a widget shows it. Shared by the shell and the
// preferences: only GLib/Gio may be used here. Both see the folder change,
// whichever of them changed it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {photoDir} from './paths.js';
import {GRID_THUMB, dropPhoto, parseGallery, photoName} from './photos.js';
import {ProfileStore} from './profiles.js';
import {ensurePictureCopy, removePictureCopies} from './thumbnails.js';
import {parseLayout, serializeLayout} from './widgets.js';

Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'copy_async');
Gio._promisify(Gio.File.prototype, 'move_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

// Changes to the folder come in bursts (a copy written, then moved into
// place): told once they have stopped for this long, ms.
const SETTLE = 150;

export class PhotoGallery {
    /**
     * @param {string} [dir] - where the photos are kept
     */
    constructor(dir = photoDir()) {
        this._dir = dir;
        this._photos = null;
        this._listeners = new Map();
        this._nextListener = 1;
        this._monitor = null;
        this._settleId = 0;
    }

    /** @returns {string} where the photos are kept */
    get dir() {
        return this._dir;
    }

    /** @returns {object[]} the photos, the first added first: {id, added, path} */
    photos() {
        if (!this._photos) {
            const names = [];
            try {
                const children = Gio.File.new_for_path(this._dir).enumerate_children('standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE, null);
                for (let info; (info = children.next_file(null));) {
                    if (info.get_file_type() === Gio.FileType.REGULAR)
                        names.push(info.get_name());
                }
            } catch {
                // (No photos yet: no folder either.)
            }
            this._photos = parseGallery(names).map(photo => ({...photo, path: this.path(photo.id)}));
        }
        return this._photos;
    }

    /** @returns {string[]} the photos' names */
    ids() {
        return this.photos().map(photo => photo.id);
    }

    /**
     * @param {string} id
     * @returns {boolean} whether the gallery has it
     */
    has(id) {
        return this.photos().some(photo => photo.id === id);
    }

    /**
     * @param {string} id
     * @returns {string} where the photo is
     */
    path(id) {
        return GLib.build_filenamev([this._dir, id]);
    }

    /**
     * The small copy the galleries' grids show.
     *
     * @param {string} id
     * @returns {Promise<string>} its path
     */
    thumbnail(id) {
        return ensurePictureCopy(this.path(id), GRID_THUMB, GRID_THUMB);
    }

    /**
     * Copy pictures into the gallery (and make their small copies).
     *
     * @param {string[]} paths - of the pictures
     * @returns {Promise<string[]>} the photos' names, of those that are
     *   pictures; the others are left out
     */
    async add(paths) {
        GLib.mkdir_with_parents(this._dir, 0o755);
        const ids = [];
        let added = Date.now();
        for (const path of paths) {
            const source = Gio.File.new_for_path(path);
            let type = '';
            try {
                const info = await source.query_info_async('standard::content-type,standard::display-name',
                    Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
                type = Gio.content_type_get_mime_type(info.get_content_type() ?? '') ?? '';
            } catch (e) {
                console.warn(`Atelier: ${path} could not be added to the photos: ${e.message}`);
                continue;
            }
            if (!type.startsWith('image/'))
                continue;
            // (One after another: each its own time, in the order given.)
            const id = photoName(GLib.path_get_basename(path), added++,
                GLib.uuid_string_random().replace(/-/g, '').slice(0, 6));
            const target = Gio.File.new_for_path(this.path(id));
            // Copied under a hidden name and moved into place when done, so
            // nothing ever reads half a picture (nor lists it).
            const partial = Gio.File.new_for_path(GLib.build_filenamev([this._dir, `.${id}.partial`]));
            try {
                await source.copy_async(partial, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null);
                await partial.move_async(target, Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, null, null);
            } catch (e) {
                partial.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
                console.warn(`Atelier: ${path} could not be added to the photos: ${e.message}`);
                continue;
            }
            ids.push(id);
            await this.thumbnail(id).catch(e => console.warn(`Atelier: no thumbnail of ${path}: ${e.message}`));
        }
        this._changed();
        return ids;
    }

    /**
     * Take a photo out of the gallery, with its small copies – and, given
     * Atelier's settings, out of every widget's choice in every profile.
     *
     * @param {string} id
     * @param {Gio.Settings|null} [settings]
     */
    async remove(id, settings = null) {
        const path = this.path(id);
        if (settings)
            forgetPhoto(settings, id);
        try {
            await Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw e;
        }
        await removePictureCopies(path);
        this._changed();
    }

    /**
     * Be told when the photos change (here, or in the other process).
     *
     * @param {Function} callback - ()
     * @returns {number} to give to disconnect()
     */
    connect(callback) {
        if (!this._monitor) {
            GLib.mkdir_with_parents(this._dir, 0o755);
            try {
                this._monitor = Gio.File.new_for_path(this._dir).monitor_directory(Gio.FileMonitorFlags.NONE, null);
                this._monitor.connect('changed', () => this._settle());
            } catch (e) {
                console.warn(`Atelier: the photos' folder can't be watched: ${e.message}`);
            }
        }
        const id = this._nextListener++;
        this._listeners.set(id, callback);
        return id;
    }

    /** @param {number} id - from connect() */
    disconnect(id) {
        this._listeners.delete(id);
    }

    _settle() {
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE, () => {
            this._settleId = 0;
            this._changed();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Read again, and told – unless nothing changed.
    _changed() {
        const before = JSON.stringify(this._photos?.map(photo => photo.id) ?? null);
        this._photos = null;
        if (JSON.stringify(this.ids()) === before)
            return;
        for (const callback of [...this._listeners.values()]) {
            try {
                callback();
            } catch (e) {
                console.error(`Atelier: ${e.message}\n${e.stack}`);
            }
        }
    }

    destroy() {
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
        this._monitor?.cancel();
        this._monitor = null;
        this._listeners.clear();
    }
}

/**
 * A photo gone from every photo widget's choice: on the desktop now, and
 * in every profile.
 *
 * @param {Gio.Settings} settings - Atelier's
 * @param {string} id
 */
export function forgetPhoto(settings, id) {
    const desktop = settings.get_child('desktop');
    const layout = parseLayout(desktop.get_string('widgets'));
    const kept = dropPhoto(layout, id);
    if (kept !== layout)
        desktop.set_string('widgets', serializeLayout(kept));
    const store = new ProfileStore(settings);
    const profiles = store.getAll();
    const changed = profiles.map(profile => {
        const widgets = profile.widgets;
        const without = widgets ? dropPhoto(widgets.layout, id) : null;
        return without && without !== widgets.layout ? {...profile, widgets: {...widgets, layout: without}} : profile;
    });
    if (changed.some((profile, i) => profile !== profiles[i]))
        store.setAll(changed);
}
