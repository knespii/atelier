// How Atelier's glass looks – Liquid Glass, as iOS 26 has it: neutral
// glass, what is behind it only lightly blurred, bending strongly at its
// edges as a thick glass marble does (the outer rim a mirrored, squeezed
// copy of what lies farther in), lighter or darker as a whole as GNOME's
// style has it, with a thin bright glint on the side the light comes from
// and the opposite one, a faint contour and a soft shadow outside it, and
// a fine grain against banding. One model for every surface, drawn on the
// GPU (shell/core/glassMaterial.js) – the lock screen's clock is still
// drawn with Cairo (shell/lockscreen/liquidGlass.js), from the values of
// the look it always had – in three variants, as Apple's: regular, clear
// and off. Where the type on a surface would not read, its glass takes an
// extra shade, darker under light type, lighter under dark (lib/vibrancy.js).
// Pure, shared by the shell and the preferences.

/** The variants, as the glass-variant setting has them. */
export const VARIANTS = ['regular', 'clear', 'off'];

/**
 * The material of each variant (none for 'off': solid surfaces). Lengths
 * in logical pixels; alphas and factors 0 … 1 unless said otherwise.
 *
 * - blur: what is behind it, blurred by a Gaussian of this sigma (in the
 *   shader: blurTaps())
 * - face: how it is lighter or darker as a whole, one of FACES – 'style'
 *   for GNOME's style's (light, or dark), as faceOf() picks it
 * - lens: its edges bend what is behind as a bevel of glass: within bevel
 *   of the edge (a quarter of the part's short side at most), what lies up
 *   to depth farther in (half its short side at most) – lensDepth();
 *   dispersion: how much farther red looks and blue less (0: none)
 * - glint: how bright the glint on its edges is, at most
 * - contour: how much light the fine line round it absorbs, by GNOME's
 *   style ('clear' glass's own)
 * - grain: the amplitude of the fine noise
 * - light.lean: how far (0 … 1) the light turns towards the pointer when
 *   it is near; light.near: how near that is
 *
 * The rest is the lock screen's glass clock's, drawn with Cairo until it
 * moves to the GPU too: frost, saturation and brightness of what is behind
 * it, veil and dim over it; its lens (lens.width: how far in from the edge
 * it bends; lens.shift: how far what is behind moves at the very edge;
 * aberration: how much more red moves, and blue less); the rim's light;
 * a diagonal sheen.
 */
export const LOOK = {
    regular: {
        blur: 2,
        face: 'style',
        lens: {bevel: 20, depth: 60, dispersion: 0, width: 16, shift: 12},
        glint: 0.8,
        contour: {light: 0.15, dark: 0.3},
        grain: 0.02,
        light: {lean: 0.35, near: 160},
        frost: 1,
        saturation: 1.8,
        brightness: 1.15,
        veil: 0.08,
        dim: 0,
        rim: {top: 0.6, bottom: 0.2, side: 0.3, width: 1.5},
        aberration: 0.35,
        sheen: {angle: 135, alpha: 0.4, reach: 0.4},
    },
    clear: {
        blur: 0,
        face: 'clear',
        lens: {bevel: 20, depth: 60, dispersion: 0, width: 16, shift: 14},
        glint: 0.85,
        contour: {light: 0.12, dark: 0.12},
        grain: 0.015,
        light: {lean: 0.35, near: 160},
        frost: 0.5,
        saturation: 1.4,
        brightness: 1.05,
        veil: 0.03,
        dim: 0.12,
        rim: {top: 0.5, bottom: 0.15, side: 0.25, width: 1.5},
        aberration: 0.35,
        sheen: {angle: 135, alpha: 0.25, reach: 0.4},
    },
    off: null,
};

