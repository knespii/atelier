// How the lock screen's widgets look: the one tone of their type, picked
// from the wallpaper behind all of them (a light tint of the palette's hue,
// as an iPhone's; a dark one only where light would not read), what it
// takes each part of them to read where it is – nothing where it reads as
// it is; else a heavier weight, a soft shadow round its letters, more
// opaque glass, as iOS does (contrast as APCA has it, lib/apca.js) – which
// of their parts are the big digits and which text (the fonts they are set
// in: lib/lockType.js), how tall the glass clock's digits stand, and what
// the battery says. Pure functions, shared by the shell and the preferences.

import {blend, contrastLc, minimumLc} from './apca.js';
import {glassColor, glassFor, glassTint} from './glassBackdrop.js';
import {regionPixels, tenths} from './lockColor.js';
import {hexToOklch, hexToRgb, luminance, oklchToHex, rgbToHex} from './palette.js';

/**
 * The lock screen's type, as stylesheet.css sets it: the date line (the
 * weather's and the battery's values too, in a line), a small widget's
 * caption, and a large clock's digits (the glass clock's are drawn
 * larger still). Sizes in CSS pixels (pt × 4/3), weights as wght.
 */
export const TYPE = {
    line: {size: 20, weight: 600},
    caption: {size: 44 / 3, weight: 600},
    digits: {size: 304 / 3, weight: 800},
};

/**
 * How far type may go to read (legibilityPlan()): so much heavier (wght),
 * a shadow of so much alpha, glass so opaque, at most. The lock screen's
 * type is light where light type reads with the soft ones.
 */
export const REACH = {
    full: {bolder: 200, shadow: 0.6, glass: 0.92},
    soft: {bolder: 100, shadow: 0.35, glass: null},
};

/** @returns {boolean} whether it is a colour as the settings keep one: '#rrggbb' */
export const isColor = value => /^#[0-9a-f]{6}$/i.test(value ?? '');

/**
 * Where a part of the screen is in a sample of its wallpaper: the
 * wallpaper fills the screen (zoomed, cut to its middle), as GNOME shows
 * it by default.
 *
 * @param {number[]} rect - [x, y, width, height] on the screen, 0 … 1
 * @param {number} aspect - the screen's width over its height
 * @param {number} sampleAspect - the sample's
 * @returns {number[]} [x, y, width, height] in the sample, 0 … 1
 */
export function regionIn([x, y, width, height], aspect, sampleAspect) {
    let [sx, sy, sw, sh] = [0, 0, 1, 1];
    if (aspect > sampleAspect) {
        sh = sampleAspect / aspect;
        sy = (1 - sh) / 2;
    } else {
        sw = aspect / sampleAspect;
        sx = (1 - sw) / 2;
    }
    return [sx + x * sw, sy + y * sh, width * sw, height * sh];
}

/**
 * What there is in a part of a sample of the wallpaper.
 *
 * @param {object} sample - {pixels, channels, rowstride, width, height}
 * @param {number[]} region - [x, y, width, height] in it, 0 … 1
 * @returns {{mean: string, low: number, high: number, middle: number, tenths: object}|null}
 *   its average colour; how light its darker and lighter tenths are and its
 *   middle (WCAG luminance); the colours there as a screen shows them
 *   (lib/lockColor.js tenths(): {dark, middle, light}); null if it has no
 *   pixels
 */
export function regionStats(sample, region) {
    const pixels = regionPixels(sample, region);
    if (pixels.length === 0)
        return null;
    const lights = pixels.map(rgb => luminance(rgbToHex(rgb))).sort((a, b) => a - b);
    const at = share => lights[Math.min(lights.length - 1, Math.floor(share * lights.length))];
    const mean = [0, 1, 2].map(c => pixels.reduce((sum, rgb) => sum + rgb[c], 0) / pixels.length);
    return {mean: rgbToHex(mean), low: at(0.1), high: at(0.9), middle: at(0.5), tenths: tenths(pixels)};
}

/**
 * What there is behind several parts of the wallpaper together, each
 * weighing as much as it is given (the clock more than the small widgets),
 * and each of them as it is, with the type it carries.
 *
 * @param {object[]} parts - {stats: regionStats() or null, weight, text}:
 *   text the most demanding type on it, {size, weight} as in TYPE (none:
 *   the date line)
 * @returns {object|null} as regionStats() has it, with the parts known
 *   ({stats, weight, text}); null if nothing is known
 */
