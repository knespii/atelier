// The dock: the pinned apps and the apps with windows on this workspace,
// in a row at the bottom of the screen, with room at its end for Dynamic
// Music Pill. It moves out of the way of the focused app's windows and
// comes back when the pointer reaches the bottom edge.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {GlassSurface} from '../core/glass.js';
import {DockItem, workspaceWindows} from './icon.js';

const SHOW_TIME = 200; // milliseconds
const HIDE_DELAY = 200;
const CHECK_DELAY = 100;
const MARGIN = 8; // between the dock and the bottom edge, logical pixels
const MUSIC_PILL = 'dynamic-music-pill@andbal';
const HANDLE = 'dash-to-dock';

// Windows that can cover the dock.
const COVERING_TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY];

export class Dock {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings - the dock's
     * @param {boolean} params.glass - of glass rather than dark
     */
    constructor({settings, glass}) {
        this._settings = settings;
        this._items = new Map(); // app id → DockItem
        this._running = []; // ids of running apps not pinned, in the order they came
        this._hidden = false;
        this._overlapped = false;
        this._forced = 0;
        this._timeouts = new Map();
        this._laterId = 0;

        this.actor = new St.Widget({name: 'atelier-dock', reactive: false});
        this._box = new St.BoxLayout({style_class: 'atelier-dock-box'});
        this._container = new St.Bin({style_class: 'atelier-dock', child: this._box, track_hover: true, reactive: true});
        // Apps dropped on it are pinned there.
        this._container._delegate = this;
        this.actor.add_child(this._container);
        Main.layoutManager.addChrome(this.actor, {affectsStruts: false, trackFullscreen: true});

        // The bottom edge brings it back while it is away.
        this._edge = new St.Widget({name: 'atelier-dock-edge', reactive: true, visible: false});
        Main.layoutManager.addChrome(this._edge, {affectsStruts: false, trackFullscreen: true});
        this._edge.connect('enter-event', () => this._reveal());

        if (glass) {
            this._glass = new GlassSurface({reach: 0.25, fromBottom: true});
            this._glass.add_style_class_name('atelier-dock-glass');
            Main.layoutManager.uiGroup.insert_child_below(this._glass, this.actor);
            this._container.add_style_class_name('atelier-dock-glassy');
            for (const signal of ['notify::translation-y', 'notify::allocation'])
                this._container.connect(signal, () => this._syncGlass());
            // (Away with the dock, as when a window is full screen.)
            this.actor.connect('notify::visible', () => this._syncGlass());
        }

        this._separator = new St.Widget({style_class: 'atelier-dock-separator', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._separator);

        AppFavorites.getAppFavorites().connectObject('changed', () => this._queueRedisplay(), this);
        Shell.AppSystem.get_default().connectObject('app-state-changed', () => this._queueRedisplay(), this);
        global.workspace_manager.connectObject('active-workspace-changed', () => {
            this._queueRedisplay();
            this._queueCheck();
        }, this);
        global.display.connectObject(
            'restacked', () => {
                this._queueRedisplay();
                this._queueCheck();
            },
            'window-created', (_, window) => this._watchWindow(window),
            'notify::focus-window', () => this._queueCheck(),
            'workareas-changed', () => this._queuePlace(),
            this);
        Shell.WindowTracker.get_default().connectObject('notify::focus-app', () => this._queueCheck(), this);
        Main.overview.connectObject(
            'showing', () => this._sync(),
            'hidden', () => this._sync(),
            'item-drag-begin', () => this.force(true),
            'item-drag-end', () => this.force(false),
            this);
        this._container.connect('notify::hover', () => this._sync());
        // (Placed again after the row is laid out, not while it is.)
        this._box.connect('notify::width', () => this._queuePlace());
        this._box.connect('notify::height', () => this._queuePlace());
        settings.connectObject('changed::intellihide', () => this._queueCheck(), this);
        global.get_window_actors().forEach(actor => this._watchWindow(actor.meta_window));

        this._redisplay();
        this._place();
        this._check();
        this._attachMusicPill();
    }

    /** @returns {St.BoxLayout} the row of apps */
    get box() {
        return this._box;
    }

    /** @returns {Map<string, DockItem>} the apps in it, by id */
    get items() {
        return this._items;
    }

    /** @returns {boolean} whether it is out of the way */
    get hidden() {
        return this._hidden;
    }

    /**
     * Keep it shown (a menu of it is open, something is being dragged).
     *
     * @param {boolean} forced
     */
    force(forced) {
        this._forced = Math.max(0, this._forced + (forced ? 1 : -1));
        this._sync();
    }

    _iconSize() {
        return this._settings.get_int('icon-size');
    }

    // The apps: pinned ones first, then those with windows here.
    _wanted() {
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const pinned = new Set(favorites.map(app => app.get_id()));
        const system = Shell.AppSystem.get_default();
        const running = system.get_running().filter(app => !pinned.has(app.get_id()) && workspaceWindows(app).length > 0);
        // Stable: those that came earlier stay first.
        const ids = running.map(app => app.get_id());
        this._running = [...this._running.filter(id => ids.includes(id)), ...ids.filter(id => !this._running.includes(id))];
        const byId = new Map(running.map(app => [app.get_id(), app]));
        return {favorites, running: this._running.map(id => byId.get(id))};
    }

    _queueRedisplay() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._redisplay();
            return GLib.SOURCE_REMOVE;
        });
    }

    _redisplay() {
        const {favorites, running} = this._wanted();
        const apps = [...favorites, ...running];
        const ids = new Set(apps.map(app => app.get_id()));
        for (const [id, item] of this._items) {
            if (!ids.has(id) || item.icon.icon.iconSize !== this._iconSize()) {
                this._items.delete(id);
                item.animateOutAndDestroy();
            }
        }
        // Ours first, in order, then whatever else is in the row (the pill).
        let index = 0;
        const place = actor => this._box.set_child_at_index(actor, index++);
        for (const app of favorites)
            place(this._itemFor(app));
        place(this._separator);
        for (const app of running)
            place(this._itemFor(app));
        this._separator.visible = favorites.length > 0 && running.length > 0;
    }

    _itemFor(app) {
        let item = this._items.get(app.get_id());
        if (!item) {
            item = new DockItem(app, this._iconSize());
            item.connect('menu-state-changed', (_, opened) => this.force(opened));
            this._items.set(app.get_id(), item);
            this._box.add_child(item);
            item.show(true);
        }
        item.icon._updateRunningStyle();
        return item;
    }

    _queuePlace() {
        if (this._placeId)
            return;
        this._placeId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._placeId = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Centered at the bottom of the primary monitor.
    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [, width] = this._container.get_preferred_width(-1);
        const [, height] = this._container.get_preferred_height(width);
        const margin = MARGIN * scale;
        this.actor.set_size(Math.ceil(width), Math.ceil(height));
        this.actor.set_position(
            Math.round(monitor.x + (monitor.width - width) / 2),
            Math.round(monitor.y + monitor.height - height - margin));
        this._edge.set_size(Math.ceil(width), Math.max(1, Math.round(scale)));
        this._edge.set_position(this.actor.x, monitor.y + monitor.height - this._edge.height);
        this._syncGlass();
        this._queueCheck();
    }

    _syncGlass() {
        if (!this._glass)
            return;
        const [x, y] = this._container.get_transformed_position();
        const [width, height] = this._container.get_transformed_size();
        const radius = this._container.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
        this._glass.visible = this.actor.visible && this._container.translation_y < height;
        this._glass.setShape(x, y, width, height, radius);
    }

    _watchWindow(window) {
        // (A new window gets its actor a moment later.)
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this.actor)
                window.get_compositor_private()?.connectObject('notify::allocation', () => this._queueCheck(), this);
            return GLib.SOURCE_REMOVE;
        });
        this._queueCheck();
    }

    _queueCheck() {
        this._after('check', CHECK_DELAY, () => this._check());
    }

    // Do the focused app's windows on this workspace cover where it is?
    _check() {
        const focused = Shell.WindowTracker.get_default().focus_app;
        const workspace = global.workspace_manager.get_active_workspace();
        const area = {x: this.actor.x, y: this.actor.y, width: this.actor.width, height: this.actor.height};
        this._overlapped = Boolean(focused) && focused.get_windows().some(window => {
            if (!COVERING_TYPES.includes(window.get_window_type()) || window.minimized ||
                !window.located_on_workspace(workspace) || !window.showing_on_its_workspace())
                return false;
            const rect = window.get_frame_rect();
            return rect.x < area.x + area.width && area.x < rect.x + rect.width &&
                rect.y < area.y + area.height && area.y < rect.y + rect.height;
        });
        this._sync();
    }

    _reveal() {
        this._revealed = true;
        this._sync();
        // Away again once the pointer isn't on it (after a moment to get there).
        this._clear('revealed');
        this._timeouts.set('revealed', GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            if (this._container.hover)
                return GLib.SOURCE_CONTINUE;
            this._timeouts.delete('revealed');
            this._revealed = false;
            this._sync();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _sync() {
        const intellihide = this._settings.get_boolean('intellihide');
        const away = Main.overview.visible ||
            (intellihide && this._overlapped && !this._forced && !this._container.hover && !this._revealed);
        if (away === this._hidden)
            return;
        this._hidden = away;
        this._clear('hide');
        if (away)
            this._after('hide', HIDE_DELAY, () => this._slide(true));
        else
            this._slide(false);
    }

    _slide(away) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._edge.visible = away && !Main.overview.visible;
        this._container.ease({
            translation_y: away ? this._container.height + MARGIN * scale + 2 : 0,
            opacity: away && Main.overview.visible ? 0 : 255,
            duration: SHOW_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._syncGlass(),
        });
    }

    _after(name, delay, callback) {
        this._clear(name);
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeouts.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _clear(name) {
        const id = this._timeouts.get(name);
        if (id)
            GLib.source_remove(id);
        this._timeouts.delete(name);
    }

    // Drag and drop: an app dropped on the dock is pinned where it lands.
    handleDragOver(source) {
        return source?.app ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP;
    }

    acceptDrop(source, _actor, x) {
        const app = source?.app;
        if (!app)
            return false;
        const favorites = AppFavorites.getAppFavorites();
        const pinned = favorites.getFavorites();
        // Before the first pinned item whose middle is right of the drop.
        let position = pinned.findIndex(other => {
            const item = this._items.get(other.get_id());
            if (!item)
                return false;
            const [itemX] = item.get_transformed_position();
            return itemX + item.width / 2 > x + this._container.get_transformed_position()[0];
        });
        if (position < 0)
            position = pinned.length;
        const id = app.get_id();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (favorites.isFavorite(id))
                favorites.moveFavoriteToPos(id, position > pinned.findIndex(a => a.get_id() === id) ? position - 1 : position);
            else
                favorites.addFavoriteAtPos(id, position);
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    // Dynamic Music Pill goes where Dash to Dock's row is: here, now.
    _attachMusicPill() {
        const statusArea = Main.panel.statusArea;
        if (!Object.getOwnPropertyDescriptor(statusArea, HANDLE)) {
            const box = this._box;
            Object.defineProperty(statusArea, HANDLE, {
                get: () => ({_box: box}),
                configurable: true,
                enumerable: false,
            });
            this._handle = true;
        }
        Main.extensionManager.lookup(MUSIC_PILL)?.stateObj?._controller?._queueInject?.();
    }

    _detachMusicPill() {
        if (this._handle)
            delete Main.panel.statusArea[HANDLE];
        this._handle = false;
        try {
            Main.extensionManager.lookup(MUSIC_PILL)?.stateObj?._controller?._inject?.();
        } catch (e) {
            console.warn(`Atelier: Dynamic Music Pill could not move back: ${e.message}`);
        }
        // What is still ours to give back, never to destroy.
        for (const child of this._box.get_children()) {
            if (!(child instanceof DockItem) && child !== this._separator)
                this._box.remove_child(child);
        }
    }

    destroy() {
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        for (const id of [this._laterId, this._placeId]) {
            if (id)
                global.compositor.get_laters().remove(id);
        }
        this._laterId = this._placeId = 0;
        this._detachMusicPill();
        AppFavorites.getAppFavorites().disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._settings.disconnectObject(this);
        global.get_window_actors().forEach(actor => actor.disconnectObject(this));
        this._glass?.destroy();
        this._glass = null;
        this._edge.destroy();
        this.actor.destroy();
        this.actor = null;
    }
}
