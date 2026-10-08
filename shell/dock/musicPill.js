// Dynamic Music Pill goes where Dash to Dock's row is: Main.panel's
// statusArea['dash-to-dock']._box. While the main dock is a row (at the top
// or the bottom of the screen) that handle leads to its box, and the pill
// sits at the box's end. It is the pill's to keep: given back, never
// destroyed.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MUSIC_PILL = 'dynamic-music-pill@andbal';
const HANDLE = 'dash-to-dock';

export class MusicPill {
    constructor() {
        this._box = null;
    }

    /** @returns {St.BoxLayout|null} the row the pill is told to go to */
    get box() {
        return this._box;
    }

    /**
     * Lead the pill to a row (unless something else has the handle).
     *
     * @param {St.BoxLayout} box
     */
    attach(box) {
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
        Main.extensionManager.lookup(MUSIC_PILL)?.stateObj?._controller?._queueInject?.();
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
