import GLib from 'gi://GLib';

import {minimumLc} from '../lib/apca.js';
import {NO_SHADE, faceColor, lookOf} from '../lib/glassLook.js';
import {buildPalette, hexToOklch, hexToRgb, luminance} from '../lib/palette.js';
import {
    COLOURED, INKS, MARK_LC, PROMPT_GLASS, READ_LC, REFERENCE, SHADE, SLACK, backdropOf, designedOf, glassOver,
    inkOn, lcOf, needOf, promptShade,
    pictureRegion, polarityOf, readingNeed, scopeOf, shadeFor, shadeNeeded, shadeOf, steadied, surfaceRules,
    vibrancyStylesheet, withBackground,
} from '../lib/vibrancy.js';
import {assert, assertEqual} from './util.js';

const REGULAR = lookOf('regular');
const CLEAR = lookOf('clear');
const DARK = '#141a24';
const LIGHT = '#efe6d2';
const flat = hex => ({mean: hex, tenths: {dark: hex, middle: hex, light: hex}});
const on = (wallpaper, look = REGULAR, options = {}) => backdropOf(flat(wallpaper), look, options);
// The shade each polarity needs for a kind of surface's type over a
// wallpaper, and the polarity it takes (GNOME's dark style unless said).
const neededOn = (wallpaper, inks = 'island', look = REGULAR, options = {}) => Object.fromEntries(['light', 'dark']
    .map(polarity => [polarity, shadeNeeded(flat(wallpaper), look, polarity, readingNeed(inks), options)]));
// (Dark type preferred: GNOME's light style, light glass.)
const polarityFor = (wallpaper, choice = {}, inks = 'island', options = {}) =>
    polarityOf(neededOn(wallpaper, inks, REGULAR, {light: choice.prefer === 'dark', ...options}), choice);
// In GNOME's light style: light glass.
const LIGHT_STYLE = {light: true};
const greys = (from, to, step) => Array.from({length: Math.floor((to - from) / step) + 1},
    (_, i) => `#${(from + i * step).toString(16).padStart(2, '0').repeat(3)}`);
const hueDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const palette = buildPalette({source: '#4278e6', variant: 'vibrant'});
// An ink of a kind of surface, by its selector (and what it colours).
const inkOf = (inks, selector, property = 'color') =>
    INKS[inks].find(ink => [ink.selector].flat().includes(selector) && (ink.property ?? 'color') === property);
const SURFACES = Object.keys(INKS);

export function testGlassOver() {
    assertEqual(glassOver('#3a6ea5', null), '#3a6ea5', 'no glass: what is behind it, as it is');
    // A grey, as the face makes it (lib/glassLook.js faceColor()): dark
    // glass in GNOME's dark style, light glass in its light one.
    const face = (hex, name, options) => `#${faceColor(hexToRgb(hex).map(v => v / 255), name, options)
        .map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
    assertEqual(glassOver('#808080', REGULAR), face('#808080', 'dark'), 'grey, through dark glass');
    assertEqual(glassOver('#808080', REGULAR, {light: true}), face('#808080', 'light'), 'and light glass');
    assertEqual(glassOver('#808080', REGULAR, {small: 1}), face('#808080', 'dark', {small: 1}), 'a small control');
    assertEqual(glassOver('#808080', CLEAR, {light: true}), face('#808080', 'clear'), 'clear glass, either style');
    assertEqual(glassOver('#000000', REGULAR), '#050505', 'black, as dark through dark glass');
    assertEqual(glassOver('#ffffff', REGULAR, {light: true}), '#ffffff', 'white, white through light glass');
    for (const color of ['#141a24', '#3a6ea5', '#9aa8b8', '#e9b949']) {
        const dark = glassOver(color, REGULAR);
        const light = glassOver(color, REGULAR, {light: true});
        assert(luminance(light) > luminance(color) && luminance(light) > luminance(dark),
            `${color}: light glass lighter (${light}, ${dark})`);
        const [, chroma, hue] = hexToOklch(light);
        assert(chroma < 0.02 || Math.abs(((hue - hexToOklch(color)[2] + 540) % 360) - 180) < 12,
            `${color}: its hue kept (${light})`);
    }
    assertEqual(glassOver('#3a6ea5', REGULAR, {strength: 0}), '#3a6ea5', 'none of the glass shows: the wallpaper');
    // The extra shade, after the face: dimmed, then veiled.
    const grey = hexToRgb(glassOver('#808080', REGULAR))[0];
    assertEqual(glassOver('#808080', REGULAR, {shade: {dim: 0.5, veil: 0}}),
        `#${Math.round(grey * 0.5).toString(16).padStart(2, '0').repeat(3)}`, 'dimmed by the shade');
    assertEqual(glassOver('#808080', REGULAR, {shade: {dim: 0, veil: 1}}), '#ffffff', 'or veiled');

    const covered = glassOver('#ffffff', CLEAR, {layers: [{color: '#000000', alpha: 0.5}]});
    assertEqual(covered, '#808080', 'a layer over the glass: half of it black, half white');

    const backdrop = backdropOf({mean: '#808080', tenths: {dark: '#202020', middle: '#808080', light: '#e0e0e0'}}, REGULAR);
    assert(luminance(backdrop.dark) < luminance(backdrop.mean) && luminance(backdrop.mean) < luminance(backdrop.light),
        'where it is darkest, on the whole and where lightest');
}

