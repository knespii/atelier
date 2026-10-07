// Notes pinned to the screen's edges, like sticky notes stuck to its side:
// square papers, all of one size whatever is on them, of which a strip
// peeks out of the edge; one slides out while the pointer rests on it, and
// a click opens it in the island – or, on the button in its corner, puts it
// into the archive. A new one spreads out of the edge where the drop of its
// sheet ran into it. They lie over the windows, or – if so set – on the
// desktop only, under them; on the main monitor only.

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
// The papers below one that went move up (or down) into place.
const MOVE_TIME = 260;
// A new paper spreading out of the edge, once its drop has run into it:
// from a sliver as tall as the drop to its strip.
const SPREAD_TIME = 480;
const SLIVER = 4;
const DROP_HEIGHT = 64;
const LINES = 7;

const EdgeTab = GObject.registerClass({
    Signals: {'archive': {}},
}, class AtelierNoteTab extends St.Button {
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
        // Into the archive: a button in its top corner, there while it is
        // out (in the strip, a click would hit it unseen).
        this._archive = new St.Button({
            style_class: 'atelier-note-tab-archive',
            accessible_name: 'Archive',
            can_focus: false,
            reactive: false,
            opacity: 0,
            // (A bin lays a child out by its alignment only if it expands.)
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'package-x-generic-symbolic'}),
        });
        this._archive.connect('clicked', () => this.emit('archive'));
        const paper = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        paper.add_child(page);
        paper.add_child(this._archive);
        this.child = paper;
        this.sync(note);
        this.connect('notify::hover', () => this._slide());
        this.connect('destroy', () => (this.gone = true));
    }

    sync(note, again = false) {
        // (Writing another note, as every key changes the notes, leaves
        // this one as it is.)
        if (!again && note.title === this._title && note.text === this._text && note.color === this._color &&
            note.remind === this._remind)
            return;
        [this._title, this._text, this._color, this._remind] = [note.title, note.text, note.color, note.remind];
        this.style = paperStyle(note.color);
        this._content.setNote(note.id);
    }

    /** @returns {number[]} [width, height], laid out or not yet */
    get size() {
        return [this.width || this.get_preferred_width(-1)[1], this.height || this.get_preferred_height(-1)[1]];
    }

    // Hidden but for its strip, or out while the pointer rests on it.
    _hiddenOffset() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return (this.size[0] - PEEK * scale) * (this.side === 'left' ? -1 : 1);
    }

    _slide() {
        if (this.leaving || this.waiting)
            return;
        this.get_parent()?.set_child_above_sibling(this, null);
        // (Its button takes clicks once the paper is out.)
        this._archive.reactive = false;
        this.ease({
            translation_x: this.hover ? 0 : this._hiddenOffset(),
            duration: SLIDE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => (this._archive.reactive = this.hover && !this.leaving),
        });
        this._archive.ease({
            opacity: this.hover ? 255 : 0,
            duration: SLIDE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    rest() {
        if (this.leaving)
            return;
        this.remove_transition('translation-x');
        // (Waiting for its drop: all of it in the edge.)
        this.translation_x = this.waiting ? this.size[0] * (this.side === 'left' ? -1 : 1) : this._hiddenOffset();
        this._archive.remove_transition('opacity');
        this._archive.opacity = 0;
        this._archive.reactive = false;
    }

    /** All of it in the edge, until emerge(). */
    hold() {
        this.waiting = true;
        this.rest();
    }

    /**
     * Out of the edge, its strip only (as when the pointer isn't on it):
     * spreading along the edge from where its drop ran into it, a little too
     * far and back.
     */
    emerge() {
        if (!this.waiting)
            return;
        this.waiting = false;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [width, height] = this.size;
        this.remove_transition('translation-x');
        this.translation_x = (width - SLIVER * scale) * (this.side === 'left' ? -1 : 1);
        this.set_pivot_point(0.5, 0.5);
        this.scale_y = Math.min(1, DROP_HEIGHT * scale / height);
        this.ease({
            translation_x: this.hover ? 0 : this._hiddenOffset(),
            scale_y: 1,
            duration: SPREAD_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });
    }

    /**
     * Into the edge, all of it, and gone.
     *
     * @param {Function} done - called once it is
     */
    leave(done) {
        this.leaving = true;
        this.reactive = false;
        this._archive.reactive = false;
        this.ease({
            translation_x: this.width * (this.side === 'left' ? -1 : 1),
            opacity: 0,
            duration: SLIDE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => done(),
        });
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
                // Into its edge and away (at once if it went there already,
                // put into the archive by its button).
                this._tabs.delete(id);
                if (tab.leaving)
                    tab.destroy();
                else
                    tab.leave(() => !tab.gone && tab.destroy());
            } else {
                tab.sync(note);
            }
        }
        for (const note of pinned) {
            if (this._tabs.has(note.id))
                continue;
            const tab = new EdgeTab(this._store, note, note.pin);
            tab.connect('clicked', () => this._open(note.id));
            // (Still a note when it is gone: in the Notes tab's archive.)
            tab.connect('archive', () => tab.leave(() => this._store.update(note.id, {archived: true})));
            this._sheet.add_child(tab);
            if (this._arriving)
                tab.hold();
            // (Over the windows, it takes the clicks the sheet doesn't.)
            if (!this._onDesktop)
                Main.layoutManager.trackChrome(tab, {affectsInputRegion: true, trackFullscreen: false});
            this._tabs.set(note.id, tab);
            // (Placed once it has its size, after it is laid out.)
            tab.connect('notify::width', () => this._queuePlace());
        }
        this._place();
    }

    /**
     * A new note whose paper arrives: it waits in the edge until emerge().
     *
     * @param {Function} create - makes the note, and returns it
     * @returns {object} the note
     */
    arriving(create) {
        this._arriving = true;
        try {
            return create();
        } finally {
            this._arriving = false;
        }
    }

    /**
     * @param {string} id - of a note pinned to an edge
     * @returns {object|null} {x, y, side}: where its paper comes out of the
     *   edge, on the stage (the middle of its side)
     */
    landing(id) {
        const tab = this._tabs.get(id);
        if (!tab || !this._sheet)
            return null;
        const [sheetX, sheetY] = this._sheet.get_transformed_position();
        const [width, height] = tab.size;
        const x = sheetX + tab.x + (tab.side === 'left' ? 0 : width);
        return {x, y: sheetY + tab.y + height / 2, side: tab.side};
    }

    /** @param {string} id - its paper comes out of the edge */
    emerge(id) {
        this._tabs.get(id)?.emerge();
    }

    /** Show them anew (a new day: "Tomorrow" is today now). */
    refresh() {
        const pinned = this._store.pinned();
        for (const [id, tab] of this._tabs) {
            const note = pinned.find(n => n.id === id);
            if (note)
                tab.sync(note, true);
        }
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
                const x = Math.round(side === 'left' ? 0 : area.width - tab.size[0]);
                const y = Math.round(TOP * scale + i * step);
                // (One placed already moves to its new place.)
                if (tab.placed && tab.y !== y) {
                    tab.x = x;
                    tab.ease({y, duration: MOVE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                } else {
                    tab.set_position(x, y);
                }
                tab.placed = true;
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
