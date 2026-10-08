import {badgeText, dominantColor, indicatorShapes} from '../lib/dockIndicators.js';
import {assert, assertEqual} from './util.js';

const STYLES = ['DOT', 'DOTS', 'SQUARES', 'DASHES', 'SEGMENTED', 'SOLID', 'CILIORA', 'METRO', 'BINARY'];
const SIDES = ['TOP', 'RIGHT', 'BOTTOM', 'LEFT'];
const near = (a, b) => Math.abs(a - b) < 1e-6;

// Where the shapes are: their outer edges.
function bounds(shapes) {
    return {
        left: Math.min(...shapes.map(s => s.x)),
        top: Math.min(...shapes.map(s => s.y)),
        right: Math.max(...shapes.map(s => s.x + s.width)),
        bottom: Math.max(...shapes.map(s => s.y + s.height)),
    };
}

export function testNothingToMark() {
    assertEqual(indicatorShapes('DOTS', 0, 48, 48, 'BOTTOM', false), [], 'no windows, no marks');
    assertEqual(indicatorShapes('DEFAULT', 3, 48, 48, 'BOTTOM', false), [], 'GNOME\'s own dot draws nothing here');
    assertEqual(indicatorShapes('SOLID', 1, 0, 0, 'BOTTOM', false), [], 'no room, no marks');
}

export function testEveryStyleInsideAtTheEdge() {
    for (const style of STYLES) {
        for (const side of SIDES) {
            for (let n = 1; n <= 5; n++) {
                const shapes = indicatorShapes(style, n, 48, 52, side, false);
                assert(shapes.length > 0, `${style} ${side} ${n}: something to draw`);
                const box = bounds(shapes);
                assert(box.left >= -1e-6 && box.top >= -1e-6 && box.right <= 48 + 1e-6 && box.bottom <= 52 + 1e-6,
                    `${style} ${side} ${n}: inside the area (${JSON.stringify(box)})`);
                // At the edge towards the dock's edge, and thin.
                const gap = {TOP: box.top, BOTTOM: 52 - box.bottom, LEFT: box.left, RIGHT: 48 - box.right}[side];
                const thickness = side === 'TOP' || side === 'BOTTOM' ? box.bottom - box.top : box.right - box.left;
                assert(gap < 1e-6 && thickness < 52 / 4, `${style} ${side} ${n}: at the edge (${gap}, ${thickness})`);
                assert(shapes.every(s => s.width > 0 && s.height > 0 && s.shade > 0 && s.shade <= 1),
                    `${style} ${side} ${n}: real shapes`);
            }
        }
    }
}

export function testCounts() {
    const count = (style, n) => indicatorShapes(style, n, 48, 48, 'BOTTOM', false).length;
    assertEqual([1, 2, 3, 4, 5].map(n => count('DOT', n)), [1, 1, 1, 1, 1], 'one dot, however many windows');
    for (const style of ['DOTS', 'SQUARES', 'DASHES', 'SEGMENTED', 'CILIORA'])
        assertEqual([1, 2, 3, 4, 5].map(n => count(style, n)), [1, 2, 3, 4, 4], `${style}: one each, up to four`);
    assertEqual([1, 2, 5].map(n => count('SOLID', n)), [1, 1, 1], 'one bar');
    assertEqual([1, 2, 5].map(n => count('METRO', n)), [1, 3, 3], 'metro: a bar, with a darker end for more');
    assertEqual([1, 2, 5, 20].map(n => count('BINARY', n)), [4, 4, 4, 4], 'binary: always four digits');
}

export function testShapesOfStyles() {
    const at = (style, n, side = 'BOTTOM', focused = false) => indicatorShapes(style, n, 48, 48, side, focused);
    const [dot] = at('DOT', 2);
    assert(dot.kind === 'circle' && near(dot.x + dot.radius, 24), 'the dot in the middle');
    const dots = at('DOTS', 3);
    assert(dots.every(d => d.kind === 'circle') && near((dots[0].x + dots[2].x + dots[2].width) / 2, 24),
        'dots side by side, in the middle');
    const [solid] = at('SOLID', 3);
    assert(solid.kind === 'rect' && solid.x === 0 && solid.width === 48, 'solid: all the way along');
    const segments = at('SEGMENTED', 2);
    assert(segments[0].x === 0 && near(segments[1].x + segments[1].width, 48), 'segments fill the length');
    const ciliora = at('CILIORA', 3);
    assert(ciliora[0].x === 0 && ciliora[0].width > ciliora[1].width && near(ciliora[2].x + ciliora[2].width, 48),
        'ciliora: a line, then squares to the end');
    // 5 = 0101: a dash, a dot, a dash, a dot.
    assertEqual(at('BINARY', 5).map(s => s.kind), ['rect', 'circle', 'rect', 'circle'], 'binary 5');
    assertEqual(at('BINARY', 20).map(s => s.kind), ['circle', 'circle', 'circle', 'circle'], 'binary stops at 15');
    // Metro: the darker end is shorter while the app has the focus.
    const metro = at('METRO', 2), focused = at('METRO', 2, 'BOTTOM', true);
    assert(metro[2].shade < 1 && metro[1].shade < metro[2].shade, 'metro: darker, and a darker line');
    assert(focused[2].width < metro[2].width, `metro: shorter dark end with the focus (${focused[2].width} < ${metro[2].width})`);
    assert(near(metro[2].x + metro[2].width, 48), 'metro: all the way along');
}

