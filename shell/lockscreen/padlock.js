// The padlock in the lock screen's island, in a ring: the ring spins while
// GNOME checks (a password, a face), shows faintly while a fingerprint
// reader waits, fills red for a moment on a failure, and green as the
// shackle opens when the screen unlocks. Drawn, so that the shackle can lift.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';

const OPEN_TIME = 320;
const FILL_TIME = 420;
const FADE_TIME = 200;
const TURN_TIME = 1100; // one turn of a spinning ring
const SPIN_ARC = 0.28; // of the ring, while it spins

export const Padlock = GObject.registerClass(
class AtelierPadlock extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'atelier-lock-padlock',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._shackle = 0; // 0 closed … 1 open
        this._arc = 0; // how much of the ring is drawn, 0 … 1
        this._ringAlpha = 0;
        this._angle = 0; // where the ring starts, turning while it spins
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
        this._look = {shackle, ring, tone};
        for (const [name, wanted] of [['success', tone === 'green'], ['failed', tone === 'red']]) {
            if (wanted)
                this.add_style_pseudo_class(name);
            else
                this.remove_style_pseudo_class(name);
        }
        this._tween('shackle', shackle === 'open' ? 1 : 0, OPEN_TIME);

        const spinning = ring === 'spin';
        if (spinning && !this._timelines.has('spin'))
            this._startSpin();
        else if (!spinning)
            this._stop('spin');
        this._ring = ring;
        this._tween('ringAlpha', ring === 'none' ? 0 : 1, FADE_TIME);
        // A filling ring grows from where it is to all of it.
        this._tween('arc', spinning ? SPIN_ARC : ring === 'none' ? this._arc : 1,
            ring === 'fill' ? FILL_TIME : FADE_TIME);
        this.queue_repaint();
    }

    _startSpin() {
        const duration = adjustAnimationTime(TURN_TIME);
        // (Without animations, the arc just stands.)
        if (duration <= 0)
            return;
        const timeline = new Clutter.Timeline({actor: this, duration, repeat_count: -1});
        timeline.connect('new-frame', () => {
            this._angle = 2 * Math.PI * timeline.get_progress();
            this.queue_repaint();
        });
        this._timelines.set('spin', timeline);
        timeline.start();
    }

    // Move one of the drawing's values to a target, eased.
    _tween(name, target, time) {
        const property = `_${name}`;
        this._stop(name);
        const from = this[property];
        const duration = adjustAnimationTime(time);
        if (from === target || duration <= 0) {
            this[property] = target;
            return;
        }
        const timeline = new Clutter.Timeline({
            actor: this,
            duration,
            progress_mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        timeline.connect('new-frame', () => {
            this[property] = from + (target - from) * timeline.get_progress();
            this.queue_repaint();
        });
        timeline.connect('completed', () => {
            this[property] = target;
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

        if (this._ringAlpha > 0 && this._arc > 0) {
            const lineWidth = 2 * scale;
            const radius = size / 2 - lineWidth / 2;
            cr.setLineWidth(lineWidth);
            cr.setLineCap(Cairo.LineCap.ROUND);
            // Waiting for a finger: the whole ring, faint.
            set(hasRing ? ringColor : color, this._ringAlpha * (this._ring === 'track' ? 0.35 : 1));
            const start = -Math.PI / 2 + this._angle;
            cr.arc(cx, cy, radius, start, start + 2 * Math.PI * Math.min(1, this._arc));
            cr.stroke();
        }

        // The padlock, about half as big as the ring.
        const bodyWidth = size * 0.4;
        const bodyHeight = size * 0.3;
        const bodyX = cx - bodyWidth / 2;
        const bodyY = cy - bodyHeight * 0.12;
        const stroke = Math.max(1.5 * scale, size * 0.075);
        const shackle = bodyWidth * 0.3;
        const lift = size * 0.09 * this._shackle;
        const top = bodyY - size * 0.1 - lift; // where the shackle's bow starts
        set(color, 1);
        cr.setLineWidth(stroke);
        cr.setLineCap(Cairo.LineCap.BUTT);
        // The left leg stays in the body; the right one comes out of it.
        cr.moveTo(cx - shackle, bodyY + stroke / 2);
        cr.lineTo(cx - shackle, top);
        cr.arc(cx, top, shackle, Math.PI, 2 * Math.PI);
        cr.lineTo(cx + shackle, bodyY + stroke / 2 - lift);
        cr.stroke();

        const corner = size * 0.06;
        cr.newSubPath();
        cr.arc(bodyX + bodyWidth - corner, bodyY + corner, corner, -Math.PI / 2, 0);
        cr.arc(bodyX + bodyWidth - corner, bodyY + bodyHeight - corner, corner, 0, Math.PI / 2);
        cr.arc(bodyX + corner, bodyY + bodyHeight - corner, corner, Math.PI / 2, Math.PI);
        cr.arc(bodyX + corner, bodyY + corner, corner, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        cr.fill();
        // The keyhole lets the island's black through.
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.arc(cx, bodyY + bodyHeight * 0.45, size * 0.045, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }
});
