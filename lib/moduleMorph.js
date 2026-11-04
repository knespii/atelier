// The island's glass as the control centre's modules: one rounded piece of
// glass for each, and how one set of them turns into another (the capsule
// splitting into the modules as it opens, the modules flowing into a
// detail's page and out again, back into the capsule as it closes).
//
// A rect is {id, x, y, width, height, radius, bottomRadius, ear}: on the
// stage, its corners (the bottom ones may differ: a notch), and the radius
// of a notch's ears beside its top corners (the capsule's; 0 for modules),
// and how much of a small control's lighter face its glass has (the
// capsule all of it, modules none: shell/core/glassMaterial.js).

/** How many modules the island's glass draws at most (shell/core/glass.js). */
export const MAX_MODULES = 24;

/**
 * Clutter's easeOutExpo, which the island grows and shrinks with.
 *
 * @param {number} t - 0 … 1
 * @returns {number}
 */
export function easeOutExpo(t) {
    return t >= 1 ? 1 : 1 - 2 ** (-10 * Math.max(0, t));
}

/**
 * A rect with all it may have, its corners no rounder than it is.
 *
 * @param {object} rect - {x, y, width, height, radius, [bottomRadius], [ear], [id]}
 * @returns {object}
 */
export function fullRect({id = '', x, y, width, height, radius = 0, bottomRadius = radius, ear = 0, small = 0}) {
    const limit = Math.max(0, Math.min(width, height) / 2);
    return {
        id, x, y, width, height, radius: Math.min(radius, limit), bottomRadius: Math.min(bottomRadius, limit), ear,
        small,
    };
}

/**
 * @param {object} a - a rect
 * @param {object} b - a rect
 * @param {number} t - 0 (a) … 1 (b)
 * @returns {object} the rect between them (b's id)
 */
export function lerpRect(a, b, t) {
    const at = key => a[key] + (b[key] - a[key]) * t;
    return {
        id: b.id, x: at('x'), y: at('y'), width: at('width'), height: at('height'),
        radius: at('radius'), bottomRadius: at('bottomRadius'), ear: at('ear'), small: at('small'),
    };
}

// [x, y, width, height] round some rects, as a rect (no corners rounder
// than the roundest of them, no ears more than theirs); null for none.
function around(rects, id) {
    if (rects.length === 0)
        return null;
    const x1 = Math.min(...rects.map(r => r.x));
    const y1 = Math.min(...rects.map(r => r.y));
    const x2 = Math.max(...rects.map(r => r.x + r.width));
    const y2 = Math.max(...rects.map(r => r.y + r.height));
    return fullRect({
        id, x: x1, y: y1, width: x2 - x1, height: y2 - y1,
        radius: Math.max(...rects.map(r => r.radius)),
        bottomRadius: Math.max(...rects.map(r => r.bottomRadius)),
        ear: Math.max(...rects.map(r => r.ear)),
        small: Math.max(...rects.map(r => r.small)),
    });
}

// A rect shrunk to nothing at its centre.
const pointOf = r => ({...r, x: r.x + r.width / 2, y: r.y + r.height / 2, width: 0, height: 0,
    radius: 0, bottomRadius: 0, ear: 0, small: 0});

/**
 * What is drawn on the way from one set of rects to another, t of the way:
 * - a rect in both (by id) moves from where it was to where it goes;
 * - those only in the old set flow into the one only in the new set (a
 *   detail's page), or into what all of those cover; those only in the new
 *   come out of the one only in the old (the capsule), or out of what all
 *   of those covered: one new (or old) one, it is drawn only as the others
 *   have become it (they are all of it there);
 * - with none on the other side, they shrink to (grow out of) their centre.
 * Those in both first (in the new set's order), then the new, then the old
 * ones: the first is the one with the ears (the capsule, the tabs).
 *
 * @param {object[]} from - rects (fullRect()'s)
 * @param {object[]} to - rects
 * @param {number} t - 0 (from) … 1 (to), eased
 * @returns {object[]} rects, those with no area left out
 */
export function morphRects(from, to, t) {
    if (t >= 1)
        return to.filter(r => r.width > 0 && r.height > 0);
    const old = new Map(from.map(r => [r.id, r]));
    const ids = new Set(to.map(r => r.id));
    const both = to.filter(r => old.has(r.id)).map(r => lerpRect(old.get(r.id), r, t));
    const added = to.filter(r => !old.has(r.id));
    const gone = from.filter(r => !ids.has(r.id));
    const drawn = [...both];
    if (added.length === 1 && gone.length > 0) {
        // (The new one is all of where they go.)
        drawn.push(...gone.map(r => ({...lerpRect(r, {...added[0], id: r.id}, t)})));
    } else if (gone.length === 1 && added.length > 0) {
        drawn.push(...added.map(r => lerpRect(gone[0], r, t)));
    } else {
        const into = around(added, '');
        const outOf = around(gone, '');
        drawn.push(...added.map(r => lerpRect(outOf ? {...outOf, id: r.id} : pointOf(r), r, t)));
        drawn.push(...gone.map(r => ({...lerpRect(r, into ? {...into, id: r.id} : pointOf(r), t)})));
    }
    return drawn.filter(r => r.width > 0.01 && r.height > 0.01);
}

/**
 * Whether two sets of rects are the same, within a hundredth of a pixel.
 *
 * @param {object[]} a
 * @param {object[]} b
 * @returns {boolean}
 */
export function sameRects(a, b) {
    if (a.length !== b.length)
        return false;
    const keys = ['x', 'y', 'width', 'height', 'radius', 'bottomRadius', 'ear', 'small'];
    return a.every((r, i) => r.id === b[i].id && keys.every(k => Math.abs(r[k] - b[i][k]) < 0.01));
}
