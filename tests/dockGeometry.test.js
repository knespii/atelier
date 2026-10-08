import {
    barrierLine, dockRect, dropIndex, edgeRect, fitIconSize, hiddenOffset, isHorizontal, labelPosition,
    maxLength, pickMonitors, pointerInZone, rectsOverlap, strutRect,
} from '../lib/dockGeometry.js';
import {assert, assertEqual} from './util.js';

// A monitor right of another one, so offsets show.
const monitor = {x: 1920, y: 0, width: 1600, height: 1000};
const SIDES = ['TOP', 'RIGHT', 'BOTTOM', 'LEFT'];

export function testSides() {
    assert(isHorizontal('TOP') && isHorizontal('BOTTOM'), 'top and bottom are rows');
    assert(!isHorizontal('LEFT') && !isHorizontal('RIGHT'), 'left and right are columns');
}

export function testDockRect() {
    const params = {area: monitor, length: 600, thickness: 60, margin: 8};
    assertEqual(dockRect({...params, side: 'BOTTOM'}), {x: 2420, y: 932, width: 600, height: 60}, 'bottom');
    assertEqual(dockRect({...params, side: 'TOP'}), {x: 2420, y: 8, width: 600, height: 60}, 'top');
    assertEqual(dockRect({...params, side: 'LEFT'}), {x: 1928, y: 200, width: 60, height: 600}, 'left');
    assertEqual(dockRect({...params, side: 'RIGHT'}), {x: 3452, y: 200, width: 60, height: 600}, 'right');
    // Panel mode: all of the edge, at the edge.
    assertEqual(dockRect({...params, side: 'BOTTOM', extend: true}), {x: 1920, y: 940, width: 1600, height: 60});
    assertEqual(dockRect({...params, side: 'RIGHT', extend: true}), {x: 3460, y: 0, width: 60, height: 1000});
    // Fractions of pixels: the size rounded up, the place to the nearest.
    assertEqual(dockRect({...params, side: 'BOTTOM', length: 600.5, thickness: 59.2}),
        {x: 2420, y: 933, width: 601, height: 60});
}

export function testMaxLength() {
    assertEqual(maxLength(monitor, 'BOTTOM', 0.9), 1440);
    assertEqual(maxLength(monitor, 'LEFT', 0.9), 900);
    assertEqual(maxLength(monitor, 'TOP', 0.3), 480);
    assertEqual(maxLength(monitor, 'RIGHT', 0.3, true), 1000, 'panel mode: all of it');
    assertEqual(maxLength(monitor, 'BOTTOM', 2), 1600, 'never more than the edge');
}

export function testFitIconSize() {
    const fit = (count, available, extra = {}) =>
        fitIconSize({count, maxSize: 48, available, itemPadding: 8, spacing: 2, extras: 16, ...extra});
    assertEqual(fit(5, 1440), 48, 'room enough: the size asked for');
    // 5 × (48 + 8) + 4 × 2 + 16 = 304
    assertEqual(fit(5, 304), 48, 'just enough');
    assertEqual(fit(5, 303), 40, 'a pixel too few: the next smaller');
    assertEqual(fit(20, 300), 16, 'nothing fits: the smallest');
    assertEqual(fit(30, 300, {fixed: true}), 48, 'fixed: the size asked for');
    assertEqual(fit(0, 10), 48, 'no icons');
    assertEqual(fitIconSize({count: 3, maxSize: 45, available: 1000}), 45, 'a size of its own is kept');
    assertEqual(fitIconSize({count: 3, maxSize: 45, available: 3 * 40}), 40, 'then the sizes below it');
    assertEqual(fitIconSize({count: 3, maxSize: 20, available: 10}), 16);
}

export function testHiddenOffset() {
    assertEqual(hiddenOffset('BOTTOM', 60, 8), {x: 0, y: 70});
    assertEqual(hiddenOffset('TOP', 60, 8), {x: 0, y: -70});
    assertEqual(hiddenOffset('LEFT', 60, 8), {x: -70, y: 0});
    assertEqual(hiddenOffset('RIGHT', 60, 8), {x: 70, y: 0});
    // Away: none of it is left on the monitor.
    for (const side of SIDES) {
        const rect = dockRect({area: monitor, side, length: 600, thickness: 60, margin: 8});
        const {x, y} = hiddenOffset(side, 60, 8);
        const moved = {...rect, x: rect.x + x, y: rect.y + y};
        assert(!rectsOverlap(moved, monitor), `away off the monitor (${side})`);
    }
}

export function testEdgeRect() {
    const rect = {x: 2420, y: 932, width: 600, height: 60};
    assertEqual(edgeRect('BOTTOM', monitor, rect, 1), {x: 2420, y: 999, width: 600, height: 1});
    assertEqual(edgeRect('TOP', monitor, rect, 2), {x: 2420, y: 0, width: 600, height: 2});
    const column = {x: 1928, y: 200, width: 60, height: 600};
    assertEqual(edgeRect('LEFT', monitor, column, 1), {x: 1920, y: 200, width: 1, height: 600});
    assertEqual(edgeRect('RIGHT', monitor, column, 1), {x: 3519, y: 200, width: 1, height: 600});
}

export function testBarrierLine() {
    const rect = {x: 2420, y: 932, width: 600, height: 60};
    assertEqual(barrierLine('BOTTOM', monitor, rect),
        {x1: 2421, y1: 1000, x2: 3019, y2: 1000, direction: 'NEGATIVE_Y'});
    assertEqual(barrierLine('TOP', monitor, rect), {x1: 2421, y1: 0, x2: 3019, y2: 0, direction: 'POSITIVE_Y'});
    const column = {x: 1928, y: 200, width: 60, height: 600};
    assertEqual(barrierLine('LEFT', monitor, column), {x1: 1921, y1: 201, x2: 1921, y2: 799, direction: 'POSITIVE_X'});
    assertEqual(barrierLine('RIGHT', monitor, column), {x1: 3519, y1: 201, x2: 3519, y2: 799, direction: 'NEGATIVE_X'});
}

