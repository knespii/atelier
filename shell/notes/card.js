// A note as a little paper: its title, when it reminds of itself, and its
// lines, the checkboxes among them ready to be ticked off. Shown in the
// island's list of notes, on the desktop and in the tabs on the screen's
// edges.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatDateWithCFormatString, formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';

import {COLORS, dayOffset, displayTitle, lines, toggleLine} from '../../lib/notes.js';

/**
 * @param {string} color - a name from COLORS
 * @returns {string} St style for a paper of that color
 */
export function paperStyle(color) {
    const {paper, ink} = COLORS[color] ?? COLORS.yellow;
    return `background-color: ${paper}; color: ${ink};`;
}

/**
 * @param {number} days - from today
 * @param {number} time - a moment of that day, in milliseconds
 * @returns {string} "Today", "Tomorrow" or the date, e.g. "Fri 10 Oct"
 */
export function dayText(days, time) {
    if (days === 0)
        return 'Today';
    if (days === 1)
        return 'Tomorrow';
    return formatDateWithCFormatString(new Date(time), '%a %-d %b');
}

/**
 * @param {number} time - of a reminder, in milliseconds
 * @returns {string} when, shortly: "15:00", "Tomorrow 9:00", "Fri 10 Oct 9:00"
 *   (the time as the clock has it, 24-hour or not)
 */
export function reminderText(time) {
    const clock = formatTime(new Date(time), {timeOnly: true}).trim();
    const days = dayOffset(time, new Date());
    return days === 0 ? clock : `${dayText(days, time)} ${clock}`;
}

export const NoteContent = GObject.registerClass(
class AtelierNoteContent extends St.BoxLayout {
    /**
     * @param {NotesStore} store
     * @param {object} [options]
     * @param {number} [options.maxLines] - lines shown at most
     * @param {boolean} [options.wrap] - long lines go on, wrapped, instead
     *   of being cut short (the paper grows with them)
     */
    _init(store, {maxLines = 6, wrap = false} = {}) {
        super._init({style_class: 'atelier-note-content', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._store = store;
        this._maxLines = maxLines;
        this._wrap = wrap;
        this._id = null;
    }

    _fit(label) {
        if (this._wrap) {
            label.clutter_text.set({line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR,
                ellipsize: Pango.EllipsizeMode.NONE});
        } else {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        }
        return label;
    }

    /** @param {string|null} id - the note shown */
    setNote(id) {
        this._id = id;
        this.sync();
    }

    sync() {
        this.destroy_all_children();
        const note = this._id ? this._store.get(this._id) : null;
        if (!note)
            return;
        this.add_child(this._fit(new St.Label({style_class: 'atelier-note-title', text: displayTitle(note)})));
        if (note.remind !== null) {
            // (In the paper's ink, a little lighter: St has no opacity in CSS.)
            const reminder = new St.BoxLayout({
                style_class: 'atelier-note-reminder',
                x_align: Clutter.ActorAlign.START,
                opacity: 190,
            });
            reminder.add_child(new St.Icon({icon_name: 'alarm-symbolic', y_align: Clutter.ActorAlign.CENTER}));
            reminder.add_child(new St.Label({text: reminderText(note.remind), y_align: Clutter.ActorAlign.CENTER}));
            this.add_child(reminder);
        }
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
        return this._fit(new St.Label({style_class: 'atelier-note-line', text: text || ' '}));
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
