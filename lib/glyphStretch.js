// Taller digits that stay as they are drawn: the glass clock's vertical
// stretch, as an iPhone's tall clock has it. An affine stretch thickens
// every horizontal stroke and turns a round "0" into an ellipse with heavy
// ends; here only what runs up and down grows – straight stems, the sides
// of bowls where they are near vertical – while horizontal strokes, the
// turns of curves and dots keep their height, and every stroke its
// thickness.
//
// How: the glyph's height is cut into rows. A row can take extra height
// where every edge of the ink it crosses is near vertical (and so is as
// thick after as before) and no stroke runs across it (a bar, the top of
// a bowl: what a column through it finds short, between flat edges); a
// row a diagonal stroke crosses takes less (it grows steeper), and so
// does one a hook runs through (a stroke that ends inside the glyph, as
// a "2" has at its top: it would grow as long as the side beside it).
// The extra height is shared out among the rows, the more the more
// vertical they are, which gives a monotone map from the old heights to
// the new ones; where a slanted edge runs through rows that grow unlike,
// the change is eased in along it, so that it bends smoothly, not at a
// corner. Every point of the outline goes through the map, curves cut
// where it bends, keeping their tangents. A glyph without such rows grows
// where no stroke runs across; a glyph of dots (a colon) keeps them round
// and moves them apart.
// Pure functions: an outline in, an outline out. Outlines are as
// HarfBuzz draws them, y up: ['M', x, y], ['L', x, y],
// ['Q', x1, y1, x, y], ['C', x1, y1, x2, y2, x, y], ['Z'].

const ROWS = 320; // the rows the stretched height is measured in
const COLUMNS = 192; // the columns runs of ink across are found in
const STEPS = 24; // the edges a curve is measured as
// How near vertical every edge a row crosses is, for the row to grow: a
// curve all it can up to STEEP degrees off vertical, not at all from SLANT
// on (its turn keeps its shape); a straight edge as much up to STEEP, and
// DIAGONAL as much up to LEANING (a diagonal grows steeper: a "4", a "7"),
// and so does a curve that runs on from one, as steep.
const STEEP = 8;
const SLANT = 30;
const DIAGONAL = 0.4;
const LEANING = 45;
// A stroke runs across the rows where a column finds ink no longer than
// THIN times the glyph's horizontal strokes (or partly so, up to THICK
// times) between edges no steeper than FLAT degrees (partly so up to
// UPRIGHT): those rows keep their height. (Where a column only grazes a
// round side, its run is short too, but between steep edges; further
// round a curve's turn, the curve itself keeps its rows: see growth().)
const THIN = 1.3;
const THICK = 1.8;
const FLAT = 20;
const UPRIGHT = 40;
// What the other rows (no stroke across, but slanted) take besides.
const SLACK = 0.04;
// A stroke ends inside the glyph where a column's run of ink ends at a
// level straight edge no longer than CUT times its horizontal strokes,
// more than EDGE of the height from its bottom and top: the rows that
// stroke runs through grow by TERMINAL less.
const CUT = 1.8;
const EDGE = 0.08;
const TERMINAL = 0.75;
// How far, as a share of the height, a change in how much rows grow is
// eased in along an edge more than SLANTED degrees off vertical (and off
// horizontal) that runs through it, at least; edges whose directions
// differ by less than JOINED degrees run on smoothly.
const SOFTEN = 0.1;
const SLANTED = 2;
const JOINED = 12;
// Less than this share of the height near vertical: spread where no stroke
// runs across instead.
const SCARCE = 0.1;
// How far an outline may stray from the map, in its units (a font's are
// some 2000 to the em: well under a pixel).
const TOLERANCE = 0.25;
const DEPTH = 10;

/**
 * @param {Array[]} commands
 * @returns {object[][]} its contours: each a list of segments
 *   {cubic: boolean, p: [x0, y0, x1, y1, x2, y2, x3, y3]} (a line has its
 *   control points on it), closed
 */
