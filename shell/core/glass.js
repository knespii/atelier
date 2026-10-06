// Atelier's glass: the wallpaper under a surface, blurred and tinted, like
// GNOME's lock screen – a static blur, which costs nothing while it stays.
// For a while, it may be live glass instead: of what is under it now, the
// windows too, blurred again whenever that changes.
// A surface is the blurred wallpaper of the top of its monitor, masked to a
// rounded rectangle that can move and change size every frame (the island
// growing) without blurring anything again – and to a drop beside it, which
// melts into it where they meet (the island dripping).

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BLUR_RADIUS = 36; // logical pixels
const BLUR_BRIGHTNESS = 0.75;
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
const MASK_DECLARATIONS = `
uniform vec2 origin;
uniform vec2 size;
uniform vec4 rect;
uniform vec2 radii;
uniform float ear;
uniform vec4 drop;
uniform float dropRadius;
uniform vec4 neck;
uniform float blend;

float atelier_smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

float atelier_box(vec2 p, vec2 center, vec2 halfSize) {
    vec2 q = abs(p - center) - halfSize;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

float atelier_ear(vec2 p, float side, float inner) {
    vec2 center = vec2(side + (inner - side) * 0.5, rect.y + ear * 0.5 - 0.5);
    float square = atelier_box(p, center, vec2(ear * 0.5 + 0.5));
    return max(square, ear - length(p - vec2(side, rect.y + ear)));
}
`;

