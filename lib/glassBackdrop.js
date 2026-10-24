// The glass clock's Liquid Glass (shell/lockscreen/liquidGlass.js), its
// sums: the backdrop – the wallpaper as GNOME draws it on the lock screen's
// monitor, frosted (blurred, its colours richer and brighter, as Atelier's
// glass has them: lib/glassLook.js), and small: blurred that much, a
// monitor a fifth as wide and as high is as good as all of it – where a
// part of the monitor falls in it, how the glass bends it at the glyphs'
// edges, the light its edges catch, its sheen and grain, and the glass's
// tint, taken from the tone and from what is behind it. Pure functions
// (GLib only for a checksum), shared by the shell and the tools.

import GLib from 'gi://GLib';

import {lookOf} from './glassLook.js';
import {hexToOklch, hexToRgb, oklchToHex, rgbToHex} from './palette.js';

/**
 * How the glass frosts what is behind it: the blur's sigma (logical
 * pixels: GNOME's blur radius is twice it, so about 28 here). How much
 * richer and brighter it comes out is the look's (frostOf()) – and the
 * glow: the clock is type made of glass, with nothing on it to read but
 * itself, so the light comes through it brighter than through glass that
 * type lies on (as bright as the clock had it before all of Atelier's
 * glass shared one look).
 */
export const FROST = {sigma: 14, glow: 0.55};

/**
 * @param {object|null} look - lib/glassLook.js lookOf()'s; null: none (as
 *   the picture is)
 * @returns {{sigma: number, saturation: number, lift: number}} how the
 *   backdrop is frosted for it: blurred by the sigma (logical pixels), its
 *   colours pushed away from their grey `saturation` times, and the light
 *   coming through 1 + lift times as bright (as far as its colour lets it
 *   be brighter: its hue stays, where a white veil alone would wash it
 *   grey) – the look's brightness and the glow (FROST)
 */
export function frostOf(look) {
    if (!look)
        return {sigma: FROST.sigma, saturation: 1, lift: 0};
    return {sigma: FROST.sigma, saturation: look.saturation, lift: Math.max(0, look.brightness - 1) + FROST.glow};
}

/**
 * Raised whenever the backdrop is made otherwise, so the old ones are made
 * anew.
 */
export const BACKDROP_VERSION = 2;

// The backdrop's pixels per sigma: blurred by three of them, it is as
// smooth drawn four or five times larger as a sharp one would be.
const SIGMA_PIXELS = 3;

/**
 * The glass's tint, lighter at the top (where light falls on it) than at
 * the bottom: of the tint's alpha, at the top and at the bottom.
 */
export const TINT_GRADIENT = [1.18, 0.82];

/**
 * How much of the light dark glass lets through (of the backdrop's: the
 * frost as light glass lets it through).
 */
export const DIM = 0.42;

/**
 * The glass at rest: how much of its tint covers the frosted wallpaper,
 * and how much the membrane (the frosted wallpaper and the tint) covers
 * the sharp one (the "material alpha" a contrast plan raises).
 */
export const GLASS = {tintAlpha: 0.34, opacity: 0.86};

/**
 * How much of the glass's tint shows over what is behind it, where least
 * (at the digits' feet, the membrane's own transparency counted): glass
 * type's `glass` as lib/lockLook.js legibilityPlan() takes it.
 *
 * @param {object} [material] - {tintAlpha, opacity}; the glass at rest
 * @returns {number} 0 … 1
 */
export function tintShown({tintAlpha = GLASS.tintAlpha, opacity = GLASS.opacity} = {}) {
    return Math.min(1, tintAlpha * TINT_GRADIENT[1]) * opacity;
}

/**
 * The glass that shows this much of its tint (legibilityPlan()'s `glass`,
 * as much as it takes to read): less transparent first – all of the frost
 * and the tint – then more of the tint, as Apple's lock screen makes its
 * glass more opaque. Never less than at rest.
 *
 * @param {number|null} shown - see tintShown(); null: the glass at rest
 * @returns {{tintAlpha: number, opacity: number}}
 */
