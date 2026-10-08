// What clicking and scrolling on the dock do. A click does the action the
// settings pick for its button (lib/dockActions.js says what that comes to
// for the app's windows): by default it opens the app, brings its window
// up, minimizes it when it is up already, or goes through its windows; Ctrl
// opens a new window. Scrolling on an app may go through its windows or
// switch workspaces, and scrolling on the dock between its apps switches
// workspaces.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {pickAction, plan} from '../../lib/dockActions.js';
import {appWindows, windowOptions} from './windows.js';

// How long a round through an app's windows lasts.
const CYCLE_TIME = 3000;
// Scrolling goes on one window, or one workspace, at most this often
// (milliseconds): a touchpad sends many small scrolls.
const SCROLL_PAUSE = 300;

let lastWorkspaceScroll = 0;

/**
 * @param {object} ctx - the icon's: {dock, settings, services, side}
 * @param {Shell.App} app
 * @returns {Meta.Window[]} the app's windows that count for the dock
 */
export function windowsOf(ctx, app) {
    return appWindows(app, windowOptions(ctx.settings, ctx.dock.monitorIndex, ctx.services.locations));
}

/**
 * An app in the dock clicked (or opened by its Super+number).
 *
 * @param {DockIcon} icon
 * @param {number} button - Clutter.BUTTON_*
 * @param {Clutter.ModifierType} modifiers - held as it was clicked
 * @param {object} ctx - the icon's: {dock, settings, services, side}
 */
