// APCA, the Accessible Perceptual Contrast Algorithm: how much text stands
// out from what is behind it as people see it on a screen – Lc, lightness
// contrast, about 0 … 106 for dark text on light and 0 … -108 for light
// text on dark (the two are seen differently, so they are scored apart) –
// and how much of it text of a size and a weight needs. As APCA-W3 0.1.9
// has it (github.com/Myndex/apca-w3, src/apca-w3.js), with the constants of
// APCA 0.0.98G-4g, which every version since keeps. Colours are '#rrggbb'
// or [r, g, b] in 0 … 255. Pure functions, shared by the shell and the
// preferences.

import {hexToRgb, rgbToHex} from './palette.js';

/**
 * APCA 0.0.98G-4g's constants, by the names APCA-W3 gives them (its SA98G):
 * the screen's own simple exponent and the sRGB coefficients for its
 * luminance Y; the exponents for normal polarity (dark text on light) and
 * reverse (light on dark); the soft clamp of near-black; the scale, the
 * offsets and the low clip of Lc; and the least difference in Y that counts.
 */
export const APCA = Object.freeze({
    mainTRC: 2.4,
    sRco: 0.2126729,
    sGco: 0.7151522,
    sBco: 0.0721750,
    normBG: 0.56,
    normTXT: 0.57,
    revTXT: 0.62,
    revBG: 0.65,
    blkThrs: 0.022,
    blkClmp: 1.414,
    scaleBoW: 1.14,
    scaleWoB: 1.14,
    loBoWoffset: 0.027,
    loWoBoffset: 0.027,
    deltaYmin: 0.0005,
    loClip: 0.1,
});

const rgbOf = color => (typeof color === 'string' ? hexToRgb(color) : color);

// Each channel's power, worked out once for its 256 whole values (a
// picture's pixels: many at a time).
const POWERS = Float64Array.from({length: 256}, (_, c) => (c / 255.0) ** APCA.mainTRC);
const simpleExp = channel => (Number.isInteger(channel) && channel >= 0 && channel <= 255 ? POWERS[channel]
    : (channel / 255.0) ** APCA.mainTRC);

/**
 * @param {string|number[]} color
 * @returns {number} its luminance on a screen as APCA has it (its sRGBtoY():
 *   a plain 2.4 exponent, not sRGB's piecewise curve), 0 … 1
 */
export function apcaY(color) {
    const {sRco, sGco, sBco} = APCA;
    const [r, g, b] = rgbOf(color);
    return sRco * simpleExp(r) + sGco * simpleExp(g) + sBco * simpleExp(b);
}

/**
 * APCA's APCAcontrast().
 *
 * @param {number} textY - apcaY() of the text
 * @param {number} backgroundY - of what is behind it
 * @returns {number} Lc: positive for dark text on light, negative for light
 *   text on dark, 0 where it is too low to count (or the input is not Y)
 */
export function apcaContrast(textY, backgroundY) {
    const {blkThrs, blkClmp, deltaYmin, normBG, normTXT, revBG, revTXT, scaleBoW, scaleWoB, loClip,
        loBoWoffset, loWoBoffset} = APCA;
    if (!Number.isFinite(textY) || !Number.isFinite(backgroundY) ||
        Math.min(textY, backgroundY) < 0 || Math.max(textY, backgroundY) > 1.1)
        return 0;
    // (Near black, softly clamped: a screen's black is not black.)
    const clamp = y => (y > blkThrs ? y : y + (blkThrs - y) ** blkClmp);
    const [text, background] = [clamp(textY), clamp(backgroundY)];
    if (Math.abs(background - text) < deltaYmin)
        return 0;
    if (background > text) {
        const sapc = (background ** normBG - text ** normTXT) * scaleBoW;
        return (sapc < loClip ? 0 : sapc - loBoWoffset) * 100;
    }
    const sapc = (background ** revBG - text ** revTXT) * scaleWoB;
    return (sapc > -loClip ? 0 : sapc + loWoBoffset) * 100;
}

/**
 * @param {string|number[]} text - its colour
 * @param {string|number[]} background - the colour behind it
 * @returns {number} their Lc, as apcaContrast()
 */
export function contrastLc(text, background) {
    return apcaContrast(apcaY(text), apcaY(background));
}

/**
 * A colour laid over another with some alpha, as the screen lays it: in
 * sRGB as it is stored (no linear light), to whole values (APCA-W3's
 * alphaBlend()). How translucent type looks over the wallpaper.
 *
 * @param {string|number[]} color - what is laid over
 * @param {number} alpha - how much of it shows, 0 … 1
 * @param {string|number[]} behind
 * @returns {string} '#rrggbb'
 */