export function testPolarity() {
    // GNOME's dark style: dark glass, light type over anything, the glass
    // dimmed where it must be.
    for (const wallpaper of [DARK, '#000000', LIGHT, '#ffffff'])
        assertEqual(polarityFor(wallpaper, {prefer: 'light'}), 'light', `the dark style: over ${wallpaper}, light type`);
    // Its light style: light glass, dark type over a light wallpaper, light
    // over a dark one.
    assertEqual(polarityFor(DARK, {prefer: 'dark'}), 'light', 'the light style: over a dark wallpaper, light type');
    assertEqual(polarityFor('#000000', {prefer: 'dark'}), 'light', 'over black too');
    assertEqual(polarityFor(LIGHT, {prefer: 'dark'}), 'dark', 'over a light one, dark type');
    assertEqual(polarityFor('#ffffff', {prefer: 'dark'}), 'dark', 'over white too');
    // In between, the polarity GNOME's style implies keeps the benefit of
    // the doubt: the other only where it needs clearly less shade.
    const biased = {light: 0, dark: 0};
    for (const grey of greys(60, 220, 4)) {
        for (const prefer of ['light', 'dark']) {
            const needed = neededOn(grey, 'island', REGULAR, {light: prefer === 'dark'});
            const other = prefer === 'light' ? 'dark' : 'light';
            assertEqual(polarityOf(needed, {prefer}), needed[other] + SHADE.margin < needed[prefer] ? other : prefer,
                `${grey}, ${prefer} type preferred (${JSON.stringify(needed)})`);
            if (needed[other] < needed[prefer] && polarityOf(needed, {prefer}) === prefer)
                biased[prefer]++;
        }
    }
    // (Dark glass never needs less for dark type: the dark style's light
    // type is never in doubt.)
    assert(biased.dark > 0,
        `where the other needs only a little less shade, the style's stays (${JSON.stringify(biased)})`);
    // Where either would do about as well, it stays as it was: the other,
    // taken, until the style's is clearly better again; the style's as it
    // would be anyway. (In the light style: in the dark one, light type is
    // never in doubt.)
    for (const prefer of ['dark']) {
        const other = prefer === 'light' ? 'dark' : 'light';
        let kept = 0;
        for (const grey of greys(100, 220, 2)) {
            const needed = neededOn(grey, 'island', REGULAR, {light: prefer === 'dark'});
            if (polarityOf(needed, {prefer, was: other}) === other && polarityOf(needed, {prefer}) === prefer)
                kept++;
            assertEqual(polarityOf(needed, {prefer, was: prefer}), polarityOf(needed, {prefer}),
                `${grey}: as it was, the style's (${prefer})`);
            assert(polarityOf(needed, {prefer}) === prefer || polarityOf(needed, {prefer, was: other}) === other,
                `${grey}: as it was, the other (${other})`);
        }
        assert(kept > 0, `the ${other} type stays until the ${prefer} is clearly better`);
    }
    // By the shade each needs: dark where it needs none and light type
    // more than the margin; light again only where it is clearly better.
    assertEqual(polarityOf({light: 0.12, dark: 0}, {was: 'light'}), 'dark', 'light type needing a while: dark');
    assertEqual(polarityOf({light: 0.08, dark: 0}, {was: 'light'}), 'light', 'needing a little: light still');
    assertEqual(polarityOf({light: 0.08, dark: 0}, {was: 'dark'}), 'dark', 'and dark as it was');
    assertEqual(polarityOf({light: 0.04, dark: 0}, {was: 'dark'}), 'light', 'until light is clearly better');
    assertEqual(polarityOf({light: 0.04, dark: 0.16}, {prefer: 'dark', was: 'light'}), 'light',
        'the same the other way round, in the light style');
}

