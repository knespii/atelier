// Whether the desktop can be seen: not with the overview over it, nor the
// screen shield (a blank screen, or the lock screen), nor while the screen
// is dimmed for the user being away – and, for a widget on it, whether
// the windows on the workspace leave any of it to see. Photo widgets ask
// before they take turns (there is no point in it, nobody would see it),
// and are told ('changed') when it may have changed: the windows are
// watched only while one of them wants to know.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isCovered} from '../../lib/photos.js';

// Windows that are in the way of what is under them.
const COVERING = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG];
// Windows change in bursts (moved, a frame at a time): told once a while
// after the first change, ms.
const DEBOUNCE = 100;
// GNOME dims the screen when the user has been away for this part of the
// time after which it blanks (idle-delay), but not before this many seconds.
const DIM_PART = 4 / 5;
const DIM_LEAST = 10;

/**
 * @param {string} id
 * @returns {Gio.Settings|null} the settings of that schema, if there are
 */
function settingsOf(id) {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(id, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

export class Sight extends EventEmitter {
    constructor() {
        super();
        this._away = false;
        this._idleWatch = 0;
        this._activeWatch = 0;
        this._changedId = 0;
        this._watchers = new Set();
        this._actors = new Set();
        const changed = () => this._changed();
        Main.overview.connectObject('showing', changed, 'hidden', changed, this);
        Main.screenShield?.connectObject('active-changed', changed, this);
        Main.sessionMode.connectObject('updated', changed, this);
        this._session = settingsOf('org.gnome.desktop.session');
        this._power = settingsOf('org.gnome.settings-daemon.plugins.power');
        this._session?.connectObject('changed::idle-delay', () => this._watchAway(), this);
        this._power?.connectObject('changed::idle-dim', () => this._watchAway(), this);
        this._watchAway();
    }

    /** @returns {boolean} whether the desktop is on the screen, and the screen lit */
    get desktopShown() {
        return !Main.overview.visible && !Main.screenShield?.active && !Main.sessionMode.isLocked && !this._away;
    }

    /**
     * @param {Clutter.Actor} actor - on the desktop
     * @returns {boolean} whether all of it is under windows of the workspace
     */
    covered(actor) {
        const [x, y] = actor.get_transformed_position();
        const [width, height] = actor.get_transformed_size();
        const workspace = global.workspace_manager.get_active_workspace();
        const over = workspace.list_windows()
            .filter(window => COVERING.includes(window.get_window_type()) && !window.minimized &&
                window.showing_on_its_workspace() && window.get_compositor_private()?.visible)
            .map(window => {
                const frame = window.get_frame_rect();
                return [frame.x, frame.y, frame.width, frame.height];
            });
        return isCovered([x, y, width, height], over);
    }

    /**
     * Be told as the windows change, too – or not any more.
     *
     * @param {object} watcher - who wants to know
     * @param {boolean} watching
     */
    watchWindows(watcher, watching) {
        const before = this._watchers.size > 0;
        if (watching)
            this._watchers.add(watcher);
        else
            this._watchers.delete(watcher);
        const now = this._watchers.size > 0;
        if (now && !before)
            this._startWatching();
        else if (!now && before)
            this._stopWatching();
    }

    _startWatching() {
        const changed = () => this._changed();
        global.workspace_manager.connectObject('active-workspace-changed', changed, this);
        global.display.connectObject(
            'restacked', changed,
            'window-created', (_, window) => this._watch(window),
            this);
        global.get_window_actors().forEach(actor => this._watch(actor.meta_window));
    }

    _stopWatching() {
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._actors.forEach(actor => {
            actor.disconnectObject(this);
            actor.meta_window?.disconnectObject(this);
        });
        this._actors.clear();
    }

    // A window moved, stretched, minimized or gone.
    _watch(window) {
        // (A new window gets its actor a moment later.)
        const actor = window?.get_compositor_private();
        if (!actor) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this._watchers.size > 0 && window.get_compositor_private())
                    this._watch(window);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (this._actors.has(actor))
            return;
        this._actors.add(actor);
        const changed = () => this._changed();
        actor.connectObject(
            'notify::allocation', changed,
            'notify::visible', changed,
            'destroy', () => {
                this._actors.delete(actor);
                changed();
            },
            this);
        window.connectObject('notify::minimized', changed, this);
        changed();
    }

    // The user away for as long as GNOME waits before it dims the screen
    // (or blanks it, when it doesn't dim): the screen is as good as unseen
    // until they are back.
    _watchAway() {
        const monitor = global.backend.get_core_idle_monitor();
        if (this._idleWatch)
            monitor.remove_watch(this._idleWatch);
        this._idleWatch = 0;
        const delay = this._session?.get_uint('idle-delay') ?? 0;
        if (delay === 0)
            return;
        const dims = this._power?.get_boolean('idle-dim') ?? false;
        const seconds = dims ? Math.max(DIM_LEAST, Math.floor(delay * DIM_PART)) : delay;
        this._idleWatch = monitor.add_idle_watch(seconds * 1000, () => {
            this._away = true;
            this._changed();
            if (!this._activeWatch) {
                this._activeWatch = monitor.add_user_active_watch(() => {
                    this._activeWatch = 0;
                    this._away = false;
                    this._changed();
                });
            }
        });
    }

    _changed() {
        if (this._changedId)
            return;
        this._changedId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE, () => {
            this._changedId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._changedId)
            GLib.source_remove(this._changedId);
        this._changedId = 0;
        const monitor = global.backend.get_core_idle_monitor();
        for (const watch of [this._idleWatch, this._activeWatch]) {
            if (watch)
                monitor.remove_watch(watch);
        }
        this._idleWatch = this._activeWatch = 0;
        this._watchers.clear();
        this._stopWatching();
        Main.overview.disconnectObject(this);
        Main.screenShield?.disconnectObject(this);
        Main.sessionMode.disconnectObject(this);
        this._session?.disconnectObject(this);
        this._power?.disconnectObject(this);
        this.disconnectAll();
    }
}
