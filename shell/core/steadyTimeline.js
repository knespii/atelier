// A timeline that counts only the frames that come (lib/steadyTime.js):
// when the shell stops for a moment, the frame after the gap counts as one
// frame, and the animation plays on from where it was instead of jumping to
// its end, as Clutter's own timelines (which go by the clock) do.

import Clutter from 'gi://Clutter';

import {Curve, steadyDelta} from '../../lib/steadyTime.js';

const CURVES = {
    [Clutter.AnimationMode.LINEAR]: Curve.linear,
    [Clutter.AnimationMode.EASE_OUT_CUBIC]: Curve.easeOutCubic,
    [Clutter.AnimationMode.EASE_IN_CUBIC]: Curve.easeInCubic,
    [Clutter.AnimationMode.EASE_IN_OUT_SINE]: Curve.easeInOutSine,
};
const REFRESH_RATE = 60; // if the monitor's can't be read, Hz

export class SteadyTimeline {
    /**
     * @param {Clutter.Actor} actor - on whose frames it plays
     * @param {number} duration - ms (as adjustAnimationTime has it)
     * @param {object} [options]
     * @param {Clutter.AnimationMode} [options.mode] - one of CURVES' (linear otherwise)
     * @param {Function} [options.onFrame] - (eased progress, 0 … 1)
     * @param {Function} [options.onCompleted] - once it has got to its end
     */
    constructor(actor, duration, {mode = Clutter.AnimationMode.LINEAR, onFrame = null, onCompleted = null} = {}) {
        this._actor = actor;
        this._duration = Math.max(1, duration);
        this._curve = CURVES[mode] ?? Curve.linear;
        this._onFrame = onFrame;
        this._onCompleted = onCompleted;
        this._elapsed = 0;
        this._timeline = null;
    }

    /** @returns {number} how far it has got, 0 … 1 (not eased) */
    get progress() {
        return Math.min(1, this._elapsed / this._duration);
    }

    start() {
        if (this._timeline)
            return;
        // (Only for its frames: it never gets to an end of its own.)
        this._timeline = new Clutter.Timeline({actor: this._actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', timeline => this._tick(timeline.get_delta()));
        this._timeline.start();
    }

    stop() {
        this._timeline?.stop();
        this._timeline = null;
    }

    _tick(delta) {
        this._elapsed += steadyDelta(delta, this._interval());
        const progress = this.progress;
        this._onFrame?.(this._curve(progress));
        if (progress < 1)
            return;
        this.stop();
        this._onCompleted?.();
    }

    /** @returns {number} ms between frames on time, on the actor's monitor */
    _interval() {
        const rate = this._actor.peek_stage_views()[0]?.get_refresh_rate?.();
        return 1000 / (rate > 0 ? rate : REFRESH_RATE);
    }
}
