// Liquid Glass on the GPU: the material every glass surface of Atelier's is
// drawn with (lib/glassLook.js says how it looks) – one GLSL snippet after
// the texture lookup of a Shell.GLSLEffect, whose texture is what is behind
// the surface, sharp (its actor, painted offscreen). The snippet looks that
// texture up again where the lens has it, blurred with a few taps of its
// own (cogl_sampler0, at coordinates of its own), which GNOME 48 to 50 all
// allow.
//
// Each effect declares its shape, as signed distances in pixels of its
// actor (below 0 inside):
//
//   float atelier_shape(vec2 p) – what the surface covers;
//   float atelier_body(vec2 p) – the glass it is part of, for the lens and
//     the edges: the shape, or more (a surface on the screen's edge goes on
//     past it; the island's glass in the one island is one glass with it);
//   float atelier_others(vec2 p) – of that glass, what other surfaces draw
//     (the one island's, for the island's glass): they draw its contour
//     and shadow there;
//   void atelier_part(vec2 p, out vec2 light, out vec2 shade, out float
//     thick) – where the light comes from at p, the glass's extra shade
//     there [dim, veil] and the short side of the part of it p is in
//     (its own rectangle, a drop, the one island…), in pixels.
//
// And, where it defines them (#define before the material's declarations):
//
//   ATELIER_OWN_NORMAL: vec2 atelier_normal(vec2 p) – the body's outward
//     normal at p, a unit vector (none, shorter than a half: no edge there),
//     for a body whose distances are not smooth enough to take it from
//     (the lock screen's clock: its figures' distances read from a texture,
//     the normal stored with them);
//   ATELIER_WASH: vec4 atelier_wash – a colour [r, g, b] the glass is
//     washed towards after its shade, as much as a (the clock's tone, as
//     its legibility plan has it).
//
// Then, only within the bounds it may draw in (glassReach):
// - the lens: within a bevel of the body's edge, what is behind is looked
//   up farther in, along the body's normal (its gradient: shapes merged by
//   a smooth minimum bend as one), the more the nearer the edge, its outer
//   part a mirrored, squeezed copy (lib/glassLook.js lensDepth()) – right
//   at the edge, where that changes fastest, a few taps more against
//   shimmer;
// - what is behind, lightly blurred (lib/glassLook.js blurTaps());
// - its face: neutral glass, lighter or darker as GNOME's style has it, a
//   small control's dark glass lighter (atelier_face, lib/glassLook.js
//   faceColor());
// - the extra shade, as a wash: dimmed under light type, veiled under
//   dark;
// - its volume: a little darker towards its edge, inside;
// - the glint: a thin bright line on the edge facing the light and on the
//   opposite one;
// - a fine grain, against banding;
// - and outside its body (not past a screen's edge, nor where another
//   surface's glass goes on): a fine contour, and a soft shadow.
// Without the material (lens.w 0: solid surfaces, the glass turned off)
// the shape is only cut out, as it always was.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {EDGE, LENS_SHARE, NO_SHADE, SMALL, lookOf, materialValues, resolveVariant, sameShade} from '../../lib/glassLook.js';

// How long glass takes to take another shade, ms.
const SHADE_TIME = 250;
/** How long glass takes to turn from GNOME's dark style to its light one, ms. */
export const STYLE_TIME = 700;

const UNIFORMS = ['glassLens', 'glassBlur', 'glassFace', 'glassLightFace', 'glassSmall', 'glassGlint',
    'glassEdge', 'glassStyle', 'glassShadow', 'glassReach', 'glassArea'];