export function mergeStats(parts) {
    const known = parts.filter(part => part.stats && part.weight > 0);
    const total = known.reduce((sum, part) => sum + part.weight, 0);
    if (total <= 0)
        return null;
    const sum = read => known.reduce((s, part) => s + read(part.stats) * part.weight, 0) / total;
    const mix = read => rgbToHex([0, 1, 2].map(c => sum(stats => hexToRgb(read(stats))[c])));
    return {
        mean: mix(s => s.mean),
        low: sum(s => s.low),
        high: sum(s => s.high),
        middle: sum(s => s.middle),
        tenths: {dark: mix(s => s.tenths.dark), middle: mix(s => s.tenths.middle), light: mix(s => s.tenths.light)},
        parts: known.map(({stats, weight, text = TYPE.line}) => ({stats, weight, text})),
    };
}

// Merged stats as their parts, or one part's as itself; each with its type.
const partsOf = (stats, text) => (stats.parts ?? [{stats, weight: 1}]).map(part => ({...part, text: part.text ?? text}));

// The shadow round type: as the date line's always was when nothing is
// known (alpha), blurred as much (6 px for 20 px type) and up to twice
// that as far as the type falls short; and how much of its alpha is there
// at the edges of the letters – about half where their strokes are as
// wide as half its blur, less on thinner ones (a stroke taken as 4 % of
// the size and a tenth of the wght in thousandths: 10 % at 600).
const SOFT_SHADOW = 0.32;
const blurOf = (size, short) => Math.min(16, Math.max(4, size * 0.3)) * (1 + short);
const edgeOf = (size, weight, blur) => 0.5 * Math.min(1, 2 * size * (0.04 + weight / 10000) / blur);
// (Up to whole hundredths: as a style has it, never less than it takes.)
const upTo = value => Math.ceil(value * 100 - 1e-9) / 100;

// The |Lc| of type in a tone on a part, in its own polarity (light type
// lighter than what is behind it: else none): light type on the part's
// lighter tenth, dark type on its darker one, dimmed as the prompt dims
// the wallpaper; glass type this opaque over it (null: solid) – its tint
// as much as that over what is behind it, or as its material comes out
// there (ink) – and a shadow round it making what is behind it this much
// darker (lighter). (The shadow is round the letters only: what shows
// through glass type is not darker for it.)
function typeLc({color, dark}, stats, {dim = 1, glass = null, shadow = 0, ink = null} = {}) {
    const behind = dark ? blend('#000000', 1 - dim, stats.tenths.dark) : stats.tenths.light;
    const shown = glass === null ? color : ink ? ink(glass, behind) : blend(color, glass, behind);
    const around = blend(dark ? '#ffffff' : '#000000', shadow, behind);
    return Math.max(0, (dark ? 1 : -1) * contrastLc(shown, around));
}

// The least value from `from` to `to` that does (what does so from some
// value up), or `to` when none does.
function least(does, from, to) {
    if (!does(to))
        return to;
    let [low, high] = [from, to];
    for (let i = 0; i < 20; i++) {
        const middle = (low + high) / 2;
        if (does(middle))
            high = middle;
        else
            low = middle;
    }
    return high;
}