export function contoursOf(commands) {
    const contours = [];
    let contour = null;
    let start = null;
    let at = null;
    const close = () => {
        if (contour && at && (at[0] !== start[0] || at[1] !== start[1]))
            contour.push(line(at, start));
        if (contour?.length)
            contours.push(contour);
        contour = null;
    };
    for (const [op, ...v] of commands) {
        if (op === 'M') {
            close();
            contour = [];
            start = at = [v[0], v[1]];
        } else if (op === 'L') {
            contour ??= [];
            contour.push(line(at, v));
            at = [v[0], v[1]];
        } else if (op === 'Q') {
            // (As a cubic: the same curve.)
            const [qx, qy, x, y] = v;
            contour ??= [];
            contour.push({cubic: true, p: [at[0], at[1],
                at[0] + 2 / 3 * (qx - at[0]), at[1] + 2 / 3 * (qy - at[1]),
                x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y]});
            at = [x, y];
        } else if (op === 'C') {
            contour ??= [];
            contour.push({cubic: true, p: [at[0], at[1], ...v]});
            at = [v[4], v[5]];
        } else if (op === 'Z') {
            close();
            at = start;
        }
    }
    close();
    return contours;
}

function line(a, b) {
    return {cubic: false, p: [a[0], a[1], a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3,
        a[0] + 2 * (b[0] - a[0]) / 3, a[1] + 2 * (b[1] - a[1]) / 3, b[0], b[1]]};
}

