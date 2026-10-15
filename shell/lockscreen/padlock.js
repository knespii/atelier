// The padlock in the lock screen's island, in a ring of ticks. While GNOME
// checks (a password, a face), a wave runs round the ring: the ticks it
// passes grow and fall back, as a stadium's wave. The ring shows faintly
// while a fingerprint reader waits, turns red for a moment on a failure,
// and green when the screen unlocks (its colour always blending softly
// from one to the next). Unlocked, the ring is squeezed like a stress ball:
// it swells and squashes out of round, wobbles back, the ticks' tips paling
// a little meanwhile; and the padlock springs open: the shackle jumps up
// past where it stays, swinging out on its right leg, and the padlock
// swells a little. Drawn, so that it all can move.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';

const TICKS = 48;
const RING = 0.37; // the ring's radius, of the padlock's size: room round it to swell
const WAVE_WIDTH = 0.95; // half the wave's width, radians
const WAVE_GROW = 1.4; // how much longer a tick is on the wave's crest
const OPEN_TIME = 700; // springing open
const CLOSE_TIME = 320;
const SWING = 0.7; // how far the shackle swings out as it opens, radians
const SWELL = 0.1; // how much bigger the padlock gets for a moment
const FADE_TIME = 220;
const TURN_TIME = 1300; // the wave once round, while GNOME checks
const SQUEEZE_TIME = 1200; // the ring squeezed, once unlocked
const PALE = 0.4; // how far the ticks' tips pale towards white then, at most
const COLOR_TIME = 300; // from one colour of the ring to the next

const clamp01 = t => Math.min(1, Math.max(0, t));
// Past the end and back: 1.1 at most.
const easeOutBack = t => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;

// How far a tick at angle a is from the wave's crest at c, 0 (on it) to π.
function apart(a, c) {
    const d = Math.abs(a - c) % (2 * Math.PI);
    return d > Math.PI ? 2 * Math.PI - d : d;
}

