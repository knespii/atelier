// Atelier's glass: the wallpaper under a surface, blurred and tinted, like
// GNOME's lock screen – a static blur, which costs nothing while it stays.
// A surface is the blurred wallpaper of the top of its monitor, masked to a
// rounded rectangle that can move and change size every frame (the island
// growing) without blurring anything again.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BLUR_RADIUS = 36; // logical pixels
const BLUR_BRIGHTNESS = 0.75;

// Pixels outside the rounded rectangle are dropped; its edge gets one pixel
// of antialiasing. Everything is in pixels of the actor. The top and the
// bottom corners may differ (a notch has square top corners), and a notch
// may have ears: beside its top corners, squares less a quarter circle,
// where it curves into the top edge. (They reach a pixel into the notch and
// above it, so no seam shows.)
const MASK_DECLARATIONS = `
uniform vec2 origin;
uniform vec2 size;
uniform vec4 rect;
uniform vec2 radii;
uniform float ear;

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
    }
});
