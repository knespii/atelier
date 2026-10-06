// Notes: written in the island (the control centre's Notes tab) and pinned
// to the screen's left (or right) edge as square papers, like sticky notes –
// the same whatever the profile. The desktop's menu and a shortcut start a
// new one.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {EdgeTabs} from './edges.js';
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
    }

    enable() {
        this._notesSettings = this._settings.get_child('notes');
        this.store = new NotesStore();
        this._dropNoteWidgets();
        // The control centre's Notes tab; it outlives the control centre.
        this.view = new NotesView(this.store);
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
        this.view?.destroy();
        this.view = null;
        this.store?.destroy();
        this.store = null;
    }

    // Note widgets on the widgets' grid (of before) went: the notes are on
    // the screen's edge.
    _dropNoteWidgets() {
        const desktop = this._settings.get_child('desktop');
        let layout;
        try {
            layout = JSON.parse(desktop.get_string('widgets'));
        } catch {
            return;
        }
        if (Array.isArray(layout) && layout.some(entry => entry?.kind === 'note'))
            desktop.set_string('widgets', JSON.stringify(layout.filter(entry => entry?.kind !== 'note')));
    }

    // "New Note" in the desktop's menu: a new one, written in the island.
    _joinDesktop() {
        this._modules.get('desktop')?.addMenuItem('New Note', () => this.open(null, {create: true}));
        this._syncEdges();
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
