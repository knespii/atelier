// A note as a little paper: its title and lines, the checkboxes among
// them ready to be ticked off. Shown in the island's list of notes, on the
// desktop and in the tabs on the screen's edges.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {COLORS, displayTitle, lines, toggleLine} from '../../lib/notes.js';

/**
 * @param {string} color - a name from COLORS
 * @returns {string} St style for a paper of that color
 */
export function paperStyle(color) {
    const {paper, ink} = COLORS[color] ?? COLORS.yellow;
    return `background-color: ${paper}; color: ${ink};`;
}

export const NoteContent = GObject.registerClass(
class AtelierNoteContent extends St.BoxLayout {
    /**
     * @param {NotesStore} store
     * @param {object} [options]
     * @param {number} [options.maxLines] - lines shown at most
     */
    _init(store, {maxLines = 6} = {}) {
        super._init({style_class: 'atelier-note-content', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._store = store;
        this._maxLines = maxLines;
        this._id = null;
    }

    /** @param {string|null} id - the note shown */
    show(id) {
        this._id = id;
        this.sync();
    }

    sync() {
        this.destroy_all_children();
        const note = this._id ? this._store.get(this._id) : null;
        if (!note)
            return;
        const title = new St.Label({style_class: 'atelier-note-title', text: displayTitle(note)});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(title);
        // The text without its first line when that one is the title.
        const all = lines(note.text).map((line, index) => ({...line, index}));
        const body = note.title.trim() ? all : all.slice(all.findIndex(line => line.text.trim()) + 1);
        const shown = body.filter((line, i) => line.text.trim() || (i > 0 && i < body.length - 1));
        for (const line of shown.slice(0, this._maxLines))
            this.add_child(line.checkbox ? this._checkbox(note, line) : this._text(line.text));
        if (shown.length > this._maxLines) {
            this.add_child(new St.Label({
                style_class: 'atelier-note-more',
                text: `+ ${shown.length - this._maxLines} more`,
            }));
        }
    }

    _text(text) {
        const label = new St.Label({style_class: 'atelier-note-line', text: text || ' '});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return label;
    }

    _checkbox(note, line) {
        const row = new St.BoxLayout({style_class: 'atelier-note-check-row'});
        const box = new St.Button({
            style_class: 'atelier-note-check',
            accessible_name: line.checked ? `Untick ${line.text}` : `Tick ${line.text}`,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'object-select-symbolic'}),
        });
        if (line.checked) {
            box.add_style_pseudo_class('checked');
            row.add_style_pseudo_class('checked');
        }
        box.connect('clicked', () => {
            const current = this._store.get(note.id);
            if (current)
                this._store.update(note.id, {text: toggleLine(current.text, line.index)});
        });
        row.add_child(box);
        const label = this._text(line.text);
        label.add_style_class_name('atelier-note-check-text');
        label.y_align = Clutter.ActorAlign.CENTER;
        row.add_child(label);
        return row;
    }
});
