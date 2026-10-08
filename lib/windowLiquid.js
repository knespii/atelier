// Windows as liquid, as they open: out of the dock, a drop swells from the
// app's icon, lets go, flies to the window and spreads into it; opened
// otherwise, a window spreads out of a drop in its middle; closing, it draws
// into it (lib/liquid.js spread() and gather()). Pure functions of how far
// along they are, shared by the shell and the tests.
//
// Rectangles are {x, y, width, height}; shapes as lib/liquid.js has them.

import {clamp01, gather, spread} from './liquid.js';

const lerp = (a, b, t) => a + (b - a) * t;
const between = (t, from, to) => clamp01((t - from) / (to - from));
const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = t => 1 - (1 - t) ** 3;

// Parts of the way out of the dock: the drop has swollen, let go, reached
// the window; the window has spread.
export const SWOLLEN = 0.28;
const LET_GO = 0.36;
export const REACHED = 0.6;
// How high the drop arcs on its way, in drops.
const ARC = 3;

const asArray = r => [r.x, r.y, r.width, r.height];

/**
 * Where a drop from the dock meets a window: the point of the window
 * nearest to the icon.
 *
 * @param {object} icon - its rectangle on the stage
 * @param {object} frame - the window's
 * @returns {number[]} [x, y]
 */
export function entryPoint(icon, frame) {
    const cx = icon.x + icon.width / 2;
    const cy = icon.y + icon.height / 2;
    return [
        Math.min(frame.x + frame.width, Math.max(frame.x, cx)),
        Math.min(frame.y + frame.height, Math.max(frame.y, cy)),
    ];
}

/**
 * The drop out of the dock, on the stage: it swells from the edge of the
 * icon facing away from the dock, hangs on a neck, lets go and flies to
 * the window in an arc, and goes into it as the window spreads.
 *
 * @param {object} params
 * @param {object} params.icon - the app's icon, its rectangle on the stage
 * @param {string} params.side - the dock's edge: 'BOTTOM', 'TOP', 'LEFT', 'RIGHT'
 * @param {object} params.frame - the window's rectangle on the stage
 * @param {number} params.drop - the drop's radius, pixels
 * @param {number} params.blend - how near the liquid melts, pixels
 * @param {number} t - 0 to 1
 * @returns {object} {boxes, capsules}
 */
export function dropFromDock({icon, side, frame, drop, blend}, t) {
    if (t >= REACHED + 0.12)
        return {boxes: [], capsules: []};
    const away = {BOTTOM: [0, -1], TOP: [0, 1], LEFT: [1, 0], RIGHT: [-1, 0]}[side] ?? [0, -1];
    const cx = icon.x + icon.width / 2;
    const cy = icon.y + icon.height / 2;
    // The edge of the icon facing away from the dock.
    const lip = [cx + away[0] * icon.width / 2, cy + away[1] * icon.height / 2];
    const swell = easeOut(between(t, 0, SWOLLEN));
    const fly = easeInOut(between(t, LET_GO - 0.04, REACHED));
    const into = between(t, REACHED - 0.04, REACHED + 0.12);
    const r = drop * swell * (1 - into);
    // Hanging off the icon, then on its way, a little drawn out.
    const hang = [lip[0] + away[0] * r * 1.2, lip[1] + away[1] * r * 1.2];
    const [ex, ey] = entryPoint(icon, frame);
    const lift = ARC * drop * Math.sin(Math.PI * fly);
    const x = lerp(hang[0], ex, fly) + away[0] * lift;
    const y = lerp(hang[1], ey, fly) + away[1] * lift;
    const stretch = 1 + 0.35 * Math.sin(Math.PI * fly);
    const boxes = r > 0.25 ? [[x, y, r / Math.sqrt(stretch), r * Math.sqrt(stretch), r / Math.sqrt(stretch), blend]] : [];
    // The neck to the icon, thinning until it lets go.
    const neck = r * 0.5 * (1 - between(t, SWOLLEN, LET_GO));
    const capsules = neck > 0.25 ? [[lip[0], lip[1], x, y, neck, blend]] : [];
    return {boxes, capsules};
}

/**
 * The window out of the dock, in the window actor's own pixels: hidden
 * until the drop reaches it, then spreading from where it came in.
 *
 * @param {object} params
 * @param {object} params.icon - the app's icon, on the stage
 * @param {object} params.frame - the window's rectangle on the stage
 * @param {object} params.actor - the window actor's rectangle on the stage
 *   (with its shadow)
 * @param {number} params.drop - the drop's radius, pixels
 * @param {number} params.radius - of the window's corners, pixels
 * @param {number} t - 0 to 1
 * @returns {object} {boxes, capsules}
 */
export function windowFromDock({icon, frame, actor, drop, radius}, t) {
    if (t < REACHED - 0.04)
        return {boxes: [], capsules: []};
    const [ex, ey] = entryPoint(icon, frame);
    const u = easeOut(between(t, REACHED - 0.04, 1));
    // From a drop where it came in to the frame, then out to the shadow.
    const full = between(t, 0.92, 1);
    const cx = lerp(ex, frame.x + frame.width / 2, u);
    const cy = lerp(ey, frame.y + frame.height / 2, u);
    let half = [lerp(drop, frame.width / 2, u ** 0.9), lerp(drop, frame.height / 2, u)];
    let center = [cx, cy];
    let corner = Math.min(lerp(drop, radius, u), ...half);
    if (full > 0) {
        center = [lerp(cx, actor.x + actor.width / 2, full), lerp(cy, actor.y + actor.height / 2, full)];
        half = [lerp(half[0], actor.width / 2, full), lerp(half[1], actor.height / 2, full)];
        corner = lerp(corner, 0, full);
    }
    return {
        boxes: [[center[0] - actor.x, center[1] - actor.y, half[0], half[1], corner, 0]],
        capsules: [],
    };
}

/**
 * A window opened otherwise, in the actor's own pixels: out of a drop in
 * its middle, spreading into it (and out to its shadow at the end).
 *
 * @param {object} frame - the window's rectangle on the stage
 * @param {object} actor - the window actor's, with its shadow
 * @param {number} radius - of the window's corners
 * @param {number} t - 0 to 1
 * @returns {object} {boxes, capsules}
 */
export function windowFromMiddle(frame, actor, radius, t) {
    const local = {x: frame.x - actor.x, y: frame.y - actor.y, width: frame.width, height: frame.height};
    const shape = spread(asArray(local), clamp01(t / 0.92), {radius});
    const full = between(t, 0.92, 1);
    if (full === 0)
        return shape;
    const [box] = shape.boxes;
    return {
        boxes: [[
            lerp(box[0], actor.width / 2, full), lerp(box[1], actor.height / 2, full),
            lerp(box[2], actor.width / 2, full), lerp(box[3], actor.height / 2, full),
            lerp(box[4], 0, full), 0,
        ]],
        capsules: [],
    };
}

/**
 * A window closing, in its picture's own pixels: drawing into its middle,
 * rounding up into a drop that is gone.
 *
 * @param {object} frame - the window's rectangle within the picture
 * @param {number} radius - of its corners
 * @param {number} t - 0 to 1
 * @returns {object} {boxes, capsules}
 */
export function windowClosing(frame, radius, t) {
    return gather(asArray(frame), clamp01(t), {radius});
}
