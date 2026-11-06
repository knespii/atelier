// The control centre's transitions (lib/ccMotion.js), run frame by frame:
// each a property of an actor (or of any object: a card's rect) going from
// wherever it is to where the state has it, on the spec's cubic-bezier
// curves – which may overshoot, as Clutter's own modes can't. A new target
// for a property on its way turns it round from where it is. Driven by one
// timeline on the stage's frame clock, only while something moves; slowed
// down as the shell's animations are, and short and plain with reduced
// motion (GNOME's animations off).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Tween, easeOf, transitionOf} from '../../lib/ccMotion.js';

/** @returns {boolean} whether motion is to be reduced (GNOME's animations off) */
export function reducedMotion() {
    return !St.Settings.get().enable_animations;
}

const now = () => GLib.get_monotonic_time() / 1000;

/**
 * @param {object} target
 * @param {string} name - a property, or 'scale' (both of an actor's)
 * @returns {number}
 */
function getProp(target, name) {
    if (name === 'scale')
        return target.scale_x;
    return target[name];
}

function setProp(target, name, value) {
    if (name === 'scale')
        target.set_scale(value, value);
    else if (name === 'opacity')
        target.opacity = Math.round(Math.min(255, Math.max(0, value)));
    else
        target[name] = value;
}

export class Animator {
    /**
     * @param {Clutter.Actor} actor - whose frame clock drives it
     */
    constructor(actor) {
        this._actor = actor;
        // target → {props: Map(name → Tween), onUpdate, onDone}[]
        this._jobs = new Set();
        this._timeline = null;
    }

    /**
     * Ease properties of a target to these values.
     *
     * @param {object} target - an actor, or any object
     * @param {object} values - {name: value}; 'scale' sets both of an actor's
     * @param {object} options
     * @param {string} [options.curve] - one of lib/ccMotion.js CURVES
     * @param {number} [options.duration] - ms
     * @param {number} [options.delay] - ms
     * @param {object} [options.from] - {name: value}, set now (as a
     *   keyframe's start, kept through its delay)
     * @param {Function} [options.onUpdate] - each frame, once its values are set
     * @param {Function} [options.onDone] - (finished) once it got there (or
     *   was taken over)
     * @param {boolean} [options.instant] - there at once
     */
    ease(target, values, {curve = 'morph', duration = 0, delay = 0, from = null, onUpdate = null,
        onDone = null, instant = false} = {}) {
        const names = Object.keys(values);
        this.stop(target, names);
        if (from) {
            for (const [name, value] of Object.entries(from))
                setProp(target, name, value);
        }
        const motion = transitionOf(curve, duration, delay, reducedMotion());
        const slow = St.Settings.get().slow_down_factor || 1;
        if (instant || motion.duration * slow <= 0) {
            for (const name of names)
                setProp(target, name, values[name]);
            onUpdate?.();
            onDone?.(true);
            return;
        }
        const start = now();
        const ease = easeOf(motion.curve);
        const props = new Map(names.map(name => [name, new Tween({
            from: getProp(target, name), to: values[name], start,
            duration: motion.duration * slow, delay: motion.delay * slow, ease,
        })]));
        this._jobs.add({target, props, onUpdate, onDone});
        this._run();
    }

    /**
     * @param {object} target
     * @param {string} name
     * @returns {number|undefined} where a property is going, while it goes
     */
    targetOf(target, name) {
        for (const job of this._jobs) {
            if (job.target === target && job.props.has(name))
                return job.props.get(name).to;
        }
        return undefined;
    }

    /**
     * Stop a target's properties where they are (all of them without names).
     *
     * @param {object} target
     * @param {string[]} [names]
     */
    stop(target, names = null) {
        for (const job of [...this._jobs]) {
            if (job.target !== target)
                continue;
            for (const name of names ?? [...job.props.keys()])
                job.props.delete(name);
            if (job.props.size === 0) {
                this._jobs.delete(job);
                job.onDone?.(false);
            }
        }
    }

    /** Everything that moves, there at once. */
    finish() {
        for (const job of [...this._jobs]) {
            this._jobs.delete(job);
            for (const [name, tween] of job.props)
                setProp(job.target, name, tween.to);
            job.onUpdate?.();
            job.onDone?.(true);
        }
        this._idle();
    }

    /** @returns {boolean} whether anything moves */
    get busy() {
        return this._jobs.size > 0;
    }

    _run() {
        if (this._timeline)
            return;
        this._timeline = new Clutter.Timeline({actor: this._actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._step());
        this._timeline.start();
        // (Its first values now, not a frame late.)
        this._step();
    }

    _step() {
        const time = now();
        for (const job of [...this._jobs]) {
            let done = true;
            for (const [name, tween] of job.props) {
                setProp(job.target, name, tween.valueAt(time));
                done &&= tween.doneAt(time);
            }
            job.onUpdate?.();
            if (done && this._jobs.delete(job))
                job.onDone?.(true);
        }
        this._idle();
    }

    _idle() {
        if (this._jobs.size > 0 || !this._timeline)
            return;
        const timeline = this._timeline;
        this._timeline = null;
        // (Stopped, not disposed: this may be in its own frame's handler.)
        timeline.stop();
    }

    destroy() {
        this._jobs.clear();
        this._idle();
        this._actor = null;
    }
}
