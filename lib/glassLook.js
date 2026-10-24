// How Atelier's glass looks – Liquid Glass, as iOS 26 has it: what is
// behind it bends at its edges as through a lens (more so for red than for
// blue: a hint of colour at the very rim), richer and lighter; its edges
// catch a light from above (strongly at the top, faintly at the bottom, in
// between at the sides) that leans towards the pointer; a soft sheen runs
// across it; a fine grain keeps its gradients from banding. One look for
// every surface – drawn on the GPU (shell/core/glassMaterial.js) or with
// Cairo (the lock screen's clock, shell/lockscreen/liquidGlass.js) – in
// three variants, as Apple's: regular, clear and off. Pure, shared by the
// shell and the preferences.

/** The variants, as the glass-variant setting has them. */
export const VARIANTS = ['regular', 'clear', 'off'];

/**
 * The material of each variant (none for 'off': solid surfaces). Lengths
 * in logical pixels; alphas and factors 0 … 1 unless said otherwise.
 *
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
 *   alpha at its start, and how far across it fades out (0 … 1)
 * - grain: the amplitude of the fine noise
 * - light.lean: how far (0 … 1) the light turns towards the pointer when
 *   it is near; light.near: how near that is
 */
export const LOOK = {
    regular: {
        saturation: 1.8,
        brightness: 1.15,
        veil: 0.08,
        dim: 0,
        lens: {width: 14, shift: 10},
        aberration: 0.35,
        rim: {top: 0.6, bottom: 0.2, side: 0.3, width: 1.5},
        sheen: {angle: 135, alpha: 0.4, reach: 0.4},
        grain: 0.02,
        light: {lean: 0.35, near: 160},
    },
    clear: {
        saturation: 1.4,
        brightness: 1.05,
        veil: 0.03,
        dim: 0.12,
        lens: {width: 14, shift: 12},
        aberration: 0.35,
        rim: {top: 0.5, bottom: 0.15, side: 0.25, width: 1.5},
        sheen: {angle: 135, alpha: 0.25, reach: 0.4},
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