/**
 * What it takes a part of a widget to read on the wallpaper behind it, as
 * iOS keeps its lock screen legible (contrast as APCA has it, the Lc its
 * size and weight need by APCA's font lookup; lib/apca.js): nothing where
 * it reads as it is – no shadow at all; else first a heavier weight, as far
 * as that is enough, then a soft shadow of the other polarity round its
 * letters, its alpha and blur as much as it still lacks, then, for glass
 * type, more opaque glass. Light type is measured on the lighter tenth of
 * what is behind it, dark type on the darker one, dimmed as the prompt
 * dims the wallpaper.
 *
 * @param {object} part
 * @param {number} part.size - its type's size, CSS pixels (pt × 4/3)
 * @param {number} part.weight - its weight (wght)
 * @param {object|null} part.tone - its tone (lockTone(), chosenTone())
 * @param {object|null} part.stats - regionStats() of what is behind it;
 *   null: nothing known (then solid type has the soft shadow it always had)
 * @param {number|null} [part.glass] - glass type: how much of its tint
 *   shows over what is behind it, where least; null: solid type
 * @param {Function} [part.ink] - glass type: (glass, behind) => the colour
 *   it comes out over a colour behind it with that much glass, as its
 *   material has it (lib/glassBackdrop.js glassColor() of glassFor(glass):
 *   the frosted wallpaper, lighter, under the tint); none: its tint as much
 *   as `glass` over what is behind it
 * @param {number} [part.dim] - how much of the wallpaper's light is left at
 *   most while the prompt is up
 * @param {object} [part.reach] - how far it may go: REACH.full or .soft
 * @returns {object} {lc, need, weight, boldness, shadow, glass, reaches,
 *   short}: its |Lc| as it is (in its own polarity; null: nothing known)
 *   and the least its size and weight need; the weight it comes to, and how
 *   much heavier that is, 0 … 1 of REACH.full.bolder (for a font's GRAD
 *   axis where it has one, else its wght: styleWithPlan()); the shadow,
 *   {color, alpha, blur, y} (null: none); the glass's alpha (null: solid);
 *   its |Lc| with all that and how much it still lacks then, of what the
 *   weight it comes to needs (0: it reads; null: nothing known)
 */
export function legibilityPlan({size, weight, tone, stats, glass = null, ink = null, dim = 1, reach = REACH.full}) {
    const need = minimumLc(size, weight);
    const plan = {lc: null, need, weight, boldness: 0, shadow: null, glass, reaches: null, short: null};
    if (!tone)
        return plan;
    const color = tone.dark ? '#ffffff' : '#000000';
    if (!stats?.tenths) {
        if (glass === null)
            plan.shadow = {color, alpha: SOFT_SHADOW, blur: Math.round(blurOf(size, 0)), y: 1};
        return plan;
    }
    const lcWith = (shadow, alpha) => typeLc(tone, stats, {dim, glass: alpha, shadow, ink});
    plan.lc = lcWith(0, glass);
    // (a) Heavier: as little as is enough, or what needs least.
    let needs = need;
    for (let heavier = weight + 10; needs > plan.lc && heavier <= Math.min(900, weight + reach.bolder); heavier += 10) {
        const less = minimumLc(size, heavier);
        if (less < needs) {
            needs = less;
            plan.weight = heavier;
        }
    }
    plan.boldness = (plan.weight - weight) / REACH.full.bolder;
    // (b) A shadow round the letters, as much as they still lack.
    let shadow = 0;
    if (needs > plan.lc) {
        const short = Number.isFinite(needs) ? Math.min(1, (needs - plan.lc) / needs) : 1;
        const blur = blurOf(size, short);
        const edge = edgeOf(size, plan.weight, blur);
        const alpha = upTo(least(s => lcWith(s * edge, glass) >= needs, 0, reach.shadow));
        if (alpha > 0) {
            shadow = alpha * edge;
            plan.shadow = {color, alpha, blur: Math.round(blur), y: Math.max(1, Math.round(blur / 6))};
        }
    }
    // (c) Glass: more opaque, as much as it still lacks.
    if (glass !== null && reach.glass !== null && lcWith(shadow, glass) < needs)
        plan.glass = Math.min(1, upTo(least(alpha => lcWith(shadow, alpha) >= needs, glass, Math.max(glass, reach.glass))));
    plan.reaches = lcWith(shadow, plan.glass);
    plan.short = Math.max(0, needs - plan.reaches);
    return plan;
}

/**
 * How the glass clock's digits come out over the wallpaper, for
 * legibilityPlan()'s ink: their material (shell/lockscreen/liquidGlass.js)
 * as lib/glassBackdrop.js glassColor() has it – the frosted wallpaper (its
 * light let through brighter) under the tint, as opaque as the plan makes
 * the glass (glassFor()), over the wallpaper. Where the wallpaper is
 * lightest the frost is lightest too: light type, measured on the
 * wallpaper's lighter tenth, is lit by the frost's lighter tenth there (and
 * dark type by its darker one) – on a sky lighter at one side the digits
 * are lighter there too, while fine stripes, blurred, give the frost their
 * mean.
 *
 * @param {object} tone - {color, dark}: the type's tone
 * @param {object|null} frosted - regionStats() of the frosted wallpaper
 *   behind the digits (the backdrop's); null: none made yet (the tint alone,
 *   as legibilityPlan() has it without ink)
 * @returns {Function|null} (glass, behind) => '#rrggbb'; null without a
 *   backdrop
 */
