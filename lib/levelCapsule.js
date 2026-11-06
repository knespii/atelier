// A level as iOS's Control Center shows brightness and volume: a tall
// capsule filled from the bottom as far as the level goes, its icon low
// in it – dark once the fill is under it, light on the glass – no knob.
// Pressed or dragged: as far up as the pointer (past the ends it
// stretches, a rubber), scrolled, or stepped with the keys.
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
 * Where the pointer is, as a level: the spec's mapping. Above the top it
 * is over 100 %, below the bottom under 0 – by how much is `over`, which
 * stretches the capsule (stretchOf()).
 *
 * @param {number} y - the pointer, in the same coordinates as top, bottom
 * @param {number} top - the capsule's top, as it was pressed (unscaled)
 * @param {number} bottom - its bottom
 * @returns {{raw: number, value: number, over: number}} raw: percent, any;
 *   value: whole percent, 0 … 100; over: percent past 100 (+) or under 0 (−)
 */
export function pointerLevel(y, top, bottom) {
    const height = bottom - top;
    const raw = height > 0 && Number.isFinite(y) ? (bottom - y) / height * 100 : 0;
    const value = Math.round(Math.min(100, Math.max(0, raw)));
    const over = raw > 100 ? raw - 100 : raw < 0 ? raw : 0;
    // (Never −0.)
    return {raw, value: value || 0, over: over || 0};
}

// How far a capsule stretches past its end at most, and how soon.
export const STRETCH = 0.09;
const STRETCH_SOFTNESS = 25;

/**
 * Rubber past an end: grows fast at first, never past STRETCH.
 *
 * @param {number} over - percent past the end (either way)
 * @returns {number} the scale along its height, 1 … 1 + STRETCH
 */
export function stretchOf(over) {
    return 1 + STRETCH * (1 - Math.exp(-Math.abs(over || 0) / STRETCH_SOFTNESS));
}

/**
 * Which edge stays put as it stretches: the one away from the pointer.
 *
 * @param {number} over
 * @param {string} previous - 'bottom' or 'top' (kept while not over)
 * @returns {string}
 */
export function originOf(over, previous = 'bottom') {
    return over > 0 ? 'bottom' : over < 0 ? 'top' : previous;
}

/**
 * Whether the icon bumps: the level reached an end just now.
 *
 * @param {number} value - whole percent
 * @param {number|null} previous - before
 * @returns {boolean}
 */
export function bumps(value, previous) {
    return (value === 0 || value === 100) && value !== previous;
}

// The bump: up to so much, so far through it.
export const BUMP_SCALE = 1.3;
const BUMP_PEAK = 0.4;

/**
 * The icon's scale through its bump (a keyframe: 1, up at 40 %, 1).
 *
 * @param {number} t - 0 … 1 through it
 * @param {function(number): number} ease - each half's curve
 * @returns {number}
 */
export function bumpScale(t, ease) {
    if (!(t > 0) || t >= 1)
        return 1;
    if (t < BUMP_PEAK)
        return 1 + (BUMP_SCALE - 1) * ease(t / BUMP_PEAK);
    return BUMP_SCALE - (BUMP_SCALE - 1) * ease((t - BUMP_PEAK) / (1 - BUMP_PEAK));
}

/**
 * @param {number} level - 0 … 1
 * @returns {boolean} whether the fill covers the icon (it goes dark)
 */
export function iconCovered(level) {
    return level > 0.17;
}

/**
 * The sun's rays for a brightness: turned with it, and grown.
 *
 * @param {number} percent - 0 … 100
 * @returns {{angle: number, scale: number}} degrees, scale
 */
export function sunRays(percent) {
    const p = Math.min(100, Math.max(0, percent || 0));
    return {angle: p * 0.9, scale: 0.6 + 0.4 * p / 100};
}

/**
 * The speaker's parts for a volume: a wave, two, or muted.
 *
 * @param {number} percent - 0 … 100
 * @returns {{wave1: boolean, wave2: boolean, cross: boolean}}
 */
export function speakerParts(percent) {
    return {wave1: percent > 0, wave2: percent > 50, cross: !(percent > 0)};
}

/**
 * How long until a value may be sent again (to GNOME, ~30 times a second).
 *
 * @param {number} now - ms
 * @param {number|null} last - when the last went, ms (null: none yet)
 * @param {number} [interval] - ms
 * @returns {number} ms to wait: 0, now
 */
export function sendDelay(now, last, interval = 1000 / 30) {
    if (last === null || !Number.isFinite(last))
        return 0;
    return Math.max(0, last + interval - now);
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