/**
 * How glass makes what is behind it lighter or darker: a neutral transfer
 * of its luminance, the same for every hue (Apple's, fitted), on the
 * unpremultiplied sRGB values of what is behind:
 *
 *   face = lift + T·Y·(1 + λ·(1 − Y)) + g·(c − Y)
 *
 * Y its Rec. 709 luma, c each channel; lift the grey the glass lays over
 * all of it (black behind comes out so light), T how much of the light
 * behind it lets through, λ how it lifts the middle greys more than the
 * ends, g how colourful what is behind stays – more than T: a little
 * richer than it is. Light glass is Apple's, fitted; dark glass is nearly
 * clear under a light dark wash, what is behind keeping its own colours
 * (where type needs it darker, its shade dims it more), a little lighter
 * for small controls (small, blended in by smallness()); deep glass the
 * same, darker, under what is styled for a dark surface only (the control
 * centre, a sheet's form).
 */
export const FACES = {
    light: {lift: 253 / 255 * 0.403, T: 0.599, lambda: 0.216, g: 1.169},
    dark: {lift: 0.02, T: 0.66, lambda: 0, g: 0.8, small: {T: 0.72, lambda: 0}},
    clear: {lift: 0.06, T: 0.95, lambda: 0, g: 1.15},
    deep: {lift: 0.02, T: 0.36, lambda: 0, g: 0.44},
};

/**
 * @param {object|null} look - LOOK's
 * @param {object} options
 * @param {boolean} options.light - GNOME's style is light
 * @returns {string|null} which of FACES it has (null: none)
 */
export function faceOf(look, {light}) {
    if (!look)
        return null;
    if (look.face !== 'style')
        return look.face;
    return light ? 'light' : 'dark';
}

const clamp01 = v => Math.min(1, Math.max(0, v));
const smoothstep = (a, b, v) => {
    const t = clamp01((v - a) / (b - a));
    return t * t * (3 - 2 * t);
};

/** A part is a small control with a short side under this, none over (logical pixels). */
export const SMALL = Object.freeze([40, 80]);

/**
 * @param {number} side - a part's short side, logical pixels
 * @returns {number} how much a small control it is, 0 … 1 (SMALL)
 */
export function smallness(side) {
    return 1 - smoothstep(SMALL[0], SMALL[1], side);
}

// One face's transfer of a colour, [r, g, b] 0 … 1.
function transfer(rgb, {lift, T, lambda, g}) {
    const y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const grey = lift + T * y * (1 + lambda * (1 - y));
    return rgb.map(v => grey + g * (v - y));
}

/**
 * A colour behind glass as its face makes it – as the GPU's shader does it
 * (shell/core/glassMaterial.js atelier_face), before the shade, the bevel
 * and the glint.
 *
 * @param {number[]} rgb - what is behind, [r, g, b] 0 … 1 (sRGB's values)
 * @param {string} face - one of FACES
 * @param {object} [options]
 * @param {number} [options.small] - smallness() of the part
 * @param {number} [options.deep] - how deep it is, 0 … 1 (eased)
 * @returns {number[]} [r, g, b] 0 … 1
 */
export function faceColor(rgb, face, {small = 0, deep = 0} = {}) {
    const own = FACES[face];
    const values = {
        ...own,
        T: own.T + ((own.small?.T ?? own.T) - own.T) * small,
        lambda: own.lambda + ((own.small?.lambda ?? own.lambda) - own.lambda) * small,
    };
    let color = transfer(rgb, values);
    if (deep > 0) {
        const under = transfer(rgb, FACES.deep);
        color = color.map((v, i) => v + (under[i] - v) * deep);
    }
    return color.map(clamp01);
}

/**
 * How far in the lens looks, at a distance inward from the edge: a bevel
 * of glass, its curve Apple's (fitted) – the whole depth at the very edge,
 * nothing from the bevel's end in (the middle is flat, not bent). Taken
 * that far towards the middle, the outer part of the bevel (some 0.55 to
 * 0.68 of it) shows what lies farther in mirrored and squeezed.
 *
 * @param {number} d - the inward distance from the edge, pixels
 * @param {number} bevel - how far in it bends (B)
 * @param {number} depth - how far in it looks at the edge (A)
 * @returns {number} pixels
 */
export function lensDepth(d, bevel, depth) {
    if (!(bevel > 0))
        return 0;
    const u = 1 - clamp01(d / bevel);
    return depth * (1 - Math.sqrt(1 - u * u));
}

