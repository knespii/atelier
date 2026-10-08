// When a dock is away and how it goes: out of the way of windows (as its
// intellihide says), when the pointer leaves it, or until it is called –
// off the screen past its edge – and back when the pointer reaches that
// edge (after a moment) or pushes against it, or for a while when a window
// of it asks for attention. It stays while the pointer is on it, a menu of
// it is open or something is dragged, and goes in the overview. While it
// is always visible (dock-fixed), it goes only in the overview. Which of
// these wins is lib/dockVisibility.js's shouldHide().
//
// Pushing against the edge (require-pressure-to-show) puts a pressure
// barrier there while the dock is away, where the shell's backend has
// barriers; without them, the edge brings it back as without pushing.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {barrierLine, edgeRect, hiddenOffset, isHorizontal, pointerInZone} from '../../lib/dockGeometry.js';
import {shouldHide} from '../../lib/dockVisibility.js';
import {appWindows, windowOptions} from './windows.js';

// After the edge brought it back, how long it stays at least, and how often
// it then looks whether the pointer left, milliseconds.
const REVEAL_HOLD = 1500;
const REVEAL_POLL = 250;
// How long a window asking for attention keeps it.
const URGENT_TIME = 3000;
// How long the pressure barrier stays once the dock is back: pushed on, the
// pointer would go past the edge (to another monitor) and the dock away.
const BARRIER_HOLD = 100;

// Settings it looks at again as they change.
const SYNC_KEYS = ['autohide', 'manualhide', 'intellihide'];
const PRESSURE_KEYS = ['require-pressure-to-show', 'pressure-threshold', 'show-delay'];

const seconds = (settings, key) => Math.round(settings.get_double(key) * 1000);

export class DockHider extends EventEmitter {
    /**
     * @param {Dock} dock
     * @param {Gio.Settings} settings - the dock's
     */
    constructor(dock, settings) {
        super();
        this._dock = dock;
        this._settings = settings;
        this._hidden = false;
        this._forced = 0;
        this._revealed = false;
        this._urgent = false;
        this._sliding = false; // on its way, or about to be (not all the way away nor back)
        this._destroyed = false;
        this._pressure = null; // Layout.PressureBarrier, while pushing is asked for and possible
        this._barrier = null; // its Meta.Barrier at the edge, only while the dock is away

        // The edge brings it back while it is away (after the show delay,
        // if the pointer stays).
        this._edge = new St.Widget({name: 'atelier-dock-edge', reactive: true, visible: false});
        Main.layoutManager.addChrome(this._edge, {affectsStruts: false, trackFullscreen: dock.tracksFullscreen});
        this._edge.connect('enter-event', () => this._onEdgeEntered());
        this._edge.connect('leave-event', () => this._dock.timers.clear('edge'));

        // (Away already, it keeps no barrier in the overview.)
        const onOverview = () => {
            this.sync();
            this._syncBarrier();
        };
        Main.overview.connectObject(
            'showing', onOverview,
            'hidden', onOverview,
            'item-drag-begin', () => this.force(true),
            'item-drag-end', () => this.force(false),
            this);
        dock.container.connectObject('notify::hover', () => this.sync(), this);
        dock.intellihide.connectObject('changed', () => this.sync(), this);
        dock.connectObject('placed', () => this._onPlaced(), this);
        settings.connectObject(
            ...SYNC_KEYS.flatMap(key => [`changed::${key}`, () => this.sync()]),
            ...PRESSURE_KEYS.flatMap(key => [`changed::${key}`, () => this._setupPressure()]),
            this);
        global.display.connectObject(
            'in-fullscreen-changed', () => {
                this.sync();
                this._syncBarrier();
            },
            'window-demands-attention', (_, window) => this._onUrgent(window),
            'window-marked-urgent', (_, window) => this._onUrgent(window),
            this);
        this._setupPressure();
    }

    /** @returns {boolean} whether the dock is away */
    get hidden() {
        return this._hidden;
    }

    /** @returns {boolean} whether the edge brought it back, and it stays for now */
    get revealed() {
        return this._revealed;
    }

    /** @returns {St.Widget} the strip of the edge that brings it back */
    get edge() {
        return this._edge;
    }

