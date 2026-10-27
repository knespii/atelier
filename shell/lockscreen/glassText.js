// The lock screen's glass clock on the GPU: its figures Liquid Glass of the
// same material as all of Atelier's glass (shell/core/glassMaterial.js) –
// the wallpaper behind them bent by a lens along each stroke's edge, lightly
// blurred, their face neutral, a glint on their edges, a fine contour round
// them – washed towards the tone as much as their legibility plan has it,
// with a soft halo round them where it is planned; or, with no glass ('off',
// GNOME's high contrast), solid in the tone.
//
// One actor over the clock's face: the lock screen's wallpaper, sharp (its
// own BackgroundManager's, shown where it lies on the monitor, clipped to
// the face: GNOME's texture cache shares the picture), painted offscreen
// and drawn through the material. Its shape is the figures' signed
// distances (figureAtlas.js: a texture of tiles, one for each figure, made
// ahead of time), each figure a slot – where its tile lies on the face, how
// far it has moved and how much it shows (a minute turning) – so that
// nothing but a few numbers changes as the figures move; and nothing at all
// is drawn while they rest.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {REST_LIGHT, lookOf} from '../../lib/glassLook.js';
import {FAR, SDF_GLSL} from '../../lib/glyphSdf.js';
import {syncTextureFrame} from '../core/glass.js';
import {
    MATERIAL_CODE, MATERIAL_DECLARATIONS, materialUniforms, setMaterial, setMaterialArea, setMaterialReach,
    textureDensity,
} from '../core/glassMaterial.js';
import {ShapeTexture} from '../core/glassShapeTexture.js';

/**
 * Figures drawn at once at most: the five of a time, and while a minute
 * turns, those that go (all of them, as 9:59 becomes 10:00).
 */
export const MAX_SLOTS = 10;

const DECLARATIONS = `
#define ATELIER_OWN_NORMAL
#define ATELIER_WASH
uniform vec2 origin;
uniform vec2 size;
uniform vec4 slotBox[${MAX_SLOTS}];
uniform vec4 slotAtlas[${MAX_SLOTS}];
uniform vec4 slotLook[${MAX_SLOTS}];
uniform float slotCount;
uniform float clipTop;
uniform vec2 glassLight;
uniform vec4 atelier_wash;
uniform vec4 clockSolid;
uniform vec4 clockHalo;
uniform vec4 clockHaloColor;
${SDF_GLSL}

// The figures at a point, worked out once for it: how far it is from the
// nearest (below 0 inside), that one's normal there and how thick its
// strokes are, and how much of what is drawn there shows (a figure fading
// as it goes, or comes).
vec2 atelier_clock_at = vec2(-100000.0);
float atelier_clock_d = 100000.0;
vec2 atelier_clock_n = vec2(0.0);
float atelier_clock_thick = 0.0;
float atelier_clock_fade = 0.0;

void atelier_clock(vec2 p) {
    if (p == atelier_clock_at)
        return;
    atelier_clock_at = p;
    atelier_clock_d = 100000.0;
    atelier_clock_n = vec2(0.0);
    atelier_clock_thick = 0.0;
    atelier_clock_fade = 0.0;
    for (int i = 0; i < ${MAX_SLOTS}; i++) {
        if (float(i) >= slotCount)
            break;
        vec4 look = slotLook[i];
        // (One moving up goes no higher than the figures' top: the date
        // line is there.)
        if (look.y < 0.004 || (look.x < 0.0 && p.y < clipTop))
            continue;
        vec2 q = p - slotBox[i].xy - vec2(0.0, look.x);
        vec2 past = max(max(-q, q - slotBox[i].zw), 0.0);
        float d;
        vec2 n = vec2(0.0);
        if (past.x + past.y > 0.0) {
            d = ${FAR}.0 * look.z + length(past);
        } else {
            vec4 texel = texture2D(cogl_sampler1, slotAtlas[i].xy + q / slotBox[i].zw * slotAtlas[i].zw);
            d = atelier_sdf_distance(texel) * look.z;
            n = atelier_sdf_normal(texel);
        }
        atelier_clock_fade = max(atelier_clock_fade, look.y * clamp(clockHalo.w - d, 0.0, 1.0));
        if (d < atelier_clock_d) {
            atelier_clock_d = d;
            atelier_clock_n = n;
            atelier_clock_thick = look.w;
        }
    }
}

float atelier_shape(vec2 p) {
    atelier_clock(p);
    return atelier_clock_d;
}

float atelier_body(vec2 p) {
    return atelier_shape(p);
}

float atelier_others(vec2 p) {
    return 100000.0;
}

vec2 atelier_normal(vec2 p) {
    atelier_clock(p);
    return dot(atelier_clock_n, atelier_clock_n) > 0.25 ? normalize(atelier_clock_n) : vec2(0.0);
}

void atelier_part(vec2 p, out vec2 light, out float thick) {
    atelier_clock(p);
    light = glassLight;
    thick = atelier_clock_thick;
}
${MATERIAL_DECLARATIONS}
`;

