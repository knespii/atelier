// Whether windows cover a dock where it is when it is shown: which ones
// count is the intellihide mode's (lib/dockVisibility.js), on the current
// workspace. It says 'changed' after every check, and the dock's hider
// decides.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {windowCovers} from '../../lib/dockVisibility.js';

const CHECK_DELAY = 100; // milliseconds

// Windows that can cover the dock.
const COVERING_TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG,
    Meta.WindowType.UTILITY];

export class Intellihide extends EventEmitter {
    /**
     * @param {Dock} dock
     * @param {Gio.Settings} settings - the dock's
     * @param {WindowWatcher} windows - the docks' window signals
     */
    constructor(dock, settings, windows) {
        super();
        this._dock = dock;
        this._settings = settings;
        this._windows = windows;
        this._overlapped = false;
        windows.connectObject('changed', () => this.check(), this);
        settings.connectObject(
            'changed::intellihide', () => this.queueCheck(),
            'changed::intellihide-mode', () => this.queueCheck(),
            this);
        dock.connectObject('placed', () => this.queueCheck(), this);
    }

    /** @returns {boolean} whether windows cover the dock */
    get overlapped() {
        return this._overlapped;
    }

    /** Check in a moment (once, however often this is called until then). */
    queueCheck() {
        this._dock.timers.after('check', CHECK_DELAY, () => this.check());
    }

    // Do windows that count in the mode cover where it is?
    check() {
        const rect = this._dock.staticRect;
        if (!rect)
            return;
        const mode = this._settings.get_string('intellihide-mode');
        const tracker = Shell.WindowTracker.get_default();
        const workspace = global.workspace_manager.get_active_workspace();
        const appId = window => tracker.get_window_app(window)?.get_id() ?? null;
        const windows = global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(window => window && COVERING_TYPES.includes(window.get_window_type()));
        const shown = window => !window.minimized && window.located_on_workspace(workspace) &&
            window.showing_on_its_workspace();
        // (Bottom to top: the last one on its monitor is on top.)
        const top = windows.filter(window => shown(window) && window.get_monitor() === this._dock.monitorIndex).at(-1);
        const focus = global.display.focus_window;
        const ctx = {
            rect,
            focusAppId: tracker.focus_app?.get_id() ?? null,
            topAppId: top ? appId(top) : null,
            halfMonitor: focus?.maximized_vertically && !focus.maximized_horizontally ? focus.get_monitor() : -1,
        };
        this._overlapped = this._settings.get_boolean('intellihide') && windows.some(window => windowCovers(mode, {
            rect: window.get_frame_rect(),
            appId: appId(window),
            monitorIndex: window.get_monitor(),
            minimized: window.minimized,
            onWorkspace: window.located_on_workspace(workspace),
            showing: window.showing_on_its_workspace(),
            maximizedHorizontally: window.maximized_horizontally,
            maximizedVertically: window.maximized_vertically,
            fullscreen: window.fullscreen,
            above: window.is_above(),
        }, ctx));
        this.emit('changed');
    }

    destroy() {
        this._dock.timers.clear('check');
        this._windows.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._dock.disconnectObject(this);
        this.disconnectAll();
    }
}
