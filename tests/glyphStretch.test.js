import {contoursOf, dotsMap, heightMap, inkOf, profileOf, stretchGlyph, stretchOutline, strokeOf} from '../lib/glyphStretch.js';
import {assert, assertEqual} from './util.js';

const STRETCHES = [1.6, 2.2, 2.8];

// Outlines as HarfBuzz draws them (y up): a rectangle, a circle (four
// arcs, the other way round for a hole), a ring.
const rect = (x0, y0, x1, y1) => [['M', x0, y0], ['L', x1, y0], ['L', x1, y1], ['L', x0, y1], ['Z']];

function circle(cx, cy, r, hole = false) {
    const k = 0.5523 * r;
    const arcs = [
        [cx + r, cy, cx + r, cy + k, cx + k, cy + r, cx, cy + r],
        [cx, cy + r, cx - k, cy + r, cx - r, cy + k, cx - r, cy],
        [cx - r, cy, cx - r, cy - k, cx - k, cy - r, cx, cy - r],
        [cx, cy - r, cx + k, cy - r, cx + r, cy - k, cx + r, cy],
    ];
    if (hole) {
        // (Round the other way: each arc backwards, last to first.)
        const back = arcs.reverse().map(([x0, y0, x1, y1, x2, y2, x3, y3]) => [x3, y3, x2, y2, x1, y1, x0, y0]);
        return [['M', back[0][0], back[0][1]], ...back.map(a => ['C', ...a.slice(2)]), ['Z']];
    }
    return [['M', arcs[0][0], arcs[0][1]], ...arcs.map(a => ['C', ...a.slice(2)]), ['Z']];
}

const ring = (cx, cy, outer, inner) => [...circle(cx, cy, outer), ...circle(cx, cy, inner, true)];

// The runs of ink along a line (x = at, or y = at): [from, to], as the
// outline fills (non-zero), its curves measured finely.
function runs(commands, axis, at) {
    const crossings = [];
    for (const contour of contoursOf(commands)) {
        for (const {p} of contour) {
            let previous = [p[0], p[1]];
            for (let i = 1; i <= 128; i++) {
                const t = i / 128;
                const u = 1 - t;
                const point = [0, 1].map(k => u * u * u * p[k] + 3 * u * u * t * p[k + 2] + 3 * u * t * t * p[k + 4] + t * t * t * p[k + 6]);
                const [a, b] = axis === 'x' ? [previous[0], point[0]] : [previous[1], point[1]];
                if (a !== b && at >= Math.min(a, b) && at < Math.max(a, b)) {
                    const f = (at - a) / (b - a);
                    const other = axis === 'x' ? previous[1] + f * (point[1] - previous[1]) : previous[0] + f * (point[0] - previous[0]);
                    crossings.push({at: other, dir: Math.sign(b - a)});
                }
                previous = point;
            }
        }
    }
    crossings.sort((a, b) => a.at - b.at);
    const found = [];
    let winding = 0;
    let from = 0;
    for (const {at: where, dir} of crossings) {
        const was = winding;
        winding += dir;
        if (was === 0 && winding !== 0)
            from = where;
        else if (was !== 0 && winding === 0)
            found.push([from, where]);
    }
    return found;
}

const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const length = ([a, b]) => b - a;

export function testStemOnlyGetsLonger() {
    const stem = rect(100, 0, 200, 1000);
    for (const stretch of STRETCHES) {
        const out = stretchGlyph(stem, {bottom: 0, top: 1000, stretch});
        const ink = inkOf(out);
        assert(ink.x1 === 100 && ink.x2 === 200 && ink.y1 === 0 && near(ink.y2, 1000 * stretch, 1e-6),
            `${stretch}: as wide, exactly as tall as asked (${JSON.stringify(ink)})`);
        assert(out.every(([op, x]) => op === 'Z' || x === 100 || x === 200), 'its sides straight and upright');
    }
}

