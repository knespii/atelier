// The lock screen's glass clock, its sums (shell/lockscreen/clock.js draws
// it): the font file and the instance its digits are drawn in, how large
// they are drawn to fill the clock's width, where each figure of the time
// stands – tabular, the line centred by its advance, so that a figure that
// changes moves none of the others – and how a figure goes as the minute
// turns: the old one up and away, the new one rising into its place, as on
// an iPhone's lock screen. And what is worked out ahead: how each figure
// of an instance stretches, the slow part, so that the lock screen never
// pays for it in a frame. Plain gjs (HarfBuzz through lib/glyphOutlines.js):
// shared by the shell and the tests.

import {axesOf, bundledFile, fontAt, systemFontFile, traceOutline} from './glyphOutlines.js';
import {inkOf} from './glyphStretch.js';
import {variationsFor} from './lockType.js';
import {pixelSize} from './widgets.js';

/** The figures a clock shows: what is worked out ahead. */
export const FIGURES = '0123456789:';

/** What the digits are sized for: their size stays as the minutes go. */
export const SAMPLE = '00:00';

/**
 * The OpenType features the time is set with: tabular figures (all as
 * wide: the time doesn't wobble as it goes) and a colon as high as they are.
 */
export const FEATURES = ['tnum', 'case'];

/** Of the clock's width the digits take, at most. */
export const FILL = 0.98;

// A line of SAMPLE in ems, about: what the optical size a clock of a size
// draws its digits at is worked out with – the same in the session and on
// the lock screen, whatever the clock's padding.
const SAMPLE_EMS = 2.8;

// How much grade a plan's boldness comes to, at its most (Roboto Flex's
// GRAD: heavier strokes, the same advances).
const GRADE = 150;

/**
 * The file a typeface's digits are drawn from.
 *
 * @param {object} typeface - lib/lockType.js typefaceFor()
 * @param {number} weight - the weight they are drawn in (for a family of a
 *   file per weight: the nearest one)
 * @param {string|null} [shellFamily] - the family of the shell's own font
 *   (the default typeface's, and one whose families aren't installed)
 * @returns {string|null} its path; null when none is known (Pango draws
 *   them then)
 */
export function fontFile(typeface, weight, shellFamily = null) {
    if (typeface.file)
        return bundledFile(typeface.file);
    const family = typeface.family ?? shellFamily?.split(',')[0].trim();
    return family ? systemFontFile(family, weight) : null;
}

/**
 * How a legibility plan makes type heavier: on the font's grade where it
 * has the axis (heavier strokes, the same advances: the line stays as it
 * is), on its weight otherwise.
 *
 * @param {object|null} axes - the font's, {tag: {min, default, max}}
 * @param {number} weight - the type's own
 * @param {object|null} plan - lib/lockLook.js legibilityPlan(): its
 *   boldness (0 … 1) and the weight it comes to
 * @returns {{weight: number, extra: object}} the weight to draw in, and the
 *   other axes' values as lib/lockType.js variationsFor() takes them
 */
export function heavier(axes, weight, plan) {
    const boldness = Math.min(1, Math.max(0, plan?.boldness ?? 0));
    if (!(boldness > 0))
        return {weight, extra: {}};
    if (axes?.GRAD)
        return {weight, extra: {GRAD: boldness * GRADE}};
    return {weight: Math.max(weight, plan.weight ?? weight), extra: {}};
}

/**
 * @param {string} size - a clock's size (lib/widgets.js SIZES)
 * @param {number} [scaleX] - how much narrower (or wider) its digits are
 *   drawn than the font makes them
 * @returns {number} the optical size its digits are drawn at: about as
 *   large as they are, logical pixels
 */
export function opticalSize(size, scaleX = 1) {
    const [width] = pixelSize(size);
    return Math.round(FILL * width / (SAMPLE_EMS * Math.max(0.1, scaleX)));
}

/**
 * The instance of a font a glass clock's digits are drawn in: the style's
 * weight and width, a plan's grade or weight (in a family of a file per
 * weight, its heavier file), and the optical size of a clock of its size –
 * the same wherever it is asked for (the session works its figures out
 * ahead, the lock screen draws with them).
 *
 * @param {object} typeface - lib/lockType.js typefaceFor()
 * @param {object} style - styleFor() the glass digits: {weight, width}
 * @param {object} [options]
 * @param {string} [options.size] - the clock's size (lib/widgets.js SIZES)
 * @param {object|null} [options.plan] - the digits' legibility plan
 * @param {string|null} [options.shellFamily] - as for fontFile()
 * @returns {{font: object|null, file: string|null, variations: string,
 *   scaleX: number, weight: number, extra: object, key: string}} font, a
 *   lib/glyphOutlines.js GlyphFont, null where there is no file or it can't
 *   be read (Pango draws the digits then, in the weight and with the
 *   variations given); key tells one instance from another
 */
