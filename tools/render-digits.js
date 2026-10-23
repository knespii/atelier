// The glass clock's digits, stretched as the clock stretched them (an
// affine scale, drawn by Pango) beside how lib/glyphStretch.js stretches
// them, in Inter, Roboto Flex and the system's Cantarell, at a few
// heights and two weights: PNGs in tests/output/digits.
//
// Usage: gjs -m tools/render-digits.js [--detail]
//        (--detail: also each digit large, its outline's points marked)

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {bundledFile, fontAt, systemFontFile, traceOutline} from '../lib/glyphOutlines.js';
import {STRETCH} from '../lib/lockLook.js';
import {TYPEFACES, styleFor, typefaceFor, variationsFor} from '../lib/lockType.js';

const OUT = GLib.build_filenamev([GLib.get_current_dir(), 'tests', 'output', 'digits']);
const STRETCHES = [1, 1.6, 2.2, STRETCH.max];
const WEIGHTS = [400, 800];
const TEXTS = {time: '10:52', digits: '0123456789'};
const FIGURE = 110; // how tall the figures are at a stretch of 1, pixels
const GAP = 36;
const DETAIL = ARGV.includes('--detail');

// The fonts: the bundled ones, and Cantarell (the shell's default) where
// the system has it.
const FONTS = [
    ...TYPEFACES.filter(t => t.file).map(t => ({id: t.id, name: t.name, family: t.families[0], path: bundledFile(t.file), axes: t.axes})),
    {id: 'default', name: 'Cantarell', family: 'Cantarell', path: systemFontFile('Cantarell'), axes: null},
].filter(font => font.path);

const fontMap = PangoCairo.FontMap.get_default();
for (const font of FONTS.filter(f => f.axes))
    fontMap.add_font_file?.(font.path);

// The old way: Pango's path of the text, scaled as a whole. (The weight
// asked for too: where the static Inter is installed, Pango finds that one
// at this size, which takes no notice of variations.)
function drawAffine(cr, font, weight, variations, text, size, scaleX, stretch, x, baseline) {
    const layout = PangoCairo.create_layout(cr);
    const desc = Pango.FontDescription.from_string(font.family);
    desc.set_absolute_size(size * Pango.SCALE);
    desc.set_weight(weight);
    desc.set_variations(variations);
    layout.set_font_description(desc);
    const attrs = new Pango.AttrList();
    attrs.insert(Pango.attr_font_features_new('tnum'));
    layout.set_attributes(attrs);
    layout.set_text(text, -1);
    cr.save();
    cr.translate(x, baseline);
    cr.scale(scaleX, stretch);
    cr.translate(0, -layout.get_baseline() / Pango.SCALE);
    PangoCairo.layout_path(cr, layout);
    cr.restore();
    cr.fill();
    const [, logical] = layout.get_pixel_extents();
    return logical.width * scaleX;
}

// The new way: each glyph's outline, stretched.
function drawStretched(cr, glyphFont, text, size, scaleX, stretch, x, baseline) {
    const scale = size / glyphFont.upem;
    const {glyphs, advance} = glyphFont.shape(text, ['tnum', 'case']);
    for (const g of glyphs) {
        traceOutline(cr, glyphFont.stretched(g.glyph, stretch),
            {x: x + (g.x + g.dx) * scale * scaleX, y: baseline - g.dy * scale, scale, scaleX});
    }
    cr.fill();
    return advance * scale * scaleX;
}