export function glassInk(tone, frosted) {
    if (!frosted?.tenths)
        return null;
    const tint = glassTint(tone, frosted.mean);
    const lit = tone.dark ? frosted.tenths.dark : frosted.tenths.light;
    return (glass, behind) => glassColor({frosted: lit, tint, dark: tone.dark, ...glassFor(glass), behind});
}

// What it takes type in a tone to read on the part where it takes most.
function hardest(tone, parts, dim) {
    const strength = plan => (plan.shadow?.alpha ?? 0) + plan.boldness + (plan.short ?? 0) / 100;
    return parts.map(part => legibilityPlan({...part.text, tone, stats: part.stats, dim}))
        .reduce((most, plan) => (strength(plan) > strength(most) ? plan : most));
}

// The palette's hue, and as much of its colour as type takes.
const tintOf = tint => {
    const [, chroma, hue] = tint ? hexToOklch(tint) : [0, 0, 0];
    return {chroma: Math.min(0.04, chroma), hue};
};

// The light (or dark) tone for type on some parts: a tint of the palette's
// hue, made lighter (darker) until it reads on each as its type needs, or
// as far as it goes; its contrast where it is least.
function toneOn(parts, dark, {chroma, hue}, dim) {
    const [from, to] = dark ? [0.26, 0.08] : [0.96, 1];
    const steps = Math.round(Math.abs(to - from) / 0.01);
    let tone = null;
    for (let step = 0; step <= steps; step++) {
        const color = oklchToHex([from + (to - from) * step / steps, dark ? chroma * 1.2 : chroma, hue]);
        const lcs = parts.map(part => typeLc({color, dark}, part.stats, {dim}));
        tone = {color, dark, contrast: Math.min(...lcs)};
        if (parts.every((part, i) => lcs[i] >= minimumLc(part.text.size, part.text.weight)))
            break;
    }
    return tone;
}

/**
 * The tone for type on a part of the wallpaper: a light or a dark tint of
 * the palette's hue, whichever stands out more, made lighter (or darker)
 * until it reads there.
 *
 * @param {object|null} stats - regionStats(); null: nothing known (light)
 * @param {object} [options]
 * @param {string|null} [options.tint] - the palette's colour, whose hue
 *   tints the type (null: none)
 * @param {number} [options.dim] - how much of the wallpaper's light is left
 *   at most while the prompt is up (the glass): dark type must read then too
 * @param {object} [options.text] - the type, {size, weight} as in TYPE (the
 *   date line)
 * @returns {{color: string, dark: boolean, contrast: number|null}} the tone,
 *   whether it is dark, and its |Lc| there (null: nothing known)
 */
export function pickTone(stats, {tint = null, dim = 1, text = TYPE.line} = {}) {
    const hue = tintOf(tint);
    if (!stats)
        return {color: oklchToHex([0.97, hue.chroma, hue.hue]), dark: false, contrast: null};
    const parts = [{stats, text}];
    const [light, dark] = [false, true].map(isDark => toneOn(parts, isDark, hue, dim));
    // (Light type wins a tie: the lock screen's own is light.)
    return dark.contrast > light.contrast * 1.1 ? dark : light;
}

/**
 * The one tone of the lock screen's type: light (a tint of the palette's
 * hue) wherever it reads – as it is, or a little heavier, or with a soft
 * shadow (REACH.soft) – dark only where the wallpaper behind the widgets
 * is too light for it; where neither reads, the one that comes nearer
 * (light, unless dark comes clearly nearer). With what it takes the type to
 * read where it takes most (legibilityPlan()), for the widgets' type.
 *
 * @param {object|null} stats - mergeStats() of the parts behind the
 *   widgets, or regionStats() of one
 * @param {object} [options] - as for pickTone(); text: the type of the
 *   parts that do not say
 * @returns {{color: string, dark: boolean, contrast: number|null, plan: object}}
 *   contrast: its |Lc| where it is least, as it is
 */
