// What makes a stretched glyph clean, measured: a glyph's outline
// stretched (lib/glyphStretch.js) against the one it was. Shared by
// tests/glyphStretch.test.js and tools/render-digits.js --check.
//
// A stretch keeps every point's x and the order of the outline's nodes,
// so each node of the outline it was is found again in the stretched one,
// in turn, at its own x: what lies between two of them is what the
// segment between them became.

import {contoursOf, inkOf} from '../lib/glyphStretch.js';

// Where the tangent breaks by this many degrees, there is a corner.
const CORNER = 3;
// A curvature under this (1 / font units) is none: a straight stretch.
const STRAIGHT = 1e-6;
const SAMPLES = 32;

const point = (p, t) => {
    const u = 1 - t;
    const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]];
};

const velocity = (p, t) => {
    const u = 1 - t;
    const [a, b, c] = [3 * u * u, 6 * u * t, 3 * t * t];
    return [a * (p[2] - p[0]) + b * (p[4] - p[2]) + c * (p[6] - p[4]),
        a * (p[3] - p[1]) + b * (p[5] - p[3]) + c * (p[7] - p[5])];
};

const acceleration = (p, t) => {
    const u = 1 - t;
    return [6 * u * (p[4] - 2 * p[2] + p[0]) + 6 * t * (p[6] - 2 * p[4] + p[2]),
        6 * u * (p[5] - 2 * p[3] + p[1]) + 6 * t * (p[7] - 2 * p[5] + p[3])];
};

// The way a segment leaves its start and comes into its end.
function ends({p}) {
    const away = [[2, 3], [4, 5], [6, 7]].map(([i, j]) => [p[i] - p[0], p[j] - p[1]]).find(([x, y]) => Math.hypot(x, y) > 1e-9) ?? [0, 0];
    const into = [[4, 5], [2, 3], [0, 1]].map(([i, j]) => [p[6] - p[i], p[7] - p[j]]).find(([x, y]) => Math.hypot(x, y) > 1e-9) ?? [0, 0];
    return [away, into];
}

const breakOf = ([ax, ay], [bx, by]) => {
    const d = Math.abs(Math.atan2(ay, ax) - Math.atan2(by, bx)) * 180 / Math.PI;
    return Math.min(d, 360 - d);
};

// Segments without length left out (a stretch may add or drop them).
const real = contour => contour.filter(({p}) => p.some((v, i) => Math.abs(v - p[i % 2]) > 1e-9));

/**
 * Each contour's corners and inflections.
 *
 * @param {Array[]} commands - an outline
 * @returns {{corners: number, inflections: number}[]} per contour: how many
 *   nodes its tangent breaks at, and how often its curvature changes sides
 *   all the way round (straight stretches don't count, nor do corners: a
 *   stretch may soften one under CORNER degrees)
 */
export function shapeOf(commands) {
    return contoursOf(commands).map(contour => {
        const segments = real(contour);
        const n = segments.length;
        // Along the contour: the curvature's signs; and the corners.
        const signs = [];
        let corners = 0;
        segments.forEach((segment, i) => {
            const [away] = ends(segment);
            const [, into] = ends(segments[(i + n - 1) % n]);
            if (breakOf(into, away) >= CORNER)
                corners++;
            if (!segment.cubic)
                return;
            for (let k = 0; k <= SAMPLES; k++) {
                const t = k / SAMPLES;
                const [vx, vy] = velocity(segment.p, t);
                const [ax, ay] = acceleration(segment.p, t);
                const speed = Math.hypot(vx, vy);
                if (speed < 1e-9)
                    continue;
                const curvature = (vx * ay - vy * ax) / speed ** 3;
                if (Math.abs(curvature) > STRAIGHT)
                    signs.push(Math.sign(curvature));
            }
        });
        const inflections = signs.filter((sign, k) => sign !== signs[(k + 1) % signs.length]).length;
        return {corners, inflections};
    });
}

/**
 * Each segment of an outline found again in it stretched: where its start
 * and its end went.
 *
 * @param {object[][]} original - contoursOf() the outline
 * @param {object[][]} stretched - contoursOf() it stretched
 * @returns {Array[]|null} per contour, per segment of the original: [from,
 *   to], the stretched contour's segments it became (from up to, not
 *   with, to; round its end); null where they can't be told
 */
