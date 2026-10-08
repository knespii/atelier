// A dock: the pinned apps, the apps with windows that count for it and the
// places (the trash, drives), in a row at an edge of a monitor – or a
// column, at the left or the right – with room at its end for Dynamic
// Music Pill. It is no longer than a part of the edge (all of it in panel
// mode): its icons get smaller when they don't all fit, or it scrolls when
// they keep their size. It moves out of the way of windows and comes back
// when the pointer reaches its edge (hider.js, intellihide.js).
//
// It lays its apps out and places itself; what it does besides is in the
// collaborators it has: its hider and intellihide, its theming, the items
// of the shared services (locations, the Show Applications button).

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    dockRect, dropIndex, fitIconSize, isHorizontal, maxLength, strutRect,
} from '../../lib/dockGeometry.js';
import {GlassSurface} from '../core/glass.js';
import {scrollDock} from './actions.js';
import {DockHider} from './hider.js';
import {DockItem} from './icon.js';
import {Intellihide} from './intellihide.js';
import {createShowAppsItem} from './showApps.js';
import {DockTheming} from './theming.js';
import {Timers} from './timers.js';
import {appWindows, windowOptions} from './windows.js';

const MARGIN = 8; // between the dock and its edge, logical pixels
// How much of a monitor's width the glass of a dock at its side may take,
// logical pixels.
const SIDE_GLASS = 160;

// Settings the dock lays its apps out again for.
const REDISPLAY_KEYS = ['show-favorites', 'show-running', 'isolate-workspaces', 'isolate-monitors',
    'workspace-agnostic-urgent-windows', 'show-show-apps-button', 'show-apps-at-top',
    'show-apps-always-in-the-edge'];

