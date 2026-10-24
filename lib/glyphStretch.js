// Taller digits that stay as they are drawn: the glass clock's vertical
// stretch, as an iPhone's tall clock has it. An affine stretch thickens
// every horizontal stroke and turns a round "0" into an ellipse with heavy
// ends; here only what runs up and down grows – straight stems, the sides
// of bowls – while horizontal strokes, the turns of curves, terminals and
// dots keep their shape and every stroke its thickness, and a diagonal
// stays straight, only steeper.
//
// How: the outline is cut where its curves turn across or up and down
// (their extremes), and into chains where it has a corner or runs upright
// or level: within a chain it runs on smoothly, one way up and one way
// across. Nothing bends a chain. It is moved as it is, or stretched up as
// a whole (an affine stretch, which keeps a line a line and a curve as it
// curves), and chains meet where tangents can't break – where they run
// upright or level – or have broken already, at corners. A curve's turn,
// from where it runs upright to where it runs level (a quarter of a "0"),
// is moved as it is, and the height it gains goes in where it runs
// upright, as a straight upright stretch of outline: a "0" becomes a
// stadium, a "6"'s stem a straight one. Lines, a diagonal's chain (a "2"'s
// spine) and the rest are stretched between where their ends go.
// Where their ends go is one map of heights for the whole glyph, so that
// what is at one height moves alike: the height is cut into rows, and the
// extra height is shared out among them evenly – so that a bar, a waist, a
// terminal stays as far up the glyph as it was drawn, as a typeface's own
// condensed figures have it – except where a chain through a row can't
// grow (a curve that has to keep its shape, a diagonal too flat to steepen,
// as a "1"'s flag) or a stroke runs across it (a bar, the top of a bowl:
// what a column through it finds short, between flat edges). A glyph
// without such rows grows where no stroke runs across; a glyph of dots (a
// colon) keeps them round and moves them apart.
// Pure functions: an outline in, an outline out. Outlines are as
// HarfBuzz draws them, y up: ['M', x, y], ['L', x, y],
// ['Q', x1, y1, x, y], ['C', x1, y1, x2, y2, x, y], ['Z'].

const ROWS = 320; // the rows the stretched height is measured in
const COLUMNS = 192; // the columns runs of ink across are found in
const STEPS = 24; // the edges a curve is measured as, for those columns
// A tangent within TANGENT degrees of vertical runs upright (a curve cut
// at its extreme: not at all), as much off horizontal level; where
// tangents turn by JOINED degrees or more, there is a corner. A curve is
// cut no nearer its ends than NEAR (of its course).
const TANGENT = 1;
const JOINED = 12;
const NEAR = 1e-3;
// A turn runs from upright to within LEVEL degrees of level (the top of a
// bowl, a waist).
const LEVEL = 30;
// How much a row may grow where a chain runs through it, by how far off
// vertical that runs: a curve all it can up to STEEP degrees, none from
// SLANT on; a diagonal (a line from SLANTED to FLATTEST degrees off
// vertical, a curve that slants as much and keeps within STRAIGHTISH of
// its length to its chord, or one that runs from upright to a slant: a
// spine) all it can up to LEANING, less till FLATTEST, from where it keeps
// its slope (a "1"'s flag: steeper, it would be much thicker).
const STEEP = 8;
const SLANT = 30;
const SLANTED = 2;
const STRAIGHTISH = 0.06;
const LEANING = 45;
const FLATTEST = 55;
// A stroke runs across the rows where a column finds ink no longer than
// THIN times the glyph's horizontal strokes (or partly so, up to THICK
// times) between edges no steeper than FLAT degrees (partly so up to
// UPRIGHT): those rows keep their height. (Where a column only grazes a
// round side, its run is short too, but between steep edges.)
const THIN = 1.3;
const THICK = 1.8;
const FLAT = 20;
const UPRIGHT = 40;
// Less than this share of the height that can grow: spread where no stroke
// runs across instead.
const SCARCE = 0.1;
// Ends of chains nearer than this (in font units) are taken as one.
const TOUCHING = 1e-6;

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

// A contour as a polygon's edges, in its order: [x0, y0, x1, y1].
function edgesOf(contour) {
    const edges = [];
    for (const {cubic, p} of contour) {
        if (!cubic) {
            edges.push([p[0], p[1], p[6], p[7]]);
            continue;
        }
        let [x, y] = [p[0], p[1]];
        for (let i = 1; i <= STEPS; i++) {
            const t = i / STEPS;
            const [nx, ny] = [bezier(p[0], p[2], p[4], p[6], t), bezier(p[1], p[3], p[5], p[7], t)];
            if (nx !== x || ny !== y)
                edges.push([x, y, nx, ny]);
            [x, y] = [nx, ny];
        }
    }
    return edges;
}

