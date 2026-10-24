// The glass clock's digits as lib/glyphStretch.js stretches them, in
// Inter (as the glass face sets it, and heavy), Roboto Flex and the
// system's Cantarell, from as they are to the tallest stretch: contact
// sheets in tests/output/digits, and with --check, how clean each figure
// stays at each stretch (tests/glyphChecks.js).
//
// Usage: gjs -m tools/render-digits.js [--check] [--detail [stretch]]
//        (--detail: also each figure large, its outline's points marked,
//        at the tallest stretch or the one given)

import Cairo from 'cairo';
import GLib from 'gi://GLib';

import {bundledFile, fontAt, systemFontFile, traceOutline} from '../lib/glyphOutlines.js';
import {inkOf} from '../lib/glyphStretch.js';
import {STRETCH} from '../lib/lockLook.js';
import {TYPEFACES, styleFor, typefaceFor, variationsFor} from '../lib/lockType.js';
import {crookedness, crossings, shapeOf, strokeChange} from '../tests/glyphChecks.js';

const OUT = GLib.build_filenamev([GLib.get_current_dir(), 'tests', 'output', 'digits']);
const STRETCHES = [1, 1.5, 2, 2.5, 3, 4, 5, STRETCH.max];
const TEXTS = {digits: '0123456789:', time: '6:47'};
const FIGURE = {digits: 70, time: 150}; // how tall the figures are at a stretch of 1, pixels
const GAP = 24;
const CHECK = ARGV.includes('--check');
const DETAIL = ARGV.includes('--detail');
const DETAIL_STRETCH = Number(ARGV[ARGV.indexOf('--detail') + 1]) || STRETCH.max;

// The fonts as the glass face sets them (its weight and width, the
// optical size of a large clock), Inter heavy, and where the system has
// them Cantarell (the shell's default) and the rounded and serif
// typefaces' first family.
const glass = styleFor(typefaceFor('inter'), 'glass');
const installed = id => TYPEFACES.find(t => t.id === id).families
    .map(family => ({name: family, path: systemFontFile(family, glass.weight), axes: null, weight: glass.weight}))
    .find(font => font.path) ?? {path: null};
const FONTS = [
    ...TYPEFACES.filter(t => t.file).map(t => ({name: t.name, path: bundledFile(t.file), axes: t.axes, weight: glass.weight})),
    {name: 'Inter', path: bundledFile('Inter.ttf'), axes: TYPEFACES[0].axes, weight: 800},
    {name: 'Cantarell', path: systemFontFile('Cantarell'), axes: null, weight: glass.weight},
    installed('rounded'),
    installed('serif'),
].filter(font => font.path);

function instanceOf(font) {
    const {variations, scaleX} = variationsFor(font.axes, {weight: font.weight, width: glass.width, size: 400});
    return {glyphFont: fontAt(font.path, variations), variations, scaleX};
}

// A line of text, each glyph stretched, its baseline at y.
function drawLine(cr, glyphFont, text, size, scaleX, stretch, x, baseline) {
    const scale = size / glyphFont.upem;
    for (const g of glyphFont.shape(text, ['tnum', 'case']).glyphs) {
        traceOutline(cr, glyphFont.stretched(g.glyph, stretch),
            {x: x + (g.x + g.dx) * scale * scaleX, y: baseline - g.dy * scale, scale, scaleX});
    }
    cr.fill();
}

function label(cr, text, x, y) {
    cr.setSourceRGB(0.45, 0.45, 0.45);
    cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
    cr.setFontSize(14);
    cr.moveTo(x, y);
    cr.showText(text);
}

// The figures' top and baseline, faint.
function guides(cr, x, width, baseline, height) {
    cr.setSourceRGB(0.85, 0.9, 1);
    cr.rectangle(x, baseline - height, width, 1);
    cr.rectangle(x, baseline, width, 1);
    cr.fill();
}

// The figures in rows, a stretch each (key 'digits'), or the time side by
// side, a stretch each (key 'time').
function sheet(font, key) {
    const {glyphFont, variations, scaleX} = instanceOf(font);
    const {top, bottom} = glyphFont.figures;
    const figure = FIGURE[key];
    const size = figure * glyphFont.upem / (top - bottom);
    const text = TEXTS[key];
    const lineWidth = Math.ceil(glyphFont.shape(text, ['tnum', 'case']).advance * size / glyphFont.upem * scaleX);
    const rows = key === 'digits';
    const cell = lineWidth + 2 * GAP;
    const tallest = figure * Math.max(...STRETCHES);
    const width = rows ? cell : cell * STRETCHES.length;
    const height = 40 + (rows ? STRETCHES.reduce((sum, s) => sum + figure * s + 2 * GAP, 0) : tallest + 2 * GAP + 20);
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, Math.ceil(width), Math.ceil(height));
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(1, 1, 1);
    cr.paint();
    label(cr, `${font.name} ${variations} × ${scaleX}`, GAP, 24);
    let y = 40;
    STRETCHES.forEach((stretch, i) => {
        const x = rows ? 0 : i * cell;
        const baseline = rows ? y + GAP + figure * stretch : height - GAP;
        guides(cr, x, cell, baseline, figure * stretch);
        label(cr, `× ${stretch}`, x + GAP, baseline - figure * stretch - 6);
        cr.setSourceRGB(0.08, 0.08, 0.1);
        drawLine(cr, glyphFont, text, size, scaleX, stretch, x + GAP, baseline);
        y += figure * stretch + 2 * GAP;
    });
    cr.$dispose();
    const name = `${font.name.replace(/\s/g, '')}-${font.weight}-${key}.png`;
    surface.writeToPNG(GLib.build_filenamev([OUT, name]));
    return name;
}