export function matchSegments(original, stretched) {
    if (original.length !== stretched.length)
        return null;
    return original.map((contour, c) => {
        const nodes = real(contour).map(({p}) => p[0]);
        const segments = stretched[c];
        const xs = segments.map(({p}) => p[0]);
        const [n, m] = [nodes.length, xs.length];
        const same = (a, b) => Math.abs(a - b) < 1e-7;
        // Wherever the stretched contour starts, try each node at that x.
        for (let k = 0; k < n; k++) {
            if (!same(nodes[k], xs[0]))
                continue;
            const first = new Array(n);
            const last = new Array(n);
            let j = 0;
            let found = true;
            for (let i = 0; i < n && found; i++) {
                const x = nodes[(k + i) % n];
                while (j < m && !same(xs[j], x))
                    j++;
                if (j >= m) {
                    found = false;
                    break;
                }
                first[i] = j;
                while (j + 1 < m && same(xs[j + 1], x))
                    j++;
                last[i] = j;
            }
            if (!found)
                continue;
            const spans = new Array(n);
            for (let i = 0; i < n; i++)
                spans[(k + i) % n] = [last[i], i + 1 < n ? first[i + 1] : m];
            return spans;
        }
        return null;
    });
}

/**
 * How far the slanted lines of an outline, stretched, stray from straight.
 *
 * @param {Array[]} before - the outline
 * @param {Array[]} after - it stretched
 * @returns {{lines: number, worst: number}|null} how many slanted lines it
 *   has, and the most any strays from the line between its ends, as a
 *   share of that line's length; null where its segments can't be found
 */
export function crookedness(before, after) {
    const original = contoursOf(before).map(real);
    const stretched = contoursOf(after);
    const spans = matchSegments(original, stretched);
    if (!spans || spans.includes(null))
        return null;
    let lines = 0;
    let worst = 0;
    original.forEach((contour, c) => {
        contour.forEach(({cubic, p}, i) => {
            const [dx, dy] = [p[6] - p[0], p[7] - p[1]];
            if (cubic || Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6)
                return;
            lines++;
            const [from, to] = spans[c][i];
            const run = stretched[c].slice(from, to);
            if (run.length === 0)
                return;
            const [x0, y0] = [run[0].p[0], run[0].p[1]];
            const end = run[run.length - 1].p;
            const [x1, y1] = [end[6], end[7]];
            const length = Math.hypot(x1 - x0, y1 - y0);
            for (const segment of run) {
                for (let k = 0; k <= 16; k++) {
                    const [x, y] = point(segment.p, k / 16);
                    const off = Math.abs((x - x0) * (y1 - y0) - (y - y0) * (x1 - x0)) / length;
                    worst = Math.max(worst, off / length);
                }
            }
        });
    });
    return {lines, worst};
}

/**
 * Whether an outline's upright lines (its stems' sides) are upright lines
 * still, where they were across and at least as long.
 *
 * @param {Array[]} before - the outline
 * @param {Array[]} after - it stretched
 * @returns {number} how many of its upright lines aren't (0: all are)
 */
export function stemsAstray(before, after) {
    const length = new Map();
    for (const contour of contoursOf(after)) {
        for (const {cubic, p} of contour) {
            if (!cubic && p[0] === p[6])
                length.set(p[0], (length.get(p[0]) ?? 0) + Math.abs(p[7] - p[1]));
        }
    }
    const need = new Map();
    for (const contour of contoursOf(before)) {
        for (const {cubic, p} of contour) {
            if (!cubic && p[0] === p[6] && p[1] !== p[7])
                need.set(p[0], (need.get(p[0]) ?? 0) + Math.abs(p[7] - p[1]));
        }
    }
    return [...need].filter(([x, total]) => !((length.get(x) ?? 0) >= total - 1e-9)).length;
}

// An outline as straight edges: [x0, y0, x1, y1, contour, line].
function edgesOf(commands, steps = 12) {
    const edges = [];
    contoursOf(commands).forEach((contour, c) => {
        for (const {cubic, p} of real(contour)) {
            let previous = [p[0], p[1]];
            for (let k = 1; k <= (cubic ? steps : 1); k++) {
                const next = cubic ? point(p, k / steps) : [p[6], p[7]];
                edges.push([...previous, ...next, c, !cubic]);
                previous = next;
            }
        }
    });
    return edges;
}

/**
 * Where an outline crosses itself: edges that cross (not those that only
 * meet), within a contour or between two.
 *
 * @param {Array[]} commands
 * @returns {number} how many crossings
 */
