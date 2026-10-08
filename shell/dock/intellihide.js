// Whether windows cover a dock: those of the focused app on the current
// workspace, where the dock is when it is shown. It says 'changed' after
// every check, and the dock's hider decides.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {rectsOverlap} from '../../lib/dockGeometry.js';

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
        settings.connectObject('changed::intellihide', () => this.queueCheck(), this);
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

    // Do the focused app's windows on this workspace cover where it is?
    check() {
        const rect = this._dock.staticRect;
        if (!rect)
            return;
        const focused = Shell.WindowTracker.get_default().focus_app;
        const workspace = global.workspace_manager.get_active_workspace();
        this._overlapped = Boolean(focused) && focused.get_windows().some(window => {
            if (!COVERING_TYPES.includes(window.get_window_type()) || window.minimized ||
                !window.located_on_workspace(workspace) || !window.showing_on_its_workspace())
                return false;
            return rectsOverlap(window.get_frame_rect(), rect);
        });
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
