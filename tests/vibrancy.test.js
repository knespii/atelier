import GLib from 'gi://GLib';

import {minimumLc} from '../lib/apca.js';
import {lookOf} from '../lib/glassLook.js';
import {buildPalette, hexToOklch, luminance} from '../lib/palette.js';
import {
    COLOURED, INKS, LIGHT_BIAS, MARK_LC, REFERENCE, SLACK, backdropOf, designedOf, glassOver, inkOn, lcOf, needOf,
    pictureRegion, polarityOn, scopeOf, surfaceRules, vibrancyStylesheet, withBackground,
} from '../lib/vibrancy.js';
import {assert, assertEqual} from './util.js';

const REGULAR = lookOf('regular');
const DARK = '#141a24';
const LIGHT = '#efe6d2';
const flat = hex => ({mean: hex, tenths: {dark: hex, middle: hex, light: hex}});
const on = (wallpaper, look = REGULAR, options = {}) => backdropOf(flat(wallpaper), look, options);
const hueDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const palette = buildPalette({source: '#4278e6', variant: 'vibrant'});
// An ink of a kind of surface, by its selector (and what it colours).
const inkOf = (inks, selector, property = 'color') =>
    INKS[inks].find(ink => [ink.selector].flat().includes(selector) && (ink.property ?? 'color') === property);
const SURFACES = Object.keys(INKS);

export function testGlassOver() {
    assertEqual(glassOver('#3a6ea5', null), '#3a6ea5', 'no glass: what is behind it, as it is');
    // A grey: as light as the material makes it, then veiled (128 × 1.15,
    // 8 % of the way to white).
    assertEqual(glassOver('#808080', REGULAR), '#9c9c9c', 'grey, lighter');
    assertEqual(glassOver('#ffffff', REGULAR), '#ffffff', 'white stays white');
    assert(luminance(glassOver('#000000', REGULAR)) > 0, 'black, a little veiled');
    for (const color of ['#141a24', '#3a6ea5', '#9aa8b8', '#e9b949']) {
        const glass = glassOver(color, REGULAR);
        assert(luminance(glass) > luminance(color), `${color}: lighter through the glass (${glass})`);
        assert(hexToOklch(glass)[1] >= hexToOklch(color)[1] - 0.005, `${color}: as colourful at least (${glass})`);
        assert(luminance(glassOver(color, lookOf('clear'))) < luminance(glass),
            `${color}: clear glass, dimmed, darker than regular`);
    }
    assertEqual(glassOver('#3a6ea5', REGULAR, {strength: 0}), '#3a6ea5', 'none of the glass shows: the wallpaper');
    const tinted = glassOver('#ffffff', REGULAR, {layers: [{color: '#000000', alpha: 0.5}]});
    assertEqual(tinted, '#808080', 'a layer over the glass: half of it black, half white');
    const backdrop = backdropOf({mean: '#808080', tenths: {dark: '#202020', middle: '#808080', light: '#e0e0e0'}}, REGULAR);
    assert(luminance(backdrop.dark) < luminance(backdrop.mean) && luminance(backdrop.mean) < luminance(backdrop.light),
        'where it is darkest, on the whole and where lightest');
}

export function testPolarity() {
    assertEqual(polarityOn(on(DARK)), 'light', 'over a dark wallpaper, light type');
    assertEqual(polarityOn(on('#000000')), 'light', 'over black too');
    assertEqual(polarityOn(on(LIGHT)), 'dark', 'over a light one, dark type');
    assertEqual(polarityOn(on('#ffffff')), 'dark', 'over white too');
    // In between, light type keeps the benefit of the doubt.
    let biased = 0;
    for (let level = 60; level <= 220; level += 4) {
        const grey = `#${level.toString(16).padStart(2, '0').repeat(3)}`;
        const backdrop = on(grey);
        const light = lcOf({color: '#ffffff'}, backdrop.light, 'light');
        const dark = lcOf({color: '#000000'}, backdrop.dark, 'dark');
        assertEqual(polarityOn(backdrop), dark > light * LIGHT_BIAS ? 'dark' : 'light', grey);
        if (dark > light && polarityOn(backdrop) === 'light')
            biased++;
    }
    assert(biased > 0, 'where dark type is only a little better, light type stays');
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
            const {polarity, rules} = surfaceRules({roots: ['.r'], scope: 's', inks: surface,
                backdrop: on(wallpaper, REGULAR, {layers})}, palette);
            assertEqual([polarity, rules], ['light', []], `${wallpaper}, ${surface}: as it is set`);
        }
    }
    // Glass a little lighter than Atelier's dark (a deep green wallpaper):
    // white type as it is; one of another colour (the microphone's
    // orange, the palette's grey) a little lighter, in its hue, where it
    // would fall short.
    const green = on('#1d2b1f');
    assertEqual(polarityOn(green), 'light', 'light type');
    let lighter = 0;
    for (const surface of SURFACES) {
        for (const ink of INKS[surface]) {
            const shown = inkOn(ink, green, 'light', palette);
            const designed = designedOf(ink, palette);
            if (!shown)
                continue;
            const [l, c, h] = hexToOklch(designed.color);
            const [l2, , h2] = hexToOklch(shown.color);
            assert(designed.color !== '#ffffff' && l2 > l && (c < 0.01 || hueDistance(h, h2) < 6),
                `${surface} ${ink.selector}: not white, lighter in its hue (${shown.color})`);
            lighter++;
        }
    }
    assert(lighter <= 4, `a few colours only (${lighter})`);
}

export function testDarkOnLight() {
    for (const surface of ['island', 'pages', 'bar', 'dock']) {
        const backdrop = on(LIGHT);
        assertEqual(polarityOn(backdrop), 'dark', `${surface}: dark type`);
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
    const backdrop = on(LIGHT);
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
    const backdrop = on('#4a5262');
    assertEqual(polarityOn(backdrop), 'light', 'still light type');
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
    const light = on(LIGHT);
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
    const grey = on('#7a7a7a', REGULAR, {layers: [{color: '#0e0e12', alpha: 0.38}]});
    assertEqual(polarityOn(grey), 'light', 'light type on the card');
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
    const {polarity, rules} = surfaceRules({roots: ['#panel #panelLeft', '#panel #panelRight'], scope: 'atelier-vibrant-bar',
        inks: 'bar', backdrop}, palette);
    assertEqual(polarity, 'dark');
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
