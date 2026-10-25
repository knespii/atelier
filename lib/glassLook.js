// How Atelier's glass looks – Liquid Glass, as iOS 26 has it: what is
// behind it bends at its edges as through a lens (more so for red than for
// blue: a hint of colour at the very rim), richer and lighter; its edges
// catch a light from above (strongly at the top, faintly at the bottom, in
// between at the sides) that leans towards the pointer; a soft sheen runs
// across it; a fine grain keeps its gradients from banding. One look for
// every surface – drawn on the GPU (shell/core/glassMaterial.js) or with
// Cairo (the lock screen's clock, shell/lockscreen/liquidGlass.js) – in
// three variants, as Apple's: regular, clear and off. Where the type on a
// surface would not read, its glass takes an extra shade (shadedLook()):
// darker under light type, lighter under dark. Pure, shared by the shell
// and the preferences.

/** The variants, as the glass-variant setting has them. */
export const VARIANTS = ['regular', 'clear', 'off'];

/**
 * The material of each variant (none for 'off': solid surfaces). Lengths
 * in logical pixels; alphas and factors 0 … 1 unless said otherwise.
 *
 * - frost: how frosted it is – its blur and its tint, a share of what the
 *   surface has of them (clear glass lets more of what is behind through)
 * - saturation, brightness: of what is behind it (1 as it is)
 * - veil: a white veil over it, its alpha
 * - dim: a dark veil under the veil, its alpha (clear glass lets more light
 *   through and needs it to keep what is on it legible)
 * - lens.width: how far in from the edge it bends; lens.shift: how far
 *   what is behind it moves at the very edge
 * - aberration: how much more than the lens's shift red moves at the edge,
 *   and blue less (green as the lens has it)
 * - rim: the light the edges catch – top, bottom and side alphas – and its
 *   width
 * - sheen: a diagonal gloss – its angle (degrees, 135: from the top left),
 *   alpha at its start, and how far across it fades out (0 … 1); surfaces
 *   with something on them to read (the island, the bar, the dock, the
 *   widgets) show this much of it (sheen.surface), glass that is all there
 *   is to see (the lock screen's glass clock) all of it
 * - grain: the amplitude of the fine noise
 * - light.lean: how far (0 … 1) the light turns towards the pointer when
 *   it is near; light.near: how near that is
 */
export const LOOK = {
    regular: {
        frost: 1,
        saturation: 1.8,
        brightness: 1.15,
        veil: 0.08,
        dim: 0,
        lens: {width: 16, shift: 12},
        aberration: 0.35,
        rim: {top: 0.6, bottom: 0.2, side: 0.3, width: 1.5},
        sheen: {angle: 135, alpha: 0.4, reach: 0.4, surface: 0.35},
        grain: 0.02,
        light: {lean: 0.35, near: 160},
    },
    clear: {
        frost: 0.5,
        saturation: 1.4,
        brightness: 1.05,
        veil: 0.03,
        dim: 0.12,
        lens: {width: 16, shift: 14},
        aberration: 0.35,
        rim: {top: 0.5, bottom: 0.15, side: 0.25, width: 1.5},
        sheen: {angle: 135, alpha: 0.25, reach: 0.4, surface: 0.35},
        grain: 0.015,
        light: {lean: 0.35, near: 160},
    },
    off: null,
};

/**
 * The variant to draw: the one chosen, unless GNOME's high contrast is on
 * (then none: solid surfaces).
 *
 * @param {string} chosen - the glass-variant setting
 * @param {object} [options]
 * @param {boolean} [options.highContrast] - org.gnome.desktop.a11y.interface
 * @returns {string} one of VARIANTS
 */
export function resolveVariant(chosen, {highContrast = false} = {}) {
    if (highContrast)
        return 'off';
    return VARIANTS.includes(chosen) ? chosen : 'regular';
}

/**
 * @param {string} variant - one of VARIANTS
 * @returns {object|null} its material (LOOK), null for none
 */
export function lookOf(variant) {
    return LOOK[variant] ?? null;
}

/** The tints of glass (stylesheet.css, shell/core/theme.js). */
export const TINTS = ['smoky', 'smoky-clear', 'light', 'light-clear', 'deep'];

/**
 * How a surface's glass is tinted under its material: smoky in GNOME's dark
 * style, light (the palette's hue, faintly) in its light one, half as much
 * for clear glass – and deep, dark whatever the style, where it carries
 * what is styled for a dark surface only (GNOME's own controls in the
 * control centre, a sheet's form).
 *
 * @param {object|null} look - LOOK's
 * @param {object} options
 * @param {boolean} options.light - GNOME's style is light
 * @param {boolean} [options.deep]
 * @returns {string} one of TINTS
 */
export function tintOf(look, {light, deep = false}) {
    if (deep)
        return 'deep';
    const tone = light ? 'light' : 'smoky';
    return (look?.frost ?? 1) < 1 ? `${tone}-clear` : tone;
}

/** No extra shade: {dim, veil} (shadedLook()). */
export const NO_SHADE = Object.freeze({dim: 0, veil: 0});

/**
 * A look with an extra shade, as the GPU's shader lays it on
 * (shell/core/glassMaterial.js): a dark veil multiplied with its own dim, a
 * white one with its own veil – each letting through what the other left.
 * (Where its type would not read otherwise: lib/vibrancy.js shadeNeeded().)
 *
 * @param {object|null} look - LOOK's
 * @param {object} [shade] - {dim, veil}, 0 … 1 each
 * @returns {object|null} the look, so shaded
 */
