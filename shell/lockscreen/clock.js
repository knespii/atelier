// The lock screen's clock: the desktop's (shell/desktop/kinds/time.js), its
// stacked minutes as bright as its hours, and a face of its own – glass:
// the time in one line of tall digits of Liquid Glass (liquidGlass.js), the
// wallpaper showing through, under a small date line, as an iPhone's. The
// digits are the font's own outlines (lib/glyphOutlines.js), in the
// typeface, weight and width the settings give and as heavy as reading
// them takes (lib/lockLook.js legibilityPlan()), and they grow tall as a
// tall typeface draws them: their stems and the sides of their bowls
// longer, their bars, the turns of their curves and their dots as they are
// (lib/glyphStretch.js). They fill the clock's box, as the editor
// stretches it (to any size, cell by cell): as large as it is wide, from
// under the date line down to its bottom – whatever of the wallpaper's
// subject stands in front of them there (see board.js); in a box too flat
// for them, as tall as it is. As the minute turns, the figures that change
// – only they – go: the old one lifting as it fades, the new one rising
// into its place (lib/glassClock.js), drawn on a layer of their own while
// they move. Nothing is drawn while it rests. Stretched in the editor, its
// glass is drawn quickly as it goes, a frame at a time (liquidGlass.js
// sketch(): its frost and tint, the light along its edges), and in full
// once let go of – or once held still a moment, where that is quick too.
//
// (St draws a drawing area the moment it is told to – queue_repaint() – and
// whenever it is laid out at another size: the face draws its layers as it
// is laid out, once a frame however often it is asked, and nothing it does
// while one is being drawn may lay it out, or St would throw away what it
// draws into.)

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    CHANGE, FIGURES, FILL, SAMPLE, boxRound, changeAt, changedFigures, fitSize, glassInstance, heavier, learn,
    placeLine, setLine, traceLine, unlearnt,
} from '../../lib/glassClock.js';
import {glassFor, tintShown} from '../../lib/glassBackdrop.js';
import {glassDigits} from '../../lib/lockLook.js';
import {labelFont, styleFor, typefaceFor} from '../../lib/lockType.js';
import {hexToRgb, luminance} from '../../lib/palette.js';
import {LOCK_KINDS, parseLayout, splitClock} from '../../lib/widgets.js';
import {holdLabelFont} from '../core/fonts.js';
import {ClockWidget} from '../desktop/kinds/time.js';
import {label} from '../desktop/widget.js';
import {LiquidGlass, prepareLockBackdrop} from './liquidGlass.js';

const DATE_GAP = 2; // between the date line and the digits, logical pixels
// Type this light (WCAG luminance) or darker is dark type, as
// lib/lockLook.js chosenTone() tells it: dark glass.
const DARK = 0.18;
// What the glass draws round the digits besides them – its rim and the
// light on its edges – without a shadow, logical pixels.
const RIM_REACH = 6;
// Stretched and held still this long (ms), the digits are drawn in full –
// where that takes no longer than this (ms): the pointer may move on
// meanwhile, and a frame drawn in full must not hold it up.
const REST_TIME = 250;
const QUICK_ENOUGH = 8;

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

