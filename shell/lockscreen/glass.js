// The lock screen's wallpaper as glass while the password is asked: blurred
// as GNOME blurs it, but its colours kept – a little richer, darkened far
// less than GNOME darkens it, and only towards the edges. The type stays
// legible by itself: a soft shadow round each widget's type, and
// the popup is black. One small shader on each wallpaper, under GNOME's
// blur (both are cached: nothing is drawn anew while it rests).

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {backgroundGroupOf, wallpapersOf} from './gnome.js';

const EFFECT_NAME = 'atelier-glass';
/** The glass at its fullest: how much light is left, how rich the colours, how dark the corners. */
export const GLASS = {brightness: 0.86, saturation: 1.3, vignette: 0.38};
// Unlocked, the wallpaper comes sharp again over this long, ms – frame by
// frame, each at most FRAME on: a shell that stops a moment (turning the
// other extensions on) does not make it jump.
const RELEASE_TIME = 350;
const FRAME = 1000 / 50;

const DECLARATIONS = `
uniform float saturation;
uniform float vignette;
`;

// After the texture lookup (premultiplied; the wallpaper is opaque). Gray
// as the eye has it, the colours pushed away from it; then darker towards
// the corners, nothing in the middle third.
const CODE = `
vec3 color = cogl_color_out.rgb;
float gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
color = mix(vec3(gray), color, saturation);
vec2 p = cogl_tex_coord_in[0].xy - vec2(0.5);
color *= 1.0 - vignette * smoothstep(0.35, 1.0, length(p) * 1.41421);
cogl_color_out.rgb = clamp(color, 0.0, cogl_color_out.a);
`;

const GlassEffect = GObject.registerClass(
class AtelierLockGlassEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._saturation = this.get_uniform_location('saturation');
        this._vignette = this.get_uniform_location('vignette');
        this._look = null;
        this.setLook(1, 0);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    /**
     * @param {number} saturation - 1 as it is, more richer
     * @param {number} vignette - how much darker the corners are, 0 … 1
     */
    setLook(saturation, vignette) {
        if (this._look?.[0] === saturation && this._look[1] === vignette)
            return;
        this._look = [saturation, vignette];
        this.set_uniform_float(this._saturation, 1, [saturation]);
        this.set_uniform_float(this._vignette, 1, [vignette]);
        this.queue_repaint();
    }

    /** @returns {number[]} [saturation, vignette] */
    get look() {
        return this._look;
    }
});

export class LockGlass {
    /**
     * @param {UnlockDialog} dialog
     * @param {object} blur - GNOME's blur at its fullest: {radius (logical
     *   pixels), brightness}
     */
    constructor(dialog, blur) {
        this._dialog = dialog;
        this._blur = blur;
        this._progress = 0;
        this._releasing = null;
    }

    /** @returns {number} how much glass there is: 0 sharp … 1 */
    get progress() {
        return this._progress;
    }

    /** @param {number} progress - 0 sharp … 1 glass, as the prompt comes up */
    set(progress) {
        this._stopReleasing();
        this._paint(progress);
    }

    _paint(progress) {
        this._progress = progress;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        for (const wallpaper of wallpapersOf(this._dialog)) {
            // (GNOME makes them anew with the monitors: each gets its own.)
            let glass = wallpaper.get_effect(EFFECT_NAME);
            if (!glass) {
                glass = new GlassEffect();
                wallpaper.add_effect_with_name(EFFECT_NAME, glass);
            }
            const shown = progress > 0;
            wallpaper.get_effect('blur').set({
                radius: Math.round(this._blur.radius * scale * progress),
                brightness: 1 - (1 - GLASS.brightness) * progress,
                enabled: shown,
            });
            glass.setLook(1 + (GLASS.saturation - 1) * progress, GLASS.vignette * progress);
            glass.enabled = shown;
        }
    }

    /**
     * Unlocked: sharp again, as the lock screen goes – by itself, after
     * Atelier's lock screen has stopped; it stops with the lock screen.
     */
    release() {
        const group = backgroundGroupOf(this._dialog);
        const from = this._progress;
        if (this._releasing || !group || from <= 0)
            return;
        const duration = adjustAnimationTime(RELEASE_TIME);
        if (duration <= 0) {
            this._paint(0);
            return;
        }
        let t = 0;
        const timeline = new Clutter.Timeline({actor: group, duration: 1000, repeat_count: -1});
        timeline.connect('new-frame', () => {
            t = Math.min(1, t + Math.min(timeline.get_delta(), FRAME) / duration);
            this._paint(from * (1 - t) * (1 - t));
            if (t >= 1)
                this._stopReleasing();
        });
        group.connectObject('destroy', () => this._stopReleasing(), this);
        this._releasing = timeline;
        timeline.start();
    }

    _stopReleasing() {
        if (!this._releasing)
            return;
        this._releasing.stop();
        this._releasing = null;
        backgroundGroupOf(this._dialog)?.disconnectObject(this);
    }

    /** GNOME's own blur again, as it set it (Atelier turned off while locked). */
    restore() {
        this._stopReleasing();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        for (const wallpaper of wallpapersOf(this._dialog)) {
            wallpaper.remove_effect_by_name(EFFECT_NAME);
            wallpaper.get_effect('blur').set({
                radius: Math.round(this._blur.radius * scale),
                brightness: this._blur.brightness,
                enabled: true,
            });
        }
        this._dialog = null;
    }
}
