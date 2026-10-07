import {gather, overflow, pour, spread} from '../lib/liquid.js';
import {assert, assertEqual} from './util.js';

const look = {radius: 22, blend: 18};
const card = [10, 20, 176, 176];

export function testPour() {
    const to = [500, 20, 176, 176];
    assertEqual(pour(card, to, 0, look).boxes, [[98, 108, 88, 88, 22, 18]], 'the card where it was');
    assertEqual(pour(card, to, 1, look), {boxes: [[588, 108, 88, 88, 22, 0]], capsules: []}, 'the card where it goes');
    const midway = pour(card, to, 0.5, look);
    assert(midway.capsules.length === 1 && midway.boxes.length === 3, 'mid-way: drained, a stream, filling');
    const [, , w0] = pour(card, to, 0.3, look).boxes[0];
    const [, , w1] = pour(card, to, 0.5, look).boxes[0];
    assert(w1 < w0, 'it runs out where it was');
}

export function testGatherAndSpread() {
    assertEqual(gather(card, 0, look).boxes, [[98, 108, 88, 88, 22, 0]]);
    assertEqual(gather(card, 1, look).boxes, [], 'gone');
    const [, , hx, hy, radius] = gather([0, 0, 368, 176], 0.8, look).boxes[0];
    assert(Math.abs(hx - hy) < 0.25 * Math.max(hx, hy) && radius >= Math.min(hx, hy) - 0.01, 'round, nearly');
    assertEqual(spread(card, 1, look).boxes, [[98, 108, 88, 88, 22, 0]], 'spread, the card');
    assertEqual(spread(card, 0, look).boxes, [], 'nothing yet');
}

export function testOverflow() {
    const bar = [100, 900, 600, 90];
    const panel = [150, 700, 400, 170];
    const options = {drop: 16, blend: 20};
    assertEqual(overflow(bar, 28, panel, 28, 180, 0, options), {boxes: [[400, 945, 300, 45, 28, 0]], capsules: []});
    const end = overflow(bar, 28, panel, 28, 180, 1, options);
    assertEqual(end.boxes[1], [350, 785, 200, 85, 28, 0], 'the panel, apart from the bar');
    assertEqual(end.capsules, []);
    const hanging = overflow(bar, 28, panel, 28, 180, 0.35, options);
    assert(hanging.capsules.length === 1 && hanging.boxes[1][1] < 900, 'a drop above the bar, on a neck');
}
