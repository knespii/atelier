// Glass under the widgets: one blurred copy of the wallpaper for the whole
// desktop, shown only where the widgets are – rounded rectangles that may
// move every frame (while a widget is dragged) without blurring anything
// again.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {syncTextureFrame} from '../core/glass.js';

const MAX_RECTS = 32;
const BLUR_RADIUS = 40; // logical pixels
const BLUR_BRIGHTNESS = 0.8;

const DECLARATIONS = `
uniform vec2 origin;
uniform vec2 size;
uniform float radius;
uniform float count;
uniform vec4 rects[${MAX_RECTS}];
`;

const CODE = `
vec2 p = origin + cogl_tex_coord_in[0].xy * size;
float cover = 0.0;
for (int i = 0; i < ${MAX_RECTS}; i++) {
    if (float(i) >= count)
        break;
    vec2 halfSize = rects[i].zw * 0.5;
    vec2 q = abs(p - rects[i].xy - halfSize) - halfSize + vec2(radius);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    cover = max(cover, clamp(0.5 - d, 0.0, 1.0));
}
cogl_color_out *= cover;
`;

const RectsMaskEffect = GObject.registerClass(
class AtelierRectsMaskEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._origin = this.get_uniform_location('origin');
        this._size = this.get_uniform_location('size');
        this._radius = this.get_uniform_location('radius');
        this._count = this.get_uniform_location('count');
        this._rects = this.get_uniform_location('rects');
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    vfunc_paint_target(node, paintContext) {
        syncTextureFrame(this, this._origin, this._size);
        super.vfunc_paint_target(node, paintContext);
    }

    /**
     * @param {number[]} size - [width, height] of the actor
     * @param {number[][]} rects - [x, y, width, height] in it
     * @param {number} radius - of their corners
     */
    setRects(size, rects, radius) {
        const values = new Array(MAX_RECTS * 4).fill(0);
        rects.slice(0, MAX_RECTS).forEach((rect, i) => values.splice(i * 4, 4, ...rect));
        this.set_uniform_float(this._origin, 2, [0, 0]);
        this.set_uniform_float(this._size, 2, size);
        this.set_uniform_float(this._radius, 1, [radius]);
        this.set_uniform_float(this._count, 1, [Math.min(rects.length, MAX_RECTS)]);
        this.set_uniform_float(this._rects, 4, values);
        this.queue_repaint();
    }
});

export const DesktopGlass = GObject.registerClass(
class AtelierDesktopGlass extends St.Widget {
    /**
     * As big as the area it lies in (the widgets' layer); the wallpaper
     * lines up with the desktop's.
     */
    _init() {
        super._init({style_class: 'atelier-desktop-glass', reactive: false, clip_to_allocation: true});
        Shell.util_set_hidden_from_pick(this, true);
        this._wallpaper = new Clutter.Actor();
        this.add_child(this._wallpaper);
        this._mask = new RectsMaskEffect();
        this.add_effect_with_name('atelier-desktop-glass-mask', this._mask);
        this._rects = [];
        this._radius = 0;
        this.connect('destroy', () => {
            this._bgManager?.destroy();
            this._bgManager = null;
        });
    }

    /**
     * @param {object} area - the layer's place on the stage: {x, y, width, height}
     */
    setArea(area) {
        this.set_size(area.width, area.height);
        this._apply();
        const index = Main.layoutManager.primaryIndex;
        const monitor = Main.layoutManager.monitors[index];
        if (!monitor)
            return;
        this._wallpaper.set_position(monitor.x - area.x, monitor.y - area.y);
        // A new copy of the wallpaper for another monitor only: blurring it
        // again shows. (The work area changes as workspaces come and go.)
        const key = [index, monitor.x, monitor.y, monitor.width, monitor.height].join(' ');
        if (this._bgManager && key === this._monitorKey)
            return;
        this._monitorKey = key;
        this._bgManager?.destroy();
        this._bgManager = new Background.BackgroundManager({
            container: this._wallpaper,
            monitorIndex: index,
            controlPosition: false,
        });
        this._bgManager.connect('changed', () => this._blur());
        this._blur();
    }

    _blur() {
        const actor = this._bgManager?.backgroundActor;
        if (!actor)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        actor.remove_effect_by_name('atelier-blur');
        actor.add_effect_with_name('atelier-blur', new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS * scale,
            brightness: BLUR_BRIGHTNESS,
        }));
    }

    /**
     * Show the glass under these rectangles.
     *
     * @param {number[][]} rects - [x, y, width, height] in the layer
     * @param {number} radius - of their corners
     */
    setRects(rects, radius) {
        this._rects = rects;
        this._radius = radius;
        this._apply();
    }

    _apply() {
        this._mask.setRects([this.width, this.height], this._rects, this._radius);
    }
});
