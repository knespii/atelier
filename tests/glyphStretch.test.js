import GLib from 'gi://GLib';

import {bundledFile, fontAt, systemFontFile} from '../lib/glyphOutlines.js';
import {contoursOf, dotsMap, heightMap, inkOf, profileOf, stretchGlyph, stretchOutline, strokeOf} from '../lib/glyphStretch.js';
import {STRETCH} from '../lib/lockLook.js';
import {TYPEFACES, styleFor, typefaceFor, variationsFor} from '../lib/lockType.js';
import {crookedness, crossings, shapeOf, stemsAstray, strokeChange} from './glyphChecks.js';
import {assert, assertEqual} from './util.js';

const STRETCHES = [1.6, 2.2, 2.8];
// From a little taller to the tallest the clock stretches.
const TALL = [1.5, 2, 2.5, 3, 4, 5, STRETCH.max];

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

// The fonts the glass clock draws its figures in: Inter as the glass face
// sets it (its weight and width, a large clock's optical size) and heavy,
// Roboto Flex, and the shell's Cantarell where the system has it.
function clockFonts() {
    const {weight, width} = styleFor(typefaceFor('inter'), 'glass');
    const typeface = id => TYPEFACES.find(t => t.id === id);
    return [
        ['Inter', bundledFile('Inter.ttf'), typeface('inter').axes, weight],
        ['Inter', bundledFile('Inter.ttf'), typeface('inter').axes, 800],
        ['Roboto Flex', bundledFile('RobotoFlex.ttf'), typeface('flex').axes, weight],
        ['Cantarell', systemFontFile('Cantarell'), null, weight],
    ].filter(([, path]) => path).map(([name, path, fontAxes, fontWeight]) => {
        const {variations} = variationsFor(fontAxes, {weight: fontWeight, width, size: 400});
        return {name: `${name} ${variations}`, font: fontAt(path, variations)};
    });
}

const glyphOf = (font, char) => font.shape(char, ['tnum', 'case']).glyphs[0].glyph;

export function testFiguresStayAsDrawn() {
    // Every figure, every height: no curve bent anew (no inflection, no
    // corner it hadn't), the outline not crossing itself, lines straight,
    // stems upright where they were, every figure exactly as tall, its
    // horizontal strokes as thick.
    for (const {name, font} of clockFonts()) {
        const {top, bottom, stroke} = font.figures;
        for (const char of '0123456789:') {
            const glyph = glyphOf(font, char);
            const {commands, ink} = font.outline(glyph);
            const shape = shapeOf(commands);
            const crossed = crossings(commands);
            for (const stretch of TALL) {
                const out = font.stretched(glyph, stretch);
                const what = `${name} "${char}" × ${stretch}`;
                const after = shapeOf(out);
                assert(after.length === shape.length &&
                    after.every((c, i) => c.inflections <= shape[i].inflections && c.corners <= shape[i].corners),
                `${what}: nothing bent (${JSON.stringify(shape)} → ${JSON.stringify(after)})`);
                assert(crossings(out) <= crossed, `${what}: crossing itself no more than it did`);
                const lines = crookedness(commands, out);
                assert(lines !== null && lines.worst < 1e-9, `${what}: its slanted lines straight (${lines?.worst})`);
                assertEqual(stemsAstray(commands, out), 0, `${what}: its stems upright where they were`);
                const stretched = inkOf(out);
                assert(stretched.x1 === ink.x1 && stretched.x2 === ink.x2, `${what}: as wide`);
                if (char === ':')
                    continue;
                assert(near(stretched.y2, ink.y2 + (stretch - 1) * (top - bottom), 1e-6) && near(stretched.y1, ink.y1, 1e-6),
                    `${what}: its foot where it was, its top up by all of the extra height (${ink.y2} → ${stretched.y2})`);
                const change = strokeChange(commands, out, 1.5 * stroke);
                assert(change < 0.002 * stroke, `${what}: its horizontal strokes as thick (${change} of ${stroke})`);
            }
        }
    }
}

export function testTurnsMoveAsTheyAre() {
    // A "0": its top half moved up as it is, its bottom half where it was,
    // straight upright sides between.
    const font = fontAt(bundledFile('Inter.ttf'), 'wght=600,opsz=32');
    const glyph = glyphOf(font, '0');
    const {commands} = font.outline(glyph);
    const {top, bottom} = font.figures;
    const nodes = list => list.filter(([op]) => op !== 'Z').map(v => v.slice(-2));
    const middle = (inkOf(commands).y1 + inkOf(commands).y2) / 2;
    for (const stretch of [1.5, 3, 6]) {
        const out = nodes(font.stretched(glyph, stretch));
        const extra = (stretch - 1) * (top - bottom);
        for (const [x, y] of nodes(commands)) {
            const to = y > middle + 1 ? y + extra : y < middle - 1 ? y : null;
            if (to !== null)
                assert(out.some(([ox, oy]) => ox === x && near(oy, to, 1e-6)), `× ${stretch}: ${x}, ${y} to ${to}`);
        }
        // (The curves measured finely, not exactly: to a hundredth.)
        const sides = runs(font.stretched(glyph, stretch), 'y', middle + extra / 2);
        const before = runs(commands, 'y', middle);
        assert(sides.length === 2 && sides.every((run, i) => near(run[0], before[i][0], 0.01) && near(run[1], before[i][1], 0.01)),
            `× ${stretch}: its sides as thick, upright (${sides}, ${before})`);
    }
}

export function testStretchIsQuick() {
    // Once a glyph's profile is made, stretching it again (a frame of a
    // stretch being dragged) takes a few hundredths of a millisecond.
    const font = fontAt(bundledFile('Inter.ttf'), 'wght=600,opsz=32');
    const glyphs = [...'0123456789:'].map(char => glyphOf(font, char));
    glyphs.forEach(glyph => font.stretched(glyph, 1));
    const started = GLib.get_monotonic_time();
    let count = 0;
    for (let stretch = 1.01; stretch <= STRETCH.max; stretch += 0.05) {
        glyphs.forEach(glyph => font.stretched(glyph, stretch));
        count += glyphs.length;
    }
    const each = (GLib.get_monotonic_time() - started) / 1000 / count;
    assert(each < 0.5, `well under a millisecond a glyph (${each.toFixed(4)} ms)`);
}
