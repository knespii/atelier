// Notes: pinned to the screen's left (or right) edge as square papers, like
// sticky notes – the same whatever the profile. One is written on a sheet
// that drips from the island: a new one (from the desktop's menu, or the
// Notes tab), or one clicked on (its paper on the edge, or in the Notes tab,
// the island's place for all of them, which a shortcut opens). A note with
// a reminder brings a notification at its time.

import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {displayTitle, dueReminders, lines} from '../../lib/notes.js';
import {EdgeTabs} from './edges.js';
import {NoteSheet} from './sheet.js';
import {NotesStore} from './store.js';
import {NotesView} from './view.js';

// How long a reminder put off waits ("In 10 min").
const SNOOZE = 10 * 60 * 1000;
// Lines of a note under its title, in its reminder.
const REMINDER_LINES = 3;

// The reminders come from one source of notifications, which stays while
// Atelier is down for the lock screen: what it showed stays in GNOME's
// list. Their buttons reach the notes module running then.
let reminders = null;
let running = null;

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
        this.view.connect('create-request', () => this.create());
        this.view.connect('open-request', (_, id) => this.edit(id));
        this._edges = new EdgeTabs(this.store, id => this.open(id));

        this._notesSettings.connectObject('changed::edges-on-desktop-only', () => this._syncEdges(), this);
        this._modules.connectObject(
            'started', (_, id) => id === 'desktop' && this._joinDesktop(),
            'stopped', (_, id) => id === 'desktop' && this._syncEdges(),
            this);
        this._joinDesktop();
        Main.wm.addKeybinding('atelier-open-notes', this._notesSettings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.open());

        // Reminders: looked at every minute (GNOME's wall clock, which ticks
        // after a suspend and as the clock is set, too) and as the notes
        // change. Those that came while Atelier was down come now.
        running = this;
        this._day = new Date().toDateString();
        this._wallClock = new GnomeDesktop.WallClock({time_only: true});
        this._wallClock.connectObject('notify::clock', () => this._tick(), this);
        this.store.connectObject('changed', () => this._remind(), this);
        this._remind();
    }

    disable() {
        this._wallClock?.disconnectObject(this);
        this._wallClock?.run_dispose();
        this._wallClock = null;
        this.store?.disconnectObject(this);
        if (running === this)
            running = null;
        // Turned off, not just down for the lock screen: its reminders go.
        if (!Main.sessionMode.isLocked)
            reminders?.destroy();
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
     * Open the notes: one on a sheet that drips from the island, or the
     * papers in the island's Notes tab.
     *
     * @param {string|null} [id] - a note to write, or the papers
     * @param {object} [options]
     * @param {boolean} [options.create] - a new note
     */
    open(id = null, {create = false} = {}) {
        if (create)
            this.create();
        else if (id)
            this.edit(id);
        else
            this._openTab();
    }

    /** Write a new note, on a sheet that drips from the island. */
    create() {
        this._openSheet(null);
    }

    /**
     * Change a note, on a sheet that drips from the island.
     *
     * @param {string} id
     */
    edit(id) {
        const note = this.store?.get(id);
        if (note)
            this._openSheet(note);
    }

    // A note on a sheet: saved, or kept when let go of (Esc, a click beside),
    // with something on it – emptied, it goes; archived or deleted from
    // there. (No island to drip from: the papers in the Notes tab.)
    _openSheet(note) {
        // (A page in the island goes back into it as the drop forms.)
        this._modules.get('control-centre')?.close();
        const form = new NoteSheet(note);
        const sheet = this._modules.get('island')?.openSheet(form) ?? null;
        if (!sheet) {
            form.destroy();
            this._openTab();
            return;
        }
        let done = false;
        const finish = action => {
            if (done)
                return;
            done = true;
            const store = this.store;
            const fields = form.fields;
            if (store && note && store.get(note.id)) {
                if (action === 'delete' || (action === 'keep' && form.empty))
                    store.remove(note.id);
                else if (action === 'keep')
                    store.update(note.id, fields);
                else if (action === 'archive')
                    store.update(note.id, {...fields, archived: !note.archived});
            } else if (store && !note && action === 'keep' && !form.empty) {
                store.create(fields);
            }
            sheet.close();
        };
        form.connect('save', () => finish('keep'));
        form.connect('cancel', () => finish('cancel'));
        form.connect('archive', () => finish('archive'));
        form.connect('delete', () => finish('delete'));
        sheet.connect('dismissed', () => finish('keep'));
    }

    _tick() {
        // A new day: "Tomorrow" on the papers is today now.
        const day = new Date().toDateString();
        if (day !== this._day) {
            this._day = day;
            this._edges?.refresh();
            this.view?.showGrid();
        }
        this._remind();
    }

    // The reminders that are due: each a notification, and the note's
    // reminder gone (without counting as a change to it).
    _remind() {
        if (!this.store || this._reminding)
            return;
        this._reminding = true;
        try {
            for (const note of dueReminders(this.store.all(), Date.now())) {
                this.store.update(note.id, {remind: null}, {touch: false});
                this._notify(note);
            }
        } finally {
            this._reminding = false;
        }
    }

    _notify(note) {
        if (!reminders) {
            reminders = new MessageTray.Source({title: 'Notes', iconName: 'alarm-symbolic'});
            reminders.connect('destroy', () => (reminders = null));
            Main.messageTray.add(reminders);
        }
        // Its lines under the title (the first one, when it is the title).
        const title = displayTitle(note);
        const all = lines(note.text).filter(line => line.text.trim());
        const body = (!note.title.trim() && all[0]?.text.trim() === title ? all.slice(1) : all)
            .slice(0, REMINDER_LINES)
            .map(line => (line.checkbox ? `${line.checked ? '☑' : '☐'} ${line.text}` : line.text))
            .join('\n');
        const notification = new MessageTray.Notification({
            source: reminders,
            title,
            body,
            urgency: MessageTray.Urgency.HIGH,
            sound: new MessageTray.Sound(null, 'alarm-clock-elapsed'),
        });
        const id = note.id;
        notification.connect('activated', () => running?.edit(id));
        notification.addAction('Open', () => running?.edit(id));
        notification.addAction('In 10 min', () =>
            running?.store?.update(id, {remind: Date.now() + SNOOZE}, {touch: false}));
        reminders.addNotification(notification);
    }

    _openTab() {
        const controlCentre = this._modules.get('control-centre');
        if (!controlCentre?.available)
            return;
        controlCentre.open('notes');
        this.view.showGrid();
        this.view.focus();
    }
}