// One figure large, stretched, its outline's points marked: on the curve
// dark, off it light.
function detail(font, char) {
    const {glyphFont, scaleX} = instanceOf(font);
    const [shaped] = glyphFont.shape(char, ['tnum', 'case']).glyphs;
    const {top, bottom} = glyphFont.figures;
    const figure = 200;
    const scale = figure / (top - bottom);
    const {ink, advance} = glyphFont.outline(shaped.glyph);
    const width = Math.ceil(advance * scale * scaleX) + 2 * GAP;
    const height = Math.ceil(figure * DETAIL_STRETCH + 2 * GAP + 40);
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, 2 * width, height);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(1, 1, 1);
    cr.paint();
    const baseline = height - GAP - Math.max(0, -ink.y1 * scale);
    for (const [k, commands] of [[0, glyphFont.outline(shaped.glyph).commands], [1, glyphFont.stretched(shaped.glyph, DETAIL_STRETCH)]]) {
        const x = k * width + GAP;
        cr.setSourceRGB(0.75, 0.8, 0.9);
        traceOutline(cr, commands, {x, y: baseline, scale, scaleX});
        cr.fill();
        cr.setSourceRGB(0.1, 0.1, 0.2);
        cr.setLineWidth(1);
        traceOutline(cr, commands, {x, y: baseline, scale, scaleX});
        cr.stroke();
        for (const [op, ...v] of commands) {
            for (let i = 0; i + 1 < v.length; i += 2) {
                const onCurve = op !== 'C' || i === 4;
                cr.setSourceRGB(...onCurve ? [0.8, 0.1, 0.1] : [0.2, 0.6, 1]);
                cr.arc(x + v[i] * scale * scaleX, baseline - v[i + 1] * scale, onCurve ? 2.2 : 1.6, 0, 2 * Math.PI);
                cr.fill();
            }
        }
    }
    cr.$dispose();
    const name = `detail-${font.name.replace(/\s/g, '')}-${font.weight}-${char === ':' ? 'colon' : char}.png`;
    surface.writeToPNG(GLib.build_filenamev([OUT, name]));
    return name;
}

// How clean each figure stays at each stretch: what tests/glyphStretch.test.js
// holds it to, printed.
function check(font) {
    const {glyphFont} = instanceOf(font);
    const {top, bottom, stroke} = glyphFont.figures;
    const worst = {inflections: 0, corners: 0, crossings: 0, crooked: 0, height: 0, stroke: 0, profile: 0, ms: 0};
    const times = [];
    const ms = since => (GLib.get_monotonic_time() - since) / 1000;
    for (const char of TEXTS.digits) {
        const [shaped] = glyphFont.shape(char, ['tnum', 'case']).glyphs;
        const {commands} = glyphFont.outline(shaped.glyph);
        const shape = shapeOf(commands);
        const crossed = crossings(commands);
        const ink = inkOf(commands);
        // (Its profile first, once: what the session works out ahead.)
        let started = GLib.get_monotonic_time();
        glyphFont.stretched(shaped.glyph, 1);
        worst.profile = Math.max(worst.profile, ms(started));
        for (const stretch of STRETCHES.slice(1)) {
            started = GLib.get_monotonic_time();
            const out = glyphFont.stretched(shaped.glyph, stretch);
            times.push(ms(started));
            worst.ms = Math.max(worst.ms, times[times.length - 1]);
            const after = shapeOf(out);
            const added = key => after.reduce((sum, c, i) => sum + Math.max(0, c[key] - shape[i][key]), 0);
            const stretchedInk = inkOf(out);
            const line = crookedness(commands, out);
            const result = {
                inflections: added('inflections'),
                corners: added('corners'),
                crossings: Math.max(0, crossings(out) - crossed),
                crooked: line ? line.worst : Infinity,
                height: char === ':' ? 0 : Math.max(Math.abs(stretchedInk.y2 - ink.y2 - (stretch - 1) * (top - bottom)),
                    Math.abs(stretchedInk.y1 - ink.y1)),
                stroke: char === ':' ? 0 : strokeChange(commands, out, 1.5 * stroke) / stroke,
            };
            for (const key of Object.keys(result))
                worst[key] = Math.max(worst[key], result[key]);
            if (result.inflections || result.corners || result.crossings || result.crooked > 1e-6 || result.height > 1e-3)
                print(`  ${char} × ${stretch}: ${JSON.stringify(result)}`);
        }
    }
    print(`${font.name} ${font.weight}: new inflections ${worst.inflections}, new corners ${worst.corners}, ` +
        `new crossings ${worst.crossings}, lines off straight ${(worst.crooked * 100).toFixed(4)} % of their length, ` +
        `height off ${worst.height.toFixed(4)} units, strokes ${(worst.stroke * 100).toFixed(2)} % thicker or thinner ` +
        `(the most of any figure at any stretch); a figure's profile ${worst.profile.toFixed(1)} ms, ` +
        `a stretch then ${(times.reduce((a, b) => a + b, 0) / times.length).toFixed(3)} ms (${worst.ms.toFixed(3)} at most)`);
}

GLib.mkdir_with_parents(OUT, 0o755);
for (const font of FONTS) {
    if (CHECK) {
        check(font);
        continue;
    }
    for (const key of Object.keys(TEXTS))
        print(`${OUT}/${sheet(font, key)}`);
    if (DETAIL) {
        for (const char of TEXTS.digits)
            print(`${OUT}/${detail(font, char)}`);
    }
}
