// A note on the desktop: one of the notes, on its own paper whatever the
// desktop's look. A new note widget shows the latest note not on the
// desktop yet, or a new one; a click opens it in the island.

import GObject from 'gi://GObject';

import {DesktopWidget} from '../desktop/widget.js';
import {NoteContent, paperStyle} from './card.js';

const LINES = {square: 4, card: 4, large: 12};

export const NoteWidget = GObject.registerClass(
class AtelierNoteWidget extends DesktopWidget {
    build(box, size) {
        const notes = this._context.notes();
        if (!notes)
            return;
        if (!this._listening) {
            this._listening = true;
            this._store = notes.store;
            this._store.connectObject('changed', () => this._sync(), this);
        }
        this._content = new NoteContent(notes.store, {maxLines: LINES[size] ?? 4});
        box.add_child(this._content);
        this._sync();
    }

    _sync() {
        const notes = this._context.notes();
        if (!this._content || !notes)
            return;
        let note = notes.store.get(this.entry.note);
        if (!note || note.archived) {
            note = notes.pickForDesktop(this.entry.id);
            this._context.setOption(this.entry.id, 'note', note.id);
            this.entry = {...this.entry, note: note.id};
        }
        this.style = paperStyle(note.color);
        this._content.show(note.id);
    }

    activate() {
        this._context.notes()?.open(this.entry.note);
    }

    cleanup() {
        this._store?.disconnectObject(this);
        this._store = null;
        this._content = null;
    }
});
