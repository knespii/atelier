// Notes pinned to the screen's edges: a strip of each paper peeks out of
// the side of the screen and slides out while the pointer rests on it. They
// lie over the windows, or – if so set – on the desktop only, under them.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NoteContent, paperStyle} from './card.js';

const WIDTH = 240; // logical pixels
const PEEK = 14;
const GAP = 10;
const SLIDE_TIME = 180;

const EdgeTab = GObject.registerClass(
class AtelierNoteTab extends St.Button {
    _init(store, note, side) {
        super._init({
            style_class: `atelier-note-tab atelier-note-tab-${side}`,
            track_hover: true,
            can_focus: false,
        });
        this.side = side;
        this.noteId = note.id;
        this._content = new NoteContent(store, {maxLines: 8});
        this.child = this._content;
        this.sync(note);
        this.connect('notify::hover', () => this._slide());
    }

    sync(note) {
        this.style = `${paperStyle(note.color)} width: ${WIDTH}px;`;
        this._content.show(note.id);
    }

    /** How far it is out: hidden but for its strip, or out. */
    _slide() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const hidden = (this.width - PEEK * scale) * (this.side === 'left' ? -1 : 1);
        this.ease({
            translation_x: this.hover ? 0 : hidden,
            duration: SLIDE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    rest() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.remove_transition('translation-x');
        this.translation_x = (this.width - PEEK * scale) * (this.side === 'left' ? -1 : 1);
    }
});

export class EdgeTabs {
    /**
     * @param {NotesStore} store
     * @param {Function} open - (id) opens a note
     */
    constructor(store, open) {
        this._store = store;
        this._open = open;
        this._tabs = new Map();
        this._parent = null;
        this._onDesktop = false;
        store.connectObject('changed', () => this.sync(), this);
        global.display.connectObject('workareas-changed', () => this._place(), this);
    }

    /**
     * @param {St.Widget|null} desktopLayer - the widgets' layer, for tabs
     *   on the desktop only; null for over the windows
     */
    setLayer(desktopLayer) {
        this._onDesktop = desktopLayer !== null;
        this._layer = desktopLayer;
        this._tabs.forEach(tab => this._drop(tab));
        this._tabs.clear();
        this.sync();
    }

    sync() {
        const pinned = this._store.pinned();
        for (const [id, tab] of this._tabs) {
            const note = pinned.find(n => n.id === id);
            if (!note || note.pin !== tab.side) {
                this._drop(tab);
                this._tabs.delete(id);
            } else {
                tab.sync(note);
            }
        }
        for (const note of pinned) {
            if (this._tabs.has(note.id))
                continue;
            const tab = new EdgeTab(this._store, note, note.pin);
            tab.connect('clicked', () => this._open(note.id));
            if (this._onDesktop && this._layer)
                this._layer.add_child(tab);
            else
                Main.layoutManager.addChrome(tab, {trackFullscreen: true});
            this._tabs.set(note.id, tab);
            tab.connect('notify::height', () => this._place());
        }
        this._place();
    }

    _drop(tab) {
        tab.destroy();
    }

    // Stacked down each edge from a quarter of the way.
    _place() {
        const index = Main.layoutManager.primaryIndex;
        const area = index >= 0 ? Main.layoutManager.getWorkAreaForMonitor(index) : null;
        if (!area)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // (In the desktop's layer, positions are within the work area.)
        const [ox, oy] = this._onDesktop ? [0, 0] : [area.x, area.y];
        const next = {left: area.height / 4, right: area.height / 4};
        for (const tab of this._tabs.values()) {
            const x = tab.side === 'left' ? ox : ox + area.width - tab.width;
            tab.set_position(Math.round(x), Math.round(oy + next[tab.side]));
            next[tab.side] += tab.height + GAP * scale;
            if (!tab.hover)
                tab.rest();
        }
    }

    destroy() {
        this._store.disconnectObject(this);
        global.display.disconnectObject(this);
        this._tabs.forEach(tab => this._drop(tab));
        this._tabs.clear();
    }
}
