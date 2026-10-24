// GNOME's blur (Shell.BlurEffect, src/shell-blur-effect.c, the same in
// GNOME 48 to 50) blurs a picture drawn smaller the larger the radius: half
// as large for each doubling of the radius past MAX_RADIUS, as long as the
// picture stays larger than MIN_SIZE each way. Whenever that size changes it
// makes what it draws into anew – on a large monitor, a frame of its own.
// Pure, for the lock screen's wallpaper turning to glass
// (shell/lockscreen/glass.js), which keeps a blur for each of those sizes.

/** As GNOME's blur has them. */
export const MAX_RADIUS = 12;
export const MIN_SIZE = 256;

/**
 * @param {number} width - of what is blurred (as it is laid out), pixels
 * @param {number} height
 * @param {number} radius - the blur's
 * @returns {number} how many times smaller GNOME's blur draws it, blurred
 *   that much (calculate_downscale_factor())
 */
export function blurDownscale(width, height, radius) {
    let factor = 1;
    while (radius / factor > MAX_RADIUS && width / factor > MIN_SIZE && height / factor > MIN_SIZE)
        factor *= 2;
    return factor;
}

/**
 * @param {number} width - of what is blurred, pixels
 * @param {number} height
 * @param {number} radius - the most it is blurred
 * @returns {number[]} how many times smaller GNOME's blur draws it on the
 *   way there, blurred by a pixel and more: each once, the least first
 *   (none for no blur)
 */
export function blurSteps(width, height, radius) {
    const steps = [];
    for (let r = 1; r <= radius; r++) {
        const factor = blurDownscale(width, height, r);
        if (steps.at(-1) !== factor)
            steps.push(factor);
    }
    return steps;
}
