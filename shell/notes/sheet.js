// The form on the sheet that drips from the island for a note, new or not:
// a paper to write on – its title and its text, a line starting with "- [ ]"
// a checkbox – in one of the paper colors, and the edge it is pinned to; one
// that is there already can be archived or deleted, too. Ctrl+Enter saves
// it from anywhere on it.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {COLORS, toggleLine} from '../../lib/notes.js';
import {paperStyle} from './card.js';

const PINS = [['left', 'Left'], ['right', 'Right'], [null, 'None']];

export const NoteSheet = GObject.registerClass({
    Signals: {
        'save': {},
        'cancel': {},
        'archive': {},
        'delete': {},
    },
}, class AtelierNoteSheet extends St.BoxLayout {
    /**
     * @param {object|null} [note] - the note to change; none for a new one
     */
    _init(note = null) {
        super._init({style_class: 'atelier-note-sheet', orientation: Clutter.Orientation.VERTICAL});
        // As new notes are: yellow, on the left edge.
        this._color = note?.color ?? 'yellow';
        this._pin = note ? note.pin : 'left';

        // The paper: its title, and its text from the top, scrolled when
        // long; a click under it writes on.
        this._paper = new St.BoxLayout({style_class: 'atelier-note-sheet-paper', orientation: Clutter.Orientation.VERTICAL});
        this._title = new St.Entry({style_class: 'atelier-note-title-entry', hint_text: 'Title', can_focus: true,
            text: note?.title ?? ''});
        this._title.clutter_text.connect('activate', () => this._text.grab_key_focus());
        this._paper.add_child(this._title);
        this._text = new St.Entry({style_class: 'atelier-note-text-entry', hint_text: 'Write something…',
            can_focus: true, x_expand: true, text: note?.text ?? ''});
        const text = this._text.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        const page = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, reactive: true, x_expand: true});
        page.add_child(this._text);
        page.connect('button-press-event', () => {
            this._text.grab_key_focus();
            text.set_cursor_position(-1);
            return Clutter.EVENT_STOP;
        });
        this._paper.add_child(new St.ScrollView({
            style_class: 'atelier-note-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
            child: page,
        }));
        for (const entry of [this._title, this._text]) {
            entry.clutter_text.connect('key-press-event', (_, event) => this._onKey(event));
            entry.clutter_text.connect('text-changed', () => this._sync());
        }
        this.add_child(this._paper);

        // Its color, and where it is pinned.
        const row = new St.BoxLayout({style_class: 'atelier-sheet-row'});
        const colors = new St.BoxLayout({style_class: 'atelier-note-colors', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._colors = Object.entries(COLORS).map(([name, {paper, name: label}]) => {
            const dot = new St.Button({
                style_class: 'atelier-note-color atelier-note-sheet-color',
                style: `background-color: ${paper};`,
                accessible_name: label,
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            dot._color = name;
            dot.connect('clicked', () => {
                this._color = name;
                this._sync();
            });
            colors.add_child(dot);
            return dot;
        });
        row.add_child(colors);
        const pins = new St.BoxLayout({style_class: 'atelier-sheet-segments', accessible_name: 'Pinned to'});
        this._pins = PINS.map(([value, label]) => {
            const segment = new St.Button({style_class: 'atelier-sheet-segment', label, can_focus: true});
            segment._value = value;
            segment.connect('clicked', () => {
                this._pin = value;
                this._sync();
            });
            pins.add_child(segment);
            return segment;
        });
        row.add_child(pins);
        this.add_child(row);

        const buttons = new St.BoxLayout({style_class: 'atelier-sheet-buttons'});
        const button = (label, action, style = '') => {
            const b = new St.Button({style_class: `atelier-sheet-button ${style}`, label, can_focus: true});
            b.connect('clicked', action);
            buttons.add_child(b);
            return b;
        };
        button('Checkbox', () => this._toggleCheckbox(), 'atelier-sheet-flat');
        // One that is there already: into the archive (or out of it), or gone.
        if (note) {
            for (const [icon, name, signal] of [
                ['package-x-generic-symbolic', note.archived ? 'Unarchive' : 'Archive', 'archive'],
                ['user-trash-symbolic', 'Delete', 'delete'],
            ]) {
                const b = new St.Button({
                    style_class: 'atelier-sheet-button atelier-sheet-icon',
                    accessible_name: name,
                    can_focus: true,
                    child: new St.Icon({icon_name: icon}),
                });
                b.connect('clicked', () => this.emit(signal));
                buttons.add_child(b);
            }
        }
        buttons.add_child(new St.Widget({x_expand: true}));
        button('Cancel', () => this.emit('cancel'));
        this._save = button('Save', () => this.emit('save'), 'atelier-sheet-primary');
        this.add_child(buttons);
        this._sync();
    }

    /** @returns {object} {title, text, color, pin} as written */
    get fields() {
        return {title: this._title.text, text: this._text.text, color: this._color, pin: this._pin};
    }

    /** @returns {boolean} whether nothing is written on it */
    get empty() {
        return !this._title.text.trim() && !this._text.text.trim();
    }

    focus() {
        this._text.grab_key_focus();
        // (At the end of what is written.)
        this._text.clutter_text.set_cursor_position(-1);
    }

    _onKey(event) {
        const key = event.get_key_symbol();
        const control = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (control && (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter)) {
            if (!this.empty)
                this.emit('save');
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // A checkbox at the line the cursor is on (or off it).
    _toggleCheckbox() {
        const text = this._text.clutter_text;
        const position = text.get_cursor_position();
        const before = position < 0 ? this._text.text : this._text.text.slice(0, position);
        const line = before.split('\n').length - 1;
        const updated = toggleLine(this._text.text, line);
        this._text.text = updated;
        this._text.grab_key_focus();
        text.set_cursor_position(Math.min(updated.length, updated.split('\n').slice(0, line + 1).join('\n').length));
    }

    _sync() {
        this._paper.style = paperStyle(this._color);
        const {ink} = COLORS[this._color];
        for (const entry of [this._title, this._text])
            entry.style = `color: ${ink}; caret-color: ${ink}; selected-color: ${ink};`;
        for (const dot of this._colors) {
            if (dot._color === this._color)
                dot.add_style_pseudo_class('checked');
            else
                dot.remove_style_pseudo_class('checked');
        }
        for (const segment of this._pins) {
            if (segment._value === this._pin)
                segment.add_style_pseudo_class('checked');
            else
                segment.remove_style_pseudo_class('checked');
        }
        this._save.reactive = !this.empty;
    }
});