export const Padlock = GObject.registerClass(
class AtelierPadlock extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'atelier-lock-padlock',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._shackle = 0; // 0 closed … 1 open (a little more as it springs open)
        this._swing = 0; // the shackle turned on its right leg, radians
        this._swell = 1; // the padlock's scale
        this._squeeze = 0; // how far the ring's squeeze has got, 0 … 1 (0: none)
        this._color = 1; // from the colour shown before (0) to the ring's own (1)
        this._from = null;
        this._shown = null; // the ring's colour as last drawn
        this._ticks = 0; // how much the ring shows, 0 … 1
        this._wave = 0; // how high the wave is, 0 … 1
        this._crest = 0; // where it is: radians from the top, clockwise
        this._ring = 'none';
        this._look = {shackle: 'closed', ring: 'none', tone: 'neutral'};
        this._timelines = new Map();
        this.connect('destroy', () => {
            this._timelines.forEach(timeline => timeline.stop());
            this._timelines.clear();
        });
    }

    /** @returns {object} the look it shows, or is on its way to */
    get look() {
        return this._look;
    }

    /** @param {object} look - from lib/lockState.js look() */
    setLook({shackle, ring, tone}) {
        const before = this._look;
        this._look = {shackle, ring, tone};
        // (From the colour shown, softly.)
        if (tone !== before.tone) {
            this._from = this._shown;
            this._color = 0;
            this._tween('color', 1, COLOR_TIME, Clutter.AnimationMode.EASE_IN_OUT_SINE);
        }
        for (const [name, wanted] of [['success', tone === 'green'], ['failed', tone === 'red']]) {
            if (wanted)
                this.add_style_pseudo_class(name);
            else
                this.remove_style_pseudo_class(name);
        }
        if (shackle === 'open' && before.shackle !== 'open') {
            this._open();
        } else if (shackle !== 'open') {
            this._stop('open');
            this._swing = 0;
            this._swell = 1;
            this._tween('shackle', 0, CLOSE_TIME);
        }
        this._ring = ring;
        this._tween('ticks', ring === 'none' ? 0 : 1, FADE_TIME);
        if (ring === 'spin') {
            this._tween('wave', 1, FADE_TIME);
            if (!this._timelines.has('spin'))
                this._startSpin();
        } else {
            this._stop('spin');
            this._tween('wave', 0, FADE_TIME);
            if (tone === 'green' && before.tone !== 'green')
                this._tween('squeeze', 1, SQUEEZE_TIME, Clutter.AnimationMode.LINEAR, 0);
        }
        this.queue_repaint();
    }

    // The wave round and round, from where it is.
    _startSpin() {
        const duration = adjustAnimationTime(TURN_TIME);
        // (Without animations, the ring just shows.)
        if (duration <= 0)
            return;
        const from = this._crest;
        const timeline = new Clutter.Timeline({actor: this, duration, repeat_count: -1});
        timeline.connect('new-frame', () => {
            this._crest = from + 2 * Math.PI * timeline.get_progress();
            this.queue_repaint();
        });
        this._timelines.set('spin', timeline);
        timeline.start();
    }

    _open() {
        this._stop('shackle');
        this._stop('open');
        const opened = () => {
            this._shackle = 1;
            this._swing = 0;
            this._swell = 1;
            this._timelines.delete('open');
            this.queue_repaint();
        };
        const duration = adjustAnimationTime(OPEN_TIME);
        if (duration <= 0) {
            opened();
            return;
        }
        const from = this._shackle;
        const timeline = new Clutter.Timeline({actor: this, duration});
        timeline.connect('new-frame', () => {
            this._opening(timeline.get_progress(), from);
            this.queue_repaint();
        });
        timeline.connect('completed', opened);
        this._timelines.set('open', timeline);
        timeline.start();
    }

    // Springing open, at p (0 … 1): the shackle jumps up past where it
    // stays and back; meanwhile it swings out to the left and back, a
    // little less each time; the padlock swells and settles.
    _opening(p, from) {
        this._shackle = from + (1 - from) * easeOutBack(clamp01(p / 0.5));
        const swing = clamp01((p - 0.1) / 0.9);
        this._swing = -SWING * Math.exp(-3 * swing) * Math.sin(2.5 * Math.PI * swing) * (1 - swing);
        this._swell = 1 + SWELL * Math.sin(Math.PI * clamp01(p / 0.45));
    }

    /**
     * Move one of the drawing's values to a target, eased.
     *
     * @param {string} name
     * @param {number} target
     * @param {number} time - milliseconds
     * @param {Clutter.AnimationMode} [mode]
     * @param {number} [end] - where it is left once there (the target)
     */
    _tween(name, target, time, mode = Clutter.AnimationMode.EASE_OUT_CUBIC, end = target) {
        const property = `_${name}`;
        this._stop(name);
        const from = this[property];
        const duration = adjustAnimationTime(time);
        if (from === target || duration <= 0) {
            this[property] = end;
            return;
        }
        const timeline = new Clutter.Timeline({actor: this, duration, progress_mode: mode});
        timeline.connect('new-frame', () => {
            this[property] = from + (target - from) * timeline.get_progress();
            this.queue_repaint();
        });
        timeline.connect('completed', () => {
            this[property] = end;
            this._timelines.delete(name);
            this.queue_repaint();
        });
        this._timelines.set(name, timeline);
        timeline.start();
    }

    _stop(name) {
        this._timelines.get(name)?.stop();
        this._timelines.delete(name);
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const color = node.get_foreground_color();
        const [hasRing, ringColor] = node.lookup_color('-atelier-ring-color', false);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const set = (c, alpha) =>
            cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, alpha * c.alpha / 255);
        const size = Math.min(width, height);
        const [cx, cy] = [width / 2, height / 2];

        // The ring's colour, on its way from the one shown before.
        const own = hasRing ? ringColor : color;
        const from = this._from ?? own;
        const mix = (a, b, k) => a + (b - a) * k;
        const ink = {};
        for (const channel of ['red', 'green', 'blue', 'alpha'])
            ink[channel] = mix(from[channel], own[channel], this._color);
        this._shown = ink;

        if (this._ticks > 0) {
            // Waiting for a finger: the ring, faint and still.
            const faint = this._ring === 'track';
            const length = size * 0.06;
            // Squeezed: swelling, squashed out of round (as by a hand,
            // turning a little) and a little lumpy, all wobbling back.
            const p = this._squeeze;
            const ebb = 1 - p;
            const swell = 0.24 * Math.exp(-3 * p) * Math.sin(2.2 * Math.PI * p) * ebb;
            const squash = 0.12 * Math.exp(-2.5 * p) * Math.sin(3 * Math.PI * p) * ebb;
            const lumps = 0.02 * Math.exp(-3 * p) * Math.sin(4.4 * Math.PI * p) * ebb;
            const axis = Math.PI / 4 + 0.8 * p;
            const pale = PALE * Math.sin(Math.PI * Math.min(1, p / 0.7)) ** 2;
            const tip = {};
            for (const channel of ['red', 'green', 'blue'])
                tip[channel] = mix(ink[channel], 255, pale);
            tip.alpha = ink.alpha;
            cr.setLineCap(Cairo.LineCap.ROUND);
            for (let i = 0; i < TICKS; i++) {
                const angle = 2 * Math.PI * i / TICKS;
                const distance = apart(angle, this._crest);
                const crest = faint || distance >= WAVE_WIDTH
                    ? 0 : this._wave * 0.5 * (1 + Math.cos(Math.PI * distance / WAVE_WIDTH));
                const bulge = swell + squash * Math.cos(2 * (angle - axis)) + lumps * Math.cos(3 * angle + 1.3);
                const middle = size * RING * (1 + bulge);
                // (Stretched where it bulges.)
                const half = length * (1 + WAVE_GROW * crest) * (1 + 1.5 * Math.max(0, bulge)) / 2;
                const [dx, dy] = [Math.sin(angle), -Math.cos(angle)];
                const [x0, y0] = [cx + dx * (middle - half), cy + dy * (middle - half)];
                const [x1, y1] = [cx + dx * (middle + half), cy + dy * (middle + half)];
                const alpha = Math.min(1, this._ticks * (faint ? 0.35 : 0.75 + 0.25 * crest + 0.25 * pale));
                cr.setLineWidth(Math.max(scale, size * 0.022) * (1 + 0.5 * crest));
                if (pale > 0.002) {
                    // (Paling towards the tip, softly.)
                    const gradient = new Cairo.LinearGradient(x0, y0, x1, y1);
                    gradient.addColorStopRGBA(0.2, ink.red / 255, ink.green / 255, ink.blue / 255,
                        alpha * ink.alpha / 255);
                    gradient.addColorStopRGBA(1, tip.red / 255, tip.green / 255, tip.blue / 255,
                        alpha * tip.alpha / 255);
                    cr.setSource(gradient);
                } else {
                    set(ink, alpha);
                }
                cr.moveTo(x0, y0);
                cr.lineTo(x1, y1);
                cr.stroke();
            }
        }

        // The padlock, inside the ring, in the middle of it when closed.
        const bodyWidth = size * 0.34;
        const bodyHeight = size * 0.26;
        const bodyX = cx - bodyWidth / 2;
        const bodyY = cy - size * 0.032;
        const stroke = Math.max(1.5 * scale, size * 0.052);
        const shackle = size * 0.095;
        const lift = size * 0.07 * this._shackle;
        const top = bodyY - size * 0.075 - lift; // where the shackle's bow starts
        cr.save();
        cr.translate(cx, cy);
        cr.scale(this._swell, this._swell);
        cr.translate(-cx, -cy);
        set(color, 1);
        cr.setLineWidth(stroke);
        cr.setLineCap(Cairo.LineCap.BUTT);
        // The right leg stays in the body (the shackle turns on it); the
        // left one comes out of it.
        cr.save();
        cr.translate(cx + shackle, bodyY);
        cr.rotate(this._swing);
        cr.translate(-cx - shackle, -bodyY);
        cr.moveTo(cx + shackle, bodyY + stroke / 2);
        cr.lineTo(cx + shackle, top);
        cr.arcNegative(cx, top, shackle, 2 * Math.PI, Math.PI);
        cr.lineTo(cx - shackle, bodyY + stroke / 2 - lift);
        cr.stroke();
        cr.restore();

        const corner = size * 0.055;
        cr.newSubPath();
        cr.arc(bodyX + bodyWidth - corner, bodyY + corner, corner, -Math.PI / 2, 0);
        cr.arc(bodyX + bodyWidth - corner, bodyY + bodyHeight - corner, corner, 0, Math.PI / 2);
        cr.arc(bodyX + corner, bodyY + bodyHeight - corner, corner, Math.PI / 2, Math.PI);
        cr.arc(bodyX + corner, bodyY + corner, corner, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        cr.fill();
        cr.restore();
        cr.$dispose();
    }
});
