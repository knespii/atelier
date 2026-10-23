import Cairo from 'cairo';
import HarfBuzz from 'gi://HarfBuzz';

import {FONT_DIR, axesOf, bundledFile, fontAt, systemFontFile, traceOutline} from '../lib/glyphOutlines.js';
import {inkOf} from '../lib/glyphStretch.js';
import {TYPEFACES, typefaceFor} from '../lib/lockType.js';
import {assert, assertEqual} from './util.js';

const DIGITS = '0123456789';

// The bundled fonts, and Cantarell (the shell's) where it is found.
function fonts() {
    const list = [
        {name: 'Inter', path: bundledFile('Inter.ttf'), variations: 'wght=600,opsz=32'},
        {name: 'Roboto Flex', path: bundledFile('RobotoFlex.ttf'), variations: 'wght=600,wdth=90,opsz=144'},
    ];
    const cantarell = systemFontFile('Cantarell');
    if (cantarell)
        list.push({name: 'Cantarell', path: cantarell, variations: 'wght=600'});
    return list;
}

export function testBundledFonts() {
    assert(FONT_DIR.endsWith('/fonts'), FONT_DIR);
    for (const typeface of TYPEFACES.filter(t => t.file)) {
        const axes = axesOf(bundledFile(typeface.file));
        assert(axes, `${typeface.file} is there and read`);
        assertEqual(Object.keys(axes).sort(), Object.keys(typeface.axes).sort(), `${typeface.file}: its axes`);
        for (const [tag, range] of Object.entries(typeface.axes))
            assertEqual(axes[tag], range, `${typeface.file}: ${tag} as lib/lockType.js knows it`);
    }
    assertEqual(axesOf('/nonexistent/font.ttf'), null, 'no file: no axes');
    const cantarell = systemFontFile('Cantarell');
    if (cantarell)
        assertEqual(Object.keys(axesOf(cantarell)), ['wght'], 'Cantarell: weight only');
}

