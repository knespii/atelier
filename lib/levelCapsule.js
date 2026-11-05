// A level as iOS's Control Center shows brightness and volume: a tall
// capsule filled from the bottom as far as the level goes, its icon low
// in it – dark where the fill is under it, light where the glass is – no
// knob. Dragged up or down (by as much as the finger moves, from where it
// was), clicked where it should be, scrolled, or stepped with the keys.
// Pure, for the unit tests (shell/controlCentre/capsule.js draws it).

// Keys: so much of the range a step (Up, Down), so much a page.
export const STEP = 0.05;
export const PAGE = 0.2;

const clamp = value => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/**
 * @param {number} value - a slider's
 * @param {number} [maximum] - its greatest (more than 1 where the volume
 *   may go over 100 %)
 * @returns {number} how full the capsule is, 0 … 1
 */
export function levelOf(value, maximum = 1) {
    return maximum > 0 ? clamp(value / maximum) : 0;
}

/**
 * @param {number} level - 0 … 1
 * @param {number} [maximum]
 * @returns {number} the slider's value for it
 */
export function valueOf(level, maximum = 1) {
    return clamp(level) * Math.max(0, maximum);
}

/**
 * Dragged: the level from where it was, as far as the pointer moved (up
 * fills), a capsule's height being all of it.
 *
 * @param {number} start - the level as the drag began
 * @param {number} dy - how far the pointer moved down since, pixels
 * @param {number} height - the capsule's
 * @returns {number}
 */
export function dragLevel(start, dy, height) {
    return height > 0 ? clamp(start - dy / height) : clamp(start);
}

/**
 * Clicked: the level where the click is.
 *
 * @param {number} y - from the capsule's top, pixels
 * @param {number} height
 * @returns {number}
 */
export function levelAt(y, height) {
    return height > 0 ? clamp(1 - y / height) : 0;
}

/**
 * @param {number} level - 0 … 1
 * @param {number} step - STEP or PAGE, up (+) or down (−); ±Infinity: to the end
 * @returns {number} the level a key takes it to
 */
export function stepped(level, step) {
    // (On the steps' grid: from 0.53 up to 0.55, not 0.58.)
    const steps = Math.abs(step);
    if (!Number.isFinite(steps))
        return step > 0 ? 1 : 0;
    const at = clamp(level) / steps;
    const next = step > 0 ? Math.floor(at + 1e-6) + 1 : Math.ceil(at - 1e-6) - 1;
    return clamp(next * steps);
}

/**
 * Where the fill's top edge is.
 *
 * @param {number} level
 * @param {number} height - the capsule's
 * @returns {number} pixels from its top
 */
export function fillTop(level, height) {
    return Math.round(Math.max(0, height) * (1 - clamp(level)));
}

/**
 * How an icon in the capsule is split by the fill: its part over the
 * glass (above the fill's top) and its part on the fill, each a clip in
 * the icon's own pixels ({y, height}; height 0: none of it).
 *
 * @param {number} top - fillTop(), from the capsule's top
 * @param {number} y - the icon's top, from the capsule's top
 * @param {number} height - the icon's
 * @returns {{glass: {y: number, height: number}, fill: {y: number, height: number}}}
 */
export function splitAt(top, y, height) {
    const cut = Math.min(height, Math.max(0, top - y));
    return {glass: {y: 0, height: cut}, fill: {y: cut, height: height - cut}};
}
