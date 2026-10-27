// Atelier's glass: the wallpaper under a surface, drawn as Liquid Glass
// (shell/core/glassMaterial.js) – lightly blurred, bending at its edges,
// which catch the light. For a while, it may be live glass instead: of what
// is under it now, the windows too. A surface is the wallpaper of the top
// of its monitor (or of another edge, for a dock), masked to a rounded
// rectangle that can move and change size every frame (the island growing)
// without anything but the shader's uniforms changing – and to a drop
// beside it, which melts into it where they meet (the island dripping).

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    REST_LIGHT, bodyRect, boundsOf, edgeReach, sameLight, textureFrame,
} from '../../lib/glassLook.js';
import {glassLight} from './glassLight.js';
import {
    GlassEasing, MATERIAL_CODE, MATERIAL_DECLARATIONS, glassScale, materialUniforms, setMaterial, setMaterialArea,
    STYLE_TIME, setMaterialReach, textureDensity,
} from './glassMaterial.js';

// Live glass shows the windows over the bounds of its shapes, in steps of
// this many logical pixels (so it isn't laid out anew every frame they
// change).
const LIVE_STEP = 64;

// A surface is only as large as its shapes need (and as far round as their
// contour, shadow and blur go), in steps of this many logical pixels, within
// its part of the monitor: what it is painted into offscreen, and drawn
// again whenever what is behind changes, is no larger. (Monitor-wide, the
// island's glass was 1704 × 959 logical pixels at 150 %, drawn whole every
// frame it grew into the control centre.)
const FIT_STEP = 64;

// How much nearer or farther a partner's shape is taken to be, in pixels,
// so that where it is as near as a surface's own, only one of them draws
// the contour and the shadow (GlassSurface's yields).
const TIE = 0.05;

