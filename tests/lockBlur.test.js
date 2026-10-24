import {MAX_RADIUS, blurDownscale, blurSteps} from '../lib/lockBlur.js';
import {assertEqual} from './util.js';

export function testBlurDownscale() {
    // As GNOME's blur has it on a 1920 × 1080 wallpaper: drawn as it is up
    // to 12 pixels, then half as large for each doubling.
    const at = radii => radii.map(radius => blurDownscale(1920, 1080, radius));
    assertEqual(at([0, 1, MAX_RADIUS, MAX_RADIUS + 1, 24, 25, 48, 49, 90, 200]), [1, 1, 1, 2, 2, 4, 4, 8, 8, 8],
        'smaller past each doubling, never under 256 pixels');
    // (A smaller monitor: it stops sooner.)
    assertEqual([24, 25, 90].map(radius => blurDownscale(1280, 720, radius)), [2, 4, 4], 'stops at 256 pixels high');
    assertEqual(blurDownscale(200, 200, 90), 1, 'too small to draw smaller');
}

export function testBlurSteps() {
    assertEqual(blurSteps(1920, 1080, 90), [1, 2, 4, 8], 'four sizes on the way to GNOME\'s 90');
    // (The user's laptop at 150 %: 2560 × 1600 pixels, laid out at 1707 × 1067.)
    assertEqual(blurSteps(1707, 1067, 90), [1, 2, 4, 8], 'as many on a laptop at 150 %');
    assertEqual(blurSteps(1280, 720, 90), [1, 2, 4], 'fewer on a small one');
    assertEqual(blurSteps(1920, 1080, 12), [1], 'one up to 12');
    assertEqual(blurSteps(1920, 1080, 0), [], 'none without a blur');
}