// After the material: solid figures where there is no glass; the halo
// under what is drawn, round the figures only; and all of it as much as
// the figures there show.
const CODE = `${MATERIAL_CODE}
if (atelier_p.x >= glassReach.x && atelier_p.y >= glassReach.y &&
    atelier_p.x <= glassReach.z && atelier_p.y <= glassReach.w) {
    atelier_clock(atelier_p);
    float atelier_cover = clamp(0.5 - atelier_clock_d, 0.0, 1.0);
    float atelier_fade = atelier_clock_fade;
    if (clockSolid.w > 0.5)
        cogl_color_out = vec4(clockSolid.rgb, 1.0) * atelier_cover * cogl_color_in.a;
    if (clockHalo.z > 0.0 && atelier_cover < 1.0) {
        atelier_clock(atelier_p - vec2(0.0, clockHalo.x));
        float atelier_halo = clockHalo.z / (1.0 + exp(min(1.702 * atelier_clock_d / clockHalo.y, 30.0))) *
            (1.0 - atelier_cover) * cogl_color_in.a;
        cogl_color_out += vec4(clockHaloColor.rgb, 1.0) * atelier_halo * (1.0 - cogl_color_out.a);
    }
    cogl_color_out *= atelier_fade;
} else {
    cogl_color_out = vec4(0.0);
}
`;