export function glassFor(shown) {
    const opaque = tintShown({...GLASS, opacity: 1});
    if (!(shown > tintShown()))
        return {...GLASS};
    if (shown <= opaque)
        return {tintAlpha: GLASS.tintAlpha, opacity: shown / opaque};
    return {tintAlpha: Math.min(1, shown) / TINT_GRADIENT[1], opacity: 1};
}

// The tint takes on the colour of what is behind it, this much at most
// (OKLCH chroma): a hint of it, never a colour of its own.
const TINT_CHROMA = 0.035;

/**
 * The backdrop's size: the monitor, small enough that the blur is a few of
 * its pixels (never larger than the monitor).
 *
 * @param {number[]} monitor - [width, height], pixels
 * @param {number} [scale] - the shell's scale factor (the sigma is logical)
 * @param {number} [sigma] - the blur's, logical pixels
 * @returns {{width: number, height: number, factor: number[], sigma: number}}
 *   its pixels; [x, y] of them a monitor pixel is; the blur's sigma in them
 */
export function backdropSize([width, height], scale = 1, sigma = FROST.sigma) {
    const wanted = Math.min(1, SIGMA_PIXELS / Math.max(1e-6, sigma * scale));
    const [w, h] = [Math.max(1, Math.round(width * wanted)), Math.max(1, Math.round(height * wanted))];
    const factor = [w / width, h / height];
    return {width: w, height: h, factor, sigma: sigma * scale * (factor[0] + factor[1]) / 2};
}

/**
 * How to lay a picture into the backdrop with GdkPixbuf's composite(): the
 * part of the backdrop it covers (whole pixels), its offset and its scale.
 *
 * @param {object} shown - where GNOME draws the picture on the monitor:
 *   {x, y, width, height} (lib/depth.js placement())
 * @param {number[]} factor - the backdrop's pixels per monitor pixel
 * @param {number[]} size - [width, height] of the backdrop
 * @param {number[]} picture - [width, height] of the picture as decoded
 * @returns {object|null} {x, y, width, height, offsetX, offsetY, scaleX,
 *   scaleY, shift}; null if none of it is in the backdrop. GdkPixbuf lays
 *   a picture at whole pixels (it rounds the offset): the offset is whole,
 *   and shift ([x, y], backdrop pixels) is how far that moves the picture
 *   from where it belongs – the backdrop is drawn that much the other way.
 */
export function pictureArea(shown, [fx, fy], [width, height], [pw, ph]) {
    if (!(shown?.width > 0 && shown.height > 0 && pw > 0 && ph > 0))
        return null;
    const [left, top] = [shown.x * fx, shown.y * fy];
    const [offsetX, offsetY] = [Math.round(left), Math.round(top)];
    const x = Math.max(0, offsetX);
    const y = Math.max(0, offsetY);
    const x2 = Math.min(width, Math.round(offsetX + shown.width * fx));
    const y2 = Math.min(height, Math.round(offsetY + shown.height * fy));
    if (x2 <= x || y2 <= y)
        return null;
    return {
        x, y, width: x2 - x, height: y2 - y,
        offsetX, offsetY,
        scaleX: shown.width * fx / pw, scaleY: shown.height * fy / ph,
        shift: [offsetX - left, offsetY - top],
    };
}

/**
 * @param {string} value - a colour as GNOME keeps it in its settings:
 *   '#rgb', '#rrggbb' or '#rrrrggggbbbb'
 * @returns {number[]} [r, g, b], 0 … 255; black for anything else
 */
export function parseColor(value) {
    const digits = /^#([0-9a-f]+)$/i.exec(value?.trim() ?? '')?.[1] ?? '';
    const per = {3: 1, 6: 2, 12: 4}[digits.length];
    if (!per)
        return [0, 0, 0];
    const max = 16 ** per - 1;
    return [0, 1, 2].map(i => Math.round(parseInt(digits.slice(i * per, (i + 1) * per), 16) * 255 / max));
}

