// The lock screen's password popup in Liquid Glass, as all of Atelier's
// glass (shell/core/glassMaterial.js): the liquid it spreads out of and
// gathers back into (lib/liquid.js), and the popup itself while it is open,
// over the lock screen's wallpaper as it shows – a clone of GNOME's
// wallpapers and of their glass (glass.js), sharp or turned to glass as the
// prompt comes up – bent at its edges, lightly blurred, its face neutral,
// with a glint, a contour and a shadow, darkened as the glass-dim setting
// has all of Atelier's glass.
//
// It covers only as far as the liquid flows (and its shadow round it), not
// all of the monitor: what it is drawn in is made as it first shows, and
// over all of a large monitor that would take a frame of its own. While
// the popup rests nothing but what is behind it changing draws it anew.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {REST_LIGHT, edgeReach} from '../../lib/glassLook.js';
import {GlassSurface, WindowsClone, syncTextureFrame} from '../core/glass.js';
import {
    MATERIAL_CODE, MATERIAL_DECLARATIONS, glassScale, materialUniforms, setMaterial, setMaterialArea,
    setMaterialReach, textureDensity,
} from '../core/glassMaterial.js';
import {LIQUID_DECLARATIONS, liquidUniforms, setLiquid} from '../core/liquid.js';

// The liquid's shapes, one glass; the short side of its largest part.
const DECLARATIONS = `
uniform vec2 origin;
uniform vec2 size;
uniform vec2 glassLight;
uniform float partThick;
${LIQUID_DECLARATIONS}

float atelier_shape(vec2 p) {
    return atelier_liquid(p);
}

float atelier_body(vec2 p) {
    return atelier_liquid(p);
}

float atelier_others(vec2 p) {
    return 100000.0;
}

void atelier_part(vec2 p, out vec2 light, out float thick) {
    light = glassLight;
    thick = partThick;
}
${MATERIAL_DECLARATIONS}
`;

const PopupGlassEffect = GObject.registerClass(
class AtelierLockPopupGlassEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        const names = ['origin', 'size', 'glassLight', 'partThick'];
        this._at = Object.fromEntries(names.map(name => [name, this.get_uniform_location(name)]));
        this.liquid = liquidUniforms(this);
        this.material = materialUniforms(this);
        this._look = [null, 1, {}];
        this.set_uniform_float(this._at.glassLight, 2, REST_LIGHT);
        this.setThick(0);
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, MATERIAL_CODE, false);
    }

    vfunc_paint_target(node, paintContext) {
        const actor = this.get_actor();
        syncTextureFrame(this, this._at.origin, this._at.size);
        setMaterialArea(this, this.material, [actor.width, actor.height]);
        // (Its blur's taps are as many texels apart as its texture has.)
        const [look, scale, options] = this._look;
        const density = textureDensity(actor);
        if (look && density !== (options.density ?? 1))
            this.setMaterial(look, scale, {...options, density});
        super.vfunc_paint_target(node, paintContext);
    }

    setMaterial(look, scale, options) {
        this._look = [look, scale, options];
        setMaterial(this, this.material, look, scale, options);
        this.queue_repaint();
    }

    /** @param {number} thick - the short side of its largest part, pixels */
    setThick(thick) {
        this.set_uniform_float(this._at.partThick, 1, [thick]);
    }
});

/**
 * The popup's glass: put it where the liquid flows (on the stage at `at`),
 * and give it the liquid's shapes, in its own pixels, every frame.
 */
