// Glass under the widgets: one copy of the wallpaper for the whole desktop,
// shown only where the widgets are – rounded rectangles that may move every
// frame (while a widget is dragged) with only the shader's uniforms
// changing – and where liquid flows (cards pouring to other places). It is
// Liquid Glass (shell/core/glassMaterial.js), each widget catching its own
// light, all of it darkened alike (the glass-dim setting), casting a shadow
// outside it as all of Atelier's glass does (the cards of glass none of
// their own: it would show through them, darker than the rest).

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';

import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {REST_LIGHT, boundsOf, edgeReach, sameLight} from '../../lib/glassLook.js';
import {syncTextureFrame} from '../core/glass.js';
import {glassLight} from '../core/glassLight.js';
import {
    GlassEasing, MATERIAL_CODE, MATERIAL_DECLARATIONS, glassScale, materialUniforms, setMaterial, setMaterialArea,
    STYLE_TIME, setMaterialReach, textureDensity,
} from '../core/glassMaterial.js';
import {LIQUID_DECLARATIONS, liquidUniforms, setLiquid} from '../core/liquid.js';

const MAX_RECTS = 32;

// The widgets' rectangles (and the liquid), each with the light it catches;
// a pixel is part of the one it is nearest to.
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

float atelier_others(vec2 p) {
    return 100000.0;
}

void atelier_part(vec2 p, out vec2 light, out float thick) {
    float nearest = 100000.0;
    light = vec2(${REST_LIGHT[0]}, ${REST_LIGHT[1]});
    thick = 0.0;
    for (int i = 0; i < ${MAX_RECTS}; i++) {
        if (float(i) >= count)
            break;
        float d = atelier_rect(p, rects[i]);
        if (d < nearest) {
            nearest = d;
            light = lights[i];
            thick = min(rects[i].z, rects[i].w);
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
        this._look = [null, 1, {}];
        this.setLights([]);
        this.setReach(null);
        this.setMaterial(null, 1);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, MATERIAL_CODE, false);
    }

    vfunc_paint_target(node, paintContext) {
        syncTextureFrame(this, this._origin, this._size);
        // (Its blur's taps are as many texels apart as its texture has.)
        const [look, scale, options] = this._look;
        const density = this.get_actor() ? textureDensity(this.get_actor()) : 1;
        if (look && density !== (options.density ?? 1))
            this.setMaterial(look, scale, {...options, density});
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
        // (Drawn anew as they are now: what it drew before was cached.)
        this.queue_repaint();
    }

    /** @param {number[][]} lights - where each rect's light comes from, [x, y] */
    setLights(lights) {
        const values = new Array(MAX_RECTS * 2).fill(0).map((_, i) => REST_LIGHT[i % 2]);
        lights.slice(0, MAX_RECTS).forEach((light, i) => values.splice(i * 2, 2, ...light));
        this.set_uniform_float(this._lights, 2, values);
    }

    /** @param {number[]|null} reach - [x1, y1, x2, y2] it draws within */
    setReach(reach) {
        setMaterialReach(this, this._material, reach);
    }

    /**
     * @param {object|null} look - LOOK's, null for only the shapes
     * @param {number} scale - pixels in a logical pixel
     * @param {object} [options] - {light, shadow, density, dim} (setMaterial())
     */
    setMaterial(look, scale, options = {}) {
        this._look = [look, scale, options];
        setMaterial(this, this._material, look, scale, options);
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
     * @param {boolean} [light] - GNOME's style is light
     */
    _init(look = null, light = false) {
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
        // GNOME's style and the glass's dim, eased.
        this._eased = new GlassEasing(this, keys => this._showEased(keys));
        this._look = look;
        this._lightStyle = light;
        this._eased.set('style', {light: light ? 1 : 0});
        this._eased.set('dim', {dim: look?.dim ?? 0});
        this._syncMaterial();
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor', () => {
            this._syncMaterial();
            this._apply();
        }, this);
        glassLight.add(this);
        this.connect('notify::mapped', () => glassLight.sync());
        this.connect('destroy', () => {
            glassLight.remove(this);
            this._eased.destroy();
            St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
            this._bgManager?.destroy();
            this._bgManager = null;
        });
    }

    /**
     * @param {object|null} look - another material (LOOK's), or darkened
     *   otherwise (eased there)
     * @param {boolean} [light] - GNOME's style is light
     */
    setLook(look, light = this._lightStyle) {
        if (look === this._look && light === this._lightStyle)
            return;
        this._look = look;
        this._lightStyle = light;
        this._eased.set('style', {light: light ? 1 : 0}, STYLE_TIME);
        this._eased.set('dim', {dim: look?.dim ?? 0});
        this._syncMaterial();
        glassLight.sync();
    }

    // (Its face as GNOME's style has it now – on its way from one to the
    // other over STYLE_TIME – and its dim, on its way to the look's.)
    _syncMaterial() {
        const {light = 0} = this._eased.shown('style');
        const {dim = 0} = this._eased.shown('dim');
        this._mask.setMaterial(this._look, glassScale(), {light, shadow: true, dim});
    }

    /** @returns {number} how much darker all of its glass is to be (its look's dim), 0 … 1 */
    get dim() {
        return this._eased.wanted('dim').dim ?? 0;
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
        // A new copy of the wallpaper for another monitor only: loading it
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
        // (Liquid may flow anywhere: all of it then.)
        const liquid = (this._liquid.boxes?.length ?? 0) + (this._liquid.capsules?.length ?? 0) > 0;
        const bounds = liquid ? [0, 0, this.width, this.height] : boundsOf(this._rects.slice(0, MAX_RECTS));
        const margin = edgeReach(true) * glassScale();
        this._mask.setReach(bounds && [bounds[0] - margin, bounds[1] - margin,
            bounds[0] + bounds[2] + margin, bounds[1] + bounds[3] + margin]);
    }

    // As eased now, drawn again. (All of it: drawn again only within a
    // widget's rectangle, the wallpaper in the texture the glass is painted
    // from is drawn there only, and the other widgets' glass, drawn from
    // that texture later, came out black.)
    _showEased(keys) {
        this._syncMaterial();
        if (keys.length > 0)
            this.queue_redraw();
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
     * @returns {boolean} whether any changed (and it is drawn again)
     */
    setLights(lights) {
        const changes = wanted => wanted.map((light, i) => !this._lights[i] || !sameLight(light, this._lights[i]));
        let changed = changes(lights);
        if (!changed.includes(true))
            return false;
        // Under windows (or anything else), the widgets may not be seen at
        // all: their light leans only while the pointer is on the desktop.
        if (lights.some(light => !sameLight(light, REST_LIGHT)) && !this._pointerOnDesktop()) {
            lights = lights.map(() => REST_LIGHT);
            changed = changes(lights);
            if (!changed.includes(true))
                return false;
        }
        this._lights = lights;
        this._mask.setLights(lights);
        // (All of it: _showEased().)
        this.queue_redraw();
        return true;
    }

    // Whether what the pointer is over is the desktop: the wallpaper or the
    // widgets. (Picked where it is: GNOME 50 no longer says which actor a
    // device is over.)
    _pointerOnDesktop() {
        const [x, y] = global.get_pointer();
        const actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        return Boolean(actor && (Main.layoutManager._backgroundGroup.contains(actor) ||
            this.get_parent()?.contains(actor)));
    }

    /** @returns {number[][]} where each widget's light comes from now */
    get lights() {
        return this._lights;
    }
});
