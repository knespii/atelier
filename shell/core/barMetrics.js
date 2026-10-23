// Sizes shared by the island and the capsules of the top bar, so they line up.

// Height of a capsule, logical pixels: the bar's height minus a margin,
// within these bounds.
const MARGIN = 3;
const MIN_HEIGHT = 20;
const MAX_HEIGHT = 28;

/**
 * @param {number} barHeight - in pixels
 * @param {number} scale - the UI scale factor
 * @returns {number} height of the island at rest and of the capsules, in pixels
 */
export function capsuleHeight(barHeight, scale) {
    return Math.round(Math.max(MIN_HEIGHT * scale, Math.min(MAX_HEIGHT * scale, barHeight - 2 * MARGIN * scale)));
}

/** Radius of the bottom corners of a notch at rest, logical pixels. */
export const NOTCH_RADIUS = 14;

/** Radius of a notch's ears, where it curves into the top edge. */
export const EAR_RADIUS = 9;

/**
 * How long the bar and the island take to come out of the top edge after
 * the lock screen's padlock has gone back up, ms.
 */
export const COME_OUT_TIME = 380;
