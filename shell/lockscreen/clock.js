// The lock screen's clock: the desktop's (shell/desktop/kinds/time.js), its
// stacked minutes as bright as its hours, and a face of its own – glass:
// the time in one line of tall digits, a light tint the wallpaper shows
// through, under a small date line, as an iPhone's. They stretch to the room
// there is: from under the date line down to where the wallpaper's subject
// starts under them (which passes in front of their feet, see board.js), or
// as tall as the clock's box lets them; a change of it eases. Drawn anew
// for a minute, a size, a tone or a font: nothing moves while it rests.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {glassDigits} from '../../lib/lockLook.js';
import {splitClock} from '../../lib/widgets.js';
import {ClockWidget} from '../desktop/kinds/time.js';
import {label} from '../desktop/widget.js';

const NARROW = 0.9; // the digits' width, of what the font has: a little condensed
const FILL = 0.98; // of the clock's width the digits take, at most
const SAMPLE = '00:00'; // the digits fit the width as this would: the size stays as the minutes go
const DATE_GAP = 2; // between the date line and the digits, logical pixels
const SETTLE_TIME = 450; // to a new height, ms
// The glass: a light tint, more of it at the top, a bright rim, and a soft
// shadow round it (outside it only).
const TINT = [0.66, 0.44];
const RIM = [0.6, 0.14];
const SHADOW = [[16, 0.035], [9, 0.05], [4, 0.07]];

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

// The digits, drawn in glass: one path of them, stretched as the face says.
const Digits = GObject.registerClass(
class AtelierGlassDigits extends St.DrawingArea {
    _init(face) {
        super._init({style_class: 'atelier-widget-glass-digits'});
        this._face = face;
        this.text = '';
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const face = this._face;
        const metrics = face.metrics;
        if (!metrics || !this.text) {
            cr.$dispose();
            return;
        }
        const [width, height] = this.get_surface_size();
        const layout = PangoCairo.create_layout(cr);
        face.setUpLayout(layout, this.text);
        const [ink] = layout.get_pixel_extents();
        const {stretch, level} = face;
        const color = this.get_theme_node().get_foreground_color();
        const [r, g, b] = [color.red, color.green, color.blue].map(v => v / 255);
        const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
        const scale = scaleFactor();

        // (Round joins: stretched, the digits' corners are sharp.)
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.save();
        cr.translate(width / 2 - (ink.x + ink.width / 2) * NARROW, level - metrics.inkY * stretch);
        cr.scale(NARROW, stretch);
        PangoCairo.layout_path(cr, layout);
        cr.restore();
        const path = cr.copyPath();
        const [top, bottom] = [level, level + metrics.inkHeight * stretch];

        // The shadow, outside the digits only (the glass shows the
        // wallpaper): drawn on its own, the digits then taken out of it –
        // filled, so that where a font's outlines overlap inside a digit
        // nothing shows.
        cr.pushGroup();
        cr.appendPath(path);
        for (const [lineWidth, alpha] of SHADOW) {
            if (dark)
                cr.setSourceRGBA(1, 1, 1, alpha * 1.4);
            else
                cr.setSourceRGBA(0, 0, 0, alpha);
            cr.setLineWidth(lineWidth * scale);
            cr.strokePreserve();
        }
        cr.setOperator(Cairo.Operator.DEST_OUT);
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.fill();
        cr.popGroupToSource();
        cr.paint();

        cr.newPath();
        cr.appendPath(path);
        const tint = new Cairo.LinearGradient(0, top, 0, bottom);
        tint.addColorStopRGBA(0, r, g, b, TINT[0] * color.alpha / 255);
        tint.addColorStopRGBA(1, r, g, b, TINT[1] * color.alpha / 255);
        cr.setSource(tint);
        cr.fill();

        // The rim: light along the digits' upper edges, as glass catches
        // it – the digits, less themselves a little lower (again filled,
        // not stroked: no lines where outlines overlap).
        const rim = new Cairo.LinearGradient(0, top, 0, bottom);
        rim.addColorStopRGBA(0, 1, 1, 1, RIM[0] * (dark ? 0.5 : 1));
        rim.addColorStopRGBA(1, 1, 1, 1, RIM[1] * (dark ? 0.5 : 1));
        cr.pushGroup();
        cr.appendPath(path);
        cr.setSource(rim);
        cr.fill();
        cr.setOperator(Cairo.Operator.DEST_OUT);
        cr.translate(0, 1.6 * scale);
        cr.appendPath(path);
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.fill();
        cr.identityMatrix();
        cr.popGroupToSource();
        cr.paint();
        cr.$dispose();
    }
});