/**
 * What GNOME draws where the picture doesn't cover the monitor (scaled or
 * centered): its colour, or a gradient of two.
 *
 * @param {number} width - of the backdrop
 * @param {number} height
 * @param {object} colors
 * @param {string} colors.primary - org.gnome.desktop.background's primary-color
 * @param {string} [colors.secondary] - and secondary-color
 * @param {string} [colors.shading] - and color-shading-type: solid,
 *   vertical (top to bottom) or horizontal (left to right)
 * @returns {Uint8Array} RGB pixels, width × 3 bytes a row
 */
export function backgroundPixels(width, height, {primary, secondary = primary, shading = 'solid'}) {
    const [from, to] = [parseColor(primary), parseColor(secondary)];
    const pixels = new Uint8Array(width * height * 3);
    const along = shading === 'vertical' ? height : shading === 'horizontal' ? width : 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const t = along > 1 ? (shading === 'vertical' ? y : x) / (along - 1) : 0;
            const i = (y * width + x) * 3;
            for (let c = 0; c < 3; c++)
                pixels[i + c] = Math.round(from[c] + (to[c] - from[c]) * t);
        }
    }
    return pixels;
}

/**
 * The widths of box blurs (three) one after another that blur about as a
 * Gaussian of the sigma does (each odd, so it has a middle).
 *
 * @param {number} sigma - pixels
 * @param {number} [passes]
 * @returns {number[]}
 */
export function boxWidths(sigma, passes = 3) {
    const ideal = Math.sqrt(12 * sigma * sigma / passes + 1);
    let lower = Math.floor(ideal);
    if (lower % 2 === 0)
        lower--;
    lower = Math.max(1, lower);
    const upper = lower + 2;
    const lowerCount = Math.round((12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) /
        (-4 * lower - 4));
    return Array.from({length: passes}, (_, i) => (i < lowerCount ? lower : upper));
}

// A box blur along the rows: each value the mean of the 2r + 1 round it,
// the row's ends repeated past it. (Kept free of anything but sums: it
// runs over the whole backdrop six times.)
function blurRows(src, dst, width, height, channels, r) {
    const stride = width * channels;
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < height; y++) {
        const row = y * stride;
        for (let c = 0; c < channels; c++) {
            const first = src[row + c];
            const last = src[row + stride - channels + c];
            let sum = first * (r + 1);
            for (let i = 1; i <= r; i++)
                sum += i < width ? src[row + i * channels + c] : last;
            for (let x = 0; x < width; x++) {
                dst[row + x * channels + c] = sum * inv;
                const add = x + r + 1;
                const drop = x - r;
                sum += (add < width ? src[row + add * channels + c] : last) -
                    (drop > 0 ? src[row + drop * channels + c] : first);
            }
        }
    }
}

// The same down the columns, a row at a time (the rows lie one after
// another in memory).
function blurColumns(src, dst, width, height, channels, r) {
    const stride = width * channels;
    const inv = 1 / (2 * r + 1);
    const sum = new Float32Array(stride);
    for (let i = 0; i < stride; i++)
        sum[i] = src[i] * (r + 1);
    for (let k = 1; k <= r; k++) {
        const row = Math.min(k, height - 1) * stride;
        for (let i = 0; i < stride; i++)
            sum[i] += src[row + i];
    }
    for (let y = 0; y < height; y++) {
        const out = y * stride;
        const add = Math.min(y + r + 1, height - 1) * stride;
        const drop = Math.max(y - r, 0) * stride;
        for (let i = 0; i < stride; i++) {
            dst[out + i] = sum[i] * inv;
            sum[i] += src[add + i] - src[drop + i];
        }
    }
}

