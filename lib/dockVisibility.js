// Whether a dock should be away, from what is going on, and whether a
// window covers it in each intellihide mode. Pure functions, shared by the
// shell and the tests.

import {rectsOverlap} from './dockGeometry.js';

/**
 * In order: the overview takes it away; always visible (fixed), it stays;
 * kept (a menu, a drag), with the pointer on it, brought back by its edge
 * or for an urgent window, it stays; hidden until called (manual), it
 * goes; out of the way of windows, it goes while they cover it (or a
 * window fills the screen); hiding when the pointer leaves, it goes;
 * otherwise only a window filling the screen takes it away.
 *
 * @param {object} state - what is going on, booleans: {overview, fixed,
 *   manual, autohide, intellihide, overlapped, forced, hover, revealed,
 *   fullscreen (a window fills its monitor and the dock doesn't go with
 *   the rest of the shell's chrome), urgent}
 * @returns {boolean} whether the dock should be away
 */
export function shouldHide(state) {
    if (state.overview)
        return true;
    if (state.fixed)
        return false;
    if (state.forced || state.hover || state.revealed || state.urgent)
        return false;
    if (state.manual)
        return true;
    if (state.intellihide)
        return Boolean(state.overlapped || state.fullscreen);
    if (state.autohide)
        return true;
    return Boolean(state.fullscreen);
}

/**
 * Only windows on the current workspace, shown and over where the dock is
 * when shown count. Then, by mode: any of them (ALL_WINDOWS); those of
 * the focused app, of the app on top on the dock's monitor, those kept on
 * top and those maximized side by side with the focused window
 * (FOCUS_APPLICATION_WINDOWS, nothing while no app has the focus);
 * maximized or full screen ones (MAXIMIZED_WINDOWS); only full screen ones
 * (ALWAYS_ON_TOP: the dock is above everything else).
 *
 * @param {string} mode - 'ALL_WINDOWS', 'FOCUS_APPLICATION_WINDOWS',
 *   'MAXIMIZED_WINDOWS' or 'ALWAYS_ON_TOP'
 * @param {object} win - a window of a kind that can cover the dock:
 *   {rect, appId, monitorIndex, minimized, onWorkspace, showing,
 *   maximizedHorizontally, maximizedVertically, fullscreen, above}
 * @param {object} ctx - {rect (the dock's, shown), focusAppId (or null),
 *   topAppId (the app of the window on top on the dock's monitor, or
 *   null), halfMonitor (the monitor of the focused window while it is
 *   maximized only from top to bottom, else -1)}
 * @returns {boolean} whether the window covers the dock in that mode
 */
export function windowCovers(mode, win, ctx) {
    if (win.minimized || !win.onWorkspace || !win.showing || !ctx.rect || !rectsOverlap(win.rect, ctx.rect))
        return false;
    switch (mode) {
    case 'ALL_WINDOWS':
        return true;
    case 'MAXIMIZED_WINDOWS':
        return Boolean(win.maximizedHorizontally || win.maximizedVertically || win.fullscreen);
    case 'ALWAYS_ON_TOP':
        return Boolean(win.fullscreen);
    default: {
        if (!ctx.focusAppId)
            return false;
        const sideBySide = win.maximizedVertically && !win.maximizedHorizontally &&
            ctx.halfMonitor >= 0 && win.monitorIndex === ctx.halfMonitor;
        return win.appId === ctx.focusAppId || (Boolean(ctx.topAppId) && win.appId === ctx.topAppId) ||
            Boolean(win.above) || Boolean(sideBySide);
    }
    }
}