// A layer of the digits: all of them, or – over them, while the minute
// turns – the figures that change. The face draws it.
const Layer = GObject.registerClass(
class AtelierGlassDigits extends St.DrawingArea {
    _init(face, params) {
        super._init(params);
        this._face = face;
        /** How many times it has been drawn. */
        this.repaints = 0;
    }

    vfunc_repaint() {
        this.repaints++;
        const cr = this.get_context();
        try {
            this._face.paintLayer(this, cr);
        } finally {
            cr.$dispose();
        }
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
     *   {type, plan, backdrop}
     */
    _init(size = 'large', kept = {}) {
        super._init({style_class: 'atelier-widget-glass', x_expand: true, y_expand: true});
        this._sizeName = size;
        this._kept = kept;
        this._digits = new Layer(this, {style_class: 'atelier-widget-glass-digits'});
        this._moving = new Layer(this, {visible: false});
        this._date = label('atelier-widget-glass-date');
        this.add_child(this._digits);
        this.add_child(this._moving);
        this.add_child(this._date);
        this._glass = new LiquidGlass();
        this._movingGlass = new LiquidGlass();
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
        this._paintedAt = null;
        this._dirty = false;
        this._allocating = false;
        this._stretching = false;
        this._sketched = false;
        this._rested = false;
        this._restId = 0;
        this._settleId = 0;
        // (How long drawing the digits in full last took, ms a pixel of the drawing's.)
        this._fullCost = null;
        /** How many figures it has worked out itself (none, when the session did ahead of it). */
        this.workedOut = 0;
        this._type = kept.type ?? defaultType();
        this._plan = kept.plan ?? null;
        /** Called when the digits are measured anew (the depth effect follows them). */
        this.onMeasured = null;
        // (Another colour, or another font for Pango to find.)
        this._digits.connect('style-changed', () => {
            this._syncFont();
            this._repaint();
        });
        // (Out of sight, a change of the figures ends where it was going.)
        this.connect('notify::mapped', () => !this.mapped && this._settle());
        this.connect('destroy', () => {
            this._stopLearning();
            this._stopRest();
            this._stopSettling();
        });
        this.backdrop = kept.backdrop ?? null;
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
        // (A frame of the change: only the layer of the figures that change.)
        if (this._turning)
            this._moving.queue_repaint();
    }

    /** @returns {boolean} whether its clock is being stretched (its glass drawn quickly meanwhile) */
    get stretching() {
        return this._stretching;
    }

    /**
     * @param {boolean} stretching - its clock's corner dragged in the editor,
     *   or easing to its size once let go of: the glass drawn quickly as it
     *   goes; let go of, drawn in full (if it was drawn otherwise) – once
     *   the frame it was let go of in is done, in the next, as what it takes
     *   to read there is worked out anew in that frame (board.js): drawn in
     *   full only as that has it
     */
    set stretching(stretching) {
        this._stopRest();
        this._stopSettling();
        if (stretching) {
            this._stretching = true;
            this._rested = false;
            return;
        }
        if (!this._stretching)
            return;
        this._settleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._settleId = 0;
            this._stretching = false;
            this._rested = false;
            if (this._sketched)
                this._repaint();
            this._sketched = false;
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopSettling() {
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
    }

    // Drawn quickly while stretched: held still a moment, in full – where
    // that is quick enough (as long as it last took, for as many pixels).
    _waitForRest(pixels) {
        this._stopRest();
        this._restId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REST_TIME, () => {
            this._restId = 0;
            if (this._stretching && (this._fullCost ?? Infinity) * pixels <= QUICK_ENOUGH && this._digits.mapped) {
                this._rested = true;
                this._digits.queue_repaint();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopRest() {
        if (this._restId)
            GLib.source_remove(this._restId);
        this._restId = 0;
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
     * is planned, and the glass more opaque (lib/glassBackdrop.js
     * glassFor()).
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

    /** @returns {object|null} the frosted wallpaper behind the glass */
    get backdrop() {
        return this._glass.backdrop;
    }

    /**
     * @param {object|null} backdrop - liquidGlass.js GlassBackdrop's
     *   current, the frosted wallpaper the glass shows; null: tinted only
     */
    set backdrop(backdrop) {
        this._glass.backdrop = backdrop;
        this._movingGlass.backdrop = backdrop;
        this._kept.backdrop = backdrop;
        this._repaint();
    }

    /** @returns {object|null} {fontSize, inkY, inkHeight, width} of the digits as they are, pixels */
    get metrics() {
        return this._metrics;
    }

    /**
     * @returns {object|null} what a legibility plan of the digits takes
     *   (lib/lockLook.js legibilityPlan()): {size: their size before they
     *   stretch, CSS pixels; weight: their own, before any plan; tintAlpha:
     *   how much of the glass's tint shows where least, at rest – the
     *   plan's `glass` (lib/glassBackdrop.js tintShown())}; null until
     *   measured
     */
    get digitsMetrics() {
        if (!this._metrics)
            return null;
        return {size: this._metrics.fontSize / scaleFactor(), weight: this._type.style.weight, tintAlpha: tintShown()};
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

    // Draw the layers anew as the face is laid out next: once, however
    // often it is asked before.
    _repaint() {
        this._dirty = true;
        if (!this._allocating)
            this.queue_relayout();
    }

    /** The clock moved (dragged in the editor): its glass shows what is behind it there. */
    followMove() {
        const at = this._paintedAt;
        const now = this._onMonitor(this._digits);
        if (at && now[0] === at[0] && now[1] === at[1])
            return;
        // (As the clock is laid out: at once.)
        this._digits.queue_repaint();
        if (this._turning)
            this._moving.queue_repaint();
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
    // nor out of sight (nor with GNOME's animations off: at once).
    _turn(before) {
        this._settle();
        const {leaving, coming} = changedFigures(before, this._text);
        const box = this.mapped && adjustAnimationTime(CHANGE.time) > 0 ? this._turningBox(before, leaving, coming) : null;
        if (!box) {
            this._repaint();
            return;
        }
        const turning = {before, leaving, coming, box};
        this._turning = turning;
        this._change = 0;
        this.notify('change');
        this._moving.visible = true;
        // (The layer of the figures that change laid over their columns,
        // the rest drawn without them.)
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

    // A change of the figures under way ends where it was going: all of
    // them on one layer again.
    _settle() {
        if (!this._turning)
            return;
        this._turning = null;
        this.remove_transition('change');
        this._change = 1;
        this.notify('change');
        this._moving.visible = false;
        this._repaint();
    }

    // Where the figures that change go, across (and as far round them as
    // the glass draws), on whole pixels of the drawing's; null for none.
    _turningBox(before, leaving, coming) {
        if (!this._metrics || !this._font?.font || leaving.length + coming.length === 0)
            return null;
        const was = this._line(before, this._stretch, this._level).filter(g => leaving.includes(g.index));
        const now = this._line(this._text, this._stretch, this._level).filter(g => coming.includes(g.index));
        const ink = boxRound([...was, ...now].map(g => g.box));
        if (!ink)
            return null;
        const shadow = this._material().shadow;
        const reach = (shadow?.alpha > 0 ? 2.5 * (shadow.blur ?? 12) + Math.abs(shadow.y ?? 0) : RIM_REACH) * scaleFactor();
        const density = this.get_resource_scale();
        return {
            x1: Math.max(0, Math.floor((ink.x - reach) * density) / density),
            x2: Math.min(this._size[0], Math.ceil((ink.x + ink.width + reach) * density) / density),
        };
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
            const size = fitSize(font.font, width, font.scaleX, tall);
            const k = size / font.font.upem;
            const {top, bottom} = font.font.figures;
            const {advance} = setLine(font.font, SAMPLE);
            this._metrics = {fontSize: size, inkY: 0, inkHeight: Math.max(1, (top - bottom) * k), width: advance * k * font.scaleX};
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
        // (Stretched to another size: drawn quickly again, till it rests.)
        if (resized)
            this._rested = false;
        // The layer of the figures that change over their columns while
        // they do (where they are now, measured anew).
        const turning = this._turning;
        if (measuring && turning)
            turning.box = this._turningBox(turning.before, turning.leaving, turning.coming) ?? turning.box;
        // The layers laid out – St draws one the moment it is laid out at
        // another size, as it is to be now – and drawn anew once, if
        // anything changed and St hasn't.
        const drawn = [this._digits.repaints, this._moving.repaints];
        this._digits.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: height}));
        const columns = turning?.box;
        this._moving.allocate(columns ? new Clutter.ActorBox({x1: columns.x1, y1: 0, x2: columns.x2, y2: height})
            : new Clutter.ActorBox());
        if (this._dirty) {
            this._dirty = false;
            if (this._digits.repaints === drawn[0])
                this._digits.queue_repaint();
            if (turning && this._moving.repaints === drawn[1])
                this._moving.queue_repaint();
        }
        // The date line just over the digits, in the middle (unless it is
        // held elsewhere, in front of the subject).
        if (this._date.get_parent() === this) {
            const {x, y, width: w, height: h} = this.dateRect;
            this._date.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + h}));
        }
    }

    // The tone of the type the glass is tinted with: as planned, or as the
    // digits' style has it.
    _tone() {
        const planned = this._plan?.tone;
        if (planned?.color)
            return {color: planned.color, dark: Boolean(planned.dark)};
        const c = this._digits.get_theme_node().get_foreground_color();
        const color = `#${[c.red, c.green, c.blue].map(v => v.toString(16).padStart(2, '0')).join('')}`;
        return {color, dark: luminance(color) < DARK};
    }

    // The glass as the digits' plan has it: as opaque, with as much tint,
    // and a shadow only if planned.
    _material() {
        const digits = this._plan?.digits;
        return {...glassFor(digits?.glass ?? null), shadow: digits?.shadow ?? 0};
    }

    // Where a layer's drawing starts on the main monitor (where the
    // backdrop lies behind it).
    _onMonitor(layer) {
        const [x, y] = layer.get_transformed_position();
        const monitor = Main.layoutManager.primaryMonitor;
        return [x - (monitor?.x ?? 0), y - (monitor?.y ?? 0)];
    }

    /**
     * Draw a layer: the digits that stay where they are, or (while the
     * minute turns) the figures that change, where they have got to.
     *
     * @param {St.DrawingArea} layer
     * @param {Cairo.Context} cr - its, the matrix the identity
     */
    paintLayer(layer, cr) {
        if (!this._metrics || !this._text || !this._font)
            return;
        const look = {tone: this._tone(), at: this._onMonitor(layer), scale: scaleFactor(), ...this._material()};
        if (layer === this._digits) {
            this._paintedAt = look.at;
            const since = GLib.get_monotonic_time();
            const quick = this._stretching && !this._rested;
            if (this._font.font)
                this._paintDigits(cr, {...look, quick});
            else
                this._paintPango(cr, {...look, quick});
            // (Drawn quickly: in full once it rests a moment. In full: how
            // long that takes, for so many of the drawing's pixels.)
            const target = cr.getTarget();
            const pixels = Math.max(1, target.getWidth() * target.getHeight());
            if (quick) {
                this._sketched = true;
                this._waitForRest(pixels);
            } else {
                this._fullCost = (GLib.get_monotonic_time() - since) / 1000 / pixels;
            }
            return;
        }
        if (!this._font.font)
            return;
        const line = this._line(this._text, this._stretch, this._level);
        const bounds = boxRound(line.map(g => g.box));
        if (!bounds)
            return;
        const turning = this._turning;
        if (!turning)
            return;
        // The figures that change, in the layer's own place: the old ones
        // lifting as they fade, the new ones rising into place – never
        // above the digits' top (the date line is there). (Where the layer
        // is as it was laid out: asked of the layer while it is drawn, a
        // layout pending would be done then and there, and its drawing
        // thrown away under it.)
        const {x1, x2} = turning.box;
        const was = this._line(turning.before, this._stretch, this._level);
        const {leaving, coming} = changeAt(this._change);
        const travel = CHANGE.travel * bounds.height;
        const top = bounds.y - 1;
        cr.rectangle(0, top, x2 - x1, this._size[1] - top);
        cr.clip();
        const moving = [
            [was.filter(g => turning.leaving.includes(g.index)), leaving],
            [line.filter(g => turning.coming.includes(g.index)), coming],
        ];
        for (const [glyphs, {dy, alpha}] of moving) {
            if (!(alpha > 0.004) || glyphs.length === 0)
                continue;
            const offset = dy * travel;
            cr.pushGroup();
            this._paintGlyphs(cr, this._movingGlass, glyphs, {
                ...look,
                bounds: {...bounds, x: bounds.x - x1},
                glyphBoxes: glyphs.map(g => g.box).filter(Boolean).map(b => ({...b, x: b.x - x1, y: b.y + offset})),
                dx: -x1,
                dy: offset,
            });
            cr.popGroupToSource();
            cr.paintWithAlpha(alpha);
        }
    }

    // The digits that stay where they are (all of them, unless the minute
    // turns), from the font's outlines.
    _paintDigits(cr, look) {
        const line = this._line(this._text, this._stretch, this._level);
        const bounds = boxRound(line.map(g => g.box));
        if (!bounds)
            return;
        const turning = this._turning;
        const staying = turning ? line.filter(g => !turning.coming.includes(g.index)) : line;
        this._paintGlyphs(cr, this._glass, staying, {...look, bounds, glyphBoxes: line.map(g => g.box).filter(Boolean)});
    }

    // Glyphs in glass: their outlines, one path, the material over it (or,
    // quick, a sketch of it).
    _paintGlyphs(cr, glass, glyphs, {
        bounds, glyphBoxes, tone, at, scale, tintAlpha, opacity, shadow, dx = 0, dy = 0, quick = false,
    }) {
        if (glyphs.length === 0)
            return;
        const {font, scaleX} = this._font;
        cr.newPath();
        traceLine(cr, glyphs, {scale: this._metrics.fontSize / font.upem, scaleX, dx, dy});
        const path = cr.copyPath();
        cr.newPath();
        if (quick)
            glass.sketch(cr, path, {bounds, tone, at, scale, tintAlpha, opacity});
        else
            glass.paint(cr, path, {bounds, glyphBoxes, tone, at, scale, tintAlpha, opacity, shadow});
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

    _paintPango(cr, {tone, at, scale, tintAlpha, opacity, shadow, quick}) {
        const layout = PangoCairo.create_layout(cr);
        const boxes = this._pangoBoxes(layout, this._stretch, this._level);
        const [ink] = layout.get_pixel_extents();
        const scaleX = this._font.scaleX;
        const {stretch, level} = this;
        cr.save();
        cr.translate(this._size[0] / 2 - (ink.x + ink.width / 2) * scaleX, level - this._metrics.inkY * stretch);
        cr.scale(scaleX, stretch);
        PangoCairo.layout_path(cr, layout);
        cr.restore();
        const path = cr.copyPath();
        cr.newPath();
        const bounds = boxRound(boxes);
        if (quick)
            this._glass.sketch(cr, path, {bounds, tone, at, scale, tintAlpha, opacity});
        else
            this._glass.paint(cr, path, {bounds, glyphBoxes: boxes, tone, at, scale, tintAlpha, opacity, shadow});
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
        face.onMeasured = () => this._context.depthChanged?.(this);
        // (Stretched in the editor: drawn quickly till it is let go of.)
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
 * drawn in (the slow part, kept in this process: on the lock screen the
 * first paint then costs no more than any other), and the frosted
 * wallpaper their glass shows (liquidGlass.js, kept in the cache). Only
 * while the lock screen has a glass clock; anew as its font or the
 * wallpaper changes.
 */
export class GlassWarmUp {
    /** @param {Gio.Settings} settings - the lockscreen ones */
    constructor(settings) {
        this._settings = settings;
        this._idle = 0;
        this._backdropIdle = 0;
        this._gone = false;
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
        Main.layoutManager.connectObject('monitors-changed', () => this._queueBackdrop(), this);
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
    // figure at a time.
    _queueFigures() {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        const typeface = typefaceFor(this._settings.get_string('clock-font'), installedFamilies());
        const style = styleFor(typeface, 'glass', {
            weight: this._settings.get_int('clock-weight'), width: this._settings.get_int('clock-width'),
        });
        const family = shellFamily();
        const fonts = [...new Set(this._clocks().map(entry =>
            glassInstance(typeface, style, {size: entry.size, shellFamily: family}).font))]
            .filter(Boolean);
        if (fonts.length === 0)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            for (const font of fonts) {
                const [glyph] = unlearnt(font);
                if (glyph !== undefined) {
                    learn(font, glyph);
                    return GLib.SOURCE_CONTINUE;
                }
            }
            this._idle = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    // The frosted wallpaper of the main monitor, once things settle (a
    // wallpaper changes several settings at once).
    _queueBackdrop() {
        if (this._backdropIdle)
            GLib.source_remove(this._backdropIdle);
        this._backdropIdle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._backdropIdle = 0;
            const monitor = Main.layoutManager.primaryMonitor;
            if (!monitor || this._clocks().length === 0)
                return GLib.SOURCE_REMOVE;
            prepareLockBackdrop({
                background: this._background,
                iface: this._interface,
                monitor: [monitor.width, monitor.height],
                scale: scaleFactor(),
            }).catch(e => !this._gone && console.warn(`Atelier: the glass clock's frosted wallpaper isn't ready: ${e.message}`));
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
        this._settings.disconnectObject(this);
        this._background.disconnectObject(this);
        this._interface.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
    }
}
