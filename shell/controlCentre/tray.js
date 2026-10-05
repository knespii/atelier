// Extension icons out of the top bar: each moves into a tile on the
// control centre's Extensions tab, where clicking it does what it did in the
// bar (usually opening its menu). The bar keeps the workspaces, the island,
// GNOME's status icons and the screen sharing and recording indicators.
// Everything goes back when the tray is turned off.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PopupDummyMenu} from 'resource:///org/gnome/shell/ui/popupMenu.js';

// What stays in the bar.
const KEEP = new Set([
    'activities', 'dateMenu', 'quickSettings', 'keyboard', 'screenRecording', 'screenSharing',
    'atelier-island', 'atelier@local',
]);

/**
 * @param {string} role - key of the button in Main.panel.statusArea
 * @param {PanelMenu.Button} indicator
 * @returns {string} a name for the tile
 */
function nameFor(role, indicator) {
    const extension = Main.extensionManager.lookup(role) ??
        Main.extensionManager.getUuids().map(uuid => Main.extensionManager.lookup(uuid))
            .find(ext => ext?.uuid.split('@')[0] === role);
    if (extension?.metadata?.name)
        return extension.metadata.name;
    const accessible = indicator.accessible_name?.replace(/\s*indicator$/i, '').trim();
    if (accessible)
        return accessible;
    return role.split('@')[0].replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

const Tile = GObject.registerClass(
class AtelierExtensionTile extends St.Widget {
    _init(role, indicator) {
        super._init({
            style_class: 'atelier-ext-tile',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
        });
        this.role = role;
        this.indicator = indicator;

        // The extension's own button, filling the tile above the name.
        const slot = new St.Bin({style_class: 'atelier-ext-slot', x_expand: true, y_expand: true});
        this.add_child(slot);
        this._slot = slot;
        this._label = new St.Label({
            style_class: 'atelier-ext-label',
            text: nameFor(role, indicator),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            y_expand: true,
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this._label);

        indicator.connectObject('notify::visible', () => this._syncVisible(), this);
        indicator.container.connectObject('notify::visible', () => this._syncVisible(), this);
        this._syncVisible();
    }

    /** @returns {string} */
    get name() {
        return this._label.text;
    }

    adopt(container) {
        container.get_parent()?.remove_child(container);
        container.add_style_class_name('atelier-ext-button');
        this._slot.set_child(container);
    }

    release() {
        const container = this.indicator.container;
        this.indicator.disconnectObject(this);
        container.disconnectObject(this);
        container.remove_style_class_name('atelier-ext-button');
        if (this._slot.child === container)
            this._slot.set_child(null);
        return container;
    }

    _syncVisible() {
        this.visible = this.indicator.visible && this.indicator.container.visible;
    }

    vfunc_button_press_event(event) {
        // Presses on the button itself are the extension's; this is the name.
        if (this.indicator.contains(global.stage.get_event_actor(event)))
            return Clutter.EVENT_PROPAGATE;
        if (!(this.indicator.menu instanceof PopupDummyMenu))
            this.indicator.menu?.toggle();
        return Clutter.EVENT_STOP;
    }
});

const COLUMNS = 3;

export const ExtensionTray = GObject.registerClass({
    Signals: {'changed': {}},
}, class AtelierExtensionTray extends St.Widget {
    _init() {
        const layout = new Clutter.GridLayout({column_homogeneous: true});
        super._init({
            style_class: 'atelier-ext-tray',
            layout_manager: layout,
            x_align: Clutter.ActorAlign.CENTER,
        });
        layout.hookup_style(this);
        this._moved = []; // {role, tile, box, index}, in the order they moved
        this._laterId = 0;

        for (const box of this._boxes())
            box.connectObject('child-added', () => this._queueScan(), this);
        this._scan();
    }

    /** @returns {AtelierExtensionTile[]} tiles of extensions that show something */
    get tiles() {
        return this._moved.map(entry => entry.tile).filter(tile => tile.visible);
    }

    _boxes() {
        return [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
    }

    _queueScan() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._scan();
            return false;
        });
    }

    _scan() {
        let changed = false;
        for (const [role, indicator] of Object.entries(Main.panel.statusArea)) {
            if (KEEP.has(role) || !indicator?.container || this._moved.some(entry => entry.role === role))
                continue;
            const container = indicator.container;
            const box = this._boxes().find(b => b === container.get_parent());
            if (!box)
                continue;
            const index = box.get_children().indexOf(container);
            const tile = new Tile(role, indicator);
            tile.adopt(container);
            tile.connectObject('notify::visible', () => this._arrange(), this);
            indicator.connectObject('destroy', () => this._forget(role), this);
            this.layout_manager.attach(tile, 0, 0, 1, 1);
            this._moved.push({role, tile, box, index});
            changed = true;
        }
        if (changed)
            this._arrange();
    }

    /** Rows of three, without gaps for hidden tiles. */
    _arrange() {
        this.tiles.forEach((tile, i) => {
            this.layout_manager.child_set_property(this, tile, 'left-attach', i % COLUMNS);
            this.layout_manager.child_set_property(this, tile, 'top-attach', Math.floor(i / COLUMNS));
        });
        this.emit('changed');
    }

    _forget(role) {
        const index = this._moved.findIndex(entry => entry.role === role);
        if (index < 0)
            return;
        const [{tile}] = this._moved.splice(index, 1);
        tile.destroy();
        this._arrange();
    }

    /** Put every icon back where it was in the bar. */
    restore() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._boxes().forEach(box => box.disconnectObject(this));
        for (const {tile, box, index} of this._moved.reverse()) {
            tile.indicator.disconnectObject(this);
            const container = tile.release();
            box.insert_child_at_index(container, Math.min(index, box.get_n_children()));
            tile.destroy();
        }
        this._moved = [];
    }
});
