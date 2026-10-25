// A second texture for a Shell.GLSLEffect: pixels of Atelier's own (a
// shape's signed distances, say: lib/glyphSdf.js) that the effect's snippet
// reads as cogl_sampler1, next to what the effect draws in cogl_sampler0.
//
// Clutter builds an offscreen effect's pipeline in create_pipeline(), which
// GJS can't override; but the pipeline it built is there in paint_target()
// (get_pipeline()), before it is drawn with: the texture goes on as its
// layer 1 there, every time, so that a pipeline built anew (the actor's
// size changing) has it too. Layer 1 leaves the colour as layer 0 made it
// (REPLACE(PREVIOUS)), so only the snippet reads it, at coordinates of its
// own: the quad Clutter draws has none for it.
//
// The texels go in as they are, premultiplied RGBA bytes
// (Cogl.PixelFormat.RGBA_8888_PRE): Cogl converts nothing, and the snippet
// reads back each byte / 255 – any values in R, G and B, whatever A says.
//
//   const shape = new ShapeTexture({filter: 'linear'});
//   shape.setPixels(bytes, width, height);
//   ... in the effect's vfunc_paint_target(node, paintContext):
//   shape.bind(this);
//   super.vfunc_paint_target(node, paintContext);
//
// Its snippet declares SHAPE_DECLARATIONS (after the uniforms it uses) and
// sets where the texture lies with setShapeRect(): atelier_shape_texel(p),
// at p in the actor's pixels, is the texel there (clamped to its edge).

import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import St from 'gi://St';

export const SHAPE_LAYER = 1;

export const SHAPE_DECLARATIONS = `
uniform vec4 shapeRect;

vec4 atelier_shape_texel(vec2 p) {
    return texture2D(cogl_sampler1, (p - shapeRect.xy) / shapeRect.zw);
}
`;

const FILTERS = {
    nearest: Cogl.PipelineFilter.NEAREST,
    linear: Cogl.PipelineFilter.LINEAR,
};

const coglContext = () => global.stage.context.get_backend().get_cogl_context();

// What layer 1 has while there are no pixels yet: one clear texel. (Without
// a layer 1 the snippet's cogl_sampler1 would not exist, and it would not
// compile.)
let clearContent = null;

function clearTexture() {
    if (!clearContent) {
        clearContent = St.ImageContent.new_with_preferred_size(1, 1);
        clearContent.set_bytes(coglContext(), new GLib.Bytes(new Uint8Array(4)),
            Cogl.PixelFormat.RGBA_8888_PRE, 1, 1, 4);
    }
    return clearContent.get_texture();
}

export class ShapeTexture {
    /**
     * @param {object} [params]
     * @param {string} [params.filter] - 'linear' (between texels) or 'nearest'
     */
    constructor({filter = 'linear'} = {}) {
        this._filter = filter;
        this._content = null;
        this._width = 0;
        this._height = 0;
        // The effects it was bound to, drawn again when it changes; and the
        // pipeline each had then, set up for it.
        this._effects = new Map();
    }

    /** @returns {number[]} [width, height] in texels, [0, 0] with none */
    get size() {
        return [this._width, this._height];
    }

    /**
     * Its texels, anew: rows of premultiplied RGBA bytes.
     *
     * @param {Uint8Array} bytes
     * @param {number} width
     * @param {number} height
     * @param {number} [rowstride] - bytes from one row to the next
     */
    setPixels(bytes, width, height, rowstride = width * 4) {
        // (A new content each time: one of a size is not to be filled with
        // another's.)
        if (!this._content || width !== this._width || height !== this._height)
            this._content = St.ImageContent.new_with_preferred_size(width, height);
        this._content.set_bytes(coglContext(), new GLib.Bytes(bytes), Cogl.PixelFormat.RGBA_8888_PRE,
            width, height, rowstride);
        this._width = width;
        this._height = height;
        // (Only the effect is drawn again, over what its actor drew.)
        for (const effect of this._effects.keys())
            effect.queue_repaint();
    }

    /** @param {string} filter - 'linear' or 'nearest' */
    setFilter(filter) {
        if (filter === this._filter)
            return;
        this._filter = filter;
        for (const effect of this._effects.keys()) {
            this._effects.set(effect, null);
            effect.queue_repaint();
        }
    }

    /**
     * The texture as layer 1 of an effect's pipeline: from its
     * vfunc_paint_target(), before it chains up.
     *
     * @param {Clutter.OffscreenEffect} effect
     */
    bind(effect) {
        const pipeline = effect.get_pipeline();
        if (!pipeline)
            return;
        pipeline.set_layer_texture(SHAPE_LAYER, this._content?.get_texture() ?? clearTexture());
        if (this._effects.get(effect) === pipeline)
            return;
        pipeline.set_layer_combine(SHAPE_LAYER, 'RGBA = REPLACE(PREVIOUS)');
        pipeline.set_layer_wrap_mode(SHAPE_LAYER, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
        const filter = FILTERS[this._filter] ?? FILTERS.linear;
        pipeline.set_layer_filters(SHAPE_LAYER, filter, filter);
        this._effects.set(effect, pipeline);
    }

    /** @param {Clutter.OffscreenEffect} effect - no longer drawn again for it */
    unbind(effect) {
        this._effects.delete(effect);
    }

    destroy() {
        this._effects.clear();
        this._content = null;
    }
}

/**
 * Where an effect's snippet finds the texture: its rect in the actor.
 *
 * @param {Shell.GLSLEffect} effect
 * @param {number} location - of shapeRect (get_uniform_location())
 * @param {number[]} rect - [x, y, width, height] in the actor's pixels
 */
export function setShapeRect(effect, location, rect) {
    effect.set_uniform_float(location, 4, rect);
}
