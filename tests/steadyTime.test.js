import {Curve, onTime, steadyDelta} from '../lib/steadyTime.js';
import {assert, assertEqual} from './util.js';

const FRAME = 1000 / 60;

export function testOnTime() {
    assert(onTime(FRAME, FRAME) && onTime(2 * FRAME, FRAME), 'a frame or two: on time');
    assert(!onTime(3 * FRAME, FRAME), 'three frames\' time: late');
    assert(!onTime(600, FRAME), 'the shell stopped a moment: late');
}

export function testSteadyDelta() {
    assertEqual(steadyDelta(FRAME, FRAME), FRAME, 'a frame on time counts as long as it took');
    assertEqual(steadyDelta(0, FRAME), 0, 'the first one, nothing');
    assertEqual(steadyDelta(2 * FRAME, FRAME), 2 * FRAME, 'a dropped frame counts too');
    assertEqual(steadyDelta(600, FRAME), FRAME, 'after a stop, as one frame only');
    assertEqual(steadyDelta(600, 0), 600, 'without a refresh rate, by the clock');
    // A 700 ms animation, the shell stopping 600 ms 50 ms in: it plays on.
    let elapsed = 0;
    for (const delta of [0, 16, 17, 17, 600, 17, 16])
        elapsed += steadyDelta(delta, FRAME);
    assert(elapsed < 120, `the stop takes only a frame of it (${elapsed} ms)`);
}

export function testCurves() {
    for (const [name, curve] of Object.entries(Curve)) {
        assert(Math.abs(curve(0)) < 1e-9 && Math.abs(curve(1) - 1) < 1e-9, `${name} goes from 0 to 1`);
        for (let i = 0; i < 10; i++)
            assert(curve((i + 1) / 10) > curve(i / 10), `${name} only goes up`);
    }
    assert(Curve.easeOutCubic(0.5) > 0.5 && Curve.easeInCubic(0.5) < 0.5, 'out fast first, in slow first');
    assert(Math.abs(Curve.easeInOutSine(0.5) - 0.5) < 1e-9, 'in and out: half-way at half-time');
}
