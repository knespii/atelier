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