export function testShade() {
    const island = readingNeed('island');
    assertEqual(island, READ_LC, 'the island\'s time: as much as type reads at, no more');
    assert(readingNeed('bar') < READ_LC && readingNeed('bar') > 60, `the bar's buttons, bold: less (${readingNeed('bar')})`);
    assertEqual(readingNeed('dock'), minimumLc(32, 700), 'the dock: its Show Applications icon, the most');
    assertEqual(readingNeed('nothing'), 0, 'nothing to read');
    // None over a dark backdrop for light type, nor over a light one for
    // dark type through light glass; none at all with nothing to read or
    // without the glass.
    for (const surface of SURFACES) {
        const need = readingNeed(surface);
        for (const wallpaper of [DARK, '#000000', '#2a3140']) {
            assertEqual(shadeNeeded(flat(wallpaper), REGULAR, 'light', need), 0,
                `${surface} over ${wallpaper}: light type, no shade`);
        }
        for (const wallpaper of [LIGHT, '#ffffff']) {
            assertEqual(shadeNeeded(flat(wallpaper), REGULAR, 'dark', need, LIGHT_STYLE), 0,
                `${surface} over ${wallpaper}: dark type, no shade`);
        }
    }
    assertEqual(shadeNeeded(flat('#c0c0c0'), REGULAR, 'light', 0), 0, 'nothing to read: no shade');
    assertEqual(shadeNeeded(flat('#c0c0c0'), null, 'light', island), 0, 'no glass: no shade');
    // More over a lighter backdrop, as much as it takes – in steps, a step
    // less too little – up to the most.
    let before = 0;
    for (const grey of greys(0, 255, 5)) {
        for (const look of [REGULAR, CLEAR]) {
            const needed = shadeNeeded(flat(grey), look, 'light', island);
            assert(Math.abs(needed / SHADE.step - Math.round(needed / SHADE.step)) < 1e-9 || needed === 1,
                `${grey}: in steps (${needed})`);
            const glass = shaded => steadied(on(grey, look, {shade: {dim: shaded, veil: 0}})).light;
            assert(needed === 1 || lcOf({color: '#ffffff'}, glass(needed), 'light') >= island,
                `${grey}: white reads on the glass so shaded (${needed})`);
            assert(needed === 0 || lcOf({color: '#ffffff'}, glass(needed - SHADE.step), 'light') < island,
                `${grey}: a step less is too little (${needed})`);
            if (look === REGULAR) {
                assert(needed >= before, `${grey}: lighter, no less shade (${needed} after ${before})`);
                before = needed;
            }
        }
    }
    assert(before > SHADE.step * 4, `over white, much (${before})`);
    assertEqual(shadeOf('light', {light: 0.9, dark: 0}), {dim: SHADE.most, veil: 0}, 'no more than the most');
    assertEqual(shadeOf('dark', {light: 0, dark: 0.2}), {dim: 0, veil: 0.2}, 'dark type: a white veil');
    assertEqual(shadeFor('light', 0), NO_SHADE, 'none: no shade');
    // Dark type: a white veil, more over a darker backdrop, past the most
    // over black.
    const dark = greys(0, 255, 15).reverse().map(grey => shadeNeeded(flat(grey), REGULAR, 'dark', island, LIGHT_STYLE));
    assert(dark.every((needed, i) => i === 0 || needed >= dark[i - 1]) && dark.at(-1) > SHADE.most,
        `dark type over darker and darker backdrops: more veil (${dark})`);
    // Clear glass lets more of a light backdrop through than dark glass:
    // more; a small control's dark glass, lighter, more over white.
    assert(shadeNeeded(flat('#a0a0a0'), CLEAR, 'light', island) > shadeNeeded(flat('#a0a0a0'), REGULAR, 'light', island),
        'clear glass: more shade');
    assert(shadeNeeded(flat('#ffffff'), REGULAR, 'light', island, {small: 1}) >
        shadeNeeded(flat('#ffffff'), REGULAR, 'light', island), 'a small control of dark glass: more over white');
    // What lies over the glass counts: a card's dark colour, less.
    const card = {layers: [{color: '#0e0e12', alpha: 0.38}]};
    assert(shadeNeeded(flat('#e0e0e0'), REGULAR, 'light', island, card) <
        shadeNeeded(flat('#e0e0e0'), REGULAR, 'light', island), 'a dark card over the glass: less');
    // Where the backdrop spans both, the worst tenth for each.
    const mixed = {mean: '#808080', tenths: {dark: '#303030', middle: '#808080', light: '#d0d0d0'}};
    assert(shadeNeeded(mixed, REGULAR, 'light', island) === shadeNeeded(flat('#d0d0d0'), REGULAR, 'light', island) &&
        shadeNeeded(mixed, REGULAR, 'dark', island) === shadeNeeded(flat('#303030'), REGULAR, 'dark', island),
    'light type where it is lightest, dark where it is darkest');
}

