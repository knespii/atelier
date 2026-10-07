// Liquid on the screen: the shapes of lib/liquid.js (rounded boxes and
// capsules), melted together where they come near each other, and filled
// with the color of what turns into them – a card's, say, with its shadow.
// A mask of glass may take them too (LIQUID_* below).

import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {syncTextureFrame} from './glass.js';

export const MAX_BOXES = 24;
export const MAX_CAPSULES = 12;

// The shapes' distance from a point (in pixels of the actor): below 0
// inside. Within its blend of what came before it, a shape melts into it
// (a smooth minimum). An area may be left out: what the liquid flows out
// of, drawn by itself (a pixel of it stays, so no seam shows).
export const LIQUID_DECLARATIONS = `
uniform vec4 liquidBoxes[${MAX_BOXES}];
uniform vec2 liquidBoxLook[${MAX_BOXES}];
uniform float liquidBoxCount;
uniform vec4 liquidCapsules[${MAX_CAPSULES}];
uniform vec2 liquidCapsuleLook[${MAX_CAPSULES}];
uniform float liquidCapsuleCount;
uniform vec4 liquidHole;
uniform float liquidHoleRadius;

float atelier_liquid_smin(float a, float b, float k) {
    if (k <= 0.0)
        return min(a, b);
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

float atelier_liquid_box(vec2 p, vec2 center, vec2 halfSize, float radius) {
    vec2 q = abs(p - center) - halfSize + vec2(radius);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float atelier_liquid(vec2 p) {
    float d = 100000.0;
    for (int i = 0; i < ${MAX_BOXES}; i++) {
        if (float(i) >= liquidBoxCount)
            break;
        float b = atelier_liquid_box(p, liquidBoxes[i].xy, liquidBoxes[i].zw, liquidBoxLook[i].x);
        d = atelier_liquid_smin(d, b, liquidBoxLook[i].y);
    }
    for (int i = 0; i < ${MAX_CAPSULES}; i++) {
        if (float(i) >= liquidCapsuleCount)
            break;
        vec2 pa = p - liquidCapsules[i].xy;
        vec2 ba = liquidCapsules[i].zw - liquidCapsules[i].xy;
        float s = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
        d = atelier_liquid_smin(d, length(pa - ba * s) - liquidCapsuleLook[i].x, liquidCapsuleLook[i].y);
    }
    if (liquidHole.z > 0.0) {
        float hole = atelier_liquid_box(p, liquidHole.xy, liquidHole.zw - vec2(1.0), max(liquidHoleRadius - 1.0, 0.0));
        d = max(d, -hole);
    }
    return d;
}
`;

/**
 * Where an effect with LIQUID_DECLARATIONS finds its uniforms.
 *
 * @param {Shell.GLSLEffect} effect
 * @returns {object} to give to setLiquid()
 */
export function liquidUniforms(effect) {
    const names = ['liquidBoxes', 'liquidBoxLook', 'liquidBoxCount', 'liquidCapsules', 'liquidCapsuleLook',
        'liquidCapsuleCount', 'liquidHole', 'liquidHoleRadius'];
    return Object.fromEntries(names.map(name => [name, effect.get_uniform_location(name)]));
}

/**
 * @param {Shell.GLSLEffect} effect
 * @param {object} uniforms - from liquidUniforms()
 * @param {object} shapes - {boxes, capsules} (lib/liquid.js)
 * @param {number[]|null} [hole] - [x, y, width, height, radius] left out
 */
export function setLiquid(effect, uniforms, {boxes = [], capsules = []}, hole = null) {
    const fill = (shapes, max) => {
        const where = new Array(max * 4).fill(0);
        const look = new Array(max * 2).fill(0);
        shapes.slice(0, max).forEach((shape, i) => {
            where.splice(i * 4, 4, ...shape.slice(0, 4));
            look.splice(i * 2, 2, shape[4], shape[5] ?? 0);
        });
        return [where, look, Math.min(shapes.length, max)];
    };
    const [boxWhere, boxLook, boxCount] = fill(boxes, MAX_BOXES);
    const [capsuleWhere, capsuleLook, capsuleCount] = fill(capsules, MAX_CAPSULES);
    effect.set_uniform_float(uniforms.liquidBoxes, 4, boxWhere);
    effect.set_uniform_float(uniforms.liquidBoxLook, 2, boxLook);
    effect.set_uniform_float(uniforms.liquidBoxCount, 1, [boxCount]);
    effect.set_uniform_float(uniforms.liquidCapsules, 4, capsuleWhere);
    effect.set_uniform_float(uniforms.liquidCapsuleLook, 2, capsuleLook);
    effect.set_uniform_float(uniforms.liquidCapsuleCount, 1, [capsuleCount]);
    const [x, y, width, height, radius] = hole ?? [0, 0, 0, 0, 0];
    effect.set_uniform_float(uniforms.liquidHole, 4, [x + width / 2, y + height / 2, width / 2, height / 2]);
    effect.set_uniform_float(uniforms.liquidHoleRadius, 1, [radius]);
    effect.queue_repaint();
}