export const PopupGlass = GObject.registerClass(
class AtelierLockPopupGlass extends St.Widget {
    /**
     * @param {object} params
     * @param {Clutter.Actor} params.source - what is behind it: an actor
     *   as large as the stage, at its corner (GNOME's wallpapers)
     * @param {object} params.look - lib/glassLook.js LOOK's, dimmed
     *   (dimmedLook())
     * @param {boolean} params.light - GNOME's style is light
     */
    _init({source, look, light}) {
        super._init({reactive: false, clip_to_allocation: true});
        Shell.util_set_hidden_from_pick(this, true);
        this._behind = new WindowsClone({source});
        this._behind.set_size(global.stage.width, global.stage.height);
        this.add_child(this._behind);
        this._effect = new PopupGlassEffect();
        this.add_effect_with_name('atelier-popup-glass', this._effect);
        this._effect.setMaterial(look, glassScale(), {light, shadow: true});
        this._look = look;
        /** The shapes it was given last. */
        this.shapes = {boxes: [], capsules: []};
        this.placedAt = null;
        this.setShapes(this.shapes);
    }

    /**
     * Where it is: on the stage, and its size (what it draws in).
     *
     * @param {number[]} at - [x, y] of its top left on the stage
     * @param {number[]} parentAt - [x, y] of its parent's on the stage
     * @param {number[]} size - [width, height]
     */
    place([x, y], [px, py], [width, height]) {
        this.set_position(x - px, y - py);
        this.set_size(width, height);
        /** Where its parent was on the stage as it was placed. */
        this.placedAt = [px, py];
        // (What is at the stage's corner at the stage's.)
        this._behind.set_position(-x, -y);
    }

    /**
     * @param {object} shapes - {boxes, capsules} (lib/liquid.js), in its
     *   pixels
     */
    setShapes(shapes) {
        this.shapes = shapes;
        const {boxes = [], capsules = []} = shapes;
        setLiquid(this._effect, this._effect.liquid, shapes);
        const thick = Math.max(0, ...boxes.map(b => 2 * Math.min(b[2], b[3])), ...capsules.map(c => 2 * c[4]));
        this._effect.setThick(thick);
        // (Drawn within them, as far round as its contour and shadow go.)
        const margin = edgeReach(true) * glassScale();
        const rects = [
            ...boxes.map(([cx, cy, hw, hh]) => [cx - hw, cy - hh, cx + hw, cy + hh]),
            ...capsules.map(([ax, ay, bx, by, r]) => [Math.min(ax, bx) - r, Math.min(ay, by) - r,
                Math.max(ax, bx) + r, Math.max(ay, by) + r]),
        ];
        setMaterialReach(this._effect, this._effect.material, rects.length === 0 ? null : [
            Math.min(...rects.map(r => r[0])) - margin, Math.min(...rects.map(r => r[1])) - margin,
            Math.max(...rects.map(r => r[2])) + margin, Math.max(...rects.map(r => r[3])) + margin,
        ]);
    }

    /** @returns {object} the material it is drawn with (its dim: look.dim) */
    get look() {
        return this._look;
    }

    /** @returns {Clutter.Actor|null} what its glass shows */
    get source() {
        return this._behind.source;
    }
});

// Whether the lock screen's glass has been drawn once in this shell.
let warm = false;
/** @returns {boolean} whether the lock screen's glass was drawn ahead of it in this shell */
export function lockGlassWarm() {
    return warm;
}

// How long the warm-up waits for its frame at most, ms.
const WARM_UP_WAIT = 2000;

/**
 * Draw the lock screen's glass once in the session, ahead of the lock
 * screen, out of sight: the popup's, and a surface's over a picture of
 * what is behind it, as the island's is there. The GPU makes the programs
 * they are drawn with the first time they are drawn – here, with the
 * session's first frames, not as the password is first asked (a third of
 * a second there at 150 %, the popup's liquid frozen, the first time after
 * each start of the shell). Once in the shell.
 *
 * @param {object} look - the glass's (lib/glassLook.js LOOK's)
 * @param {boolean} light - GNOME's style is light
 */
export function warmUpLockGlass(look, light) {
    const group = Main.layoutManager.uiGroup;
    if (warm || !look || !group)
        return;
    warm = true;
    // (Under the windows and the wallpaper: drawn, never seen. What is
    // behind them here is any picture: the programs are the same.)
    const holder = new Clutter.Actor({x: 0, y: 0, width: 16, height: 16, reactive: false});
    Shell.util_set_hidden_from_pick(holder, true);
    group.insert_child_at_index(holder, 0);
    const behind = new Clutter.Actor({width: 16, height: 16, background_color: Cogl.Color.from_string('grey')[1]});
    holder.add_child(behind);
    const popup = new PopupGlass({source: behind, look, light});
    holder.add_child(popup);
    popup.place([0, 0], [0, 0], [16, 16]);
    popup.setShapes({boxes: [[8, 8, 6, 6, 3]], capsules: []});
    const surface = new GlassSurface({reach: 0.02, look, light, source: behind});
    holder.add_child(surface);
    surface.setShape(0, 0, 12, 12, 4);
    let timeoutId = 0;
    let gone = false;
    const done = () => {
        if (!gone)
            holder.destroy();
    };
    // (Gone a frame after it was drawn – or with the UI, as the shell quits.)
    global.stage.connectObject('after-paint', () => {
        global.stage.disconnectObject(holder);
        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            done();
            return GLib.SOURCE_REMOVE;
        });
    }, holder);
    holder.connect('destroy', () => {
        gone = true;
        global.stage.disconnectObject(holder);
        if (timeoutId)
            GLib.source_remove(timeoutId);
        timeoutId = 0;
    });
    timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WARM_UP_WAIT, () => {
        timeoutId = 0;
        done();
        return GLib.SOURCE_REMOVE;
    });
}