// The runs of ink a column finds, bottom to top: [y0, y1, flat], flat how
// near horizontal the edges at both its ends are (1 … 0).
function runsAt(edges, x) {
    const crossings = [];
    for (const [x0, y0, x1, y1] of edges) {
        if (x0 === x1 || x < Math.min(x0, x1) || x >= Math.max(x0, x1))
            continue;
        const level = 90 - offVertical(x1 - x0, y1 - y0);
        crossings.push({
            y: y0 + (x - x0) * (y1 - y0) / (x1 - x0),
            dir: Math.sign(x1 - x0),
            flat: 1 - smoothstep((level - FLAT) / (UPRIGHT - FLAT)),
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
            runs.push([from.y, crossing.y, Math.min(from.flat, crossing.flat)]);
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

// A contour's segments cut where a curve turns across or up and down: each
// piece runs one way in each, and where a curve runs upright or level
// there is a node. (Pieces without length left out.)
function piecesOf(contour) {
    const pieces = [];
    const somewhere = p => p.some((v, i) => v !== p[i % 2]);
    for (const segment of contour) {
        const {cubic, p} = segment;
        if (!cubic) {
            if (somewhere(p))
                pieces.push(segment);
            continue;
        }
        const cuts = [...turns(p[0], p[2], p[4], p[6]), ...turns(p[1], p[3], p[5], p[7])]
            .filter(t => t > NEAR && t < 1 - NEAR).sort((a, b) => a - b);
        let rest = p;
        let done = 0;
        for (const t of cuts) {
            if (t - done < NEAR)
                continue;
            const [a, b] = split(rest, (t - done) / (1 - done));
            pieces.push({cubic: true, p: a});
            rest = b;
            done = t;
        }
        if (somewhere(rest))
            pieces.push({cubic: true, p: rest});
    }
    return pieces;
}

// The way a piece leaves its start, and the way it comes into its end.
function leaving(p) {
    for (const k of [2, 4, 6]) {
        if (Math.abs(p[k] - p[0]) + Math.abs(p[k + 1] - p[1]) > TOUCHING)
            return [p[k] - p[0], p[k + 1] - p[1]];
    }
    return [0, 0];
}

function arriving(p) {
    for (const k of [4, 2, 0]) {
        if (Math.abs(p[6] - p[k]) + Math.abs(p[7] - p[k + 1]) > TOUCHING)
            return [p[6] - p[k], p[7] - p[k + 1]];
    }
    return [0, 0];
}

// Degrees between two directions.
function turnOf([ax, ay], [bx, by]) {
    const d = Math.abs(Math.atan2(ay, ax) - Math.atan2(by, bx)) * 180 / Math.PI;
    return Math.min(d, 360 - d);
}

const upright = ([dx, dy]) => (dx !== 0 || dy !== 0) && offVertical(dx, dy) <= TANGENT;
const level = ([dx, dy]) => (dx !== 0 || dy !== 0) && offVertical(dx, dy) >= 90 - TANGENT;

// How much a row may grow where a chain runs through it this far off
// vertical: as an upright stroke, or a diagonal.
const steep = off => smoothstep((SLANT - off) / (SLANT - STEEP));
const leaning = off => 1 - smoothstep((off - LEANING) / (FLATTEST - LEANING));
const slanted = off => off > SLANTED && off < FLATTEST;

// A run of pieces that join smoothly: how it moves as the glyph stretches.
// A turn (a curve from upright to about level, no diagonal line in it)
// moves as it is, by as much as its level end; the rest stretch between
// where their ends go, and allow the rows they run through to grow as
// much as their weight says.
function chainOf(pieces) {
    const first = pieces[0].p;
    const last = pieces[pieces.length - 1].p;
    const [x0, y0, x1, y1] = [first[0], first[1], last[6], last[7]];
    const [start, end] = [leaving(first), arriving(last)];
    const chord = offVertical(x1 - x0, y1 - y0);
    const length = Math.hypot(x1 - x0, y1 - y0);
    const curved = pieces.some(piece => piece.cubic);
    const diagonalLine = pieces.some(({cubic, p}) => !cubic && slanted(offVertical(p[6] - p[0], p[7] - p[1])));
    // (A curve within its control points: none farther from the chord.)
    const fromChord = (x, y) => Math.abs((x - x0) * (y1 - y0) - (y - y0) * (x1 - x0)) / length;
    const straightish = length > 0 && slanted(chord) &&
        pieces.every(({p}) => [2, 4, 6].every(k => fromChord(p[k], p[k + 1]) <= STRAIGHTISH * length));
    const [upStart, upEnd] = [upright(start), upright(end)];
    const levelish = direction => offVertical(...direction) >= 90 - LEVEL;
    const turn = curved && !diagonalLine && upStart !== upEnd && (upStart ? levelish(end) : levelish(start));
    const spine = diagonalLine || straightish || (upStart !== upEnd && !turn);
    return {
        pieces, x0, y0, x1, y1,
        low: Math.min(y0, y1),
        high: Math.max(y0, y1),
        kind: turn ? 'turn' : 'free',
        // (A turn moves with its level end.)
        anchor: turn ? (upStart ? y1 : y0) : null,
        weight: turn ? 1 : Math.max(steep(chord), spine ? leaning(chord) : 0),
    };
}

// A contour's pieces in chains: runs that join smoothly, broken where they
// meet at a corner, run upright or level on both sides of a node, or turn
// back there. Each runs one way up and one way across. (A closed outline
// always turns back somewhere: it has a chain at least.)
function chainsOf(contour) {
    const pieces = piecesOf(contour);
    const n = pieces.length;
    if (n === 0)
        return [];
    const back = (a, b) => Math.sign(a) * Math.sign(b) < 0;
    const breaks = pieces.map((piece, i) => {
        const before = arriving(pieces[(i + n - 1) % n].p);
        const after = leaving(piece.p);
        return turnOf(before, after) >= JOINED || (upright(before) && upright(after)) ||
            (level(before) && level(after)) || back(before[0], after[0]) || back(before[1], after[1]);
    });
    const first = breaks.indexOf(true);
    if (first < 0)
        return pieces.map(piece => chainOf([piece]));
    const chains = [];
    let run = [];
    for (let k = 0; k < n; k++) {
        const i = (first + k) % n;
        if (k > 0 && breaks[i]) {
            chains.push(chainOf(run));
            run = [];
        }
        run.push(pieces[i]);
    }
    chains.push(chainOf(run));
    return chains;
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
 * height, and the chains its outline moves in: what stretching it to any
 * height needs (kept, it serves every stretch).
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
 *   boundary, ROWS + 1), mode ('upright': rows grow as its chains allow;
 *   'even': all where no stroke runs across; 'affine': all of them, the
 *   outline stretched as a whole; 'dots'), dots (their centres' heights,
 *   for 'dots'), span ([from, to]: the heights it grows within, null for
 *   the band), chains (each contour's)}
 */
export function profileOf(commands, {bottom, top, stroke = null, debug = false}) {
    const contours = contoursOf(commands);
    const height = top - bottom;
    const weights = new Float64Array(ROWS + 1);
    const box = boxOf(contours);
    const profile = {bottom, top, weights, mode: 'affine', dots: null, span: null, chains: contours.map(chainsOf)};
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
    const edges = contours.flatMap(edgesOf);
    // (Not more than a quarter of the height: a stroke, not the glyph.)
    if (!(stroke > 0))
        stroke = strokeOf(commands) || height / 10;
    stroke = Math.min(stroke, height / 4);
    const step = height / ROWS;
    const rowAt = y => (y - bottom) / step;
    // (The rows round a span of heights: all of it moves alike when they
    // keep their height.)
    const rowsRound = (y0, y1) => [Math.max(0, Math.floor(rowAt(y0) + 1e-9)), Math.min(ROWS, Math.ceil(rowAt(y1) - 1e-9))];
    // As much as the chains that run through each row allow.
    const allowed = new Float64Array(ROWS + 1).fill(1);
    for (const chain of profile.chains.flat()) {
        if (chain.weight >= 1 || chain.high - chain.low <= TOUCHING)
            continue;
        const [from, to] = rowsRound(chain.low, chain.high);
        for (let i = from; i <= to; i++)
            allowed[i] = Math.min(allowed[i], chain.weight);
    }
    // Rows a stroke runs across: as much kept as the shortest column says.
    const kept = new Float64Array(ROWS + 1);
    for (const runs of columnsOf(edges, box)) {
        for (const [y0, y1, flat] of runs) {
            const [from, to] = rowsRound(y0, y1);
            const across = flat * (1 - smoothstep((y1 - y0 - THIN * stroke) / ((THICK - THIN) * stroke)));
            for (let i = from; i <= to; i++)
                kept[i] = Math.max(kept[i], across);
        }
    }
    // Rows above or below the glyph's ink (a figure a little shorter than
    // the others) don't grow: it moves up by all of the extra height, as
    // the others do.
    const outside = i => bottom + i * step < box.y1 - 1e-6 * height || bottom + i * step > box.y2 + 1e-6 * height;
    const uprights = Float64Array.from(kept, (k, i) => outside(i) ? 0 : allowed[i] * (1 - k));
    if (debug)
        profile.debug = {allowed, kept, uprights, stroke};
    const share = list => list.reduce((sum, w) => sum + w, 0) / (ROWS + 1);
    // Rows as the chains allow, or (too few of those) all that no stroke
    // runs across, or (none of those: a dash) the room round it, or every
    // one.
    const free = Float64Array.from(kept, (k, i) => outside(i) ? 0 : 1 - k);
    const room = Float64Array.from(kept, k => 1 - k);
    // (Growing within its ink only, it grows within it to the very edge:
    // its top up by all of the extra height, exactly.)
    const ink = [Math.max(bottom, box.y1), Math.min(top, box.y2)];
    if (share(uprights) >= SCARCE) {
        profile.mode = 'upright';
        profile.span = ink;
        weights.set(uprights);
    } else if (share(free) >= SCARCE / 4) {
        profile.mode = 'even';
        profile.span = ink;
        weights.set(free);
    } else if (share(room) >= SCARCE / 4) {
        profile.mode = 'even';
        weights.set(room);
    } else {
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
export function heightMap({bottom, top, weights, span = null}, stretch) {
    const height = top - bottom;
    const extra = (Math.max(0, stretch) - 1) * height;
    const step = height / ROWS;
    // Where it grows: the band, or the part of it its ink takes.
    const [low, high] = span && span[1] > span[0] ? span : [bottom, top];
    // The weights' integral from the bottom to each row boundary, and to
    // any height.
    const sums = new Float64Array(ROWS + 1);
    for (let i = 1; i <= ROWS; i++)
        sums[i] = sums[i - 1] + (weights[i - 1] + weights[i]) / 2 * step;
    const within = y => {
        const at = Math.min(ROWS - 1e-9, Math.max(0, (y - bottom) / step));
        const i = Math.floor(at);
        const f = at - i;
        return {i, f, w: weights[i] + (weights[i + 1] - weights[i]) * f};
    };
    const integral = y => {
        const {i, f, w} = within(y);
        return sums[i] + (weights[i] + w) / 2 * f * step;
    };
    const from = integral(low);
    const total = integral(high) - from;
    // (No weight there: evenly.)
    const grown = total > 0 ? y => extra * (integral(y) - from) / total : y => extra * (y - low) / (high - low);
    return {
        height: height + extra,
        y(y) {
            if (y <= low)
                return y;
            if (y >= high)
                return y + extra;
            return y + grown(y);
        },
        slope(y) {
            if (y < low || y > high)
                return 1;
            return 1 + (total > 0 ? extra * within(y).w / total : extra / (high - low));
        },
    };
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

// How a chain's heights go: a turn moved as its level end is, the rest
// stretched between where their ends go.
function placing(chain, map, keepTurns) {
    if (keepTurns && chain.kind === 'turn') {
        const dy = map.y(chain.anchor) - chain.anchor;
        return y => y + dy;
    }
    const {y0, y1} = chain;
    const from = map.y(y0);
    if (Math.abs(y1 - y0) <= TOUCHING)
        return y => y + from - y0;
    const scale = (map.y(y1) - from) / (y1 - y0);
    return y => from + (y - y0) * scale;
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
    const out = [];
    if (profile.mode === 'dots') {
        const to = dots ?? dotsMap(profile, stretch);
        contoursOf(commands).forEach((contour, i) => {
            const dy = to(profile.dots[i]) - profile.dots[i];
            trace(contour, (x, y) => [x, y + dy], out);
        });
        return out;
    }
    const map = heightMap(profile, stretch);
    // (Stretched as a whole: no turn kept as it is.)
    const keepTurns = profile.mode !== 'affine';
    for (const chains of profile.chains) {
        let first = null;
        let at = null;
        for (const chain of chains) {
            const place = placing(chain, map, keepTurns);
            const [x, y] = [chain.x0, place(chain.y0)];
            if (!first) {
                first = [x, y];
                out.push(['M', x, y]);
            } else if (Math.abs(y - at) > TOUCHING) {
                // Where a turn moved as it is meets what moved otherwise:
                // it runs upright there, and goes on so.
                out.push(['L', x, y]);
            }
            for (const {cubic, p} of chain.pieces) {
                if (cubic)
                    out.push(['C', p[2], place(p[3]), p[4], place(p[5]), p[6], place(p[7])]);
                else
                    out.push(['L', p[6], place(p[7])]);
            }
            at = place(chain.y1);
        }
        if (!first)
            continue;
        // (Back where it began, exactly.)
        if (Math.abs(at - first[1]) > TOUCHING)
            out.push(['L', first[0], first[1]]);
        else
            out[out.length - 1][out[out.length - 1].length - 1] = first[1];
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
