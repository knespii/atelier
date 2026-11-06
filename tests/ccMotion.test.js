import {CURVES, OPEN_DELAYS, REDUCED_DURATION, Tween, cubicBezier, easeOf, rowDelays, transitionOf} from '../lib/ccMotion.js';
import {assert, assertEqual} from './util.js';

const near = (a, b, by = 1e-4) => Math.abs(a - b) < by;

export function testBezierEnds() {
    for (const [name, curve] of Object.entries(CURVES)) {
        const ease = cubicBezier(...curve);
        assertEqual(ease(0), 0, `${name} starts at 0`);
        assertEqual(ease(1), 1, `${name} ends at 1`);
        assertEqual(ease(-1), 0, `${name} before it starts`);
        assertEqual(ease(2), 1, `${name} after it ends`);
    }
}

export function testBezierKnownValues() {
    // CSS's ease (.25, .1, .25, 1) halfway: 0.8024 (as browsers have it).
    assert(near(cubicBezier(0.25, 0.1, 0.25, 1)(0.5), 0.8024, 1e-3), 'CSS ease at 0.5');
    // Linear is linear.
    const linear = cubicBezier(0, 0, 1, 1);
    for (const t of [0.1, 0.33, 0.5, 0.9])
        assert(near(linear(t), t), `linear at ${t}`);
    // Symmetric ease-in-out: halfway at halfway.
    assert(near(cubicBezier(0.42, 0, 0.58, 1)(0.5), 0.5), 'ease-in-out halfway');
}

export function testBezierOvershoots() {
    // The spring (.3, .7, .3, 1.3) goes past 1 and settles back.
    const spring = easeOf('spring');
    let peak = 0;
    for (let t = 0; t <= 1; t += 0.01)
        peak = Math.max(peak, spring(t));
    assert(peak > 1.02 && peak < 1.2, `the spring overshoots a little (${peak.toFixed(3)})`);
    // The morph (.2, .9, .25, 1.05) only just.
    let morphPeak = 0;
    for (let t = 0; t <= 1; t += 0.01)
        morphPeak = Math.max(morphPeak, easeOf('morph')(t));
    assert(morphPeak > 1 && morphPeak < 1.02, `the morph only just (${morphPeak.toFixed(4)})`);
    // Ease out never does.
    for (let t = 0; t <= 1; t += 0.01)
        assert(easeOf('out')(t) <= 1 + 1e-9, 'ease out stays at or below 1');
    // Monotonic in time where x is (the solver finds each t's s).
    let last = -1;
    for (let t = 0; t <= 0.5; t += 0.01) {
        const v = easeOf('morph')(t);
        assert(v >= last - 1e-9, 'the morph goes on up while it rises');
        last = v;
    }
}

export function testTweenGoesOnFromWhereItIs() {
    const ease = easeOf('morph');
    const out = new Tween({from: 0, to: 100, start: 0, duration: 480, ease});
    assertEqual(out.valueAt(-10), 0, 'before its start: where it starts');
    assertEqual(out.valueAt(480), 100, 'at its end: there');
    assert(out.doneAt(480) && !out.doneAt(479), 'done at its end');
    // Turned round halfway: back from where it is, no jump.
    const halfway = out.valueAt(240);
    const back = new Tween({from: halfway, to: 0, start: 240, duration: 480, ease});
    assert(near(back.valueAt(240), halfway), 'turned round, it goes on from where it was');
    assert(back.valueAt(300) < halfway, 'and back the way it came');
    // A delay: where it starts until then.
    const later = new Tween({from: 1, to: 2, start: 100, delay: 60, duration: 100});
    assertEqual(later.valueAt(150), 1, 'waiting out its delay');
    assert(near(later.valueAt(210), 1.5), 'then on its way');
    assert(!later.doneAt(250) && later.doneAt(260), 'done after its delay and duration');
    // No duration: there at once.
    assertEqual(new Tween({from: 3, to: 7, start: 0, duration: 0}).valueAt(0), 7, 'no duration: there at once');
}

export function testReducedMotion() {
    assertEqual(transitionOf('spring', 380, 60, false), {curve: 'spring', duration: 380, delay: 60}, 'as it is');
    assertEqual(transitionOf('spring', 380, 60, true), {curve: 'out', duration: REDUCED_DURATION, delay: 0},
        'reduced: eased out, shorter, at once');
    assertEqual(transitionOf('fade', 100, 0, true), {curve: 'fade', duration: 100, delay: 0},
        'a short fade stays as short');
}

export function testDelays() {
    assertEqual(rowDelays(4), [90, 140, 190, 250], 'Wi-Fi: three networks, then Other network…');
    assertEqual(rowDelays(3, {first: 80, lastApart: false}), [80, 130, 180], 'the outputs');
    assertEqual(rowDelays(1), [90], 'one row');
    assertEqual(Object.values(OPEN_DELAYS), [60, 60, 110, 140, 160, 190, 220, 260, 300],
        'the panel opening, in order (Wired as Wi-Fi, in its place)');
}
