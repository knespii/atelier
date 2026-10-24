// Glass under the widgets: one blurred copy of the wallpaper for the whole
// desktop, shown only where the widgets are – rounded rectangles that may
// move every frame (while a widget is dragged) without blurring anything
// again – and where liquid flows (cards pouring to other places). It is
// Liquid Glass (shell/core/glassMaterial.js), each widget catching its own
// light.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {REST_LIGHT, sameLight} from '../../lib/glassLook.js';
import {syncTextureFrame} from '../core/glass.js';
import {glassLight} from '../core/glassLight.js';
import {
    MATERIAL_CODE, MATERIAL_DECLARATIONS, glassScale, materialUniforms, setMaterial, setMaterialArea,
} from '../core/glassMaterial.js';
import {LIQUID_DECLARATIONS, liquidUniforms, setLiquid} from '../core/liquid.js';

const MAX_RECTS = 32;
const BLUR_RADIUS = 40; // logical pixels
const BLUR_BRIGHTNESS = 0.8;

// The widgets' rectangles (and the liquid), each with the light it catches;
// the sheen runs across the one a pixel is nearest to.
const DECLARATIONS = `
uniform vec2 origin;
uniform vec2 size;
uniform float radius;
uniform float count;
uniform vec4 rects[${MAX_RECTS}];
uniform vec2 lights[${MAX_RECTS}];
${LIQUID_DECLARATIONS}

float atelier_rect(vec2 p, vec4 r) {
    vec2 halfSize = r.zw * 0.5;
    vec2 q = abs(p - r.xy - halfSize) - halfSize + vec2(radius);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float atelier_shape(vec2 p) {
    float d = 100000.0;
    for (int i = 0; i < ${MAX_RECTS}; i++) {
        if (float(i) >= count)
            break;
        d = min(d, atelier_rect(p, rects[i]));
    }
    if (liquidBoxCount + liquidCapsuleCount > 0.0)
        d = min(d, atelier_liquid(p));
    return d;
}

float atelier_body(vec2 p) {
    return atelier_shape(p);
}

void atelier_part(vec2 p, out vec4 frame, out vec2 light) {
    float nearest = 100000.0;
    frame = vec4(0.0);
    light = vec2(0.0, -1.0);
    for (int i = 0; i < ${MAX_RECTS}; i++) {
        if (float(i) >= count)
            break;
        float d = atelier_rect(p, rects[i]);
        if (d < nearest) {
            nearest = d;
            frame = rects[i];
            light = lights[i];
        }
    }
}
${MATERIAL_DECLARATIONS}
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
        this._lights = this.get_uniform_location('lights');
        this._liquid = liquidUniforms(this);
        this._material = materialUniforms(this);
        this.setLights([]);
        this.setMaterial(null, 1);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, MATERIAL_CODE, false);
    }

    vfunc_paint_target(node, paintContext) {
        syncTextureFrame(this, this._origin, this._size);
        super.vfunc_paint_target(node, paintContext);
    }

    /**
     * @param {number[]} size - [width, height] of the actor
     * @param {number[][]} rects - [x, y, width, height] in it
     * @param {number} radius - of their corners
     * @param {object} liquid - {boxes, capsules} (lib/liquid.js)
     */
    setRects(size, rects, radius, liquid) {
        const values = new Array(MAX_RECTS * 4).fill(0);
        rects.slice(0, MAX_RECTS).forEach((rect, i) => values.splice(i * 4, 4, ...rect));
        this.set_uniform_float(this._origin, 2, [0, 0]);
        this.set_uniform_float(this._size, 2, size);
        setMaterialArea(this, this._material, size);
        this.set_uniform_float(this._radius, 1, [radius]);
        this.set_uniform_float(this._count, 1, [Math.min(rects.length, MAX_RECTS)]);
        this.set_uniform_float(this._rects, 4, values);
        setLiquid(this, this._liquid, liquid);
    }

    /** @param {number[][]} lights - where each rect's light comes from, [x, y] */
    setLights(lights) {
        const values = new Array(MAX_RECTS * 2).fill(0).map((_, i) => REST_LIGHT[i % 2]);
        lights.slice(0, MAX_RECTS).forEach((light, i) => values.splice(i * 2, 2, ...light));
        this.set_uniform_float(this._lights, 2, values);
    }

    /**
     * @param {object|null} look - LOOK's, null for only the shapes
     * @param {number} scale - pixels in a logical pixel
     */
    setMaterial(look, scale) {
        setMaterial(this, this._material, look, scale);
        this.queue_repaint();
    }
});

export const DesktopGlass = GObject.registerClass(
class AtelierDesktopGlass extends St.Widget {
    /**
     * As big as the area it lies in (the widgets' layer); the wallpaper
     * lines up with the desktop's.
     *
     * @param {object|null} [look] - the material (lib/glassLook.js LOOK's)
     */
    _init(look = null) {
        super._init({style_class: 'atelier-desktop-glass', reactive: false, clip_to_allocation: true});
        Shell.util_set_hidden_from_pick(this, true);
        this._wallpaper = new Clutter.Actor();
        this.add_child(this._wallpaper);
        this._mask = new RectsMaskEffect();
        this.add_effect_with_name('atelier-desktop-glass-mask', this._mask);
        this._rects = [];
        this._radius = 0;
        this._liquid = {};
        this._lights = [];
        this._look = look;
        this._mask.setMaterial(look, glassScale());
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor',
            () => this._mask.setMaterial(this._look, glassScale()), this);
        glassLight.add(this);
        this.connect('notify::mapped', () => glassLight.sync());
        this.connect('destroy', () => {
            glassLight.remove(this);
            St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
            this._bgManager?.destroy();
            this._bgManager = null;
        });
    }

    /** @param {object|null} look - another material (LOOK's) */
    setLook(look) {
        if (look === this._look)
            return;
        const frosted = this._frost;
        this._look = look;
        this._mask.setMaterial(look, glassScale());
        // (Less frosted, it is blurred anew.)
        if (this._frost !== frosted)
            this._blur();
        glassLight.sync();
    }

    // How frosted it is (LOOK's): a share of its blur.
    get _frost() {
        return this._look?.frost ?? 1;
    }

    /** @returns {object|null} the material it is drawn with */
    get look() {
        return this._look;
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
            radius: BLUR_RADIUS * scale * this._frost,
            brightness: BLUR_BRIGHTNESS,
        }));
    }

    /**
     * Show the glass under these rectangles.
     *
     * @param {number[][]} rects - [x, y, width, height] in the layer
     * @param {number} radius - of their corners
     * @param {object} [liquid] - {boxes, capsules} (lib/liquid.js), in the layer
     */
    setRects(rects, radius, liquid = {}) {
        const moved = rects.length !== this._rects.length;
        this._rects = rects;
        this._radius = radius;
        this._liquid = liquid;
        // (Others than before: each with the light from above, until the
        // pointer says otherwise.)
        if (moved) {
            this._lights = rects.map(() => REST_LIGHT);
            this._mask.setLights(this._lights);
        }
        this._apply();
        glassLight.refresh(this);
    }

    _apply() {
        this._mask.setRects([this.width, this.height], this._rects, this._radius, this._liquid);
    }

    /**
     * For the light (shell/core/glassLight.js): each widget's rectangle on
     * the stage, while they are shown.
     *
     * @returns {number[][]}
     */
    lightAreas() {
        if (!this._look || !this.mapped || this.opacity === 0)
            return [];
        const [x, y] = this.get_transformed_position();
        return this._rects.slice(0, MAX_RECTS).map(([rx, ry, width, height]) => [x + rx, y + ry, width, height]);
    }

    /** @returns {object|null} how the light leans (LOOK's) */
    lightLook() {
        return this._look?.light ?? null;
    }

    /**
     * @param {number[][]} lights - where each widget's light comes from
     * @returns {boolean} whether any changed (those are drawn again, only
     *   where they are)
     */
    setLights(lights) {
        const changed = lights.map((light, i) => !this._lights[i] || !sameLight(light, this._lights[i]));
        if (!changed.includes(true))
            return false;
        this._lights = lights;
        this._mask.setLights(lights);
        changed.forEach((yes, i) => {
            const rect = this._rects[i];
            if (!yes || !rect)
                return;
            const [x, y, width, height] = rect;
            const [x1, y1] = [Math.floor(x) - 2, Math.floor(y) - 2];
            this.queue_redraw_with_clip(new Mtk.Rectangle({
                x: x1, y: y1, width: Math.ceil(x + width) + 2 - x1, height: Math.ceil(y + height) + 2 - y1,
            }));
        });
        return true;
    }

    /** @returns {number[][]} where each widget's light comes from now */
    get lights() {
        return this._lights;
    }
});
