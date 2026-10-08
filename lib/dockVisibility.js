// Whether a dock should be away, from what is going on, and whether a
// window covers it in each intellihide mode. Pure functions, shared by the
// shell and the tests.
//
// (For now they say nothing is ever in the way.)

/**
 * @param {object} _state - what is going on: {overview, intellihide,
 *   autohide, manualhide, fixed, overlapped, forced, hover, revealed,
 *   pointerInZone, urgent, fullscreen}
 * @returns {boolean} whether the dock should be away
 */
export function shouldHide(_state) {
    return false;
}

/**
 * @param {string} _mode - an intellihide mode: 'ALL_WINDOWS',
 *   'FOCUS_APPLICATION_WINDOWS', 'MAXIMIZED_WINDOWS' or 'ALWAYS_ON_TOP'
 * @param {object} _win - the window: {rect, type, minimized, maximized,
 *   above, onWorkspace, showing, appId, monitorIndex}
 * @param {object} _ctx - {rect (the dock's, shown), focusAppId,
 *   monitorIndex}
 * @returns {boolean} whether the window covers the dock in that mode
 */
export function windowCovers(_mode, _win, _ctx) {
    return false;
}
