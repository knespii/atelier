import {falloff, magnify} from '../lib/dockMagnify.js';
import {assert, assertEqual} from './util.js';

const near = (a, b) => Math.abs(a - b) < 0.001;

export function testFalloff() {
    assertEqual([falloff(0, 2), falloff(2, 2), falloff(3, 2), falloff(1, 0)], [1, 0, 0, 0]);
    assert(near(falloff(1, 2), 0.5) && near(falloff(-1, 2), 0.5), 'half way, half of it, either side');
}

export function testMagnify() {
    // Five icons of 60 px, 4 px apart.
    const centers = [30, 94, 158, 222, 286];
    const rest = magnify({centers, size: 60, pointer: null, scale: 1.5, spread: 2});
    assertEqual(rest, {scales: [1, 1, 1, 1, 1], offsets: [0, 0, 0, 0, 0]}, 'the pointer away: at rest');
    const {scales, offsets} = magnify({centers, size: 60, pointer: 158, scale: 1.5, spread: 2.5, give: 8});
    assert(near(scales[2], 1.5) && scales[1] > 1 && scales[1] < 1.5 && near(scales[1], scales[3]),
        'the icon under the pointer most, those beside it less, evenly');
    assert(near(offsets[2], 0), 'the middle one stays put');
    assert(offsets[1] < 0 && offsets[3] > 0 && near(offsets[1], -offsets[3]), 'the others move apart');
    // The row keeps its length, give or take the give: its ends (with the
    // icons as drawn) no further out than that.
    const first = centers[0] + offsets[0] - 30 * scales[0];
    const last = centers[4] + offsets[4] + 30 * scales[4];
    assert(first >= -9 && first < 0 && last <= 325 && last > 316, `the ends a little further out (${first}, ${last})`);
    const wide = magnify({centers, size: 60, pointer: 158, scale: 1.5, spread: 2.5, give: 500});
    assert(wide.offsets[4] > offsets[4], 'with room enough, the row spreads all the way');
    const flat = magnify({centers, size: 60, pointer: 158, scale: 1, spread: 2});
    assertEqual(flat.scales, [1, 1, 1, 1, 1], 'no magnification');
}
