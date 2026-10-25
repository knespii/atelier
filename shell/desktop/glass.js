// Glass under the widgets: one blurred copy of the wallpaper for the whole
// desktop, shown only where the widgets are – rounded rectangles that may
// move every frame (while a widget is dragged) without blurring anything
// again – and where liquid flows (cards pouring to other places). It is
// Liquid Glass (shell/core/glassMaterial.js), each widget catching its own
// light, and shaded as its own type needs (shell/core/vibrancy.js).

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
    GlassShades, MATERIAL_CODE, MATERIAL_DECLARATIONS, glassScale, materialUniforms, setMaterial, setMaterialArea,
} from '../core/glassMaterial.js';
import {LIQUID_DECLARATIONS, liquidUniforms, setLiquid} from '../core/liquid.js';

const MAX_RECTS = 32;
const BLUR_RADIUS = 40; // logical pixels
// How bright the blur leaves the wallpaper, in the light style and the dark.
const BLUR_BRIGHTNESS = {light: 1, smoky: 0.92};

// The widgets' rectangles (and the liquid), each with the light it catches
// and its shade; the sheen runs across the one a pixel is nearest to.
const DECLARATIONS = `
uniform vec2 origin;
uniform vec2 size;
uniform float radius;
uniform float count;
uniform vec4 rects[${MAX_RECTS}];
uniform vec2 lights[${MAX_RECTS}];
uniform vec2 shades[${MAX_RECTS}];
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

void atelier_part(vec2 p, out vec4 frame, out vec2 light, out vec2 shade) {
    float nearest = 100000.0;
    frame = vec4(0.0);
    light = vec2(0.0, -1.0);
    shade = vec2(0.0);
    for (int i = 0; i < ${MAX_RECTS}; i++) {
        if (float(i) >= count)
            break;
        float d = atelier_rect(p, rects[i]);
        if (d < nearest) {
            nearest = d;
            frame = rects[i];
            light = lights[i];
            shade = shades[i];
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
        this._shades = this.get_uniform_location('shades');
        this._liquid = liquidUniforms(this);
        this._material = materialUniforms(this);
        this.setLights([]);
        this.setShades([]);
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

    /** @param {number[][]} shades - each rect's extra shade, [dim, veil] */
    setShades(shades) {
        const values = new Array(MAX_RECTS * 2).fill(0);
        shades.slice(0, MAX_RECTS).forEach((shade, i) => values.splice(i * 2, 2, ...shade));
        this.set_uniform_float(this._shades, 2, values);
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
        this._keys = [];
        this._radius = 0;
        this._liquid = {};
        this._lights = [];
        // Each widget's extra shade, by its key (shell/core/vibrancy.js).
        this._shades = new GlassShades(this, keys => this._showShades(keys));
        this._look = look;
        this._lightStyle = light;
        this._mask.setMaterial(look, glassScale());
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor',
            () => this._mask.setMaterial(this._look, glassScale()), this);
        glassLight.add(this);
        this.connect('notify::mapped', () => glassLight.sync());
        this.connect('destroy', () => {
            glassLight.remove(this);
            this._shades.destroy();
            St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
            this._bgManager?.destroy();
            this._bgManager = null;
        });
    }

    /**
     * @param {object|null} look - another material (LOOK's)
     * @param {boolean} [light] - GNOME's style is light
     */
    setLook(look, light = this._lightStyle) {
        if (look === this._look && light === this._lightStyle)
            return;
        const blurred = [this._frost, this._blurBrightness];
        this._look = look;
        this._lightStyle = light;
        this._mask.setMaterial(look, glassScale());
        // (Less frosted, or as bright as the other style has it: blurred
        // anew.)
        if (this._frost !== blurred[0] || this._blurBrightness !== blurred[1])
            this._blur();
        glassLight.sync();
    }

    // How frosted it is (LOOK's): a share of its blur.
    get _frost() {
        return this._look?.frost ?? 1;
    }

    // In GNOME's light style, the wallpaper as bright as it is; in its dark
    // one, dimmed a little (the cards' own colour is over it).
    get _blurBrightness() {
        return this._lightStyle ? BLUR_BRIGHTNESS.light : BLUR_BRIGHTNESS.smoky;
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
            brightness: this._blurBrightness,
        }));
    }

    /**
     * Show the glass under these rectangles.
     *
     * @param {number[][]} rects - [x, y, width, height] in the layer
     * @param {number} radius - of their corners
     * @param {object} [liquid] - {boxes, capsules} (lib/liquid.js), in the layer
     * @param {Array} [keys] - whose each rectangle is: its shade's key (setShade())
     */
    setRects(rects, radius, liquid = {}, keys = []) {
        const moved = rects.length !== this._rects.length;
        this._rects = rects;
        this._keys = keys;
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
        this._mask.setShades(this._rects.map((_, i) => this._shadeAt(i)));
    }

    // [dim, veil] of a rectangle's shade as it is now.
    _shadeAt(i) {
        const key = this._keys[i];
        if (key === undefined)
            return [0, 0];
        const {dim, veil} = this._shades.shown(key);
        return [dim, veil];
    }

    /**
     * A widget's extra shade, where its type would not read otherwise
     * (lib/vibrancy.js): darker under light type, lighter under dark –
     * eased to it. (None for plain blurred glass.)
     *
     * @param {*} key - the widget's, as setRects() has its rectangle
     * @param {object|null} shade - {dim, veil}; null: the widget is gone
     */
    setShade(key, shade) {
        if (!shade) {
            this._shades.delete(key);
            this._apply();
            return;
        }
        this._shades.set(key, shade);
    }

    /**
     * @param {*} key
     * @returns {object} the extra shade it is to have, {dim, veil}
     */
    shadeOf(key) {
        return this._shades.wanted(key);
    }

    // The shades as they are now, drawn again only where those widgets are.
    _showShades(keys) {
        this._mask.setShades(this._rects.map((_, i) => this._shadeAt(i)));
        this._rects.forEach((rect, i) => {
            if (keys.includes(this._keys[i]))
                this._redrawWithin(rect);
        });
    }

    // Drawn again only within a rectangle of the layer.
    _redrawWithin([x, y, width, height]) {
        const [x1, y1] = [Math.floor(x) - 2, Math.floor(y) - 2];
        this.queue_redraw_with_clip(new Mtk.Rectangle({
            x: x1, y: y1, width: Math.ceil(x + width) + 2 - x1, height: Math.ceil(y + height) + 2 - y1,
        }));
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
        changed.forEach((yes, i) => {
            const rect = this._rects[i];
            if (yes && rect)
                this._redrawWithin(rect);
        });
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