export function testSides() {
    const bottom = indicatorShapes('DASHES', 2, 40, 60, 'BOTTOM', false);
    const top = indicatorShapes('DASHES', 2, 40, 60, 'TOP', false);
    assertEqual(top.map(s => s.x), bottom.map(s => s.x), 'top: the same along the edge');
    assert(top.every(s => s.y === 0) && bottom.every(s => near(s.y + s.height, 60)), 'at the top or the bottom');
    // Left and right: down a column 60 long.
    const left = indicatorShapes('DASHES', 2, 40, 60, 'LEFT', false);
    const right = indicatorShapes('DASHES', 2, 40, 60, 'RIGHT', false);
    const column = indicatorShapes('DASHES', 2, 60, 40, 'BOTTOM', false);
    assertEqual(left.map(s => s.y), column.map(s => s.x), 'left: along the column');
    assert(left.every(s => s.x === 0 && s.height > s.width), 'left: at the left, upright');
    assert(right.every(s => near(s.x + s.width, 40)), 'right: at the right');
}

export function testBorder() {
    const plain = indicatorShapes('SOLID', 1, 48, 48, 'BOTTOM', false);
    const bordered = indicatorShapes('SOLID', 1, 48, 48, 'BOTTOM', false, 3);
    assert(bordered[0].height >= 3 && bordered[0].y + bordered[0].height <= 45 + 1e-6 &&
        plain[0].y + plain[0].height === 48, 'a border leaves room for its line');
}

// An icon of n×n pixels, RGBA, made by a function of (x, y).
function icon(size, pixel, channels = 4, padding = 0) {
    const rowstride = size * channels + padding;
    const pixels = new Uint8Array(rowstride * size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++)
            pixel(x, y).slice(0, channels).forEach((v, c) => (pixels[y * rowstride + x * channels + c] = v));
    }
    return [pixels, size, size, rowstride, channels];
}

export function testDominantColor() {
    // Red, mostly: vivid and bright.
    const red = dominantColor(...icon(16, () => [200, 30, 30, 255]));
    assertEqual(red, [230, 80, 80], 'a red icon is red');
    // Transparent pixels count for nothing.
    const blue = dominantColor(...icon(16, (x, y) => (x + y) % 2 ? [20, 40, 220, 255] : [255, 0, 0, 0]));
    assert(blue[2] > blue[0] && blue[2] > blue[1], `blue with transparent holes is blue (${blue})`);
    // Coloured pixels count more than grey ones.
    const green = dominantColor(...icon(16, (x, y) => y < 6 ? [30, 200, 40, 255] : [128, 128, 128, 255]));
    assert(green[1] > green[0] && green[1] > green[2], `a little green among grey is green (${green})`);
    // A grey icon stays grey (only brighter).
    const grey = dominantColor(...icon(16, () => [90, 90, 90, 255]));
    assertEqual(grey, [230, 230, 230], 'grey stays grey');
    // RGB rows with padding at their ends.
    assertEqual(dominantColor(...icon(16, () => [200, 30, 30], 3, 4)), red, 'RGB with a rowstride');
    // A large icon, read every few pixels.
    assertEqual(dominantColor(...icon(256, () => [200, 30, 30, 255])), red, 'a large icon');
    assertEqual(dominantColor(...icon(8, () => [0, 0, 0, 0])), null, 'all transparent: none');
    assertEqual(dominantColor(new Uint8Array(0), 0, 0, 0, 4), null, 'no pixels: none');
}

export function testBadgeText() {
    assertEqual(badgeText(0), '', 'nothing for none');
    assertEqual(badgeText(-2), '', 'nothing for less');
    assertEqual(badgeText(1), '1');
    assertEqual(badgeText(99), '99');
    assertEqual(badgeText(100), '99+', 'more than 99');
}