// Pixels outside the rounded rectangle are dropped; its edge gets one pixel
// of antialiasing. Everything is in pixels of the actor. The top and the
// bottom corners may differ (a notch has square top corners), and a notch
// may have ears: beside its top corners, squares less a quarter circle,
// where it curves into the top edge. (They reach a pixel into the notch and
// above it, so no seam shows.) The drop is a rounded rectangle too, and its
// neck a thin upright capsule (from the island to the drop, as it hangs),
// joined with a smooth minimum: within blend pixels of each other, they flow
// together like liquid.
// The glass's body is the same, but past the screen's edges the rectangle
// lies on (body), and one with another surface's shape this one lies in
// (partner: the one island the island's glass is in) – they are one glass,
// whose edges each draws where its own shape is the nearer.
const SHAPE_DECLARATIONS = `
#define ATELIER_OWN_BODY
uniform vec2 origin;
uniform vec2 size;
uniform vec4 rect;
uniform vec4 body;
uniform vec2 radii;
uniform float ear;
uniform vec4 drop;
uniform float dropRadius;
uniform vec4 neck;
uniform float blend;
uniform vec4 partner;
uniform vec4 partnerBody;
uniform vec3 partnerLook;
uniform float partnerTie;
uniform vec2 glassLight;

float atelier_smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

float atelier_box(vec2 p, vec2 center, vec2 halfSize) {
    vec2 q = abs(p - center) - halfSize;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

float atelier_rounded(vec2 p, vec4 r, vec2 corners) {
    vec2 halfSize = r.zw * 0.5;
    vec2 center = r.xy + halfSize;
    float radius = p.y < center.y ? corners.x : corners.y;
    vec2 q = abs(p - center) - halfSize + vec2(radius);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float atelier_ear(vec2 p, float top, float e, float side, float inner, float above) {
    vec2 center = vec2((side + inner) * 0.5, top + (e - above) * 0.5);
    float square = atelier_box(p, center, vec2(abs(inner - side) * 0.5, (e + above) * 0.5));
    return max(square, e - length(p - vec2(side, top + e)));
}

float atelier_notch(vec2 p, vec4 r, vec4 b, vec2 corners, float e) {
    float d = atelier_rounded(p, b, corners);
    if (e > 0.0) {
        // (The body's ears reach well into it, so that where they meet it
        // is no edge.)
        float above = r.y - b.y + 1.0;
        float into = b.y < r.y ? 2.0 * e : 1.0;
        float left = atelier_ear(p, r.y, e, r.x - e, r.x + into, above);
        float right = atelier_ear(p, r.y, e, r.x + r.z + e, r.x + r.z - into, above);
        d = min(d, min(left, right));
        if (d < 0.0) {
            // Inside, as far from its edges as they are – each ear's arc
            // flowing into a side below it, the top beyond them – not from
            // where the rectangle and the ears' squares meet in it: its
            // lens, rim and glint bent along those as along creases (a grey
            // wedge inside each ear). The rectangle without its top, its
            // sides from where the arcs meet them; beside it, the ears'
            // outer sides; the arcs; the top.
            float low = r.y + e;
            float depth;
            if (p.y >= low) {
                depth = -atelier_rounded(p, vec4(b.x, b.y - 4096.0, b.z, b.w + 4096.0), corners);
            } else {
                float sides = max(min(p.x - b.x, b.x + b.z - p.x), 0.0);
                depth = min(length(vec2(sides, low - p.y)), b.y + b.w - p.y);
            }
            depth = min(depth, p.y - (r.y - above));
            depth = min(depth, min(p.x - (r.x - e), r.x + r.z + e - p.x));
            depth = min(depth, min(length(p - vec2(r.x - e, low)), length(p - vec2(r.x + r.z + e, low))) - e);
            d = -depth;
        }
    }
    return d;
}

float atelier_drip(vec2 p, float d) {
    float k = max(blend, 0.001);
    if (neck.w > 0.0) {
        vec2 pa = p - neck.xy;
        vec2 ba = vec2(0.0, neck.z - neck.y);
        float s = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
        d = atelier_smin(d, length(pa - ba * s) - neck.w, k);
    }
    if (drop.z > 0.0 && drop.w > 0.0) {
        vec2 dq = abs(p - drop.xy) - drop.zw + vec2(dropRadius);
        d = atelier_smin(d, length(max(dq, 0.0)) + min(max(dq.x, dq.y), 0.0) - dropRadius, k);
    }
    return d;
}

float atelier_shape(vec2 p) {
    float d = atelier_drip(p, atelier_notch(p, rect, rect, radii, ear));
    // (A pixel of its edge that its partner covers too – their sides one
    // below the one island's ears, their bottoms one at rest – it covers
    // only as much more as it covers: drawn by both, one over the other,
    // its glass showed twice in it, a light line beside the ears. Over or
    // under the partner, the two cover it as much as the more of them.)
    if (partnerTie < 0.0 && d > -0.5 && partner.z > 0.0 && partner.w > 0.0) {
        float own = clamp(0.5 - d, 0.0, 1.0);
        float other = clamp(0.5 - atelier_notch(p, partner, partner, partnerLook.xy, partnerLook.z), 0.0, 1.0);
        if (other > 0.0)
            return 0.5 - max(own - other, 0.0) / max(1.0 - other, 0.0001);
    }
    return d;
}

// (Where the other is as near as its own – the island's glass at rest in
// the one island, their bottoms one; grown out of it, their sides below the
// ears – one of them draws the contour and the shadow there, the one the
// tie goes to (partnerTie a little more, the other one a little less):
// neither did, and the one island had none under the island, nor beside its
// ears as the island grew.)
float atelier_partner(vec2 p) {
    if (partner.z > 0.0 && partner.w > 0.0)
        return atelier_notch(p, partner, partnerBody, partnerLook.xy, partnerLook.z);
    return 100000.0;
}

float atelier_others(vec2 p) {
    return atelier_partner(p) + partnerTie;
}

float atelier_own_body(vec2 p) {
    return atelier_drip(p, atelier_notch(p, rect, body, radii, ear));
}

float atelier_body(vec2 p) {
    return min(atelier_own_body(p), atelier_others(p));
}

// The short side of the part p is in: the rectangle's as it shows (not its
// body's past the screen), a drop's or its neck's where they melt into it,
// the partner's where it is the nearer. (Their rectangles', not their
// ears': where the island's glass and the one island are as near, inside
// as they grow apart, each its own – deeper in the one island's ears, the
// island's glass looked like the one island's down to them.)
void atelier_part(vec2 p, out vec2 light, out float thick) {
    light = glassLight;
    float d = atelier_rounded(p, body, radii);
    thick = min(rect.z, rect.w);
    float k = max(blend, 0.001);
    if (neck.w > 0.0) {
        vec2 pa = p - neck.xy;
        vec2 ba = vec2(0.0, neck.z - neck.y);
        float s = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
        float n = length(pa - ba * s) - neck.w;
        thick = mix(thick, 2.0 * neck.w, clamp(0.5 + 0.5 * (d - n) / k, 0.0, 1.0));
        d = atelier_smin(d, n, k);
    }
    if (drop.z > 0.0 && drop.w > 0.0) {
        vec2 dq = abs(p - drop.xy) - drop.zw + vec2(dropRadius);
        float n = length(max(dq, 0.0)) + min(max(dq.x, dq.y), 0.0) - dropRadius;
        float w = clamp(0.5 + 0.5 * (d - n) / k, 0.0, 1.0);
        thick = mix(thick, 2.0 * min(drop.z, drop.w), w);
        d = atelier_smin(d, n, k);
    }
    if (partner.z > 0.0 && partner.w > 0.0 && atelier_rounded(p, partnerBody, partnerLook.xy) < d)
        thick = min(partner.z, partner.w);
}
${MATERIAL_DECLARATIONS}
`;

