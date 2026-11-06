// CSS's cubic-bezier() timing functions, overshooting ones too (y below 0
// or above 1: a spring that goes past its end and settles), which
// Clutter's AnimationMode has none of. Pure, for the unit tests.

/**
 * @param {number} x1 - the first control point's time, 0 … 1
 * @param {number} y1 - its progress (any: above 1 overshoots)
 * @param {number} x2 - the second's time, 0 … 1
 * @param {number} y2 - its progress
 * @returns {function(number): number} time (0 … 1) to progress (0 at 0, 1
 *   at 1, in between whatever the curve has)
 */
export function cubicBezier(x1, y1, x2, y2) {
    x1 = Math.min(1, Math.max(0, x1));
    x2 = Math.min(1, Math.max(0, x2));
    // (The curve's polynomials, from (0, 0) to (1, 1): a·t³ + b·t² + c·t.)
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const xAt = t => ((ax * t + bx) * t + cx) * t;
    const yAt = t => ((ay * t + by) * t + cy) * t;
    const slopeAt = t => (3 * ax * t + 2 * bx) * t + cx;
    // The curve's t where its time is x: Newton's, then halving where
    // that won't do (x always grows with t, x1 and x2 being in 0 … 1).
    const solve = x => {
        let t = x;
        for (let i = 0; i < 8; i++) {
            const error = xAt(t) - x;
            if (Math.abs(error) < 1e-7)
                return t;
            const slope = slopeAt(t);
            if (Math.abs(slope) < 1e-6)
                break;
            t -= error / slope;
        }
        let low = 0, high = 1;
        t = x;
        for (let i = 0; i < 40 && high - low > 1e-7; i++) {
            if (xAt(t) < x)
                low = t;
            else
                high = t;
            t = (low + high) / 2;
        }
        return t;
    };
    return x => {
        if (!(x > 0))
            return 0;
        if (x >= 1)
            return 1;
        return yAt(solve(x));
    };
}

/** @returns {number} t itself: linear */
export const linear = t => Math.min(1, Math.max(0, t));

// The control centre's curves (its spec's motion tokens).
export const EASE = {
    // CSS's own `ease`, for transitions that name none.
    ease: cubicBezier(0.25, 0.1, 0.25, 1),
    out: cubicBezier(0.2, 0.8, 0.2, 1),
    spring: cubicBezier(0.3, 0.7, 0.3, 1.3),
    grab: cubicBezier(0.3, 1.5, 0.4, 1),
    release: cubicBezier(0.3, 1.6, 0.4, 1),
    rubber: cubicBezier(0.3, 1.8, 0.4, 1),
    settle: cubicBezier(0.3, 1.3, 0.4, 1),
    bump: cubicBezier(0.3, 1.5, 0.4, 1),
    morph: cubicBezier(0.2, 0.9, 0.25, 1.05),
    slide: cubicBezier(0.3, 0.7, 0.3, 1.25),
    enter: cubicBezier(0.2, 0.9, 0.25, 1.1),
};
