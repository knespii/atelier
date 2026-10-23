// Glyphs straight from a font file, through HarfBuzz: a line of text
// shaped (with tabular figures, so that the time doesn't wobble as it
// goes), and each glyph's outline, advance and ink, at an instance of a
// variable font. The glass clock draws its digits as paths, stretched by
// lib/glyphStretch.js; Pango has no outlines to give, and in gjs no
// HarfBuzz font of its own either. Works in plain gjs (the tests,
// tools/render-digits.js) and in the shell. What is read is kept: the
// files, a few instances of them, their glyphs' outlines and how they
// stretch.
//
// A system font is found where distributions install it (no fontconfig:
// on the lock screen that would mean starting a process); a font found
// nowhere has no outlines here, and is drawn as Pango draws it.

import GLib from 'gi://GLib';
import HarfBuzz from 'gi://HarfBuzz';

import {inkOf, profileOf, stretchOutline, strokeOf} from './glyphStretch.js';

/** The bundled fonts' folder: fonts/ in the extension. */
export const FONT_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0])), 'fonts']);

/**
 * @param {string} file - a bundled font's file name (lib/lockType.js TYPEFACES)
 * @returns {string} its path
 */
export const bundledFile = file => GLib.build_filenamev([FONT_DIR, file]);

// Where distributions install the shell's usual fonts, and the rounded and
// serif ones lib/lockType.js looks for: [family, weight (null: a variable
// font, every weight), paths]. Debian's and Ubuntu's first (those seen
// there), then Fedora's and Arch's.
const SYSTEM_FONTS = [
    ['Cantarell', null, [
        '/usr/share/fonts/opentype/cantarell/Cantarell-VF.otf',
        '/usr/share/fonts/abattis-cantarell-vf-fonts/Cantarell-VF.otf',
        '/usr/share/fonts/cantarell/Cantarell-VF.otf',
    ]],
    ['Adwaita Sans', null, [
        '/usr/share/fonts/truetype/adwaita/AdwaitaSans-Regular.ttf',
        '/usr/share/fonts/adwaita-sans-fonts/AdwaitaSans-Regular.ttf',
        '/usr/share/fonts/Adwaita/AdwaitaSans-Regular.ttf',
    ]],
    ['Ubuntu Sans', null, ['/usr/share/fonts/truetype/ubuntu/UbuntuSans[wdth,wght].ttf']],
    ['Quicksand', 300, ['/usr/share/fonts/truetype/quicksand/Quicksand-Light.ttf']],
    ['Quicksand', 400, ['/usr/share/fonts/truetype/quicksand/Quicksand-Regular.ttf']],
    ['Quicksand', 500, ['/usr/share/fonts/truetype/quicksand/Quicksand-Medium.ttf']],
    ['Quicksand', 700, ['/usr/share/fonts/truetype/quicksand/Quicksand-Bold.ttf']],
    ['DejaVu Serif', 400, ['/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf']],
    ['DejaVu Serif', 700, ['/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf']],
    ['Liberation Serif', 400, ['/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf']],
    ['Liberation Serif', 700, ['/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf']],
    ['Nimbus Roman', 400, ['/usr/share/fonts/opentype/urw-base35/NimbusRoman-Regular.otf']],
    ['Nimbus Roman', 700, ['/usr/share/fonts/opentype/urw-base35/NimbusRoman-Bold.otf']],
];

const exists = path => GLib.file_test(path, GLib.FileTest.IS_REGULAR);

/**
 * Where a system font's file is, as far as it is known.
 *
 * @param {string} family - e.g. the shell's font's ("Cantarell")
 * @param {number} [weight] - for a family of one file per weight: the
 *   nearest one (heavier ones first from 500 on, as CSS has it)
 * @returns {string|null} null: not known here (drawn as Pango draws it)
 */
export function systemFontFile(family, weight = 400) {
    const name = String(family ?? '').trim().toLowerCase();
    const found = SYSTEM_FONTS.filter(([f]) => f.toLowerCase() === name)
        .map(([, w, paths]) => [w, paths.find(exists)])
        .filter(([, path]) => path);
    if (found.length === 0)
        return null;
    const variable = found.find(([w]) => w === null);
    if (variable)
        return variable[1];
    const distance = w => Math.abs(w - weight) + (weight >= 500 ? (w < weight ? 0.5 : 0) : (w > weight ? 0.5 : 0));
    return found.reduce((best, item) => distance(item[0]) < distance(best[0]) ? item : best)[1];
}

// Axes a font may have: the registered ones and Roboto Flex's own. (Their
// list can't be read from gjs: hb_ot_var_get_axis_infos() is out of its
// reach; each is looked for instead.)
const AXIS_TAGS = ['wght', 'wdth', 'opsz', 'slnt', 'ital', 'GRAD', 'XOPQ', 'XTRA', 'YOPQ', 'YTAS', 'YTDE',
    'YTFI', 'YTLC', 'YTUC', 'ROND', 'CASL', 'MONO', 'CRSV', 'SOFT', 'WONK', 'FILL'];

const faces = new Map();