/**
 * Tell a mask where its actor is in the texture it paints: Clutter paints
 * the actor into a texture a few pixels larger than the actor (its box,
 * padded), so the texture's coordinates don't map onto the actor one to
 * one. (For actors that clip to their allocation, as these do.)
 *
 * @param {Shell.GLSLEffect} effect
 * @param {number} origin - location of the uniform for the texture's top
 *   left corner, in the actor's coordinates
 * @param {number} size - location of the uniform for its size
 */
export function syncTextureFrame(effect, origin, size) {
    const actor = effect.get_actor();
    if (!actor)
        return;
    // (Whatever its resource scale: lib/glassLook.js textureFrame().)
    const [x, width] = textureFrame(actor.width);
    const [y, height] = textureFrame(actor.height);
    effect.set_uniform_float(origin, 2, [x, y]);
    effect.set_uniform_float(size, 2, [width, height]);
}

const RoundedMaskEffect = GObject.registerClass(
class AtelierRoundedMaskEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        const names = ['origin', 'size', 'rect', 'body', 'radii', 'ear', 'drop', 'dropRadius', 'neck', 'blend',
            'partner', 'partnerBody', 'partnerLook', 'partnerTie', 'glassLight'];
        this._at = Object.fromEntries(names.map(name => [name, this.get_uniform_location(name)]));
        this._material = materialUniforms(this);
        this._look = [null, 1, {}];
        this.setDrop([0, 0, 0, 0], 0, 1);
        this.setNeck([0, 0, 0, 0]);
        this.setPartner(null);
        this.setLight(REST_LIGHT);
        this.setReach(null);
        this.setMaterial(null, 1);
    }

    vfunc_paint_target(node, paintContext) {
        syncTextureFrame(this, this._at.origin, this._at.size);
        // (Its blur's taps are as many texels apart as its texture has.)
        const [look, scale, options] = this._look;
        const density = this.get_actor() ? textureDensity(this.get_actor()) : 1;
        if (look && density !== (options.density ?? 1))
            this.setMaterial(look, scale, {...options, density});
        super.vfunc_paint_target(node, paintContext);
    }

    vfunc_build_pipeline() {
        // After the texture lookup; the color is premultiplied, so all four
        // channels get the mask.
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, SHAPE_DECLARATIONS, MATERIAL_CODE, false);
    }

    /**
     * @param {number[]} size - [width, height] of the actor
     * @param {number[]} rect - [x, y, width, height] relative to the actor
     * @param {number[]} radii - [top, bottom] corner radius
     * @param {number} ear - radius of the ears, 0 for none
     * @param {number[]} [body] - the rect past the screen's edges it lies on
     */
    setShape(size, rect, radii, ear, body = rect) {
        this.set_uniform_float(this._at.origin, 2, [0, 0]);
        this.set_uniform_float(this._at.size, 2, size);
        setMaterialArea(this, this._material, size);
        this.set_uniform_float(this._at.rect, 4, rect);
        this.set_uniform_float(this._at.body, 4, body);
        this.set_uniform_float(this._at.radii, 2, radii);
        this.set_uniform_float(this._at.ear, 1, [ear]);
    }

    /**
     * Another surface's shape this one's glass is one with.
     *
     * @param {object|null} partner - {rect, body, radii, ear} as setShape()
     *   has them, and yields: where they are as near, the other draws the
     *   contour and the shadow; null for none
     */
    setPartner(partner) {
        const {rect = [0, 0, 0, 0], body = rect, radii = [0, 0], ear = 0, yields = false} = partner ?? {};
        this.set_uniform_float(this._at.partner, 4, rect);
        this.set_uniform_float(this._at.partnerBody, 4, body);
        this.set_uniform_float(this._at.partnerLook, 3, [...radii, ear]);
        // (Far more than the distances' rounding, far less than a pixel.)
        this.set_uniform_float(this._at.partnerTie, 1, [yields ? -TIE : TIE]);
    }

    /** @param {number[]} light - where it comes from, [x, y] (y down) */
    setLight(light) {
        this.set_uniform_float(this._at.glassLight, 2, light);
    }

    /** @param {number[]|null} reach - [x1, y1, x2, y2] it draws within */
    setReach(reach) {
        setMaterialReach(this, this._material, reach);
    }

    /**
     * @param {object|null} look - LOOK's, null for only the shape
     * @param {number} scale - pixels in a logical pixel
     * @param {object} [options] - {light, shadow, density, dim} (setMaterial())
     */
    setMaterial(look, scale, options = {}) {
        this._look = [look, scale, options];
        setMaterial(this, this._material, look, scale, options);
        this.queue_repaint();
    }

    /**
     * @param {number[]} drop - [centerX, centerY, halfWidth, halfHeight]
     *   relative to the actor; no width or height for none
     * @param {number} radius - of its corners
     * @param {number} blend - how near it melts into the rectangle
     */
    setDrop(drop, radius, blend) {
        this.set_uniform_float(this._at.drop, 4, drop);
        this.set_uniform_float(this._at.dropRadius, 1, [radius]);
        this.set_uniform_float(this._at.blend, 1, [blend]);
    }

    /**
     * @param {number[]} neck - [centerX, top, bottom, halfWidth] relative to
     *   the actor; no width for none
     */
    setNeck(neck) {
        this.set_uniform_float(this._at.neck, 4, neck);
    }
});