const GlassFace = GObject.registerClass({
    Properties: {
        // How much taller than they are the digits stand, and where their top is.
        'stretch': GObject.ParamSpec.double('stretch', null, null, GObject.ParamFlags.READWRITE, 0, 100, 1),
        'level': GObject.ParamSpec.double('level', null, null, GObject.ParamFlags.READWRITE, -1e6, 1e6, 0),
    },
}, class AtelierGlassFace extends St.Widget {
    _init() {
        super._init({style_class: 'atelier-widget-glass', x_expand: true, y_expand: true});
        this._date = label('atelier-widget-glass-date');
        this._digits = new Digits(this);
        this.add_child(this._digits);
        this.add_child(this._date);
        this._stretch = 1;
        this._level = 0;
        this._subject = null;
        this._target = null;
        this._metrics = null;
        this._size = [0, 0];
        /** Called when the digits are measured anew (the depth effect follows them). */
        this.onMeasured = null;
        // (Another font, or weight: measured anew.)
        this._digits.connect('style-changed', () => {
            this._metrics = null;
            this.queue_relayout();
        });
    }

    get stretch() {
        return this._stretch;
    }

    set stretch(value) {
        if (value === this._stretch)
            return;
        this._stretch = value;
        this.notify('stretch');
        this._moved();
    }

    get level() {
        return this._level;
    }

    set level(value) {
        if (value === this._level)
            return;
        this._level = value;
        this.notify('level');
        this._moved();
    }

    /** @returns {object|null} {fontSize, inkY, inkHeight, width} of the digits as they are, device pixels */
    get metrics() {
        return this._metrics;
    }

    /** @returns {object|null} {stretch, y} the digits are going to */
    get target() {
        return this._target;
    }

    _moved() {
        this.queue_relayout();
        this._digits.queue_repaint();
    }

    /** @param {string} text - the clock as GNOME shows it, e.g. "9∶41 PM" */
    setClock(text) {
        const {hours, minutes} = splitClock(text);
        this._digits.text = minutes ? `${hours}:${minutes}` : hours;
        this._date.text = GLib.DateTime.new_now_local().format('%A, %B %-d');
        this._digits.queue_repaint();
    }

    /**
     * @param {Pango.Layout} layout
     * @param {string} text
     */
    setUpLayout(layout, text) {
        const font = this._digits.get_theme_node().get_font().copy();
        font.set_absolute_size((this._metrics?.fontSize ?? 100) * Pango.SCALE);
        layout.set_font_description(font);
        // (Digits all as wide: the time doesn't wobble as it goes.)
        const features = new Pango.AttrList();
        features.insert(Pango.attr_font_features_new('tnum'));
        layout.set_attributes(features);
        layout.set_text(text, -1);
    }

    // The size the digits fit the width at, and how high they are then.
    _measure(width) {
        if (!this._digits.get_stage() || width <= 0)
            return;
        const layout = this._digits.create_pango_layout(SAMPLE);
        this._metrics = null;
        this.setUpLayout(layout, SAMPLE);
        const [, logical] = layout.get_pixel_extents();
        const fontSize = Math.max(8, Math.floor(100 * width * FILL / (Math.max(1, logical.width) * NARROW)));
        this._metrics = {fontSize};
        this.setUpLayout(layout, SAMPLE);
        const [ink, wide] = layout.get_pixel_extents();
        this._metrics = {fontSize, inkY: ink.y, inkHeight: Math.max(1, ink.height), width: wide.width * NARROW};
        this.onMeasured?.();
    }

    // Under the date line, to the bottom of the box: the digits stay in it
    // (where it is placed is where they are; placed over a hill, they go
    // down behind it).
    _room() {
        const [, dateHeight] = this._date.get_preferred_height(-1);
        return {top: dateHeight + DATE_GAP * scaleFactor(), bottom: this._size[1]};
    }

    // Where the digits go, for the room there is and the subject under them.
    _retarget(animate) {
        if (!this._metrics)
            return;
        const {top, bottom} = this._room();
        const target = glassDigits(this._metrics.inkHeight, top, bottom, this._subject);
        if (this._target && Math.abs(this._target.stretch - target.stretch) < 0.005 &&
            Math.abs(this._target.y - target.y) < 0.5)
            return;
        this._target = target;
        if (animate && this.mapped) {
            this.ease_property('stretch', target.stretch, {duration: SETTLE_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            this.ease_property('level', target.y, {duration: SETTLE_TIME, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        } else {
            this.remove_transition('stretch');
            this.remove_transition('level');
            // (As it is laid out: not laid out anew for it.)
            this._stretch = target.stretch;
            this._level = target.y;
            this._digits.queue_repaint();
        }
    }

    /**
     * Where the wallpaper's subject starts under the digits (board.js finds it).
     *
     * @param {number|null} y - in the face; null for nothing there
     */
    setSubject(y) {
        const subject = y === null ? null : Math.round(y);
        if (subject === this._subject)
            return;
        this._subject = subject;
        this._retarget(true);
    }

    /**
     * @returns {object|null} {x, width, top, bottom} in the face: across
     *   the digits, from under the date line to the bottom (where to look
     *   for the subject); null until measured
     */
    get strip() {
        if (!this._metrics)
            return null;
        const width = this._metrics.width;
        return {x: (this._size[0] - width) / 2, width, ...this._room()};
    }

    /** @returns {object|null} {x, y, width, height} of the digits where they go, in the face */
    get digitsRect() {
        if (!this._metrics || !this._target)
            return null;
        const width = this._metrics.width;
        return {x: (this._size[0] - width) / 2, y: this._target.y, width,
            height: this._metrics.inkHeight * this._target.stretch};
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [width, height] = [box.get_width(), box.get_height()];
        const resized = width !== this._size[0] || height !== this._size[1];
        this._size = [width, height];
        this._digits.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: height}));
        if (!this._metrics || resized) {
            this._measure(width);
            this._target = null;
            this._retarget(false);
        }
        // The date line just over the digits, in the middle.
        const [, dateWidth] = this._date.get_preferred_width(-1);
        const [, dateHeight] = this._date.get_preferred_height(-1);
        const w = Math.min(width, dateWidth);
        const x = Math.round((width - w) / 2);
        const y = Math.max(0, Math.round(this._level - DATE_GAP * scaleFactor() - dateHeight));
        this._date.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + w, y2: y + dateHeight}));
    }
});

export const LockClockWidget = GObject.registerClass(
class AtelierLockClockWidget extends ClockWidget {
    buildFace(design, box) {
        if (design !== 'glass')
            return null;
        const face = new GlassFace();
        face.onMeasured = () => this._context.depthChanged?.();
        box.add_child(face);
        return face;
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