    /** @returns {boolean} whether the backend can hold the pointer at a barrier */
    get barriersSupported() {
        return (global.backend.get_capabilities() & Meta.BackendCapabilities.BARRIERS) !== 0;
    }

    /**
     * Keep it shown (a menu of it is open, something is being dragged).
     *
     * @param {boolean} forced
     */
    force(forced) {
        this._forced = Math.max(0, this._forced + (forced ? 1 : -1));
        this.sync();
    }

    /**
     * Bring it back for as long as the pointer is on it, or on the way to
     * it from the edge.
     */
    reveal() {
        this._revealed = true;
        this.sync();
        // Away again once the pointer isn't on it (after a moment to get
        // there). Still at the edge, it stays: going, it would uncover the
        // edge under the pointer, which brings it back – up and down for as
        // long as the pointer rests there.
        const since = Date.now();
        this._dock.timers.after('revealed', REVEAL_POLL, () => {
            if (Date.now() - since < REVEAL_HOLD || this._dock.container.hover || this._pointerAtDock())
                return true;
            this._revealed = false;
            this.sync();
            return false;
        });
    }

    // On it, or between it and the edge that brought it.
    _pointerAtDock() {
        const [x, y] = global.get_pointer();
        const monitor = this._dock.monitor;
        const rect = this._dock.staticRect;
        return Boolean(monitor && rect) && pointerInZone(this._dock.side, monitor, rect, x, y);
    }

    // A window filling the dock's monitor hides the shell's chrome, and
    // the dock with it – unless it is to stay reachable at its edge then
    // (autohide-in-fullscreen), when it goes as if covered.
    get _fullscreen() {
        return Boolean(this._dock.monitor?.inFullscreen);
    }

    _onEdgeEntered() {
        const delay = seconds(this._settings, 'show-delay');
        if (delay === 0)
            this.reveal();
        else
            this._dock.timers.after('edge', delay, () => this.reveal());
    }

    // Pushed against the edge long enough.
    _onPressure() {
        if (Main.overview.visibleTarget || (this._fullscreen && this._dock.tracksFullscreen))
            return;
        this.reveal();
    }

    // A window of an app of it asks for attention: it shows for a while.
    _onUrgent(window) {
        if (!window || !this._settings.get_boolean('show-dock-urgent-notify'))
            return;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const options = windowOptions(this._settings, this._dock.monitorIndex, this._dock.services.locations);
        if (!app || !appWindows(app, options).includes(window))
            return;
        this._urgent = true;
        this.sync();
        this._dock.timers.after('urgent', URGENT_TIME, () => {
            this._urgent = false;
            this.sync();
        });
    }

    _onPlaced() {
        this._placeEdge();
        // (Away, it stays all the way off the screen as its size changes.)
        if (this._hidden && !this._dock.timers.has('hide'))
            this._slide(true);
        this._syncBarrier();
    }

    _placeEdge() {
        const monitor = this._dock.monitor;
        const rect = this._dock.staticRect;
        if (!monitor || !rect)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const edge = edgeRect(this._dock.side, monitor, rect, scale);
        this._edge.set_position(edge.x, edge.y);
        this._edge.set_size(edge.width, edge.height);
    }