// GNOME's own controls (the control centre) and a sheet's form, styled for
// a dark surface only, keep their light type wherever they are: their glass
// is shaded for it, as the rest – over a dark backdrop not at all.
export function testControlsKeepTheirType() {
    for (const inks of ['controls', 'forms']) {
        assertEqual(readingNeed(inks), READ_LC, `${inks}: as much as type reads at`);
        for (const wallpaper of [DARK, '#748bad', LIGHT, '#ffffff']) {
            assertEqual(surfaceRules({roots: ['.r'], scope: 's', inks, backdrop: on(wallpaper), polarity: 'light'}),
                [], `${inks} over ${wallpaper}: light type as it is set`);
        }
        const pill = {layers: [{color: '#ffffff', alpha: 0.1}]};
        assertEqual(shadeNeeded(flat('#1e1e1e'), REGULAR, 'light', readingNeed(inks), pill), 0,
            `${inks} over a dark window: the glass as it is`);
        assert(shadeNeeded(flat('#fafafa'), REGULAR, 'light', readingNeed(inks), pill) > 0,
            `${inks} over a light window: shaded`);
    }
}

// The lock screen's island and popup over its wallpaper as the prompt has
// it: no shade over a dark one, as much as the popup's type needs over a
// light one, never more than PROMPT_GLASS.most.
export function testPromptShade() {
    assertEqual(promptShade(null, REGULAR), NO_SHADE, 'nothing known behind it: none');
    assertEqual(promptShade(flat('#ffffff'), null), NO_SHADE, 'no glass: none');
    for (const wallpaper of [DARK, '#000000', '#2a3140', '#202a3c'])
        assertEqual(promptShade(flat(wallpaper), REGULAR, {brightness: 0.86}), NO_SHADE, `over ${wallpaper}: none`);
    const pill = [{color: '#ffffff', alpha: 0.1}];
    for (const [wallpaper, light] of [['#c8d4ec', false], ['#ffffff', false], ['#a0a0a0', true], [LIGHT, true]]) {
        const shade = promptShade(flat(wallpaper), REGULAR, {light, brightness: 0.86, layers: pill});
        assert(shade.dim > 0 && shade.dim <= PROMPT_GLASS.most && shade.veil === 0,
            `over ${wallpaper}${light ? ', light style' : ''}: shaded, no more than the most (${shade.dim})`);
        const glass = glassOver(wallpaper, REGULAR, {light, shade, layers: pill});
        assert(shade.dim === PROMPT_GLASS.most || lcOf({color: '#ffffff'}, glass, 'light') >= READ_LC - 8,
            `and white reads on it (${glass})`);
    }
    // Its tenths half way to its mean (the prompt's blur), and darker as
    // the wallpaper's glass is.
    const mixed = {mean: '#606060', tenths: {dark: '#202020', middle: '#606060', light: '#f0f0f0'}};
    assert(promptShade(mixed, REGULAR).dim < promptShade(flat('#f0f0f0'), REGULAR).dim,
        'blurred: less than over its lightest tenth alone');
    assert(promptShade(flat('#d0d0d0'), REGULAR, {brightness: 0.86}).dim < promptShade(flat('#d0d0d0'), REGULAR).dim,
        'darkened: less');
}

