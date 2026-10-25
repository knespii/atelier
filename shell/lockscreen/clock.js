// The lock screen's clock: the desktop's (shell/desktop/kinds/time.js), its
// stacked minutes as bright as its hours, and a face of its own – glass:
// the time in one line of tall digits of Liquid Glass, the wallpaper bent
// through them, under a small date line, as an iPhone's. The digits are the
// font's own outlines (lib/glyphOutlines.js), in the typeface, weight and
// width the settings give and as heavy as reading them takes (lib/
// lockLook.js legibilityPlan()), and they grow tall as a tall typeface draws
// them: their stems and the sides of their bowls longer, their bars, the
// turns of their curves and their dots as they are (lib/glyphStretch.js).
// They fill the clock's box, as the editor stretches it (to any size, cell
// by cell): as large as it is wide, from under the date line down to its
// bottom – whatever of the wallpaper's subject stands in front of them
// there (see board.js); in a box too flat for them, as tall as it is.
//
// Drawn on the GPU (glassText.js), from each figure's signed distances,
// made ahead of time (figureAtlas.js: in the session, by GlassWarmUp, for
// each clock as it was last laid out; else while the shell is idle, the
// digits shown once they are made). As the minute turns, the figures that
// change – only they – go: the old one lifting as it fades, the new one
// rising into its place (lib/glassClock.js changeAt()), a few numbers given
// the GPU each frame. Nothing is drawn while it rests. Stretched in the
// editor, the figures made for the size it had are laid over the digits'
// new places as it goes, and made anew for the size it rests at.

import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    CHANGE, FIGURES, FILL, SAMPLE, boxRound, changeAt, changedFigures, fitSize, glassInstance, heavier, learn, placeLine,
    setLine, unlearnt,
} from '../../lib/glassClock.js';
import {glassFor, tintShown} from '../../lib/glassBackdrop.js';
import {lookOf} from '../../lib/glassLook.js';
import {mappedPlace, slotPlace, slotReach} from '../../lib/glyphAtlas.js';
import {FAR, TEXEL, glyphSdf, sdfFromMask} from '../../lib/glyphSdf.js';
import {inkOf} from '../../lib/glyphStretch.js';
import {glassDigits} from '../../lib/lockLook.js';
import {labelFont, styleFor, typefaceFor} from '../../lib/lockType.js';
import {hexToRgb, luminance} from '../../lib/palette.js';
import {LOCK_KINDS, parseLayout, splitClock} from '../../lib/widgets.js';
import {holdLabelFont} from '../core/fonts.js';
import {textureDensity} from '../core/glassMaterial.js';
import {ClockWidget} from '../desktop/kinds/time.js';
import {label} from '../desktop/widget.js';
import {atlasOf, makeAtlas} from './figureAtlas.js';
import {GlassText} from './glassText.js';
import {GlassVariant, prepareLockBackdrop} from './liquidGlass.js';

const DATE_GAP = 2; // between the date line and the digits, logical pixels
// Type this light (WCAG luminance) or darker is dark type, as
// lib/lockLook.js chosenTone() tells it: dark glass.
const DARK = 0.18;
// A halo round dark glass is a light glow, as dark again as a shadow
// round light glass.
const GLOW = 1.2;

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

// The family of the shell's own font: the default typeface's.
const shellFamily = () => St.ThemeContext.get_for_stage(global.stage).get_font()?.get_family() ?? null;

// A planned shadow as St takes it: x y blur colour.
const shadowStyle = ({color, alpha, blur, y}) =>
    `0 ${y}px ${blur}px rgba(${hexToRgb(color).join(', ')}, ${Number(alpha.toFixed(2))})`;

// Whether a type or a plan is the one there is (told again, as the lock
// screen's type is worked out anew: nothing to do).
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// What of a plan the face draws (the rest – how well it reads – it only
// keeps): the digits' weight or grade, their shadow and glass, the date
// line's weight and shadow, and the tone.
const drawnOf = plan => plan && {
    digits: plan.digits && [plan.digits.weight, plan.digits.boldness, plan.digits.shadow, plan.digits.glass],
    date: plan.date && [plan.date.weight, plan.date.boldness, plan.date.shadow],
    tone: plan.tone,
};

/** The typeface the glass digits are drawn in until they are told another: Inter, as its own. */
function defaultType() {
    const typeface = typefaceFor('inter');
    return {typeface, style: styleFor(typeface, 'glass')};
}

/**
 * How large a font's digits are drawn in a box, and how tall they stand:
 * as wide as it is at most, no taller than the room under the date line,
 * stretched down to its bottom (lib/lockLook.js glassDigits()). The face's
 * sums – and the session's, making their figures ahead of time.
 *
 * @param {object} font - a GlyphFont
 * @param {number} scaleX - how much narrower the font is drawn
 * @param {number} width - the box's, pixels
 * @param {object} room - {top, bottom} under the date line, pixels
 * @returns {{metrics: object, target: object}} metrics: {fontSize, inkY,
 *   inkHeight, width}; target: {stretch, y}
 */
export function fitFigures(font, scaleX, width, room) {
    const size = fitSize(font, width, scaleX, Math.max(1, room.bottom - room.top));
    const k = size / font.upem;
    const {top, bottom} = font.figures;
    const {advance} = setLine(font, SAMPLE);
    const metrics = {fontSize: size, inkY: 0, inkHeight: Math.max(1, (top - bottom) * k), width: advance * k * scaleX};
    return {metrics, target: glassDigits(metrics.inkHeight, room.top, room.bottom)};
}

/**
 * What a font's figures' atlas is made of (figureAtlas.js makeAtlas()):
 * each figure (and any other character of the text) stretched as tall as
 * they stand, its signed distances at the density of pixels drawn.
 *
 * @param {object} wanted - lib/glassClock.js glassInstance()'s, its font
 *   a GlyphFont
 * @param {object} options
 * @param {number} options.fontSize - pixels (of the clock's)
 * @param {number} options.stretch
 * @param {number} options.density - device pixels in one of the clock's
 * @param {string} [options.text] - the time shown
 * @returns {object} {key, from, parts}
 */