export function testStrutRect() {
    for (const side of SIDES) {
        const rect = dockRect({area: monitor, side, length: 600, thickness: 60, margin: 8});
        const strut = strutRect(side, monitor, rect, 4);
        // From the edge, along all of it, past the dock by the margin.
        const depth = isHorizontal(side) ? strut.height : strut.width;
        assertEqual(depth, 60 + 8 + 4, `as deep as the dock, its margin and the margin (${side})`);
        const along = isHorizontal(side) ? strut.width : strut.height;
        assertEqual(along, isHorizontal(side) ? monitor.width : monitor.height, `along all of the edge (${side})`);
        assert(strut.x >= monitor.x && strut.y >= monitor.y && strut.x + strut.width <= monitor.x + monitor.width &&
            strut.y + strut.height <= monitor.y + monitor.height, `on the monitor (${side})`);
        assert(rectsOverlap(strut, rect), `over the dock (${side})`);
    }
    assertEqual(strutRect('BOTTOM', monitor, {x: 1920, y: 940, width: 1600, height: 60}, 0),
        {x: 1920, y: 940, width: 1600, height: 60}, 'panel mode, no margin');
}

export function testPointerInZone() {
    const rect = {x: 2420, y: 932, width: 600, height: 60};
    assert(pointerInZone('BOTTOM', monitor, rect, 2500, 999), 'below the dock, at the edge');
    assert(pointerInZone('BOTTOM', monitor, rect, 2500, 940), 'on it');
    assert(!pointerInZone('BOTTOM', monitor, rect, 2500, 900), 'above it');
    assert(!pointerInZone('BOTTOM', monitor, rect, 2400, 999), 'beside it');
    const top = {...rect, y: 8};
    assert(pointerInZone('TOP', monitor, top, 2500, 0) && !pointerInZone('TOP', monitor, top, 2500, 80), 'top');
    const left = {x: 1928, y: 200, width: 60, height: 600};
    assert(pointerInZone('LEFT', monitor, left, 1920, 300) && !pointerInZone('LEFT', monitor, left, 2000, 300), 'left');
    assert(!pointerInZone('LEFT', monitor, left, 1920, 100), 'left, above it');
    const right = {...left, x: 3452};
    assert(pointerInZone('RIGHT', monitor, right, 3519, 300) && !pointerInZone('RIGHT', monitor, right, 3440, 300),
        'right');
}

export function testRectsOverlap() {
    const a = {x: 0, y: 0, width: 10, height: 10};
    assert(rectsOverlap(a, {x: 5, y: 5, width: 10, height: 10}));
    assert(!rectsOverlap(a, {x: 10, y: 0, width: 10, height: 10}), 'touching');
    assert(!rectsOverlap(a, {x: 0, y: 20, width: 10, height: 10}));
}

export function testDropIndex() {
    const centres = [100, 200, 300];
    assertEqual(dropIndex('BOTTOM', false, centres, 50), 0);
    assertEqual(dropIndex('BOTTOM', false, centres, 150), 1);
    assertEqual(dropIndex('BOTTOM', false, centres, 1000), 3, 'past the last: at the end');
    assertEqual(dropIndex('LEFT', false, centres, 250), 2, 'a column: by y');
    assertEqual(dropIndex('BOTTOM', false, [100, null, 300], 150), 2, 'one not in it is skipped');
    // Right to left: the first pinned app on the right.
    const rtl = [300, 200, 100];
    assertEqual(dropIndex('BOTTOM', true, rtl, 350), 0);
    assertEqual(dropIndex('TOP', true, rtl, 250), 1);
    assertEqual(dropIndex('BOTTOM', true, rtl, 50), 3);
    assertEqual(dropIndex('RIGHT', true, centres, 150), 1, 'a column reads down in either direction');
}

export function testLabelPosition() {
    const stage = {width: 3520, height: 1000};
    const item = {x: 2500, y: 940, width: 56, height: 56};
    const label = {width: 100, height: 30};
    assertEqual(labelPosition('BOTTOM', item, label, 6, stage), {x: 2478, y: 904}, 'above');
    assertEqual(labelPosition('TOP', {...item, y: 8}, label, 6, stage), {x: 2478, y: 70}, 'below');
    const column = {x: 1928, y: 500, width: 56, height: 56};
    assertEqual(labelPosition('LEFT', column, label, 6, stage), {x: 1990, y: 513}, 'to the right');
    assertEqual(labelPosition('RIGHT', {...column, x: 3456}, label, 6, stage), {x: 3350, y: 513}, 'to the left');
    assertEqual(labelPosition('BOTTOM', {...item, x: 3490}, label, 6, stage).x, 3420, 'kept on the stage');
}

export function testPickMonitors() {
    assertEqual(pickMonitors({mainIndex: 1, multi: false, count: 3}), [1]);
    assertEqual(pickMonitors({mainIndex: 1, multi: true, count: 3}), [1, 0, 2], 'the main one first');
    assertEqual(pickMonitors({mainIndex: 5, multi: false, count: 2}), [0], 'one that isn\'t there: the first');
    assertEqual(pickMonitors({mainIndex: -1, multi: true, count: 2}), [0, 1]);
    assertEqual(pickMonitors({mainIndex: 0, multi: true, count: 0}), [], 'no monitors');
}