export function testSteadied() {
    const backdrop = {dark: '#3d3d3d', mean: '#7f8081', light: '#fefefe'};
    assertEqual(steadied(backdrop), {dark: '#404040', mean: '#808080', light: '#ffffff'}, 'to the nearest 8');
    // A rectangle a little wider, a little different: the same.
    assertEqual(steadied(on('#9aa8b8')), steadied(on('#9ba9b9')), 'a hair apart, the same');
}

export function testNeeds() {
    for (const surface of SURFACES) {
        for (const ink of INKS[surface].filter(i => i.kind === 'text' || i.kind === 'icon')) {
            const designed = designedOf(ink, palette);
            const need = needOf(ink, designed);
            const own = ink.kind === 'text' ? minimumLc(ink.pt * 4 / 3, ink.weight) : minimumLc(ink.px, 700);
            const set = lcOf(designed, REFERENCE, 'light');
            assert(need <= own + 1e-9 && need <= set + 1e-9 && need === Math.min(own, set),
                `${surface} ${ink.selector}: as much as its size and weight need, no more than it is set to (${need})`);
            assertEqual(needOf(ink, designed, 'dark'), set, `${ink.selector}: as dark type, as emphatic as it is set`);
        }
    }
    // Bigger type needs less; the APCA lookup has heavier type need less
    // at a reading size.
    assert(needOf(inkOf('pages', '& .atelier-glance-time')) < needOf(inkOf('island', '& .atelier-island-time')),
        'the glance\'s big clock needs less than the island\'s small one');
    const text = (pt, weight) => ({kind: 'text', pt, weight, color: '#ffffff'});
    assert(needOf(text(11, 700)) < needOf(text(11, 400)), 'bold needs less than regular');
    assert(needOf(text(9, 400)) > needOf(text(14, 400)), 'small needs more than large');
    // Quieter type is meant to be quieter.
    assert(needOf(inkOf('island', '& .atelier-island-date')) < needOf(inkOf('island', '& .atelier-island-time')),
        'the date beside the time needs less');
    const icon = {kind: 'icon', px: 16, color: '#ffffff'};
    assertEqual(needOf(icon), minimumLc(16, 700), 'an icon: as bold type of its size');
    assertEqual(needOf({kind: 'mark', color: '#ffffff'}), MARK_LC, 'a mark: as a spot element');
    const separator = inkOf('dock', '& .atelier-dock-separator', 'background-color');
    assert(needOf(separator) < MARK_LC, 'a faint separator: no more than it is set to');
}

