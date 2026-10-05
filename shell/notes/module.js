// Notes: written in the island (the control centre's Notes tab), shown on
// the desktop as widgets and pinned to the screen's edges as tabs. The
// desktop's menu and a shortcut start a new one.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {EdgeTabs} from './edges.js';
import {NotesStore} from './store.js';
import {NotesView} from './view.js';
import {NoteWidget} from './widget.js';

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
        const desktop = this._modules.get('desktop');
        if (desktop) {
            desktop.kinds.delete('note');
            desktop.removeMenuItem('New Note');
            desktop.reload();
        }
        this._edges?.destroy();
        this._edges = null;
        this.view?.destroy();
        this.view = null;
        this.store?.destroy();
        this.store = null;
    }

    // The desktop gets note widgets and "New Note" in its menu.
    _joinDesktop() {
        const desktop = this._modules.get('desktop');
        if (desktop) {
            desktop.kinds.set('note', NoteWidget);
            desktop.addMenuItem('New Note', () => this.open(null, {create: true}));
            desktop.reload();
        }
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

    /**
     * A note for a new note widget: the latest one no widget shows, or a
     * new one.
     *
     * @param {string} widgetId - the widget asking
     * @returns {object} the note
     */
    pickForDesktop(widgetId) {
        const desktop = this._modules.get('desktop');
        const shown = new Set((desktop?.layout ?? []).filter(e => e.id !== widgetId).map(e => e.note));
        return this.store.all().find(note => !shown.has(note.id)) ?? this.store.create({text: ''});
    }
}
