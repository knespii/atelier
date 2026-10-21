// Time for animations that should play in full on the frames that come.
// Clutter's timelines go by the clock: when the shell stops for a moment
// (as GNOME turns its other extensions on, just unlocked), the frame after
// the gap gets all of it, and an animation jumps to its end. Counted here,
// a frame on time counts as long as it took, a late one as one frame only.
// Pure, shared by the shell and the tests.

/** How many frames' time a frame may take and still be on time. */
export const ON_TIME = 2.5;

/**
 * @param {number} delta - ms since the frame before
 * @param {number} interval - ms between frames on time (the refresh rate's)
 * @returns {boolean} whether the frame came on time (the shell was not stopped)
 */
export function onTime(delta, interval) {
    return delta <= ON_TIME * interval;
}

/**
 * @param {number} delta - ms since the frame before
 * @param {number} interval - ms between frames on time
 * @returns {number} how much of it an animation counts, ms
 */
export function steadyDelta(delta, interval) {
    if (!(interval > 0))
        return delta;
    return onTime(delta, interval) ? delta : interval;
}

/** Clutter's easing curves the animations use, from 0 … 1 to 0 … 1. */
export const Curve = {
    linear: t => t,
    easeOutCubic: t => 1 - (1 - t) ** 3,
    easeInCubic: t => t ** 3,
    easeInOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
};