export function testStaysOnDark() {
    for (const wallpaper of [DARK, '#000000']) {
        for (const surface of SURFACES) {
            const layers = surface === 'widget' ? [{color: '#0e0e12', alpha: 0.38}] : [];
            const needed = neededOn(wallpaper, surface, REGULAR, {layers});
            const polarity = polarityOf(needed);
            const rules = surfaceRules({roots: ['.r'], scope: 's', inks: surface,
                backdrop: on(wallpaper, REGULAR, {layers}), polarity}, palette);
            // (Dark glass is a little lighter than Atelier's dark: a colour
            // of the palette's or the microphone's orange may go lighter.)
            assertEqual([polarity, shadeOf(polarity, needed), rules.filter(rule => rule.includes('255, 255, 255'))],
                ['light', NO_SHADE, []], `${wallpaper}, ${surface}: white type as it is set, the glass as it is`);
            assert(rules.length <= 2, `${wallpaper}, ${surface}: a colour or two at most (${rules})`);
        }
    }
    // Glass a little lighter than Atelier's dark (a deep green wallpaper):
    // white type as it is, or a little more opaque; one of another colour
    // (the microphone's orange, the palette's grey) a little lighter, in
    // its hue, where it would fall short.
    const green = on('#1d2b1f');
    assertEqual(polarityFor('#1d2b1f'), 'light', 'light type');
    let lighter = 0;
    for (const surface of SURFACES) {
        for (const ink of INKS[surface]) {
            const shown = inkOn(ink, green, 'light', palette);
            const designed = designedOf(ink, palette);
            if (!shown)
                continue;
            const [l, c, h] = hexToOklch(designed.color);
            const [l2, , h2] = hexToOklch(shown.color);
            const opaquer = designed.color === '#ffffff' && shown.color === '#ffffff' && shown.alpha > designed.alpha;
            assert(opaquer || (designed.color !== '#ffffff' && l2 > l && (c < 0.01 || hueDistance(h, h2) < 6)),
                `${surface} ${ink.selector}: white more opaque, or lighter in its hue (${shown.color})`);
            lighter++;
        }
    }
    assert(lighter <= 5, `a few colours only (${lighter})`);
}

export function testDarkOnLight() {
    for (const surface of ['island', 'pages', 'bar', 'dock']) {
        const backdrop = on(LIGHT, REGULAR, LIGHT_STYLE);
        assertEqual(polarityFor(LIGHT, {prefer: 'dark'}, surface), 'dark', `${surface}: dark type`);
        for (const ink of INKS[surface].filter(i => ['text', 'icon', 'mark'].includes(i.kind))) {
            const shown = inkOn(ink, backdrop, 'dark', palette);
            const designed = designedOf(ink, palette);
            const need = needOf(ink, designed, 'dark');
            const lc = shown ? lcOf(shown, backdrop.dark, 'dark') : lcOf(designed, backdrop.dark, 'dark');
            const asFarAsItGoes = shown && shown.alpha === 1 &&
                (luminance(shown.color) < 0.001 || hexToOklch(shown.color)[0] <= COLOURED.deepest + 0.01);
            assert(lc >= need - 1 || asFarAsItGoes,
                `${surface} ${ink.selector}: reads as set (Lc ${lc.toFixed(1)} of ${need.toFixed(1)})`);
        }
    }
    const backdrop = on(LIGHT, REGULAR, LIGHT_STYLE);
    const time = inkOn(inkOf('island', '& .atelier-island-time'), backdrop, 'dark');
    const date = inkOn(inkOf('island', '& .atelier-island-date'), backdrop, 'dark');
    assertEqual(time, {color: '#000000', alpha: 1}, 'the time black');
    assert(date.alpha === 0.62 && luminance(date.color) > 0.01 && lcOf(date, backdrop.dark, 'dark') <
        lcOf(time, backdrop.dark, 'dark'), `the date beside it quieter, grey (${date.color})`);
    // The highlights go dark, those on colours of their own stay.
    const hover = inkOf('bar', '& .panel-button:hover', 'box-shadow');
    assertEqual(inkOn(hover, backdrop, 'dark'), {color: '#000000', alpha: 0.17}, 'a highlight, dark');
    assertEqual(inkOn(hover, backdrop, 'light'), null, 'as it is under light type');
    const recording = inkOf('bar', '& .panel-button.screen-recording-indicator');
    assertEqual(inkOn(recording, backdrop, 'dark'), {color: '#fafafb', alpha: 1}, 'the recording indicator as GNOME has it');
    assertEqual(inkOn(recording, on(DARK), 'light'), null, 'nothing to keep it from under light type');
}

