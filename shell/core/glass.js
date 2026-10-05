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
// bottom corners may differ (a notch has square top corners).
const MASK_DECLARATIONS = `
uniform vec2 size;
uniform vec4 rect;
uniform vec2 radii;
`;

const MASK_CODE = `
vec2 p = cogl_tex_coord_in[0].xy * size;
vec2 halfSize = rect.zw * 0.5;
vec2 center = rect.xy + halfSize;
float radius = p.y < center.y ? radii.x : radii.y;
vec2 q = abs(p - center) - halfSize + vec2(radius);
float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
cogl_color_out *= clamp(0.5 - d, 0.0, 1.0);
`;

const RoundedMaskEffect = GObject.registerClass(
class AtelierRoundedMaskEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._size = this.get_uniform_location('size');
        this._rect = this.get_uniform_location('rect');
        this._radii = this.get_uniform_location('radii');
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
     */
    setShape(size, rect, radii) {
        this.set_uniform_float(this._size, 2, size);
        this.set_uniform_float(this._rect, 4, rect);
        this.set_uniform_float(this._radii, 2, radii);
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
     */
    _init({monitorIndex = Main.layoutManager.primaryIndex, reach = 1} = {}) {
        super._init({style_class: 'atelier-glass', reactive: false, clip_to_allocation: true});
        // As big as the top of the monitor and above the overview: dragging
        // a window onto a workspace looks for the target among all actors,
        // reactive or not, and must not find this one.
        Shell.util_set_hidden_from_pick(this, true);
        this._monitorIndex = monitorIndex;
        this._reach = reach;
        this._shape = null;

        this._wallpaper = new Clutter.Actor();
        this.add_child(this._wallpaper);
        this._tint = new St.Widget({style_class: 'atelier-glass-tint'});
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
        // The surface covers the top of its monitor; the wallpaper lines up
        // with the desktop.
        const height = Math.ceil(monitor.height * this._reach);
        this.set_position(monitor.x, monitor.y);
        this.set_size(monitor.width, height);
        this._tint.set_size(monitor.width, height);
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
     */
    setShape(x, y, width, height, radius, bottomRadius = radius) {
        this._shape = [x, y, width, height, radius, bottomRadius];
        const limit = Math.min(width / 2, height / 2);
        this._mask.setShape([this.width, this.height], [x - this.x, y - this.y, width, height],
            [Math.min(radius, limit), Math.min(bottomRadius, limit)]);
    }
});