/**
 * How much of a part's short side its lens takes: small parts (a capsule
 * in the bar, the island at rest) a third of it for the bevel and looking
 * up to 0.65 of it in, so that their rim still bends and mirrors; large
 * ones a quarter and half of it (their middle flat); blended in between
 * (logical pixels).
 */
export const LENS_SHARE = Object.freeze({small: [1 / 3, 0.65], large: [1 / 4, 1 / 2], between: [64, 128]});

/**
 * The lens of a part of a surface: its bevel and depth as LOOK has them,
 * no more than its share of the part's short side (LENS_SHARE).
 *
 * @param {object} lens - LOOK's
 * @param {number} side - the part's short side, pixels
 * @param {number} [scale] - pixels in a logical pixel
 * @returns {{bevel: number, depth: number}} pixels
 */
export function lensOf(lens, side, scale = 1) {
    const t = smoothstep(LENS_SHARE.between[0] * scale, LENS_SHARE.between[1] * scale, side);
    const share = i => LENS_SHARE.small[i] + (LENS_SHARE.large[i] - LENS_SHARE.small[i]) * t;
    return {bevel: Math.min(lens.bevel * scale, side * share(0)), depth: Math.min(lens.depth * scale, side * share(1))};
}

/**
 * How the shader blurs what is behind the glass with a few taps of its
 * texture (looked up between its texels, each blending four): one where
 * there is (nearly) nothing to blur; five – the middle and four on the
 * diagonals – for a light blur; nine on a square for more. Weighted so
 * that their spread is the Gaussian's.
 *
 * @param {number} sigma - in the texture's texels
 * @returns {{taps: number, offset: number, weight: number}} offset: how
 *   far the outer taps are, texels; weight: each diagonal tap's (five),
 *   or an outer one's along each axis (nine: [w, 1 − 2w, w] across and
 *   down)
 */
export function blurTaps(sigma) {
    if (!(sigma > 0.3))
        return {taps: 1, offset: 0, weight: 0};
    if (sigma <= 1) {
        // (Each diagonal tap adds w·h² to the variance along each axis.)
        const offset = Math.max(0.75, sigma * 1.2);
        return {taps: 5, offset, weight: Math.min(0.2, sigma * sigma / (4 * offset * offset))};
    }
    const offset = sigma * Math.SQRT2;
    return {taps: 9, offset, weight: 0.25};
}

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

/** No extra shade: {dim, veil} (shadedLook()). */
export const NO_SHADE = Object.freeze({dim: 0, veil: 0});

/**
 * A look with an extra shade, as the lock screen's Cairo clock lays it on:
 * a dark veil multiplied with its own dim, a white one with its own veil –
 * each letting through what the other left. (The GPU's glass has no dim or
 * veil of its own: its shade is all there is, after its face.)
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
 * @param {object} a - a shade, {dim, veil} (or anything else eased with
 *   one: {deep}), none missing counted as 0
 * @param {object} b - another
 * @returns {boolean} whether they are the same, as far as anyone could see
 */
export function sameShade(a, b) {
    return Object.keys({...a, ...b}).every(key => Math.abs((a[key] ?? 0) - (b[key] ?? 0)) < 1e-4);
}

/**
 * What every look has at its edges, in logical pixels:
 * - bevel: inside, the glass a little darker towards its edge (amount)
 *   over this reach – its volume;
 * - glint: the light the edge catches – on the side the light comes from
 *   and, side of it, on the opposite one; least of it where the edge is
 *   side-on to the light (a thin bright rim all round) – most within near
 *   of the edge, share of it out to far: towards white (white, beyond
 *   it), what colour there is the more colourful (colour times);
 * - contour: a fine line round it outside, width wide, that absorbs light
 *   (LOOK's contour of it), the most where it is side-on to the light,
 *   least of it (least) where it faces it;
 * - shadow: under surfaces of its own (not the widgets' cards, which have
 *   one), y below it, blurred by sigma, alpha dark.
 */
export const EDGE = Object.freeze({
    bevel: {amount: 0.036, reach: 16},
    glint: {side: 0.8, least: 0.5, near: 1.0, far: 4, share: 0.25, white: 1.6, colour: 0.6},
    contour: {width: 0.75, least: 0.23},
    shadow: {y: 3.5, sigma: 8, alpha: 0.12},
});

