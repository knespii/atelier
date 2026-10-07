// The desktop: widgets on the wallpaper, under the windows, in the Modern
// look (dark glass) or the Analogue one (paper). Where they are is kept in
// the settings; the desktop's right-click menu edits them.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as BackgroundMenu from 'resource:///org/gnome/shell/ui/backgroundMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

import {keepWidgets} from '../../lib/profiles.js';
import {
    KINDS, cellOrigin, findSpot, fitLayout, fits, gridSize, nearestSize, nearestSpot, newId, nextSize, parseLayout,
    placeAt, serializeLayout,
} from '../../lib/widgets.js';
import {DesktopEditor} from './editor.js';
import {DesktopGlass} from './glass.js';
import {CalendarWidget} from './kinds/calendar.js';
import {ClaudeWidget} from './kinds/claude.js';
import {GithubWidget} from './kinds/github.js';
import {PhotoWidget} from './kinds/photo.js';
import {SlackWidget} from './kinds/slack.js';
import {ClockWidget, DateWidget} from './kinds/time.js';
import {WeatherWidget} from './kinds/weather.js';
import {GithubSource} from './sources/github.js';
import {SlackSource} from './sources/slack.js';
import {TasksSource} from './sources/tasks.js';

const WIDGETS = {
    clock: ClockWidget,
    date: DateWidget,
    calendar: CalendarWidget,
    weather: WeatherWidget,
    github: GithubWidget,
    claude: ClaudeWidget,
    photo: PhotoWidget,
    slack: SlackWidget,
};

// Corners of the cards, logical pixels (as in the stylesheet).
const RADIUS = 22;
// Another layout from the settings (another profile's, say): widgets flow
// to their new places, new ones drip in, those gone shrink away – one a
// little after the other.
const FLOW_TIME = 520;
const FLOW_STAGGER = 45;