const MASK_CODE = `
vec2 p = origin + cogl_tex_coord_in[0].xy * size;
vec2 halfSize = rect.zw * 0.5;
vec2 center = rect.xy + halfSize;
float radius = p.y < center.y ? radii.x : radii.y;
vec2 q = abs(p - center) - halfSize + vec2(radius);
float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
if (ear > 0.0) {
    float left = atelier_ear(p, rect.x - ear, rect.x + 1.0);
    float right = atelier_ear(p, rect.x + rect.z + ear, rect.x + rect.z - 1.0);
    d = min(d, min(left, right));
}
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
cogl_color_out *= clamp(0.5 - d, 0.0, 1.0);
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
    // As Clutter enlarges the box of an offscreen effect (in its pixels):
    // the end rounded up past 0.75 px more, the size rounded and 3 px more.
    const scale = Math.ceil(actor.get_resource_scale());
    const frame = length => {
        const scaled = length * scale;
        const rounded = Math.round(scaled);
        const end = Math.ceil(scaled + 0.75);
        return [(end - rounded - 3) / scale, (rounded + 3) / scale];
    };
    const [x, width] = frame(actor.width);
    const [y, height] = frame(actor.height);
    effect.set_uniform_float(origin, 2, [x, y]);
    effect.set_uniform_float(size, 2, [width, height]);
}

const RoundedMaskEffect = GObject.registerClass(
class AtelierRoundedMaskEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._origin = this.get_uniform_location('origin');
        this._size = this.get_uniform_location('size');
        this._rect = this.get_uniform_location('rect');
        this._radii = this.get_uniform_location('radii');
        this._ear = this.get_uniform_location('ear');
        this._drop = this.get_uniform_location('drop');
        this._dropRadius = this.get_uniform_location('dropRadius');
        this._neck = this.get_uniform_location('neck');
        this._blend = this.get_uniform_location('blend');
        this.setDrop([0, 0, 0, 0], 0, 1);
        this.setNeck([0, 0, 0, 0]);
    }

    vfunc_paint_target(node, paintContext) {
        syncTextureFrame(this, this._origin, this._size);
        super.vfunc_paint_target(node, paintContext);
    }

    vfunc_build_pipeline() {
        // After the texture lookup; the color is premultiplied, so all four
        // channels get the mask.
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, MASK_DECLARATIONS, MASK_CODE, false);
    }

    /**
     * @param {number[]} size - [width, height] of the actor
     * @param {number[]} rect - [x, y, width, height] relative to the actor
     * @param {number[]} radii - [top, bottom] corner radius
     * @param {number} ear - radius of the ears, 0 for none
     */
    setShape(size, rect, radii, ear) {
        this.set_uniform_float(this._origin, 2, [0, 0]);
        this.set_uniform_float(this._size, 2, size);
        this.set_uniform_float(this._rect, 4, rect);
        this.set_uniform_float(this._radii, 2, radii);
        this.set_uniform_float(this._ear, 1, [ear]);
        this.queue_repaint();
    }

    /**
     * @param {number[]} drop - [centerX, centerY, halfWidth, halfHeight]
     *   relative to the actor; no width or height for none
     * @param {number} radius - of its corners
     * @param {number} blend - how near it melts into the rectangle
     */
    setDrop(drop, radius, blend) {
        this.set_uniform_float(this._drop, 4, drop);
        this.set_uniform_float(this._dropRadius, 1, [radius]);
        this.set_uniform_float(this._blend, 1, [blend]);
        this.queue_repaint();
    }

    /**
     * @param {number[]} neck - [centerX, top, bottom, halfWidth] relative to
     *   the actor; no width for none
     */
    setNeck(neck) {
        this.set_uniform_float(this._neck, 4, neck);
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
     * @param {number} [params.reach] - how far down the monitor shapes may
     *   go, as a fraction of its height
     * @param {boolean} [params.fromBottom] - the reach is up from the bottom
     *   edge instead (for a dock)
     * @param {boolean} [params.solid] - black instead of glass: the same
     *   shapes, changing every frame without anything being laid out anew
     */
    _init({monitorIndex = Main.layoutManager.primaryIndex, reach = 1, fromBottom = false, solid = false} = {}) {
        super._init({style_class: 'atelier-glass', reactive: false, clip_to_allocation: true});
        // As big as the top of the monitor and above the overview: dragging
        // a window onto a workspace looks for the target among all actors,
        // reactive or not, and must not find this one.
        Shell.util_set_hidden_from_pick(this, true);
        this._monitorIndex = monitorIndex;
        this._reach = reach;
        this._fromBottom = fromBottom;
        this._solid = solid;
        this._shape = null;
        this._drop = null;
        this._neck = null;
        this._live = null;

        this._wallpaper = new Clutter.Actor();
        this.add_child(this._wallpaper);
        this._tint = new St.Widget({style_class: solid ? 'atelier-solid-fill' : 'atelier-glass-tint'});
        this.add_child(this._tint);

        this._mask = new RoundedMaskEffect();
        this.add_effect_with_name('atelier-glass-mask', this._mask);

        Main.layoutManager.connectObject('monitors-changed', () => this._build(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._blurBackground(), this);
        this.connect('destroy', () => {
            Main.layoutManager.disconnectObject(this);
            St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
            this._bgManager?.destroy();
            this._bgManager = null;
        });
        this._build();
    }

    _build() {
        this._bgManager?.destroy();
        this._bgManager = null;
        const monitor = Main.layoutManager.monitors[this._monitorIndex];
        if (!monitor)
            return;
        // The surface covers the top (or the bottom) of its monitor; the
        // wallpaper lines up with the desktop.
        const height = Math.ceil(monitor.height * this._reach);
        const offset = this._fromBottom ? monitor.height - height : 0;
        this.set_position(monitor.x, monitor.y + offset);
        this.set_size(monitor.width, height);
        this._tint.set_size(monitor.width, height);
        this._wallpaper.set_position(0, -offset);
        if (this._solid) {
            if (this._shape)
                this.setShape(...this._shape);
            if (this._drop)
                this.setDrop(...this._drop);
            if (this._neck)
                this.setNeck(...this._neck);
            return;
        }
        this._bgManager = new Background.BackgroundManager({
            container: this._wallpaper,
            monitorIndex: this._monitorIndex,
            controlPosition: false,
        });
        this._bgManager.connect('changed', () => this._blurBackground());
        this._blurBackground();
        if (this._shape)
            this.setShape(...this._shape);
        if (this._drop)
            this.setDrop(...this._drop);
        if (this._neck)
            this.setNeck(...this._neck);
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
                radius: BLUR_RADIUS * scale,
                brightness: BLUR_BRIGHTNESS,
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
            radius: BLUR_RADIUS * scale,
            brightness: BLUR_BRIGHTNESS,
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
        const limit = Math.min(width / 2, height / 2);
        this._mask.setShape([this.width, this.height], [x - this.x, y - this.y, width, height],
            [Math.min(radius, limit), Math.min(bottomRadius, limit)], ear);
        this._syncLive();
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
    }

    /** No drop, nor its neck. */
    clearDrop() {
        this._drop = null;
        this._neck = null;
        this._mask.setDrop([0, 0, 0, 0], 0, 1);
        this._mask.setNeck([0, 0, 0, 0]);
        this._syncLive();
    }
});
