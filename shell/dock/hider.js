// When a dock is away and how it goes: out of the way of windows (as its
// intellihide says), off the screen past its edge, and back when the
// pointer reaches that edge. It stays while the pointer is on it, a menu
// of it is open or something is dragged, and goes in the overview. While
// it is always visible (dock-fixed), it goes only in the overview.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {edgeRect, hiddenOffset, isHorizontal, pointerInZone} from '../../lib/dockGeometry.js';

const SHOW_TIME = 200; // milliseconds
const HIDE_DELAY = 200;
// After the edge brought it back, how often it looks whether the pointer left.
const REVEAL_CHECK = 1500;

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
        this._destroyed = false;

        // The edge brings it back while it is away.
        this._edge = new St.Widget({name: 'atelier-dock-edge', reactive: true, visible: false});
        Main.layoutManager.addChrome(this._edge, {affectsStruts: false, trackFullscreen: dock.tracksFullscreen});
        this._edge.connect('enter-event', () => this.reveal());

        Main.overview.connectObject(
            'showing', () => this.sync(),
            'hidden', () => this.sync(),
            'item-drag-begin', () => this.force(true),
            'item-drag-end', () => this.force(false),
            this);
        dock.container.connectObject('notify::hover', () => this.sync(), this);
        dock.intellihide.connectObject('changed', () => this.sync(), this);
        dock.connectObject('placed', () => this._placeEdge(), this);
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
        this._dock.timers.after('revealed', REVEAL_CHECK, () => {
            if (this._dock.container.hover || this._pointerAtDock())
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

    sync() {
        // (A menu of it closing as it goes, say.)
        if (this._destroyed)
            return;
        const container = this._dock.container;
        const intellihide = this._settings.get_boolean('intellihide') && !this._settings.get_boolean('dock-fixed');
        const away = Main.overview.visible ||
            (intellihide && this._dock.intellihide.overlapped && !this._forced && !container.hover && !this._revealed);
        if (away === this._hidden)
            return;
        this._hidden = away;
        this._dock.timers.clear('hide');
        if (away)
            this._dock.timers.after('hide', HIDE_DELAY, () => this._slide(true));
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
        this._edge.visible = away && !Main.overview.visible;
        this._dock.container.ease({
            translation_x: away ? x : 0,
            translation_y: away ? y : 0,
            opacity: away && Main.overview.visible ? 0 : 255,
            duration: SHOW_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._dock.syncGlass(),
        });
    }

    destroy() {
        this._destroyed = true;
        for (const name of ['hide', 'revealed'])
            this._dock.timers.clear(name);
        Main.overview.disconnectObject(this);
        this._dock.container.disconnectObject(this);
        this._dock.intellihide.disconnectObject(this);
        this._dock.disconnectObject(this);
        this._edge.destroy();
        this.disconnectAll();
    }
}