// sRGB's curve, both ways: blurred as light adds up, a bright light
// spreads into a glow rather than fading into grey.
const LINEAR = Float32Array.from({length: 256}, (_, v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const ENCODED_STEPS = 4096;
const ENCODED = Uint8Array.from({length: ENCODED_STEPS + 1}, (_, i) => {
    const c = i / ENCODED_STEPS;
    return Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
});

/**
 * Frost a picture: blurred (about as a Gaussian of the sigma, as light adds
 * up), its colours then made richer (pushed away from their grey, as the
 * eye has it) and brighter (each times the same, as far as the brightest
 * of them goes: the hue stays).
 *
 * @param {Uint8Array} pixels - RGB or RGBA (the alpha is left out)
 * @param {object} image
 * @param {number} image.width
 * @param {number} image.height
 * @param {number} [image.channels] - 3 or 4
 * @param {number} [image.rowstride] - bytes a row (width × channels)
 * @param {object} [options]
 * @param {number} [options.sigma] - pixels
 * @param {number} [options.saturation] - 1 as it is, more richer (as
 *   regular glass has it, frostOf(), if not given)
 * @param {number} [options.lift] - 0 as bright as it is, more brighter
 *   (likewise)
 * @returns {Uint8Array} RGB, width × 3 bytes a row
 */
export function frost(pixels, image, options = {}) {
    const steps = frostSteps(pixels, image, options);
    for (;;) {
        const {done, value} = steps.next();
        if (done)
            return value;
    }
}

/**
 * frost(), a pass at a time: it yields between its passes (each a few
 * milliseconds on a monitor's backdrop), so that the shell can go on
 * drawing meanwhile, and returns what frost() does.
 *
 * @param {Uint8Array} pixels
 * @param {object} image - as for frost()
 * @param {object} [options] - as for frost()
 * @yields {undefined} between the passes
 * @returns {Uint8Array}
 */
export function* frostSteps(pixels, {width, height, channels = 3, rowstride = width * channels}, {
    sigma = SIGMA_PIXELS, saturation = frostOf(lookOf('regular')).saturation, lift = frostOf(lookOf('regular')).lift,
} = {}) {
    let a = new Float32Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const from = y * rowstride + x * channels;
            const to = (y * width + x) * 3;
            a[to] = LINEAR[pixels[from]];
            a[to + 1] = LINEAR[pixels[from + 1]];
            a[to + 2] = LINEAR[pixels[from + 2]];
        }
    }
    let b = new Float32Array(a.length);
    yield;
    if (sigma > 0) {
        for (const box of boxWidths(sigma)) {
            blurRows(a, b, width, height, 3, (box - 1) / 2);
            [a, b] = [b, a];
            yield;
        }
        for (const box of boxWidths(sigma)) {
            blurColumns(a, b, width, height, 3, (box - 1) / 2);
            [a, b] = [b, a];
            yield;
        }
    }
    const encode = v => ENCODED[Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * ENCODED_STEPS)];
    // (A Uint8ClampedArray rounds and clamps as it is written.)
    const out = new Uint8ClampedArray(a.length);
    const most = 1 + lift;
    for (let i = 0; i < a.length; i += 3) {
        const r = encode(a[i]);
        const g = encode(a[i + 1]);
        const bl = encode(a[i + 2]);
        const gray = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        const sr = gray + (r - gray) * saturation;
        const sg = gray + (g - gray) * saturation;
        const sb = gray + (bl - gray) * saturation;
        const brightest = Math.max(sr, sg, sb);
        const times = brightest > 0 ? Math.max(1, Math.min(most, 255 / brightest)) : 1;
        out[i] = sr * times;
        out[i + 1] = sg * times;
        out[i + 2] = sb * times;
    }
    return new Uint8Array(out.buffer);
}

/**
 * The mean colour of a part of a picture (of the backdrop: what is behind
 * the glass), quickly – the digits ask for it as they grow.
 *
 * @param {object} image - {pixels, channels, rowstride, width, height}
 * @param {number[]} region - [x, y, width, height] in it, 0 … 1
 * @returns {string|null} '#rrggbb'; null if the part has no pixels
 */
