// A dock's background beyond the stylesheet: the inline style for each
// transparency mode, how opaque it is near windows and away from them,
// and what counts as near. Pure functions, shared by the shell and the
// tests.
//
// DEFAULT is the stylesheet's look: no inline style (dark, or clear over
// glass). FIXED and DYNAMIC give the background a colour (Atelier's dark
// one unless another is chosen) at an opacity; over glass that colour is
// a wash on the blur, so at 0 the dock is just glass.

import {rectsOverlap} from './dockGeometry.js';

/** The dock's own dark (the stylesheet's rgba(18, 18, 22, …)). */
export const DEFAULT_COLOR = '#121216';

// Dash to Dock's opacities away from windows and near them, when not
// customized (its stylesheet's .dummy-transparent and .dummy-opaque).
export const DEFAULT_ALPHAS = {min: 0.2, max: 0.8};

const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
// (Two decimals: what the eye can tell apart, and steady strings.)
const round = value => Math.round(value * 100) / 100;

/**
 * @param {string|null} color - '#rrggbb' or '#rgb'
 * @returns {number[]|null} [red, green, blue], 0–255, or null when it
 *   isn't one
 */
export function parseColor(color) {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color ?? '');
    if (!match)
        return null;
    let hex = match[1];
    if (hex.length === 3)
        hex = [...hex].map(c => c + c).join('');
    return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
}

/**
 * @param {object} params
 * @param {string} params.mode - 'DEFAULT', 'FIXED' or 'DYNAMIC'
 *   (atelier.DockTransparency)
 * @param {number} [params.opacity] - for FIXED, 0–1
 * @param {number} [params.alpha] - for DYNAMIC: the opacity now, 0–1
 * @param {string|null} [params.color] - '#rrggbb', or null for the dock's
 *   own dark
 * @param {boolean} [params.glass] - the dock is of glass (the style is the
 *   same: the colour is a wash on the blur; the stylesheet keeps the
 *   shadow off)
 * @returns {string} the inline style for the dock's shape ('' for none)
 */
export function backgroundCss({mode, opacity = 0.8, alpha = opacity, color = null}) {
    if (mode !== 'FIXED' && mode !== 'DYNAMIC')
        return '';
    const [red, green, blue] = parseColor(color) ?? parseColor(DEFAULT_COLOR);
    const value = round(clamp01(mode === 'FIXED' ? opacity : alpha));
    return `background-color: rgba(${red}, ${green}, ${blue}, ${value});`;
}

/**
 * @param {boolean} near - a window is near the dock
 * @param {number} min - opacity away from windows
 * @param {number} max - near them
 * @returns {number} the opacity, 0–1
 */
export function dynamicAlpha(near, min, max) {
    return clamp01(near ? max : min);
}

/**
 * @param {object} params
 * @param {boolean} params.customize - the user's own opacities
 * @param {number} params.min - theirs away from windows
 * @param {number} params.max - theirs near them
 * @returns {object} {min, max}: the opacities DYNAMIC goes between
 */
export function dynamicAlphas({customize, min, max}) {
    return customize ? {min: clamp01(min), max: clamp01(max)} : {...DEFAULT_ALPHAS};
}

/**
 * @param {object} rect - {x, y, width, height}
 * @param {number} by - pixels added on every side
 * @returns {object} the rectangle, grown
 */
export function grownRect(rect, by) {
    return {x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by};
}

/**
 * @param {object|null} dockRect - where the dock is when shown
 * @param {object[]} frames - the windows that count (on its monitor and
 *   workspace, showing), their frame rectangles
 * @param {number} reach - how close counts as near, pixels
 * @returns {boolean} whether a window is over the dock or close to it
 */
export function windowNear(dockRect, frames, reach) {
    if (!dockRect)
        return false;
    const zone = grownRect(dockRect, reach);
    return frames.some(frame => rectsOverlap(zone, frame));
}
