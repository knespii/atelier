// An app in the dock: GNOME's dash icon (its menu, its running dot, drag
// and drop), opening and switching windows the dock's way – only windows on
// this workspace count. A click opens the app, brings its window up,
// minimizes it when it is up already, or goes through its windows.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// How long a round through an app's windows lasts.
const CYCLE_TIME = 3000;

/**
 * @param {Shell.App} app
 * @returns {Meta.Window[]} its windows on the current workspace, the latest used first
 */
export function workspaceWindows(app) {
    const workspace = global.workspace_manager.get_active_workspace();
    return app.get_windows().filter(window => !window.skip_taskbar && window.located_on_workspace(workspace));
}

export const DockIcon = GObject.registerClass(
class AtelierDockIcon extends Dash.DashIcon {
    _init(app, iconSize) {
        super._init(app);
        this._iconSize = iconSize;
        this._cycle = null;
        this.icon.setIconSize(iconSize);
        this._updateRunningStyle();
    }

    // Running here means windows on this workspace.
    _updateRunningStyle() {
        if (!this._dot)
            return;
        if (workspaceWindows(this.app).length > 0)
            this._dot.show();
        else
            this._dot.hide();
    }

    activate(button) {
        const event = Clutter.get_current_event();
        const modifiers = event ? event.get_state() : 0;
        const wantsNew = (modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0 || button === Clutter.BUTTON_MIDDLE;
        const windows = workspaceWindows(this.app);
        if (wantsNew && this.app.can_open_new_window()) {
            this.animateLaunch();
            this.app.open_new_window(-1);
        } else if (windows.length === 0) {
            this.animateLaunch();
            // Running elsewhere: a window here, if it can have more.
            if (this.app.state === Shell.AppState.RUNNING && this.app.can_open_new_window())
                this.app.open_new_window(-1);
            else
                this.app.activate();
        } else if (windows.includes(global.display.focus_window)) {
            if (windows.length === 1)
                windows[0].minimize();
            else
                this._nextWindow(windows);
        } else {
            Main.activateWindow(windows[0]);
        }
        Main.overview.hide();
    }

    // Through the windows in the order they had when the round began.
    _nextWindow(windows) {
        const now = Date.now();
        if (!this._cycle || now - this._cycle.time > CYCLE_TIME ||
            !this._cycle.windows.every(window => windows.includes(window)))
            this._cycle = {windows: [...windows], index: 0};
        this._cycle.time = now;
        this._cycle.index = (this._cycle.index + 1) % this._cycle.windows.length;
        Main.activateWindow(this._cycle.windows[this._cycle.index]);
    }

    getDragActor() {
        return this.app.create_icon_texture(this._iconSize);
    }

    _onDestroy() {
        // (GNOME's app icon keeps its menu.)
        this._menu?.destroy();
        this._menu = null;
        super._onDestroy();
    }
});

// The item holding an icon in the dock's row, with the app's name above it
// while the pointer rests on it.
export const DockItem = GObject.registerClass({
    Signals: {'menu-state-changed': {param_types: [GObject.TYPE_BOOLEAN]}},
}, class AtelierDockItem extends Dash.DashItemContainer {
    _init(app, iconSize) {
        super._init();
        this.app = app;
        const icon = new DockIcon(app, iconSize);
        this.setChild(icon);
        this.setLabelText(app.get_name());
        icon.connect('notify::hover', () => {
            if (icon.hover && icon.shouldShowTooltip())
                this.showLabel();
            else
                this.hideLabel();
        });
        icon.connect('menu-state-changed', (_, opened) => {
            if (opened)
                this.hideLabel();
            this.emit('menu-state-changed', opened);
        });
    }

    get icon() {
        return this.child;
    }
});