export function figureAtlasSpec({font, key, scaleX}, {fontSize, stretch, density, text = ''}) {
    // (As the line is set: its figures tabular, its colon as high as they are.)
    const glyphs = [...new Set([FIGURES, text].flatMap(line => setLine(font, line).glyphs.map(g => g.glyph))
        .filter(glyph => glyph > 0))];
    const scale = fontSize / font.upem * density;
    return {
        key: [key, fontSize, stretch.toFixed(4), density, glyphs.join(',')].join('\n'),
        from: font.path,
        parts: glyphs.map(glyph => ({
            id: glyph,
            make: () => {
                const commands = font.stretched(glyph, stretch);
                const sdf = glyphSdf(commands, {scale, scaleX});
                const ink = inkOf(commands);
                sdf.ink = ink ? [FAR, FAR, (ink.x2 - ink.x1) * scale * scaleX, (ink.y2 - ink.y1) * scale] : [0, 0, 0, 0];
                return sdf;
            },
        })),
    };
}

// Where each glass clock's face was last laid out (by the clock, on a
// monitor at a scale): for the session to make its figures ahead of the
// lock screen. Kept in Atelier's cache too, for the first lock after
// logging in.
const GEOMETRY_FILE = () => GLib.build_filenamev([GLib.get_user_cache_dir(), 'atelier', 'glass', 'clocks.json']);
const geometries = new Map();
let geometriesLoaded = false;
let geometrySave = 0;
/** Emits 'changed' as a glass clock is laid out at another size. */
export const clockGeometries = new EventEmitter();

function loadGeometries() {
    if (geometriesLoaded)
        return;
    geometriesLoaded = true;
    try {
        const [, bytes] = GLib.file_get_contents(GEOMETRY_FILE());
        Object.entries(JSON.parse(new TextDecoder().decode(bytes)))
            .forEach(([key, value]) => !geometries.has(key) && geometries.set(key, value));
    } catch {
        // (None kept yet.)
    }
}

// Keyed by the clock, the monitor and the scale.
const geometryKey = (id, monitor, scale) => `${id}@${monitor?.width}x${monitor?.height}@${scale}`;

function recordGeometry(id, geometry) {
    const key = geometryKey(id, Main.layoutManager.primaryMonitor, scaleFactor());
    if (!id || same(geometries.get(key), geometry))
        return;
    loadGeometries();
    geometries.set(key, geometry);
    clockGeometries.emit('changed');
    if (geometrySave)
        return;
    geometrySave = GLib.idle_add(GLib.PRIORITY_LOW, () => {
        geometrySave = 0;
        const path = GEOMETRY_FILE();
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
        const bytes = new TextEncoder().encode(JSON.stringify(Object.fromEntries(geometries)));
        Gio.File.new_for_path(path).replace_contents_bytes_async(new GLib.Bytes(bytes), null, false,
            Gio.FileCreateFlags.NONE, null, (file, res) => {
                try {
                    file.replace_contents_finish(res);
                } catch (e) {
                    console.warn(`Atelier: where the glass clocks are wasn't kept: ${e.message}`);
                }
            });
        return GLib.SOURCE_REMOVE;
    });
}

/**
 * @param {string} id - a clock's
 * @returns {object|null} where its glass face was last laid out here (on
 *   the main monitor as it is, at the scale there is): {width, top, bottom,
 *   density, plan}
 */
export function clockGeometry(id) {
    loadGeometries();
    return geometries.get(geometryKey(id, Main.layoutManager.primaryMonitor, scaleFactor())) ?? null;
}

// Where the font has no file to draw from, Pango draws the digits – the
// line of them as one, stretched as a whole (taller and the strokes across
// thicker, its "0" an ellipse) – into a mask, a pixel of it a texel; read
// back through a PNG (Cairo in gjs gives its pixels no other way); and its
// signed distances worked out from that.
function pangoSdf(draw, {x, y, width, height}, density) {
    const margin = FAR / density;
    const [w, h] = [width + 2 * margin, height + 2 * margin].map(v => Math.max(1, Math.ceil(v * density / TEXEL)));
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
    const cr = new Cairo.Context(surface);
    cr.scale(density / TEXEL, density / TEXEL);
    cr.translate(margin - x, margin - y);
    draw(cr);
    cr.setSourceRGBA(1, 1, 1, 1);
    cr.fill();
    cr.$dispose();
    const path = GLib.build_filenamev([GLib.get_user_cache_dir(), 'atelier', 'glass', 'figures.png']);
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    surface.writeToPNG(path);
    surface.finish();
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    GLib.unlink(path);
    const [pixels, stride, channels] = [pixbuf.get_pixels(), pixbuf.get_rowstride(), pixbuf.get_n_channels()];
    const alpha = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++)
            alpha[j * w + i] = channels === 4 ? pixels[j * stride + i * 4 + 3] : pixels[j * stride + i * channels];
    }
    const sdf = sdfFromMask(alpha, w, h, {band: FAR / TEXEL});
    return {
        width: w,
        height: h,
        // (Its origin the face's: the tile lies where the line does.)
        x: (margin - x) * density,
        y: (margin - y) * density,
        texel: TEXEL,
        band: FAR,
        distances: sdf.distances.map(d => d * TEXEL),
        ink: [FAR, FAR, width * density, height * density],
    };
}

// What holds the digits' style (their colour, the font Pango draws them
// in): restyled, the face looks at it again.
const DigitsStyle = GObject.registerClass(
class AtelierGlassDigits extends St.Widget {
    _init(face, params) {
        super._init(params);
        this._face = face;
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this._face.restyled(this);
    }
});

