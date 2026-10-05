// Colors from a painting: swatches extracted from the wallpaper and a full
// palette built from one of them, for the shell, GTK apps and the terminal.
// Pure color math (OKLab / OKLCH) without any library, so it is easy to test.
// Shared by the shell and the preferences.

import {ACCENT_COLORS} from './profiles.js';

export const VARIANTS = ['vibrant', 'muted', 'monochrome'];

/** Fixed palettes for when the wallpaper shouldn't decide. */
export const PRESETS = {
    ochre: {name: 'Ochre', color: '#c8892b'},
    sea: {name: 'Sea', color: '#2f8fb0'},
    moss: {name: 'Moss', color: '#6a8f3a'},
    rose: {name: 'Rose', color: '#c75b7a'},
    lavender: {name: 'Lavender', color: '#8a6fc4'},
    slate: {name: 'Slate', color: '#6b7f94'},
    ember: {name: 'Ember', color: '#d0562e'},
    sand: {name: 'Sand', color: '#b8a07a'},
    graphite: {name: 'Graphite', color: '#5f6368'},
};

// ---- conversions ---------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const toLinear = c => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const fromLinear = c => {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
    return v * 255;
};

/**
 * @param {string} hex - '#rrggbb'
 * @returns {number[]} [r, g, b] in 0..255
 */
export function hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
}

/**
 * @param {number[]} rgb - [r, g, b] in 0..255 (clamped and rounded)
 * @returns {string} '#rrggbb'
 */
export function rgbToHex([r, g, b]) {
    return `#${[r, g, b]
        .map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0'))
        .join('')}`;
}

/**
 * @param {number[]} rgb - [r, g, b] in 0..255
 * @returns {number[]} [L, a, b] in OKLab
 */
export function rgbToOklab([r, g, b]) {
    const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

/**
 * @param {number[]} lab - [L, a, b] in OKLab
 * @returns {number[]} [r, g, b] in 0..255, possibly out of gamut
 */
export function oklabToRgbUnclamped([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
        fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    ];
}

const inGamut = rgb => rgb.every(v => v >= -0.5 && v <= 255.5);

/** @returns {number[]} [L, C, h] with h in degrees */
export function oklabToOklch([L, a, b]) {
    const h = Math.atan2(b, a) * 180 / Math.PI;
    return [L, Math.hypot(a, b), (h + 360) % 360];
}

/**
 * Convert OKLCH to sRGB, lowering the chroma until the color fits sRGB.
 *
 * @param {number[]} lch - [L, C, h]
 * @returns {number[]} [r, g, b]
 */
export function oklchToRgb([L, C, h]) {
    const rad = h * Math.PI / 180;
    const at = c => oklabToRgbUnclamped([L, c * Math.cos(rad), c * Math.sin(rad)]);
    let rgb = at(C);
    if (inGamut(rgb))
        return rgb;
    let lo = 0, hi = C;
    for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (inGamut(at(mid)))
            lo = mid;
        else
            hi = mid;
    }
    rgb = at(lo);
    return rgb.map(v => clamp(v, 0, 255));
}

export const oklchToHex = lch => rgbToHex(oklchToRgb(lch));
export const hexToOklch = hex => oklabToOklch(rgbToOklab(hexToRgb(hex)));

// ---- contrast (WCAG) -----------------------------------------------------