export const MATERIAL_DECLARATIONS = `
uniform vec4 glassLens;
uniform vec4 glassBlur;
uniform vec4 glassFace;
uniform vec4 glassLightFace;
uniform vec2 glassStyle;
uniform vec4 glassSmall;
uniform vec4 glassGlint;
uniform vec4 glassEdge;
uniform vec4 glassShadow;
uniform vec4 glassReach;
uniform vec2 glassArea;

vec2 atelier_lookup(vec2 p) {
    return (clamp(p, vec2(0.5), glassArea - vec2(0.5)) - origin) / size;
}

vec4 atelier_tap(vec2 p) {
    return texture2D(cogl_sampler0, atelier_lookup(p));
}

// What is behind at p, blurred: one tap, five or nine (lib/glassLook.js
// blurTaps()), unpremultiplied.
vec3 atelier_behind(vec2 p) {
    float h = glassBlur.y;
    float w = glassBlur.z;
    vec4 sum;
    if (glassBlur.x < 2.0) {
        sum = atelier_tap(p);
    } else if (glassBlur.x < 6.0) {
        sum = atelier_tap(p) * (1.0 - 4.0 * w) + (atelier_tap(p + vec2(h, h)) + atelier_tap(p + vec2(-h, h)) +
            atelier_tap(p + vec2(h, -h)) + atelier_tap(p + vec2(-h, -h))) * w;
    } else {
        sum = vec4(0.0);
        for (int i = -1; i <= 1; i++) {
            for (int j = -1; j <= 1; j++) {
                float wx = i == 0 ? 1.0 - 2.0 * w : w;
                float wy = j == 0 ? 1.0 - 2.0 * w : w;
                sum += atelier_tap(p + vec2(float(i), float(j)) * h) * (wx * wy);
            }
        }
    }
    return sum.rgb / max(sum.a, 0.0001);
}

float atelier_luma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// A face's neutral transfer (lib/glassLook.js FACES): [lift, T, λ, g].
vec3 atelier_face(vec3 c, vec4 face) {
    float y = atelier_luma(c);
    return vec3(face.x + face.y * y * (1.0 + face.z * (1.0 - y))) + face.w * (c - vec3(y));
}

// How far in the lens looks, d in from the edge (lib/glassLook.js lensDepth()).
float atelier_lens(float d, float bevel, float depth) {
    float u = 1.0 - clamp(d / max(bevel, 0.0001), 0.0, 1.0);
    return depth * (1.0 - sqrt(max(1.0 - u * u, 0.0)));
}

// What the lens shows at p, d in from the edge whose outward normal is n.
vec3 atelier_bent(vec2 p, vec2 n, float d, float bevel, float depth) {
    float shift = atelier_lens(d, bevel, depth);
    vec3 c = atelier_behind(p - n * shift);
    if (glassLens.z > 0.0) {
        c.r = atelier_behind(p - n * shift * (1.0 + glassLens.z)).r;
        c.b = atelier_behind(p - n * shift * (1.0 - glassLens.z)).b;
    }
    return c;
}

float atelier_hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
`;

