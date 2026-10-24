// Liquid Glass on the GPU: the material every glass surface of Atelier's is
// drawn with (lib/glassLook.js says how it looks) – one GLSL snippet after
// the texture lookup of a Shell.GLSLEffect, whose texture is what is behind
// the surface, blurred (its actor, painted offscreen). The snippet looks
// that texture up again where the lens has it (cogl_sampler0, at
// coordinates of its own), which GNOME 48 to 50 all allow.
//
// Each effect declares its shape, as signed distances in pixels of its
// actor (below 0 inside):
//
//   float atelier_shape(vec2 p) – what the surface covers;
//   float atelier_body(vec2 p) – the glass it is part of, for the lens and
//     the rim: the shape, or more (a surface on the screen's edge goes on
//     past it; the island's glass in the one island is one glass with it);
//   void atelier_part(vec2 p, out vec4 frame, out vec2 light) – the box the
//     sheen runs across, and where the light comes from, at p.
//
// Then, where the shape is:
// - the lens: within lens.width of the body's edge, what is behind is
//   looked up farther in, along the body's normal (its gradient: shapes
//   merged by a smooth minimum bend as one), up to lens.shift at the very
//   edge – bending outward, as through a convex lens; red a little farther,
//   blue a little less (the aberration): a hint of colour at the rim only;
// - richer and lighter (saturation, brightness), a dimming (clear glass)
//   and a white veil over it;
// - the rim: the body's edge catching the light, strongest where it faces
//   it, faintest where it faces away;
// - the sheen: a diagonal gloss from a corner, turning with the light;
// - a fine grain, against banding.
// Without the material (lens.w 0: solid surfaces, the glass turned off)
// the shape is only cut out, as it always was.

import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {lookOf, materialValues, resolveVariant} from '../../lib/glassLook.js';

export const MATERIAL_DECLARATIONS = `
uniform vec4 glassTone;
uniform vec4 glassLens;
uniform vec4 glassRim;
uniform vec4 glassSheen;
uniform vec2 glassArea;

vec2 atelier_lookup(vec2 p) {
    return (clamp(p, vec2(0.5), glassArea - vec2(0.5)) - origin) / size;
}

float atelier_hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec3 atelier_light_over(vec3 color, float alpha, float amount) {
    return color + amount * (vec3(alpha) - color);
}
`;

// (Premultiplied colours throughout: the texture's, and the actor's opacity
// in cogl_color_in.)
export const MATERIAL_CODE = `
vec2 atelier_uv = cogl_tex_coord_in[0].xy;
vec2 atelier_p = origin + atelier_uv * size;
float atelier_cover = clamp(0.5 - atelier_shape(atelier_p), 0.0, 1.0);
if (atelier_cover <= 0.0 || glassLens.w < 0.5) {
    cogl_color_out *= atelier_cover;
} else {
    vec4 color = cogl_color_out;
    float body = atelier_body(atelier_p);
    float inward = -body;
    vec4 frame;
    vec2 light;
    atelier_part(atelier_p, frame, light);
    vec2 normal = vec2(0.0);
    float edged = 0.0;
    if (inward < max(glassLens.x, glassRim.w) + 1.0) {
        vec2 slope = vec2(atelier_body(atelier_p + vec2(1.0, 0.0)) - body,
            atelier_body(atelier_p + vec2(0.0, 1.0)) - body);
        float steep = length(slope);
        if (steep > 0.0001) {
            normal = slope / steep;
            edged = 1.0;
        }
        float t = clamp(inward / max(glassLens.x, 0.0001), 0.0, 1.0);
        float bend = glassLens.y * (1.0 - t) * (1.0 - t);
        if (bend > 0.01 && edged > 0.0) {
            // (Never past the actor: a notch's ears bend towards the top
            // of the screen.)
            vec2 inwards = normal * bend;
            vec4 middle = texture2D(cogl_sampler0, atelier_lookup(atelier_p - inwards));
            float red = texture2D(cogl_sampler0, atelier_lookup(atelier_p - inwards * (1.0 + glassLens.z))).r;
            float blue = texture2D(cogl_sampler0, atelier_lookup(atelier_p - inwards * (1.0 - glassLens.z))).b;
            color = vec4(red, middle.g, blue, middle.a) * cogl_color_in;
            color.rgb = min(color.rgb, vec3(color.a));
        }
    }
    float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    color.rgb = clamp(mix(vec3(luma), color.rgb, glassTone.x) * glassTone.y, 0.0, color.a);
    color.rgb *= 1.0 - glassTone.w;
    color.rgb = mix(color.rgb, vec3(color.a), glassTone.z);
    if (edged > 0.0 && glassRim.w > 0.0) {
        float facing = dot(normal, light);
        float rim = facing >= 0.0 ? mix(glassRim.z, glassRim.x, facing) : mix(glassRim.z, glassRim.y, -facing);
        float across = 1.0 - smoothstep(0.0, glassRim.w, inward - 0.5);
        color.rgb = atelier_light_over(color.rgb, color.a, rim * across);
    }
    if (glassSheen.x > 0.0 && frame.z > 0.0 && frame.w > 0.0) {
        float angle = glassSheen.z + atan(light.x, -light.y);
        vec2 towards = vec2(sin(angle), -cos(angle));
        float span = abs(frame.z * towards.x) + abs(frame.w * towards.y);
        float along = dot(atelier_p - frame.xy - frame.zw * 0.5, towards) / max(span, 1.0) + 0.5;
        float sheen = glassSheen.x * clamp(1.0 - along / max(glassSheen.y, 0.0001), 0.0, 1.0);
        color.rgb = atelier_light_over(color.rgb, color.a, sheen);
    }
    color.rgb += (atelier_hash(floor(gl_FragCoord.xy)) - 0.5) * glassSheen.w * color.a;
    cogl_color_out = clamp(color, 0.0, 1.0) * atelier_cover;
}
`;

