import {PAGE, STEP, dragLevel, fillTop, levelAt, levelOf, splitAt, stepped, valueOf} from '../lib/levelCapsule.js';
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

export function testDragAndClick() {
    assertEqual(dragLevel(0.5, -50, 200), 0.75, 'dragged up a quarter of its height: a quarter fuller');
    assertEqual(dragLevel(0.5, 100, 200), 0, 'down half: empty');
    assertEqual(dragLevel(0.9, -100, 200), 1, 'no more than full');
    assertEqual(dragLevel(0.3, 10, 0), 0.3, 'no height: as it was');
    assertEqual(levelAt(0, 200), 1, 'clicked at the top: full');
    assertEqual(levelAt(150, 200), 0.25, 'a quarter up: a quarter');
    assertEqual(levelAt(250, 200), 0, 'below it: empty');
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