// (Premultiplied colours in and out: the texture's, and the actor's
// opacity in cogl_color_in. Lengths in the actor's pixels; glassSmall.z
// is how many of them make a logical pixel, glassSmall.w how wide a texel
// of its texture is.)
export const MATERIAL_CODE = `
vec2 atelier_uv = cogl_tex_coord_in[0].xy;
vec2 atelier_p = origin + atelier_uv * size;
if (glassLens.w < 0.5) {
    cogl_color_out *= clamp(0.5 - atelier_shape(atelier_p), 0.0, 1.0);
} else if (atelier_p.x < glassReach.x || atelier_p.y < glassReach.y ||
    atelier_p.x > glassReach.z || atelier_p.y > glassReach.w) {
    cogl_color_out = vec4(0.0);
} else {
    vec2 p = atelier_p;
    float shape = atelier_shape(p);
    float cover = clamp(0.5 - shape, 0.0, 1.0);
    float body = atelier_body(p);
    vec2 light;
    vec2 shade;
    float thick;
    atelier_part(p, light, shade, thick);
    vec2 across = vec2(-light.y, light.x);
    float d = -body;
    // (lib/glassLook.js lensOf().)
    float large = smoothstep(${LENS_SHARE.between[0]}.0 * glassSmall.z, ${LENS_SHARE.between[1]}.0 * glassSmall.z, thick);
    float bevel = min(glassLens.x, thick * mix(${LENS_SHARE.small[0]}, ${LENS_SHARE.large[0]}, large));
    float depth = min(glassLens.y, thick * mix(${LENS_SHARE.small[1]}, ${LENS_SHARE.large[1]}, large));
    vec2 normal = vec2(0.0);
    bool edged = false;
    if (d < max(max(bevel, glassEdge.y), glassGlint.w) + 1.0 && body < glassEdge.z + 1.5) {
#ifdef ATELIER_OWN_NORMAL
        normal = atelier_normal(p);
        edged = dot(normal, normal) > 0.25;
#else
        vec2 slope = vec2(atelier_body(p + vec2(1.0, 0.0)) - body, atelier_body(p + vec2(0.0, 1.0)) - body);
        float steep = length(slope);
        if (steep > 0.0001) {
            normal = slope / steep;
            edged = true;
        }
#endif
    }
    float side = abs(dot(normal, across));
    vec4 outside = vec4(0.0);
    if (cover < 1.0) {
        // (Past all of the glass this is one with only: not into another
        // surface's, nor past a screen's edge.)
        float keep = 1.0 - clamp(shape - body, 0.0, 1.0);
        float contour = 0.0;
        if (edged && body < atelier_others(p)) {
            float band = clamp(glassEdge.z + 0.5 - body, 0.0, 1.0);
            contour = mix(glassEdge.w, glassStyle.y, glassStyle.x) *
                (${EDGE.contour.least} + ${1 - EDGE.contour.least} * side) * band;
        }
        float shadow = 0.0;
        if (glassShadow.z > 0.0) {
            vec2 q = p - vec2(0.0, glassShadow.x);
            float under = atelier_body(q);
            if (under < atelier_others(q))
                shadow = glassShadow.z / (1.0 + exp(min(1.702 * under / glassShadow.y, 30.0)));
        }
        outside = vec4(0.0, 0.0, 0.0, (1.0 - (1.0 - contour) * (1.0 - shadow)) * keep);
    }
    vec4 glass = vec4(0.0);
    if (cover > 0.0) {
        vec3 c;
        if (edged && d < bevel) {
            c = atelier_bent(p, normal, d, bevel, depth);
            // (Right at the edge the lens looks up what changes fastest
            // there: what the pixel covers, averaged.)
            if (d < 2.0 * glassSmall.z) {
                float t = glassSmall.w / 3.0;
                c = (c + atelier_bent(p - normal * t, normal, d + t, bevel, depth) +
                    atelier_bent(p + normal * t, normal, max(d - t, 0.0), bevel, depth)) / 3.0;
            }
        } else {
            c = atelier_behind(p);
        }
        float small = 1.0 - smoothstep(${SMALL[0]}.0 * glassSmall.z, ${SMALL[1]}.0 * glassSmall.z, thick);
        // (GNOME's style's face: the dark one, the light one, or on its
        // way from one to the other.)
        vec3 f = mix(atelier_face(c, vec4(glassFace.x, mix(glassFace.y, glassSmall.x, small),
            mix(glassFace.z, glassSmall.y, small), glassFace.w)), atelier_face(c, glassLightFace), glassStyle.x);
        f = clamp(f, 0.0, 1.0);
        f *= 1.0 - shade.x;
        f = mix(f, vec3(1.0), shade.y);
#ifdef ATELIER_WASH
        f = mix(f, atelier_wash.rgb, atelier_wash.a);
#endif
        float rim = 1.0 - clamp(d / max(glassEdge.y, 0.0001), 0.0, 1.0);
        f *= 1.0 - glassEdge.x * rim * rim;
        if (edged) {
            float lit = dot(normal, light) >= 0.0 ? 1.0 : glassGlint.y;
            float glint = glassGlint.x * (${EDGE.glint.least} + ${1 - EDGE.glint.least} * (1.0 - side)) * lit *
                (clamp(1.0 - d / glassGlint.z, 0.0, 1.0) +
                ${EDGE.glint.share} * clamp(1.0 - d / glassGlint.w, 0.0, 1.0));
            f = mix(f, vec3(${EDGE.glint.white}) + ${EDGE.glint.colour} * (f - vec3(atelier_luma(f))), glint);
        }
        f += (atelier_hash(floor(gl_FragCoord.xy)) - 0.5) * glassBlur.w;
        glass = vec4(clamp(f, 0.0, 1.0), 1.0);
    }
    cogl_color_out = (glass * cover + outside * (1.0 - cover)) * cogl_color_in.a;
}
`;

