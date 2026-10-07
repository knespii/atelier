// The notes, kept in ~/.local/share/atelier/notes.json. Changes are
// written a moment later (typing doesn't write every key), in GIO's worker
// threads – a write waits for the disk, and the shell must not – and right
// away when the store goes.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {newNote, parseNotes, serializeNotes, sortNotes} from '../../lib/notes.js';

Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const SAVE_DELAY = 600; // milliseconds
const FLAGS = Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION;

export class NotesStore extends EventEmitter {
    /**
     * @param {string} [path] - where they are kept
     */
    constructor(path = GLib.build_filenamev([GLib.get_user_data_dir(), 'atelier', 'notes.json'])) {
        super();
        this._file = Gio.File.new_for_path(path);
        this._saveId = 0;
        // Writes under way, one after another (a later one is never
        // overtaken by an earlier one).
        this._writing = Promise.resolve();
        this._writes = 0;
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
     * @param {object} [options]
     * @param {boolean} [options.touch] - whether it counts as changed (the
     *   latest changed come first); not for a reminder that came, say
     */
    update(id, changes, {touch = true} = {}) {
        const note = this.get(id);
        if (!note || Object.entries(changes).every(([key, value]) => note[key] === value))
            return;
        Object.assign(note, changes, touch ? {modified: Date.now()} : {});
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

    _contents() {
        GLib.mkdir_with_parents(this._file.get_parent().get_path(), 0o755);
        return new TextEncoder().encode(serializeNotes(this._notes));
    }

    _save() {
        const contents = new GLib.Bytes(this._contents());
        this._writes++;
        this._writing = this._writing
            .then(() => this._file.replace_contents_bytes_async(contents, null, true, FLAGS, null))
            .catch(e => console.error(`Atelier: the notes could not be saved: ${e.message}`))
            .finally(() => this._writes--);
    }

    /** Write what is left to write. */
    destroy() {
        if (!this._saveId)
            return;
        GLib.source_remove(this._saveId);
        this._saveId = 0;
        // After a write under way; otherwise at once, as Atelier goes.
        if (this._writes > 0) {
            this._save();
            return;
        }
        try {
            this._file.replace_contents(this._contents(), null, true, FLAGS, null);
        } catch (e) {
            console.error(`Atelier: the notes could not be saved: ${e.message}`);
        }
    }
}