function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map(toLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * @param {string} a - hex color
 * @param {string} b - hex color
 * @returns {number} WCAG contrast ratio, 1..21
 */
export function contrastRatio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

// ---- extraction ----------------------------------------------------------

/** Small deterministic PRNG (mulberry32), so extraction is reproducible. */
function random(seed) {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6D2B79F5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

const distance2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

/**
 * Group the pixels of a (small) image into dominant colors with k-means in
 * OKLab, which matches how different colors look to people.
 *
 * @param {Uint8Array|number[]} pixels - RGB or RGBA bytes
 * @param {object} [options]
 * @param {number} [options.channels] - 3 or 4
 * @param {number} [options.rowstride] - bytes per row (defaults to width × channels)
 * @param {number} [options.width]
 * @param {number} [options.k] - number of swatches
 * @returns {{hex: string, lab: number[], share: number}[]} sorted by share
 */
export function extractSwatches(pixels, {channels = 3, rowstride = 0, width = 0, k = 6} = {}) {
    const points = [];
    if (rowstride && width) {
        for (let row = 0; row * rowstride < pixels.length; row++) {
            for (let x = 0; x < width; x++) {
                const i = row * rowstride + x * channels;
                if (i + 2 < pixels.length)
                    points.push(rgbToOklab([pixels[i], pixels[i + 1], pixels[i + 2]]));
            }
        }
    } else {
        for (let i = 0; i + 2 < pixels.length; i += channels)
            points.push(rgbToOklab([pixels[i], pixels[i + 1], pixels[i + 2]]));
    }
    if (points.length === 0)
        return [];

    // k-means++ seeding with a fixed seed.
    const rand = random(0xa7e11e7);
    const centers = [points[Math.floor(rand() * points.length)]];
    while (centers.length < Math.min(k, points.length)) {
        const weights = points.map(p => Math.min(...centers.map(c => distance2(p, c))));
        const total = weights.reduce((s, w) => s + w, 0);
        if (total === 0)
            break;
        let pick = rand() * total;
        let index = 0;
        while (pick > weights[index] && index < points.length - 1)
            pick -= weights[index++];
        centers.push(points[index]);
    }

    let assignment = new Array(points.length).fill(0);
    for (let iteration = 0; iteration < 16; iteration++) {
        let moved = false;
        points.forEach((p, i) => {
            let best = 0;
            let bestDistance = Infinity;
            centers.forEach((c, j) => {
                const d = distance2(p, c);
                if (d < bestDistance) {
                    bestDistance = d;
                    best = j;
                }
            });
            if (assignment[i] !== best) {
                assignment[i] = best;
                moved = true;
            }
        });
        const sums = centers.map(() => [0, 0, 0, 0]);
        points.forEach((p, i) => {
            const s = sums[assignment[i]];
            s[0] += p[0];
            s[1] += p[1];
            s[2] += p[2];
            s[3]++;
        });
        sums.forEach((s, j) => {
            if (s[3] > 0)
                centers[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
        });
        if (!moved && iteration > 0)
            break;
    }

    const counts = centers.map(() => 0);
    assignment.forEach(j => counts[j]++);
    return centers
        .map((lab, j) => ({
            lab,
            hex: rgbToHex(oklabToRgbUnclamped(lab)),
            share: counts[j] / points.length,
        }))
        .filter(s => s.share > 0)
        .sort((a, b) => b.share - a.share);
}

/**
 * Pick the swatch that should drive the palette: common and colorful,
 * not nearly black or white.
 *
 * @param {{lab: number[], share: number}[]} swatches
 * @returns {number} index into swatches
 */
export function pickSource(swatches) {
    let best = 0;
    let bestScore = -Infinity;
    swatches.forEach((s, i) => {
        const [L, C] = oklabToOklch(s.lab);
        const lightness = 1 - Math.min(1, Math.abs(L - 0.62) / 0.5) ** 2;
        const score = Math.sqrt(s.share) * (C + 0.015) * (0.3 + lightness);
        if (score > bestScore) {
            bestScore = score;
            best = i;
        }
    });
    return best;
}

// ---- palette -------------------------------------------------------------

const harmonize = (hue, toward, amount = 0.35, max = 18) => {
    let diff = ((toward - hue + 540) % 360) - 180;
    diff = clamp(diff * amount, -max, max);
    return (hue + diff + 360) % 360;
};

function chromaFor(variant, sourceChroma) {
    switch (variant) {
    case 'muted':
        return {primary: clamp(sourceChroma * 0.55, 0.035, 0.085), neutral: 0.01, accents: 0.07};
    case 'monochrome':
        return {primary: 0, neutral: 0, accents: 0.1};
    default:
        return {primary: clamp(Math.max(sourceChroma, 0.1), 0.1, 0.19), neutral: 0.022, accents: 0.13};
    }
}

function scheme(hue, chroma, dark) {
    const n = l => oklchToHex([l, chroma.neutral, hue]);
    const p = (l, c = chroma.primary) => oklchToHex([l, c, hue]);
    const s = (l, c = chroma.primary * 0.45) => oklchToHex([l, c, (hue + 30) % 360]);
    const t = (l, c = chroma.primary * 0.6) => oklchToHex([l, c, (hue + 60) % 360]);
    const err = l => oklchToHex([l, 0.15, 25]);
    if (dark) {
        return {
            surface: n(0.17), surfaceContainerLow: n(0.2), surfaceContainer: n(0.23),
            surfaceContainerHigh: n(0.27), surfaceContainerHighest: n(0.31),
            onSurface: n(0.94), onSurfaceVariant: n(0.79),
            outline: n(0.56), outlineVariant: n(0.36),
            primary: p(0.8), onPrimary: p(0.24), primaryContainer: p(0.38), onPrimaryContainer: p(0.92),
            secondary: s(0.78), onSecondary: s(0.25), secondaryContainer: s(0.34), onSecondaryContainer: s(0.9),
            tertiary: t(0.78), error: err(0.72), onError: err(0.25),
        };
    }
    return {
        surface: n(0.98), surfaceContainerLow: n(0.955), surfaceContainer: n(0.935),
        surfaceContainerHigh: n(0.905), surfaceContainerHighest: n(0.875),
        onSurface: n(0.22), onSurfaceVariant: n(0.43),
        outline: n(0.6), outlineVariant: n(0.83),
        primary: p(0.5), onPrimary: p(0.99, 0.01), primaryContainer: p(0.89, chroma.primary * 0.5),
        onPrimaryContainer: p(0.3),
        secondary: s(0.52), onSecondary: s(0.99, 0.01), secondaryContainer: s(0.9), onSecondaryContainer: s(0.32),
        tertiary: t(0.52), error: err(0.55), onError: err(0.99),
    };
}

// Standard ANSI hues, nudged toward the palette's hue.
const ANSI_HUES = {red: 27, green: 145, yellow: 95, blue: 258, magenta: 330, cyan: 205};

function terminal(hue, chroma, dark, roles) {
    const c = chroma.accents;
    const color = (name, l, cc = c) => oklchToHex([l, cc, harmonize(ANSI_HUES[name], hue)]);
    const names = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
    const neutral = l => oklchToHex([l, chroma.neutral * 0.6, hue]);
    if (dark) {
        return [
            roles.surfaceContainerHigh, ...names.map(name => color(name, 0.7)), neutral(0.84),
            roles.outline, ...names.map(name => color(name, 0.81, c * 1.05)), neutral(0.97),
        ];
    }
    return [
        neutral(0.26), ...names.map(name => color(name, 0.52, c * 1.1)), neutral(0.8),
        neutral(0.46), ...names.map(name => color(name, 0.44, c * 1.15)), neutral(0.94),
    ];
}

/**
 * @param {string} hex
 * @returns {string} the GNOME accent color (key of ACCENT_COLORS) closest to hex
 */
export function nearestAccent(hex) {
    const [, C, h] = hexToOklch(hex);
    if (C < 0.03)
        return 'slate';
    let best = 'blue';
    let bestDistance = Infinity;
    for (const [name, accent] of Object.entries(ACCENT_COLORS)) {
        if (name === 'slate')
            continue;
        const [, , ah] = hexToOklch(accent);
        const d = Math.min(Math.abs(ah - h), 360 - Math.abs(ah - h));
        if (d < bestDistance) {
            bestDistance = d;
            best = name;
        }
    }
    return best;
}

/**
 * Build the palette from a source color.
 *
 * @param {object} options
 * @param {string} options.source - hex color driving the palette
 * @param {string} [options.variant] - one of VARIANTS
 * @param {string[]} [options.swatches] - extracted swatches, kept for display
 * @returns {object} {source, variant, swatches, accent, dark, light, terminal: {dark, light}}
 */
export function buildPalette({source, variant = 'vibrant', swatches = []}) {
    const [, sourceChroma, hue] = hexToOklch(source);
    const chroma = chromaFor(VARIANTS.includes(variant) ? variant : 'vibrant', sourceChroma);
    const dark = scheme(hue, chroma, true);
    const light = scheme(hue, chroma, false);
    return {
        source,
        variant,
        swatches,
        accent: chroma.primary === 0 ? 'slate' : nearestAccent(dark.primary),
        dark,
        light,
        terminal: {
            dark: terminal(hue, chroma, true, dark),
            light: terminal(hue, chroma, false, light),
        },
    };
}
