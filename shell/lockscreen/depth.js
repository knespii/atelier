// The depth effect on the lock screen (and the editor's mock one): the
// cutout of the wallpaper (lib/depth.js), made in the session, laid exactly
// over the wallpaper as GNOME draws it – over the clocks, under everything
// else, as on an iPhone: the wallpaper, the clock, what stands in front.
// The date over a clock stays in front of it all the same: the cutout has
// a hole where the date is (under it is the same wallpaper, so the hole
// shows the date over the subject, nothing else). Only a cutout that is
// there shows: nothing here makes one, nor launches anything. It goes with
// the clocks as the prompt comes up and the wallpaper blurs (the board
// fades them as one), and stays off while it would hide too much of a digit
// of a clock.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {cutoutPath, legibility, lockWallpaper, pictureState, placement} from '../../lib/depth.js';
import {syncTextureFrame} from '../core/glass.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const SAMPLE_WIDTH = 480; // the cutout's subject, looked at this small, pixels
// The lines kept in front, at most; and how softly a hole's edge goes
// (pixels): the cutout and the wallpaper under it are drawn apart, a hard
// edge could show where they differ by a hair.
const MAX_HOLES = 8;
const FEATHER = 3;

const HOLES_DECLARATIONS = `
uniform vec2 origin;
uniform vec2 size;
uniform float count;
uniform float feather;
uniform vec4 holes[${MAX_HOLES}];
`;

// After the texture lookup (premultiplied: all four channels). Each hole a
// rectangle (x, y, width, height in the actor), cut out whole, its edge
// fading in outside it.
const HOLES_CODE = `
vec2 p = origin + cogl_tex_coord_in[0].xy * size;
float keep = 1.0;
for (int i = 0; i < ${MAX_HOLES}; i++) {
    if (float(i) >= count)
        break;
    vec2 halfSize = holes[i].zw * 0.5;
    vec2 q = abs(p - holes[i].xy - halfSize) - halfSize;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    keep = min(keep, smoothstep(0.0, feather, d));
}
cogl_color_out *= keep;
`;

// The cutout less the lines kept in front of it, wherever they are as it
// is drawn: their places are asked for each time it is (a widget dragged,
// a clock going up over the popup), which costs a few sums.
const HolesEffect = GObject.registerClass(
class AtelierDepthHolesEffect extends Shell.GLSLEffect {
    _init(params) {
        super._init(params);
        this._origin = this.get_uniform_location('origin');
        this._size = this.get_uniform_location('size');
        this._count = this.get_uniform_location('count');
        this._feather = this.get_uniform_location('feather');
        this._holes = this.get_uniform_location('holes');
        /** () => [x, y, width, height] of each hole, in the actor */
        this.holesOf = null;
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, HOLES_DECLARATIONS, HOLES_CODE, false);
    }

    vfunc_paint_target(node, paintContext) {
        syncTextureFrame(this, this._origin, this._size);
        const holes = this.holesOf?.().slice(0, MAX_HOLES) ?? [];
        const values = new Array(MAX_HOLES * 4).fill(0);
        holes.forEach((hole, i) => values.splice(i * 4, 4, ...hole));
        this.set_uniform_float(this._count, 1, [holes.length]);
        this.set_uniform_float(this._feather, 1, [FEATHER * St.ThemeContext.get_for_stage(global.stage).scale_factor]);
        this.set_uniform_float(this._holes, 4, values);
        super.vfunc_paint_target(node, paintContext);
    }
});

