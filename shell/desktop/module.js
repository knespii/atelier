// The desktop: widgets on the wallpaper, under the windows, in the Modern
// look (dark glass) or the Analogue one (paper). Where they are is kept in
// the settings; the desktop's right-click menu edits them.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as BackgroundMenu from 'resource:///org/gnome/shell/ui/backgroundMenu.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as WorkspaceAnimation from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';

import {clamp01, gather, pour, spread} from '../../lib/liquid.js';
import {keepWidgets} from '../../lib/profiles.js';
import {
    CLOCK_FACES, KINDS, cellOrigin, findSpot, fitLayout, fits, gridOrigin, gridSize, nearestSize, nearestSpot, newId, nextSize, parseLayout,
    placeAt, serializeLayout,
} from '../../lib/widgets.js';
import {LiquidPaint} from '../core/liquid.js';
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
// Another layout from the settings (another profile's, say): the cards
// turn liquid – each pours over to its new place, those gone draw into
// their middles, new ones spread out of theirs – one a little after the
// other. What they show fades out first, and back in once they are cards
// again.
const POUR_TIME = 950;
const GATHER_TIME = 560;
const SPREAD_TIME = 720;
const FLOW_STAGGER = 45;
// Back from the overview (which has the wallpapers without them), the
// widgets spread onto the desktop again, as fast as this.
const BACK_TIME = 560;
const CONTENT_TIME = 110;
// Logical pixels: how near the liquid melts.
const BLEND = 18;
// A profile switches its themes and palette with the widgets, and the
// shell stalls a while restyling itself: the widgets flow once it has drawn
// smoothly for a while (frames at most this far apart, this many in a row),
// or after all at most this late.
const CALM_GAP = 90;
const CALM_TICKS = 6;
const CALM_TICK = 50;
const CALM_LONGEST = 3000;
// A profile switches the desktop's look (palette, glass or paper) at once,
// while the shell stalls: the desktop as it looked stays over it, and fades
// over to the new look once the shell is calm.
const LOOK_TIME = 700;