export function testOnlyAsFarAsNeeded() {
    // A middling backdrop: light type, the quieter type a little more
    // opaque – just enough.
    const backdrop = on('#8a92a2');
    assertEqual([polarityFor('#8a92a2'), neededOn('#8a92a2').light], ['light', 0], 'still light type, unshaded');
    const date = inkOf('island', '& .atelier-island-date');
    const shown = inkOn(date, backdrop, 'light');
    const need = needOf(date);
    assert(shown && shown.color === '#ffffff' && shown.alpha > 0.62 && shown.alpha < 1,
        `the date a little more opaque (${shown?.alpha})`);
    assert(Math.abs(lcOf(shown, backdrop.light, 'light') - need) < 1.5,
        `as much as it needs (Lc ${lcOf(shown, backdrop.light, 'light').toFixed(1)} of ${need.toFixed(1)})`);
    assertEqual(inkOn(inkOf('island', '& .atelier-island-time'), backdrop, 'light'), null,
        'white as light as it gets: as it is');
    // A little short reads as set (APCA's steps).
    const near = {kind: 'text', pt: 11, weight: 700, color: '#ffffff', alpha: 0.62};
    for (const level of [0x20, 0x2c, 0x38]) {
        const grey = `#${level.toString(16).repeat(3)}`;
        const glass = on(grey);
        const lc = lcOf(designedOf(near), glass.light, 'light');
        assertEqual(inkOn(near, glass, 'light') === null, lc >= needOf(near) - SLACK,
            `${grey}: as set where it falls short by ${SLACK} at most (Lc ${lc.toFixed(1)})`);
    }
    // Dark type only as dark as it is set to stand out.
    const light = on(LIGHT, REGULAR, LIGHT_STYLE);
    const suffix = inkOn(inkOf('pages', '& .atelier-glance-suffix'), light, 'dark');
    const suffixNeed = needOf(inkOf('pages', '& .atelier-glance-suffix'), designedOf(inkOf('pages', '& .atelier-glance-suffix')), 'dark');
    assert(Math.abs(lcOf(suffix, light.dark, 'dark') - suffixNeed) < 1.5 && luminance(suffix.color) > 0.01,
        `the glance's suffix grey, as emphatic as it is set (${suffix.color})`);
}

export function testHueKept() {
    const primary = palette.dark.primary;
    const [lightness, , hue] = hexToOklch(primary);
    // Dark type: the palette's colour deeper, its hue kept.
    const light = on(LIGHT);
    for (const [surface, selector, property] of [['island', '& .atelier-island-unread', 'background-color'],
        ['pages', '& .atelier-glance-day:today .atelier-glance-day-name', 'color'],
        ['widget', '& .atelier-widget-weekday', 'color'], ['bar', '& .atelier-bar-ring', '-atelier-ring-color']]) {
        const shown = inkOn(inkOf(surface, selector, property), light, 'dark', palette);
        const [l, c, h] = hexToOklch(shown.color);
        assert(l < lightness && c > COLOURED.chroma && hueDistance(h, hue) < 4,
            `${surface} ${selector}: the palette's ${primary}, deeper (${shown.color}, hue ${h.toFixed(0)}° of ${hue.toFixed(0)}°)`);
    }
    // Light type on a lighter glass: paler, and still the palette's colour.
    const card = {layers: [{color: '#0e0e12', alpha: 0.38}]};
    const grey = on('#7a7a7a', REGULAR, card);
    assertEqual(polarityFor('#7a7a7a', {}, 'widget', card), 'light', 'light type on the card');
    const weekday = inkOn(inkOf('widget', '& .atelier-widget-weekday'), grey, 'light', palette);
    const [l, c, h] = hexToOklch(weekday.color);
    assert(l > lightness && l <= COLOURED.palest + 0.01 && c > 0.02 && hueDistance(h, hue) < 6,
        `paler, never white (${weekday.color})`);
    // A signal's colour too: the microphone's orange.
    const mic = inkOn(inkOf('island', '& .atelier-island-mic'), light, 'dark');
    assert(hueDistance(hexToOklch(mic.color)[2], hexToOklch('#ffa348')[2]) < 6 && hexToOklch(mic.color)[1] > 0.05,
        `the microphone stays orange, darker (${mic.color})`);
}

