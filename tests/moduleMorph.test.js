import {MAX_MODULES, easeOutExpo, fullRect, lerpRect, morphRects, sameRects} from '../lib/moduleMorph.js';
import {assert, assertEqual} from './util.js';

const rect = (id, x, y, width, height, radius = 10, more = {}) => fullRect({id, x, y, width, height, radius, ...more});
const box = r => [r.id, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];

const CAPSULE = rect('island', 900, 0, 120, 32, 0, {bottomRadius: 16, ear: 8});
const MODULES = [
    rect('tabs', 860, 10, 200, 32, 16),
    rect('connectivity', 760, 52, 166, 256, 22),
    rect('media', 936, 52, 166, 166, 22),
];

export function testEase() {
    assertEqual(easeOutExpo(0), 0, 'from where it was');
    assertEqual(easeOutExpo(1), 1, 'to where it goes');
    assert(easeOutExpo(0.3) > 0.85, 'most of the way early, as the island grows');
}

export function testCorners() {
    const r = fullRect({x: 0, y: 0, width: 40, height: 20, radius: 999});
    assertEqual([r.radius, r.bottomRadius, r.ear], [10, 10, 0], 'no rounder than half its short side');
    assert(MAX_MODULES >= 16, 'room for every module of the control centre');
}

export function testLerp() {
    const half = lerpRect(CAPSULE, MODULES[0], 0.5);
    assertEqual(box(half), ['tabs', 880, 5, 160, 32], 'halfway');
    assertEqual(half.ear, 4, 'its ears half gone');
}

export function testCapsuleSplits() {
    const start = morphRects([CAPSULE], MODULES, 0);
    assertEqual(start.map(box), MODULES.map(m => [m.id, 900, 0, 120, 32]), 'all of them the capsule to begin with');
    assertEqual(start[0].ear, 8, 'the first with its ears');
    const end = morphRects([CAPSULE], MODULES, 1);
    assert(sameRects(end, MODULES), 'the modules at the end');
    const mid = morphRects([CAPSULE], MODULES, 0.5);
    assertEqual(mid.length, 3, 'each module on its way');
    assertEqual(mid[0].id, 'tabs', 'the tabs first (they have the ears)');
}

export function testBackIntoCapsule() {
    const start = morphRects(MODULES, [CAPSULE], 0);
    assert(sameRects(start, MODULES), 'the modules to begin with');
    const end = morphRects(MODULES, [CAPSULE], 0.999);
    assert(end.every(r => Math.abs(r.x - 900) < 1 && Math.abs(r.width - 120) < 1), 'all of them the capsule at the end');
    assertEqual(morphRects(MODULES, [CAPSULE], 1).map(box), [box(CAPSULE)], 'then the capsule only');
}

export function testDetail() {
    const detail = [MODULES[0], rect('detail', 760, 52, 350, 300, 22)];
    const opening = morphRects(MODULES, detail, 0.5);
    assertEqual(opening.map(r => r.id), ['tabs', 'connectivity', 'media'], 'the modules flow into the detail\'s page');
    assert(sameRects([opening[0]], [MODULES[0]]), 'the tabs stay where they are');
    const closing = morphRects(detail, MODULES, 0);
    assertEqual(closing.map(box), [box(MODULES[0]), ['connectivity', 760, 52, 350, 300], ['media', 760, 52, 350, 300]],
        'the modules come out of the detail\'s page');
}

export function testComeAndGo() {
    const more = [...MODULES, rect('footer', 760, 320, 340, 30, 15)];
    const growing = morphRects(MODULES, more, 0);
    assertEqual(growing.length, 3, 'a new module grows out of its centre, nothing at first');
    const shrinking = morphRects(more, MODULES, 0.5);
    const footer = shrinking.find(r => r.id === 'footer');
    assert(footer && footer.width < 340 && footer.height < 30, 'one that goes shrinks into its centre');
}