const ClockGlassEffect = GObject.registerClass(
class AtelierClockGlassEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        const names = ['origin', 'size', 'slotBox', 'slotAtlas', 'slotLook', 'slotCount', 'clipTop', 'glassLight',
            'atelier_wash', 'clockSolid', 'clockHalo', 'clockHaloColor'];
        this._at = Object.fromEntries(names.map(name => [name, this.get_uniform_location(name)]));
        this._material = materialUniforms(this);
        this._look = [null, 1, {}];
        // (Layer 1 always has a texture: the figures' atlas, or a clear one.)
        this._none = new ShapeTexture();
        this._texture = this._none;
        /** How many times it has been drawn. */
        this.paints = 0;
        this.set_uniform_float(this._at.glassLight, 2, REST_LIGHT);
        this.setSlots([], 0, 0);
        this.setLook({});
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    vfunc_paint_target(node, paintContext) {
        const actor = this.get_actor();
        syncTextureFrame(this, this._at.origin, this._at.size);
        setMaterialArea(this, this._material, [actor.width, actor.height]);
        // (Its blur's taps are as many texels apart as its texture has.)
        const [look, scale, options] = this._look;
        const density = textureDensity(actor);
        if (density !== (options.density ?? 1))
            this._setMaterial(look, scale, {...options, density});
        this._texture.bind(this);
        this.paints++;
        super.vfunc_paint_target(node, paintContext);
    }

    _setMaterial(look, scale, options) {
        this._look = [look, scale, options];
        setMaterial(this, this._material, look, scale, options);
    }

    /** @param {ShapeTexture|null} texture - the figures' atlas */
    setTexture(texture) {
        const next = texture ?? this._none;
        if (next === this._texture)
            return;
        this._texture.unbind(this);
        this._texture = next;
        this.queue_repaint();
    }

    /**
     * @param {object[]} slots - {box, uv, dy, alpha, scale, thick} each
     * @param {number} clipTop - figures moving up go no higher
     * @param {number} reach - how far round a figure its glass draws, px
     */
    setSlots(slots, clipTop, reach) {
        const [boxes, uvs, looks] = [[], [], []];
        for (let i = 0; i < MAX_SLOTS; i++) {
            const slot = slots[i];
            boxes.push(...slot?.box ?? [0, 0, 0, 0]);
            uvs.push(...slot?.uv ?? [0, 0, 0, 0]);
            looks.push(...slot ? [slot.dy, slot.alpha, slot.scale, slot.thick] : [0, 0, 1, 0]);
        }
        this.set_uniform_float(this._at.slotBox, 4, boxes);
        this.set_uniform_float(this._at.slotAtlas, 4, uvs);
        this.set_uniform_float(this._at.slotLook, 4, looks);
        this.set_uniform_float(this._at.slotCount, 1, [Math.min(MAX_SLOTS, slots.length)]);
        this.set_uniform_float(this._at.clipTop, 1, [clipTop]);
        this._reach = reach;
        this._syncHalo();
        // (Drawn within the slots, as far round them as the glass draws.)
        const shown = slots.filter(slot => slot.alpha > 0.004);
        const bounds = shown.length === 0 ? null : [
            Math.min(...shown.map(s => s.box[0])), Math.min(...shown.map(s => s.box[1] + Math.min(0, s.dy))),
            Math.max(...shown.map(s => s.box[0] + s.box[2])), Math.max(...shown.map(s => s.box[1] + s.box[3] + Math.max(0, s.dy))),
        ];
        setMaterialReach(this, this._material, bounds);
        this.queue_repaint();
    }

    /**
     * @param {object} options
     * @param {object|null} [options.look] - lib/glassLook.js LOOK's; none:
     *   solid figures
     * @param {boolean} [options.light] - light glass (light type), else dark
     * @param {number} [options.scale] - pixels in a logical pixel
     * @param {number[]} [options.tone] - [r, g, b] 0 … 1 of the type's tone
     * @param {number} [options.wash] - how far the glass is washed towards it
     * @param {object|null} [options.halo] - {y, sigma, alpha, color: [r, g,
     *   b]} round the figures, px; null for none
     */
    setLook({look = null, light = true, scale = 1, tone = [1, 1, 1], wash = 0, halo = null}) {
        this._setMaterial(look, scale, {light, shadow: false, density: this._look[2].density ?? 1});
        this.set_uniform_float(this._at.atelier_wash, 4, [...tone, look ? wash : 0]);
        this.set_uniform_float(this._at.clockSolid, 4, [...tone, look ? 0 : 1]);
        this._halo = halo;
        this._syncHalo();
        this.queue_repaint();
    }

    _syncHalo() {
        const halo = this._halo;
        this.set_uniform_float(this._at.clockHalo, 4,
            [halo?.y ?? 0, Math.max(0.5, halo?.sigma ?? 1), halo?.alpha ?? 0, this._reach ?? 0]);
        this.set_uniform_float(this._at.clockHaloColor, 4, [...halo?.color ?? [0, 0, 0], 0]);
    }
});

// The wallpaper behind the figures: as many times as it is painted (only
// when it, or where it lies, changes: else the effect draws again from
// what it painted).
const Wallpaper = GObject.registerClass(
class AtelierGlassTextWallpaper extends Clutter.Actor {
    _init() {
        super._init();
        this.paints = 0;
    }

    vfunc_paint(context) {
        this.paints++;
        super.vfunc_paint(context);
    }
});

