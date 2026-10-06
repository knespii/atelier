// A note stuck on the desktop, like a sticky note: as big as what is
// written on it (within bounds), dragged wherever it should be, and written
// on right there – click it, type, click away. A sticky left empty goes.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {COLORS} from '../../lib/notes.js';
import {NoteContent, paperStyle} from './card.js';

const DRAG_THRESHOLD = 4; // logical pixels
const MAX_LINES = 14;

export const Sticky = GObject.registerClass({
    Signals: {
        'menu-request': {},
        'moved': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
    },
}, class AtelierSticky extends St.BoxLayout {
    /**
     * @param {NotesStore} store
     * @param {string} id - the note
     */
    _init(store, id) {
        super._init({
            style_class: 'atelier-sticky',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            track_hover: true,
        });
        this._store = store;
        this.noteId = id;
        this._press = null;
        this._grab = null;
        this._editor = null;
        this._content = new NoteContent(store, {maxLines: MAX_LINES, wrap: true});
        this.add_child(this._content);
        this.connect('destroy', () => this._release());
        this.sync();
    }

    /** @returns {boolean} whether it is being written on */
    get editing() {
        return this._editor !== null;
    }

    sync() {
        const note = this._store.get(this.noteId);
        if (!note)
            return;
        this.style = paperStyle(note.color);
        if (this._editor) {
            const {ink} = COLORS[note.color];
            for (const entry of [this._title, this._text])
                entry.style = `color: ${ink}; caret-color: ${ink}; selected-color: ${ink};`;
        } else {
            this._content.setNote(this.noteId);
        }
    }

    /** Write on it, right here. */
    edit() {
        if (this._editor)
            return;
        const note = this._store.get(this.noteId);
        if (!note)
            return;
        this._content.visible = false;
        this._editor = new St.BoxLayout({style_class: 'atelier-sticky-editor', orientation: Clutter.Orientation.VERTICAL});
        this._title = new St.Entry({style_class: 'atelier-sticky-title', hint_text: 'Title', text: note.title});
        this._title.clutter_text.connect('text-changed', () => this._store.update(this.noteId, {title: this._title.text}));
        this._editor.add_child(this._title);
        this._text = new St.Entry({style_class: 'atelier-sticky-text', hint_text: 'Write something…', text: note.text});
        const text = this._text.clutter_text;
        text.set({single_line_mode: false, activatable: false, line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR});
        text.connect('text-changed', () => this._store.update(this.noteId, {text: this._text.text}));
        this._editor.add_child(this._text);
        this.add_child(this._editor);
        this.add_style_pseudo_class('editing');
        this.sync();

        // The keyboard is the note's until a click elsewhere or Esc.
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this._text.grab_key_focus();
        text.set_cursor_position(-1);
    }

    /** Done writing; a note left empty goes. */
    stopEditing() {
        if (!this._editor)
            return;
        this._release();
        this._editor.destroy();
        this._editor = this._title = this._text = null;
        this.remove_style_pseudo_class('editing');
        this._content.visible = true;
        const note = this._store.get(this.noteId);
        if (note && !note.title.trim() && !note.text.trim())
            this._store.remove(this.noteId);
        else
            this.sync();
    }

    _release() {
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._pressGrab?.dismiss();
        this._pressGrab = null;
    }

    vfunc_key_press_event(event) {
        if (this._editor && event.get_key_symbol() === Clutter.KEY_Escape) {
            this.stopEditing();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_press_event(event) {
        const target = global.stage.get_event_actor(event);
        if (this._editor) {
            // Writing: a click elsewhere ends it.
            if (!this.contains(target))
                this.stopEditing();
            return this.contains(target) ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP;
        }
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            this.emit('menu-request');
            return Clutter.EVENT_STOP;
        }
        // (Its checkboxes tick themselves.)
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || target instanceof St.Button || target.get_parent() instanceof St.Button)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._press = {x, y, fromX: this.x, fromY: this.y, moving: false};
        this._pressGrab = global.stage.grab(this);
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        const press = this._press;
        if (!press)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (!press.moving && Math.hypot(x - press.x, y - press.y) < DRAG_THRESHOLD * scale)
            return Clutter.EVENT_STOP;
        if (!press.moving) {
            press.moving = true;
            this.add_style_pseudo_class('dragged');
            this.get_parent()?.set_child_above_sibling(this, null);
        }
        this.set_position(Math.round(press.fromX + x - press.x), Math.round(press.fromY + y - press.y));
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        const press = this._press;
        if (!press || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._press = null;
        this._pressGrab?.dismiss();
        this._pressGrab = null;
        if (press.moving) {
            this.remove_style_pseudo_class('dragged');
            this.emit('moved', this.x, this.y);
        } else {
            this.edit();
        }
        return Clutter.EVENT_STOP;
    }
});
