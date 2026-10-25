// The lock screen's wallpaper as glass while the password is asked: blurred
// as GNOME blurs it, but its colours kept – a little richer, darkened far
// less than GNOME darkens it, and only towards the edges. The type stays
// legible by itself: a soft shadow round each widget's type; the island's
// and the popup's glass darkened as the glass-dim setting has all of it.
//
// The glass is each wallpaper drawn a second time and made glass once – one
// small shader on it, under GNOME's blur at its fullest – laid over the
// wallpaper, which stays sharp: as the prompt comes up the glass fades in
// over it, and out again as the prompt goes. Nothing is blurred anew
// meanwhile (GNOME's blur keeps what it has drawn while what it blurs stays
// as it is): the glass is only drawn more or less opaque, a frame as cheap
// as any. (A blur's radius animated would have GNOME's blur draw it all
// anew each frame, and make what it draws into anew each time the size it
// draws at changes: on a large monitor, a frame of its own.) At rest the
// glass lies under the wallpaper, where it can't be seen but is drawn –
// made as the lock screen shows, and made anew should the wallpaper change:
// the prompt finds it ready.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

import {backgroundGroupOf, wallpapersOf} from './gnome.js';

const EFFECT_NAME = 'atelier-glass';
const BLUR_NAME = 'atelier-lock-blur';
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
        this.set_uniform_float(this.get_uniform_location('saturation'), 1, [GLASS.saturation]);
        this.set_uniform_float(this.get_uniform_location('vignette'), 1, [GLASS.vignette]);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    /** @returns {number[]} [saturation, vignette] */
    get look() {
        return [GLASS.saturation, GLASS.vignette];
    }
});

// A wallpaper's glass: the wallpaper as GNOME draws it there (its own,
// which follows the wallpaper as GNOME's does), blurred as GNOME blurs it at
// its fullest over the shader – GNOME's blur outermost, as it was on the
// wallpaper. It is drawn only as it is made, and anew if the wallpaper
// changes; else what GNOME's blur keeps is laid over the wallpaper as it is.
// (Not a copy of GNOME's wallpaper: GNOME restyles that whenever the key
// focus comes and goes, and it would be made anew each time. Never
// flattened to be drawn less opaque: that would make a picture of all of
// it whenever the room made changes.)
const GlassPane = GObject.registerClass(
class AtelierLockGlassPane extends Clutter.Actor {
    _init(wallpaper, monitorIndex) {
        super._init({
            x: wallpaper.x,
            y: wallpaper.y,
            width: wallpaper.width,
            height: wallpaper.height,
            offscreen_redirect: 0,
        });
        /** The wallpaper it is the glass of. */
        this.wallpaper = wallpaper;
        const background = new Background.BackgroundManager({container: this, monitorIndex, controlPosition: false});
        this.connect('destroy', () => background.destroy());
        this.add_effect_with_name(BLUR_NAME,
            new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, brightness: GLASS.brightness}));
        this.add_effect_with_name(EFFECT_NAME, new GlassEffect());
        /** How many times it has been drawn (made). */
        this.made = 0;
    }

    vfunc_paint(context) {
        this.made++;
        super.vfunc_paint(context);
    }

    /** @param {number} radius - of GNOME's blur at its fullest, pixels */
    setRadius(radius) {
        const blur = this.get_effect(BLUR_NAME);
        if (blur.radius !== radius)
            blur.radius = radius;
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
        // The wallpapers' glass: over them as it shows, under them at rest.
        this._layer = null;
    }

    /** @returns {number} how much glass there is: 0 sharp … 1 */
    get progress() {
        return this._progress;
    }

    /** @returns {Clutter.Actor|null} what holds the wallpapers' glass, in GNOME's background group */
    get layer() {
        return this._layer;
    }

    /** @returns {Clutter.Actor[]} each wallpaper's glass (its blur, its look and how often it was made) */
    get panes() {
        return this._layer?.get_children() ?? [];
    }

    /** @param {number} progress - 0 sharp … 1 glass, as the prompt comes up */
    set(progress) {
        this._stopReleasing();
        this._paint(progress);
    }

    _paint(progress) {
        this._progress = progress;
        const layer = this._sync();
        if (!layer)
            return;
        const group = layer.get_parent();
        if (progress > 0) {
            if (group.get_last_child() !== layer)
                group.set_child_above_sibling(layer, null);
            layer.opacity = Math.round(255 * progress);
        } else {
            if (group.get_first_child() !== layer)
                group.set_child_below_sibling(layer, null);
            layer.opacity = 255;
        }
    }

    // The glass of each wallpaper there is, as blurred as GNOME blurs it at
    // the scale there is, GNOME's own blur off. (GNOME makes the wallpapers
    // anew with the monitors, and the glass goes with them: made anew too.)
    _sync() {
        const group = backgroundGroupOf(this._dialog);
        const wallpapers = wallpapersOf(this._dialog);
        if (!group || wallpapers.length === 0)
            return null;
        for (const wallpaper of wallpapers) {
            const own = wallpaper.get_effect('blur');
            if (own.enabled)
                own.enabled = false;
        }
        const panes = this.panes;
        if (panes.length !== wallpapers.length || panes.some((pane, i) => pane.wallpaper !== wallpapers[i])) {
            this._layer?.destroy();
            // (Never flattened to be drawn less opaque, as an actor is: it
            // is drawn wallpaper by wallpaper.)
            const layer = new Clutter.Actor({name: 'atelier-lock-glass', offscreen_redirect: 0});
            // (GNOME's are one for each monitor, in their order.)
            wallpapers.forEach((wallpaper, i) => layer.add_child(new GlassPane(wallpaper,
                wallpaper.get_children().find(child => child instanceof Meta.BackgroundActor)?.monitor ?? i)));
            layer.connect('destroy', () => {
                if (this._layer === layer)
                    this._layer = null;
            });
            group.insert_child_below(layer, null);
            this._layer = layer;
        }
        const radius = Math.round(this._blur.radius * St.ThemeContext.get_for_stage(global.stage).scale_factor);
        this.panes.forEach(pane => pane.setRadius(radius));
        return this._layer;
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
        this._layer?.destroy();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        for (const wallpaper of wallpapersOf(this._dialog)) {
            wallpaper.get_effect('blur').set({
                radius: Math.round(this._blur.radius * scale),
                brightness: this._blur.brightness,
                enabled: true,
            });
        }
        this._dialog = null;
    }
}