export class Dock extends EventEmitter {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings - the dock's
     * @param {boolean} params.glass - of glass rather than dark
     * @param {number} params.monitorIndex - the monitor it is on
     * @param {boolean} params.main - the main dock (with the pill and the
     *   shortcuts), not one on another monitor
     * @param {object} params.services - what all docks share: {windows,
     *   badges, locations, spread, hotkeys, musicPill}
     */
    constructor({settings, glass, monitorIndex, main, services}) {
        super();
        this._settings = settings;
        this._services = services;
        this._monitorIndex = monitorIndex;
        this._main = main;
        this._side = settings.get_string('dock-position');
        this._extend = settings.get_boolean('extend-height');
        this._fixedSize = settings.get_boolean('icon-size-fixed');
        this._iconSize = settings.get_int('icon-size');
        this._items = new Map(); // app id → DockItem
        this._running = []; // ids of running apps not pinned, in the order they came
        this._rect = null;
        this._showApps = null;
        this._timers = new Timers();
        this._ctx = {dock: this, settings, services, side: this._side};
        const horizontal = isHorizontal(this._side);
        const orientation = horizontal ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL;

        // #atelier-dock > the dock's shape (.atelier-dock) > [a slot at the
        // start, the apps (scrolling, if they keep their size), a slot at the
        // end]. The slots hold the Show Applications button at the edge in
        // panel mode.
        this.actor = new St.Widget({name: 'atelier-dock', reactive: false});
        this._box = new St.BoxLayout({style_class: 'atelier-dock-box', orientation});
        if (this._fixedSize) {
            this._scroll = new St.ScrollView({
                style_class: 'atelier-dock-scroll',
                hscrollbar_policy: horizontal ? St.PolicyType.EXTERNAL : St.PolicyType.NEVER,
                vscrollbar_policy: horizontal ? St.PolicyType.NEVER : St.PolicyType.EXTERNAL,
                child: this._box,
            });
            // (A wheel turns along a row too.)
            this._scroll.connect('scroll-event', (_, event) => this._onScrollViewScroll(event));
        }
        this._middle = new St.Bin({child: this._scroll ?? this._box, x_expand: true, y_expand: true});
        this._startSlot = new St.Bin({style_class: 'atelier-dock-slot', visible: false});
        this._endSlot = new St.Bin({style_class: 'atelier-dock-slot', visible: false});
        this._content = new St.BoxLayout({style_class: 'atelier-dock-content', orientation});
        for (const actor of [this._startSlot, this._middle, this._endSlot])
            this._content.add_child(actor);
        this._container = new St.Bin({
            style_class: `atelier-dock atelier-dock-${this._side.toLowerCase()}`,
            child: this._content,
            track_hover: true,
            reactive: true,
        });
        if (this._extend)
            this._container.add_style_class_name('atelier-dock-extended');
        // Apps dropped on it are pinned there.
        this._container._delegate = this;
        this._container.connect('scroll-event', (_, event) => scrollDock(this, event));
        this.actor.add_child(this._container);
        Main.layoutManager.addChrome(this.actor, {affectsStruts: false, trackFullscreen: this.tracksFullscreen});
        // At the top it goes away behind the top bar.
        const panel = Main.layoutManager.panelBox;
        if (this._side === 'TOP' && panel.get_parent() === Main.layoutManager.uiGroup)
            Main.layoutManager.uiGroup.set_child_below_sibling(this.actor, panel);

        // Always visible, it keeps maximized windows off it.
        if (settings.get_boolean('dock-fixed')) {
            this._strut = new St.Widget({name: 'atelier-dock-strut', reactive: false});
            Main.layoutManager.addChrome(this._strut, {affectsStruts: true, affectsInputRegion: false});
        }

        if (glass) {
            const monitor = this.monitor;
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            const reach = horizontal || !monitor ? 0.25 : Math.min(1, SIDE_GLASS * scale / monitor.width);
            this._glass = new GlassSurface({monitorIndex, side: this._side, reach});
            this._glass.add_style_class_name('atelier-dock-glass');
            Main.layoutManager.uiGroup.insert_child_below(this._glass, this.actor);
            this._container.add_style_class_name('atelier-dock-glassy');
            for (const signal of ['notify::translation-x', 'notify::translation-y', 'notify::allocation'])
                this._container.connect(signal, () => this.syncGlass());
            // (Away with the dock, as when a window is full screen.)
            this.actor.connect('notify::visible', () => this.syncGlass());
        }

        const align = horizontal ? 'y_align' : 'x_align';
        this._separator = new St.Widget({style_class: 'atelier-dock-separator', [align]: Clutter.ActorAlign.CENTER});
        this._separator2 = new St.Widget({style_class: 'atelier-dock-separator', [align]: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._separator);
        this._box.add_child(this._separator2);
        this._syncAlignment();

        this.intellihide = new Intellihide(this, settings, services.windows);
        this.hider = new DockHider(this, settings);
        this.theming = new DockTheming(this, settings, {glass});

        AppFavorites.getAppFavorites().connectObject('changed', () => this._queueRedisplay(), this);
        Shell.AppSystem.get_default().connectObject('app-state-changed', () => this._queueRedisplay(), this);
        services.windows.connectObject(
            'stacking-changed', () => this._queueRedisplay(),
            'changed', () => this._scrollToFocused(),
            this);
        services.locations.connectObject('changed', () => this._queueRedisplay(), this);
        global.display.connectObject('workareas-changed', () => this._queuePlace(), this);
        settings.connectObject(
            ...REDISPLAY_KEYS.flatMap(key => [`changed::${key}`, () => this._queueRedisplay()]),
            'changed::height-fraction', () => this._queuePlace(),
            'changed::always-center-icons', () => this._syncAlignment(),
            this);
        // (Placed again after the row is laid out, not while it is.)
        this._box.connect('notify::width', () => this._queuePlace());
        this._box.connect('notify::height', () => this._queuePlace());

        this._redisplay();
        this._place();
        this.intellihide.check();
        if (main && horizontal)
            services.musicPill.attach(this._box);
    }

    /** @returns {St.BoxLayout} the row (or column) of apps */
    get box() {
        return this._box;
    }

    /** @returns {St.Bin} the dock's shape, which moves away and back */
    get container() {
        return this._container;
    }

    /** @returns {Map<string, DockItem>} the apps in it, by id */
    get items() {
        return this._items;
    }

    /** @returns {DockItem[]} its apps in the order they read (for Super+number) */
    get orderedItems() {
        return this._box.get_children().filter(child => this._isItem(child));
    }

    /** @returns {string} the edge it is at: 'TOP', 'RIGHT', 'BOTTOM' or 'LEFT' */
    get side() {
        return this._side;
    }

    /** @returns {number} the index of its monitor */
    get monitorIndex() {
        return this._monitorIndex;
    }

    /** @returns {object|null} its monitor */
    get monitor() {
        return Main.layoutManager.monitors[this._monitorIndex] ?? null;
    }

    /** @returns {boolean} whether it is the main dock */
    get isMain() {
        return this._main;
    }

    /** @returns {Timers} its delayed work */
    get timers() {
        return this._timers;
    }

    /** @returns {Gio.Settings} the dock's settings */
    get settings() {
        return this._settings;
    }

    /** @returns {object} the services all docks share */
    get services() {
        return this._services;
    }

    /** @returns {number} the size its icons have now, logical pixels */
    get iconSize() {
        return this._iconSize;
    }

    /** @returns {object|null} {x, y, width, height}: where it is when shown */
    get staticRect() {
        return this._rect;
    }

    /** @returns {number} between it and its edge, pixels */
    get margin() {
        return this._extend ? 0 : MARGIN * St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    /** @returns {boolean} whether it goes while a window is full screen */
    get tracksFullscreen() {
        return !this._settings.get_boolean('autohide-in-fullscreen');
    }

    /** @returns {boolean} whether it is out of the way */
    get hidden() {
        return this.hider.hidden;
    }

    /**
     * Keep it shown (a menu of it is open, something is being dragged).
     *
     * @param {boolean} forced
     */
    force(forced) {
        this.hider.force(forced);
    }

    /** Bring it back, as the edge does. */
    reveal() {
        this.hider.reveal();
    }

    // The apps: pinned ones first, then those with windows that count, then
    // the places.
    _wanted() {
        const options = windowOptions(this._settings, this._monitorIndex, this._services.locations);
        const favorites = this._settings.get_boolean('show-favorites')
            ? AppFavorites.getAppFavorites().getFavorites() : [];
        const pinned = new Set(favorites.map(app => app.get_id()));
        const running = this._settings.get_boolean('show-running')
            ? Shell.AppSystem.get_default().get_running()
                .filter(app => !pinned.has(app.get_id()) && appWindows(app, options).length > 0)
            : [];
        // Stable: those that came earlier stay first.
        const ids = running.map(app => app.get_id());
        this._running = [...this._running.filter(id => ids.includes(id)), ...ids.filter(id => !this._running.includes(id))];
        const byId = new Map(running.map(app => [app.get_id(), app]));
        const locations = this._services.locations.apps().filter(app => !pinned.has(app.get_id()) && !byId.has(app.get_id()));
        return {favorites, running: this._running.map(id => byId.get(id)), locations};
    }

    _queueRedisplay() {
        this._timers.later('redisplay', () => this._redisplay());
    }

    _redisplay() {
        const {favorites, running, locations} = this._wanted();
        const apps = [...favorites, ...running, ...locations];
        const ids = new Set(apps.map(app => app.get_id()));
        for (const [id, item] of this._items) {
            if (!ids.has(id)) {
                this._items.delete(id);
                item.animateOutAndDestroy();
            }
        }
        const showApps = this._syncShowApps();
        // Ours first, in order, then whatever else is in the row (the pill).
        let index = 0;
        const place = actor => this._box.set_child_at_index(actor, index++);
        if (showApps === 'start')
            place(this._showApps);
        for (const app of favorites)
            place(this._itemFor(app));
        place(this._separator);
        for (const app of running)
            place(this._itemFor(app));
        place(this._separator2);
        for (const app of locations)
            place(this._itemFor(app));
        if (showApps === 'end')
            place(this._showApps);
        this._separator.visible = favorites.length > 0 && (running.length > 0 || locations.length > 0);
        this._separator2.visible = running.length > 0 && locations.length > 0;
        this.emit('redisplayed');
    }

    // The Show Applications button, where the settings put it: 'start' or
    // 'end' of the row, at the edge of the dock (in a slot), or none.
    _syncShowApps() {
        const wanted = this._settings.get_boolean('show-show-apps-button');
        if (wanted && !this._showApps) {
            this._showApps = createShowAppsItem(this);
        } else if (!wanted && this._showApps) {
            this._showApps.destroy();
            this._showApps = null;
        }
        const button = this._showApps;
        if (!button) {
            this._startSlot.visible = this._endSlot.visible = false;
            return null;
        }
        const atStart = this._settings.get_boolean('show-apps-at-top');
        const atEdge = this._extend && this._settings.get_boolean('show-apps-always-in-the-edge');
        const slot = atEdge ? (atStart ? this._startSlot : this._endSlot) : null;
        if (button.get_parent() && button.get_parent() !== this._box && button.get_parent() !== slot)
            button.get_parent().remove_child(button);
        if (slot) {
            if (button.get_parent() !== slot)
                slot.set_child(button);
        } else if (button.get_parent() !== this._box) {
            this._box.add_child(button);
        }
        this._startSlot.visible = slot === this._startSlot;
        this._endSlot.visible = slot === this._endSlot;
        if (slot)
            return 'edge';
        return atStart ? 'start' : 'end';
    }

    _itemFor(app) {
        let item = this._items.get(app.get_id());
        if (!item) {
            item = this._services.locations.createItem(app, this._iconSize, this._ctx) ??
                new DockItem(app, this._iconSize, this._ctx);
            item.connect('menu-state-changed', (_, opened) => this.force(opened));
            this._items.set(app.get_id(), item);
            this._box.add_child(item);
            item.show(true);
        }
        item.setIconSize(this._iconSize);
        item.icon._updateRunningStyle();
        return item;
    }

    // In panel mode the apps are at the start of the edge, or in its middle.
    _syncAlignment() {
        const align = this._extend && !this._settings.get_boolean('always-center-icons')
            ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
        const apps = this._scroll ?? this._box;
        if (isHorizontal(this._side))
            apps.x_align = this._extend ? align : Clutter.ActorAlign.FILL;
        else
            apps.y_align = this._extend ? align : Clutter.ActorAlign.FILL;
    }

    _queuePlace() {
        this._timers.later('place', () => this._place());
    }

    // The rectangle of its monitor it is in: all of it, less the top bar
    // for a dock at the top. (Never the work area: with the dock always
    // visible, that has the dock's own room taken out.)
    _area(monitor) {
        const area = {x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height};
        const panel = Main.layoutManager.panelBox;
        if (this._side === 'TOP' && this._monitorIndex === Main.layoutManager.primaryIndex && panel.visible) {
            area.y += panel.height;
            area.height -= panel.height;
        }
        return area;
    }

    // Placed on its edge, as long as its apps (no longer than it may be).
    _place() {
        const monitor = this.monitor;
        if (!monitor)
            return;
        const horizontal = isHorizontal(this._side);
        const area = this._area(monitor);
        const max = maxLength(area, this._side, this._settings.get_double('height-fraction'), this._extend);
        if (this._fitIcons(max)) {
            // (Placed once the icons have their new size.)
            this._queuePlace();
            return;
        }
        // As long as it would be, then no longer than it may.
        this._container.set_size(-1, -1);
        let length, thickness;
        if (horizontal) {
            [, length] = this._container.get_preferred_width(-1);
            [, thickness] = this._container.get_preferred_height(length);
        } else {
            [, length] = this._container.get_preferred_height(-1);
            [, thickness] = this._container.get_preferred_width(length);
        }
        const tooLong = length > max;
        const rect = dockRect({
            area, side: this._side, length: Math.min(length, max), thickness,
            margin: this.margin, extend: this._extend,
        });
        this._rect = rect;
        this.actor.set_position(rect.x, rect.y);
        this.actor.set_size(rect.width, rect.height);
        if (this._extend || tooLong)
            this._container.set_size(rect.width, rect.height);
        if (this._strut) {
            const strut = strutRect(this._side, monitor, rect, 0);
            this._strut.set_position(strut.x, strut.y);
            this._strut.set_size(strut.width, strut.height);
        }
        this.syncGlass();
        this.theming.sync();
        this.emit('placed', rect);
    }

    // The icon size at which its apps fit along the length it may have.
    // Says whether the size changed.
    _fitIcons(available) {
        const items = this._box.get_children().filter(child => this._isItem(child) && child.visible);
        const maxSize = this._settings.get_int('icon-size');
        let size = maxSize;
        if (items.length > 0 && !this._fixedSize) {
            const horizontal = isHorizontal(this._side);
            const lengthOf = actor => (horizontal
                ? actor.get_preferred_width(-1) : actor.get_preferred_height(-1))[1];
            // (The icon in it: the items grow as they come in.)
            const itemNode = items[0].get_theme_node();
            const itemPadding = lengthOf(items[0].icon) - this._iconSize +
                (horizontal ? itemNode.get_horizontal_padding() : itemNode.get_vertical_padding());
            const others = this._box.get_children().filter(child => child.visible && !(child instanceof DockItem));
            const shown = this._box.get_children().filter(child => child.visible).length;
            const spacing = this._box.get_theme_node().get_length('spacing');
            const node = this._container.get_theme_node();
            const padding = horizontal
                ? node.get_horizontal_padding() + node.get_border_width(St.Side.LEFT) + node.get_border_width(St.Side.RIGHT)
                : node.get_vertical_padding() + node.get_border_width(St.Side.TOP) + node.get_border_width(St.Side.BOTTOM);
            const slots = [this._startSlot, this._endSlot].filter(slot => slot.visible);
            const extras = padding + Math.max(0, shown - 1) * spacing +
                [...others, ...slots].reduce((sum, actor) => sum + lengthOf(actor), 0);
            size = fitIconSize({count: items.length, extras, maxSize, available, itemPadding});
        }
        if (size === this._iconSize)
            return false;
        this._iconSize = size;
        items.forEach(item => item.setIconSize(size));
        return true;
    }

    syncGlass() {
        if (!this._glass)
            return;
        const [x, y] = this._container.get_transformed_position();
        const [width, height] = this._container.get_transformed_size();
        const radius = this._container.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
        const away = isHorizontal(this._side)
            ? Math.abs(this._container.translation_y) >= height
            : Math.abs(this._container.translation_x) >= width;
        this._glass.visible = this.actor.visible && !away;
        this._glass.setShape(x, y, width, height, radius);
    }

    // A wheel scrolls a row of icons that keep their size along it.
    _onScrollViewScroll(event) {
        if (!isHorizontal(this._side) || event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH &&
            Math.abs(event.get_scroll_delta()[0]) > Math.abs(event.get_scroll_delta()[1]))
            return Clutter.EVENT_PROPAGATE;
        const adjustment = this._scroll.hadjustment;
        let delta;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            delta = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
            delta = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH:
            delta = event.get_scroll_delta()[1];
            break;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        adjustment.value += delta * adjustment.step_increment;
        return Clutter.EVENT_STOP;
    }

    // Scrolling, the focused app is brought into view.
    _scrollToFocused() {
        if (!this._scroll || !this._settings.get_boolean('scroll-to-focused-application'))
            return;
        const app = Shell.WindowTracker.get_default().focus_app;
        const item = app && this._items.get(app.get_id());
        if (!item?.get_parent())
            return;
        const horizontal = isHorizontal(this._side);
        const adjustment = horizontal ? this._scroll.hadjustment : this._scroll.vadjustment;
        const box = item.get_allocation_box();
        const [start, end] = horizontal ? [box.x1, box.x2] : [box.y1, box.y2];
        if (start < adjustment.value)
            adjustment.ease(start, {duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else if (end > adjustment.value + adjustment.page_size)
            adjustment.ease(end - adjustment.page_size, {duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Drag and drop: an app dropped on the dock is pinned where it lands.
    handleDragOver(source) {
        return source?.app ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.NO_DROP;
    }

    acceptDrop(source, _actor, x, y) {
        const app = source?.app;
        if (!app)
            return false;
        const favorites = AppFavorites.getAppFavorites();
        const pinned = favorites.getFavorites();
        // Along the dock: x in a row, y in a column, on the stage.
        const horizontal = isHorizontal(this._side);
        const [containerX, containerY] = this._container.get_transformed_position();
        const centres = pinned.map(other => {
            const item = this._items.get(other.get_id());
            if (!item)
                return null;
            const [itemX, itemY] = item.get_transformed_position();
            return horizontal ? itemX + item.width / 2 : itemY + item.height / 2;
        });
        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const position = dropIndex(this._side, rtl, centres, horizontal ? x + containerX : (y ?? 0) + containerY);
        const id = app.get_id();
        this._timers.idle(`drop-${id}`, () => {
            if (favorites.isFavorite(id))
                favorites.moveFavoriteToPos(id, position > pinned.findIndex(a => a.get_id() === id) ? position - 1 : position);
            else
                favorites.addFavoriteAtPos(id, position);
        });
        return true;
    }

    // One of its apps (not one going away).
    _isItem(child) {
        return child instanceof DockItem && this._items.get(child.app.get_id()) === child;
    }

    // The dock's own children of its row (the rest are the pill's).
    _isOwn(child) {
        return child instanceof DockItem || child === this._separator || child === this._separator2 ||
            child === this._showApps;
    }

    destroy() {
        // Its icons' menus close as they go, and say so: nothing is started
        // anew from here on.
        this._timers.destroy();
        if (this._main)
            this._services.musicPill.detach(this._box, child => this._isOwn(child));
        this.hider.destroy();
        this.intellihide.destroy();
        this.theming.destroy();
        AppFavorites.getAppFavorites().disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        this._services.windows.disconnectObject(this);
        this._services.locations.disconnectObject(this);
        global.display.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._glass?.destroy();
        this._glass = null;
        this._strut?.destroy();
        this._strut = null;
        this.actor.destroy();
        this.actor = null;
        this.disconnectAll();
    }
}
