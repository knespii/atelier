// Atelier's glass: the wallpaper under a surface, blurred, like GNOME's lock
// screen – a static blur, which costs nothing while it stays – and drawn as
// Liquid Glass (shell/core/glassMaterial.js): bending at its edges, which
// catch the light. For a while, it may be live glass instead: of what is
// under it now, the windows too, blurred again whenever that changes.
// A surface is the blurred wallpaper of the top of its monitor (or of
// another edge, for a dock), masked to a rounded rectangle that can move and
// change size every frame (the island growing) without blurring anything
// again – and to a drop beside it, which melts into it where they meet (the
// island dripping).

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NO_SHADE, REST_LIGHT, TINTS, bodyRect, boundsOf, sameLight, textureFrame, tintOf} from '../../lib/glassLook.js';
import {glassLight} from './glassLight.js';
import {
    GlassShades, MATERIAL_CODE, MATERIAL_DECLARATIONS, glassScale, materialUniforms, setMaterial, setMaterialArea,
} from './glassMaterial.js';

const BLUR_RADIUS = 36; // logical pixels
// How bright the blur leaves the wallpaper, under light glass and smoky.
const BLUR_BRIGHTNESS = {light: 1, smoky: 0.92};
// Live glass is blurred over the bounds of its shapes, in steps of this many
// logical pixels (so it isn't made anew every frame they change).
const LIVE_STEP = 64;

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
// (partner: the one island the island's glass is in) – they are one glass.
const SHAPE_DECLARATIONS = `
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
uniform vec2 glassLight;
uniform vec4 glassFrame;
uniform vec2 glassShade;

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
    return atelier_drip(p, atelier_notch(p, rect, rect, radii, ear));
}

float atelier_body(vec2 p) {
    float d = atelier_drip(p, atelier_notch(p, rect, body, radii, ear));
    if (partner.z > 0.0 && partner.w > 0.0)
        d = min(d, atelier_notch(p, partner, partnerBody, partnerLook.xy, partnerLook.z));
    return d;
}

void atelier_part(vec2 p, out vec4 frame, out vec2 light, out vec2 shade) {
    frame = glassFrame;
    light = glassLight;
    shade = glassShade;
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
            'partner', 'partnerBody', 'partnerLook', 'glassLight', 'glassFrame', 'glassShade'];
        this._at = Object.fromEntries(names.map(name => [name, this.get_uniform_location(name)]));
        this._material = materialUniforms(this);
        this.setDrop([0, 0, 0, 0], 0, 1);
        this.setNeck([0, 0, 0, 0]);
        this.setPartner(null);
        this.setLight(REST_LIGHT);
        this.setFrame([0, 0, 0, 0]);
        this.setShade([0, 0]);
        this.setMaterial(null, 1);
    }

    vfunc_paint_target(node, paintContext) {
        syncTextureFrame(this, this._at.origin, this._at.size);
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
        this.queue_repaint();
    }

    /**
     * Another surface's shape this one's glass is one with.
     *
     * @param {object|null} partner - {rect, body, radii, ear} as setShape()
     *   has them, null for none
     */
    setPartner(partner) {
        const {rect = [0, 0, 0, 0], body = rect, radii = [0, 0], ear = 0} = partner ?? {};
        this.set_uniform_float(this._at.partner, 4, rect);
        this.set_uniform_float(this._at.partnerBody, 4, body);
        this.set_uniform_float(this._at.partnerLook, 3, [...radii, ear]);
        this.queue_repaint();
    }

    /** @param {number[]} light - where it comes from, [x, y] (y down) */
    setLight(light) {
        this.set_uniform_float(this._at.glassLight, 2, light);
    }

    /** @param {number[]} frame - [x, y, width, height] the sheen runs across */
    setFrame(frame) {
        this.set_uniform_float(this._at.glassFrame, 4, frame);
    }

    /** @param {number[]} shade - its extra shade, [dim, veil] */
    setShade(shade) {
        this.set_uniform_float(this._at.glassShade, 2, shade);
    }

    /**
     * @param {object|null} look - LOOK's, null for only the shape
     * @param {number} scale - pixels in a logical pixel
     */
    setMaterial(look, scale) {
        setMaterial(this, this._material, look, scale);
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
        this.queue_repaint();
    }

    /**
     * @param {number[]} neck - [centerX, top, bottom, halfWidth] relative to
     *   the actor; no width for none
     */
    setNeck(neck) {
        this.set_uniform_float(this._at.neck, 4, neck);
        this.queue_repaint();
    }
});

// The windows' group as it is on the stage, one to one, for live glass.
// (The group says it has no size, and a plain clone scales its source to
// its own size: by infinity, to nothing.)
const WindowsClone = GObject.registerClass(
class AtelierWindowsClone extends Clutter.Clone {
    vfunc_allocate(box) {
        this.set_allocation(box);
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
     *   LOOK's), none for plain blurred glass; never for solid surfaces
     * @param {boolean} [params.light] - GNOME's style is light: light glass
     *   (else smoky)
     * @param {boolean} [params.deep] - dark glass whatever the style, for
     *   what is styled for a dark surface only (a sheet's form)
     */
    _init({monitorIndex = Main.layoutManager.primaryIndex, reach = 1, fromBottom = false, side = null,
        solid = false, look = null, light = false, deep = false} = {}) {
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
        this._deep = deep;
        this._shape = null;
        this._drop = null;
        this._neck = null;
        this._partner = null;
        this._live = null;
        this._light = REST_LIGHT;
        // The extra shade its type asks for (shell/core/vibrancy.js).
        this._typeShade = NO_SHADE;
        this._shades = new GlassShades(this, () => this._showShade());

        this._wallpaper = new Clutter.Actor();
        this.add_child(this._wallpaper);
        this._tint = new St.Widget({style_class: solid ? 'atelier-solid-fill' : 'atelier-glass-tint'});
        this.add_child(this._tint);

        this._mask = new RoundedMaskEffect();
        this.add_effect_with_name('atelier-glass-mask', this._mask);

        Main.layoutManager.connectObject('monitors-changed', () => this._build(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor', () => {
            this._blurBackground();
            this._mask.setMaterial(this._look, glassScale());
        }, this);
        // (Its light is looked after while it shows.)
        if (!solid) {
            glassLight.add(this);
            this.connect('notify::mapped', () => glassLight.sync());
        }
        this.connect('destroy', () => {
            glassLight.remove(this);
            this._shades.destroy();
            Main.layoutManager.disconnectObject(this);
            St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
            this._bgManager?.destroy();
            this._bgManager = null;
        });
        this._mask.setMaterial(this._look, glassScale());
        this._syncTint();
        this._build();
    }

    /**
     * Another material: another variant of glass, or of GNOME's style. (A
     * solid surface has none.)
     *
     * @param {object|null} look - LOOK's, null for plain blurred glass
     * @param {boolean} [light] - GNOME's style is light
     */
    setLook(look, light = this._lightStyle) {
        if (this._solid || (look === this._look && light === this._lightStyle))
            return;
        const blurred = [this._frost, this._blurBrightness];
        this._look = look;
        this._lightStyle = light;
        this._mask.setMaterial(look, glassScale());
        this._syncTint();
        this._syncShade();
        // (Less frosted, or as bright as the other style has it: blurred
        // anew.)
        if (this._frost !== blurred[0] || this._blurBrightness !== blurred[1])
            this._syncBlur();
        glassLight.sync();
    }

    /**
     * Dark glass whatever GNOME's style, under what is styled for a dark
     * surface only (GNOME's own controls in the control centre).
     *
     * @param {boolean} deep
     */
    setDeep(deep) {
        if (deep === this._deep)
            return;
        this._deep = deep;
        this._syncTint();
        this._syncShade();
    }

    /** @returns {boolean} whether it is deep glass now */
    get deep() {
        return this._deep;
    }

    /**
     * An extra shade, where the type on it would not read otherwise
     * (lib/vibrancy.js): darker under light type, lighter under dark –
     * eased to it. (None while it is deep: what is on it then is styled for
     * that; nor solid or plain blurred glass.)
     *
     * @param {object} shade - {dim, veil}, 0 … 1 each
     */
    setShade(shade) {
        this._typeShade = shade ?? NO_SHADE;
        this._syncShade();
    }

    /** @returns {object} the extra shade it is to have, {dim, veil} */
    get shade() {
        return this._shades.wanted('glass');
    }

    _syncShade() {
        const none = this._solid || !this._look || this._deep;
        this._shades.set('glass', none ? NO_SHADE : this._typeShade);
    }

    // The shade as it is now, drawn again where its shapes are.
    _showShade() {
        const {dim, veil} = this._shades.shown('glass');
        this._mask.setShade([dim, veil]);
        const bounds = this._bounds();
        if (bounds)
            this._redrawWithin(bounds);
    }

    // Drawn again only within these bounds on the stage.
    _redrawWithin([x, y, width, height]) {
        const [x1, y1] = [Math.floor(x - this.x) - 2, Math.floor(y - this.y) - 2];
        this.queue_redraw_with_clip(new Mtk.Rectangle({
            x: x1, y: y1, width: Math.ceil(x + width - this.x) + 2 - x1, height: Math.ceil(y + height - this.y) + 2 - y1,
        }));
    }

    // How frosted it is (LOOK's): its blur, a share of its own (its tint is
    // as the stylesheet has it for each).
    get _frost() {
        return this._look?.frost ?? 1;
    }

    // Light glass shows the wallpaper as bright as it is; smoky glass dims
    // it a little before its tint.
    get _blurBrightness() {
        return this._lightStyle ? BLUR_BRIGHTNESS.light : BLUR_BRIGHTNESS.smoky;
    }

    // Its tint as the stylesheet has it (stylesheet.css, the palette's in
    // shell/core/theme.js): one class of its own for each.
    _syncTint() {
        if (this._solid)
            return;
        const wanted = `atelier-glass-${tintOf(this._look, {light: this._lightStyle, deep: this._deep})}`;
        for (const tint of TINTS) {
            if (`atelier-glass-${tint}` !== wanted)
                this.remove_style_class_name(`atelier-glass-${tint}`);
        }
        this.add_style_class_name(wanted);
    }

    _syncBlur() {
        this._blurBackground();
        const live = this._live?.get_effect('atelier-glass-blur');
        if (live) {
            live.radius = BLUR_RADIUS * glassScale() * this._frost;
            live.brightness = this._blurBrightness;
        }
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
        this.set_position(monitor.x + offsetX, monitor.y + offsetY);
        this.set_size(width, height);
        this._tint.set_size(width, height);
        this._wallpaper.set_position(-offsetX, -offsetY);
        if (!this._solid) {
            this._bgManager = new Background.BackgroundManager({
                container: this._wallpaper,
                monitorIndex: this._monitorIndex,
                controlPosition: false,
            });
            this._bgManager.connect('changed', () => this._blurBackground());
            this._blurBackground();
        }
        if (this._shape)
            this.setShape(...this._shape);
        if (this._drop)
            this.setDrop(...this._drop);
        if (this._neck)
            this.setNeck(...this._neck);
        this._applyPartner();
    }

    /**
     * Live glass: of what is under the surface now, the windows too, rather
     * than of the wallpaper. Dearer – blurred again whenever that changes –
     * so for a while only, over the bounds of its shapes.
     *
     * @param {boolean} live
     */
    setLive(live) {
        if (this._solid || live === (this._live !== null))
            return;
        if (live) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            this._live = new St.Widget({clip_to_allocation: true});
            const windows = new WindowsClone({source: global.window_group});
            windows.set_size(global.stage.width, global.stage.height);
            this._live.add_child(windows);
            this._live.add_effect_with_name('atelier-glass-blur', new Shell.BlurEffect({
                mode: Shell.BlurMode.ACTOR,
                radius: BLUR_RADIUS * scale * this._frost,
                brightness: this._blurBrightness,
            }));
            this.insert_child_above(this._live, this._wallpaper);
            this._wallpaper.hide();
            this._syncLive();
        } else {
            this._live.destroy();
            this._live = null;
            this._wallpaper.show();
        }
    }

    // The live glass where the shapes are, and as far around as the blur
    // reaches, so its edges are blurred like the rest.
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
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const margin = BLUR_RADIUS * scale;
        const step = LIVE_STEP * scale;
        const down = v => Math.floor(v / step) * step;
        const up = v => Math.ceil(v / step) * step;
        const x1 = Math.max(this.x, down(Math.min(...boxes.map(b => b[0])) - margin));
        const y1 = Math.max(this.y, down(Math.min(...boxes.map(b => b[1])) - margin));
        const x2 = Math.min(this.x + this.width, up(Math.max(...boxes.map(b => b[2])) + margin));
        const y2 = Math.min(this.y + this.height, up(Math.max(...boxes.map(b => b[3])) + margin));
        this._live.set_position(x1 - this.x, y1 - this.y);
        this._live.set_size(Math.max(1, x2 - x1), Math.max(1, y2 - y1));
        // (What is at x1, y1 on the stage at its corner.)
        this._live.get_first_child().set_position(-x1, -y1);
        this._live.show();
    }

    _blurBackground() {
        const actor = this._bgManager?.backgroundActor;
        if (!actor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        actor.remove_effect_by_name('atelier-glass-blur');
        actor.add_effect_with_name('atelier-glass-blur', new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS * scale * this._frost,
            brightness: this._blurBrightness,
        }));
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
        const {rect, body, radii} = this._shapeIn([x, y, width, height], radius, bottomRadius);
        this._mask.setShape([this.width, this.height], rect, radii, ear, body);
        this._syncLive();
        this._syncFrame();
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
            this._mask.setPartner({...this._shapeIn([x, y, width, height], radius, bottomRadius), ear});
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

    // What the sheen runs across and the light leans by: all of the glass
    // it is part of.
    _glassBounds() {
        const partner = this._partner;
        return boundsOf([this._bounds() ?? [0, 0, 0, 0], partner?.slice(0, 4) ?? [0, 0, 0, 0]]);
    }

    _syncFrame() {
        const bounds = this._glassBounds();
        this._mask.setFrame(bounds ? [bounds[0] - this.x, bounds[1] - this.y, bounds[2], bounds[3]] : [0, 0, 0, 0]);
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
        this._mask.setDrop([centerX - this.x, centerY - this.y, halfWidth, halfHeight],
            Math.max(0, Math.min(radius, halfWidth, halfHeight)), blend);
        this._syncLive();
        this._syncFrame();
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
        this._mask.setNeck([centerX - this.x, top - this.y, bottom - this.y, Math.max(0, halfWidth)]);
        this._syncLive();
        this._syncFrame();
    }

    /** No drop, nor its neck. */
    clearDrop() {
        this._drop = null;
        this._neck = null;
        this._mask.setDrop([0, 0, 0, 0], 0, 1);
        this._mask.setNeck([0, 0, 0, 0]);
        this._syncLive();
        this._syncFrame();
    }
});
