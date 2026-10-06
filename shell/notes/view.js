// The notes in the island (the control centre's Notes tab): the papers in
// a grid with a "New note" one, or one of them being written – its title,
// its text (a line starting with "- [ ]" is a checkbox), its color, and
// pinning it to an edge of the screen, archiving or deleting it.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {COLORS, toggleLine} from '../../lib/notes.js';
import {NoteContent, paperStyle} from './card.js';

const COLUMNS = 3;
const PINS = [null, 'left', 'right'];
const PIN_LABELS = {left: 'Pinned left', right: 'Pinned right'};

export const NotesView = GObject.registerClass(
class AtelierNotesView extends St.BoxLayout {
    /**
     * @param {NotesStore} store
     * @param {object} params
     * @param {Function} params.placeOnDesktop - () => where a note stuck on
     *   the desktop goes, {x, y}
     */
    _init(store, {placeOnDesktop}) {
        super._init({style_class: 'atelier-notes', orientation: Clutter.Orientation.VERTICAL});
        this._store = store;
        this._placeOnDesktop = placeOnDesktop;
        this._editing = null;
        this._archived = false;
        store.connectObject('changed', () => this._onChanged(), this);
        this.connect('destroy', () => store.disconnectObject(this));
        this.showGrid();
    }

    /** @returns {string|null} the note being written */
    get editing() {
        return this._editing;
    }

    /** The papers. */
    showGrid() {
        this._editing = null;
        this.destroy_all_children();
        const header = new St.BoxLayout({style_class: 'atelier-notes-header'});
        header.add_child(new St.Label({
            style_class: 'atelier-notes-heading',
            text: this._archived ? 'Archive' : 'Notes',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const archive = new St.Button({
            style_class: 'atelier-notes-button',
            label: this._archived ? 'Notes' : 'Archive',
            can_focus: true,
        });
        archive.connect('clicked', () => {
            this._archived = !this._archived;
            this.showGrid();
        });
        header.add_child(archive);
        this.add_child(header);

        const scroll = new St.ScrollView({
            style_class: 'atelier-notes-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
        });
        const grid = new St.Viewport({
            style_class: 'atelier-notes-grid',
            layout_manager: new Clutter.GridLayout({column_homogeneous: true}),
        });
        grid.layout_manager.hookup_style(grid);
        scroll.child = grid;
        this.add_child(scroll);

        const papers = [];
        if (!this._archived) {
            const add = new St.Button({style_class: 'atelier-note-new', can_focus: true});
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
            box.add_child(new St.Icon({icon_name: 'list-add-symbolic', x_align: Clutter.ActorAlign.CENTER}));
            box.add_child(new St.Label({text: 'New note', x_align: Clutter.ActorAlign.CENTER}));
            add.child = box;
            add.connect('clicked', () => this.edit(this._store.create().id));
            papers.push(add);
        }
        for (const note of this._store.all({archived: this._archived})) {
            const paper = new St.Button({
                style_class: 'atelier-note-paper',
                style: paperStyle(note.color),
                can_focus: true,
                accessible_name: note.title || 'Note',
            });
            const content = new NoteContent(this._store, {maxLines: 4});
            content.setNote(note.id);
            paper.child = content;
            paper.connect('clicked', () => this.edit(note.id));
            papers.push(paper);
        }
        papers.forEach((paper, i) => grid.layout_manager.attach(paper, i % COLUMNS, Math.floor(i / COLUMNS), 1, 1));
        if (this._archived && papers.length === 0)
            this.add_child(new St.Label({style_class: 'atelier-notes-empty', text: 'Nothing in the archive'}));
    }

    /**
     * Write a note.
     *
     * @param {string} id
     */
    edit(id) {
        const note = this._store.get(id);
        if (!note) {
            this.showGrid();
            return;
        }
        this._editing = id;
        this.destroy_all_children();

        const top = new St.BoxLayout({style_class: 'atelier-notes-header'});
        const back = new St.Button({
            style_class: 'atelier-notes-button',
            accessible_name: 'Back to the notes',
            can_focus: true,
            child: new St.Icon({icon_name: 'go-previous-symbolic'}),
        });
        back.connect('clicked', () => this._leave());
        top.add_child(back);
        this._colors = new St.BoxLayout({style_class: 'atelier-note-colors', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        for (const [name, {paper}] of Object.entries(COLORS)) {
            const dot = new St.Button({
                style_class: 'atelier-note-color',
                style: `background-color: ${paper};`,
                accessible_name: COLORS[name].name,
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            dot.connect('clicked', () => this._store.update(id, {color: name}));
            dot._color = name;
            this._colors.add_child(dot);
        }
        top.add_child(this._colors);
        this.add_child(top);

        this._paper = new St.BoxLayout({
            style_class: 'atelier-note-editor',
            orientation: Clutter.Orientation.VERTICAL,
            y_expand: true,
        });
        this.add_child(this._paper);
        this._title = new St.Entry({style_class: 'atelier-note-title-entry', hint_text: 'Title', text: note.title, can_focus: true});
        this._title.clutter_text.connect('text-changed', () => this._store.update(id, {title: this._title.text}));
        this._paper.add_child(this._title);
        // The text from the top, growing down (and scrolled when long); a
        // click under it writes on.
        this._text = new St.Entry({style_class: 'atelier-note-text-entry', hint_text: 'Write something…', text: note.text,
            can_focus: true, x_expand: true});
        const text = this._text.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.connect('text-changed', () => this._store.update(id, {text: this._text.text}));
        const page = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, reactive: true, x_expand: true});
        page.add_child(this._text);
        page.connect('button-press-event', () => {
            this._text.grab_key_focus();
            text.set_cursor_position(-1);
            return Clutter.EVENT_STOP;
        });
        const scroll = new St.ScrollView({
            style_class: 'atelier-note-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
            child: page,
        });
        this._paper.add_child(scroll);

        const bottom = new St.BoxLayout({style_class: 'atelier-note-actions'});
        const button = (label, action, params = {}) => {
            const b = new St.Button({style_class: 'atelier-notes-button', label, can_focus: true, ...params});
            b.connect('clicked', action);
            bottom.add_child(b);
            return b;
        };
        button('Checkbox', () => this._toggleCheckbox());
        // On the desktop as a sticky, or on an edge of the screen.
        this._desk = button('', () => {
            const current = this._store.get(id);
            this._store.update(id, current.desk ? {desk: null} : {desk: this._placeOnDesktop(), pin: null});
        });
        this._pin = button('', () => {
            const current = this._store.get(id);
            const pin = PINS[(PINS.indexOf(current.pin) + 1) % PINS.length];
            this._store.update(id, pin ? {pin, desk: null} : {pin});
        });
        bottom.add_child(new St.Widget({x_expand: true}));
        button(note.archived ? 'Unarchive' : 'Archive', () => {
            this._store.update(id, {archived: !this._store.get(id).archived});
            this._leave();
        });
        button('Delete', () => {
            this._store.remove(id);
            this._editing = null;
            this.showGrid();
        }, {style_class: 'atelier-notes-button atelier-notes-delete'});
        this.add_child(bottom);
        this._syncEditor();
    }

    /** Write a new note. */
    editNew() {
        this.edit(this._store.create().id);
    }

    focus() {
        (this._editing ? this._text : this).grab_key_focus();
    }

    // Back to the papers; a note left empty goes.
    _leave() {
        const note = this._store.get(this._editing);
        if (note && !note.title.trim() && !note.text.trim())
            this._store.remove(note.id);
        this.showGrid();
    }

    // A checkbox at the line the cursor is on (or off it).
    _toggleCheckbox() {
        const note = this._store.get(this._editing);
        if (!note)
            return;
        const text = this._text.clutter_text;
        const position = text.get_cursor_position();
        const before = position < 0 ? note.text : note.text.slice(0, position);
        const line = before.split('\n').length - 1;
        const updated = toggleLine(note.text, line);
        this._text.text = updated;
        text.set_cursor_position(Math.min(updated.length, updated.split('\n').slice(0, line + 1).join('\n').length));
    }

    _syncEditor() {
        const note = this._store.get(this._editing);
        if (!note)
            return;
        this._paper.style = paperStyle(note.color);
        const {ink} = COLORS[note.color];
        for (const entry of [this._title, this._text])
            entry.style = `color: ${ink}; caret-color: ${ink}; selected-color: ${ink};`;
        for (const dot of this._colors.get_children()) {
            if (dot._color === note.color)
                dot.add_style_pseudo_class('checked');
            else
                dot.remove_style_pseudo_class('checked');
        }
        this._pin.label = PIN_LABELS[note.pin] ?? 'Pin to the edge';
        this._desk.label = note.desk ? 'On the desktop' : 'Stick on the desktop';
        if (note.desk)
            this._desk.add_style_pseudo_class('checked');
        else
            this._desk.remove_style_pseudo_class('checked');
    }

    _onChanged() {
        if (this._editing) {
            if (this._store.get(this._editing))
                this._syncEditor();
            else
                this.showGrid();
        } else {
            this.showGrid();
        }
    }
});