/**
 * Where an effect with the material finds its uniforms.
 *
 * @param {Shell.GLSLEffect} effect
 * @returns {object} to give to setMaterial()
 */
export function materialUniforms(effect) {
    return Object.fromEntries(['glassTone', 'glassLens', 'glassRim', 'glassSheen', 'glassArea']
        .map(name => [name, effect.get_uniform_location(name)]));
}

/**
 * @param {Shell.GLSLEffect} effect
 * @param {object} uniforms - from materialUniforms()
 * @param {number[]} area - [width, height] of its actor: the lens looks
 *   nothing up past it
 */
export function setMaterialArea(effect, uniforms, area) {
    effect.set_uniform_float(uniforms.glassArea, 2, area);
}

/**
 * @param {Shell.GLSLEffect} effect
 * @param {object} uniforms - from materialUniforms()
 * @param {object|null} look - LOOK's (lib/glassLook.js), null for none
 * @param {number} scale - pixels in a logical pixel
 */
export function setMaterial(effect, uniforms, look, scale) {
    const {tone, lens, rim, sheen} = materialValues(look, scale);
    effect.set_uniform_float(uniforms.glassTone, 4, tone);
    effect.set_uniform_float(uniforms.glassLens, 4, lens);
    effect.set_uniform_float(uniforms.glassRim, 4, rim);
    effect.set_uniform_float(uniforms.glassSheen, 4, sheen);
}

/** @returns {number} pixels in a logical pixel, as St has it */
export function glassScale() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/**
 * The glass to draw, as the glass-variant setting and GNOME's high contrast
 * have it (lib/glassLook.js resolveVariant()); emits 'changed' when it
 * changes.
 */
export class GlassLook extends EventEmitter {
    /** @param {Gio.Settings} settings - Atelier's */
    constructor(settings) {
        super();
        this._settings = settings;
        const source = Gio.SettingsSchemaSource.get_default();
        const a11y = source.lookup('org.gnome.desktop.a11y.interface', true);
        this._a11y = a11y?.has_key('high-contrast')
            ? new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'}) : null;
        settings.connectObject('changed::glass-variant', () => this._sync(), this);
        this._a11y?.connectObject('changed::high-contrast', () => this._sync(), this);
        this._variant = this._resolve();
    }

    _resolve() {
        return resolveVariant(this._settings.get_string('glass-variant'),
            {highContrast: this._a11y?.get_boolean('high-contrast') ?? false});
    }

    _sync() {
        const variant = this._resolve();
        if (variant === this._variant)
            return;
        this._variant = variant;
        this.emit('changed');
    }

    /** @returns {string} 'regular', 'clear' or 'off' (solid surfaces) */
    get variant() {
        return this._variant;
    }

    /** @returns {object|null} the material (LOOK's), null when off */
    get look() {
        return lookOf(this._variant);
    }

    /** @returns {boolean} whether there is glass at all */
    get glass() {
        return this._variant !== 'off';
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._a11y?.disconnectObject(this);
        this._a11y = null;
    }
}

// Only the grain, over what is drawn already (a blurred wallpaper).
const GRAIN_DECLARATIONS = `
uniform float grain;

float atelier_hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
`;

const GRAIN_CODE = `
cogl_color_out.rgb = clamp(cogl_color_out.rgb +
    (atelier_hash(floor(gl_FragCoord.xy)) - 0.5) * grain * cogl_color_out.a, 0.0, cogl_color_out.a);
`;

/**
 * A fine grain over an actor (a blurred wallpaper's gradients band
 * without it): add it before the blur, so that it comes after it.
 */
export const GrainEffect = GObject.registerClass(
class AtelierGrainEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._grain = this.get_uniform_location('grain');
        this.setGrain(0);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, GRAIN_DECLARATIONS, GRAIN_CODE, false);
    }

    /** @param {number} amount - its amplitude, 0 … 1 */
    setGrain(amount) {
        this.set_uniform_float(this._grain, 1, [amount]);
        this.queue_repaint();
    }
});
