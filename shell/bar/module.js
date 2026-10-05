// The top bar's look: GNOME's, clear (the workspaces, the island and the
// status icons on the wallpaper) or grouped (the sides in capsules like the
// island, black or glass).

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {capsuleHeight} from '../core/barMetrics.js';
import {GlassSurface} from '../core/glass.js';
import {PanelBackdrop} from './backdrop.js';

const CLEAN = 'atelier-bar-clean';
const GROUPED = 'atelier-bar-grouped';
// Room between a capsule and the screen's edge, logical pixels.
const EDGE = 4;

// A capsule behind one side of the bar.
class Capsule {
    constructor(box, glass) {
        this._box = box;
        if (glass) {
            this.actor = new GlassSurface({reach: 0.1});
        } else {
            this.actor = new St.Widget({style_class: 'atelier-capsule', reactive: false});
        }
        this._glass = glass;
        Main.layoutManager.uiGroup.insert_child_below(this.actor, Main.layoutManager.panelBox);
    }

    get glass() {
        return this._glass;
    }

    /** Wrap the side's items, as tall as the island at rest. */
    update() {
        const box = this._box;
        const panel = Main.panel;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const shown = box.get_children().some(child => child.visible && child.width > 0);
        this.actor.visible = shown && Main.layoutManager.panelBox.visible && panel.visible;
        if (!this.actor.visible)
            return;
        const [boxX] = box.get_transformed_position();
        const [, panelY] = panel.get_transformed_position();
        const height = capsuleHeight(panel.height, scale);
        const edge = EDGE * scale;
        const monitor = Main.layoutManager.primaryMonitor;
        const x = Math.max(boxX, monitor.x + edge);
        const right = Math.min(boxX + box.width, monitor.x + monitor.width - edge);
        const y = Math.round(panelY + (panel.height - height) / 2);
        if (this._glass) {
            this.actor.setShape(x, y, right - x, height, height / 2);
        } else {
            this.actor.set_position(x, y);
            this.actor.set_size(right - x, height);
        }
    }

    destroy() {
        this.actor.destroy();
        this.actor = null;
    }
}

export class BarModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     */
    constructor({settings}) {
        this._settings = settings;
        this._backdrop = null;
        this._capsules = [];
        this._laterId = 0;
    }

    enable() {
        this._barSettings = this._settings.get_child('bar');
        this._barSettings.connectObject(
            'changed::style', () => this._sync(),
            'changed::surface', () => this._sync(),
            this);
        for (const box of [Main.panel._leftBox, Main.panel._rightBox])
            box.connectObject('notify::allocation', () => this._queueUpdate(), this);
        Main.layoutManager.panelBox.connectObject(
            'notify::allocation', () => this._queueUpdate(),
            'notify::visible', () => this._queueUpdate(),
            this);
        this._sync();
    }

    disable() {
        this._barSettings?.disconnectObject(this);
        this._barSettings = null;
        Main.panel._leftBox.disconnectObject(this);
        Main.panel._rightBox.disconnectObject(this);
        Main.layoutManager.panelBox.disconnectObject(this);
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        Main.panel.remove_style_class_name(CLEAN);
        Main.panel.remove_style_class_name(GROUPED);
        this._backdrop?.destroy();
        this._backdrop = null;
        this._capsules.forEach(capsule => capsule.destroy());
        this._capsules = [];
    }

    _sync() {
        const style = this._barSettings.get_string('style');
        const clear = style !== 'gnome';
        const grouped = style === 'grouped';
        const glass = this._barSettings.get_string('surface') === 'glass';

        // Without a background of its own, the bar needs the wallpaper strip
        // while the overview opens and closes.
        if (clear) {
            Main.panel.add_style_class_name(CLEAN);
            this._backdrop ??= new PanelBackdrop();
        } else {
            Main.panel.remove_style_class_name(CLEAN);
            this._backdrop?.destroy();
            this._backdrop = null;
        }

        if (grouped)
            Main.panel.add_style_class_name(GROUPED);
        else
            Main.panel.remove_style_class_name(GROUPED);
        if (!grouped || this._capsules.some(capsule => capsule.glass !== glass)) {
            this._capsules.forEach(capsule => capsule.destroy());
            this._capsules = [];
        }
        if (grouped && this._capsules.length === 0)
            this._capsules = [Main.panel._leftBox, Main.panel._rightBox].map(box => new Capsule(box, glass));
        this._queueUpdate();
    }

    _queueUpdate() {
        if (this._laterId || this._capsules.length === 0)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._capsules.forEach(capsule => capsule.update());
            return GLib.SOURCE_REMOVE;
        });
    }
}