// The windows' group as it is on the stage, one to one, for live glass –
// or any other actor that is as large as the stage. (The group says it has
// no size, and a plain clone scales its source to its own size: by
// infinity, to nothing.)
// A clone is drawn anew whenever anything in what it clones is, and the
// stage with it as far as the clone reaches: told the part of it that
// shows, it has the stage drawn again only there. (Live glass showed all of
// the windows' group: a window drawn anew anywhere had the whole stage
// drawn again, every frame of a spinner far from the glass.)
export const WindowsClone = GObject.registerClass(
class AtelierWindowsClone extends Clutter.Clone {
    vfunc_allocate(box) {
        this.set_allocation(box);
    }

    /**
     * @param {number[]|null} part - [x, y, width, height]: what shows of
     *   it, in its own pixels; null for all of it
     */
    setShown(part) {
        if (part?.join() === this._part?.join())
            return;
        this._part = part;
        // (Its paint volume is worked out anew.)
        this.queue_redraw();
    }

    vfunc_get_paint_volume(volume) {
        if (!this._part)
            return super.vfunc_get_paint_volume(volume);
        const [x, y, width, height] = this._part;
        volume.set_origin(new Graphene.Point3D({x, y, z: 0}));
        volume.set_width(width);
        volume.set_height(height);
        return true;
    }
});

/**
 * A glass surface: put it into the scene (below what stands on it) and
 * give it the rectangle to fill with setShape().
 */