export function crossings(commands) {
    const edges = edgesOf(commands);
    const n = edges.length;
    let count = 0;
    const side = (ax, ay, bx, by, px, py) => Math.sign((bx - ax) * (py - ay) - (by - ay) * (px - ax));
    const meet = (px, py, qx, qy) => Math.abs(px - qx) + Math.abs(py - qy) < 1e-6;
    for (let i = 0; i < n; i++) {
        const [ax, ay, bx, by] = edges[i];
        for (let j = i + 1; j < n; j++) {
            const [cx, cy, dx, dy] = edges[j];
            if (Math.max(cx, dx) <= Math.min(ax, bx) || Math.min(cx, dx) >= Math.max(ax, bx) ||
                Math.max(cy, dy) <= Math.min(ay, by) || Math.min(cy, dy) >= Math.max(ay, by))
                continue;
            // (Edges that only meet, end to end, don't cross.)
            if (meet(ax, ay, cx, cy) || meet(ax, ay, dx, dy) || meet(bx, by, cx, cy) || meet(bx, by, dx, dy))
                continue;
            const [s1, s2] = [side(ax, ay, bx, by, cx, cy), side(ax, ay, bx, by, dx, dy)];
            const [s3, s4] = [side(cx, cy, dx, dy, ax, ay), side(cx, cy, dx, dy, bx, by)];
            if (s1 * s2 < 0 && s3 * s4 < 0)
                count++;
        }
    }
    return count;
}

/**
 * The runs of ink along a column, as the outline fills (non-zero).
 *
 * @param {Array[]|number[][]} outline - an outline, or edgesOf() it
 * @param {number} x
 * @returns {Array[]} [from, to, flat, cut]: bottom to top, flat whether the
 *   edges at both its ends are within 20 degrees of level, cut how wide
 *   the narrower level line at its ends is (a stroke's end cut square;
 *   Infinity for none)
 */
export function columnRuns(outline, x) {
    const edges = typeof outline[0]?.[0] === 'string' ? edgesOf(outline, 64) : outline;
    const found = [];
    for (const [ax, ay, bx, by, , line] of edges) {
        if (ax === bx || x < Math.min(ax, bx) || x >= Math.max(ax, bx))
            continue;
        const angle = Math.atan2(Math.abs(by - ay), Math.abs(bx - ax)) * 180 / Math.PI;
        const cut = line && angle <= 2 ? Math.abs(bx - ax) : Infinity;
        found.push({y: ay + (x - ax) * (by - ay) / (bx - ax), dir: Math.sign(bx - ax), level: angle <= 20, cut});
    }
    found.sort((a, b) => a.y - b.y);
    const runs = [];
    let winding = 0;
    let from = null;
    for (const crossing of found) {
        const was = winding;
        winding += crossing.dir;
        if (was === 0 && winding !== 0)
            from = crossing;
        else if (was !== 0 && winding === 0)
            runs.push([from.y, crossing.y, from.level && crossing.level, Math.min(from.cut, crossing.cut)]);
    }
    return runs;
}

/**
 * How much an outline's horizontal strokes changed in thickness: each
 * column's runs of ink between level edges no longer than `most` (a bar,
 * the top of a bowl; not one along a stroke to its end cut square,
 * narrower than the run is long: a hook's), against the same run (in
 * turn, bottom to top) of the column stretched.
 *
 * @param {Array[]} before
 * @param {Array[]} after
 * @param {number} most - the longest run taken for a stroke
 * @param {number} [count] - columns across the ink
 * @returns {number} the most a stroke's run grew or shrank, font units
 */
export function strokeChange(before, after, most, count = 48) {
    const ink = inkOf(before);
    const [edgesBefore, edgesAfter] = [edgesOf(before, 64), edgesOf(after, 64)];
    let worst = 0;
    for (let j = 0; j < count; j++) {
        const x = ink.x1 + (j + 0.5) * (ink.x2 - ink.x1) / count;
        const [was, is] = [columnRuns(edgesBefore, x), columnRuns(edgesAfter, x)];
        if (was.length !== is.length)
            continue;
        was.forEach(([a, b, flat, cut], k) => {
            if (flat && b - a <= most && b - a <= cut)
                worst = Math.max(worst, Math.abs((is[k][1] - is[k][0]) - (b - a)));
        });
    }
    return worst;
}