export function testRingKeepsItsTurns() {
    const glyph = ring(500, 500, 400, 300);
    const profile = profileOf(glyph, {bottom: 100, top: 900});
    assertEqual(profile.mode, 'upright');
    for (const stretch of STRETCHES) {
        const out = stretchOutline(glyph, profile, stretch);
        const top = 100 + 800 * stretch;
        const ink = inkOf(out);
        assert(near(ink.y1, 100, 1e-6) && near(ink.y2, top, 1e-6) && near(ink.x1, 100, 1e-6) && near(ink.x2, 900, 1e-6),
            `${stretch}: exactly as tall, as wide (${JSON.stringify(ink)})`);
        // Its top and bottom as thick as they were (an affine stretch: 2.8 times).
        const middle = runs(out, 'x', 500);
        assertEqual(middle.length, 2, 'two arcs across its middle');
        assert(middle.every(run => near(length(run), 100, 1.5)), `${stretch}: its turns as thick (${middle.map(length)})`);
        // Its sides as thick, and upright through the middle of its height.
        const sides = runs(out, 'y', (100 + top) / 2);
        assert(sides.length === 2 && near(length(sides[0]), 100, 0.5) && near(length(sides[1]), 100, 0.5),
            `${stretch}: its sides as thick (${sides.map(length)})`);
        // Its side nearer upright than the circle's (as a whole stretch has
        // it), and upright through the middle third of it at the most.
        for (const share of [0.35, 0.5, 0.65]) {
            const [[left]] = runs(out, 'y', 100 + (top - 100) * share);
            const affine = 500 - Math.sqrt(400 ** 2 - (800 * share - 400) ** 2);
            assert(left <= affine + 1e-6, `${stretch}: straighter at ${share} of its height (${left}, ${affine})`);
            if (share === 0.5 || stretch === 2.8)
                assert(near(left, 100, 3), `${stretch}: upright at ${share} of its height (${left})`);
        }
    }
}

export function testHeightMap() {
    const profile = profileOf(ring(500, 500, 400, 300), {bottom: 100, top: 900});
    for (const stretch of [1, ...STRETCHES]) {
        const map = heightMap(profile, stretch);
        assert(near(map.height, 800 * stretch, 1e-9));
        assert(map.y(100) === 100 && near(map.y(900), 100 + 800 * stretch, 1e-6), `${stretch}: from the bottom to the top`);
        assert(near(map.y(1000), 1000 + 800 * (stretch - 1), 1e-9) && map.y(50) === 50, 'outside it, moved as it is');
        let last = -Infinity;
        for (let y = 0; y <= 1000; y += 0.5) {
            const to = map.y(y);
            assert(to > last, `${stretch}: monotone (at ${y})`);
            assert(map.slope(y) >= 1 - 1e-9, `${stretch}: never shorter anywhere (at ${y})`);
            last = to;
        }
    }
    const one = heightMap(profile, 1);
    assert([150, 500, 850].every(y => near(one.y(y), y, 1e-9)), 'a stretch of 1: as it is');
}

export function testBarKeepsItsHeight() {
    // An "H": two stems and a bar, overlapping (as variable fonts keep them).
    const glyph = [...rect(0, 0, 100, 1000), ...rect(500, 0, 600, 1000), ...rect(0, 450, 600, 550)];
    for (const stretch of STRETCHES) {
        const out = stretchGlyph(glyph, {bottom: 0, top: 1000, stretch});
        const bar = runs(out, 'x', 300);
        assert(bar.length === 1 && near(length(bar[0]), 100, 1), `${stretch}: the bar as thick (${bar.map(length)})`);
        assert(near((bar[0][0] + bar[0][1]) / 2, 500 * stretch, 5), `${stretch}: halfway up still (${bar[0]})`);
        const [stem] = runs(out, 'x', 50);
        assert(near(stem[0], 0, 1e-6) && near(stem[1], 1000 * stretch, 1e-6), `${stretch}: the stems all the way`);
    }
}

export function testDiagonalStaysStraight() {
    // A "7": a bar over a diagonal.
    const glyph = [...rect(0, 880, 600, 1000), ['M', 100, 0], ['L', 230, 0], ['L', 600, 880], ['L', 470, 880], ['Z']];
    const profile = profileOf(glyph, {bottom: 0, top: 1000});
    assert(profile.mode !== 'affine', `no upright rows, but no affine stretch either (${profile.mode})`);
    for (const stretch of STRETCHES) {
        const out = stretchOutline(glyph, profile, stretch);
        const top = 1000 * stretch;
        assert(near(inkOf(out).y2, top, 1e-6), `${stretch}: as tall as asked`);
        const bar = runs(out, 'x', 50);
        assert(bar.length === 1 && near(length(bar[0]), 120, 1), `${stretch}: the bar as thick (${bar.map(length)})`);
        // Its left edge on one line, its foot to the bar's foot.
        const barFoot = bar[0][0];
        const at = share => runs(out, 'y', barFoot * share)[0][0];
        const [a, b, c] = [0.1, 0.5, 0.9].map(at);
        const straight = (b - a) / 0.4 - (c - b) / 0.4;
        assert(Math.abs(straight) < 1, `${stretch}: the diagonal straight (${a}, ${b}, ${c})`);
    }
}

