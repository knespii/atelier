// What clicking and scrolling on the dock do. A click opens the app, brings
// its window up, minimizes it when it is up already, or goes through its
// windows; Ctrl or the middle button opens a new window.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {appWindows, windowOptions} from './windows.js';

// How long a round through an app's windows lasts.
const CYCLE_TIME = 3000;

/**
 * @param {object} ctx - the icon's: {dock, settings, services, side}
 * @param {Shell.App} app
 * @returns {Meta.Window[]} the app's windows that count for the dock
 */
export function windowsOf(ctx, app) {
    return appWindows(app, windowOptions(ctx.settings, ctx.dock.monitorIndex, ctx.services.locations));
}

/**
 * An app in the dock clicked.
 *
 * @param {DockIcon} icon
 * @param {number} button - Clutter.BUTTON_*
 * @param {Clutter.ModifierType} modifiers - held as it was clicked
 * @param {object} ctx - the icon's: {dock, settings, services, side}
 */
export function activateApp(icon, button, modifiers, ctx) {
    const app = icon.app;
    const wantsNew = (modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0 || button === Clutter.BUTTON_MIDDLE;
    const windows = windowsOf(ctx, app);
    if (wantsNew && app.can_open_new_window()) {
        icon.animateLaunch();
        app.open_new_window(-1);
    } else if (windows.length === 0) {
        icon.animateLaunch();
        // Running elsewhere: a window here, if it can have more.
        if (app.state === Shell.AppState.RUNNING && app.can_open_new_window())
            app.open_new_window(-1);
        else
            app.activate();
    } else if (windows.includes(global.display.focus_window)) {
        if (windows.length === 1)
            windows[0].minimize();
        else
            nextWindow(icon, windows);
    } else {
        Main.activateWindow(windows[0]);
    }
    Main.overview.hide();
}

// Through the windows in the order they had when the round began.
function nextWindow(icon, windows) {
    const now = Date.now();
    if (!icon._cycle || now - icon._cycle.time > CYCLE_TIME ||
        !icon._cycle.windows.every(window => windows.includes(window)))
        icon._cycle = {windows: [...windows], index: 0};
    icon._cycle.time = now;
    icon._cycle.index = (icon._cycle.index + 1) % icon._cycle.windows.length;
    Main.activateWindow(icon._cycle.windows[icon._cycle.index]);
}

/**
 * Scrolling on an app in the dock.
 *
 * @param {DockIcon} _icon
 * @param {Clutter.Event} _event
 * @param {object} _ctx - the icon's: {dock, settings, services, side}
 * @returns {boolean} Clutter.EVENT_STOP when it did something with it
 */
export function scrollApp(_icon, _event, _ctx) {
    return Clutter.EVENT_PROPAGATE;
}

/**
 * Scrolling on the dock, not on an app.
 *
 * @param {Dock} _dock
 * @param {Clutter.Event} _event
 * @returns {boolean} Clutter.EVENT_STOP when it did something with it
 */
export function scrollDock(_dock, _event) {
    return Clutter.EVENT_PROPAGATE;
}