export function glassInstance(typeface, style, {size = 'large', plan = null, shellFamily = null} = {}) {
    let file = fontFile(typeface, style.weight, shellFamily);
    let axes = typeface.axes ?? (file ? axesOf(file) : null);
    const {weight, extra} = heavier(axes, style.weight, plan);
    if (weight !== style.weight && file && axes && !axes.wght) {
        file = fontFile(typeface, weight, shellFamily);
        axes = file ? axesOf(file) : null;
    }
    // (The optical size of the digits as wide as they are drawn.)
    const {scaleX: wide} = variationsFor(axes, {weight, width: style.width});
    const {variations, scaleX} = variationsFor(axes, {
        weight, width: style.width, size: opticalSize(size, wide), extra,
    });
    let font = null;
    if (file && axes) {
        try {
            font = fontAt(file, variations);
        } catch {
            font = null;
        }
    }
    const from = font ? file : `pango:${typeface.family ?? ''}`;
    return {font, file: font ? file : null, variations, scaleX, weight, extra, key: `${from}\n${variations}\n${scaleX}`};
}

// Each font's figure cell: as wide as its widest figure where its tabular
// figures aren't all as wide (or it has none); null where they are.
const cells = new WeakMap();

function cellOf(font) {
    if (!cells.has(font)) {
        const advances = font.shape(FIGURES.replace(/\D/g, ''), FEATURES).glyphs.map(g => g.advance);
        const widest = Math.max(...advances);
        cells.set(font, advances.every(advance => advance === widest) ? null : widest);
    }
    return cells.get(font);
}

/**
 * A line of the time as the font sets it, tabular: its figures all as wide
 * (the font's tabular figures; where it has none, each in the middle of a
 * cell as wide as its widest), so that one that changes moves none of the
 * others.
 *
 * @param {object} font - a GlyphFont
 * @param {string} text
 * @returns {{glyphs: object[], advance: number}} each glyph's {glyph, char,
 *   index (its character's place in the text), x (where its origin goes),
 *   dy (how far over the baseline)}, and the line's advance; font units
 */
export function setLine(font, text) {
    const cell = cellOf(font);
    const chars = [...text];
    let pen = 0;
    const glyphs = font.shape(text, FEATURES).glyphs.map(g => {
        const char = chars[g.cluster] ?? '';
        const width = cell !== null && /^\d$/.test(char) ? cell : g.advance;
        const x = pen + (width - g.advance) / 2 + g.dx;
        pen += width;
        return {glyph: g.glyph, char, index: g.cluster, x, dy: g.dy};
    });
    return {glyphs, advance: pen};
}

/**
 * How large the digits are drawn to fill a width.
 *
 * @param {object} font - a GlyphFont
 * @param {number} width - pixels
 * @param {number} [scaleX]
 * @returns {number} the font's size in those pixels, whole: a line of
 *   SAMPLE as wide as FILL of the width, at most
 */
export function fitSize(font, width, scaleX = 1) {
    const {advance} = setLine(font, SAMPLE);
    return Math.max(8, Math.floor(width * FILL * font.upem / (Math.max(1, advance) * scaleX)));
}

/**
 * A line of the time (setLine()), centred in a width by its advance.
 *
 * @param {object} font - a GlyphFont
 * @param {string} text
 * @param {object} place
 * @param {number} place.size - the font's size, pixels
 * @param {number} [place.scaleX]
 * @param {number} place.width - what it is centred in
 * @returns {{glyphs: object[], x: number, width: number}} each glyph's
 *   {glyph, char, index, x (where its origin goes, from the width's left),
 *   dy (how far under the baseline)}, and where the line starts and how
 *   wide it is; pixels
 */
export function lineOf(font, text, {size, scaleX = 1, width}) {
    const {glyphs, advance} = setLine(font, text);
    const k = size / font.upem;
    const lineWidth = advance * k * scaleX;
    const x = (width - lineWidth) / 2;
    return {
        x,
        width: lineWidth,
        glyphs: glyphs.map(g => ({...g, x: x + g.x * k * scaleX, dy: -g.dy * k})),
    };
}

// Outlines stretched, kept by whoever draws them: up to so many (a stretch
// easing makes some for each frame).
const KEPT = 48;

/**
 * A line of the time as it is drawn: each glyph's outline stretched as tall
 * as the figures stand (lib/glyphStretch.js, through the font), where it
 * goes, and its ink's box there.
 *
 * @param {object} font - a GlyphFont
 * @param {string} text
 * @param {object} place - as for lineOf(), and:
 * @param {number} place.stretch - how much taller than they are the figures
 *   stand
 * @param {number} place.level - where their top is (the flat top of a "1")
 * @param {Map} [place.kept] - the outlines stretched before, kept there
 *   (for this font only)
 * @returns {object[]} each glyph's {glyph, char, index, x, y (its baseline),
 *   commands (its outline, stretched), box ({x, y, width, height} of its
 *   ink; null for none)}
 */