/**
 * Where an effect with the material finds its uniforms.
 *
 * @param {Shell.GLSLEffect} effect
 * @returns {object} to give to setMaterial()
 */
export function materialUniforms(effect) {
    return Object.fromEntries(UNIFORMS.map(name => [name, effect.get_uniform_location(name)]));
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
 * @param {number[]|null} reach - [x1, y1, x2, y2] in its actor: nothing is
 *   drawn past it (its shapes, their contour and shadow); null: nothing at
 *   all
 */
export function setMaterialReach(effect, uniforms, reach) {
    effect.set_uniform_float(uniforms.glassReach, 4, reach ?? [0, 0, -1, -1]);
}

/**
 * @param {Shell.GLSLEffect} effect
 * @param {object} uniforms - from materialUniforms()
 * @param {object|null} look - LOOK's (lib/glassLook.js), null for none
 * @param {number} scale - pixels in a logical pixel
 * @param {object} [options] - as lib/glassLook.js materialValues() takes
 *   them: {light, shadow, density}
 */
export function setMaterial(effect, uniforms, look, scale, options = {}) {
    const values = materialValues(look, scale, options);
    const density = options.density ?? 1;
    effect.set_uniform_float(uniforms.glassLens, 4, values.lens);
    effect.set_uniform_float(uniforms.glassBlur, 4, values.blur);
    effect.set_uniform_float(uniforms.glassFace, 4, values.face);
    effect.set_uniform_float(uniforms.glassLightFace, 4, values.lightFace);
    effect.set_uniform_float(uniforms.glassStyle, 2, values.style);
    effect.set_uniform_float(uniforms.glassSmall, 4, [values.small[0], values.small[1], scale, 1 / density]);
    effect.set_uniform_float(uniforms.glassGlint, 4, values.glint);
    effect.set_uniform_float(uniforms.glassEdge, 4, values.edge);
    effect.set_uniform_float(uniforms.glassShadow, 4, values.shadow);
}

/**
 * @param {Clutter.Actor} actor
 * @returns {number} texels of its offscreen texture in one of its pixels:
 *   its resource scale, rounded up (lib/glassLook.js textureFrame())
 */
export function textureDensity(actor) {
    return Math.ceil(actor.get_resource_scale?.() ?? 1);
}

/** @returns {number} pixels in a logical pixel, as St has it */
export function glassScale() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/**
 * The glass to draw, as the glass-variant setting and GNOME's high contrast
 * have it (lib/glassLook.js resolveVariant()), light or smoky as GNOME's
 * style is; emits 'changed' when it changes.
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
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        settings.connectObject('changed::glass-variant', () => this._sync(), this);
        this._a11y?.connectObject('changed::high-contrast', () => this._sync(), this);
        this._interface.connectObject('changed::color-scheme', () => this._sync(), this);
        [this._variant, this._light] = this._resolve();
    }

    _resolve() {
        return [
            resolveVariant(this._settings.get_string('glass-variant'),
                {highContrast: this._a11y?.get_boolean('high-contrast') ?? false}),
            this._interface.get_string('color-scheme') !== 'prefer-dark',
        ];
    }

    _sync() {
        const [variant, light] = this._resolve();
        if (variant === this._variant && light === this._light)
            return;
        [this._variant, this._light] = [variant, light];
        this.emit('changed');
    }

    /** @returns {boolean} whether GNOME's style is light: light glass, else smoky */
    get light() {
        return this._light;
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
        this._interface?.disconnectObject(this);
        this._interface = null;
    }
}