export function meanColor({pixels, channels, rowstride, width, height}, [x, y, w, h]) {
    if (!(w > 0 && h > 0) || x + w <= 0 || y + h <= 0 || x >= 1 || y >= 1)
        return null;
    const clampTo = (v, n) => Math.min(n - 1, Math.max(0, v));
    const [x1, y1] = [clampTo(Math.floor(x * width), width), clampTo(Math.floor(y * height), height)];
    const [x2, y2] = [clampTo(Math.ceil((x + w) * width) - 1, width), clampTo(Math.ceil((y + h) * height) - 1, height)];
    let [r, g, b, n] = [0, 0, 0, 0];
    for (let row = y1; row <= y2; row++) {
        for (let i = row * rowstride + x1 * channels, end = row * rowstride + x2 * channels; i <= end; i += channels) {
            r += pixels[i];
            g += pixels[i + 1];
            b += pixels[i + 2];
            n++;
        }
    }
    return n > 0 ? rgbToHex([r / n, g / n, b / n]) : null;
}

/**
 * The name of a backdrop: the picture (where it is, when it was changed,
 * how big it is), how GNOME places it and what it draws round it, the
 * monitor and its scale, and how the backdrop is made – so that any of
 * them changed gets a backdrop of its own.
 *
 * @param {{path: string, mtime: number, size: number}} picture - lib/depth.js pictureState()
 * @param {object} options
 * @param {number[]} options.monitor - [width, height]
 * @param {number} options.scale
 * @param {string} options.style - picture-options
 * @param {object} [options.colors] - as for backgroundPixels()
 * @param {object} [options.frost] - frostOf() the look it is made for
 * @returns {string}
 */
export function backdropKey({path, mtime, size},
    {monitor: [width, height], scale, style, colors = {}, frost = frostOf(null)}) {
    const text = [path, mtime, size, style, colors.primary ?? '', colors.secondary ?? '', colors.shading ?? '',
        `${Math.round(width)}x${Math.round(height)}@${scale}`, frost.sigma, frost.saturation, frost.lift,
        `v${BACKDROP_VERSION}`]
        .join('\n');
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, text, -1);
}

/**
 * How to draw the backdrop where it lies behind a drawing: Cairo's
 * translate() and scale() (in that order) from the drawing's pixels to the
 * backdrop's, magnified about a point by a lens (more than 1: the middle
 * of what is behind, larger; less: what is further out, drawn in).
 *
 * @param {object} options
 * @param {number[]} options.at - [x, y] of the drawing's origin on the monitor
 * @param {number[]} options.factor - the backdrop's pixels per monitor pixel
 * @param {number[]} [options.center] - [x, y] the lens is about, in the drawing
 * @param {number|number[]} [options.lens] - how much it magnifies, or
 *   [across, down] (lensOf())
 * @param {number[]} [options.shift] - how far the backdrop's picture lies
 *   from where it belongs, its pixels (pictureArea())
 * @returns {{x: number, y: number, scaleX: number, scaleY: number}}
 */
export function backdropTransform({
    at: [ax, ay], factor: [fx, fy], center: [cx, cy] = [0, 0], lens = 1, shift: [sx, sy] = [0, 0],
}) {
    const [lx, ly] = Array.isArray(lens) ? lens : [lens, lens];
    return {
        x: cx * (1 - lx) - lx * ax - lx / fx * sx,
        y: cy * (1 - ly) - ly * ay - ly / fy * sy,
        scaleX: lx / fx,
        scaleY: ly / fy,
    };
}

