// The notes in the island (the control centre's Notes tab): the papers in a
// grid with a "New note" one, or those in the archive. Their checkboxes tick
// off right on them; a click on a paper opens it (on a sheet that drips from
// the island, written by whoever made the view).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {NoteContent, paperStyle} from './card.js';

const COLUMNS = 3;

export const NotesView = GObject.registerClass({
    Signals: {
        // the "New note" paper, and a paper: whoever made the view writes them
        'create-request': {},
        'open-request': {param_types: [GObject.TYPE_STRING]},
    },
}, class AtelierNotesView extends St.BoxLayout {
    /**
     * @param {NotesStore} store
     */
    _init(store) {
        super._init({style_class: 'atelier-notes', orientation: Clutter.Orientation.VERTICAL});
        this._store = store;
        this._archived = false;
        store.connectObject('changed', () => this.showGrid(), this);
        this.connect('destroy', () => store.disconnectObject(this));
        this.showGrid();
    }

    /** The papers. */
    showGrid() {
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
            add.connect('clicked', () => this.emit('create-request'));
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
            paper.connect('clicked', () => this.emit('open-request', note.id));
            papers.push(paper);
        }
        papers.forEach((paper, i) => grid.layout_manager.attach(paper, i % COLUMNS, Math.floor(i / COLUMNS), 1, 1));
        if (this._archived && papers.length === 0)
            this.add_child(new St.Label({style_class: 'atelier-notes-empty', text: 'Nothing in the archive'}));
    }

    focus() {
        this.grab_key_focus();
    }
});
