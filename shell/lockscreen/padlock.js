// The padlock in the lock screen's island, in a ring of ticks. While GNOME
// checks (a password, a face), a wave runs round the ring: the ticks it
// passes grow and fall back, as a stadium's wave. The ring shows faintly
// while a fingerprint reader waits, turns red for a moment on a failure,
// and green as the shackle opens when the screen unlocks, with one last
// wave round it. Drawn, so that the shackle can lift.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';

const TICKS = 48;
const WAVE_WIDTH = 0.95; // half the wave's width, radians
const WAVE_GROW = 1.4; // how much longer a tick is on the wave's crest
const OPEN_TIME = 320;
const FADE_TIME = 220;
const TURN_TIME = 1300; // the wave once round, while GNOME checks
const SWEEP_TIME = 760; // the last wave, once unlocked

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
        this._shackle = 0; // 0 closed … 1 open
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
        for (const [name, wanted] of [['success', tone === 'green'], ['failed', tone === 'red']]) {
            if (wanted)
                this.add_style_pseudo_class(name);
            else
                this.remove_style_pseudo_class(name);
        }
        this._tween('shackle', shackle === 'open' ? 1 : 0, OPEN_TIME);
        this._ring = ring;
        this._tween('ticks', ring === 'none' ? 0 : 1, FADE_TIME);
        if (ring === 'spin') {
            this._stop('sweep');
            this._tween('wave', 1, FADE_TIME);
            if (!this._timelines.has('spin'))
                this._startSpin();
        } else {
            this._stop('spin');
            if (tone === 'green' && before.tone !== 'green')
                this._sweep();
            else
                this._tween('wave', 0, FADE_TIME);
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

    // Unlocked: one last wave round the ring, ebbing away.
    _sweep() {
        this._stop('wave');
        this._stop('sweep');
        const duration = adjustAnimationTime(SWEEP_TIME);
        if (duration <= 0) {
            this._wave = 0;
            return;
        }
        const from = this._crest;
        const timeline = new Clutter.Timeline({
            actor: this,
            duration,
            progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        timeline.connect('new-frame', () => {
            const t = timeline.get_progress();
            this._crest = from + 2 * Math.PI * t;
            this._wave = 1 - t;
            this.queue_repaint();
        });
        timeline.connect('completed', () => {
            this._wave = 0;
            this._timelines.delete('sweep');
            this.queue_repaint();
        });
        this._timelines.set('sweep', timeline);
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

        if (this._ticks > 0) {
            // Waiting for a finger: the ring, faint and still.
            const faint = this._ring === 'track';
            const middle = size * 0.4;
            const length = size * 0.06;
            cr.setLineCap(Cairo.LineCap.ROUND);
            for (let i = 0; i < TICKS; i++) {
                const angle = 2 * Math.PI * i / TICKS;
                const distance = apart(angle, this._crest);
                const crest = faint || distance >= WAVE_WIDTH
                    ? 0 : this._wave * 0.5 * (1 + Math.cos(Math.PI * distance / WAVE_WIDTH));
                const half = length * (1 + WAVE_GROW * crest) / 2;
                const [dx, dy] = [Math.sin(angle), -Math.cos(angle)];
                cr.setLineWidth(Math.max(scale, size * 0.022) * (1 + 0.5 * crest));
                set(hasRing ? ringColor : color, this._ticks * (faint ? 0.35 : 0.75 + 0.25 * crest));
                cr.moveTo(cx + dx * (middle - half), cy + dy * (middle - half));
                cr.lineTo(cx + dx * (middle + half), cy + dy * (middle + half));
                cr.stroke();
            }
        }

        // The padlock, inside the ring.
        const bodyWidth = size * 0.3;
        const bodyHeight = size * 0.235;
        const bodyX = cx - bodyWidth / 2;
        const bodyY = cy - size * 0.02;
        const stroke = Math.max(1.5 * scale, size * 0.048);
        const shackle = size * 0.085;
        const lift = size * 0.06 * this._shackle;
        const top = bodyY - size * 0.07 - lift; // where the shackle's bow starts
        set(color, 1);
        cr.setLineWidth(stroke);
        cr.setLineCap(Cairo.LineCap.BUTT);
        // The right leg stays in the body; the left one comes out of it.
        cr.moveTo(cx + shackle, bodyY + stroke / 2);
        cr.lineTo(cx + shackle, top);
        cr.arcNegative(cx, top, shackle, 2 * Math.PI, Math.PI);
        cr.lineTo(cx - shackle, bodyY + stroke / 2 - lift);
        cr.stroke();

        const corner = size * 0.05;
        cr.newSubPath();
        cr.arc(bodyX + bodyWidth - corner, bodyY + corner, corner, -Math.PI / 2, 0);
        cr.arc(bodyX + bodyWidth - corner, bodyY + bodyHeight - corner, corner, 0, Math.PI / 2);
        cr.arc(bodyX + corner, bodyY + bodyHeight - corner, corner, Math.PI / 2, Math.PI);
        cr.arc(bodyX + corner, bodyY + corner, corner, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        cr.fill();
        cr.$dispose();
    }
});