export function activateApp(icon, button, modifiers, ctx) {
    const app = icon.app;
    const windows = windowsOf(ctx, app);
    const canNew = app.can_open_new_window();
    const shift = (modifiers & Clutter.ModifierType.SHIFT_MASK) !== 0;
    let step;
    if ((modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0 && canNew) {
        step = {kind: 'new-window'};
    } else {
        const focus = global.display.focus_window;
        step = plan(pickAction(key => ctx.settings.get_string(key), button, shift), {
            windows: windows.length,
            focusedIndex: windows.findIndex(window => window === focus),
            minimizedAll: windows.length > 0 && windows.every(window => window.minimized),
            canNew,
            singleActivates: ctx.settings.get_boolean('activate-single-window'),
            plain: button === Clutter.BUTTON_PRIMARY && !shift,
        });
    }
    // The overview goes, unless the step is to show it.
    if (!runStep(step, icon, windows, ctx))
        Main.overview.hide();
}

// Does a step; says whether it leaves the overview to itself.
function runStep(step, icon, windows, ctx) {
    const app = icon.app;
    switch (step.kind) {
    case 'launch':
        icon.animateLaunch();
        // Running elsewhere: a window here, if it can have more.
        if (app.state === Shell.AppState.RUNNING && app.can_open_new_window())
            app.open_new_window(-1);
        else
            app.activate();
        break;
    case 'new-window':
        icon.animateLaunch();
        app.open_new_window(-1);
        break;
    case 'activate':
        if (step.all)
            activateAll(windows);
        else
            Main.activateWindow(windows[0]);
        break;
    case 'minimize-all':
        minimize(windows, step.latest);
        break;
    case 'cycle':
        nextWindow(icon, windows, false);
        break;
    case 'spread':
        // (The overview as it is, where the shell doesn't let it.)
        if (!ctx.services.spread.supported || !ctx.services.spread.toggle(app))
            Main.overview.toggle();
        return true;
    case 'overview':
        Main.overview.toggle();
        return true;
    case 'quit': {
        const time = global.get_current_time();
        windows.forEach(window => window.delete(time));
        break;
    }
    }
    return false;
}

// All its windows up, on the workspace of the latest one, that one on top.
function activateAll(windows) {
    const workspace = windows[0].get_workspace();
    for (const window of [...windows].reverse()) {
        if (window === windows[0] || window.is_on_all_workspaces() || window.get_workspace() === workspace)
            Main.activateWindow(window);
    }
}

// Those shown on the current workspace (only the latest one, if asked).
function minimize(windows, latest) {
    const workspace = global.workspace_manager.get_active_workspace();
    const shown = windows.filter(window => window.located_on_workspace(workspace) &&
        window.showing_on_its_workspace());
    for (const window of latest ? shown.slice(0, 1) : shown)
        window.minimize();
}

// Through the windows in the order they had when the round began (back,
// when reversed).
function nextWindow(icon, windows, reversed) {
    const now = Date.now();
    if (!icon._cycle || now - icon._cycle.time > CYCLE_TIME ||
        !icon._cycle.windows.every(window => windows.includes(window)))
        icon._cycle = {windows: [...windows], index: 0};
    icon._cycle.time = now;
    const count = icon._cycle.windows.length;
    icon._cycle.index = (icon._cycle.index + (reversed ? count - 1 : 1)) % count;
    Main.activateWindow(icon._cycle.windows[icon._cycle.index]);
}

// -1 (up, left), 1 (down, right) or 0 for a scroll.
function scrollStep(event) {
    switch (event.get_scroll_direction()) {
    case Clutter.ScrollDirection.UP:
    case Clutter.ScrollDirection.LEFT:
        return -1;
    case Clutter.ScrollDirection.DOWN:
    case Clutter.ScrollDirection.RIGHT:
        return 1;
    case Clutter.ScrollDirection.SMOOTH: {
        const [dx, dy] = event.get_scroll_delta();
        return Math.sign(dy || dx);
    }
    default:
        return 0;
    }
}

/**
 * Scrolling on an app in the dock.
 *
 * @param {DockIcon} icon
 * @param {Clutter.Event} event
 * @param {object} ctx - the icon's: {dock, settings, services, side}
 * @returns {boolean} Clutter.EVENT_STOP when it did something with it
 */
export function scrollApp(icon, event, ctx) {
    switch (ctx.settings.get_string('scroll-action')) {
    case 'cycle-windows':
        return scrollWindows(icon, event, ctx);
    case 'switch-workspace':
        return switchWorkspace(event);
    default:
        return Clutter.EVENT_PROPAGATE;
    }
}

// Down to the next of the app's windows, up back; an app in the background
// is brought up first.
function scrollWindows(icon, event, ctx) {
    const windows = windowsOf(ctx, icon.app);
    const step = scrollStep(event);
    if (windows.length === 0 || step === 0)
        return Clutter.EVENT_PROPAGATE;
    const now = Date.now();
    if (now - (icon._scrolled ?? 0) < SCROLL_PAUSE)
        return Clutter.EVENT_STOP;
    icon._scrolled = now;
    if (Main.overview.visible)
        icon.app.activate();
    else if (windows.includes(global.display.focus_window))
        nextWindow(icon, windows, step < 0);
    else
        Main.activateWindow(windows[0]);
    return Clutter.EVENT_STOP;
}

// To the workspace before (up, left) or after (down, right) this one.
function switchWorkspace(event) {
    const step = scrollStep(event);
    if (step === 0 || Main.overview.visible)
        return Clutter.EVENT_PROPAGATE;
    const now = Date.now();
    if (now - lastWorkspaceScroll < SCROLL_PAUSE)
        return Clutter.EVENT_STOP;
    lastWorkspaceScroll = now;
    const manager = global.workspace_manager;
    const index = manager.get_active_workspace_index() + step;
    if (index >= 0 && index < manager.n_workspaces)
        Main.wm.actionMoveWorkspace(manager.get_workspace_by_index(index));
    return Clutter.EVENT_STOP;
}

/**
 * Scrolling on the dock, not on an app.
 *
 * @param {Dock} dock
 * @param {Clutter.Event} event
 * @returns {boolean} Clutter.EVENT_STOP when it did something with it
 */
export function scrollDock(dock, event) {
    if (!dock.settings.get_boolean('scroll-switch-workspace'))
        return Clutter.EVENT_PROPAGATE;
    // (On an app, the app's scrolling says; it let this one through.)
    const [x, y] = global.get_pointer();
    const under = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
    if ([...dock.items.values()].some(item => item.contains(under)))
        return Clutter.EVENT_PROPAGATE;
    return switchWorkspace(event);
}