// A file's HarfBuzz face, read once.
function faceOf(path) {
    let face = faces.get(path);
    if (!face) {
        const blob = HarfBuzz.blob_create_from_file(path);
        if (HarfBuzz.blob_get_length(blob) === 0)
            throw new Error(`no font at ${path}`);
        face = HarfBuzz.face_create(blob, 0);
        if (HarfBuzz.face_get_glyph_count(face) === 0)
            throw new Error(`no glyphs in ${path}`);
        faces.set(path, face);
    }
    return face;
}

/**
 * @param {string} path - a font file
 * @returns {object|null} its axes, {tag: {min, default, max}} ({} for a
 *   font that isn't variable); null when it can't be read
 */
export function axesOf(path) {
    let face;
    try {
        face = faceOf(path);
    } catch {
        return null;
    }
    const axes = {};
    if (!HarfBuzz.ot_var_has_data(face))
        return axes;
    for (const tag of AXIS_TAGS) {
        const [found, info] = HarfBuzz.ot_var_find_axis_info(face, HarfBuzz.tag_from_string(tag));
        if (found)
            axes[tag] = {min: info.min_value, default: info.default_value, max: info.max_value};
    }
    return axes;
}

// One set of drawing functions for every outline: they add to `drawn`.
let drawn = null;
let drawFuncs = null;

function draw(font, glyph) {
    if (!drawFuncs) {
        // (No quadratic_to: HarfBuzz hands quadratic curves on as cubic ones.)
        drawFuncs = HarfBuzz.draw_funcs_create();
        HarfBuzz.draw_funcs_set_move_to_func(drawFuncs, (funcs, state, x, y) => drawn.push(['M', x, y]));
        HarfBuzz.draw_funcs_set_line_to_func(drawFuncs, (funcs, state, x, y) => drawn.push(['L', x, y]));
        HarfBuzz.draw_funcs_set_cubic_to_func(drawFuncs, (funcs, state, x1, y1, x2, y2, x, y) =>
            drawn.push(['C', x1, y1, x2, y2, x, y]));
        HarfBuzz.draw_funcs_set_close_path_func(drawFuncs, () => drawn.push(['Z']));
    }
    drawn = [];
    try {
        HarfBuzz.font_draw_glyph(font, glyph, drawFuncs, null);
        return drawn;
    } finally {
        drawn = null;
    }
}

const encoder = new TextEncoder();
const features = new Map();

function featureOf(name) {
    let feature = features.get(name);
    if (feature === undefined) {
        const [ok, parsed] = HarfBuzz.feature_from_string(encoder.encode(name));
        feature = ok ? parsed : null;
        features.set(name, feature);
    }
    return feature;
}

/** A font file at an instance: its glyphs shaped, outlined and stretched. */
export class GlyphFont {
    /**
     * @param {string} path - the font file
     * @param {string} [variations] - as lib/lockType.js variationsFor()
     *   has them ("wght=600,opsz=32"); '' for the font's default
     */
    constructor(path, variations = '') {
        this.path = path;
        this.variations = variations;
        const face = faceOf(path);
        this._font = HarfBuzz.font_create(face);
        const parsed = variations.split(',').map(v => v.trim()).filter(Boolean)
            .map(v => HarfBuzz.variation_from_string(encoder.encode(v)))
            .filter(([ok]) => ok).map(([, v]) => v);
        if (parsed.length > 0)
            HarfBuzz.font_set_variations(this._font, parsed);
        /** Units to the em: what the outlines and advances are in. */
        this.upem = HarfBuzz.face_get_upem(face);
        this._outlines = new Map();
        this._profiles = new Map();
        this._metrics = null;
    }

    /**
     * @param {string} char - one character
     * @returns {number|null} its glyph, as the font maps it (null: none)
     */
    glyphOf(char) {
        const [found, glyph] = HarfBuzz.font_get_nominal_glyph(this._font, char.codePointAt(0));
        return found ? glyph : null;
    }

    /**
     * A line of text, shaped.
     *
     * @param {string} text
     * @param {string[]} [featureNames] - OpenType features, as CSS's
     *   font-feature-settings names them ("tnum": digits all as wide;
     *   "case": a colon as high as the figures)
     * @returns {{glyphs: object[], advance: number}} each glyph {glyph,
     *   cluster (its first character's place in the text), x (the pen's),
     *   advance, dx, dy (an offset from the pen)}, and the line's advance,
     *   in font units
     */
    shape(text, featureNames = ['tnum']) {
        const buffer = HarfBuzz.buffer_create();
        const bytes = encoder.encode(text);
        HarfBuzz.buffer_add_utf8(buffer, bytes, 0, -1);
        HarfBuzz.buffer_guess_segment_properties(buffer);
        HarfBuzz.shape(this._font, buffer, featureNames.map(featureOf).filter(Boolean));
        const infos = HarfBuzz.buffer_get_glyph_infos(buffer);
        const positions = HarfBuzz.buffer_get_glyph_positions(buffer);
        // (Clusters are places in the UTF-8 bytes: in characters here.)
        const charAt = new Map();
        let offset = 0;
        [...text].forEach((char, i) => {
            charAt.set(offset, i);
            offset += encoder.encode(char).length;
        });
        let x = 0;
        const glyphs = infos.map((info, i) => {
            const {x_advance: advance, x_offset: dx, y_offset: dy} = positions[i];
            const glyph = {glyph: info.codepoint, cluster: charAt.get(info.cluster) ?? info.cluster, x, advance, dx, dy};
            x += advance;
            return glyph;
        });
        return {glyphs, advance: x};
    }

