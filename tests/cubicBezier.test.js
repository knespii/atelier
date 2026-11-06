import {EASE, cubicBezier, linear} from '../lib/cubicBezier.js';
import {assert, assertEqual} from './util.js';

const near = (a, b, by = 1e-3) => Math.abs(a - b) <= by;

export function testEnds() {
    for (const [name, ease] of Object.entries(EASE)) {
        assertEqual(ease(0), 0, `${name} starts at 0`);
        assertEqual(ease(1), 1, `${name} ends at 1`);
        assertEqual(ease(-0.5), 0, `${name}: before it, 0`);
        assertEqual(ease(2), 1, `${name}: after it, 1`);
    }
    assertEqual(linear(0.3), 0.3, 'linear');
}

export function testKnownCurves() {
    // (0, 0, 1, 1) is a straight line.
    const straight = cubicBezier(0, 0, 1, 1);
    for (const t of [0.1, 0.25, 0.5, 0.9])
        assert(near(straight(t), t, 1e-5), `straight at ${t}`);
    // CSS's ease-in-out is symmetric: half way at half the time.
    const inOut = cubicBezier(0.42, 0, 0.58, 1);
    assert(near(inOut(0.5), 0.5, 1e-5), 'ease-in-out half way at half the time');
    assert(near(inOut(0.25) + inOut(0.75), 1, 1e-5), 'and symmetric');
    // CSS's ease, as browsers have it: 0.8024 at half the time.
    assert(near(EASE.ease(0.5), 0.8024, 2e-3), `ease at 0.5 (${EASE.ease(0.5)})`);
}

export function testOvershoot() {
    // The springs go past 1 and come back.
    for (const name of ['grab', 'release', 'rubber', 'spring', 'settle']) {
        const ease = EASE[name];
        let peak = 0;
        for (let t = 0; t <= 1; t += 0.01)
            peak = Math.max(peak, ease(t));
        assert(peak > 1.01, `${name} overshoots (${peak.toFixed(3)})`);
    }
    let peak = 0;
    for (let t = 0; t <= 1; t += 0.005)
        peak = Math.max(peak, EASE.rubber(t));
    assert(peak > 1.15 && peak < 1.4, `the rubber's spring well past (${peak.toFixed(3)})`);
    // ease.out never does.
    for (let t = 0; t <= 1; t += 0.01)
        assert(EASE.out(t) <= 1 + 1e-9, `ease.out stays at or under 1 (${t})`);
}

export function testMonotonicTime() {
    // The steepest of the springs still solves smoothly (no NaN, no jump).
    const steep = cubicBezier(0.3, 1.8, 0.4, 1);
    let last = 0;
    for (let t = 0; t <= 1; t += 0.001) {
        const v = steep(t);
        assert(Number.isFinite(v), `finite at ${t}`);
        assert(Math.abs(v - last) < 0.05, `continuous at ${t.toFixed(3)}`);
        last = v;
    }
}
