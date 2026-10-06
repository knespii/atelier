// Notes: written in the island (the control centre's Notes tab), stuck on
// the desktop like sticky notes and pinned to the screen's edges as tabs –
// the same whatever the profile. The desktop's menu and a shortcut start a
// new one.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {cellOrigin} from '../../lib/widgets.js';
import {EdgeTabs} from './edges.js';
import {Stickies} from './stickies.js';
import {NotesStore} from './store.js';
import {NotesView} from './view.js';

export class NotesModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     * @param {ModuleManager} context.modules
     */
    constructor({settings, modules}) {
        this._settings = settings;
        this._modules = modules;
        this.store = null;
        this.view = null;
        this.stickies = null;
    }

    enable() {
        this._notesSettings = this._settings.get_child('notes');
        this.store = new NotesStore();
        this._adoptNoteWidgets();
        this.stickies = new Stickies(this.store, {open: id => this.open(id)});
        // The control centre's Notes tab; it outlives the control centre.
        this.view = new NotesView(this.store, {placeOnDesktop: () => this.stickies.placeFor()});
        this._edges = new EdgeTabs(this.store, id => this.open(id));

        this._notesSettings.connectObject('changed::edges-on-desktop-only', () => this._syncEdges(), this);
        this._modules.connectObject(
            'started', (_, id) => id === 'desktop' && this._joinDesktop(),
            'stopped', (_, id) => id === 'desktop' && this._syncEdges(),
            this);
        this._joinDesktop();
        Main.wm.addKeybinding('atelier-open-notes', this._notesSettings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.open());
    }

    disable() {
        Main.wm.removeKeybinding('atelier-open-notes');
        this._modules.disconnectObject(this);
        this._notesSettings?.disconnectObject(this);
        this._modules.get('desktop')?.removeMenuItem('New Note');
        this._edges?.destroy();
        this._edges = null;
        this.stickies?.destroy();
        this.stickies = null;
        this.view?.destroy();
        this.view = null;
        this.store?.destroy();
        this.store = null;
    }

    // Note widgets on the widgets' grid (before stickies) became stickies
    // where they were.
    _adoptNoteWidgets() {
        const desktop = this._settings.get_child('desktop');
        let layout;
        try {
            layout = JSON.parse(desktop.get_string('widgets'));
        } catch {
            return;
        }
        if (!Array.isArray(layout) || !layout.some(entry => entry?.kind === 'note'))
            return;
        for (const entry of layout.filter(e => e?.kind === 'note')) {
            const note = this.store.get(entry.note);
            if (note && !note.desk) {
                const [x, y] = cellOrigin(Number(entry.x) || 0, Number(entry.y) || 0);
                this.store.update(note.id, {desk: {x, y}, pin: null});
            }
        }
        desktop.set_string('widgets', JSON.stringify(layout.filter(entry => entry?.kind !== 'note')));
    }

    // "New Note" in the desktop's menu sticks a new note where it was asked.
    _joinDesktop() {
        const desktop = this._modules.get('desktop');
        desktop?.addMenuItem('New Note', () => {
            const [x, y] = Main.layoutManager.dummyCursor.get_transformed_position();
            this.newSticky([x, y]);
        });
        this.stickies?.raise();
        this._syncEdges();
    }

    /**
     * Stick a new note on the desktop and write on it.
     *
     * @param {number[]} [at] - [x, y] on the stage
     * @returns {object} the note
     */
    newSticky(at = null) {
        const note = this.store.create({desk: this.stickies.placeFor(at)});
        this.stickies.edit(note.id);
        return note;
    }

    _syncEdges() {
        const onDesktop = this._notesSettings.get_boolean('edges-on-desktop-only');
        this._edges?.setLayer(onDesktop ? this._modules.get('desktop')?.layer ?? null : null);
    }

    /**
     * Open the notes in the island.
     *
     * @param {string|null} [id] - a note to write, or the list
     * @param {object} [options]
     * @param {boolean} [options.create] - a new note
     */
    open(id = null, {create = false} = {}) {
        const controlCentre = this._modules.get('control-centre');
        if (!controlCentre?.available)
            return;
        controlCentre.open('notes');
        if (create)
            this.view.editNew();
        else if (id)
            this.view.edit(id);
        else
            this.view.showGrid();
        this.view.focus();
    }
}