// What a widget shows, of its entry in the layout (not where it is).
const PLACE_KEYS = ['x', 'y', 'grid', 'places', 'fine'];
const options = entry => JSON.stringify(Object.entries(entry).filter(([key]) => !PLACE_KEYS.includes(key)).sort());

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

    /** @returns {number[]} [px, py] of the grid's corner in the work area, logical pixels */
    get origin() {
        return this._origin;
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
            'changed::widgets', () => {
                if (this._saving)
                    return;
                this._loadPending = true;
                this._settleWhenCalm();
            },
            'changed::style', () => this._syncLook(true),
            'changed::glass', () => this._syncLook(false),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._queueArea(), this);
        Main.overview.connectObject(
            'shown', () => this._layer && (this._layer.opacity = 0),
            'hidden', () => this._spreadBack(),
            this);
        global.display.connectObject('workareas-changed', () => this._queueArea(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._queueArea(), this);
        this._modules.connectObject(
            'started', (_, id) => {
                if (id === 'claude')
                    this._refresh('claude');
                if (id === 'profiles')
                    this._watchApplier();
            },
            'stopped', (_, id) => id === 'claude' && this._refresh('claude'),
            this);
        // (Before a profile is written: the look it had.)
        this._freezeLook = () => this.freezeLook();
        this._watchApplier();

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
        this._cancelCalm();
        this._finishFlow();
        this._thaw(false);
        this._modules.get('profiles')?.applier?.beforeWrite.delete(this._freezeLook);
        this.stopEditing();
        this._injections.clear();
        this._resetMenus();
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._modules.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.display.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this._desktopSettings?.disconnectObject(this);
        this._widgets.forEach(widget => this._dropWidget(widget));
        this._widgets.clear();
        this._layer?.destroy();
        this._layer = null;
        this._glass = null;
        this._liquid = null;
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
        this._finishFlow();
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
        this._origin = gridOrigin(area.width / scale, area.height / scale);
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

    _watchApplier() {
        this._modules.get('profiles')?.applier?.beforeWrite.add(this._freezeLook);
    }

    /**
     * Keep the desktop as it looks now (the wallpaper and the widgets)
     * over it, until the shell is calm: then it fades over to how it looks
     * by then.
     */
    freezeLook() {
        if (!this._layer?.mapped || !this._area || this._editor || Main.overview.visible ||
            !St.Settings.get().enable_animations)
            return;
        this._thaw(false);
        // (Only them: what is over them is out of the way for the moment
        // it is painted – never on the screen.)
        const background = Main.layoutManager._backgroundGroup;
        const over = [
            ...global.window_group.get_children().filter(actor => actor !== background),
            ...Main.layoutManager.uiGroup.get_children().filter(actor => actor !== global.window_group),
        ].filter(actor => actor.visible && actor.opacity > 0);
        const opacities = over.map(actor => actor.opacity);
        over.forEach(actor => (actor.opacity = 0));
        const {x, y, width, height} = this._area;
        let content = null;
        try {
            content = global.stage.paint_to_content(new Mtk.Rectangle({x, y, width, height}),
                this._layer.get_resource_scale(), Clutter.PaintFlag.NO_CURSORS);
        } catch (e) {
            console.warn('Atelier: could not keep the desktop\'s look', e);
        } finally {
            over.forEach((actor, i) => (actor.opacity = opacities[i]));
        }
        if (!content)
            return;
        this._frozen = new Clutter.Actor({content, x, y, width, height, reactive: false});
        background.insert_child_above(this._frozen, this._layer);
        this._settleWhenCalm();
    }

    // The desktop as it looked fades over to how it looks now (or goes at once).
    _thaw(fade = true) {
        const frozen = this._frozen;
        this._frozen = null;
        if (!frozen)
            return;
        if (!fade) {
            frozen.destroy();
            return;
        }
        frozen.ease({opacity: 0, duration: LOOK_TIME, mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onStopped: () => frozen.destroy()});
    }

    // Once the shell is calm: the widgets as the settings have them now
    // (flowing there), and the desktop's new look fading in.
    _settleWhenCalm() {
        this._cancelCalm();
        const settle = flow => {
            if (this._loadPending) {
                this._loadPending = false;
                this._load(flow);
            }
            this._thaw();
        };
        if (this._editor || !St.Settings.get().enable_animations) {
            settle(false);
            return;
        }
        const start = GLib.get_monotonic_time();
        let last = start;
        let calm = 0;
        this._calmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CALM_TICK, () => {
            const now = GLib.get_monotonic_time();
            calm = now - last < CALM_GAP * 1000 ? calm + 1 : 0;
            last = now;
            const busy = this._modules.get('profiles')?._applier?.busy;
            if ((calm < CALM_TICKS || busy) && now - start < CALM_LONGEST * 1000)
                return GLib.SOURCE_CONTINUE;
            this._calmId = 0;
            settle(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelCalm() {
        if (this._calmId)
            GLib.source_remove(this._calmId);
        this._calmId = 0;
    }

    /** @param {boolean} [flow] - animated, for another layout (not while editing) */
    _load(flow = false) {
        // (One still flowing is there at once.)
        this._finishFlow();
        this._flow = flow && !this._editor && St.Settings.get().enable_animations;
        this._gone = [];
        this._layout = parseLayout(this._desktopSettings.get_string('widgets'));
        const ids = new Set(this._layout.map(entry => entry.id));
        for (const [id, widget] of this._widgets) {
            // (Where it is, as it is: where it pours from.)
            widget.was = this._flow ? [widget.x, widget.y, widget.width, widget.height] : null;
            const entry = this._layout.find(e => e.id === id);
            if (!ids.has(id) || entry.kind !== widget.entry.kind) {
                this._widgets.delete(id);
                if (this._flow)
                    this._gone.push(widget);
                else
                    this._dropWidget(widget);
            }
        }
        for (const entry of this._layout) {
            const widget = this._widgets.get(entry.id);
            if (!widget) {
                const created = this._createWidget(entry);
                if (created)
                    created.was = null;
            }
            else {
                // (Another size, or other options – a clock's face, say:
                // drawn anew.)
                const redraw = widget.entry.size !== entry.size || options(widget.entry) !== options(entry);
                widget.entry = {...entry};
                if (redraw)
                    widget.resize(entry.size);
            }
        }
        this._place();
        this._flow = false;
        this._gone = [];
    }

    // The cards flowing, liquid, from where they were to where they are
    // now (or out of the way): steps of {widget, kind, from, to, delay,
    // duration} – kind pour, gather or spread.
    _startFlow(steps) {
        if (steps.length === 0)
            return;
        if (!this._liquid) {
            this._liquid = new LiquidPaint();
            this._layer.add_child(this._liquid);
        }
        // Over the glass, under the cards.
        this._layer.set_child_above_sibling(this._liquid, this._glass);
        this._liquid.set_size(this._layer.width, this._layer.height);
        this._liquid.show();
        // (The look of a card as it is drawn, before it melts.)
        this._liquid.setLook(steps.find(step => step.kind !== 'spread')?.widget ?? steps[0].widget);
        for (const step of steps)
            this._melt(step.widget, true, step.kind !== 'spread');
        const length = Math.max(...steps.map(step => step.delay + step.duration));
        const timeline = new Clutter.Timeline({actor: this._layer, duration: Math.max(1, adjustAnimationTime(length))});
        this._flowing = {steps, timeline, length};
        timeline.connect('new-frame', () => this._flowFrame());
        timeline.connect('completed', () => this._finishFlow());
        this._flowFrame();
        timeline.start();
    }

    _flowFrame() {
        const {steps, timeline, length} = this._flowing;
        const elapsed = timeline.get_elapsed_time() * length / timeline.duration;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const look = {radius: RADIUS * scale, blend: BLEND * scale};
        const shapes = {boxes: [], capsules: []};
        for (const step of steps) {
            if (step.done)
                continue;
            const t = clamp01((elapsed - step.delay) / step.duration);
            if (t > 0 && !step.started) {
                step.started = true;
                if (step.kind !== 'spread')
                    this._fadeContent(step.widget, 0);
            }
            // (Its card goes there now: what it shows is gone.)
            if (step.kind === 'pour' && t >= 0.12)
                step.widget.set_position(step.to[0], step.to[1]);
            if (t >= 1) {
                this._settle(step);
                continue;
            }
            const shape = step.kind === 'pour' ? pour(step.from, step.to, t, look)
                : step.kind === 'gather' ? gather(step.from, t, look) : spread(step.to, t, look);
            shapes.boxes.push(...shape.boxes);
            shapes.capsules.push(...shape.capsules);
        }
        this._liquidShapes = shapes;
        this._liquid.setShapes(shapes);
        this.syncGlass();
    }

    // A card again (where it goes), or gone.
    // Back on the desktop from the overview: each widget spreads out of its
    // middle, one a little after the other.
    _spreadBack() {
        if (!this._layer)
            return;
        const hidden = this._layer.opacity === 0;
        this._layer.opacity = 255;
        if (!hidden || this._editor || this._flowing || !St.Settings.get().enable_animations)
            return;
        const widgets = [...this._widgets.values()].filter(widget => widget.visible)
            .sort((a, b) => a.y - b.y || a.x - b.x);
        this._startFlow(widgets.map((widget, i) => ({
            widget, kind: 'spread', to: [widget.x, widget.y, widget.width, widget.height],
            delay: i * FLOW_STAGGER, duration: BACK_TIME,
        })));
    }

    _settle(step) {
        step.done = true;
        const {widget} = step;
        if (step.kind === 'gather') {
            this._dropWidget(widget);
            return;
        }
        widget.set_position(step.to[0], step.to[1]);
        this._melt(widget, false, false);
        this._fadeContent(widget, 255, CONTENT_TIME * 2);
    }

    _finishFlow() {
        if (!this._flowing)
            return;
        const {steps, timeline} = this._flowing;
        this._flowing = null;
        timeline.stop();
        steps.filter(step => !step.done).forEach(step => this._settle(step));
        this._liquidShapes = null;
        if (this._liquid) {
            this._liquid.setShapes({});
            this._liquid.hide();
        }
        this.syncGlass();
    }

    /**
     * @param {DesktopWidget} widget
     * @param {boolean} melted - its card drawn by the liquid (its own
     *   background and shadow gone, at once)
     * @param {boolean} [showing] - what it shows (if not, gone at once)
     */
    _melt(widget, melted, showing = true) {
        widget.melted = melted;
        widget.reactive = !melted;
        widget.set_style('transition-duration: 0ms;');
        if (melted)
            widget.add_style_class_name('atelier-widget-melted');
        else
            widget.remove_style_class_name('atelier-widget-melted');
        // (Styled now, then back to its usual transitions.)
        widget.get_theme_node();
        widget.set_style(null);
        if (!showing)
            widget.get_children().forEach(child => (child.opacity = 0));
    }

    _fadeContent(widget, opacity, duration = CONTENT_TIME) {
        for (const child of widget.get_children()) {
            child.remove_transition('opacity');
            child.ease({opacity, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
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
        // (Placed anew while flowing: there at once.)
        if (!this._flow)
            this._finishFlow();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const shown = fitLayout(this._layout, this._grid);
        const steps = [];
        let order = 0;
        for (const entry of shown) {
            const widget = this._widgets.get(entry.id);
            if (!widget)
                continue;
            widget.entry = {...widget.entry, x: entry.x, y: entry.y};
            const [x, y] = cellOrigin(entry.x, entry.y, this._origin).map(v => v * scale);
            const delay = order * FLOW_STAGGER;
            const to = [x, y, widget.width, widget.height];
            const {was} = widget;
            widget.was = null;
            if (this._flow && !was) {
                widget.set_position(x, y);
                steps.push({widget, kind: 'spread', to, delay, duration: SPREAD_TIME});
                order++;
            } else if (this._flow && to.some((v, i) => Math.abs(v - was[i]) >= 1)) {
                steps.push({widget, kind: 'pour', from: was, to, delay, duration: POUR_TIME});
                order++;
            } else {
                widget.set_position(x, y);
            }
        }
        if (this._flow) {
            // (Those gone first, out of the way.)
            const gone = this._gone.map(widget => ({widget, kind: 'gather', from: widget.was, delay: 0, duration: GATHER_TIME}));
            this._startFlow([...gone, ...steps]);
        }
        this.syncGlass();
    }

    /** The glass under the widgets follows them. */
    syncGlass() {
        if (!this._glass)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // (As big as they are drawn, growing in or shrinking away.)
        const rects = [...this._widgets.values()]
            .filter(widget => widget.visible && widget.opacity > 0 && !widget.melted)
            .map(widget => {
                const [w, h] = [widget.width * widget.scale_x, widget.height * widget.scale_y];
                return [widget.x + (widget.width - w) / 2, widget.y + (widget.height - h) / 2, w, h];
            });
        this._glass.setRects(rects, RADIUS * scale, this._liquidShapes ?? {});
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
    /**
     * Put a widget of a kind on the desktop.
     *
     * @param {string} kind
     * @param {object} [options] - its own, e.g. {face} for a clock
     * @param {object|null} [at] - {x, y}: these cells, if it fits there
     * @returns {DesktopWidget|null} the widget, or null when there is no room
     */
    addWidget(kind, options = {}, at = null) {
        const layout = this._shownLayout();
        const entry = {id: newId(layout, kind), kind, size: KINDS[kind].sizes[0], ...options};
        const spot = at && fits(layout, {...entry, ...at}, this._grid) ? at : findSpot(layout, entry, this._grid);
        if (!spot)
            return null;
        this._keep({...entry, ...spot});
        if (Object.keys(options).length > 0) {
            this._layout = this._layout.map(e => (e.id === entry.id ? {...e, ...options} : e));
            this._save();
        }
        const widget = this._createWidget({...entry, ...spot});
        this._place();
        return widget;
    }

    /**
     * A widget of a kind that is not on the desktop (one being dragged out
     * of the gallery, say), in the desktop's look.
     *
     * @param {string} kind
     * @param {object} [options]
     * @returns {St.Widget|null} the widget, in a box with the look's styles
     */
    makeWidget(kind, options = {}) {
        const Kind = this.kinds.get(kind);
        if (!Kind)
            return null;
        const look = new St.Widget({style_class: this._layer.get_style_class_name()});
        const widget = new Kind({id: `new-${kind}`, kind, size: KINDS[kind].sizes[0], x: 0, y: 0, ...options},
            this._context);
        widget.reactive = false;
        look.add_child(widget);
        look.widget = widget;
        return look;
    }

    /**
     * Where a new widget of a kind would land.
     *
     * @param {string} kind
     * @param {number} fx - its top left corner, in cells of the grid (not whole ones)
     * @param {number} fy
     * @returns {object|null} {x, y}: the free cells nearest to that, if any
     */
    spotForNew(kind, fx, fy) {
        const layout = this._shownLayout();
        const entry = {id: '', kind, size: KINDS[kind].sizes[0]};
        const spot = nearestSpot(layout, entry, this._grid, fx, fy);
        return Number.isInteger(spot.x) && fits(layout, {...entry, ...spot}, this._grid) ? spot : null;
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
     * Set one of a widget's options (the clock's face, say): kept with it,
     * and it is built anew.
     *
     * @param {string} id
     * @param {string} key
     * @param {*} value
     */
    setWidgetOption(id, key, value) {
        const widget = this._widgets.get(id);
        if (!widget)
            return;
        this._layout = this._layout.map(entry => (entry.id === id ? {...entry, [key]: value} : entry));
        widget.entry = {...widget.entry, [key]: value};
        this._save();
        widget.resize(widget.entry.size);
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
            if (widget.entry.kind === 'clock') {
                const faces = new PopupMenu.PopupSubMenuMenuItem('Clock Face');
                widget._faces = CLOCK_FACES.map(([id, name]) => {
                    const item = faces.menu.addAction(name, () => this.setWidgetOption(widget.entry.id, 'face', id));
                    item._face = id;
                    return item;
                });
                menu.addMenuItem(faces);
            }
            menu.addAction('Remove', () => this.removeWidget(widget.entry.id));
            Main.uiGroup.add_child(menu.actor);
            menu.actor.hide();
            const manager = new PopupMenu.PopupMenuManager(widget);
            manager.addMenu(menu);
            widget._menu = menu;
            widget._menuManager = manager;
        }
        for (const item of widget._faces ?? []) {
            item.setOrnament(item._face === (widget.entry.face ?? 'auto')
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NO_DOT);
        }
        widget._menu.open(BoxPointer.PopupAnimation.FULL);
    }
}