export function testDots() {
    // A colon centred on the band, and one for lowercase (low).
    for (const [low, high] of [[250, 750], [100, 500]]) {
        const colon = [...circle(200, low, 80), ...circle(200, high, 80)];
        const profile = profileOf(colon, {bottom: 0, top: 1000});
        assertEqual(profile.mode, 'dots');
        for (const stretch of [1, ...STRETCHES]) {
            const out = stretchOutline(colon, profile, stretch);
            const dots = runs(out, 'x', 200);
            assertEqual(dots.length, 2, 'two dots still');
            assert(dots.every(dot => near(length(dot), 160, 0.5)), `${stretch}: round still (${dots.map(length)})`);
            const centres = dots.map(([a, b]) => (a + b) / 2);
            const gap = (high - low) * stretch;
            assert(near(centres[0] + centres[1], 1000 * stretch, 0.5) && near(centres[1] - centres[0], gap, 0.5),
                `${stretch}: centred on the figures, as far apart as they stretch (${centres})`);
        }
    }
    const stop = profileOf(circle(200, 80, 80), {bottom: 0, top: 1000});
    assertEqual(stop.mode, 'dots');
    assert(near(dotsMap(stop, 2)(80), 160, 1e-9), 'a dot on its own: as far up as it was');
}

export function testFallbacks() {
    // A dash halfway up: it keeps its height, and the room round it grows.
    const dash = rect(100, 450, 900, 550);
    for (const stretch of STRETCHES) {
        const [run] = runs(stretchGlyph(dash, {bottom: 0, top: 1000, stretch}), 'x', 500);
        assert(near(length(run), 100, 1) && near((run[0] + run[1]) / 2, 500 * stretch, 2),
            `${stretch}: as thick, halfway up (${run})`);
    }
    // A bar as tall as the band: all of it grows, as tall as asked.
    assert(near(inkOf(stretchGlyph(rect(0, 0, 1000, 100), {bottom: 0, top: 100, stretch: 2.5})).y2, 250, 1e-6));
    assertEqual(profileOf([], {bottom: 0, top: 100}).mode, 'affine', 'no ink: as a whole');
    assertEqual(stretchGlyph([], {bottom: 0, top: 100, stretch: 2}), []);
    const profile = profileOf(rect(0, 0, 100, 100), {bottom: 0, top: 0});
    assert(near(inkOf(stretchOutline(rect(0, 0, 100, 100), profile, 2)).y2, 100, 1e-9), 'no band: as it is');
}

export function testQuadraticCurves() {
    // A circle as TrueType draws it: quadratic arcs.
    const k = 300 * Math.tan(Math.PI / 8);
    const glyph = [['M', 800, 500], ['Q', 800, 500 + k, 712, 712], ['Q', 500 + k, 800, 500, 800],
        ['Q', 500 - k, 800, 288, 712], ['Q', 200, 500 + k, 200, 500], ['Q', 200, 500 - k, 288, 288],
        ['Q', 500 - k, 200, 500, 200], ['Q', 500 + k, 200, 712, 288], ['Q', 800, 500 - k, 800, 500], ['Z']];
    assertEqual(contoursOf(glyph)[0].length, 8, 'as cubic curves');
    const out = stretchGlyph(glyph, {bottom: 200, top: 800, stretch: 2});
    assert(near(inkOf(out).y2, 1400, 0.5) && near(inkOf(out).y1, 200, 0.5), JSON.stringify(inkOf(out)));
    assert(out.every(([op]) => ['M', 'L', 'C', 'Z'].includes(op)), 'M, L, C and Z only');
}

export function testStroke() {
    assert(near(strokeOf(ring(500, 500, 400, 300)), 100, 2), `a ring's: its thickness (${strokeOf(ring(500, 500, 400, 300))})`);
    assertEqual(strokeOf([]), 0);
}
