// Extension icons out of the top bar: each moves into a tile on the
// control centre's Extensions tab, where clicking it does what it did in the
// bar (usually opening its menu). Apps' tray icons, which the AppIndicator
// extension puts into the bar, are named after the app, and a click opens
// the app (the right button its menu). The bar keeps the workspaces, the
// island, GNOME's status icons and the screen sharing and recording
// indicators. Everything goes back when the tray is turned off.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {PopupDummyMenu} from 'resource:///org/gnome/shell/ui/popupMenu.js';

// What stays in the bar: GNOME's own and everything of Atelier's. (GNOME
// puts its own icons in the bar anew when the screen locks, too.)
const KEEP = new Set(['activities', 'dateMenu', 'quickSettings', 'keyboard', 'a11y', 'dwellClick',
    'screenRecording', 'screenSharing']);
const keeps = role => KEEP.has(role) || role.startsWith('atelier');

// Extensions whose button starts something over the whole screen as it is
// pressed: the control centre goes first, at once and unseen. (Color Picker
// picks from a picture of the screen it takes then.)
const COVERS_SCREEN = new Set(['color-picker@tuberry']);

/**
 * An app's tray icon from the AppIndicator extension (Ubuntu's, or the same
 * from extensions.gnome.org) stands for the app behind it, on D-Bus.
 *
 * @param {string} role - key of the button in Main.panel.statusArea
 * @param {PanelMenu.Button} indicator
 * @returns {object|null} the extension's AppIndicator: title, id, open(), supportsActivation
 */
function trayAppOf(role, indicator) {
    const app = indicator._indicator;
    return role.startsWith('appindicator-') && typeof app?.open === 'function' ? app : null;
}

/**
 * @param {string} role - key of the button in Main.panel.statusArea
 * @param {PanelMenu.Button} indicator
 * @returns {string} a name for the tile
 */
function nameFor(role, indicator) {
    // An app's name comes once the app has answered (never the D-Bus address
    // the role is made of).
    const app = trayAppOf(role, indicator);
    if (app) {
        const id = app.id?.replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
        return app.title || indicator.accessible_name || id || '';
    }
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

const Tile = GObject.registerClass({
    Signals: {'opened': {}, 'covering': {}},
}, class AtelierExtensionTile extends St.Widget {
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

        // (An app's tray icon shows, and gets its name, once the app answers.)
        indicator.connectObject(
            'notify::visible', () => this._syncVisible(),
            'notify::accessible-name', () => this._syncName(),
            this);
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
        this._syncName();
    }

    _syncName() {
        const name = nameFor(this.role, this.indicator);
        if (this._label.text !== name)
            this._label.text = name;
    }

    // An app's tray icon opens the app with a click, its own button too (in
    // the bar the extension waits whether a second click comes first); the
    // right button still brings up its menu.
    vfunc_captured_event(event) {
        const pressed = event.type() === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY;
        if (pressed && COVERS_SCREEN.has(this.role) && this.indicator.contains(global.stage.get_event_actor(event))) {
            this.emit('covering');
            return Clutter.EVENT_PROPAGATE;
        }
        const app = trayAppOf(this.role, this.indicator);
        if (!app || app.supportsActivation === false ||
            event.type() !== Clutter.EventType.BUTTON_PRESS || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        // The control centre goes first, so that the app's window comes up.
        this.emit('opened');
        app.open(...event.get_coords(), event.get_time()).catch(logError);
        return Clutter.EVENT_STOP;
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
    Signals: {'changed': {}, 'opened': {}, 'covering': {}},
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
            if (keeps(role) || !indicator?.container || this._moved.some(entry => entry.role === role))
                continue;
            const container = indicator.container;
            const box = this._boxes().find(b => b === container.get_parent());
            if (!box)
                continue;
            const index = box.get_children().indexOf(container);
            const tile = new Tile(role, indicator);
            // (Another extension's button may throw as it is moved – its
            // own handlers, half set up: it stays where it is, the others
            // still come in.)
            try {
                tile.adopt(container);
            } catch (e) {
                console.warn(`Atelier: ${role} could not go into the control centre: ${e.message}`);
                tile.release();
                tile.destroy();
                if (!container.get_parent())
                    box.insert_child_at_index(container, index);
                continue;
            }
            tile.connectObject(
                'notify::visible', () => this._arrange(),
                'opened', () => this.emit('opened'),
                'covering', () => this.emit('covering'),
                this);
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