/**
 * How the glass bends what is behind a glyph, as a lens about its middle:
 * at its edges, what lies `shift` further out is drawn there (as the look
 * has it, lib/glassLook.js lens.shift) – red a little further still, blue
 * a little less (aberration): a hint of colour at the very rim.
 *
 * @param {number[]} half - [across, down]: half the glyph's width and
 *   height (pixels)
 * @param {number} shift - how far what is behind it moves at its edges
 *   (pixels)
 * @param {number} [aberration] - how much more red moves, and blue less,
 *   of the shift
 * @returns {{red: number[], green: number[], blue: number[]}} each
 *   colour's magnification, [across, down] (backdropTransform()'s lens):
 *   less than 1, what lies further out drawn in
 */
export function lensOf([hx, hy], shift, aberration = 0) {
    const scale = moved => [hx, hy].map(h => (h > 0 && moved > 0 ? h / (h + moved) : 1));
    return {red: scale(shift * (1 + aberration)), green: scale(shift), blue: scale(shift * (1 - aberration))};
}

/**
 * How many times a pixel band's worth of light is added up along each kind
 * of edge, for the rim's light to be as strong as the look has it (lib/
 * glassLook.js rim: strongest along the tops of the strokes, faintest
 * along their bottoms, in between along their sides) – added up a few
 * times over, each time as much (unit), for that is quick.
 *
 * @param {object} rim - {top, bottom, side}: the light's alpha along each
 * @param {number} [strength] - of all of it (dark glass catches less)
 * @param {number} [adds] - how many times at most, all edges together
 * @returns {{unit: number, top: number, bottom: number, side: number}}
 *   the alpha added each time, and how many times along each kind of edge
 *   (the sides: each of them)
 */
export function rimSteps({top, bottom, side}, strength = 1, adds = 14) {
    const unit = (top + bottom + 2 * side) / adds;
    const times = alpha => (alpha > 0 && unit > 0 ? Math.max(1, Math.round(alpha / unit)) : 0);
    return {unit: unit * strength, top: times(top), bottom: times(bottom), side: times(side)};
}

/**
 * The line a sheen's gradient runs along across a box, as CSS draws a
 * linear-gradient() at an angle: through the box's middle, from where the
 * angle comes from to where it goes, as long as the box is across that way.
 *
 * @param {object} box - {x, y, width, height}
 * @param {number} angle - degrees, as CSS has them (135: from the top left
 *   down to the bottom right)
 * @returns {number[]} [x0, y0, x1, y1]
 */
export function sheenLine({x, y, width, height}, angle) {
    const a = angle * Math.PI / 180;
    const [dx, dy] = [Math.sin(a), -Math.cos(a)];
    const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
    const [cx, cy] = [x + width / 2, y + height / 2];
    return [cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half];
}

/**
 * Fine grain against banding: so many values from -1 to 1, as random as
 * they need to look, and the same each time (a seed of their own).
 *
 * @param {number} count
 * @param {number} [seed]
 * @returns {Float32Array}
 */
export function grainNoise(count, seed = 0x5eed) {
    const values = new Float32Array(count);
    let state = seed >>> 0;
    for (let i = 0; i < count; i++) {
        // (xorshift32)
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        values[i] = state / 2147483647.5 - 1;
    }
    return values;
}

/**
 * Each glyph's cell, side by side and not overlapping (split halfway where
 * two glyphs come close or overlap), each with the middle the glass bends
 * light about.
 *
 * @param {object[]} boxes - {x, y, width, height} of each glyph, left to right
 * @param {object} bounds - {x, y, width, height} of all of them
 * @returns {{x: number, width: number, center: number[], box: object}[]}
 *   from the bounds' left to their right; box: the glyph's own (the
 *   bounds, without glyphs)
 */