const GlassFace = GObject.registerClass({
    Properties: {
        // How far the figures that change have gone (1 at rest).
        'change': GObject.ParamSpec.double('change', null, null, GObject.ParamFlags.READWRITE, 0, 1, 1),
    },
}, class AtelierGlassFace extends St.Widget {
    /**
     * @param {string} size - the clock's size, named or its own (lib/
     *   widgets.js sizeOf()): the optical size its digits are drawn at
     * @param {object} [kept] - what it was told before, by the clock it is
     *   the face of (it keeps it for the face built anew for another size):
     *   {type, plan, backdrop, variant}
     */
    _init(size = 'large', kept = {}) {
        super._init({style_class: 'atelier-widget-glass', x_expand: true, y_expand: true});
        this._sizeName = size;
        this._kept = kept;
        this._digits = new DigitsStyle(this, {style_class: 'atelier-widget-glass-digits'});
        this._glass = new GlassText();
        this._date = label('atelier-widget-glass-date');
        this.add_child(this._digits);
        this.add_child(this._glass);
        this.add_child(this._date);
        this._stretch = 1;
        this._level = 0;
        this._change = 1;
        this._target = null;
        this._metrics = null;
        this._size = [0, 0];
        this._roomTop = null;
        this._text = '';
        this._turning = null;
        this._font = null;
        this._wanted = null;
        this._learning = 0;
        this._outlines = new Map();
        this._dirty = false;
        this._allocating = false;
        this._stretching = false;
        this._settleId = 0;
        this._specKey = null;
        // The atlas the figures are being made into (and how to let go of it).
        this._making = null;
        /** The clock it is the face of (where it was laid out is kept by it). */
        this.clockId = null;
        /** How many figures it has worked out itself (none, when the session did ahead of it). */
        this.workedOut = 0;
        /** How many tiles of figures were made for it while it waited (none, when the session made them ahead of it). */
        this.sdfBuilds = 0;
        this._type = kept.type ?? defaultType();
        this._plan = kept.plan ?? null;
        this._variant = kept.variant ?? 'regular';
        this._backdrop = kept.backdrop ?? null;
        /** Called when the digits are measured anew (the depth effect follows them). */
        this.onMeasured = null;
        // (What of their style the digits were last drawn in: restyled().)
        this._style = null;
        // (Out of sight, a change of the figures ends where it was going.)
        this.connect('notify::mapped', () => !this.mapped && this._settle());
        this.connect('destroy', () => {
            this._stopLearning();
            this._stopSettling();
            this._stopMaking();
            // (A change of the figures under way – the minute turning as the
            // screen unlocks – ends with the face.)
            this._turning = null;
            this.remove_transition('change');
        });
        this._syncDate();
        this._syncFont();
    }

    /** @returns {number} how much taller than they are the digits stand */
    get stretch() {
        return this._stretch;
    }

    /** @returns {number} where their top is, in the face */
    get level() {
        return this._level;
    }

    get change() {
        return this._change;
    }

    set change(value) {
        if (value === this._change)
            return;
        this._change = value;
        this.notify('change');
        // (A frame of the change: only where the figures that change are.)
        if (this._turning)
            this._syncSlots();
    }

    /** @returns {GlassText} what draws the digits */
    get glassText() {
        return this._glass;
    }

    /** @returns {number} how many times the digits were drawn */
    get paints() {
        return this._glass.paints;
    }

    /** @returns {number} how many times the figures were moved or laid anew (numbers only) */
    get slotUpdates() {
        return this._glass.slotUpdates;
    }

    /** @returns {boolean} whether its clock is being stretched */
    get stretching() {
        return this._stretching;
    }

    /**
     * @param {boolean} stretching - its clock's corner dragged in the editor,
     *   or easing to its size once let go of: the figures made for the size
     *   it had laid over the digits as they go; let go of, made for the
     *   size it rests at – once the frame it was let go of in is done, as
     *   what it takes to read there is worked out anew in that frame
     *   (board.js)
     */
    set stretching(stretching) {
        this._stopSettling();
        if (stretching) {
            this._stretching = true;
            return;
        }
        if (!this._stretching)
            return;
        this._settleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._settleId = 0;
            this._stretching = false;
            this._repaint();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopSettling() {
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
    }

    /**
     * @param {string} size - its clock's size anew (it lays itself out for
     *   the box it is given): the optical size its digits are drawn at
     */
    setSize(size) {
        if (size === this._sizeName)
            return;
        this._sizeName = size;
        this._syncFont();
    }

    /**
     * The typeface and style the digits are drawn in (the date line in the
     * typeface's text weight), as the lock screen's settings have them.
     * Until it is told, Inter, as the glass face has it.
     *
     * @param {object} type
     * @param {object} type.typeface - lib/lockType.js typefaceFor() clock-font
     * @param {object} type.style - styleFor(typeface, 'glass', {weight:
     *   clock-weight, width: clock-width})
     */
    setType({typeface, style}) {
        const type = {typeface, style};
        if (same(type, this._type))
            return;
        this._type = type;
        this._kept.type = type;
        this._syncDate();
        this._syncFont();
    }

    /**
     * What it takes the digits and the date line to read where they are
     * (lib/lockLook.js legibilityPlan()s; the digits' made with
     * digitsMetrics): a heavier weight – in Roboto Flex a higher grade,
     * which keeps them as wide –, a soft shadow round them only where it
     * is planned, and the glass washed more towards the tone (lib/
     * glassBackdrop.js glassFor()).
     *
     * @param {object|null} plan - null: nothing known (no shadow, the glass
     *   as it is)
     * @param {object|null} plan.digits - the digits' plan
     * @param {object|null} [plan.date] - the date line's
     * @param {object} [plan.tone] - {color, dark}: the tone they are
     *   planned for (else the colour the digits' style has)
     */
    setPlan(plan) {
        const planned = plan ? {digits: plan.digits ?? null, date: plan.date ?? null, tone: plan.tone ?? null} : null;
        if (same(planned, this._plan))
            return;
        const drawn = drawnOf(this._plan);
        this._plan = planned;
        this._kept.plan = planned;
        // (Only how well they read is another: drawn as they are.)
        if (same(drawnOf(planned), drawn))
            return;
        this._syncDate();
        this._syncFont();
        this._repaint();
    }

    /** @returns {string} the glass the digits are drawn in (lib/glassLook.js VARIANTS) */
    get variant() {
        return this._variant;
    }

    /**
     * The glass the digits are drawn in, as Atelier's glass looks:
     * 'regular', 'clear', or 'off' – solid, in the tone. Until it is told,
     * regular.
     *
     * @param {string} variant
     */
    setVariant(variant) {
        if (variant === this._variant)
            return;
        this._variant = variant;
        this._kept.variant = variant;
        this._repaint();
    }

    /** @returns {object|null} the wallpaper behind the glass, as its legibility is weighed on */
    get backdrop() {
        return this._backdrop;
    }

    /**
     * @param {object|null} backdrop - liquidGlass.js GlassBackdrop's
     *   current: the wallpaper as the glass blurs it, small, for what the
     *   digits take to read; null with no glass
     */
    set backdrop(backdrop) {
        this._backdrop = backdrop;
        this._kept.backdrop = backdrop;
    }

    /** @returns {object|null} {fontSize, inkY, inkHeight, width} of the digits as they are, pixels */
    get metrics() {
        return this._metrics;
    }

    /**
     * @returns {object|null} what a legibility plan of the digits takes
     *   (lib/lockLook.js legibilityPlan()): {size: their size before they
     *   stretch, CSS pixels; weight: their own, before any plan; tintAlpha:
     *   how much the glass is washed towards the tone at rest – the plan's
     *   `glass` (lib/glassBackdrop.js tintShown()); null for no glass,
     *   solid digits}; null until measured
     */
    get digitsMetrics() {
        if (!this._metrics)
            return null;
        return {
            size: this._metrics.fontSize / scaleFactor(),
            weight: this._type.style.weight,
            tintAlpha: lookOf(this._variant) ? tintShown() : null,
        };
    }

    /** @returns {object|null} {stretch, y}: how tall the digits stand in the box, and where their top is */
    get target() {
        return this._target;
    }

    /** @returns {St.Label} the date line over the digits (in front of the depth effect's subject, board.js) */
    get dateLine() {
        return this._date;
    }

    /** @returns {object} {x, y, width, height} where the date line goes, in the face */
    get dateRect() {
        const [, dateWidth] = this._date.get_preferred_width(-1);
        const [, height] = this._date.get_preferred_height(-1);
        const width = Math.min(this._size[0], dateWidth);
        return {
            x: Math.round((this._size[0] - width) / 2),
            y: Math.max(0, Math.round(this._level - DATE_GAP * scaleFactor() - height)),
            width,
            height,
        };
    }

    /** @returns {string|null} the font file the digits are drawn from; null: as Pango draws them */
    get fontFile() {
        return this._font?.file ?? null;
    }

    /** @returns {string|null} the instance of it ("wght=600,opsz=32") */
    get variations() {
        return this._font?.variations ?? null;
    }

    /** @returns {object|null} {leaving, coming}: the figures changing now (their places); null at rest */
    get changing() {
        return this._turning ? {leaving: [...this._turning.leaving], coming: [...this._turning.coming]} : null;
    }

    /**
     * The digits restyled: drawn anew only if what they are drawn in is
     * another: the colour of their type (but for a tone planned), the font
     * Pango draws them in, or the shell's family. Not when only what is
     * round them was restyled, as GNOME's lock screen is whenever the key
     * focus comes to it or goes (as the prompt comes up and goes).
     *
     * @param {St.Widget} digits
     */
    restyled(digits) {
        const node = digits.get_theme_node();
        const {red, green, blue, alpha} = node.get_foreground_color();
        const style = JSON.stringify([[red, green, blue, alpha], node.get_font().to_string(), shellFamily()]);
        if (style === this._style)
            return;
        this._style = style;
        // (Another colour, or another font for Pango to find.)
        this._syncFont();
        this._repaint();
    }

    // The digits anew as the face is laid out next: once, however often it
    // is asked before.
    _repaint() {
        this._dirty = true;
        if (!this._allocating)
            this.queue_relayout();
    }

    /** The clock moved (dragged in the editor): its glass shows what is behind it there. */
    followMove() {
        this._glass.setPlace(this._onMonitor());
    }

    /** @param {string} text - the clock as GNOME shows it, e.g. "9∶41 PM" */
    setClock(text) {
        const {hours, minutes} = splitClock(text);
        const digits = minutes ? `${hours}:${minutes}` : hours;
        this._date.text = GLib.DateTime.new_now_local().format('%A, %B %-d');
        if (digits === this._text)
            return;
        const before = this._text;
        this._text = digits;
        // (Figures besides the usual ones: has the font them, are they known?)
        if ([...digits].some(char => !FIGURES.includes(char)))
            this._syncFont();
        this._turn(before);
    }

    // The minute turned: the figures that change go – not the first time,
    // nor out of sight (nor with GNOME's animations off: at once), nor as
    // Pango draws them.
    _turn(before) {
        this._settle();
        const {leaving, coming} = changedFigures(before, this._text);
        const moves = this.mapped && adjustAnimationTime(CHANGE.time) > 0 && this._metrics && this._font?.font &&
            leaving.length + coming.length > 0;
        if (!moves) {
            this._repaint();
            return;
        }
        const turning = {before, leaving, coming};
        this._turning = turning;
        this._change = 0;
        this.notify('change');
        this._repaint();
        this.ease_property('change', 1, {
            duration: CHANGE.time,
            mode: Clutter.AnimationMode.LINEAR,
            onStopped: () => {
                if (this._turning === turning)
                    this._settle();
            },
        });
    }

    // A change of the figures under way ends where it was going.
    _settle() {
        if (!this._turning)
            return;
        this._turning = null;
        this.remove_transition('change');
        this._change = 1;
        this.notify('change');
        this._syncSlots();
    }

    // The instance the digits are to be drawn in now: the typeface and
    // style given, the plan's weight or grade, a clock of its size's
    // optical size. A font without a figure is left to Pango.
    _wantedFont() {
        const {typeface, style} = this._type;
        const wanted = glassInstance(typeface, style,
            {size: this._sizeName, plan: this._plan?.digits, shellFamily: shellFamily()});
        const font = wanted.font;
        if (font && [...FIGURES.replace(/\D/g, ''), ...this._text].some(char => !(font.glyphOf(char) > 0)))
            return {...wanted, font: null, file: null, key: `pango:${wanted.key}`};
        return wanted;
    }

    // Draw in the instance wanted once its figures' stretch is worked out:
    // at once if it is known (worked out in the session ahead of time, see
    // GlassWarmUp), else a figure at a time while the shell is idle (never
    // in a frame) – the one before drawn meanwhile.
    _syncFont() {
        const wanted = this._wantedFont();
        if (wanted.key === this._font?.key) {
            this._stopLearning();
            return;
        }
        if (!wanted.font || unlearnt(wanted.font, this._text).length === 0) {
            this._stopLearning();
            this._useFont(wanted);
            return;
        }
        if (this._learning && this._wanted?.key === wanted.key)
            return;
        this._stopLearning();
        this._wanted = wanted;
        this._learning = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const [glyph] = unlearnt(wanted.font, this._text);
            if (glyph !== undefined) {
                learn(wanted.font, glyph);
                this.workedOut++;
                return GLib.SOURCE_CONTINUE;
            }
            this._learning = 0;
            this._wanted = null;
            this._useFont(wanted);
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopLearning() {
        if (this._learning)
            GLib.source_remove(this._learning);
        this._learning = 0;
        this._wanted = null;
    }

    _useFont(font) {
        this._settle();
        this._font = font;
        this._outlines.clear();
        this._metrics = null;
        this._repaint();
    }

    // The date line: in the typeface, its text weight (heavier as its plan
    // has it), a shadow round it only where one is planned.
    _syncDate() {
        const {typeface} = this._type;
        const text = styleFor(typeface, 'text');
        const plan = this._plan?.date ?? null;
        const {weight, extra} = heavier(typeface.axes, text.weight, plan);
        holdLabelFont(this._date, size => labelFont(typeface, {...text, weight, extra}, size));
        this._date.style = plan ? `text-shadow: ${plan.shadow ? shadowStyle(plan.shadow) : 'none'};` : null;
    }

    // The line of a text as it is drawn, at a stretch and a level.
    _line(text, stretch, level) {
        const {font, scaleX} = this._font;
        return placeLine(font, text, {
            size: this._metrics.fontSize, scaleX, width: this._size[0], stretch, level, kept: this._outlines,
        });
    }

    // The size the digits fit the box at – as wide as it is, and in a box
    // too flat for them, as tall as the room under the date line – and how
    // high they are then.
    _measure(width, room) {
        this._metrics = null;
        const font = this._font;
        if (!font || width <= 0)
            return;
        const tall = Math.max(1, room.bottom - room.top);
        if (font.font) {
            this._metrics = fitFigures(font.font, font.scaleX, width, room).metrics;
        } else {
            if (!this._digits.get_stage())
                return;
            const layout = this._digits.create_pango_layout(SAMPLE);
            this._pangoLayout(layout, SAMPLE, 100);
            const [, logical] = layout.get_pixel_extents();
            let fontSize = Math.max(8, Math.floor(100 * width * FILL / (Math.max(1, logical.width) * font.scaleX)));
            this._pangoLayout(layout, SAMPLE, fontSize);
            let [ink, wide] = layout.get_pixel_extents();
            if (ink.height > tall) {
                fontSize = Math.max(8, Math.floor(fontSize * tall / ink.height));
                this._pangoLayout(layout, SAMPLE, fontSize);
                [ink, wide] = layout.get_pixel_extents();
            }
            this._metrics = {fontSize, inkY: ink.y, inkHeight: Math.max(1, ink.height), width: wide.width * font.scaleX};
        }
        this.onMeasured?.();
    }

    // Under the date line, to the bottom of the box: the digits fill it
    // (where it is placed is where they are; placed over a hill, they go
    // down behind it, and the board lets the hill stand in front only
    // while they read).
    _room() {
        const [, dateHeight] = this._date.get_preferred_height(-1);
        return {top: dateHeight + DATE_GAP * scaleFactor(), bottom: this._size[1]};
    }

    // Where the digits go, for the room there is.
    _retarget(room) {
        if (!this._metrics)
            return;
        const target = glassDigits(this._metrics.inkHeight, room.top, room.bottom);
        if (this._target && Math.abs(this._target.stretch - target.stretch) < 0.005 &&
            Math.abs(this._target.y - target.y) < 0.5)
            return;
        this._target = target;
        // (As it is laid out: not laid out anew for it.)
        this._stretch = target.stretch;
        this._level = target.y;
        this._repaint();
    }

    /** @returns {object|null} {x, y, width, height} of the digits where they go, in the face */
    get digitsRect() {
        if (!this._metrics || !this._target)
            return null;
        const width = this._metrics.width;
        return {x: (this._size[0] - width) / 2, y: this._target.y, width,
            height: this._metrics.inkHeight * this._target.stretch};
    }

    /**
     * @returns {object[]|null} each digit's ink, {x, y, width, height} in
     *   the face, where it stands (target), the colon left out; null until
     *   measured
     */
    get glyphBoxes() {
        if (!this._metrics || !this._target || !this._text)
            return null;
        const {stretch, y} = this._target;
        const boxes = this._font.font
            ? this._line(this._text, stretch, y).filter(g => g.box).map(g => ({char: g.char, ...g.box}))
            : this._pangoBoxes(this._digits.create_pango_layout(this._text), stretch, y);
        return boxes.filter(box => box.char !== ':').map(({x, y: top, width, height}) => ({x, y: top, width, height}));
    }

    vfunc_allocate(box) {
        this._allocating = true;
        try {
            this._allocate(box);
        } finally {
            this._allocating = false;
        }
    }

    _allocate(box) {
        this.set_allocation(box);
        const [width, height] = [box.get_width(), box.get_height()];
        const resized = width !== this._size[0] || height !== this._size[1];
        this._size = [width, height];
        // (First: styled anew, it may take another font.)
        this._digits.ensure_style();
        // (Measured anew for another box, or another date line over them:
        // in a box too flat for them, the room they have is what sizes them.)
        const room = this._room();
        const measuring = !this._metrics || resized || room.top !== this._roomTop;
        this._roomTop = room.top;
        if (measuring) {
            this._measure(width, room);
            this._target = null;
        }
        this._retarget(room);
        const whole = new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: height});
        this._digits.allocate(whole);
        // (The wallpaper behind it where the face is now.)
        this._glass.setPlace(this._onMonitor());
        this._glass.allocate(whole);
        if (this._dirty || measuring) {
            this._dirty = false;
            this._sync();
        }
        // The date line just over the digits, in the middle (unless it is
        // held elsewhere, in front of the subject).
        if (this._date.get_parent() === this) {
            const {x, y, width: w, height: h} = this.dateRect;
            this._date.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h}));
        }
    }

    // The tone of the type: as planned, or as the digits' style has it.
    _tone() {
        const planned = this._plan?.tone;
        if (planned?.color)
            return {color: planned.color, dark: Boolean(planned.dark)};
        const c = this._digits.get_theme_node().get_foreground_color();
        const color = `#${[c.red, c.green, c.blue].map(v => v.toString(16).padStart(2, '0')).join('')}`;
        return {color, dark: luminance(color) < DARK};
    }

    // Where the face is on the main monitor (where the wallpaper lies behind it).
    _onMonitor() {
        const [x, y] = this.get_transformed_position();
        const monitor = Main.layoutManager.primaryMonitor;
        return [x - (monitor?.x ?? 0), y - (monitor?.y ?? 0)];
    }

    // How the digits look and where they are, as all is now: their glass
    // and tone, the figures they are drawn from (made, or to be made), and
    // each figure's place.
    _sync() {
        const tone = this._tone();
        const digits = this._plan?.digits;
        const scale = scaleFactor();
        const halo = digits?.shadow?.alpha > 0 ? digits.shadow : null;
        const white = halo && luminance(halo.color) > 0.5;
        this._glass.setLook({
            variant: this._variant,
            light: !tone.dark,
            scale,
            tone: hexToRgb(tone.color).map(v => v / 255),
            wash: glassFor(digits?.glass ?? null).wash,
            halo: halo && {
                y: (halo.y ?? 0) * scale,
                sigma: Math.max(1, halo.blur ?? 12) / 2 * scale,
                alpha: Math.min(1, halo.alpha * (white ? GLOW : 1)),
                color: hexToRgb(halo.color).map(v => v / 255),
            },
        });
        this._syncAtlas();
        this._syncSlots();
    }

    // The figures' atlas for the digits as they are drawn now: the one made
    // for them, else made now – not while the clock is stretched: until it
    // rests, the one there is serves, laid over the digits as they go.
    _syncAtlas() {
        const spec = this._atlasSpec();
        this._specKey = spec?.key ?? null;
        if (!spec) {
            this._stopMaking();
            this._glass.setAtlas(null);
            return;
        }
        const atlas = atlasOf(spec.key);
        if (atlas) {
            this._stopMaking();
            this._useAtlas(atlas);
            return;
        }
        if (this._glass.atlas?.from !== spec.from)
            this._glass.setAtlas(null);
        if (this._stretching || this._making?.key === spec.key)
            return;
        this._stopMaking();
        const making = {key: spec.key, release: null};
        this._making = making;
        making.release = makeAtlas(spec, {
            onTile: () => this.sdfBuilds++,
            onReady: made => {
                if (this._making !== making)
                    return;
                this._making = null;
                this._useAtlas(made);
                this._syncSlots();
            },
        });
    }

    _useAtlas(atlas) {
        this._glass.setAtlas(atlas);
        // (Where it was laid out at this size: for the session to make the
        // lock screen's figures ahead of it.)
        if (this._font?.font && !this._stretching) {
            const room = this._room();
            recordGeometry(this.clockId, {
                width: this._size[0], top: room.top, bottom: room.bottom, density: this._density(),
                plan: this._plan?.digits ? {weight: this._plan.digits.weight, boldness: this._plan.digits.boldness} : null,
            });
        }
    }

    _stopMaking() {
        this._making?.release?.();
        this._making = null;
    }

    _density() {
        return textureDensity(this._glass);
    }

    // What the atlas of the digits as they are now is made of.
    _atlasSpec() {
        if (!this._metrics || !this._target || !this._font || !this._text)
            return null;
        const density = this._density();
        if (this._font.font) {
            return figureAtlasSpec(this._font, {
                fontSize: this._metrics.fontSize, stretch: this._stretch, density, text: this._text,
            });
        }
        // (As Pango draws the line: all of it one tile.)
        const layout = this._digits.create_pango_layout(this._text);
        const bounds = boxRound(this._pangoBoxes(layout, this._stretch, this._level));
        if (!bounds)
            return null;
        const font = this._pangoFont(this._metrics.fontSize).to_string();
        return {
            key: ['pango', font, this._text, this._font.scaleX, this._stretch.toFixed(4), this._level, this._size[0],
                density].join('\n'),
            from: `pango:${font}`,
            parts: [{id: 'line', make: () => pangoSdf(cr => this._pangoPath(cr, layout), bounds, density)}],
        };
    }

    // Each figure where it is now: those that stay, and while the minute
    // turns, those that go and come, where they have got to – given the
    // GPU, nothing else drawn anew.
    _syncSlots() {
        const atlas = this._glass.atlas;
        if (!atlas || !this._metrics || !this._target || !this._font || !this._text) {
            this._glass.setSlots([]);
            return;
        }
        const density = this._density();
        const exact = atlas.key === this._specKey;
        const slot = (id, at, ink, dy, alpha) => {
            const tile = atlas.tiles.get(id);
            if (!tile)
                return null;
            const {box, scale} = exact || !ink ? slotPlace(tile.tile, at, density) : mappedPlace(tile.tile, ink, density);
            return {box, uv: tile.uv, dy, alpha, scale, thick: tile.thick * scale};
        };
        let slots;
        let clipTop = 0;
        if (this._font.font) {
            const line = this._line(this._text, this._stretch, this._level);
            const turning = this._turning;
            const staying = turning ? line.filter(g => !turning.coming.includes(g.index)) : line;
            slots = staying.map(g => slot(g.glyph, [g.x, g.y], g.box, 0, 1));
            const bounds = boxRound(line.map(g => g.box));
            if (turning && bounds) {
                const was = this._line(turning.before, this._stretch, this._level);
                const {leaving, coming} = changeAt(this._change);
                const travel = CHANGE.travel * bounds.height;
                clipTop = bounds.y - 1;
                slots.push(
                    ...was.filter(g => turning.leaving.includes(g.index))
                        .map(g => slot(g.glyph, [g.x, g.y], g.box, leaving.dy * travel, leaving.alpha)),
                    ...line.filter(g => turning.coming.includes(g.index))
                        .map(g => slot(g.glyph, [g.x, g.y], g.box, coming.dy * travel, coming.alpha)));
            }
        } else {
            const bounds = boxRound(this._pangoBoxes(this._digits.create_pango_layout(this._text), this._stretch,
                this._level));
            slots = [slot('line', [0, 0], bounds, 0, 1)];
        }
        slots = slots.filter(Boolean);
        this._glass.setSlots(slots, {clipTop, reach: slotReach(1 / density)});
    }

    // Where the font has no file to draw from, Pango draws the digits,
    // stretched as a whole (taller and the strokes across thicker, its "0"
    // an ellipse): they change at once.

    _pangoFont(size) {
        const {typeface, style} = this._type;
        const font = this._digits.get_theme_node().get_font().copy();
        const {families, weight, variations} = labelFont(typeface,
            {...style, weight: this._font.weight, extra: this._font.extra}, null);
        if (families.length > 0)
            font.set_family(families.join(','));
        font.set_weight(weight);
        font.set_variations(variations);
        font.set_absolute_size(size * Pango.SCALE);
        return font;
    }

    _pangoLayout(layout, text, size) {
        layout.set_font_description(this._pangoFont(size));
        // (Digits all as wide: the time doesn't wobble as it goes.)
        const features = new Pango.AttrList();
        features.insert(Pango.attr_font_features_new('tnum'));
        layout.set_attributes(features);
        layout.set_text(text, -1);
    }

    // Each character's box, as Pango lays it out: across, its logical
    // width; up and down, the digits'.
    _pangoBoxes(layout, stretch, level) {
        this._pangoLayout(layout, this._text, this._metrics.fontSize);
        const [ink] = layout.get_pixel_extents();
        const scaleX = this._font.scaleX;
        const left = this._size[0] / 2 - (ink.x + ink.width / 2) * scaleX;
        const height = this._metrics.inkHeight * stretch;
        const encoder = new TextEncoder();
        let index = 0;
        return [...this._text].map(char => {
            const pos = layout.index_to_pos(index);
            index += encoder.encode(char).length;
            return {char, x: left + pos.x / Pango.SCALE * scaleX, y: level, width: pos.width / Pango.SCALE * scaleX, height};
        });
    }

    // The line's outline, as Pango draws it, added to a Cairo path in the
    // face's pixels.
    _pangoPath(cr, layout) {
        this._pangoLayout(layout, this._text, this._metrics.fontSize);
        const [ink] = layout.get_pixel_extents();
        const scaleX = this._font.scaleX;
        const pangoLayout = PangoCairo.create_layout(cr);
        this._pangoLayout(pangoLayout, this._text, this._metrics.fontSize);
        cr.save();
        cr.translate(this._size[0] / 2 - (ink.x + ink.width / 2) * scaleX, this._level - this._metrics.inkY * this._stretch);
        cr.scale(scaleX, this._stretch);
        PangoCairo.layout_path(cr, pangoLayout);
        cr.restore();
    }
});