/**
 * The extra shades of a glass ({dim, veil}: darker under light type,
 * lighter under dark, where it would not read otherwise – or anything else
 * of numbers eased as they are, as {light}), each by a key – a surface has
 * one, the widgets' glass one for each widget – eased to what they are to
 * be over SHADE_TIME (or a time of their own): at once with GNOME's
 * animations off (its setting, as the light has it: St's is forced on in
 * the tests) or the glass not shown. Only uniforms change meanwhile.
 */
export class GlassShades {
    /**
     * @param {Clutter.Actor} actor - the glass, whose frames ease them
     * @param {Function} onChange - (keys) => the shades of these keys as
     *   they are now (shown()) are to go to the GPU
     */
    constructor(actor, onChange) {
        this._actor = actor;
        this._onChange = onChange;
        this._from = new Map();
        this._to = new Map();
        this._timeline = null;
        // (Asked once a shade changes: glass that never takes one – solid,
        // say – never asks.)
        this._interface = null;
    }

    /**
     * @param {*} key
     * @returns {object} its shade as it is now, {dim, veil}
     */
    shown(key) {
        const to = this.wanted(key);
        const from = this._from.get(key) ?? to;
        const t = this._timeline ? this._timeline.get_progress() : 1;
        return Object.fromEntries(Object.keys({...from, ...to}).map(name =>
            [name, (from[name] ?? 0) + ((to[name] ?? 0) - (from[name] ?? 0)) * t]));
    }

    /**
     * @param {*} key
     * @returns {object} the shade it is to have, {dim, veil}
     */
    wanted(key) {
        return this._to.get(key) ?? NO_SHADE;
    }

    /**
     * @param {*} key
     * @param {object} shade - {dim, veil} it is to have
     * @param {number} [duration] - how long it takes to get there, ms
     */
    set(key, shade, duration = SHADE_TIME) {
        if (sameShade(shade, this.wanted(key)))
            return;
        // (Each from where it is now: one on its way goes on from there.)
        for (const other of new Set([...this._to.keys(), key]))
            this._from.set(other, this.shown(other));
        this._to.set(key, {...shade});
        this._timeline?.stop();
        this._timeline = null;
        this._interface ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const animated = this._actor.mapped && St.Settings.get().enable_animations &&
            this._interface.get_boolean('enable-animations');
        if (!animated) {
            this._settle();
            return;
        }
        const timeline = new Clutter.Timeline({
            actor: this._actor,
            duration: duration * St.Settings.get().slow_down_factor,
            progress_mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        const moving = [...this._to.keys()].filter(other => !sameShade(this._from.get(other), this.wanted(other)));
        timeline.connect('new-frame', () => this._onChange(moving));
        timeline.connect('completed', () => {
            if (this._timeline === timeline)
                this._settle();
        });
        this._timeline = timeline;
        timeline.start();
    }

    /** @param {*} key - one gone */
    delete(key) {
        this._from.delete(key);
        this._to.delete(key);
    }

    // Each as it is to be.
    _settle() {
        const changed = [...this._to.keys()].filter(key => !sameShade(this._from.get(key) ?? NO_SHADE, this.wanted(key)));
        this._timeline?.stop();
        this._timeline = null;
        this._from = new Map(this._to);
        this._onChange(changed);
    }

    destroy() {
        this._timeline?.stop();
        this._timeline = null;
        this._interface = null;
        this._onChange = () => {};
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