export class DesktopModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     * @param {ModuleManager} context.modules
     * @param {object} context.extension
     */
    constructor({settings, modules, extension, store}) {
        this._settings = settings;
        this._modules = modules;
        this._extension = extension;
        this._store = store;
        this._injections = new InjectionManager();
        this._widgets = new Map();
        this._menus = new Map();
        this._layout = [];
        this._editor = null;
        this._saving = false;
        this._laterId = 0;
        /** extra kinds of widgets, by name: other modules (notes) add theirs */
        this.kinds = new Map(Object.entries(WIDGETS));
    }

    /** @returns {St.Widget} the widgets' layer */
    get layer() {
        return this._layer;
    }

    /** @returns {Map<string, DesktopWidget>} the widgets, by id */
    get widgets() {
        return this._widgets;
    }

    /** @returns {object[]} where they are */
    get layout() {
        return this._layout;
    }

    /** @returns {object} the work area they are in, on the stage: {x, y, width, height} */
    get area() {
        return this._area;
    }

    /** @returns {number[]} [columns, rows] of the grid */
    get grid() {
        return this._grid;
    }

    /** @returns {boolean} whether the widgets are being edited */
    get editing() {
        return this._editor !== null;
    }

    /** @returns {Gio.Icon} Claude's icon, for the gallery */
    get claudeIcon() {
        return Gio.icon_new_for_string(GLib.build_filenamev([this._extension.path, 'icons', 'sparkle-symbolic.svg']));
    }

    enable() {
        this._desktopSettings = this._settings.get_child('desktop');
        this.sources = {github: new GithubSource(this._desktopSettings), tasks: new TasksSource(), slack: new SlackSource()};
        this._context = {
            settings: this._desktopSettings,
            sources: this.sources,
            style: () => this._desktopSettings.get_string('style'),
            claude: () => this._modules.get('claude'),
            openSettings: () => this._extension.openPreferences(),
        };

        // Above the wallpaper, under the windows: inside the wallpapers'
        // group (a new wallpaper goes in at its bottom).
        this._layer = new St.Widget({name: 'atelier-desktop', style_class: 'atelier-desktop'});
        this.restoreLayer();
        this._glass = null;

        this._desktopSettings.connectObject(
            'changed::widgets', () => !this._saving && this._load(true),
            'changed::style', () => this._syncLook(true),
            'changed::glass', () => this._syncLook(false),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._queueArea(), this);
        global.display.connectObject('workareas-changed', () => this._queueArea(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._queueArea(), this);
        this._modules.connectObject(
            'started', (_, id) => id === 'claude' && this._refresh('claude'),
            'stopped', (_, id) => id === 'claude' && this._refresh('claude'),
            this);

        // The desktop's menu edits them.
        const desktop = this;
        this._injections.overrideMethod(BackgroundMenu.BackgroundMenu.prototype, 'open',
            original => function (...args) {
                desktop._extendMenu(this);
                return original.call(this, ...args);
            });
        // Switching workspaces, GNOME slides copies of their wallpapers (and
        // desktop windows) over the desktop: the widgets go on them too, or
        // they would be gone until the switch is over.
        if (WorkspaceAnimation.WorkspaceGroup?.prototype._createDesktopWindows) {
            this._injections.overrideMethod(WorkspaceAnimation.WorkspaceGroup.prototype, '_createDesktopWindows',
                original => function (...args) {
                    original.call(this, ...args);
                    desktop._joinWorkspaceSwitch(this);
                });
        }

        this._syncArea();
        this._syncLook(false);
        this._load();
    }

    disable() {
        this.stopEditing();
        this._injections.clear();
        this._resetMenus();
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._modules.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this._desktopSettings?.disconnectObject(this);
        this._widgets.forEach(widget => this._dropWidget(widget));
        this._widgets.clear();
        const leaving = [...this._leaving ?? []];
        this._leaving = null;
        leaving.forEach(widget => this._dropWidget(widget));
        this._layer?.destroy();
        this._layer = null;
        this._glass = null;
        for (const source of Object.values(this.sources ?? {}))
            source.destroy();
        this.sources = null;
    }

    /** Put the layer where it lives: on the wallpaper, under the windows. */
    restoreLayer() {
        const group = Main.layoutManager._backgroundGroup;
        if (this._layer.get_parent() !== group)
            group.add_child(this._layer);
        if (this._area)
            this._layer.set_position(this._area.x, this._area.y);
    }

    // A copy of the widgets, where they are, on a wallpaper that slides
    // while workspaces switch. (Only the main monitor has them.)
    _joinWorkspaceSwitch(group) {
        const monitor = group._monitor;
        if (!this._layer || this._editor || !this._area || !group._background ||
            monitor?.index !== Main.layoutManager.primaryIndex)
            return;
        const copy = new Clutter.Clone({source: this._layer});
        copy.set_position(this._area.x - monitor.x, this._area.y - monitor.y);
        group._background.add_child(copy);
    }

    /** Edit the widgets: they come up over the windows. */
    edit() {
        if (this._editor || !this._layer)
            return;
        this._closeMenus();
        this._editor = new DesktopEditor(this);
    }

    stopEditing() {
        if (!this._editor)
            return;
        const editor = this._editor;
        this._editor = null;
        editor.destroy();
    }

    // The menu of the desktop (one per wallpaper actor) gets Atelier's items.
    _extendMenu(menu) {
        if (this._menus.has(menu))
            return;
        const items = [new PopupMenu.PopupSeparatorMenuItem()];
        const add = (text, action) => {
            const item = new PopupMenu.PopupMenuItem(text);
            item.connect('activate', action);
            items.push(item);
        };
        add('Edit Widgets', () => this.edit());
        for (const [text, action] of this._menuExtras ?? [])
            add(text, action);
        if (this._modules.get('profiles'))
            add('Wallpapers', () => this._modules.get('profiles')?.toggleSwitcher('wallpapers'));
        add('Atelier Settings', () => this._extension.openPreferences());
        items.forEach(item => menu.addMenuItem(item));
        this._menus.set(menu, items);
        // (Gone with its wallpaper, when that changes. The menu is no actor:
        // its connection would otherwise be kept, and the menu with it.)
        menu.connectObject('destroy', () => {
            menu.disconnectObject(this);
            this._menus.delete(menu);
        }, this);
    }

    /**
     * Another item for the desktop's menu, e.g. "New Note".
     *
     * @param {string} text
     * @param {Function} action
     */
    addMenuItem(text, action) {
        this._menuExtras = [...(this._menuExtras ?? []).filter(([t]) => t !== text), [text, action]];
        this._resetMenus();
    }

    /** @param {string} text - of an item added with addMenuItem() */
    removeMenuItem(text) {
        this._menuExtras = (this._menuExtras ?? []).filter(([t]) => t !== text);
        this._resetMenus();
    }

    // Menus extended so far lose Atelier's items; they get them anew when
    // they open next.
    _resetMenus() {
        for (const [menu, items] of this._menus) {
            menu.disconnectObject(this);
            items.forEach(item => item.destroy());
        }
        this._menus.clear();
    }

    _closeMenus() {
        for (const menu of this._menus.keys())
            menu.close(BoxPointer.PopupAnimation.NONE);
    }

    _queueArea() {
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._syncArea();
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncArea() {
        const index = Main.layoutManager.primaryIndex;
        const area = index >= 0 ? Main.layoutManager.getWorkAreaForMonitor(index) : null;
        if (!area)
            return;
        this._area = {x: area.x, y: area.y, width: area.width, height: area.height};
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._grid = gridSize(area.width / scale, area.height / scale);
        if (!this._editor)
            this._layer.set_position(area.x, area.y);
        this._layer.set_size(area.width, area.height);
        this._glass?.setArea(this._area);
    }

    /**
     * @param {boolean} rebuild - the widgets draw themselves anew (the look changed)
     */
    _syncLook(rebuild) {
        const style = this._desktopSettings.get_string('style');
        const glass = style === 'modern' && this._desktopSettings.get_boolean('glass');
        for (const name of ['modern', 'analogue'])
            this._layer.remove_style_class_name(`atelier-desktop-${name}`);
        this._layer.add_style_class_name(`atelier-desktop-${style}`);
        if (glass)
            this._layer.add_style_class_name('atelier-desktop-glassy');
        else
            this._layer.remove_style_class_name('atelier-desktop-glassy');
        if (glass && !this._glass) {
            this._glass = new DesktopGlass();
            this._layer.insert_child_at_index(this._glass, 0);
            this._glass.setArea(this._area);
        } else if (!glass && this._glass) {
            this._glass.destroy();
            this._glass = null;
        }
        if (rebuild)
            this._widgets.forEach(widget => widget.resize(widget.entry.size));
        this.syncGlass();
    }

    /** Make the widgets anew, e.g. when another kind became known. */
    reload() {
        this._widgets.forEach(widget => this._dropWidget(widget));
        this._widgets.clear();
        this._load();
    }

    // The widgets as the settings have them.
    /** @param {boolean} [flow] - animated, for another layout (not while editing) */
    _load(flow = false) {
        this._flow = flow && !this._editor && St.Settings.get().enable_animations;
        this._layout = parseLayout(this._desktopSettings.get_string('widgets'));
        const ids = new Set(this._layout.map(entry => entry.id));
        for (const [id, widget] of this._widgets) {
            const entry = this._layout.find(e => e.id === id);
            if (!ids.has(id) || entry.kind !== widget.entry.kind) {
                this._widgets.delete(id);
                if (this._flow)
                    this._shrinkAway(widget);
                else
                    this._dropWidget(widget);
            }
        }
        for (const entry of this._layout) {
            const widget = this._widgets.get(entry.id);
            if (!widget) {
                const created = this._createWidget(entry);
                if (created)
                    created.fresh = this._flow;
            }
            else if (widget.entry.size !== entry.size)
                widget.resize(entry.size);
            else
                widget.entry = {...widget.entry, ...entry};
        }
        this._place();
        this._flow = false;
    }

    _shrinkAway(widget) {
        this._leaving ??= new Set();
        this._leaving.add(widget);
        widget.reactive = false;
        widget.set_pivot_point(0.5, 0.5);
        widget.ease({
            scale_x: 0.6,
            scale_y: 0.6,
            opacity: 0,
            duration: FLOW_TIME * 0.6,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                // (Gone with the layer already, as Atelier went.)
                if (!this._leaving?.delete(widget))
                    return;
                this._dropWidget(widget);
                this.syncGlass();
            },
        });
    }

    _createWidget(entry) {
        const Kind = this.kinds.get(entry.kind);
        if (!Kind)
            return null;
        const widget = new Kind(entry, this._context);
        widget.connectObject(
            'menu-request', () => this._showWidgetMenu(widget),
            // (The glass under it follows it as it moves or is stretched.)
            'notify::allocation', () => this.syncGlass(),
            'notify::scale-x', () => this.syncGlass(),
            'notify::opacity', () => this.syncGlass(),
            this);
        this._layer.add_child(widget);
        this._widgets.set(entry.id, widget);
        this._editor?.adopt(widget);
        return widget;
    }

    _dropWidget(widget) {
        widget._menu?.destroy();
        widget._menu = null;
        widget.disconnectObject(this);
        widget.destroy();
    }

    // Everything on the grid, as far as the screen allows: on another
    // monitor, near the same edges (only shown: the layout stays as it was
    // placed until it is edited).
    _place() {
        if (!this._grid)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const shown = fitLayout(this._layout, this._grid);
        let order = 0;
        for (const entry of shown) {
            const widget = this._widgets.get(entry.id);
            if (!widget)
                continue;
            widget.entry = {...widget.entry, x: entry.x, y: entry.y};
            const [x, y] = cellOrigin(entry.x, entry.y).map(v => v * scale);
            const delay = order * FLOW_STAGGER;
            if (this._flow && widget.fresh) {
                // Dripping in: from a smaller drop, a little too big and back.
                widget.fresh = false;
                widget.set_position(x, y);
                widget.set_pivot_point(0.5, 0.5);
                widget.set({scale_x: 0.55, scale_y: 0.55, opacity: 0});
                widget.ease({scale_x: 1, scale_y: 1, opacity: 255, delay, duration: FLOW_TIME,
                    mode: Clutter.AnimationMode.EASE_OUT_BACK, onStopped: () => this.syncGlass()});
                order++;
            } else if (this._flow && (widget.x !== x || widget.y !== y)) {
                // Flowing to its new place.
                widget.ease({x, y, delay, duration: FLOW_TIME, mode: Clutter.AnimationMode.EASE_OUT_BACK});
                order++;
            } else {
                widget.set_position(x, y);
            }
        }
        this.syncGlass();
    }

    /** The glass under the widgets follows them. */
    syncGlass() {
        if (!this._glass)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // (As big as they are drawn, growing in or shrinking away.)
        const rects = [...this._widgets.values(), ...this._leaving ?? []]
            .filter(widget => widget.visible && widget.opacity > 0)
            .map(widget => {
                const [w, h] = [widget.width * widget.scale_x, widget.height * widget.scale_y];
                return [widget.x + (widget.width - w) / 2, widget.y + (widget.height - h) / 2, w, h];
            });
        this._glass.setRects(rects, RADIUS * scale);
    }

    _refresh(kind) {
        for (const widget of this._widgets.values()) {
            if (widget.entry.kind === kind)
                widget.resize(widget.entry.size);
        }
    }

    // Kept in the settings, and in the profile in use: each profile has
    // its widgets.
    _save() {
        this._saving = true;
        this._desktopSettings.set_string('widgets', serializeLayout(this._layout));
        this._saving = false;
        if (this._store)
            keepWidgets(this._store, this._desktopSettings);
    }

    // A widget placed (or given a size) on the screen there is now: kept
    // where it is for screens of this size. The others stay as they were
    // placed, on the screens they were.
    _keep({id, kind, size, x, y}) {
        const stored = this._layout.find(e => e.id === id);
        const kept = placeAt({...stored ?? {id, kind}, size}, x, y, this._grid);
        this._layout = stored ? this._layout.map(e => (e === stored ? kept : e)) : [...this._layout, kept];
        this._save();
    }

    // The layout as shown, for editing it.
    _shownLayout() {
        // (Entries of kinds not known now stay as they are.)
        const unknown = this._layout.filter(entry => !this._widgets.has(entry.id));
        return [...unknown, ...[...this._widgets.values()].map(widget => ({
            ...this._layout.find(e => e.id === widget.entry.id),
            x: widget.entry.x, y: widget.entry.y, size: widget.entry.size,
        }))];
    }

    /**
     * Add a widget where there is room.
     *
     * @param {string} kind
     * @returns {boolean} whether there was room
     */
    addWidget(kind) {
        const layout = this._shownLayout();
        const entry = {id: newId(layout, kind), kind, size: KINDS[kind].sizes[0]};
        const spot = findSpot(layout, entry, this._grid);
        if (!spot)
            return false;
        this._keep({...entry, ...spot});
        this._createWidget({...entry, ...spot});
        this._place();
        return true;
    }

    /** @param {string} id */
    removeWidget(id) {
        const widget = this._widgets.get(id);
        if (!widget)
            return;
        this._layout = this._layout.filter(entry => entry.id !== id);
        this._widgets.delete(id);
        this._dropWidget(widget);
        this._save();
        this.syncGlass();
    }

    /**
     * Give a widget its next size, if there is room for it (where it is, or
     * else somewhere).
     *
     * @param {string} id
     * @returns {boolean} whether it changed
     */
    resizeWidget(id) {
        const widget = this._widgets.get(id);
        if (!widget)
            return false;
        const layout = this._shownLayout();
        const entry = layout.find(e => e.id === id);
        const sizes = KINDS[entry.kind].sizes;
        for (let size = nextSize(entry.kind, entry.size), n = 1; n < sizes.length; size = nextSize(entry.kind, size), n++) {
            let resized = {...entry, size};
            if (!fits(layout, resized, this._grid)) {
                const spot = findSpot(layout, resized, this._grid);
                if (!spot)
                    continue;
                resized = {...resized, ...spot};
            }
            this._keep(resized);
            widget.resize(size);
            this._place();
            return true;
        }
        return false;
    }

    /**
     * Give a widget one of the sizes it comes in, where it is.
     *
     * @param {string} id
     * @param {string} size
     * @returns {boolean} whether it has that size now (it fits there)
     */
    setWidgetSize(id, size) {
        const widget = this._widgets.get(id);
        const layout = this._shownLayout();
        const entry = layout.find(e => e.id === id);
        if (!widget || !entry || !KINDS[entry.kind]?.sizes.includes(size) || !fits(layout, {...entry, size}, this._grid))
            return false;
        this._keep({...entry, size});
        // (While it is stretched, it may show that size already.)
        if (widget.entry.size !== size)
            widget.fill(size);
        widget.fit();
        this._place();
        return true;
    }

    /**
     * Where a widget being dragged would land.
     *
     * @param {string} id
     * @param {number} fx - its top left corner, in cells of the grid (not whole ones)
     * @param {number} fy
     * @returns {object} {x, y}: the free cells nearest to that
     */
    spotFor(id, fx, fy) {
        const layout = this._shownLayout();
        return nearestSpot(layout, layout.find(e => e.id === id), this._grid, fx, fy);
    }

    /**
     * The size a widget being stretched would take.
     *
     * @param {string} id
     * @param {number} fw - its width, in cells (not whole ones)
     * @param {number} fh - its height
     * @returns {string} of its sizes that fit where it is, the nearest to that
     */
    sizeFor(id, fw, fh) {
        const layout = this._shownLayout();
        return nearestSize(layout, layout.find(e => e.id === id), this._grid, fw, fh);
    }

    /**
     * Move a widget to a cell, if it fits there.
     *
     * @param {string} id
     * @param {number} x
     * @param {number} y
     * @returns {boolean} whether it moved
     */
    moveWidget(id, x, y) {
        const layout = this._shownLayout();
        const entry = layout.find(e => e.id === id);
        if (!entry || !fits(layout, {...entry, x, y}, this._grid))
            return false;
        this._keep({...entry, x, y});
        const widget = this._widgets.get(id);
        widget.entry = {...widget.entry, x, y};
        return true;
    }

    _showWidgetMenu(widget) {
        if (this._editor)
            return;
        if (!widget._menu) {
            const menu = new PopupMenu.PopupMenu(widget, 0.5, St.Side.TOP);
            menu.addAction('Edit Widgets', () => this.edit());
            if (KINDS[widget.entry.kind].sizes.length > 1)
                menu.addAction('Change Size', () => this.resizeWidget(widget.entry.id));
            menu.addAction('Remove', () => this.removeWidget(widget.entry.id));
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            const manager = new PopupMenu.PopupMenuManager(widget);
            manager.addMenu(menu);
            widget._menu = menu;
            widget._menuManager = manager;
        }
        widget._menu.open(BoxPointer.PopupAnimation.FULL);
    }
}