function sheet(font, weight, textKey) {
    const role = styleFor(typefaceFor(font.id), 'glass');
    const {variations, scaleX} = variationsFor(font.axes, {weight, width: role.width, size: 200});
    const glyphFont = fontAt(font.path, variations);
    const {top, bottom} = glyphFont.figures;
    const size = FIGURE * glyphFont.upem / (top - bottom);
    const text = TEXTS[textKey];
    const width = Math.ceil(glyphFont.shape(text).advance * size / glyphFont.upem * scaleX) + 2 * GAP;
    const rowHeights = STRETCHES.map(s => FIGURE * s + 2 * GAP);
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, 2 * width + GAP, Math.ceil(rowHeights.reduce((a, b) => a + b, 0)) + 40);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(1, 1, 1);
    cr.paint();
    cr.setSourceRGB(0.45, 0.45, 0.45);
    cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
    cr.setFontSize(16);
    cr.moveTo(GAP, 26);
    cr.showText(`${font.name} ${variations} × ${scaleX} — left: affine (as before), right: stretched`);
    let y = 40;
    STRETCHES.forEach((stretch, i) => {
        const baseline = y + GAP + FIGURE * stretch;
        // (The figures' top and baseline, faint.)
        cr.setSourceRGB(0.85, 0.9, 1);
        cr.rectangle(0, baseline - FIGURE * stretch, 2 * width + GAP, 1);
        cr.rectangle(0, baseline, 2 * width + GAP, 1);
        cr.fill();
        cr.setSourceRGB(0.08, 0.08, 0.1);
        drawAffine(cr, font, weight, glyphFont.variations, text, size, scaleX, stretch, GAP, baseline);
        drawStretched(cr, glyphFont, text, size, scaleX, stretch, width + GAP + GAP, baseline);
        y += rowHeights[i];
    });
    cr.$dispose();
    const name = `${font.name.replace(/\s/g, '')}-${weight}-${textKey}.png`;
    surface.writeToPNG(GLib.build_filenamev([OUT, name]));
    return name;
}

// One glyph large, stretched the most, its outline's points marked: on
// the curve dark, off it light.
function detail(font, weight, char) {
    const {variations} = variationsFor(font.axes, {weight, width: 100, size: 200});
    const glyphFont = fontAt(font.path, variations);
    const glyph = glyphFont.glyphOf(char);
    if (glyph === null)
        return null;
    const {top, bottom} = glyphFont.figures;
    const figure = 300;
    const scale = figure / (top - bottom);
    const stretch = STRETCH.max;
    const {ink, advance} = glyphFont.outline(glyph);
    const width = Math.ceil(advance * scale) + 2 * GAP;
    const height = Math.ceil(figure * stretch + 2 * GAP + 60);
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, 2 * width, height);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(1, 1, 1);
    cr.paint();
    const baseline = height - GAP - Math.max(0, -ink.y1 * scale);
    for (const [k, commands] of [[0, glyphFont.outline(glyph).commands], [1, glyphFont.stretched(glyph, stretch)]]) {
        const x = k * width + GAP;
        cr.setSourceRGB(0.75, 0.8, 0.9);
        traceOutline(cr, commands, {x, y: baseline, scale});
        cr.fill();
        cr.setSourceRGB(0.1, 0.1, 0.2);
        cr.setLineWidth(1);
        traceOutline(cr, commands, {x, y: baseline, scale});
        cr.stroke();
        for (const [op, ...v] of commands) {
            for (let i = 0; i + 1 < v.length; i += 2) {
                const onCurve = op !== 'C' || i === 4;
                cr.setSourceRGB(...onCurve ? [0.8, 0.1, 0.1] : [0.2, 0.6, 1]);
                cr.arc(x + v[i] * scale, baseline - v[i + 1] * scale, onCurve ? 2.2 : 1.6, 0, 2 * Math.PI);
                cr.fill();
            }
        }
    }
    cr.$dispose();
    const name = `detail-${font.name.replace(/\s/g, '')}-${weight}-${char === ':' ? 'colon' : char}.png`;
    surface.writeToPNG(GLib.build_filenamev([OUT, name]));
    return name;
}

GLib.mkdir_with_parents(OUT, 0o755);
for (const font of FONTS) {
    for (const weight of WEIGHTS) {
        for (const textKey of Object.keys(TEXTS))
            print(`${OUT}/${sheet(font, weight, textKey)}`);
        if (DETAIL) {
            for (const char of '0123456789:')
                print(`${OUT}/${detail(font, weight, char)}`);
        }
    }
}
