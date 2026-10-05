// The notes, kept in ~/.local/share/atelier/notes.json. Changes are
// written a moment later (typing doesn't write every key), and right away
// when the store goes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {newNote, parseNotes, serializeNotes, sortNotes} from '../../lib/notes.js';

const SAVE_DELAY = 600; // milliseconds

export class NotesStore extends EventEmitter {
    /**
     * @param {string} [path] - where they are kept
     */
    constructor(path = GLib.build_filenamev([GLib.get_user_data_dir(), 'atelier', 'notes.json'])) {
        super();
        this._file = Gio.File.new_for_path(path);
        this._saveId = 0;
        this._notes = [];
        try {
            const [, contents] = this._file.load_contents(null);
            this._notes = parseNotes(new TextDecoder().decode(contents));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Atelier: the notes could not be read: ${e.message}`);
        }
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.archived] - the archived ones instead
     * @returns {object[]} the notes, the latest changed first
     */
    all({archived = false} = {}) {
        return sortNotes(this._notes.filter(note => note.archived === archived));
    }

    /** @returns {object[]} the notes pinned to the screen's edges */
    pinned() {
        return this._notes.filter(note => note.pin && !note.archived).sort((a, b) => a.created - b.created);
    }

    /**
     * @param {string} id
     * @returns {object|null}
     */
    get(id) {
        return this._notes.find(note => note.id === id) ?? null;
    }

    /**
     * @param {object} [fields]
     * @returns {object} the new note
     */
    create(fields = {}) {
        const note = newNote(this._notes, fields);
        this._notes.push(note);
        this._changed();
        return note;
    }

    /**
     * @param {string} id
     * @param {object} changes - e.g. {title}, {text}, {color}, {archived}, {pin}
     */
    update(id, changes) {
        const note = this.get(id);
        if (!note || Object.entries(changes).every(([key, value]) => note[key] === value))
            return;
        Object.assign(note, changes, {modified: Date.now()});
        this._changed();
    }

    /** @param {string} id */
    remove(id) {
        const count = this._notes.length;
        this._notes = this._notes.filter(note => note.id !== id);
        if (this._notes.length !== count)
            this._changed();
    }

    _changed() {
        this.emit('changed');
        if (!this._saveId) {
            this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY, () => {
                this._saveId = 0;
                this._save();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _save() {
        try {
            this._file.get_parent().make_directory_with_parents(null);
        } catch {
            // it exists
        }
        try {
            this._file.replace_contents(new TextEncoder().encode(serializeNotes(this._notes)),
                null, true, Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`Atelier: the notes could not be saved: ${e.message}`);
        }
    }

    /** Write what is left to write. */
    destroy() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._save();
        }
    }
}