export const LockClockWidget = GObject.registerClass(
class AtelierLockClockWidget extends ClockWidget {
    buildFace(design, box, size) {
        if (design !== 'glass')
            return null;
        // (What its glass face is told, kept for one built anew: for another size.)
        this._glassKept ??= {};
        const face = new GlassFace(size, this._glassKept);
        face.clockId = this.entry?.id ?? null;
        face.onMeasured = () => this._context.depthChanged?.(this);
        // (Stretched in the editor: the figures it has laid over the digits till it is let go of.)
        face.stretching = this.stretching;
        box.add_child(face);
        // (Moved – dragged in the editor –, the glass shows what is behind it there.)
        this.connectObject(
            'notify::allocation', () => face.followMove(),
            'notify::stretching', () => (face.stretching = this.stretching),
            face);
        return face;
    }

    // A glass face serves for any size as it is, told of it (for its
    // digits' optical size): not built anew as a stretched clock takes its
    // size.
    fitContent(size) {
        if (!this._ownFace || this.entry.face !== 'glass')
            return false;
        this._ownFace.setSize(size);
        return true;
    }

    /** @returns {GlassFace|null} its glass face, when it has it */
    get glass() {
        return this._ownFace ?? null;
    }

    // (On the lock screen, as bright as the hours: one tone for all of it.)
    get minutesOpacity() {
        return 255;
    }
});

