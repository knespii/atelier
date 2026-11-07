// The control centre's motion (its Layout & Motion spec): the curves and
// times of each transition, cubic-bezier easing that may overshoot past 1
// (Clutter's own modes don't), and tweens that go on from wherever they are
// when they are turned round. Pure, for the unit tests; the shell's side
// (shell/controlCentre/animator.js) runs them frame by frame on actors.

/**
 * A CSS cubic-bezier(x1, y1, x2, y2) timing function: its y for a given
 * x (time, 0 … 1). y1 and y2 may be past 0 … 1: it overshoots and settles.
 *
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {Function} (t) => progress
 */
export function cubicBezier(x1, y1, x2, y2) {
    // B(s) = 3(1-s)²s·p1 + 3(1-s)s²·p2 + s³ (p0 = 0, p3 = 1).
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const xAt = s => ((ax * s + bx) * s + cx) * s;
    const yAt = s => ((ay * s + by) * s + cy) * s;
    const dxAt = s => (3 * ax * s + 2 * bx) * s + cx;
    // The s whose x is t: Newton's method, then halving where it stalls.
    const solve = t => {
        let s = t;
        for (let i = 0; i < 8; i++) {
            const error = xAt(s) - t;
            if (Math.abs(error) < 1e-7)
                return s;
            const d = dxAt(s);
            if (Math.abs(d) < 1e-6)
                break;
            s -= error / d;
        }
        let lo = 0;
        let hi = 1;
        s = t;
        for (let i = 0; i < 40; i++) {
            const x = xAt(s);
            if (Math.abs(x - t) < 1e-7)
                break;
            if (x < t)
                lo = s;
            else
                hi = s;
            s = (lo + hi) / 2;
        }
        return s;
    };
    return t => {
        if (t <= 0)
            return 0;
        if (t >= 1)
            return 1;
        return yAt(solve(t));
    };
}

/** The spec's curves (its cubic-bezier values). */
export const CURVES = Object.freeze({
    // Cards growing and shrinking, the neighbours stepping back.
    morph: [0.2, 0.9, 0.25, 1.05],
    // A switch's accent circle, a card's chevron.
    spring: [0.3, 0.7, 0.3, 1.3],
    // The selection pill (chips, the output list).
    slide: [0.3, 0.7, 0.3, 1.25],
    // List items coming in.
    enter: [0.2, 0.9, 0.25, 1.1],
    // The panel opening; and everything, with reduced motion.
    out: [0.2, 0.8, 0.2, 1],
    // Each tile as the panel opens.
    open: [0.2, 0.9, 0.25, 1.15],
    // A button held down.
    press: [0.3, 0.7, 0.4, 1.5],
    // Fades and colours: no overshoot.
    fade: [0.25, 0.1, 0.25, 1],
    linear: [0, 0, 1, 1],
});

const EASES = Object.fromEntries(Object.entries(CURVES).map(([name, curve]) => [name, cubicBezier(...curve)]));

/**
 * @param {string} name - one of CURVES
 * @returns {Function} its easing
 */
export function easeOf(name) {
    const ease = EASES[name];
    if (!ease)
        throw new Error(`no curve ${name}`);
    return ease;
}

/** The spec's times (ms). */
export const DURATIONS = Object.freeze({
    morph: 480,
    hideFade: 260,
    hideMove: 420,
    dimFade: 360,
    dimMove: 480,
    toggle: 380,
    chevron: 420,
    row: 420,
    rowStep: 50,
    select: 440,
    selectColour: 250,
    raisedBg: 300,
    miniPills: 380,
    chipsBack: 380,
    open: 480,
    press: 160,
    rowBg: 250,
    spin: 800,
    // The system tile's battery bar: filled as the panel opens, to a new
    // level, lifted under the pointer; its shimmer's loop while charging.
    batteryGrow: 600,
    batteryLevel: 340,
    batteryHover: 200,
    batteryWave: 2000,
});

/**
 * The panel opening: each tile's delay (ms), in the spec's order.
 */
export const OPEN_DELAYS = Object.freeze({
    wifi: 60, wired: 60, bt: 110, caffeine: 140, airplane: 160, output: 190, brightness: 220, volume: 260, system: 300,
});

/** With reduced motion: every transition so long, eased out, no overshoot. */
export const REDUCED_DURATION = 150;

/**
 * What a transition is, motion reduced or not.
 *
 * @param {string} curve - one of CURVES
 * @param {number} duration - ms
 * @param {number} delay - ms
 * @param {boolean} reduced - with reduced motion
 * @returns {{curve: string, duration: number, delay: number}}
 */
export function transitionOf(curve, duration, delay, reduced) {
    if (!reduced)
        return {curve, duration, delay};
    // (Fades keep theirs, shortened.)
    return {curve: curve === 'fade' || curve === 'linear' ? curve : 'out',
        duration: Math.min(duration, REDUCED_DURATION), delay: 0};
}

/**
 * A list's items coming in as a card opens: when each starts (ms) – the
 * spec's 90 / 140 / 190 … for Wi-Fi and Bluetooth, 80 / 130 / 180 for the
 * outputs; the last row of a list ("Other network…", "Pair new device…")
 * a little after the rest, as at 250 after three.
 *
 * @param {number} count - its rows, the last included
 * @param {object} [options]
 * @param {number} [options.first] - the first's delay
 * @param {boolean} [options.lastApart] - the last row comes 60 ms after the one before it
 * @returns {number[]}
 */
export function rowDelays(count, {first = 90, lastApart = true} = {}) {
    const delays = [];
    for (let i = 0; i < count; i++) {
        const apart = lastApart && i === count - 1 && i > 0;
        delays.push(apart ? delays[i - 1] + 60 : first + i * DURATIONS.rowStep);
    }
    return delays;
}

/**
 * A value on its way from one to another: started at some time, after a
 * delay, over a duration, eased. Turned round (a new target) while it goes,
 * it goes on from where it is – no jump back to where it started.
 */
export class Tween {
    /**
     * @param {object} params
     * @param {number} params.from
     * @param {number} params.to
     * @param {number} params.start - ms, a clock's
     * @param {number} params.duration - ms
     * @param {number} [params.delay] - ms
     * @param {Function} [params.ease] - (t) => progress
     */
    constructor({from, to, start, duration, delay = 0, ease = easeOf('linear')}) {
        Object.assign(this, {from, to, start, duration, delay, ease});
    }

    /**
     * @param {number} now - ms
     * @returns {number} its value then
     */
    valueAt(now) {
        const t = this.duration > 0 ? (now - this.start - this.delay) / this.duration : 1;
        if (t <= 0)
            return this.from;
        if (t >= 1)
            return this.to;
        return this.from + (this.to - this.from) * this.ease(t);
    }

    /**
     * @param {number} now - ms
     * @returns {boolean} whether it has got there
     */
    doneAt(now) {
        return now - this.start - this.delay >= this.duration;
    }
}