export function testTabularFigures() {
    for (const {name, path, variations} of fonts()) {
        const font = fontAt(path, variations);
        const {glyphs, advance} = font.shape(DIGITS, ['tnum']);
        assertEqual(glyphs.length, 10, `${name}: a glyph each`);
        assert(glyphs.every(g => g.advance === glyphs[0].advance && g.advance > 0),
            `${name}: all as wide (${glyphs.map(g => g.advance)})`);
        assertEqual(advance, 10 * glyphs[0].advance);
        assertEqual(glyphs.map(g => g.cluster), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert(glyphs.every((g, i) => g.x === i * glyphs[0].advance), `${name}: one after another`);
    }
    // (Without tnum, Inter's are as wide as each is.)
    const inter = fontAt(bundledFile('Inter.ttf'));
    const proportional = inter.shape(DIGITS, []).glyphs.map(g => g.advance);
    assert(new Set(proportional).size > 1, `Inter's own figures differ (${proportional})`);
}

export function testZero() {
    for (const {name, path, variations} of fonts()) {
        const font = fontAt(path, variations);
        const glyph = font.glyphOf('0');
        assert(glyph !== null, `${name} has a 0`);
        const {commands, advance, ink} = font.outline(glyph);
        assert(commands.length > 4 && commands[0][0] === 'M', `${name}: an outline`);
        assertEqual(commands.filter(([op]) => op === 'M').length, 2, `${name}: its outside and its counter`);
        const {top, bottom} = font.figures;
        assert(ink.x1 > 0 && ink.x2 < advance && ink.x2 - ink.x1 > advance / 3, `${name}: within its advance (${JSON.stringify(ink)})`);
        assert(ink.y1 <= bottom && ink.y1 > bottom - font.upem / 40 && ink.y2 >= top && ink.y2 < top + font.upem / 40,
            `${name}: from the baseline to the figures' top, overshooting a little (${JSON.stringify(ink)}, ${top})`);
        // As HarfBuzz measures it (its box: of the points, off the curve too).
        const [, extents] = HarfBuzz.font_get_glyph_extents(font._font, glyph);
        assert(Math.abs(extents.x_bearing - ink.x1) < 2 && Math.abs(extents.y_bearing - ink.y2) < 2 &&
            Math.abs(extents.y_bearing + extents.height - ink.y1) < 2,
        `${name}: as HarfBuzz has it (${extents.x_bearing}, ${extents.y_bearing}, ${extents.height})`);
        assert(font.figures.stroke > 0 && font.figures.stroke < (top - bottom) / 4,
            `${name}: its strokes' thickness found (${font.figures.stroke})`);
    }
}

export function testInstances() {
    const path = bundledFile('Inter.ttf');
    const light = fontAt(path, 'wght=200,opsz=32');
    const heavy = fontAt(path, 'wght=900,opsz=32');
    assert(fontAt(path, 'wght=200,opsz=32') === light, 'kept once made');
    const width = font => {
        const {ink} = font.outline(font.glyphOf('0'));
        return ink.x2 - ink.x1;
    };
    assert(width(heavy) > width(light), `heavier, wider (${width(light)}, ${width(heavy)})`);
    assert(heavy.figures.stroke > light.figures.stroke * 2, 'heavier, thicker strokes');
    // Optical size: the display cut is set tighter.
    const text = fontAt(path, 'wght=400,opsz=14').shape('0000', []).advance;
    const display = fontAt(path, 'wght=400,opsz=32').shape('0000', []).advance;
    assert(display < text, `opsz 32 tighter than 14 (${display}, ${text})`);
    let threw = false;
    try {
        fontAt('/nonexistent/font.ttf');
    } catch {
        threw = true;
    }
    assert(threw, 'no file: an error');
}

export function testStretchedFigures() {
    for (const {name, path, variations} of fonts()) {
        const font = fontAt(path, variations);
        const {top, bottom} = font.figures;
        const height = top - bottom;
        // Every figure grows by as much: its top (a round one's overshoot,
        // a shorter one's top) up by all of the extra height, its foot
        // where it was.
        for (const stretch of [1.6, 2.8]) {
            for (const char of DIGITS) {
                const glyph = font.glyphOf(char);
                const original = font.outline(glyph).ink;
                const ink = inkOf(font.stretched(glyph, stretch));
                assert(Math.abs(ink.y2 - original.y2 - height * (stretch - 1)) < 0.5 && Math.abs(ink.y1 - original.y1) < 0.5,
                    `${name} ${char} × ${stretch}: its foot as it was, its top up by as much (${original.y1} → ${ink.y1}, ${original.y2} → ${ink.y2})`);
            }
        }
        // The colon: round dots, centred on the figures.
        const [colon] = font.shape(':', ['tnum', 'case']).glyphs;
        const dots = font.stretched(colon.glyph, 2);
        const ink = inkOf(dots);
        assert(Math.abs((ink.y1 + ink.y2) / 2 - (bottom + height)) < height / 20,
            `${name}: its colon centred on the figures (${ink.y1}, ${ink.y2})`);
        assert(font.stretched(font.glyphOf('1'), 1) === font.outline(font.glyphOf('1')).commands, 'a stretch of 1: as it is');
    }
}

export function testSystemFonts() {
    assertEqual(systemFontFile('No Such Family'), null);
    assertEqual(systemFontFile(null), null);
    const cantarell = systemFontFile('cantarell');
    assert(cantarell === null || cantarell.endsWith('.otf'), 'whatever the case');
    // A family of a file per weight: the nearest one (heavier from 500).
    const regular = systemFontFile('Quicksand', 400);
    if (regular) {
        assert(regular.endsWith('Quicksand-Regular.ttf'), regular);
        assert(systemFontFile('Quicksand', 600).endsWith('Quicksand-Bold.ttf'), 'between Medium and Bold: Bold');
        assert(systemFontFile('Quicksand', 350).endsWith('Quicksand-Light.ttf'), 'between Light and Regular: Light');
    }
}

export function testTrace() {
    const font = fontAt(bundledFile('Inter.ttf'), typefaceFor('inter').axes ? 'wght=600' : '');
    const glyph = font.glyphOf('1');
    const surface = new Cairo.ImageSurface(Cairo.Format.A8, 200, 400);
    const cr = new Cairo.Context(surface);
    const scale = 100 / font.upem;
    traceOutline(cr, font.stretched(glyph, 2), {x: 20, y: 350, scale, scaleX: 0.5});
    const [x1, y1, x2, y2] = cr.fillExtents();
    cr.$dispose();
    const {ink} = font.outline(glyph);
    const tall = (font.figures.top - font.figures.bottom) * 2 * scale;
    assert(Math.abs(y2 - 350) < 0.5 && Math.abs(y2 - y1 - tall) < 0.5, `y down, from the baseline (${y1}, ${y2})`);
    assert(Math.abs(x1 - (20 + ink.x1 * scale * 0.5)) < 0.5 && Math.abs(x2 - (20 + ink.x2 * scale * 0.5)) < 0.5,
        `narrower by scaleX (${x1}, ${x2})`);
}
