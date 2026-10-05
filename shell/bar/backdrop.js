// The wallpaper behind a bar without background while the overview opens or
// closes. The overview shrinks the desktop into a workspace on a dark
// backdrop; through a clear bar that backdrop would show as a dark band
// coming and going. This strip of the wallpaper covers it, following the
// overview's animation, and is invisible on the desktop and in the overview.

import Clutter from 'gi://Clutter';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Fully there for most of the way, fading only near the overview itself.
const FADE_PORTION = 0.25;

/**
 * @param {number} progress - 0 on the desktop, 1 in the overview (2 in the app grid)
 * @returns {number} opacity of the strip
 */
export function backdropOpacity(progress) {
    if (progress <= 0 || progress >= 1)
        return 0;
    return Math.round(255 * Math.min(1, (1 - progress) / FADE_PORTION));
}

export class PanelBackdrop {
    constructor() {
        this.actor = new Clutter.Actor({name: 'atelier-panel-backdrop', reactive: false, opacity: 0});
        Main.layoutManager.uiGroup.insert_child_below(this.actor, Main.layoutManager.panelBox);
        this._bgManager = null;

        Main.layoutManager.connectObject('monitors-changed', () => this._rebuild(), this);
        Main.layoutManager.panelBox.connectObject('notify::allocation', () => this._updateClip(), this);

        // How far the overview is open, as it animates.
        this._adjustment = Main.overview._overview?.controls?._stateAdjustment ?? null;
        if (this._adjustment) {
            this._adjustment.connectObject('notify::value',
                () => (this.actor.opacity = backdropOpacity(this._adjustment.value)), this);
        }
        this._rebuild();
    }

    _rebuild() {
        this._bgManager?.destroy();
        this._bgManager = null;
        const index = Main.layoutManager.primaryIndex;
        if (index < 0 || !Main.layoutManager.primaryMonitor)
            return;
        this._bgManager = new Background.BackgroundManager({container: this.actor, monitorIndex: index});
        this._updateClip();
    }

    _updateClip() {
        const box = Main.layoutManager.panelBox;
        this.actor.set_clip(box.x, box.y, box.width, box.height);
    }

    destroy() {
        this._adjustment?.disconnectObject(this);
        this._adjustment = null;
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.panelBox.disconnectObject(this);
        this._bgManager?.destroy();
        this._bgManager = null;
        this.actor.destroy();
        this.actor = null;
    }
}