const bezier = (a, b, c, d, t) => {
    const u = 1 - t;
    return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

// Where a cubic's coordinate turns (0 < t < 1).
function turns(a, b, c, d) {
    // Its derivative, over 3: A t² + B t + C.
    const A = -a + 3 * b - 3 * c + d;
    const B = 2 * (a - 2 * b + c);
    const C = b - a;
    if (Math.abs(A) < 1e-12)
        return Math.abs(B) < 1e-12 ? [] : [-C / B].filter(t => t > 0 && t < 1);
    const disc = B * B - 4 * A * C;
    if (disc < 0)
        return [];
    const root = Math.sqrt(disc);
    return [(-B + root) / (2 * A), (-B - root) / (2 * A)].filter(t => t > 0 && t < 1);
}

// The box of contours' ink.
function boxOf(contours) {
    let box = null;
    const add = (x, y) => {
        if (!box)
            box = {x1: x, y1: y, x2: x, y2: y};
        box.x1 = Math.min(box.x1, x);
        box.y1 = Math.min(box.y1, y);
        box.x2 = Math.max(box.x2, x);
        box.y2 = Math.max(box.y2, y);
    };
    for (const contour of contours) {
        for (const {cubic, p} of contour) {
            add(p[0], p[1]);
            add(p[6], p[7]);
            if (!cubic)
                continue;
            for (const t of turns(p[0], p[2], p[4], p[6]))
                add(bezier(p[0], p[2], p[4], p[6], t), bezier(p[1], p[3], p[5], p[7], t));
            for (const t of turns(p[1], p[3], p[5], p[7]))
                add(bezier(p[0], p[2], p[4], p[6], t), bezier(p[1], p[3], p[5], p[7], t));
        }
    }
    return box;
}

/**
 * @param {Array[]} commands
 * @returns {{x1: number, y1: number, x2: number, y2: number}|null} the
 *   ink's box (the curves' own, not their control points'); null for none
 */
export const inkOf = commands => boxOf(contoursOf(commands));

const smoothstep = t => {
    const c = Math.min(1, Math.max(0, t));
    return c * c * (3 - 2 * c);
};

// Degrees off vertical.
const offVertical = (dx, dy) => Math.atan2(Math.abs(dx), Math.abs(dy)) * 180 / Math.PI;
const offOf = ([x0, y0, x1, y1]) => offVertical(x1 - x0, y1 - y0);

// A contour as a polygon's edges, in its order: [x0, y0, x1, y1, straight,
// diagonal]; diagonal for a straight edge that leans, and for the curves
// that run on smoothly from one, as steep (one stroke: a "2"'s spine, from
// its bowl down to its foot).
function edgesOf(contour) {
    const edges = [];
    for (const {cubic, p} of contour) {
        if (!cubic) {
            edges.push([p[0], p[1], p[6], p[7], true, false]);
            continue;
        }
        let [x, y] = [p[0], p[1]];
        for (let i = 1; i <= STEPS; i++) {
            const t = i / STEPS;
            const [nx, ny] = [bezier(p[0], p[2], p[4], p[6], t), bezier(p[1], p[3], p[5], p[7], t)];
            if (nx !== x || ny !== y)
                edges.push([x, y, nx, ny, false, false]);
            [x, y] = [nx, ny];
        }
    }
    const leans = edge => offOf(edge) > SLANTED && offOf(edge) <= LEANING;
    for (const run of smoothRuns(edges)) {
        if (run.some(edge => edge[4] && leans(edge)))
            run.forEach(edge => (edge[5] = offOf(edge) <= LEANING));
    }
    return edges;
}

// A contour's edges in runs that join smoothly (their directions differ
// by less than JOINED degrees at each corner between them); a contour
// without a corner is one run.
function smoothRuns(edges) {
    const n = edges.length;
    const direction = ([x0, y0, x1, y1]) => Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
    const corner = i => {
        const turn = Math.abs(direction(edges[i]) - direction(edges[(i + n - 1) % n]));
        return Math.min(turn, 360 - turn) >= JOINED;
    };
    const first = edges.findIndex((edge, i) => corner(i));
    if (first < 0)
        return n > 0 ? [edges.slice()] : [];
    const runs = [];
    let run = [];
    for (let k = 0; k < n; k++) {
        const i = (first + k) % n;
        if (k > 0 && corner(i)) {
            runs.push(run);
            run = [];
        }
        run.push(edges[i]);
    }
    runs.push(run);
    return runs;
}

// How much a row may grow where it crosses an edge this far off vertical.
function growth(off, diagonal) {
    const upright = smoothstep((SLANT - off) / (SLANT - STEEP));
    return Math.max(upright, diagonal && off <= LEANING ? DIAGONAL : 0);
}

// How much a row may grow for the ink's edges it crosses, all of them:
// 1 (or no ink there) … 0.
function uprightness(edges, y) {
    const crossings = [];
    for (const [x0, y0, x1, y1, straight, diagonal] of edges) {
        if (y0 === y1 || y < Math.min(y0, y1) || y >= Math.max(y0, y1))
            continue;
        const x = x0 + (y - y0) * (x1 - x0) / (y1 - y0);
        crossings.push({x, dir: Math.sign(y1 - y0), grows: growth(offVertical(x1 - x0, y1 - y0), straight || diagonal)});
    }
    crossings.sort((a, b) => a.x - b.x);
    // (Its edges: where the winding goes from none to some, or back –
    // not edges of one contour inside another.)
    let winding = 0;
    let upright = 1;
    for (const {dir, grows} of crossings) {
        const was = winding;
        winding += dir;
        if ((was === 0) !== (winding === 0))
            upright = Math.min(upright, grows);
    }
    return upright;
}

// The runs of ink a column finds, bottom to top: [y0, y1, flat, cut0,
// cut1], flat how near horizontal the edges at both its ends are (1 … 0),
// cut0 and cut1 how long the level straight edge at either end is (a
// stroke's end cut square: a terminal), or 0.
function runsAt(edges, x) {
    const crossings = [];
    for (const [x0, y0, x1, y1, straight] of edges) {
        if (x0 === x1 || x < Math.min(x0, x1) || x >= Math.max(x0, x1))
            continue;
        const level = 90 - offVertical(x1 - x0, y1 - y0);
        crossings.push({
            y: y0 + (x - x0) * (y1 - y0) / (x1 - x0),
            dir: Math.sign(x1 - x0),
            flat: 1 - smoothstep((level - FLAT) / (UPRIGHT - FLAT)),
            cut: straight && level <= SLANTED ? Math.hypot(x1 - x0, y1 - y0) : 0,
        });
    }
    crossings.sort((a, b) => a.y - b.y);
    const runs = [];
    let winding = 0;
    let from = null;
    for (const crossing of crossings) {
        const was = winding;
        winding += crossing.dir;
        if (was === 0 && winding !== 0)
            from = crossing;
        else if (was !== 0 && winding === 0)
            runs.push([from.y, crossing.y, Math.min(from.flat, crossing.flat), from.cut, crossing.cut]);
    }
    return runs;
}

function columnsOf(edges, box, count = COLUMNS) {
    const columns = [];
    for (let j = 0; j < count; j++)
        columns.push(runsAt(edges, box.x1 + (j + 0.5) * (box.x2 - box.x1) / count));
    return columns;
}

/**
 * How thick a glyph's horizontal strokes are, about: the shortest run of
 * ink between flat edges that a column through its middle third finds,
 * as most of those that cross more than one stroke have it (the top and
 * the bottom of a "0", round its counter).
 *
 * @param {Array[]} commands
 * @returns {number} in its units (0 for none)
 */
export function strokeOf(commands) {
    const contours = contoursOf(commands);
    const box = boxOf(contours);
    if (!box)
        return 0;
    const third = (box.x2 - box.x1) / 3;
    const columns = columnsOf(contours.flatMap(edgesOf), {...box, x1: box.x1 + third, x2: box.x2 - third}, 64)
        .map(runs => runs.filter(([, , flat]) => flat > 0.5));
    // (Columns through a counter, if there are any.)
    const crossing = columns.filter(runs => runs.length > 1);
    const shortest = (crossing.length > 0 ? crossing : columns)
        .filter(runs => runs.length > 0)
        .map(runs => Math.min(...runs.map(([a, b]) => b - a)))
        .sort((a, b) => a - b);
    return shortest.length ? shortest[Math.floor(shortest.length / 2)] : 0;
}

// The runs of slanted edges that join smoothly, as the rows they span
// ([first, last], a row more each way): a change in how much rows grow
// within one bends an edge.
function slantedSpans(contourEdges, rowAt) {
    const spans = [];
    for (const edges of contourEdges) {
        for (const run of smoothRuns(edges)) {
            let span = null;
            for (const edge of run) {
                const off = offOf(edge);
                if (off > SLANTED && off < 90 - SLANTED) {
                    const [a, b] = [rowAt(Math.min(edge[1], edge[3])), rowAt(Math.max(edge[1], edge[3]))];
                    span = span ? [Math.min(span[0], a), Math.max(span[1], b)] : [a, b];
                } else if (span) {
                    spans.push(span);
                    span = null;
                }
            }
            if (span)
                spans.push(span);
        }
    }
    return spans.map(([a, b]) => [Math.max(0, Math.floor(a) - 1), Math.min(ROWS, Math.ceil(b) + 1)])
        .filter(([a, b]) => b > a);
}

// Along each run of slanted edges, the weights eased in: by no more than
// all of it over `radius` rows (the largest weights under the raw ones
// that do: never more than they were, so what is kept stays kept, and a
// narrow band of rows that grow grows less, but grows). Elsewhere they
// stay as they are: rows where only upright edges change (a stem) can
// change at once, and a diagonal that ends at a bar stays straight.
function soften(weights, spans, radius) {
    const raw = Float64Array.from(weights);
    const most = 1 / radius;
    for (const [a, b] of spans) {
        const eased = raw.slice(a, b + 1);
        for (let i = 1; i < eased.length; i++)
            eased[i] = Math.min(eased[i], eased[i - 1] + most);
        for (let i = eased.length - 2; i >= 0; i--)
            eased[i] = Math.min(eased[i], eased[i + 1] + most);
        eased.forEach((w, i) => (weights[a + i] = Math.min(weights[a + i], w)));
    }
}

// Dots: contours all small, about as wide as tall, none in another.
function dotsOf(contours, height) {
    const boxes = contours.map(contour => boxOf([contour]));
    const round = boxes.every(box => {
        const [w, h] = [box.x2 - box.x1, box.y2 - box.y1];
        return h > 0 && h <= 0.45 * height && w / h > 0.6 && w / h < 1.67;
    });
    const inside = (a, b) => a.x1 >= b.x1 && a.x2 <= b.x2 && a.y1 >= b.y1 && a.y2 <= b.y2;
    const apart = boxes.every((a, i) => boxes.every((b, k) => i === k || !inside(a, b)));
    return round && apart ? boxes.map(box => (box.y1 + box.y2) / 2) : null;
}

/**
 * Which of a glyph's rows can grow, and how much each takes of the extra
 * height: what stretching it to any height needs (kept, it serves every
 * stretch).
 *
 * @param {Array[]} commands - the glyph's outline
 * @param {object} band - the height that stretches, in its units (the
 *   figures': the baseline to their top; what is above or below it moves
 *   with it, as it is)
 * @param {number} band.bottom
 * @param {number} band.top
 * @param {number|null} [band.stroke] - how thick the font's horizontal
 *   strokes are (the top of its "0", say); null: as this glyph's look
 * @param {boolean} [band.debug] - keep what each row was found to be
 * @returns {object} the profile: {bottom, top, weights (one per row
 *   boundary, ROWS + 1), mode ('upright': its near vertical rows grow;
 *   'even': all where no stroke runs across; 'affine': all of them;
 *   'dots'), dots (their centres' heights, for 'dots')}
 */
export function profileOf(commands, {bottom, top, stroke = null, debug = false}) {
    const contours = contoursOf(commands);
    const height = top - bottom;
    const weights = new Float64Array(ROWS + 1);
    const box = boxOf(contours);
    const profile = {bottom, top, weights, mode: 'affine', dots: null};
    if (!box || !(height > 0)) {
        weights.fill(1);
        return profile;
    }
    const dots = dotsOf(contours, height);
    if (dots) {
        profile.mode = 'dots';
        profile.dots = dots;
        return profile;
    }
    const contourEdges = contours.map(contour => edgesOf(contour));
    const edges = contourEdges.flat();
    // (Not more than a quarter of the height: a stroke, not the glyph.)
    if (!(stroke > 0))
        stroke = strokeOf(commands) || height / 10;
    stroke = Math.min(stroke, height / 4);
    const step = height / ROWS;
    const rowAt = y => (y - bottom) / step;
    const rowsOf = (y0, y1) => [Math.max(0, Math.ceil(rowAt(y0) - 1e-6)), Math.min(ROWS, Math.floor(rowAt(y1) + 1e-6))];
    // Rows a stroke runs across: as much kept as the shortest column says.
    // And rows a stroke that ends inside the glyph runs through (a hook,
    // cut square, as a "2" has at its top): they grow less, or the hook
    // grows as long as the side beside it.
    const kept = new Float64Array(ROWS + 1);
    const ending = new Float64Array(ROWS + 1);
    const inside = y => y > bottom + EDGE * height && y < top - EDGE * height;
    const isCut = (cut, y) => cut > 0 && cut <= CUT * stroke && inside(y);
    for (const runs of columnsOf(edges, box)) {
        for (const [y0, y1, flat, cut0, cut1] of runs) {
            const [from, to] = rowsOf(y0, y1);
            const across = flat * (1 - smoothstep((y1 - y0 - THIN * stroke) / ((THICK - THIN) * stroke)));
            const ends = y1 - y0 > THICK * stroke && (isCut(cut0, y0) || isCut(cut1, y1));
            for (let i = from; i <= to; i++) {
                kept[i] = Math.max(kept[i], across);
                if (ends)
                    ending[i] = 1;
            }
        }
    }
    // Rows above or below the glyph's ink (a figure a little shorter than
    // the others) don't grow: it moves up by all of the extra height, as
    // the others do.
    const outside = i => bottom + i * step < box.y1 - 1e-6 * height || bottom + i * step > box.y2 + 1e-6 * height;
    // (The top row a little lower: edges ending there are counted.)
    const uprights = Float64Array.from(kept, (k, i) => outside(i) ? 0
        : uprightness(edges, bottom + Math.min(i, ROWS - 0.25) * step) * (1 - k) * (1 - TERMINAL * ending[i]));
    const spans = slantedSpans(contourEdges, rowAt);
    if (debug)
        profile.debug = {kept, ending, uprights, spans, stroke};
    const share = list => list.reduce((sum, w) => sum + w, 0) / (ROWS + 1);
    // Near vertical rows, or (too few of those) all that no stroke runs
    // across, or (none of those: a dash) the room round it, or every one.
    const free = Float64Array.from(kept, (k, i) => outside(i) ? 0 : 1 - k);
    const room = Float64Array.from(kept, k => 1 - k);
    if (share(uprights) >= SCARCE) {
        profile.mode = 'upright';
        weights.set(uprights.map((w, i) => w + SLACK * free[i]));
    } else if (share(free) >= SCARCE / 4) {
        profile.mode = 'even';
        weights.set(free);
    } else if (share(room) >= SCARCE / 4) {
        profile.mode = 'even';
        weights.set(room);
    } else {
        weights.fill(1);
        return profile;
    }
    soften(weights, spans, Math.max(1, Math.round(SOFTEN * ROWS)));
    // (Eased away entirely: every one.)
    if (share(weights) < 1e-3) {
        profile.mode = 'affine';
        weights.fill(1);
    }
    return profile;
}

/**
 * The map of heights a profile gives for a stretch.
 *
 * @param {object} profile - profileOf()
 * @param {number} stretch - how much taller the band gets (1: as it is)
 * @returns {{y: Function, slope: Function, height: number}} y(old) the
 *   new height of a point, slope(old) how much taller it grows there, and
 *   the band's new height
 */
export function heightMap({bottom, top, weights}, stretch) {
    const height = top - bottom;
    const extra = (Math.max(0, stretch) - 1) * height;
    const step = height / ROWS;
    // The weights' integral from the bottom to each row boundary.
    const sums = new Float64Array(ROWS + 1);
    for (let i = 1; i <= ROWS; i++)
        sums[i] = sums[i - 1] + (weights[i - 1] + weights[i]) / 2 * step;
    const total = sums[ROWS];
    const scale = total > 0 ? extra / total : 0;
    const within = y => {
        const at = Math.min(ROWS - 1e-9, Math.max(0, (y - bottom) / step));
        const i = Math.floor(at);
        const f = at - i;
        return {i, f, w: weights[i] + (weights[i + 1] - weights[i]) * f};
    };
    return {
        height: height + extra,
        y(y) {
            if (y <= bottom)
                return y;
            if (y >= top)
                return y + extra;
            const {i, f, w} = within(y);
            return y + scale * (sums[i] + (weights[i] + w) / 2 * f * step);
        },
        slope(y) {
            if (y < bottom || y > top)
                return 1;
            return 1 + scale * within(y).w;
        },
        // Whether it is straight between two heights: the same slope all
        // the way (a line there stays one).
        straight(a, b) {
            const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
            if (hi <= bottom || lo >= top || scale === 0)
                return true;
            const slopes = [];
            if (lo < bottom || hi > top)
                slopes.push(1);
            const [from, to] = [Math.max(0, Math.floor((lo - bottom) / step)), Math.min(ROWS, Math.ceil((hi - bottom) / step))];
            for (let i = from; i <= to; i++)
                slopes.push(1 + scale * weights[i]);
            return slopes.every(s => Math.abs(s - slopes[0]) < 1e-9);
        },
    };
}

// A cubic split at t: its two halves' control points.
function split(p, t) {
    const lerp = (a, b) => a + (b - a) * t;
    const halves = [[], []];
    for (const k of [0, 1]) {
        const [a, b, c, d] = [p[k], p[k + 2], p[k + 4], p[k + 6]];
        const [ab, bc, cd] = [lerp(a, b), lerp(b, c), lerp(c, d)];
        const [abc, bcd] = [lerp(ab, bc), lerp(bc, cd)];
        const m = lerp(abc, bcd);
        halves[0].push(a, ab, abc, m);
        halves[1].push(m, bcd, cd, d);
    }
    // (Back to x0, y0, x1, y1, …)
    const zip = ([x0, x1, x2, x3, y0, y1, y2, y3]) => [x0, y0, x1, y1, x2, y2, x3, y3];
    return halves.map(zip);
}

// A cubic through the map: its ends where the map puts them, and its
// tangents there as the map turns them – so that pieces meet smoothly –
// cut in halves until it keeps to the map.
function mapCubic(p, map, out, depth = 0) {
    const [y0, y3] = [map.y(p[1]), map.y(p[7])];
    const [s0, s3] = [map.slope(p[1]), map.slope(p[7])];
    const q = [p[0], y0, p[2], y0 + s0 * (p[3] - p[1]), p[4], y3 + s3 * (p[5] - p[7]), p[6], y3];
    if (depth < DEPTH) {
        for (const t of [0.25, 0.5, 0.75]) {
            const wanted = map.y(bezier(p[1], p[3], p[5], p[7], t));
            if (Math.abs(bezier(q[1], q[3], q[5], q[7], t) - wanted) > TOLERANCE) {
                const [a, b] = split(p, 0.5);
                mapCubic(a, map, out, depth + 1);
                mapCubic(b, map, out, depth + 1);
                return;
            }
        }
    }
    out.push(['C', q[2], q[3], q[4], q[5], q[6], q[7]]);
}

function trace(contour, move, out) {
    out.push(['M', ...move(contour[0].p[0], contour[0].p[1])]);
    for (const {cubic, p} of contour) {
        if (cubic)
            out.push(['C', ...move(p[2], p[3]), ...move(p[4], p[5]), ...move(p[6], p[7])]);
        else
            out.push(['L', ...move(p[6], p[7])]);
    }
    out.push(['Z']);
}

/**
 * Where a glyph of dots puts their centres: dots one over the other (a
 * colon) centred on the band – where the figures' middle is, whichever
 * colon the font has (the one for lowercase sits low) – and as far apart
 * as the band stretches, so that they sit where the figures' bowls are;
 * a dot on its own (a full stop) as far up the stretched band as it was
 * up the band.
 *
 * @param {object} profile - profileOf() a glyph of dots
 * @param {number} stretch
 * @returns {Function} the height a centre goes to, from the one it has
 */
export function dotsMap({bottom, top, dots}, stretch) {
    const [low, high] = [Math.min(...dots), Math.max(...dots)];
    if (high - low > (top - bottom) / 20) {
        const [from, to] = [(low + high) / 2, bottom + (top - bottom) * stretch / 2];
        return y => to + (y - from) * stretch;
    }
    return y => y <= bottom ? y : y >= top ? y + (stretch - 1) * (top - bottom) : bottom + (y - bottom) * stretch;
}

/**
 * A glyph, stretched.
 *
 * @param {Array[]} commands - its outline
 * @param {object} profile - profileOf() its outline
 * @param {number} stretch - how much taller the band gets
 * @param {object} [options]
 * @param {Function} [options.dots] - for dots (a colon): the height their
 *   centres go to, from the one they have (default: dotsMap())
 * @returns {Array[]} the outline, stretched: M, L, C and Z only (dots
 *   moved even at a stretch of 1)
 */
export function stretchOutline(commands, profile, stretch, {dots = null} = {}) {
    const contours = contoursOf(commands);
    const out = [];
    if (profile.mode === 'dots') {
        const to = dots ?? dotsMap(profile, stretch);
        contours.forEach((contour, i) => {
            const dy = to(profile.dots[i]) - profile.dots[i];
            trace(contour, (x, y) => [x, y + dy], out);
        });
        return out;
    }
    const map = heightMap(profile, stretch);
    for (const contour of contours) {
        out.push(['M', contour[0].p[0], map.y(contour[0].p[1])]);
        for (const {cubic, p} of contour) {
            // (Upright and level lines stay lines; so do lines where the
            // map is straight.)
            if (!cubic && (p[0] === p[6] || p[1] === p[7] || map.straight(p[1], p[7])))
                out.push(['L', p[6], map.y(p[7])]);
            else
                mapCubic(p, map, out);
        }
        out.push(['Z']);
    }
    return out;
}

/**
 * A glyph stretched in one go (profileOf() and stretchOutline(); keep the
 * profile to stretch it again).
 *
 * @param {Array[]} commands
 * @param {object} options - as profileOf()'s band, and stretch (and dots,
 *   as for stretchOutline())
 * @returns {Array[]}
 */
export function stretchGlyph(commands, {bottom, top, stroke = null, stretch, dots = null}) {
    return stretchOutline(commands, profileOf(commands, {bottom, top, stroke}), stretch, {dots});
}