    /**
     * @param {number} glyph
     * @returns {{commands: Array[], advance: number, ink: object|null}} its
     *   outline (y up, font units: ['M', x, y], ['L', x, y], ['C', x1, y1,
     *   x2, y2, x, y], ['Z']), its advance and its ink's box {x1, y1, x2,
     *   y2} (null for none: a space)
     */
    outline(glyph) {
        let outline = this._outlines.get(glyph);
        if (!outline) {
            const commands = draw(this._font, glyph);
            outline = {
                commands,
                advance: HarfBuzz.font_get_glyph_h_advance(this._font, glyph),
                ink: inkOf(commands),
            };
            this._outlines.set(glyph, outline);
        }
        return outline;
    }

    /**
     * What the figures stretch from, in font units: the baseline to their
     * top (the flat top of a "1", "4" or "7"; the capitals' height if the
     * font has none of them), and how thick their horizontal strokes are
     * (the top of the "0").
     *
     * @returns {{bottom: number, top: number, stroke: number|null, ascender: number, descender: number}}
     */
    get figures() {
        if (!this._metrics) {
            const tops = ['1', '4', '7'].map(char => this.glyphOf(char))
                .filter(glyph => glyph !== null)
                .map(glyph => this.outline(glyph).ink?.y2)
                .filter(Number.isFinite);
            const [hasCap, cap] = HarfBuzz.ot_metrics_get_position(this._font, HarfBuzz.ot_metrics_tag_t.CAP_HEIGHT);
            const [, extents] = HarfBuzz.font_get_h_extents(this._font);
            const zero = this.glyphOf('0');
            this._metrics = {
                bottom: 0,
                top: tops.length > 0 ? Math.max(...tops) : hasCap && cap > 0 ? cap : extents.ascender,
                stroke: zero === null ? null : strokeOf(this.outline(zero).commands) || null,
                ascender: extents.ascender,
                descender: extents.descender,
            };
        }
        return this._metrics;
    }

    /**
     * A glyph stretched: taller by `stretch` between the baseline and the
     * figures' top (lib/glyphStretch.js), its strokes as thick as they
     * are. Every figure reaches the same height; a colon's dots stay
     * round, centred on the figures and as far apart as they stretch
     * (centred even at a stretch of 1).
     *
     * @param {number} glyph
     * @param {number} stretch - 1: as it is
     * @returns {Array[]} its outline, stretched
     */
    stretched(glyph, stretch) {
        const {commands} = this.outline(glyph);
        let profile = this._profiles.get(glyph);
        if (!profile) {
            const {bottom, top, stroke} = this.figures;
            profile = profileOf(commands, {bottom, top, stroke});
            this._profiles.set(glyph, profile);
        }
        if (stretch === 1 && profile.mode !== 'dots')
            return commands;
        return stretchOutline(commands, profile, stretch);
    }
}

// The instances kept: the latest few (a weight dragged along a slider
// makes one for each value).
const KEPT = 8;
const instances = new Map();

/**
 * A font file at an instance, kept once made.
 *
 * @param {string} path
 * @param {string} [variations]
 * @returns {GlyphFont} (throws when the file can't be read)
 */
export function fontAt(path, variations = '') {
    const key = `${path}\n${variations}`;
    let font = instances.get(key);
    if (font) {
        instances.delete(key);
    } else {
        font = new GlyphFont(path, variations);
        while (instances.size >= KEPT)
            instances.delete(instances.keys().next().value);
    }
    instances.set(key, font);
    return font;
}

/**
 * Add an outline to a Cairo path: y down, as Cairo has it.
 *
 * @param {object} cr - a Cairo context
 * @param {Array[]} commands - an outline, y up (font units)
 * @param {object} place
 * @param {number} place.x - where its origin goes, x
 * @param {number} place.y - and y: the baseline
 * @param {number} place.scale - device units per font unit (size / upem)
 * @param {number} [place.scaleX] - and as much again across (a width the
 *   font can't make itself)
 */
export function traceOutline(cr, commands, {x, y, scale, scaleX = 1}) {
    const sx = scale * scaleX;
    const at = (px, py) => [x + px * sx, y - py * scale];
    for (const [op, ...v] of commands) {
        if (op === 'M')
            cr.moveTo(...at(v[0], v[1]));
        else if (op === 'L')
            cr.lineTo(...at(v[0], v[1]));
        else if (op === 'C')
            cr.curveTo(...at(v[0], v[1]), ...at(v[2], v[3]), ...at(v[4], v[5]));
        else if (op === 'Z')
            cr.closePath();
    }
}