export function glyphCells(boxes, bounds) {
    const sorted = (boxes ?? []).filter(box => box.width > 0).sort((a, b) => a.x - b.x);
    const middleY = bounds.y + bounds.height / 2;
    if (sorted.length === 0) {
        return [{x: bounds.x, width: bounds.width, center: [bounds.x + bounds.width / 2, middleY],
            box: {x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height}}];
    }
    const edges = [bounds.x];
    for (let i = 1; i < sorted.length; i++) {
        const [left, right] = [sorted[i - 1], sorted[i]];
        edges.push(Math.max(edges.at(-1), (left.x + left.width + right.x) / 2));
    }
    edges.push(Math.max(edges.at(-1), bounds.x + bounds.width));
    return sorted.map((box, i) => ({
        x: edges[i],
        width: edges[i + 1] - edges[i],
        center: [box.x + box.width / 2, middleY],
        box: {x: box.x, y: box.y, width: box.width, height: box.height},
    }));
}

/**
 * The glass's tint: as light (or as dark) as the tone, with a hint of the
 * colour of what is behind it, as a frosted pane takes it on (with none to
 * speak of, the tone's own hue).
 *
 * @param {object} tone - {color: '#rrggbb', dark}: lib/lockLook.js's tone
 * @param {string|null} [behind] - the backdrop's mean colour behind the
 *   glass; null when it isn't known
 * @returns {string} '#rrggbb'
 */
export function glassTint(tone, behind = null) {
    const [lightness, toneChroma, toneHue] = hexToOklch(tone.color);
    if (!behind)
        return tone.color;
    const [, chroma, hue] = hexToOklch(behind);
    // (A grey backdrop has no hue to give: the tone's then.)
    const share = Math.min(1, chroma / 0.06);
    const taken = Math.min(TINT_CHROMA, chroma * 0.6);
    const ownChroma = Math.min(TINT_CHROMA, toneChroma);
    const [a, b] = [
        taken * Math.cos(hue * Math.PI / 180) * share + ownChroma * Math.cos(toneHue * Math.PI / 180) * (1 - share),
        taken * Math.sin(hue * Math.PI / 180) * share + ownChroma * Math.sin(toneHue * Math.PI / 180) * (1 - share),
    ];
    const mixedHue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
    return oklchToHex([lightness, Math.hypot(a, b), mixedHue]);
}

/**
 * What colour the glass comes out, on the whole: the backdrop (as dark
 * glass lets less of it through, darker; dimmed and veiled as the look
 * has it) under the tint (its mean: lighter at the top, darker at the
 * bottom), the membrane they make over the sharp wallpaper as much as its
 * opacity. For a contrast plan to weigh against what is round the glass.
 * (Mixed as Cairo mixes them: in sRGB's values. The light along its edges
 * and its sheen are left out: the plan weighs it where it is least.)
 *
 * @param {object} options
 * @param {string} options.frosted - the backdrop's mean behind the glass
 * @param {string} options.tint - glassTint()
 * @param {boolean} [options.dark] - dark glass (the tone is dark)
 * @param {number} [options.tintAlpha]
 * @param {number} [options.opacity]
 * @param {string} [options.behind] - the sharp wallpaper's mean behind it
 *   (what shows through where the membrane is not opaque); the frosted
 *   one's if not given
 * @param {object|null} [options.look] - lib/glassLook.js lookOf()'s: its
 *   dim and veil over the backdrop; none: neither
 * @returns {string} '#rrggbb'
 */
export function glassColor({
    frosted, tint, dark = false, tintAlpha = GLASS.tintAlpha, opacity = GLASS.opacity, behind = frosted, look = null,
}) {
    const alpha = TINT_GRADIENT.reduce((sum, share) => sum + Math.min(1, tintAlpha * share), 0) / TINT_GRADIENT.length;
    const [f, t, s] = [hexToRgb(frosted), hexToRgb(tint), hexToRgb(behind)];
    const [dim, veil] = [look?.dim ?? 0, look?.veil ?? 0];
    const through = f.map(v => (dark ? v * DIM : v) * (1 - dim)).map(v => v + (255 - v) * veil);
    const membrane = through.map((v, c) => v + (t[c] - v) * alpha);
    const o = Math.min(1, Math.max(0, opacity));
    return rgbToHex(membrane.map((v, c) => s[c] + (v - s[c]) * o));
}