/**
 * How far past its shapes a surface's glass draws (its contour and its
 * shadow), logical pixels.
 *
 * @param {boolean} shadow - whether it casts one
 * @returns {number}
 */
export function edgeReach(shadow) {
    return shadow ? EDGE.shadow.y + 3 * EDGE.shadow.sigma : EDGE.contour.width + 1;
}

const faceValues = ({lift, T, lambda, g}) => [lift, T, lambda, g];

/**
 * A material as the GPU's shader takes it (shell/core/glassMaterial.js):
 * vectors of four, lengths in the surface's pixels.
 *
 * @param {object|null} look - LOOK's, null for none (only the shape)
 * @param {number} [scale] - pixels in a logical pixel
 * @param {object} [options]
 * @param {boolean|number} [options.light] - GNOME's style is light: 1 (or
 *   true), dark: 0, on its way from one to the other: in between
 * @param {boolean} [options.shadow] - it casts a shadow
 * @param {number} [options.density] - texels of its texture in a pixel
 *   (the actor's resource scale)
 * @returns {object} lens [bevel, depth, dispersion, 1 for the material at
 *   all]; blur [taps, offset, weight (blurTaps(), the offset in pixels),
 *   grain]; face (in the dark style), lightFace (in the light one) and
 *   deep [lift, T, λ, g]; small [T, λ of small controls, scale, 0]; glint
 *   [most, opposite side, near, far]; edge [bevel amount, bevel reach,
 *   contour width, contour in the dark style]; style [how light, contour
 *   in the light style]; shadow [y, sigma, alpha, 0]
 */
export function materialValues(look, scale = 1, {light = false, shadow = false, density = 1} = {}) {
    if (!look) {
        const none = [0, 0, 0, 0];
        return {lens: none, blur: none, face: none, lightFace: none, small: none, deep: none, glint: none,
            edge: none, style: [0, 0], shadow: none};
    }
    const face = FACES[faceOf(look, {light: false})];
    const taps = blurTaps(look.blur * scale * density);
    return {
        lens: [look.lens.bevel * scale, look.lens.depth * scale, look.lens.dispersion, 1],
        blur: [taps.taps, taps.offset / density, taps.weight, look.grain],
        face: faceValues(face),
        lightFace: faceValues(FACES[faceOf(look, {light: true})]),
        small: [face.small?.T ?? face.T, face.small?.lambda ?? face.lambda, scale, 0],
        deep: faceValues(FACES.deep),
        glint: [look.glint, EDGE.glint.side, EDGE.glint.near * scale, EDGE.glint.far * scale],
        edge: [EDGE.bevel.amount, EDGE.bevel.reach * scale, EDGE.contour.width * scale, look.contour.dark],
        style: [Number(light), look.contour.light],
        shadow: shadow ? [EDGE.shadow.y * scale, EDGE.shadow.sigma * scale, EDGE.shadow.alpha, 0] : [0, 1, 0, 0],
    };
}

/** Where the light comes from at rest: the top left (a direction, y down). */
export const REST_LIGHT = Object.freeze([-Math.SQRT1_2, -Math.SQRT1_2]);

/**
 * Where the light comes from for a surface: from the top left, turning towards
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
 * Where an actor is in the texture an offscreen effect (the glass's
 * Shell.GLSLEffect) paints it into, along one of its sides: Clutter
 * enlarges the box it paints – its end rounded up past 0.75 px more, its
 * size rounded and 3 px more – in the actor's own pixels, and only then
 * scales it to the actor's resource scale (rounded up: 2 at 150 %). That
 * gives the texture more texels, the same frame. (Clutter's
 * clutter_offscreen_effect_pre_paint(), GNOME 48 to 50.)
 *
 * @param {number} length - the actor's width or height (for an actor that
 *   clips to its allocation: it paints from 0 to there)
 * @returns {number[]} [start, length] of the texture, in the actor's pixels
 */
export function textureFrame(length) {
    const rounded = Math.round(length);
    const end = Math.ceil(length + 0.75);
    return [end - rounded - 3, rounded + 3];
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