function pixbufOf(stream, cancellable) {
    return new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.new_from_stream_async(stream, cancellable, (_, res) => {
            try {
                resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function fileInfoOf(path, cancellable) {
    return new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.get_file_info_async(path, cancellable, (_, res) => {
            try {
                const [, width, height] = GdkPixbuf.Pixbuf.get_file_info_finish(res);
                resolve([width, height]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class DepthCutout {
    constructor() {
        this.actor = new St.Widget({
            style_class: 'atelier-lock-depth', reactive: false, visible: false, clip_to_allocation: true,
        });
        // (The first of its effects: drawn last, it is asked where the
        // lines are each time it is drawn, while what it draws over is kept.)
        this._holes = new HolesEffect({enabled: false});
        this._holes.holesOf = () => this._holeRects();
        this.actor.add_effect_with_name('in-front', this._holes);
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._cancellable = null;
        this._monitor = null;
        this._picture = null; // [width, height] as GNOME places it
        this._sample = null;
        this._shown = null;
        this._clocks = [];
        this._inFront = [];
        /** Whether the subject would hide too much of a clock (and so stays off). */
        this.tooMuch = false;
        /** How legible each clock stays with it (lib/depth.js legibility()), as cover() was told of them. */
        this.legibility = [];
        /** Called when the cutout comes, goes or moves (how much of the clocks it covers is looked at anew). */
        this.onChanged = null;
        this.actor.connect('destroy', () => {
            this._cancellable?.cancel();
            this._holes.holesOf = null;
            this.actor = null;
        });
        this._background.connectObject('changed', () => this._load(), this);
        this._interface.connectObject('changed::color-scheme', () => this._load(), this);
    }

    /** @returns {boolean} whether a cutout is there to show */
    get loaded() {
        return Boolean(this._sample);
    }

    /** @returns {object|null} {x, y, width, height} where it is drawn, on the monitor */
    get shown() {
        return this._shown;
    }

    /** @param {number[]} monitor - [width, height] of the main monitor, pixels */
    setMonitor(monitor) {
        if (this._monitor?.[0] === monitor[0] && this._monitor?.[1] === monitor[1])
            return;
        this._monitor = monitor;
        this._load();
    }

    // The cutout of the wallpaper on screen now, if one was made.
    async _load() {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._clear();
        const path = lockWallpaper(this._background, this._interface);
        const picture = path && this._monitor ? pictureState(path) : null;
        const cutout = picture ? cutoutPath(picture, this._monitor) : null;
        if (!cutout || !GLib.file_test(cutout, GLib.FileTest.EXISTS))
            return;
        try {
            const stream = await Gio.File.new_for_path(cutout).read_async(GLib.PRIORITY_LOW, cancellable);
            let pixbuf;
            try {
                pixbuf = await pixbufOf(stream, cancellable);
            } finally {
                stream.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
            }
            const size = await this._pictureSize(pixbuf, path, cancellable);
            if (cancellable.is_cancelled() || !this.actor || !pixbuf.get_has_alpha())
                return;
            this._show(pixbuf, size);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`Atelier: the depth effect's cutout can't be read: ${e.message}`);
        }
    }

    // The wallpaper's own size, as the worker wrote it in the cutout; or
    // read from the wallpaper (turned, if the cutout is).
    async _pictureSize(pixbuf, path, cancellable) {
        const [width, height] = ['width', 'height'].map(side => Number(pixbuf.get_option(`tEXt::atelier-${side}`)));
        if (width > 0 && height > 0)
            return [width, height];
        const [w, h] = await fileInfoOf(path, cancellable);
        const turned = (w > h) !== (pixbuf.get_width() > pixbuf.get_height());
        return turned ? [h, w] : [w, h];
    }

    _show(pixbuf, picture) {
        const [width, height] = [pixbuf.get_width(), pixbuf.get_height()];
        const content = St.ImageContent.new_with_preferred_size(width, height);
        const context = global.stage.context.get_backend().get_cogl_context();
        content.set_bytes(context, pixbuf.read_pixel_bytes(), Cogl.PixelFormat.RGBA_8888,
            width, height, pixbuf.get_rowstride());
        this.actor.set_content(content);
        // (The subject, small, to tell how much of a clock it covers.)
        const scale = Math.min(1, SAMPLE_WIDTH / width);
        const sample = pixbuf.scale_simple(Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale)), GdkPixbuf.InterpType.BILINEAR);
        this._sample = {
            pixels: sample.get_pixels(),
            width: sample.get_width(),
            height: sample.get_height(),
            rowstride: sample.get_rowstride(),
        };
        this._picture = picture;
        this._place();
    }

    _clear() {
        const had = Boolean(this._shown);
        this._sample = null;
        this._picture = null;
        this._shown = null;
        this.actor?.set_content(null);
        this._sync();
        if (had)
            this.onChanged?.();
    }

    _place() {
        const style = this._background.get_string('picture-options');
        this._shown = this._picture && this._monitor ? placement(style, this._monitor, this._picture) : null;
        if (this._shown) {
            const {x, y, width, height} = this._shown;
            this.actor.set_position(x, y);
            this.actor.set_size(width, height);
        }
        this.cover(this._clocks);
        this.onChanged?.();
    }

    /**
     * Where the clocks under it are: the effect is off while the subject
     * would hide too much of a digit of one, or of one as a whole (as an
     * iPhone gives it up: lib/depth.js legibility()), and without any.
     *
     * @param {object[]} clocks - as legibility() takes each: {glyphs, box,
     *   overlap, glass}, on the monitor
     */
    cover(clocks) {
        this._clocks = clocks;
        this.legibility = this._shown && this._sample
            ? clocks.map(clock => legibility(this._sample, this._shown, clock)) : [];
        this.tooMuch = this.legibility.some(clock => !clock.stays);
        this._sync();
    }

    /**
     * Lines of type that stay in front of the subject although their clock
     * is under it: the date over a clock, as on an iPhone.
     *
     * @param {object[]} lines - {actor, pad}: an actor, and how far round it
     *   (its shadow's reach) stays in front too, pixels
     */
    keepInFront(lines) {
        if (lines.length === this._inFront.length &&
            lines.every((line, i) => line.actor === this._inFront[i].actor && line.pad === this._inFront[i].pad))
            return;
        this._letGoOfLines();
        // (A line gone – its clock filled anew – is let go of at once.)
        this._inFront = lines.map(({actor, pad}) => {
            const line = {actor, pad, id: 0};
            line.id = actor.connect('destroy', () => {
                this._inFront = this._inFront.filter(other => other !== line);
            });
            return line;
        });
        this._holes.enabled = this._inFront.length > 0;
        this.actor?.queue_redraw();
    }

    _letGoOfLines() {
        this._inFront.forEach(({actor, id}) => actor.disconnect(id));
        this._inFront = [];
    }

    // Where each line kept in front is now, in the cutout: its box as it is
    // drawn (moved, made smaller), and a little round it.
    _holeRects() {
        const actor = this.actor;
        if (!actor)
            return [];
        const rects = [];
        for (const {actor: line, pad} of this._inFront) {
            if (!line.mapped)
                continue;
            const extents = line.get_transformed_extents();
            const corners = [
                [extents.get_x() - pad, extents.get_y() - pad],
                [extents.get_x() + extents.get_width() + pad, extents.get_y() + extents.get_height() + pad],
            ].map(([x, y]) => actor.transform_stage_point(x, y));
            if (corners.some(([ok]) => !ok))
                continue;
            const [[, x1, y1], [, x2, y2]] = corners;
            rects.push([Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)]);
        }
        return rects;
    }

    /**
     * Darkened, as what is under it is (in the editor).
     *
     * @param {number} amount - 0 … 1, how much of its light goes
     */
    dim(amount) {
        if (!this.actor)
            return;
        let effect = this.actor.get_effect('dim');
        if (!effect && amount > 0) {
            effect = new Clutter.BrightnessContrastEffect();
            this.actor.add_effect_with_name('dim', effect);
        }
        effect?.set_brightness(-amount);
        if (effect)
            effect.enabled = amount > 0;
    }

    _sync() {
        if (this.actor)
            this.actor.visible = Boolean(this._shown) && this._clocks.length > 0 && !this.tooMuch;
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.keepActor] - it goes with what holds it (the
     *   lock screen sliding away once unlocked)
     */
    destroy({keepActor = false} = {}) {
        this._cancellable?.cancel();
        this._cancellable = null;
        this.onChanged = null;
        // (Sliding away, the dates stay in front as they go.)
        if (!keepActor)
            this._letGoOfLines();
        this._background.disconnectObject(this);
        this._interface.disconnectObject(this);
        if (!keepActor)
            this.actor?.destroy();
    }
}