// Filled with a color, over a shadow as St draws one (near enough: its
// blur a gaussian's two sigmas).
const PAINT_DECLARATIONS = `
uniform vec2 origin;
uniform vec2 size;
uniform vec4 color;
uniform vec4 shadow;
uniform vec3 shadowShape;
${LIQUID_DECLARATIONS}
`;

const PAINT_CODE = `
vec2 p = origin + cogl_tex_coord_in[0].xy * size;
float cover = clamp(0.5 - atelier_liquid(p), 0.0, 1.0);
float shade = 0.0;
if (shadow.a > 0.0) {
    float blur = max(shadowShape.z, 0.5);
    shade = shadow.a * (1.0 - smoothstep(-blur, blur, atelier_liquid(p - shadowShape.xy)));
}
vec4 fill = vec4(color.rgb * color.a, color.a) * cover;
cogl_color_out = fill + vec4(shadow.rgb * shade, shade) * (1.0 - fill.a);
`;

const LiquidPaintEffect = GObject.registerClass(
class AtelierLiquidPaintEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._origin = this.get_uniform_location('origin');
        this._size = this.get_uniform_location('size');
        this._color = this.get_uniform_location('color');
        this._shadow = this.get_uniform_location('shadow');
        this._shadowShape = this.get_uniform_location('shadowShape');
        this.uniforms = liquidUniforms(this);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, PAINT_DECLARATIONS, PAINT_CODE, false);
    }

    vfunc_paint_target(node, paintContext) {
        syncTextureFrame(this, this._origin, this._size);
        super.vfunc_paint_target(node, paintContext);
    }

    setLook(color, shadow, shadowShape) {
        this.set_uniform_float(this._color, 4, color);
        this.set_uniform_float(this._shadow, 4, shadow);
        this.set_uniform_float(this._shadowShape, 3, shadowShape);
        this.queue_repaint();
    }
});

const channels = color => [color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255];

/**
 * Liquid, filling an area: put it where it flows (its shapes are in its
 * own pixels), give it the look of what turns into it with setLook(), and
 * its shapes with setShapes() every frame.
 */
export const LiquidPaint = GObject.registerClass(
class AtelierLiquidPaint extends St.Widget {
    _init(params = {}) {
        super._init({reactive: false, clip_to_allocation: true, ...params});
        Shell.util_set_hidden_from_pick(this, true);
        // (Something to paint, for the effect to fill in.)
        this.background_color = Cogl.Color.from_string('black')[1];
        this._paint = new LiquidPaintEffect();
        this.add_effect_with_name('atelier-liquid', this._paint);
        this.setShapes({});
        this._paint.setLook([0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0]);
    }

    /**
     * As an actor is drawn: its background's color, and its shadow.
     *
     * @param {St.Widget} actor - (mapped, so it is styled)
     */
    setLook(actor) {
        const node = actor.get_theme_node();
        const shadow = node.get_box_shadow();
        this._paint.setLook(
            channels(node.get_background_color()),
            shadow ? channels(shadow.color) : [0, 0, 0, 0],
            shadow ? [shadow.xoffset, shadow.yoffset, shadow.blur] : [0, 0, 0]);
    }

    /**
     * @param {object} shapes - {boxes, capsules} (lib/liquid.js)
     * @param {number[]|null} [hole] - [x, y, width, height, radius] left out
     */
    setShapes(shapes, hole = null) {
        setLiquid(this._paint, this._paint.uniforms, shapes, hole);
    }
});