export function shadedLook(look, {dim = 0, veil = 0} = NO_SHADE) {
    if (!look || (dim <= 0 && veil <= 0))
        return look;
    const over = (own = 0, more) => (more > 0 ? 1 - (1 - own) * (1 - more) : own);
    return {...look, dim: over(look.dim, dim), veil: over(look.veil, veil)};
}

/**
 * @param {object} a - a shade, {dim, veil}
 * @param {object} b - another
 * @returns {boolean} whether they are the same, as far as anyone could see
 */
export function sameShade(a, b) {
    return Math.abs(a.dim - b.dim) < 1e-4 && Math.abs(a.veil - b.veil) < 1e-4;
}

/**
 * A material as the GPU's shader takes it (shell/core/glassMaterial.js):
 * four vectors of four, lengths in the surface's pixels.
 *
 * @param {object|null} look - LOOK's, null for none (only the shape)
 * @param {number} [scale] - pixels in a logical pixel
 * @returns {object} {tone, lens, rim, sheen}: tone [saturation,
 *   brightness, veil, dim]; lens [width, shift, aberration, 1 for the
 *   material at all]; rim [top, bottom, side, width]; sheen [alpha as a
 *   surface shows it, reach, angle in radians, grain]
 */
export function materialValues(look, scale = 1) {
    if (!look)
        return {tone: [1, 1, 0, 0], lens: [0, 0, 0, 0], rim: [0, 0, 0, 0], sheen: [0, 0, 0, 0]};
    return {
        tone: [look.saturation, look.brightness, look.veil, look.dim],
        lens: [look.lens.width * scale, look.lens.shift * scale, look.aberration, 1],
        rim: [look.rim.top, look.rim.bottom, look.rim.side, look.rim.width * scale],
        sheen: [look.sheen.alpha * (look.sheen.surface ?? 1), look.sheen.reach, look.sheen.angle * Math.PI / 180,
            look.grain],
    };
}

/** Where the light comes from at rest: above (a direction, y down). */
export const REST_LIGHT = [0, -1];

/**
 * Where the light comes from for a surface: from above, turning towards
 * the pointer while it is near – the nearer, the more (eased), up to
 * light.lean of the way. Over the surface it leans the way the pointer is
 * from its middle, so the light moves with it across.
 *
 * @param {number[]} area - [x, y, width, height] of the surface
 * @param {number[]} pointer - [x, y], the same way
 * @param {object} light - LOOK's: {lean, near}
 * @param {number} [scale] - pixels in a logical pixel
 * @returns {number[]} a direction [x, y] (y down), REST_LIGHT when far
 */
export function lightToward([x, y, width, height], [px, py], {lean, near}, scale = 1) {
    const reach = near * scale;
    const dx = Math.max(x - px, 0, px - x - width);
    const dy = Math.max(y - py, 0, py - y - height);
    const distance = Math.hypot(dx, dy);
    if (!(reach > 0) || distance >= reach || width <= 0 || height <= 0)
        return REST_LIGHT;
    const closeness = 1 - distance / reach;
    const amount = lean * closeness * closeness * (3 - 2 * closeness);
    // From the middle towards the pointer, a whole step at the edges.
    let vx = (px - x - width / 2) / (width / 2);
    let vy = (py - y - height / 2) / (height / 2);
    const length = Math.hypot(vx, vy);
    if (length > 1) {
        vx /= length;
        vy /= length;
    }
    const lx = REST_LIGHT[0] * (1 - amount) + vx * amount;
    const ly = REST_LIGHT[1] * (1 - amount) + vy * amount;
    const norm = Math.hypot(lx, ly);
    return norm < 1e-3 ? REST_LIGHT : [lx / norm, ly / norm];
}

/**
 * @param {number[]} a - a light's direction
 * @param {number[]} b - another's
 * @returns {boolean} whether they are the same, as far as anyone could see
 */
export function sameLight(a, b) {
    return Math.abs(a[0] - b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3;
}

// How far past a screen's edge a surface lying on it is taken to go.
const PAST_EDGE = 512;

/**
 * A surface that lies on an edge of its monitor (a notch at the top, a bar
 * across it, a dock along the bottom) has no edge there to bend or catch
 * the light: its body goes on past it.
 *
 * @param {number[]} rect - [x, y, width, height]
 * @param {object} monitor - {x, y, width, height}, the same way
 * @returns {number[]} the rect, past the monitor's edges it lies on
 */
export function bodyRect([x, y, width, height], monitor) {
    const on = (a, b) => Math.abs(a - b) <= 1;
    const left = on(x, monitor.x) ? PAST_EDGE : 0;
    const top = on(y, monitor.y) ? PAST_EDGE : 0;
    const right = on(x + width, monitor.x + monitor.width) ? PAST_EDGE : 0;
    const bottom = on(y + height, monitor.y + monitor.height) ? PAST_EDGE : 0;
    return [x - left, y - top, width + left + right, height + top + bottom];
}

/**
 * @param {number[][]} rects - [x, y, width, height] each, none empty
 * @returns {number[]|null} the bounds of them all, null for none
 */
export function boundsOf(rects) {
    const shown = rects.filter(([, , width, height]) => width > 0 && height > 0);
    if (shown.length === 0)
        return null;
    const x1 = Math.min(...shown.map(r => r[0]));
    const y1 = Math.min(...shown.map(r => r[1]));
    const x2 = Math.max(...shown.map(r => r[0] + r[2]));
    const y2 = Math.max(...shown.map(r => r[1] + r[3]));
    return [x1, y1, x2 - x1, y2 - y1];
}
