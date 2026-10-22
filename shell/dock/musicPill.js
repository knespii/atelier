// Dynamic Music Pill goes where Dash to Dock's row is: Main.panel's
// statusArea['dash-to-dock']._box. While the main dock is a row (at the top
// or the bottom of the screen) that handle leads to its box, and the pill
// sits at the box's end. It is the pill's to keep: given back, never
// destroyed.
//
// The pill holds Dash to Dock open itself while its popups (the player,
// the list of players) are up; Atelier's dock it doesn't know, so the dock
// stays while they show. And as GNOME takes its UI down, the row stops
// telling the pill of its children going: it would come back to it,
// already gone.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MUSIC_PILL = 'dynamic-music-pill@andbal';
const HANDLE = 'dash-to-dock';

export class MusicPill {
    constructor() {
        this._box = null;
        this._dock = null;
        this._popups = new Set();
        this._holding = false;
    }

    /** @returns {St.BoxLayout|null} the row the pill is told to go to */
    get box() {
        return this._box;
    }

    /**
     * Lead the pill to a row (unless something else has the handle).
     *
     * @param {St.BoxLayout} box
     * @param {Dock} [dock] - the dock of the row, kept shown while the
     *   pill's popups are up
     */
    attach(box, dock = null) {
        const statusArea = Main.panel.statusArea;
        if (this._box)
            this.detach(this._box);
        if (Object.getOwnPropertyDescriptor(statusArea, HANDLE))
            return;
        Object.defineProperty(statusArea, HANDLE, {
            get: () => ({_box: box}),
            configurable: true,
            enumerable: false,
        });
        this._box = box;
        this._dock = dock;
        Main.layoutManager.uiGroup.connectObject(
            // (The pill adds its popups as chrome.)
            'child-added', (_, actor) => this._onChrome(actor),
            'destroy', () => this._onShutdown(),
            this);
        this._controller()?._queueInject?.();
    }

    _controller() {
        return Main.extensionManager.lookup(MUSIC_PILL)?.stateObj?._controller ?? null;
    }

    _onChrome(actor) {
        const controller = this._controller();
        if (!controller || this._popups.has(actor) ||
            (actor !== controller._expandedPlayer && actor !== controller._playerMenu))
            return;
        this._popups.add(actor);
        actor.connectObject(
            'notify::visible', () => this._syncHold(),
            'destroy', () => {
                this._popups.delete(actor);
                this._syncHold();
            },
            this);
        this._syncHold();
    }

    _syncHold() {
        const open = [...this._popups].some(popup => popup.visible);
        if (open === this._holding)
            return;
        this._holding = open;
        this._dock?.force(open);
    }

    _release() {
        Main.layoutManager.uiGroup.disconnectObject(this);
        this._popups.forEach(popup => popup.disconnectObject(this));
        this._popups.clear();
        if (this._holding)
            this._dock?.force(false);
        this._holding = false;
        this._dock = null;
    }

    _onShutdown() {
        const box = this._box;
        this._release();
        if (!box)
            return;
        const controller = this._controller();
        if (controller)
            box.disconnectObject(controller);
        delete Main.panel.statusArea[HANDLE];
        this._box = null;
    }

    /**
     * Take the handle away and give the pill back.
     *
     * @param {St.BoxLayout} box
     * @param {Function} [isOwn] - which children of the row are the dock's:
     *   the rest are given back (without it, none are)
     */
    detach(box, isOwn = null) {
        if (this._box === box) {
            this._release();
            delete Main.panel.statusArea[HANDLE];
            this._box = null;
            try {
                Main.extensionManager.lookup(MUSIC_PILL)?.stateObj?._controller?._inject?.();
            } catch (e) {
                console.warn(`Atelier: Dynamic Music Pill could not move back: ${e.message}`);
            }
        }
        // What is still the pill's to give back, never to destroy.
        if (!isOwn)
            return;
        for (const child of box.get_children()) {
            if (!isOwn(child))
                box.remove_child(child);
        }
    }

    destroy() {
        if (this._box)
            this.detach(this._box);
    }
}
