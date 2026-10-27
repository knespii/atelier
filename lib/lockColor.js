// Colours from the wallpaper for the lock screen's type, as iOS finds the
// colours of its clock: a small copy of the wallpaper (its thumbnail at
// 96 × 60, as the lock screen samples it), the colours of the part behind
// the clock found twice – as Color Cube finds them, where the pixels are
// densest in a grid over the colour cube (a 3D histogram), and by k-means
// (lib/palette.js), which lumps a small vivid colour in with a big one –
// the two lists made one in OKLab, and tints of each, light or dark, that
// read there (APCA's Lc, lib/apca.js), the best first: the settings'
// colours from the wallpaper and the glass clock's tint. Pure functions,
// shared by the shell and the preferences.

import {apcaY, blend, contrastLc} from './apca.js';
import {extractSwatches, hexToRgb, oklabToOklch, oklchToHex, rgbToHex, rgbToOklab} from './palette.js';

/**
 * Color Cube: cells along each side of the colour cube; a colour counts
 * when this share of the pixels is in its cell and round it; colours
 * closer than this in OKLab are one.
 */
export const CUBE = {cells: 16, least: 0.01, distinct: 0.08};

/** Tints for type: as colourful as this at most, and closer than this in OKLab, one. */
export const TINT = {chroma: 0.12, distinct: 0.04};

/**
 * The pixels of a part of a sample of the wallpaper.
 *
 * @param {object} sample - {pixels, channels, rowstride, width, height}, as
 *   lib/thumbnails.js sampleWallpaper() has it
 * @param {number[]} region - [x, y, width, height] in it, 0 … 1 (any part
 *   of a pixel takes it in: even a tiny part has one)
 * @returns {number[][]} [r, g, b] of each, row by row
 */
export function regionPixels({pixels, channels, rowstride, width, height}, [x, y, w, h]) {
    const clampTo = (v, n) => Math.min(n - 1, Math.max(0, v));
    const [x1, y1] = [clampTo(Math.floor(x * width), width), clampTo(Math.floor(y * height), height)];
    const [x2, y2] = [clampTo(Math.ceil((x + w) * width) - 1, width), clampTo(Math.ceil((y + h) * height) - 1, height)];
    const found = [];
    for (let row = y1; row <= y2; row++) {
        for (let col = x1; col <= x2; col++) {
            const i = row * rowstride + col * channels;
            if (i + 2 < pixels.length)
                found.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
        }
    }
    return found;
}

/**
 * @param {number[][]} pixels - [r, g, b] of each
 * @returns {{dark: string, middle: string, light: string}|null} the colour
 *   of the pixel a tenth of the way up from the darkest (as a screen shows
 *   them: APCA's Y), half way and a tenth of the way down from the lightest;
 *   null for no pixels
 */
export function tenths(pixels) {
    const n = pixels.length;
    if (n === 0)
        return null;
    // (Their Ys sorted; of pixels as light, the one first among them in
    // the picture – as a stable sort of the pixels has them.)
    const ys = Float64Array.from(pixels, rgb => apcaY(rgb));
    const sorted = Float64Array.from(ys).sort();
    const at = share => {
        const k = Math.min(n - 1, Math.floor(share * n));
        let first = k;
        while (first > 0 && sorted[first - 1] === sorted[k])
            first--;
        for (let i = 0, skip = k - first; i < n; i++) {
            if (ys[i] === sorted[k] && skip-- === 0)
                return rgbToHex(pixels[i]);
        }
        return null;
    };
    return {dark: at(0.1), middle: at(0.5), light: at(0.9)};
}

const distance = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

/**
 * Color Cube: the pixels counted in a grid over the RGB cube, and a colour
 * wherever they are denser than in every cell round it (a local maximum):
 * each colour that covers some of the picture, however small, and not
 * their averages.
 *
 * @param {number[][]} pixels - [r, g, b] of each
 * @param {object} [options]
 * @param {number} [options.cells] - along each side of the cube
 * @param {number} [options.least] - the share of the pixels a colour has at least
 * @returns {{hex: string, lab: number[], share: number}[]} the mean colour
 *   of each maximum's cell and the share of the pixels in it and round it,
 *   the densest first
 */
export function colorCube(pixels, {cells = CUBE.cells, least = CUBE.least} = {}) {
    if (pixels.length === 0)
        return [];
    const n = cells;
    const index = (r, g, b) => (r * n + g) * n + b;
    const cellOf = v => Math.min(n - 1, Math.floor(v * n / 256));
    const counts = new Uint32Array(n ** 3);
    const sums = new Float64Array(n ** 3 * 3);
    for (const [r, g, b] of pixels) {
        const i = index(cellOf(r), cellOf(g), cellOf(b));
        counts[i]++;
        sums[3 * i] += r;
        sums[3 * i + 1] += g;
        sums[3 * i + 2] += b;
    }
    // Each cell's neighbours (and itself, for its share): those within the cube.
    const around = (r, g, b) => {
        const found = [];
        for (let dr = -1; dr <= 1; dr++) {
            for (let dg = -1; dg <= 1; dg++) {
                for (let db = -1; db <= 1; db++) {
                    const [nr, ng, nb] = [r + dr, g + dg, b + db];
                    if (nr >= 0 && ng >= 0 && nb >= 0 && nr < n && ng < n && nb < n)
                        found.push(index(nr, ng, nb));
                }
            }
        }
        return found;
    };
    const found = [];
    for (let r = 0; r < n; r++) {
        for (let g = 0; g < n; g++) {
            for (let b = 0; b < n; b++) {
                const i = index(r, g, b);
                const hits = counts[i];
                if (hits === 0)
                    continue;
                const block = around(r, g, b);
                // (Ties are maxima both: the colours close by are made one later.)
                if (block.some(j => counts[j] > hits))
                    continue;
                const share = block.reduce((sum, j) => sum + counts[j], 0) / pixels.length;
                if (share < least)
                    continue;
                const rgb = [0, 1, 2].map(c => sums[3 * i + c] / hits);
                found.push({hex: rgbToHex(rgb), lab: rgbToOklab(rgb), share});
            }
        }
    }
    return found.sort((a, b) => b.share - a.share);
}