export function placeLine(font, text, {size, scaleX = 1, width, stretch, level, kept = null}) {
    const k = size / font.upem;
    const {bottom, top} = font.figures;
    const baseline = level + (bottom + stretch * (top - bottom)) * k;
    return lineOf(font, text, {size, scaleX, width}).glyphs.map(g => {
        const key = `${g.glyph}@${stretch}`;
        let outline = kept?.get(key);
        if (!outline) {
            const commands = font.stretched(g.glyph, stretch);
            outline = {commands, ink: inkOf(commands)};
            if (kept?.size >= KEPT)
                kept.clear();
            kept?.set(key, outline);
        }
        const {ink} = outline;
        const y = baseline + g.dy;
        const box = ink && {
            x: g.x + ink.x1 * k * scaleX,
            y: y - ink.y2 * k,
            width: (ink.x2 - ink.x1) * k * scaleX,
            height: (ink.y2 - ink.y1) * k,
        };
        return {...g, y, commands: outline.commands, box};
    });
}

/**
 * Add glyphs placeLine() placed to a Cairo path.
 *
 * @param {object} cr - a Cairo context
 * @param {object[]} glyphs - placeLine()'s
 * @param {object} place
 * @param {number} place.scale - pixels per font unit (size / upem)
 * @param {number} [place.scaleX]
 * @param {number} [place.dx] - moved so far across
 * @param {number} [place.dy] - and down
 */
export function traceLine(cr, glyphs, {scale, scaleX = 1, dx = 0, dy = 0}) {
    for (const g of glyphs)
        traceOutline(cr, g.commands, {x: g.x + dx, y: g.y + dy, scale, scaleX});
}

/**
 * @param {object[]} boxes - {x, y, width, height}, some of them null
 * @returns {object|null} the box round all of them; null for none
 */
export function boxRound(boxes) {
    const known = boxes.filter(Boolean);
    if (known.length === 0)
        return null;
    const [x1, y1] = [Math.min(...known.map(b => b.x)), Math.min(...known.map(b => b.y))];
    const [x2, y2] = [Math.max(...known.map(b => b.x + b.width)), Math.max(...known.map(b => b.y + b.height))];
    return {x: x1, y: y1, width: x2 - x1, height: y2 - y1};
}

/**
 * Which figures of the time change from one minute to the next: those that
 * differ where they stand; all of them when the line grows or shrinks (it
 * is centred anew: 9:59 to 10:00).
 *
 * @param {string} before - '' when nothing was shown yet (then nothing
 *   changes: the first time is just there)
 * @param {string} after
 * @returns {{leaving: number[], coming: number[]}} the places of the
 *   characters that go (in before) and come (in after)
 */
export function changedFigures(before, after) {
    const [was, is] = [[...before ?? ''], [...after ?? '']];
    if (was.length === 0 || is.length === 0)
        return {leaving: [], coming: []};
    if (was.length !== is.length)
        return {leaving: was.map((_, i) => i), coming: is.map((_, i) => i)};
    const changed = is.map((_, i) => i).filter(i => was[i] !== is[i]);
    return {leaving: changed, coming: [...changed]};
}

/**
 * A figure changing as the minute turns: how long it takes (ms, as GNOME's
 * animation settings have it), and how far the figures travel, of how tall
 * they stand.
 */
export const CHANGE = {time: 450, travel: 0.25};

const smoothstep = (from, to, t) => {
    const c = Math.min(1, Math.max(0, (t - from) / (to - from)));
    return c * c * (3 - 2 * c);
};

/**
 * The figures that change, t of the way through: the old one lifting as it
 * fades (slowly at first: gone before it has gone far), the new one rising
 * into its place from below as it comes in, fast at first and settling
 * gently – in sight as the old one goes, the two seldom over each other.
 *
 * @param {number} t - 0 … 1, of CHANGE.time
 * @returns {{leaving: {dy: number, alpha: number}, coming: {dy: number,
 *   alpha: number}}} dy how far below its place, of the way it travels
 *   (negative: above it)
 */
export function changeAt(t) {
    const c = Math.min(1, Math.max(0, t));
    return {
        leaving: {dy: -c * c, alpha: 1 - smoothstep(0, 0.4, c)},
        coming: {dy: (1 - c) ** 3, alpha: smoothstep(0.15, 0.65, c)},
    };
}

// The glyphs of each instance whose stretch it has worked out (it keeps
// what it works out: lib/glyphOutlines.js); drawing them costs little then.
const learnt = new WeakMap();

/**
 * @param {object} font - a GlyphFont
 * @param {string} [text] - figures besides FIGURES (a time in other digits)
 * @returns {number[]} the glyphs of FIGURES (and of the text) whose stretch
 *   the font has yet to work out
 */
export function unlearnt(font, text = '') {
    const known = learnt.get(font);
    const glyphs = new Set([...FIGURES, ...text].map(char => font.glyphOf(char)).filter(glyph => glyph > 0));
    return [...glyphs].filter(glyph => !known?.has(glyph));
}

/**
 * Work out how a glyph stretches: a few milliseconds, once for each glyph
 * of an instance (a glyph at a time, while the shell is idle).
 *
 * @param {object} font - a GlyphFont
 * @param {number} glyph
 */
export function learn(font, glyph) {
    // (Its profile, which every stretch takes; at 1, nothing stretched.)
    font.stretched(glyph, 1);
    let known = learnt.get(font);
    if (!known) {
        known = new Set();
        learnt.set(font, known);
    }
    known.add(glyph);
}