export function lockTone(stats, {tint = null, dim = 1, text = TYPE.line} = {}) {
    const hue = tintOf(tint);
    if (!stats) {
        const tone = {color: oklchToHex([0.97, hue.chroma, hue.hue]), dark: false, contrast: null};
        return {...tone, plan: legibilityPlan({...text, tone, stats: null})};
    }
    const parts = partsOf(stats, text);
    const [light, dark] = [false, true].map(isDark => toneOn(parts, isDark, hue, dim));
    // How much each lacks with the soft help, the parts weighed.
    const lacking = tone => parts.reduce((sum, part) =>
        sum + part.weight * legibilityPlan({...part.text, tone, stats: part.stats, dim, reach: REACH.soft}).short, 0);
    const [lightShort, darkShort] = [light, dark].map(lacking);
    const tone = lightShort > 0 && darkShort * 1.1 < lightShort ? dark : light;
    return {...tone, plan: hardest(tone, parts, dim)};
}

/**
 * How the glass clock's digits stretch: as tall as they are at least, so
 * much taller at most; and how much of each, at its foot, may stand behind
 * the wallpaper's subject before it counts against their legibility (lib/
 * depth.js legibility()).
 *
 * Six times as tall at most: the tallest of the clock's named sizes (8 by
 * 12 cells) takes ×5.2 in Inter (×4.5 in Roboto Flex), so each fills its
 * box, and so does a size of its own up to 13 rows at 8 columns (in
 * Inter), 17 at 10, and from 12 columns on the whole height of a 1080p
 * screen's grid. Taller still, the long single strokes of a "2" or a "5"
 * take over: the figures start to read as bars (tools/render-digits.js
 * draws them as tall as they get).
 */
export const STRETCH = {min: 1, max: 6, overlap: 0.25};

/**
 * How tall the glass clock's digits stand, and where: from under the date
 * line down to the bottom of the clock's box – as it is stretched in the
 * editor, whatever stands in front of them there (the board turns the
 * depth effect off where it would hide too much of them).
 *
 * @param {number} ink - the digits' height as they are, pixels
 * @param {number} top - where they start (under the date line)
 * @param {number} bottom - where they end (the clock's box)
 * @returns {{stretch: number, y: number}} how much taller than they are,
 *   and where their top is
 */
export function glassDigits(ink, top, bottom) {
    const {min, max} = STRETCH;
    if (!(ink > 0))
        return {stretch: 1, y: top};
    return {stretch: Math.min(max, Math.max(min, (bottom - top) / ink)), y: top};
}

/**
 * @param {string} color - '#rrggbb', as chosen in the settings
 * @param {object|null} [stats] - as for lockTone() (null: nothing known)
 * @param {object} [options] - dim and text, as for lockTone()
 * @returns {{color: string, dark: boolean, contrast: number|null, plan: object}}
 *   as lockTone() has it: what it takes the colour to read where it takes most
 */
export function chosenTone(color, stats = null, {dim = 1, text = TYPE.line} = {}) {
    const tone = {color: color.toLowerCase(), dark: luminance(color) < 0.18, contrast: null};
    if (!stats)
        return {...tone, plan: legibilityPlan({...text, tone, stats: null})};
    const parts = partsOf(stats, text);
    const contrast = Math.min(...parts.map(part => typeLc(tone, part.stats, {dim})));
    return {...tone, contrast, plan: hardest(tone, parts, dim)};
}

// The parts of a widget whose type is quieter than the rest on the desktop
// (a colour of their own there; on the lock screen in the one tone, solid,
// as all of it), drawn faces in the tone, and the big digits: the glass
// clock's, and the other faces' (the digital and stacked clocks', the time
// beside hands, the date's day). The rest – the date lines, the weather and
// the battery among it – is text.
const QUIET = ['atelier-widget-caption', 'atelier-widget-time-suffix', 'atelier-widget-weekday',
    'atelier-widget-placeholder', 'atelier-lock-quiet'];
const DRAWN = ['atelier-widget-face', 'atelier-lock-ring'];
const GLASS_DIGITS = 'atelier-widget-glass-digits';
const DIGITS = ['atelier-widget-time', 'atelier-widget-stacked-hours', 'atelier-widget-stacked-minutes',
    'atelier-widget-day'];

/**
 * @param {string[]} classes - a part's style classes
 * @returns {string} how it is set (lib/lockType.js ROLES): 'glass' for the
 *   glass clock's digits, 'digits' for the other faces' big digits, 'text'
 *   for the rest
 */
export function roleOf(classes) {
    if (classes.includes(GLASS_DIGITS))
        return 'glass';
    return classes.some(name => DIGITS.includes(name)) ? 'digits' : 'text';
}

