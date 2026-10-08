// A dock's background beyond the stylesheet: the inline style for each
// transparency mode, and how opaque it is near windows. Pure functions,
// shared by the shell and the tests.
//
// (For now the stylesheet's look: no inline style.)

/**
 * @param {object} _params - {mode (from atelier.DockTransparency),
 *   opacity, alpha (now, for DYNAMIC), color ('#rrggbb' or null for the
 *   theme's), glass}
 * @returns {string} the inline style for the dock's shape ('' for none)
 */
export function backgroundCss(_params) {
    return '';
}

/**
 * @param {boolean} near - a window is near the dock
 * @param {number} min - opacity away from windows
 * @param {number} max - near them
 * @returns {number} the opacity
 */
export function dynamicAlpha(near, min, max) {
    return near ? max : min;
}
