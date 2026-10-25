// The glass clock's sums (shell/lockscreen/glassText.js draws it on the
// GPU): the backdrop – the wallpaper as GNOME draws it on the lock screen's
// monitor, blurred as the clock's glass blurs it (lib/glassLook.js), small
// (a monitor a fifth as wide and as high is as good as all of it to weigh
// what the digits take to read) – and where a part of the monitor falls in
// it; and the colour the glass comes out over it: its neutral face, washed
// towards the tone as much as its legibility plan has it. Pure functions
// (GLib only for a checksum), shared by the shell and the tools.

import GLib from 'gi://GLib';

import {faceColor, lookOf} from './glassLook.js';
import {hexToRgb, rgbToHex} from './palette.js';

/**
 * How small the backdrop is: as a blur of this sigma (logical pixels)
 * would let it be – the digits' legibility is weighed on it (the lighter and
 * darker tenth of what is behind them), not drawn.
 */
export const FROST = {sample: 14};

/**
 * @param {object|null} look - lib/glassLook.js lookOf()'s; null: none (as
 *   the picture is)
 * @returns {{sigma: number, saturation: number, lift: number}} how the
 *   backdrop is blurred for it: as the glass blurs what is behind it (its
 *   blur's sigma, logical pixels), its colours and its light as they are
 *   (the glass's face does the rest: glassColor())
 */
export function frostOf(look) {
    return {sigma: look?.blur ?? 0, saturation: 1, lift: 0};
}

/**
 * Raised whenever the backdrop is made otherwise, so the old ones are made
 * anew.
 */
export const BACKDROP_VERSION = 3;

// The backdrop's pixels per FROST's sigma.
const SIGMA_PIXELS = 3;

/**
 * The glass at rest: how far its face is washed towards the tone (the
 * glass a contrast plan makes more opaque).
 */
export const GLASS = {wash: 0.15};

/**
 * How much of the tone the glass shows over what is behind it: glass
 * type's `glass` as lib/lockLook.js legibilityPlan() takes it.
 *
 * @param {object} [material] - {wash}; the glass at rest
 * @returns {number} 0 … 1
 */
export function tintShown({wash = GLASS.wash} = {}) {
    return Math.min(1, Math.max(0, wash));
}

/**
 * The glass that shows this much of the tone (legibilityPlan()'s `glass`,
 * as much as it takes to read), as Apple's lock screen makes its glass
 * more opaque. Never less than at rest.
 *
 * @param {number|null} shown - see tintShown(); null: the glass at rest
 * @returns {{wash: number}}
 */
export function glassFor(shown) {
    return {wash: shown > GLASS.wash ? Math.min(1, shown) : GLASS.wash};
}

/**
 * The backdrop's size: the monitor, as small as FROST has it (never larger
 * than the monitor).
 *
 * @param {number[]} monitor - [width, height], pixels
 * @param {number} [scale] - the shell's scale factor (the sigma is logical)
 * @param {number} [sigma] - the blur's, logical pixels
 * @returns {{width: number, height: number, factor: number[], sigma: number}}
 *   its pixels; [x, y] of them a monitor pixel is; the blur's sigma in them
 */
export function backdropSize([width, height], scale = 1, sigma = 0) {
    const wanted = Math.min(1, SIGMA_PIXELS / Math.max(1e-6, FROST.sample * scale));
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
 * What colour the glass comes out, on the whole: what is behind it (as
 * lightly blurred as the glass has it), as the glass's face makes it
 * (lib/glassLook.js faceColor(): lighter or darker, neutral), washed
 * towards the tone as much as asked – as the GPU draws it (shell/
 * lockscreen/glassText.js). For a contrast plan to weigh against what is
 * round the glass. (The lens, the light along its edges and its glint are
 * left out: the plan weighs it where it is least.)
 *
 * @param {object} options
 * @param {string} options.behind - what is behind the glass, '#rrggbb'
 * @param {string} options.tone - the type's tone, '#rrggbb'
 * @param {number} [options.wash] - how far towards it (glassFor())
 * @param {string} [options.face] - which of lib/glassLook.js FACES
 * @returns {string} '#rrggbb'
 */
export function glassColor({behind, tone, wash = GLASS.wash, face = 'light'}) {
    const glass = faceColor(hexToRgb(behind).map(v => v / 255), face);
    const toward = hexToRgb(tone).map(v => v / 255);
    const w = Math.min(1, Math.max(0, wash));
    return rgbToHex(glass.map((v, c) => 255 * (v + (toward[c] - v) * w)));
}