/**
 * How a part is set to read: as heavy as its plan has it – on its
 * typeface's grade axis where it has one (Roboto Flex's GRAD: heavier
 * strokes, the letters as wide), else on its weight.
 *
 * @param {object} typeface - lib/lockType.js typefaceFor()
 * @param {object} style - lib/lockType.js styleFor() of the part's role
 * @param {object|null} [plan] - legibilityPlan() of its type
 * @returns {object} the style, heavier where planned ({weight, width,
 *   extra}: as lib/lockType.js labelFont() and variationsFor() take it)
 */
export function styleWithPlan(typeface, style, plan = null) {
    if (!(plan?.boldness > 0))
        return style;
    const grade = typeface.axes?.GRAD;
    if (grade?.max > 0)
        return {...style, extra: {...style.extra, GRAD: Math.round(Math.min(1, plan.boldness) * grade.max)}};
    return {...style, weight: plan.weight};
}

// A planned shadow as St takes it: x y blur colour.
const shadowStyle = ({color, alpha, blur, y}) =>
    `0 ${y}px ${blur}px rgba(${hexToRgb(color).join(', ')}, ${Number(alpha.toFixed(2))})`;

/**
 * @param {object|null} tone - lockTone() or chosenTone(); null: the widget's
 *   own colours (on a card)
 * @param {object} typeface - lib/lockType.js typefaceFor()
 * @param {object|null} [plan] - a legibilityPlan() for all of its type;
 *   none: no shadow (each part has the one planned for it, partStyle())
 * @returns {string} the inline style of a widget: its colour, the shadow
 *   planned round its type (round the letters, never a box; none unless
 *   planned) and its typeface's family
 */
export function widgetStyle(tone, typeface, plan = null) {
    let style = '';
    if (tone)
        style += `color: ${tone.color}; text-shadow: ${plan?.shadow ? shadowStyle(plan.shadow) : 'none'};`;
    if (typeface.family)
        style += ` font-family: "${typeface.family}";`;
    return style.trim();
}

/**
 * @param {string[]} classes - a part's style classes
 * @param {object|null} tone - as for widgetStyle()
 * @param {object|null} [style] - how the part is set: {weight}
 *   (styleWithPlan()); null: as the stylesheet has it
 * @param {object|null} [plan] - legibilityPlan() of the part's type: its
 *   shadow (null: none)
 * @returns {string} its inline style ('' to leave it as it is)
 */
export function partStyle(classes, tone, style = null, plan = null) {
    const has = list => classes.some(name => list.includes(name));
    let css = '';
    if (tone && (has(QUIET) || has(DRAWN)))
        css += `color: ${tone.color};`;
    if (style?.weight)
        css += ` font-weight: ${Math.round(style.weight)};`;
    if (tone && plan?.shadow)
        css += ` text-shadow: ${shadowStyle(plan.shadow)};`;
    return css.trim();
}

/**
 * The battery, as GNOME's battery tile has it.
 *
 * @param {object|null} battery - {present, percentage, state (UPower's),
 *   title (GNOME's text: "82 %")}; null: none known
 * @returns {{shown: boolean, fraction: number, text: string, caption: string, charging: boolean}}
 */
export function batteryState(battery) {
    if (!battery?.present)
        return {shown: false, fraction: 0, text: '', caption: '', charging: false};
    const parsed = parseFloat(String(battery.title ?? '').replace(/[^\d.,]/g, '').replace(',', '.'));
    const percentage = Number.isFinite(battery.percentage) ? battery.percentage : parsed;
    const fraction = Number.isFinite(percentage) ? Math.min(1, Math.max(0, percentage / 100)) : 0;
    // UPower's states: 1 charging, 2 discharging, 4 fully charged, 5 waiting to charge.
    const charging = battery.state === 1;
    const caption = {1: 'Charging', 2: 'On battery', 4: 'Charged', 5: 'Plugged in'}[battery.state] ?? '';
    return {
        shown: true,
        fraction,
        text: battery.title || (Number.isFinite(percentage) ? `${Math.round(percentage)} %` : ''),
        caption,
        charging,
    };
}

/**
 * @param {string} summary - GWeather's temperature, e.g. "14 °C"
 * @returns {string} as the lock screen shows it: "14°"
 */
export function shortTemperature(summary) {
    return String(summary ?? '').replace(/\s*°\s*[CF]?$/, '°').trim();
}
