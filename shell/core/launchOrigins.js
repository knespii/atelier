// Where an app was launched from, for the window it opens: the dock says
// so as it launches one, and the window's opening (shell/windows/) asks for
// it as the window comes. A launch counts for a while only, and once.

import GLib from 'gi://GLib';

// How long a launch waits for its window, microseconds.
const WAIT = 10 * 1000 * 1000;

const launches = new Map(); // app id → {rect, side, time}

/**
 * @param {string} appId
 * @param {object} rect - the icon it was launched from, on the stage
 * @param {string} side - the edge of the dock: 'BOTTOM', 'TOP', 'LEFT', 'RIGHT'
 */
export function noteLaunch(appId, rect, side) {
    launches.set(appId, {rect, side, time: GLib.get_monotonic_time()});
}

/**
 * @param {string|null} appId - of a window that comes
 * @returns {object|null} {rect, side}: where it was launched from, or null
 */
export function takeLaunch(appId) {
    const launch = appId ? launches.get(appId) : null;
    if (!launch)
        return null;
    launches.delete(appId);
    return GLib.get_monotonic_time() - launch.time < WAIT ? launch : null;
}
