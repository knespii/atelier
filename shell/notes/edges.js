// Notes pinned to the screen's edges, like sticky notes stuck to its side:
// square papers, all of one size whatever is on them, of which a strip
// peeks out of the edge; one slides out while the pointer rests on it, and
// a click opens it in the island. They lie over the windows, or – if so
// set – on the desktop only, under them; on the main monitor only.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NoteContent, paperStyle} from './card.js';

const PEEK = 18; // logical pixels of a paper that show at the edge
const TOP = 56; // where the first paper is
const GAP = 12;
const SLIDE_TIME = 180;
const LINES = 7;

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
        this._content = new NoteContent(store, {maxLines: LINES, wrap: true});
        // Written from the top of the paper down; what doesn't fit is cut
        // off at its bottom. (Not the paper itself: it would cut its shadow
        // into its rounded corners.)
        const page = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        page.add_child(this._content);
        this.child = page;
        this.sync(note);
        this.connect('notify::hover', () => this._slide());
    }

    sync(note) {
        this.style = paperStyle(note.color);
        this._content.setNote(note.id);
    }

    // Hidden but for its strip, or out while the pointer rests on it.
    _hiddenOffset() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return (this.width - PEEK * scale) * (this.side === 'left' ? -1 : 1);
    }

    _slide() {
        this.get_parent()?.set_child_above_sibling(this, null);
        this.ease({
            translation_x: this.hover ? 0 : this._hiddenOffset(),
            duration: SLIDE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    rest() {
        this.remove_transition('translation-x');
        this.translation_x = this._hiddenOffset();
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
        this._sheet = null;
        this._onDesktop = false;
        store.connectObject('changed', () => this.sync(), this);
        global.display.connectObject('workareas-changed', () => this._place(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._place(), this);
    }

    /**
     * @param {St.Widget|null} desktopLayer - the widgets' layer, for papers
     *   on the desktop only; null for over the windows
     */
    setLayer(desktopLayer) {
        this._dropSheet();
        this._onDesktop = desktopLayer !== null;
        // The papers lie on a sheet as big as the main monitor's work area,
        // which cuts off what is past its edges: a monitor beside it would
        // show the rest of them. The sheet itself has no size, so it is in
        // the way of no click or drop (a drop looks even for actors that
        // don't react).
        const sheet = new St.Widget({name: 'atelier-note-edges', width: 0, height: 0});
        sheet.connect('destroy', () => {
            // (With the desktop's layer, when that goes first.)
            if (this._sheet === sheet) {
                this._sheet = null;
                this._tabs.clear();
            }
        });
        this._sheet = sheet;
        if (desktopLayer) {
            desktopLayer.add_child(sheet);
            // Over the widgets, which a paper sliding out covers.
            desktopLayer.connectObject('child-added', () => desktopLayer.set_child_above_sibling(sheet, null), sheet);
        } else {
            Main.layoutManager.addChrome(sheet, {affectsInputRegion: false, trackFullscreen: true});
        }
        this.sync();
    }

    sync() {
        if (!this._sheet)
            return;
        const pinned = this._store.pinned();
        for (const [id, tab] of this._tabs) {
            const note = pinned.find(n => n.id === id);
            if (!note || note.pin !== tab.side) {
                tab.destroy();
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
            this._sheet.add_child(tab);
            // (Over the windows, it takes the clicks the sheet doesn't.)
            if (!this._onDesktop)
                Main.layoutManager.trackChrome(tab, {affectsInputRegion: true, trackFullscreen: false});
            this._tabs.set(note.id, tab);
            // (Placed once it has its size, after it is laid out.)
            tab.connect('notify::width', () => this._queuePlace());
        }
        this._place();
    }

    _queuePlace() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Down each edge from the top; when there are more than fit, they
    // overlap like a stack of papers.
    _place() {
        const index = Main.layoutManager.primaryIndex;
        const area = index >= 0 ? Main.layoutManager.getWorkAreaForMonitor(index) : null;
        if (!area || !this._sheet)
            return;
        // (The desktop's layer is where the work area is.)
        if (this._onDesktop)
            this._sheet.set_position(0, 0);
        else
            this._sheet.set_position(area.x, area.y);
        this._sheet.set_clip(0, 0, area.width, area.height);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        for (const side of ['left', 'right']) {
            const tabs = [...this._tabs.values()].filter(tab => tab.side === side);
            if (tabs.length === 0)
                continue;
            const size = tabs[0].height || tabs[0].get_preferred_height(-1)[1];
            const room = area.height - (TOP + GAP) * scale - size;
            const step = Math.min(size + GAP * scale, tabs.length > 1 ? room / (tabs.length - 1) : Infinity);
            tabs.forEach((tab, i) => {
                const x = side === 'left' ? 0 : area.width - tab.width;
                tab.set_position(Math.round(x), Math.round(TOP * scale + i * step));
                if (!tab.hover)
                    tab.rest();
            });
        }
    }

    _dropSheet() {
        const sheet = this._sheet;
        this._sheet = null;
        this._tabs.clear();
        sheet?.destroy();
    }

    destroy() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._store.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._dropSheet();
    }
}