    // The pressure barrier's sensor, with the settings' threshold and the
    // show delay as the time the pressure adds up over.
    _setupPressure() {
        this._removeBarrier();
        this._pressure?.disconnectObject(this);
        this._pressure?.destroy();
        this._pressure = null;
        if (this._settings.get_boolean('require-pressure-to-show') && this.barriersSupported) {
            this._pressure = new Layout.PressureBarrier(
                this._settings.get_double('pressure-threshold'), seconds(this._settings, 'show-delay'),
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
            this._pressure.connectObject('trigger', () => this._onPressure(), this);
        }
        this._syncEdge();
        this._syncBarrier();
    }

    // The barrier is there only while the dock is all the way away (not in
    // the overview, nor over a window filling the screen that hides the
    // dock: the pointer would be stuck at an edge with nothing there).
    _syncBarrier() {
        const monitor = this._dock.monitor;
        const rect = this._dock.staticRect;
        const wanted = Boolean(this._pressure && monitor && rect) && this._hidden && !this._sliding &&
            !Main.overview.visible && !(this._fullscreen && this._dock.tracksFullscreen);
        const line = wanted ? barrierLine(this._dock.side, monitor, rect) : null;
        const same = line && this._barrier && ['x1', 'y1', 'x2', 'y2'].every(k => this._barrier[k] === line[k]);
        if (same)
            return;
        this._removeBarrier();
        if (!line)
            return;
        this._barrier = new Meta.Barrier({
            backend: global.backend,
            x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2,
            directions: Meta.BarrierDirection[line.direction],
        });
        // (Triggered when it brought the dock back, the sensor waits for
        // the pointer to leave a barrier that is gone by then.)
        this._pressure._reset();
        this._pressure._isTriggered = false;
        this._pressure.addBarrier(this._barrier);
    }

    _removeBarrier() {
        if (!this._barrier)
            return;
        this._pressure?.removeBarrier(this._barrier);
        this._barrier.destroy();
        this._barrier = null;
    }

    // The edge brings it back while it is away, unless the pointer is to
    // push against a barrier there.
    _syncEdge() {
        this._edge.visible = this._hidden && !Main.overview.visible && !this._pressure;
    }

    sync() {
        // (A menu of it closing as it goes, say.)
        if (this._destroyed)
            return;
        const settings = this._settings;
        const away = shouldHide({
            overview: Main.overview.visible,
            fixed: settings.get_boolean('dock-fixed'),
            manual: settings.get_boolean('manualhide'),
            autohide: settings.get_boolean('autohide'),
            intellihide: settings.get_boolean('intellihide'),
            overlapped: this._dock.intellihide.overlapped,
            forced: this._forced > 0,
            hover: this._dock.container.hover,
            revealed: this._revealed,
            fullscreen: this._fullscreen && !this._dock.tracksFullscreen,
            urgent: this._urgent,
        });
        if (away === this._hidden)
            return;
        this._hidden = away;
        this._dock.timers.clear('hide');
        this._sliding = true;
        if (away)
            this._dock.timers.after('hide', seconds(settings, 'hide-delay'), () => this._slide(true));
        else
            this._slide(false);
        this.emit('changed');
    }

    /** @returns {object} {x, y}: where the dock's container is moved to while away */
    get hiddenTranslation() {
        const container = this._dock.container;
        const side = this._dock.side;
        const thickness = isHorizontal(side) ? container.height : container.width;
        // (Past the edge of the monitor: at the top, past the top bar too.)
        const monitor = this._dock.monitor;
        const rect = this._dock.staticRect;
        const gap = monitor && rect ? {
            TOP: rect.y - monitor.y,
            LEFT: rect.x - monitor.x,
            RIGHT: monitor.x + monitor.width - rect.x - rect.width,
            BOTTOM: monitor.y + monitor.height - rect.y - rect.height,
        }[side] : this._dock.margin;
        return hiddenOffset(side, thickness, gap);
    }

    _slide(away) {
        const {x, y} = this.hiddenTranslation;
        this._syncEdge();
        this._sliding = true;
        this._dock.timers.clear('barrier');
        this._dock.container.ease({
            translation_x: away ? x : 0,
            translation_y: away ? y : 0,
            opacity: away && Main.overview.visible ? 0 : 255,
            duration: seconds(this._settings, 'animation-time'),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: finished => {
                if (this._destroyed)
                    return;
                this._dock.syncGlass();
                if (!finished)
                    return;
                this._sliding = false;
                // Away, the barrier comes; back, it goes a moment later.
                if (away)
                    this._syncBarrier();
                else
                    this._dock.timers.after('barrier', BARRIER_HOLD, () => this._syncBarrier());
            },
        });
    }

    destroy() {
        this._destroyed = true;
        for (const name of ['hide', 'revealed', 'edge', 'urgent', 'barrier'])
            this._dock.timers.clear(name);
        this._removeBarrier();
        this._pressure?.disconnectObject(this);
        this._pressure?.destroy();
        this._pressure = null;
        Main.overview.disconnectObject(this);
        this._dock.container.disconnectObject(this);
        this._dock.intellihide.disconnectObject(this);
        this._dock.disconnectObject(this);
        this._settings.disconnectObject(this);
        global.display.disconnectObject(this);
        this._edge.destroy();
        this.disconnectAll();
    }
}
