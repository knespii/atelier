import {BUMP_SCALE, PAGE, STEP, STRETCH, bumpScale, bumps, fillTop, iconCovered, levelOf, originOf,
    pointerLevel, sendDelay, speakerParts, splitAt, stepped, stretchOf, sunRays, valueOf} from '../lib/levelCapsule.js';
import {EASE, linear} from '../lib/cubicBezier.js';
import {assert, assertEqual} from './util.js';

const near = (a, b) => Math.abs(a - b) < 1e-9;

export function testLevelAndValue() {
    assertEqual(levelOf(0.5), 0.5, 'a slider of 0 … 1 as it is');
    assertEqual(levelOf(0.75, 1.5), 0.5, 'the volume over 100 %: of its whole range');
    assertEqual(levelOf(2), 1, 'no more than full');
    assertEqual(levelOf(-1), 0, 'no less than empty');
    assertEqual(levelOf(0.5, 0), 0, 'no range: empty');
    assertEqual(levelOf(NaN), 0, 'nothing: empty');
    assertEqual(valueOf(0.5, 1.5), 0.75, 'and back');
    assertEqual(valueOf(1.2), 1, 'clamped');
}

export function testPointer() {
    // A capsule from y 100 to 300.
    assertEqual(pointerLevel(200, 100, 300), {raw: 50, value: 50, over: 0}, 'half way up: half');
    assertEqual(pointerLevel(150, 100, 300), {raw: 75, value: 75, over: 0}, 'three quarters');
    assertEqual(pointerLevel(100, 100, 300).value, 100, 'at the top: full');
    assertEqual(pointerLevel(300, 100, 300).value, 0, 'at the bottom: empty');
    assertEqual(pointerLevel(201, 100, 300).value, 50, 'whole percent (49.5 rounds to 50)');
    const above = pointerLevel(50, 100, 300);
    assertEqual([above.value, above.over], [100, 25], 'a quarter of its height above: full, 25 % over');
    const below = pointerLevel(340, 100, 300);
    assertEqual([below.value, below.over], [0, -20], 'below: empty, 20 % under');
    assertEqual(pointerLevel(200, 100, 100), {raw: 0, value: 0, over: 0}, 'no height: empty, not over');
}

export function testStretch() {
    assertEqual(stretchOf(0), 1, 'not over: as it is');
    assert(near(stretchOf(25), 1 + STRETCH * (1 - Math.exp(-1))), 'the spec\'s formula');
    assert(Math.abs(stretchOf(25) - 1.0569) < 1e-3, `25 % over: about 5.7 % (${stretchOf(25)})`);
    assertEqual(stretchOf(-25), stretchOf(25), 'under as over');
    assert(stretchOf(1e6) <= 1 + STRETCH && stretchOf(1e6) > 1.0899, 'never past 9 %');
    assert(stretchOf(10) < stretchOf(20) && stretchOf(20) - stretchOf(10) < stretchOf(10) - 1,
        'grows fast at first, then less');
    assertEqual(originOf(5, 'top'), 'bottom', 'over the top: the bottom holds');
    assertEqual(originOf(-5, 'bottom'), 'top', 'under: the top holds');
    assertEqual(originOf(0, 'top'), 'top', 'neither: as it was');
}

export function testBump() {
    assert(bumps(100, 99) && bumps(0, 3) && bumps(0, null), 'reaching an end bumps');
    assert(!bumps(100, 100) && !bumps(0, 0), 'staying there does not');
    assert(!bumps(50, 0), 'leaving it does not');
    assertEqual(bumpScale(0, linear), 1, 'starts at 1');
    assert(near(bumpScale(0.4, linear), BUMP_SCALE), 'up at 40 %');
    assertEqual(bumpScale(1, linear), 1, 'back at the end');
    assert(Math.abs(bumpScale(0.2, linear) - 1.15) < 1e-9, 'half way up');
    assert(bumpScale(0.3, EASE.bump) > bumpScale(0.3, linear), 'its spring early');
}

export function testIcons() {
    assert(!iconCovered(0.17) && iconCovered(0.18), 'the icon dark past 17 %');
    assertEqual(sunRays(0), {angle: 0, scale: 0.6}, 'no brightness: small rays, upright');
    assertEqual(sunRays(100), {angle: 90, scale: 1}, 'full: whole, a quarter turn');
    assertEqual(sunRays(50), {angle: 45, scale: 0.8}, 'half');
    assertEqual(speakerParts(0), {wave1: false, wave2: false, cross: true}, 'muted: the cross');
    assertEqual(speakerParts(30), {wave1: true, wave2: false, cross: false}, 'a wave');
    assertEqual(speakerParts(51), {wave1: true, wave2: true, cross: false}, 'two');
    assertEqual(speakerParts(50).wave2, false, 'the second only past half');
}

export function testSending() {
    assertEqual(sendDelay(1000, null), 0, 'the first at once');
    assertEqual(sendDelay(1000, 1000 - 40), 0, 'after a while, at once');
    assert(Math.abs(sendDelay(1000, 990) - (1000 / 30 - 10)) < 1e-9, 'too soon: when it may');
}

export function testKeys() {
    assert(near(stepped(0.5, STEP), 0.55), 'Up: a step');
    assert(near(stepped(0.53, STEP), 0.55), 'onto the steps\' grid');
    assert(near(stepped(0.53, -STEP), 0.5), 'Down too');
    assert(near(stepped(0.5, -STEP), 0.45), 'Down from one');
    assert(near(stepped(0.5, PAGE), 0.6), 'Page Up');
    assertEqual(stepped(0.98, STEP), 1, 'no more than full');
    assertEqual(stepped(0.01, -PAGE), 0, 'no less than empty');
    assertEqual(stepped(0.4, Infinity), 1, 'End');
    assertEqual(stepped(0.4, -Infinity), 0, 'Home');
}

export function testFillAndIcon() {
    assertEqual(fillTop(0, 200), 200, 'empty: no fill');
    assertEqual(fillTop(1, 200), 0, 'full: all of it');
    assertEqual(fillTop(0.25, 200), 150, 'a quarter: the bottom quarter');
    // An icon 22 px tall, its top 160 px down a capsule 200 px tall.
    assertEqual(splitAt(200, 160, 22), {glass: {y: 0, height: 22}, fill: {y: 22, height: 0}},
        'the fill under it: all on the glass');
    assertEqual(splitAt(100, 160, 22), {glass: {y: 0, height: 0}, fill: {y: 0, height: 22}},
        'the fill over it: all on the fill');
    assertEqual(splitAt(170, 160, 22), {glass: {y: 0, height: 10}, fill: {y: 10, height: 12}},
        'the fill\'s edge across it: split there');
}