export function blend(color, alpha, behind) {
    const a = Math.min(1, Math.max(0, alpha));
    const [over, under] = [rgbOf(color), rgbOf(behind)];
    return rgbToHex(over.map((v, i) => under[i] * (1 - a) + v * a));
}

/**
 * APCA-W3's font lookup, the one its fontLookupAPCA() interpolates
 * (fontMatrixAscend in src/apca-w3.js 0.1.9; the same as fontMatrixG in
 * data/LUT-GseriesMay28-2022.js, the G series of May 2022, for APCA
 * 0.0.98G-4g). A row per Lc, 0 … 125 by fives: the Lc, then the least
 * font size, in CSS pixels, that reads at it in each weight, 100 … 900.
 * 999: too low a contrast for anything; 777: for non-text and spot text
 * only. (APCA's by-size table, byFontSize in the same file, is a coarser,
 * rounded picture of this one.)
 */
export const FONT_LOOKUP = Object.freeze([
    [0, 999, 999, 999, 999, 999, 999, 999, 999, 999],
    [10, 999, 999, 999, 999, 999, 999, 999, 999, 999],
    [15, 777, 777, 777, 777, 777, 777, 777, 777, 777],
    [20, 777, 777, 777, 777, 777, 777, 777, 777, 777],
    [25, 777, 777, 777, 120, 120, 108, 96, 96, 96],
    [30, 777, 777, 120, 108, 108, 96, 72, 72, 72],
    [35, 777, 120, 108, 96, 72, 60, 48, 48, 48],
    [40, 120, 108, 96, 60, 48, 42, 32, 32, 32],
    [45, 108, 96, 72, 42, 32, 28, 24, 24, 24],
    [50, 96, 72, 60, 32, 28, 24, 21, 21, 21],
    [55, 80, 60, 48, 28, 24, 21, 18, 18, 18],
    [60, 72, 48, 42, 24, 21, 18, 16, 16, 18],
    [65, 68, 46, 32, 21.75, 19, 17, 15, 16, 18],
    [70, 64, 44, 28, 19.5, 18, 16, 14.5, 16, 18],
    [75, 60, 42, 24, 18, 16, 15, 14, 16, 18],
    [80, 56, 38.25, 23, 17.25, 15.81, 14.81, 14, 16, 18],
    [85, 52, 34.5, 22, 16.5, 15.625, 14.625, 14, 16, 18],
    [90, 48, 32, 21, 16, 15.5, 14.5, 14, 16, 18],
    [95, 45, 28, 19.5, 15.5, 15, 14, 13.5, 16, 18],
    [100, 42, 26.5, 18.5, 15, 14.5, 13.5, 13, 16, 18],
    [105, 39, 25, 18, 14.5, 14, 13, 12, 16, 18],
    [110, 36, 24, 18, 14, 13, 12, 11, 16, 18],
    [115, 34.5, 22.5, 17.25, 12.5, 11.875, 11.25, 10.625, 14.5, 16.5],
    [120, 33, 21, 16.5, 11, 10.75, 10.5, 10.25, 13, 15],
    [125, 32, 20, 16, 10, 10, 10, 10, 12, 14],
].map(row => Object.freeze(row)));

// (777 and 999: no size reads at that Lc.)
const NOT_TEXT = 777;

// The least Lc type of a size needs in one of the table's weights: the
// lookup read the other way – between two rows, as far from the one as
// fontLookupAPCA() would put the size; larger than the table's largest
// size for a weight, its lowest Lc for text (no less).
function columnLc(column, size) {
    let before = null;
    for (const row of FONT_LOOKUP) {
        const least = row[column];
        if (least >= NOT_TEXT)
            continue;
        if (least <= size) {
            return before
                ? before.lc + (row[0] - before.lc) * (before.least - size) / (before.least - least)
                : row[0];
        }
        before = {lc: row[0], least};
    }
    return Infinity;
}

/**
 * @param {number} size - the type's size in CSS pixels (pt × 4/3)
 * @param {number} weight - its weight, 100 … 900 (wght; between the
 *   table's weights, between their needs)
 * @returns {number} the least |Lc| it reads at (APCA's font lookup), or
 *   Infinity when no contrast is enough for it to read as text
 */
export function minimumLc(size, weight) {
    if (!(size > 0))
        return Infinity;
    const at = Math.min(9, Math.max(1, (weight || 400) / 100));
    const [lower, upper] = [Math.floor(at), Math.ceil(at)];
    const low = columnLc(lower, size);
    if (upper === lower)
        return low;
    const high = columnLc(upper, size);
    if (!Number.isFinite(low) || !Number.isFinite(high))
        return Infinity;
    return low + (high - low) * (at - lower);
}