export const GlassText = GObject.registerClass(
class AtelierGlassText extends Clutter.Actor {
    _init() {
        super._init({clip_to_allocation: true});
        this._wallpaper = new Wallpaper();
        this.add_child(this._wallpaper);
        this._effect = new ClockGlassEffect();
        this.add_effect(this._effect);
        this._manager = null;
        this._at = null;
        this._atlas = null;
        /** How many times its figures were moved, faded or laid anew (only numbers given the GPU). */
        this.slotUpdates = 0;
        this.connect('destroy', () => {
            this._manager?.destroy();
            this._manager = null;
            this._effect.setTexture(null);
        });
    }

    // (As large as it is laid out: the wallpaper in it asks for none of it.)
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }

    /** @returns {number} how many times it has been drawn */
    get paints() {
        return this._effect.paints;
    }

    /** @returns {number} how many times what is behind it was painted anew */
    get renders() {
        return this._wallpaper.paints;
    }

    /** @returns {object|null} the atlas its figures are drawn from */
    get atlas() {
        return this._atlas;
    }

    /**
     * @param {boolean} glass - whether the figures are glass (the wallpaper
     *   behind them shown through), or solid
     */
    setGlass(glass) {
        if (glass === Boolean(this._manager))
            return;
        if (glass) {
            const monitor = Main.layoutManager.primaryMonitor;
            this._wallpaper.set_size(monitor?.width ?? 0, monitor?.height ?? 0);
            this._manager = new Background.BackgroundManager({
                container: this._wallpaper,
                monitorIndex: Main.layoutManager.primaryIndex,
                controlPosition: false,
            });
            this._wallpaper.show();
        } else {
            this._manager.destroy();
            this._manager = null;
            this._wallpaper.hide();
        }
    }

    /**
     * Where it is on the main monitor: the wallpaper behind it lies there.
     *
     * @param {number[]} at - [x, y] of its top left on the monitor
     */
    setPlace(at) {
        if (this._at?.[0] === at[0] && this._at?.[1] === at[1])
            return;
        this._at = [...at];
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor && (this._wallpaper.width !== monitor.width || this._wallpaper.height !== monitor.height))
            this._wallpaper.set_size(monitor.width, monitor.height);
        this._wallpaper.set_position(-at[0], -at[1]);
    }

    /** @returns {number[]|null} where it was last placed on the monitor */
    get place() {
        return this._at;
    }

    /** @param {object|null} atlas - figureAtlas.js's: the figures' tiles */
    setAtlas(atlas) {
        this._atlas = atlas;
        this._effect.setTexture(atlas?.texture ?? null);
    }

    /**
     * The figures where they are now.
     *
     * @param {object[]} slots - {box: [x, y, width, height] of its tile, in
     *   the actor; uv: [u, v, du, dv] of it in the atlas; dy: how far it is
     *   moved down; alpha: how much it shows; scale: its pixels in a px of
     *   the tile; thick: how thick its strokes are, its pixels}
     * @param {object} [options]
     * @param {number} [options.clipTop] - figures moving up go no higher
     * @param {number} [options.reach] - how far round them their glass
     *   draws, pixels
     */
    setSlots(slots, {clipTop = 0, reach = 0} = {}) {
        this.slotUpdates++;
        this._effect.setSlots(slots.slice(0, MAX_SLOTS), clipTop, reach);
    }

    /**
     * How the figures look: as the glass is (lib/glassLook.js variants),
     * the tone and how much the glass is washed with it, a halo.
     *
     * @param {object} options
     * @param {string} options.variant - 'regular', 'clear' or 'off'
     * @param {boolean} options.light - light type: light glass
     * @param {number} options.scale - pixels in a logical pixel
     * @param {number[]} options.tone - [r, g, b] 0 … 1
     * @param {number} options.wash - 0 … 1
     * @param {object|null} options.halo - as ClockGlassEffect's setLook()
     */
    setLook({variant, light, scale, tone, wash, halo}) {
        const look = lookOf(variant);
        this.setGlass(Boolean(look));
        this._effect.setLook({look, light, scale, tone, wash, halo});
    }
});