// The font families there are, listed once (fonts installed meanwhile are
// there next time the shell starts).
let families = null;

function installedFamilies() {
    if (!families) {
        try {
            families = PangoCairo.FontMap.get_default().list_families().map(family => family.get_name());
        } catch {
            families = [];
        }
    }
    return families.length > 0 ? families : null;
}

// The lock screen's settings the glass clocks' digits follow.
const DIGITS_KEYS = ['enabled', 'widgets', 'clock-font', 'clock-weight', 'clock-width'];

/**
 * Ready in the session, while it is idle, what the lock screen's glass
 * clocks take to draw: how their figures stretch in the instance they are
 * drawn in (kept in this process), the figures themselves – each clock's
 * atlas (figureAtlas.js), for the size its face was last laid out at, in
 * the instance the settings have now – and the wallpaper as the glass blurs
 * it, small, for what the digits take to read (liquidGlass.js, kept in the
 * cache). Only while the lock screen has a glass clock; anew as its font,
 * the glass, the wallpaper or where a clock is laid out changes.
 */
export class GlassWarmUp {
    /**
     * @param {Gio.Settings} settings - the lockscreen ones
     * @param {Gio.Settings} [atelier] - Atelier's own (the glass variant)
     */
    constructor(settings, atelier = null) {
        this._settings = settings;
        this._idle = 0;
        this._backdropIdle = 0;
        this._atlases = [];
        this._gone = false;
        this._variant = new GlassVariant(atelier, () => this._queueBackdrop());
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        settings.connectObject('changed', (_, key) => {
            if (DIGITS_KEYS.includes(key)) {
                this._queueFigures();
                this._queueBackdrop();
            }
        }, this);
        this._background.connectObject('changed', () => this._queueBackdrop(), this);
        this._interface.connectObject('changed::color-scheme', () => this._queueBackdrop(), this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._queueFigures();
            this._queueBackdrop();
        }, this);
        clockGeometries.connectObject('changed', () => this._queueFigures(), this);
        this._queueFigures();
        this._queueBackdrop();
    }

    // The glass clocks on the lock screen, when it is Atelier's.
    _clocks() {
        if (!this._settings.get_boolean('enabled'))
            return [];
        return parseLayout(this._settings.get_string('widgets'), LOCK_KINDS)
            .filter(entry => entry.kind === 'clock' && entry.face === 'glass');
    }

    // The instances the clocks draw in (as their faces work them out), a
    // figure at a time; then each clock's figures, where it is known how
    // large its face is laid out.
    _queueFigures() {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        const typeface = typefaceFor(this._settings.get_string('clock-font'), installedFamilies());
        const style = styleFor(typeface, 'glass', {
            weight: this._settings.get_int('clock-weight'), width: this._settings.get_int('clock-width'),
        });
        const family = shellFamily();
        const clocks = this._clocks().map(entry => {
            const geometry = clockGeometry(entry.id);
            return {
                geometry,
                wanted: glassInstance(typeface, style, {size: entry.size, plan: geometry?.plan ?? null, shellFamily: family}),
            };
        }).filter(clock => clock.wanted.font);
        if (clocks.length === 0)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            for (const {wanted: {font}} of clocks) {
                const [glyph] = unlearnt(font);
                if (glyph !== undefined) {
                    learn(font, glyph);
                    return GLib.SOURCE_CONTINUE;
                }
            }
            this._idle = 0;
            this._makeAtlases(clocks);
            return GLib.SOURCE_REMOVE;
        });
    }

    // Each clock's figures, as its face will lay them out (fitFigures(),
    // figureAtlasSpec()): made while the shell is idle, kept in this
    // process for the lock screen.
    _makeAtlases(clocks) {
        const before = this._atlases;
        this._atlases = clocks.filter(clock => clock.geometry).map(({geometry, wanted}) => {
            const {width, top, bottom, density} = geometry;
            const {metrics, target} = fitFigures(wanted.font, wanted.scaleX, width, {top, bottom});
            return makeAtlas(figureAtlasSpec(wanted, {fontSize: metrics.fontSize, stretch: target.stretch, density}));
        });
        // (Let go of only now: an atlas wanted still goes on being made.)
        before.forEach(release => release());
    }

    // The wallpaper of the main monitor as the glass there blurs it, small,
    // once things settle (a wallpaper changes several settings at once).
    _queueBackdrop() {
        if (this._backdropIdle)
            GLib.source_remove(this._backdropIdle);
        this._backdropIdle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._backdropIdle = 0;
            const monitor = Main.layoutManager.primaryMonitor;
            const look = lookOf(this._variant.variant);
            if (!monitor || !look || this._clocks().length === 0)
                return GLib.SOURCE_REMOVE;
            prepareLockBackdrop({
                background: this._background,
                iface: this._interface,
                monitor: [monitor.width, monitor.height],
                scale: scaleFactor(),
                look,
            }).catch(e => !this._gone && console.warn(`Atelier: the glass clock's wallpaper sample isn't ready: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        this._gone = true;
        for (const id of [this._idle, this._backdropIdle]) {
            if (id)
                GLib.source_remove(id);
        }
        this._idle = this._backdropIdle = 0;
        this._atlases.forEach(release => release());
        this._atlases = [];
        this._variant.destroy();
        this._settings.disconnectObject(this);
        this._background.disconnectObject(this);
        this._interface.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        clockGeometries.disconnectObject(this);
    }
}
