// The notes stuck on the desktop: a layer on the wallpaper, over the
// widgets and under the windows, the same whatever the profile. Each note
// with a place there (note.desk) is a sticky.

import St from 'gi://St';

import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {COLORS} from '../../lib/notes.js';
import {Sticky} from './sticky.js';

// Where a new one goes when no place is given: down from the top right.
const START = {right: 300, top: 40, step: 36}; // logical pixels

export class Stickies {
    /**
     * @param {NotesStore} store
     * @param {object} actions - {open(id)}: what the notes module does for them
     */
    constructor(store, actions) {
        this._store = store;
        this._actions = actions;
        this._stickies = new Map();
        this.actor = new St.Widget({name: 'atelier-stickies'});
        this.raise();
        store.connectObject('changed', () => this.sync(), this);
        global.display.connectObject('workareas-changed', () => this._place(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._place(), this);
        this._place();
        this.sync();
    }

    /** @returns {Map<string, Sticky>} the stickies, by note */
    get stickies() {
        return this._stickies;
    }

    /** Over everything else on the wallpaper (the widgets). */
    raise() {
        const group = Main.layoutManager._backgroundGroup;
        if (this.actor.get_parent() !== group)
            group.add_child(this.actor);
        else
            group.set_child_above_sibling(this.actor, null);
    }

    /** @returns {object|null} the work area, {x, y, width, height} */
    _area() {
        const index = Main.layoutManager.primaryIndex;
        return index >= 0 ? Main.layoutManager.getWorkAreaForMonitor(index) : null;
    }

    _place() {
        const area = this._area();
        if (!area)
            return;
        this.actor.set_position(area.x, area.y);
        this.actor.set_size(area.width, area.height);
        this._stickies.forEach(sticky => this._position(sticky));
    }

    // At its place, kept on the screen.
    _position(sticky) {
        const note = this._store.get(sticky.noteId);
        if (!note?.desk || sticky.editing)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const area = this._area();
        const [, width] = sticky.get_preferred_width(-1);
        const x = Math.min(note.desk.x * scale, Math.max(0, area.width - width));
        const y = Math.min(note.desk.y * scale, Math.max(0, area.height - 60 * scale));
        sticky.set_position(Math.max(0, Math.round(x)), Math.max(0, Math.round(y)));
    }

    sync() {
        const stuck = this._store.all().filter(note => note.desk);
        const ids = new Set(stuck.map(note => note.id));
        for (const [id, sticky] of this._stickies) {
            if (!ids.has(id)) {
                this._drop(sticky);
                this._stickies.delete(id);
            }
        }
        for (const note of stuck) {
            let sticky = this._stickies.get(note.id);
            if (!sticky) {
                sticky = new Sticky(this._store, note.id);
                sticky.connect('moved', (_, x, y) => {
                    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
                    this._store.update(note.id, {desk: {x: Math.round(x / scale), y: Math.round(y / scale)}});
                });
                sticky.connect('menu-request', () => this._showMenu(sticky));
                this.actor.add_child(sticky);
                this._stickies.set(note.id, sticky);
            } else {
                sticky.sync();
            }
            this._position(sticky);
        }
    }

    /**
     * A place for a new sticky: where asked, or the next one down the right.
     *
     * @param {number[]} [at] - [x, y] on the stage
     * @returns {object} {x, y} in the work area, logical pixels
     */
    placeFor(at = null) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const area = this._area();
        if (at)
            return {x: Math.round((at[0] - area.x) / scale), y: Math.round((at[1] - area.y) / scale)};
        const count = this._stickies.size % 8;
        return {
            x: Math.round(area.width / scale - START.right - count * START.step / 2),
            y: START.top + count * START.step,
        };
    }

    /**
     * Write on a note's sticky.
     *
     * @param {string} id
     */
    edit(id) {
        this.sync();
        this._stickies.get(id)?.edit();
    }

    _showMenu(sticky) {
        if (!sticky._menu) {
            const menu = new PopupMenu.PopupMenu(sticky, 0.5, St.Side.TOP);
            const id = sticky.noteId;
            menu.addAction('Write', () => sticky.edit());
            menu.addAction('Open in the Island', () => this._actions.open(id));
            const colors = new PopupMenu.PopupSubMenuMenuItem('Color');
            for (const [name, {name: label}] of Object.entries(COLORS))
                colors.menu.addAction(label, () => this._store.update(id, {color: name}));
            menu.addMenuItem(colors);
            menu.addAction('Pin to the Left Edge', () => this._store.update(id, {desk: null, pin: 'left'}));
            menu.addAction('Pin to the Right Edge', () => this._store.update(id, {desk: null, pin: 'right'}));
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            menu.addAction('Off the Desktop', () => this._store.update(id, {desk: null}));
            menu.addAction('Archive', () => this._store.update(id, {desk: null, archived: true}));
            menu.addAction('Delete', () => this._store.remove(id));
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            const manager = new PopupMenu.PopupMenuManager(sticky);
            manager.addMenu(menu);
            sticky._menu = menu;
        }
        sticky._menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _drop(sticky) {
        sticky._menu?.destroy();
        sticky._menu = null;
        sticky.destroy();
    }

    destroy() {
        this._store.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._stickies.forEach(sticky => this._drop(sticky));
        this._stickies.clear();
        this.actor.destroy();
        this.actor = null;
    }
}