export const GlassSurface = GObject.registerClass(
class AtelierGlassSurface extends St.Widget {
    /**
     * @param {object} [params]
     * @param {number} [params.monitorIndex] - defaults to the primary monitor
     * @param {number} [params.reach] - how far from its edge the monitor
     *   shapes may go, as a fraction of its height (of its width at the
     *   left or the right)
     * @param {string} [params.side] - the monitor's edge the surface is
     *   at: 'TOP' (the default), 'BOTTOM', 'LEFT' or 'RIGHT' (for a dock)
     * @param {boolean} [params.fromBottom] - the same as side 'BOTTOM'
     * @param {boolean} [params.solid] - black instead of glass: the same
     *   shapes, changing every frame without anything being laid out anew
     * @param {object|null} [params.look] - the material (lib/glassLook.js
     *   LOOK's), none for the plain wallpaper; never for solid surfaces
     * @param {boolean} [params.light] - GNOME's style is light: light glass
     *   (else dark)
     * @param {Clutter.Actor} [params.source] - what is behind it, instead
     *   of the wallpaper: an actor as large as the stage, at its corner,
     *   whose picture its glass shows (the lock screen's wallpapers, sharp
     *   or turned to glass); the wallpaper again once it is gone
     * @param {boolean} [params.yields] - where its partner's shape
     *   (setPartner()) is as near as its own, the partner draws their
     *   contour and shadow (the island's glass, in the bar's one island,
     *   which is always shown); else this one
     */
    _init({monitorIndex = Main.layoutManager.primaryIndex, reach = 1, fromBottom = false, side = null,
        solid = false, look = null, light = false, source = null, yields = false} = {}) {
        super._init({style_class: 'atelier-glass', reactive: false, clip_to_allocation: true});
        // As big as the top of the monitor and above the overview: dragging
        // a window onto a workspace looks for the target among all actors,
        // reactive or not, and must not find this one.
        Shell.util_set_hidden_from_pick(this, true);
        this._monitorIndex = monitorIndex;
        this._reach = reach;
        this._side = side ?? (fromBottom ? 'BOTTOM' : 'TOP');
        this._solid = solid;
        this._look = solid ? null : look;
        this._lightStyle = light;
        this._source = null;
        this._shape = null;
        // (Where its shapes were drawn last, on the stage; the part of the
        // monitor it may cover, and how much of it it covers now.)
        this._drawn = null;
        this._band = null;
        this._frame = null;
        this._monitorAt = [0, 0];
        this._drop = null;
        this._neck = null;
        this._partner = null;
        this._yields = yields;
        this._live = null;
        this._light = REST_LIGHT;
        // GNOME's style and the glass's dim, eased.
        this._eased = new GlassEasing(this, () => this._showEased());

        this._wallpaper = new Clutter.Actor();
        this.add_child(this._wallpaper);
        // (Solid: black over it. Glass is neutral, its face as GNOME's style
        // has it, no tint of its own.)
        this._fill = solid ? new St.Widget({style_class: 'atelier-solid-fill'}) : null;
        if (this._fill)
            this.add_child(this._fill);

        this._mask = new RoundedMaskEffect();
        this.add_effect_with_name('atelier-glass-mask', this._mask);

        Main.layoutManager.connectObject('monitors-changed', () => this._build(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor', () => {
            this._syncMaterial();
            this._syncReach();
        }, this);
        // (Its light is looked after while it shows.)
        if (!solid) {
            glassLight.add(this);
            this.connect('notify::mapped', () => glassLight.sync());
        }
        this.connect('destroy', () => {
            glassLight.remove(this);
            this._eased.destroy();
            Main.layoutManager.disconnectObject(this);
            St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
            this._bgManager?.destroy();
            this._bgManager = null;
        });
        this._eased.set('style', {light: light ? 1 : 0});
        this._eased.set('dim', {dim: this._look?.dim ?? 0});
        this._syncMaterial();
        this._build();
        if (source && !solid)
            this.setSource(source);
    }

    /**
     * What is behind it: an actor's picture (a clone of it), or the
     * wallpaper (null) – as the constructor's source.
     *
     * @param {Clutter.Actor|null} source
     */
    setSource(source) {
        if (this._solid || source === (this._source?.source ?? null))
            return;
        this._source?.destroy();
        this._source = null;
        if (source) {
            const clone = new WindowsClone({source});
            clone.set_size(global.stage.width, global.stage.height);
            this.insert_child_above(clone, this._wallpaper);
            // (Gone, the wallpaper shows again.)
            source.connectObject('destroy', () => this.setSource(null), clone);
            clone.connect('destroy', () => source.disconnectObject?.(clone));
            this._source = clone;
            this._syncSource();
        }
        this._wallpaper.visible = !this._source && !this._live;
    }

    /** @returns {Clutter.Actor|null} what its glass shows instead of the wallpaper */
    get source() {
        return this._source?.source ?? null;
    }

    // (What is at the stage's corner at the stage's: the clone in it.)
    _syncSource() {
        this._source?.set_position(-this.x, -this.y);
    }

    // (Its face as GNOME's style has it now – on its way from one to the
    // other over STYLE_TIME – and its dim, on its way to the look's.)
    _syncMaterial() {
        const {light = 0} = this._eased.shown('style');
        const {dim = 0} = this._eased.shown('dim');
        this._mask.setMaterial(this._look, glassScale(), {light, shadow: true, dim});
    }

    /**
     * Another material: another variant of glass, darkened otherwise
     * (eased there), or of GNOME's style. (A solid surface has none.)
     *
     * @param {object|null} look - LOOK's, null for the plain wallpaper
     * @param {boolean} [light] - GNOME's style is light
     */
    setLook(look, light = this._lightStyle) {
        if (this._solid || (look === this._look && light === this._lightStyle))
            return;
        this._look = look;
        this._lightStyle = light;
        this._eased.set('style', {light: light ? 1 : 0}, STYLE_TIME);
        this._eased.set('dim', {dim: look?.dim ?? 0});
        this._syncMaterial();
        this._shapesChanged();
        glassLight.sync();
    }

    /** @returns {number} how much darker its glass is to be (its look's dim), 0 … 1 */
    get dim() {
        return this._eased.wanted('dim').dim ?? 0;
    }

    // As eased now, drawn again where its shapes are.
    _showEased() {
        this._syncMaterial();
        const bounds = this._bounds();
        if (bounds)
            this._redrawWithin(bounds);
    }

    // Drawn again only within these bounds on the stage (and as far round
    // them as its contour and shadow go).
    _redrawWithin([x, y, width, height]) {
        const margin = Math.ceil(edgeReach(true) * glassScale()) + 2;
        // (Within the surface: past it there is nothing of it to draw – an
        // empty or upside-down rectangle is no clip to give Clutter.)
        const x1 = Math.max(0, Math.floor(x - this.x) - margin);
        const y1 = Math.max(0, Math.floor(y - this.y) - margin);
        const x2 = Math.min(Math.ceil(this.width), Math.ceil(x + width - this.x) + margin);
        const y2 = Math.min(Math.ceil(this.height), Math.ceil(y + height - this.y) + margin);
        if (!(x2 > x1 && y2 > y1))
            return;
        this.queue_redraw_with_clip(new Mtk.Rectangle({x: x1, y: y1, width: x2 - x1, height: y2 - y1}));
    }

    // What the shader draws within: its shapes, their contour and shadow.
    _syncReach() {
        const bounds = this._bounds();
        if (!bounds) {
            this._mask.setReach(null);
            return;
        }
        const margin = edgeReach(true) * glassScale();
        const [x, y, width, height] = bounds;
        this._mask.setReach([x - this.x - margin, y - this.y - margin,
            x + width - this.x + margin, y + height - this.y + margin]);
    }

    /** @returns {object|null} the material it is drawn with */
    get look() {
        return this._look;
    }

    /** @returns {number[]|null} its shape, as setShape() took it last */
    get shape() {
        return this._shape;
    }

    _build() {
        this._bgManager?.destroy();
        this._bgManager = null;
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        if (!monitor)
            return;
        // The surface covers the top of its monitor (or the bottom, or a
        // side); the wallpaper lines up with the desktop.
        let [width, height, offsetX, offsetY] = [monitor.width, monitor.height, 0, 0];
        if (this._side === 'LEFT' || this._side === 'RIGHT') {
            width = Math.ceil(monitor.width * this._reach);
            offsetX = this._side === 'RIGHT' ? monitor.width - width : 0;
        } else {
            height = Math.ceil(monitor.height * this._reach);
            offsetY = this._side === 'BOTTOM' ? monitor.height - height : 0;
        }
        /** The part of the monitor it may cover, on the stage: [x, y, width, height]. */
        this._band = [monitor.x + offsetX, monitor.y + offsetY, width, height];
        this._monitorAt = [monitor.x, monitor.y];
        this._source?.set_size(global.stage.width, global.stage.height);
        if (!this._solid) {
            this._bgManager = new Background.BackgroundManager({
                container: this._wallpaper,
                monitorIndex: this._monitorIndex,
                controlPosition: false,
            });
        }
        this._frame = null;
        this._shapesChanged();
    }

    // Where it is on the stage and how large: round its shapes as far as
    // they draw, in steps, within its part of the monitor – grown at once,
    // shrunk only once they need much less (a texture of another size is
    // made anew as it changes). Without shapes, as it was (a pixel to
    // start with).
    _fit() {
        const band = this._band;
        if (!band)
            return;
        const bounds = this._bounds();
        let need;
        if (bounds) {
            const scale = glassScale();
            const margin = Math.ceil((edgeReach(true) + 3 * (this._look?.blur ?? 0) + 2) * scale) + 2;
            const step = FIT_STEP * scale;
            const [bx, by, bw, bh] = band;
            const down = (v, from) => from + Math.floor((v - from) / step) * step;
            const up = (v, from) => from + Math.ceil((v - from) / step) * step;
            const x1 = Math.max(bx, down(bounds[0] - margin, bx));
            const y1 = Math.max(by, down(bounds[1] - margin, by));
            const x2 = Math.min(bx + bw, up(bounds[0] + bounds[2] + margin, bx));
            const y2 = Math.min(by + bh, up(bounds[1] + bounds[3] + margin, by));
            need = [x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1)];
        } else {
            need = this._frame ?? [band[0], band[1], 1, 1];
        }
        const frame = this._frame;
        if (frame) {
            const inside = need[0] >= frame[0] && need[1] >= frame[1] &&
                need[0] + need[2] <= frame[0] + frame[2] && need[1] + need[3] <= frame[1] + frame[3];
            if (inside && need[2] * need[3] * 4 > frame[2] * frame[3])
                return;
        }
        this._frame = need;
        const [x, y, width, height] = need.map(Math.round);
        this.set_position(x, y);
        this.set_size(width, height);
        this._fill?.set_size(width, height);
        this._wallpaper.set_position(this._monitorAt[0] - x, this._monitorAt[1] - y);
        this._syncSource();
    }

    // Its shapes as they are: where it is, what its shader is told (in its
    // own pixels), its live glass and what it draws within.
    _shapesChanged() {
        this._fit();
        if (this._shape) {
            const [x, y, width, height, radius, bottomRadius, ear] = this._shape;
            const {rect, body, radii} = this._shapeIn([x, y, width, height], radius, bottomRadius);
            this._mask.setShape([this.width, this.height], rect, radii, ear, body);
        }
        if (this._drop) {
            const [centerX, centerY, halfWidth, halfHeight, radius, blend] = this._drop;
            this._mask.setDrop([centerX - this.x, centerY - this.y, halfWidth, halfHeight],
                Math.max(0, Math.min(radius, halfWidth, halfHeight)), blend);
        } else {
            this._mask.setDrop([0, 0, 0, 0], 0, 1);
        }
        if (this._neck) {
            const [centerX, top, bottom, halfWidth] = this._neck;
            this._mask.setNeck([centerX - this.x, top - this.y, bottom - this.y, Math.max(0, halfWidth)]);
        } else {
            this._mask.setNeck([0, 0, 0, 0]);
        }
        this._applyPartner();
        this._syncLive();
    }

    /**
     * Live glass: of what is under the surface now, the windows too, rather
     * than of the wallpaper. Dearer – drawn again whenever that changes –
     * so for a while only, over the bounds of its shapes.
     *
     * @param {boolean} live
     */
    setLive(live) {
        if (this._solid || live === (this._live !== null))
            return;
        if (live) {
            this._live = new St.Widget({clip_to_allocation: true});
            const windows = new WindowsClone({source: global.window_group});
            windows.set_size(global.stage.width, global.stage.height);
            this._live.add_child(windows);
            // (Told what shows of it before it is on the stage: all of it,
            // even once, is the whole stage drawn again.)
            this._syncLive();
            this.insert_child_above(this._live, this._source ?? this._wallpaper);
            this._wallpaper.hide();
            this._source?.hide();
        } else {
            this._live.destroy();
            this._live = null;
            this._source?.show();
            this._wallpaper.visible = !this._source;
        }
    }

    // The live glass where the shapes are, and as far around as the blur's
    // taps reach, so its edges are blurred like the rest.
    _syncLive() {
        if (!this._live)
            return;
        const boxes = [];
        if (this._shape) {
            const [x, y, width, height, , , ear] = this._shape;
            boxes.push([x - ear, y, x + width + ear, y + height]);
        }
        if (this._drop && this._drop[2] > 0 && this._drop[3] > 0) {
            const [cx, cy, hw, hh] = this._drop;
            boxes.push([cx - hw, cy - hh, cx + hw, cy + hh]);
        }
        if (this._neck && this._neck[3] > 0) {
            const [cx, top, bottom, hw] = this._neck;
            boxes.push([cx - hw, top, cx + hw, bottom]);
        }
        if (boxes.length === 0 || this.width === 0) {
            this._live.hide();
            return;
        }
        const scale = glassScale();
        const margin = (3 * (this._look?.blur ?? 0) + 2) * scale;
        const step = LIVE_STEP * scale;
        const down = v => Math.floor(v / step) * step;
        const up = v => Math.ceil(v / step) * step;
        const x1 = Math.max(this.x, down(Math.min(...boxes.map(b => b[0])) - margin));
        const y1 = Math.max(this.y, down(Math.min(...boxes.map(b => b[1])) - margin));
        const x2 = Math.min(this.x + this.width, up(Math.max(...boxes.map(b => b[2])) + margin));
        const y2 = Math.min(this.y + this.height, up(Math.max(...boxes.map(b => b[3])) + margin));
        const [width, height] = [Math.max(1, x2 - x1), Math.max(1, y2 - y1)];
        this._live.set_position(x1 - this.x, y1 - this.y);
        this._live.set_size(width, height);
        // (What is at x1, y1 on the stage at its corner; only that much of
        // the windows shows.)
        const windows = this._live.get_first_child();
        windows.set_position(-x1, -y1);
        windows.setShown([x1, y1, width, height]);
        this._live.show();
    }


    /**
     * Fill a rounded rectangle, in stage coordinates.
     *
     * @param {number} x
     * @param {number} y
     * @param {number} width
     * @param {number} height
     * @param {number} radius - of the top corners
     * @param {number} [bottomRadius] - of the bottom ones, if different
     * @param {number} [ear] - radius of a notch's ears beside the top corners
     */
    setShape(x, y, width, height, radius, bottomRadius = radius, ear = 0) {
        this._shape = [x, y, width, height, radius, bottomRadius, ear];
        this._shapesChanged();
    }

    // A rectangle on the stage, in the actor: as it is, past the edges of
    // the screen it lies on, and its corners (no rounder than it can be).
    _shapeIn([x, y, width, height], radius, bottomRadius) {
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        const [bx, by, bw, bh] = monitor ? bodyRect([x, y, width, height], monitor) : [x, y, width, height];
        const limit = Math.min(width / 2, height / 2);
        return {
            rect: [x - this.x, y - this.y, width, height],
            body: [bx - this.x, by - this.y, bw, bh],
            radii: [Math.min(radius, limit), Math.min(bottomRadius, limit)],
        };
    }

    /**
     * Another surface's shape, in stage coordinates, which this one's glass
     * is one with: the one island the island lies in, say. It bends and
     * catches the light as one with it (never where this one is only
     * inside it), the light leaning the same way for both.
     *
     * @param {number[]|null} shape - [x, y, width, height, radius,
     *   bottomRadius, ear] as setShape() takes them, null for none
     */
    setPartner(shape) {
        if (JSON.stringify(shape) === JSON.stringify(this._partner))
            return;
        this._partner = shape;
        this._applyPartner();
    }

    _applyPartner() {
        const shape = this._partner;
        if (!shape) {
            this._mask.setPartner(null);
        } else {
            const [x, y, width, height, radius, bottomRadius = radius, ear = 0] = shape;
            this._mask.setPartner({...this._shapeIn([x, y, width, height], radius, bottomRadius), ear,
                yields: this._yields});
        }
        this._syncFrame();
    }

    // [x, y, width, height] on the stage of its shapes, a drop's and its
    // neck's too, null for none.
    _bounds() {
        const rects = [];
        if (this._shape) {
            const [x, y, width, height, , , ear] = this._shape;
            rects.push([x - ear, y, width + 2 * ear, height]);
        }
        if (this._drop && this._drop[2] > 0 && this._drop[3] > 0) {
            const [cx, cy, hw, hh] = this._drop;
            rects.push([cx - hw, cy - hh, 2 * hw, 2 * hh]);
        }
        if (this._neck && this._neck[3] > 0) {
            const [cx, top, bottom, hw] = this._neck;
            rects.push([cx - hw, top, 2 * hw, bottom - top]);
        }
        return boundsOf(rects);
    }

    // What the light leans by: all of the glass it is part of.
    _glassBounds() {
        const partner = this._partner;
        return boundsOf([this._bounds() ?? [0, 0, 0, 0], partner?.slice(0, 4) ?? [0, 0, 0, 0]]);
    }

    // (Its shapes changed: drawn again where they were and where they are,
    // the effect's uniforms only. Not all of the surface – it draws nothing
    // past its shapes, and what lies under all of it, monitor-wide, would
    // be drawn again with it every frame they move: the island growing into
    // the control centre, 9 ms a frame at 150 % here.)
    _syncFrame() {
        this._syncReach();
        const bounds = this._bounds();
        const drawn = [bounds, this._drawn].filter(Boolean);
        this._drawn = bounds;
        if (drawn.length > 0)
            this._redrawWithin(boundsOf(drawn));
        glassLight.refresh(this);
    }

    /**
     * For the light (shell/core/glassLight.js): all of the glass it is
     * part of, on the stage, while it is shown.
     *
     * @returns {number[][]}
     */
    lightAreas() {
        if (!this._look || !this.mapped || this.opacity === 0)
            return [];
        const bounds = this._glassBounds();
        return bounds ? [bounds] : [];
    }

    /** @returns {object|null} how its light leans (LOOK's) */
    lightLook() {
        return this._look?.light ?? null;
    }

    /**
     * @param {number[][]} lights - where the light comes from, one
     * @returns {boolean} whether it changed (and is drawn again, only where
     *   the surface's shapes are)
     */
    setLights([light]) {
        if (!light || sameLight(light, this._light))
            return false;
        this._light = light;
        this._mask.setLight(light);
        const bounds = this._bounds();
        if (bounds)
            this._redrawWithin(bounds);
        return true;
    }

    /** @returns {number[]} where its light comes from now, [x, y] (y down) */
    get light() {
        return this._light;
    }

    /**
     * Fill a drop as well, a rounded rectangle in stage coordinates, which
     * melts into the other one where they come near.
     *
     * @param {number} centerX
     * @param {number} centerY
     * @param {number} halfWidth
     * @param {number} halfHeight
     * @param {number} radius - of its corners
     * @param {number} blend - how near they melt into each other
     */
    setDrop(centerX, centerY, halfWidth, halfHeight, radius, blend) {
        this._drop = [centerX, centerY, halfWidth, halfHeight, radius, blend];
        this._shapesChanged();
    }

    /**
     * A neck the drop hangs on: an upright capsule, in stage coordinates,
     * which melts into the rest where it comes near.
     *
     * @param {number} centerX
     * @param {number} top
     * @param {number} bottom
     * @param {number} halfWidth - none for no neck
     */
    setNeck(centerX, top, bottom, halfWidth) {
        this._neck = [centerX, top, bottom, halfWidth];
        this._shapesChanged();
    }

    /** No drop, nor its neck. */
    clearDrop() {
        this._drop = null;
        this._neck = null;
        this._shapesChanged();
    }
});