export function testPictureRegion() {
    // Zoomed: the picture past the monitor's sides.
    const zoomed = {x: -240, y: 0, width: 2400, height: 1080};
    const {region, cover} = pictureRegion([0, 0, 1920, 40], zoomed);
    assert(Math.abs(region[0] - 0.1) < 1e-9 && Math.abs(region[2] - 0.8) < 1e-9 && cover === 1,
        `the middle of the picture (${region})`);
    // Centered, smaller than the monitor: half of the rect on it.
    const centered = {x: 460, y: 240, width: 1000, height: 600};
    const half = pictureRegion([360, 300, 200, 100], centered);
    assert(Math.abs(half.cover - 0.5) < 1e-9 && half.region[0] === 0, `half of it on the picture (${half.cover})`);
    assertEqual(pictureRegion([0, 0, 100, 100], centered), null, 'off the picture');
    const stats = flat('#ffffff');
    assertEqual(withBackground(null, 0, '#000000').mean, '#000000', 'all of it the background\'s colour');
    assertEqual(withBackground(stats, 0.5, '#000000').mean, '#808080', 'half of it');
    assertEqual(withBackground(stats, 1, '#000000'), stats, 'none of it');
}

export function testRules() {
    assertEqual(scopeOf('widget-Clock 2'), 'atelier-vibrant-widget-clock-2', 'a class of its own');
    const backdrop = on(LIGHT);
    const rules = surfaceRules({roots: ['#panel #panelLeft', '#panel #panelRight'], scope: 'atelier-vibrant-bar',
        inks: 'bar', backdrop, polarity: 'dark'}, palette);
    const button = rules.find(rule => rule.includes('.panel-button {'));
    assert(button?.startsWith('#panel #panelLeft.atelier-vibrant-bar .panel-button,\n#panel #panelRight.atelier-vibrant-bar .panel-button {'),
        `on each of its roots (${button})`);
    assert(rules.some(rule => rule.includes('box-shadow: inset 0 0 0 100px rgba(0, 0, 0, 0.17);')),
        'a highlight as GNOME draws it');
    assertEqual(vibrancyStylesheet([]), '', 'nothing: no stylesheet');
    assert(vibrancyStylesheet(rules).startsWith('/* Generated by Atelier'), 'said where it comes from');
}

// stylesheet.css as rules: their selectors and declarations.
function stylesheetRules() {
    const [, bytes] = GLib.file_get_contents('stylesheet.css');
    const css = new TextDecoder().decode(bytes).replace(/\/\*[\s\S]*?\*\//g, '');
    return css.split('}').map(block => block.split('{')).filter(parts => parts.length === 2).map(([head, body]) => ({
        selectors: head.split(',').map(s => s.trim().replace(/\s+/g, ' ')),
        declarations: Object.fromEntries(body.split(';').map(d => d.split(/:(.*)/s).map(s => s?.trim()))
            .filter(([name, value]) => name && value)),
    }));
}

// A colour as the stylesheet writes it: {color, alpha}.
function parsed(value) {
    const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value);
    if (rgba) {
        const hex = rgba.slice(1, 4).map(v => Number(v).toString(16).padStart(2, '0')).join('');
        return {color: `#${hex}`, alpha: rgba[4] === undefined ? 1 : Number(rgba[4])};
    }
    const named = {white: '#ffffff'}[value] ?? value;
    const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(named);
    return {color: (short ? `#${short.slice(1).map(c => c + c).join('')}` : named).toLowerCase(), alpha: 1};
}

export function testInksAsTheStylesheetSetsThem() {
    const rules = stylesheetRules();
    const valueOf = (selector, property) =>
        rules.filter(rule => rule.selectors.includes(selector) && property in rule.declarations).at(-1)?.declarations[property];
    let checked = 0;
    for (const surface of SURFACES) {
        for (const ink of INKS[surface].filter(i => i.source)) {
            const property = ink.property ?? 'color';
            const value = valueOf(ink.source, property);
            assert(value !== undefined, `${surface}: ${ink.source} sets its ${property}`);
            if (ink.role)
                assertEqual(value, '-st-accent-color', `${ink.source}: the palette's colour, GNOME's accent until it loads`);
            else
                assertEqual(parsed(value), designedOf(ink), `${surface}: ${ink.source}'s ${property}`);
            const size = valueOf(ink.source, 'font-size');
            if (ink.kind === 'text' && size)
                assertEqual(size, `${ink.pt}pt`, `${ink.source}: its size`);
            checked++;
        }
    }
    assert(checked > 40, `checked ${checked}`);
}