/**
 * The colours of a part of the wallpaper: Color Cube's and k-means' (as
 * the palette has them), one list – those that look alike (in OKLab) one
 * colour: Color Cube's, the picture's own (k-means' are averages of
 * several), with the larger share.
 *
 * @param {number[][]} pixels - [r, g, b] of each
 * @param {object} [options]
 * @param {number} [options.k] - k-means' clusters
 * @param {number} [options.distinct] - how far apart in OKLab colours are, at least
 * @returns {{hex: string, lab: number[], share: number, by: string[]}[]}
 *   by: 'cube', 'k-means' or both; the most common first
 */
export function wallpaperColors(pixels, {k = 6, distinct = CUBE.distinct} = {}) {
    const cube = colorCube(pixels).map(color => ({...color, by: ['cube']}));
    const means = extractSwatches(Uint8Array.from(pixels.flat()), {k})
        .map(({hex, lab, share}) => ({hex, lab, share, by: ['k-means']}));
    const colors = [];
    for (const color of [...cube, ...means]) {
        const same = colors.find(kept => distance(kept.lab, color.lab) < distinct);
        if (!same) {
            colors.push(color);
            continue;
        }
        same.share = Math.max(same.share, color.share);
        if (!same.by.includes(color.by[0]))
            same.by = [...same.by, ...color.by];
    }
    return colors.sort((a, b) => b.share - a.share);
}

// A tint of a hue for type on a colour: from a colourful one towards white
// (or black) until it reads there, or as far as it goes.
function readableTint(hue, chroma, dark, behind, need) {
    const c = Math.min(chroma, TINT.chroma);
    const [from, to] = dark ? [0.45, 0.08] : [0.8, 1];
    const steps = Math.round(Math.abs(to - from) / 0.01);
    let tint = null;
    for (let step = 0; step <= steps; step++) {
        const color = oklchToHex([from + (to - from) * step / steps, c, hue]);
        // (In its own polarity: light type lighter than what is behind it.)
        const lc = Math.max(0, dark ? contrastLc(color, behind) : -contrastLc(color, behind));
        tint = {color, dark, lc};
        if (lc >= need)
            break;
    }
    return {...tint, reaches: tint.lc >= need};
}

/**
 * Colours for type on a part of the wallpaper, from the wallpaper's own: a
 * light and a dark tint of each (its hue, as colourful as type may be),
 * light type checked on the part's lighter tenth, dark type on its darker
 * one; the more common and colourful first, light before dark (as an
 * iPhone's lock screen has it). Only those that read, unless none does:
 * then the nearest to it.
 *
 * @param {number[][]} pixels - [r, g, b] of the part behind the type
 * @param {object} options
 * @param {number} options.need - the |Lc| the type needs (lib/apca.js
 *   minimumLc() of its size and weight)
 * @param {number} [options.dim] - how much of the wallpaper's light is left
 *   at most while the prompt is up: dark type must read then too
 * @param {number} [options.count] - how many at most
 * @param {number[][]} [options.from] - the pixels whose colours are tinted
 *   (the part's own, unless more of the wallpaper's are wanted)
 * @returns {{color: string, dark: boolean, lc: number, reaches: boolean, source: string, share: number}[]}
 *   each tint, its |Lc| there, whether that is enough, and the wallpaper's
 *   colour it is of
 */
export function typeColors(pixels, {need, dim = 1, count = 6, from = pixels}) {
    const behind = tenths(pixels);
    if (!behind)
        return [];
    const darkBehind = blend('#000000', 1 - dim, behind.dark);
    const tints = [];
    for (const {hex, lab, share} of wallpaperColors(from)) {
        const [, chroma, hue] = oklabToOklch(lab);
        for (const dark of [false, true]) {
            const tint = readableTint(hue, chroma, dark, dark ? darkBehind : behind.light, need);
            const tintLab = rgbToOklab(hexToRgb(tint.color));
            const score = Math.sqrt(share) * (0.02 + oklabToOklch(tintLab)[1]) * (dark ? 0.85 : 1);
            tints.push({...tint, lab: tintLab, source: hex, share, score});
        }
    }
    const reading = tints.filter(tint => tint.reaches);
    const ranked = reading.length > 0 ? reading.sort((a, b) => b.score - a.score) : tints.sort((a, b) => b.lc - a.lc);
    const chosen = [];
    for (const tint of ranked) {
        if (chosen.some(other => distance(other.lab, tint.lab) < TINT.distinct))
            continue;
        chosen.push(tint);
        if (chosen.length >= count)
            break;
    }
    return chosen.map(({color, dark, lc, reaches, source, share}) => ({color, dark, lc, reaches, source, share}));
}

/**
 * typeColors() of the part of a sample behind the clock.
 *
 * @param {object} sample - as for regionPixels()
 * @param {number[]} region - [x, y, width, height] in it, 0 … 1
 * @param {object} options - as for typeColors(); from, a region of the
 *   sample whose colours are tinted ([0, 0, 1, 1]: the whole wallpaper's;
 *   none: the clock's part's own)
 * @returns {object[]} as typeColors()
 */
export function clockColors(sample, region, {from = null, ...options}) {
    const pixels = regionPixels(sample, region);
    return typeColors(pixels, {...options, from: from ? regionPixels(sample, from) : pixels});
}
