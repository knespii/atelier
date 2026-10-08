// How a see-through surface of glass gives way as it is made less opaque:
// first the tint over the blurred wallpaper goes, then the glass itself –
// at nothing, the wallpaper is clear. Pure, shared by the dock, the
// widgets and the tests.

/** Below this opacity the glass itself fades; above it, the tint comes in. */
export const GLASS_FULL = 0.4;

const clamp01 = value => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/**
 * @param {number} opacity - how opaque the surface is, 0–1
 * @returns {object} {glass, tint}: how much of the glass shows, and how
 *   much of the tint over it, each 0–1
 */
export function glassShare(opacity) {
    const value = clamp01(opacity);
    return {
        glass: Math.min(1, value / GLASS_FULL),
        tint: Math.max(0, (value - GLASS_FULL) / (1 - GLASS_FULL)),
    };
}
