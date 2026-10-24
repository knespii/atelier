// The glass clock's material, Liquid Glass as an iPhone's lock screen has
// it: the digits a translucent membrane over the wallpaper. Behind them the
// wallpaper is frosted – blurred, its colours richer, the light coming
// through brighter (or, through dark glass, dimmer) – and tinted in the
// tone (lib/lockLook.js) with a hint of the colour behind; light catches
// their upper edges and leaves by their lower ones, a darker line runs
// inside those, and along their edges the glass bends what is behind (what
// lies further out drawn in, lighter). As opaque as asked, and with a soft
// shadow round them when asked: a contrast plan's means.
//
// The frosted wallpaper – the backdrop – is the whole monitor's, made once
// for a wallpaper (lib/glassBackdrop.js) as GNOME draws it there, and kept
// in Atelier's cache as a small PNG (Cairo in gjs reads pictures from PNG
// files only); digits drawn anywhere on the monitor take their part of it.
// Made in the session ahead of time, or on the lock screen when it isn't
// there yet: the decoding in GdkPixbuf's threads, the blur a pass at a time
// when the shell is idle, never holding anything up. Drawn, the digits are
// filled once, as a mask, and the rest is that mask laid over the backdrop
// and the light (a few milliseconds for a large clock): they can change at
// 60 frames a second.
//
// Only Cairo, GdkPixbuf, Gio and GLib here (tools/render-glass.js draws
// with it outside the shell).

import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {lockWallpaper, pictureState, placement} from '../../lib/depth.js';
import {
    DIM, GLASS, TINT_GRADIENT, backdropKey, backdropSize, backdropTransform, backgroundPixels, frostSteps, glassTint,
    glyphCells, meanColor, parseColor, pictureArea,
} from '../../lib/glassBackdrop.js';
import {hexToRgb} from '../../lib/palette.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'replace_async');
Gio._promisify(Gio.File.prototype, 'move_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');

const KEPT = 4; // backdrops kept: the newest (the light style's and the dark one's, another monitor's)

// How the glass bends light in a band along its edge: what lies further
// out drawn in, as if what is behind each glyph were this much smaller,
// about its middle.
const LENS = 0.8;
// The band: as deep as the shape blurred this much (logical pixels) runs
// in from the edge, strongest at the edge; and how much lighter it is, on
// light glass and on dark.
const BAND = {blur: 6, light: [0.22, 0.08]};
// The rim: light caught along the upper and left edges – the shape less
// itself moved away from the light, by the rim's width (logical pixels) –
// brighter at the top than at the bottom; and where the light leaves it,
// lower and right, a thinner one. On dark glass half as bright.
const RIM = {width: 1.6, light: [-0.45, -1], alpha: [0.9, 0.4], exit: {width: 0.9, alpha: 0.45}};
// Inside the lower edges, a little further in, a darker line (the glass
// is thick there), faint.
const INNER = {width: 2.6, alpha: 0.08};
// A soft shadow round the shape (outside it only), at its fullest – as a
// plan's is given (lib/lockLook.js legibilityPlan()): its alpha, its blur
// (as CSS's, logical pixels) and how far down it falls; black round light
// glass, a light glow round dark glass, as dark again as plain.
const SHADOW = {alpha: 0.6, blur: 12, y: 1, glow: 1.2};
// The tint's alpha, without a backdrop to frost (none made yet): more of
// it, in place of the frost.
const BARE_TINT = 1.35;

/** @returns {string} the folder of the frosted backdrops */
export function backdropDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'atelier', 'glass']);
}

/**
 * What the backdrop of a picture on a monitor is made of, and where it is
 * kept.
 *
 * @param {object} options
 * @param {string} options.path - the picture
 * @param {string} options.style - GNOME's picture-options
 * @param {object} [options.colors] - what GNOME draws round the picture
 *   (lib/glassBackdrop.js backgroundPixels())
 * @param {number[]} options.monitor - [width, height], pixels
 * @param {number} [options.scale] - the shell's scale factor
 * @param {string} [options.dir] - where it is kept (backdropDir())
 * @returns {object|null} null for a picture that can't be read, or a style
 *   the glass doesn't follow (tiled, spanned)
 */
export function backdropSpec({path, style, colors = {primary: '#000000'}, monitor, scale = 1, dir = backdropDir()}) {
    const picture = path ? pictureState(path) : null;
    if (!picture || !placement(style, monitor, [1, 1]) || !(monitor[0] > 0 && monitor[1] > 0))
        return null;
    const key = backdropKey(picture, {monitor, scale, style, colors});
    return {
        path, style, colors, monitor, scale, key,
        size: backdropSize(monitor, scale),
        file: GLib.build_filenamev([dir, `${key}.png`]),
    };
}

/**
 * @param {Gio.Settings} background - org.gnome.desktop.background
 * @param {Gio.Settings} iface - org.gnome.desktop.interface
 * @param {number[]} monitor - [width, height] of the main monitor, pixels
 * @param {number} scale - the shell's scale factor
 * @returns {object|null} backdropSpec() of what GNOME's lock screen shows
 *   (lib/depth.js lockWallpaper())
 */
export function lockBackdropSpec(background, iface, monitor, scale) {
    return backdropSpec({
        path: lockWallpaper(background, iface),
        style: background.get_string('picture-options'),
        colors: {
            primary: background.get_string('primary-color'),
            secondary: background.get_string('secondary-color'),
            shading: background.get_string('color-shading-type'),
        },
        monitor,
        scale,
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

async function decode(path, width, height, cancellable) {
    const stream = await Gio.File.new_for_path(path).read_async(GLib.PRIORITY_LOW, cancellable);
    try {
        return await new Promise((resolve, reject) => {
            const done = (_, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                } catch (e) {
                    reject(e);
                }
            };
            if (width > 0)
                GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, width, height, true, cancellable, done);
            else
                GdkPixbuf.Pixbuf.new_from_stream_async(stream, cancellable, done);
        });
    } finally {
        stream.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
    }
}

// A generator's passes, one each time the shell is idle.
async function stepwise(steps) {
    for (;;) {
        const {done, value} = steps.next();
        if (done)
            return value;
        await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_LOW, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
    }
}

// Written aside and moved into place: a reader never finds half of it.
// (Notes go in as PNG's text: {key: value}.)
async function savePng(pixbuf, path, notes = {}) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    const partial = Gio.File.new_for_path(`${path}.${GLib.uuid_string_random().slice(0, 8)}.partial`);
    try {
        const stream = await partial.replace_async(null, false, Gio.FileCreateFlags.NONE, GLib.PRIORITY_LOW, null);
        await new Promise((resolve, reject) => {
            const keys = Object.keys(notes).map(key => `tEXt::${key}`);
            pixbuf.save_to_streamv_async(stream, 'png', keys, Object.values(notes), null, (_, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.save_to_stream_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        await stream.close_async(GLib.PRIORITY_LOW, null);
        await partial.move_async(Gio.File.new_for_path(path), Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_LOW,
            null, null);
    } catch (e) {
        partial.delete_async(GLib.PRIORITY_LOW, null).catch(() => {});
        throw e;
    }
}

// Only the newest few backdrops kept (another wallpaper's go).
async function prune(dir, keep) {
    const folder = Gio.File.new_for_path(dir);
    const enumerator = await folder.enumerate_children_async('standard::name,time::modified',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
    const backdrops = [];
    for (;;) {
        const infos = await enumerator.next_files_async(64, GLib.PRIORITY_LOW, null);
        if (infos.length === 0)
            break;
        backdrops.push(...infos.filter(info => info.get_name().endsWith('.png')));
    }
    const time = info => info.get_attribute_uint64('time::modified');
    backdrops.sort((a, b) => time(b) - time(a));
    for (const info of backdrops.slice(KEPT)) {
        const file = folder.get_child(info.get_name());
        if (file.get_path() !== keep)
            await file.delete_async(GLib.PRIORITY_LOW, null).catch(() => {});
    }
}

// The monitor's backdrop, frosted: its pixels, and how far its picture
// lies from where it belongs (pictureArea()).
async function frostedPixels(spec) {
    const {monitor, style, size} = spec;
    const stored = await fileInfoOf(spec.path, null);
    // Decoded about as large as GNOME draws it on the backdrop (turned
    // or not by its camera: that is known once it is decoded).
    const drawn = [stored, [stored[1], stored[0]]].map(picture => placement(style, monitor, picture));
    const longest = Math.max(...drawn.map(p => Math.max(p.width * size.factor[0], p.height * size.factor[1])));
    const side = Math.max(1, Math.min(Math.max(...stored), Math.ceil(longest)));
    let picture = await decode(spec.path, side, side, null);
    picture = picture.apply_embedded_orientation() ?? picture;
    const [w, h] = [picture.get_width(), picture.get_height()];
    const turned = w !== h && (w > h) !== (stored[0] > stored[1]);
    const shown = placement(style, monitor, turned ? [stored[1], stored[0]] : stored);

    const {width, height} = size;
    let canvas;
    const shading = spec.colors.shading ?? 'solid';
    if (shading === 'solid' || !spec.colors.secondary) {
        canvas = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
        const [r, g, b] = parseColor(spec.colors.primary);
        canvas.fill(((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0);
    } else {
        canvas = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(backgroundPixels(width, height, spec.colors)),
            GdkPixbuf.Colorspace.RGB, false, 8, width, height, width * 3).copy();
    }
    const area = pictureArea(shown, size.factor, [width, height], [w, h]);
    if (area) {
        picture.composite(canvas, area.x, area.y, area.width, area.height, area.offsetX, area.offsetY,
            area.scaleX, area.scaleY, GdkPixbuf.InterpType.BILINEAR, 255);
    }
    const pixels = await stepwise(frostSteps(canvas.get_pixels(), {
        width, height, channels: canvas.get_n_channels(), rowstride: canvas.get_rowstride(),
    }, {sigma: size.sigma}));
    return {pixels, shift: area?.shift ?? [0, 0]};
}

const SHIFT_NOTE = 'atelier-shift';

const jobs = new Map();

/**
 * Make a backdrop unless it is there (made before, for the picture as it
 * is now): a job for each, shared by whoever asks for it meanwhile, and
 * done once begun (a tenth of a second or so; whoever no longer needs it
 * just stops waiting).
 *
 * @param {object} spec - backdropSpec()
 * @returns {Promise<object|null>} when made now, {pixels (RGB, width × 3
 *   bytes a row), shift}; null when it was there
 */
export function makeBackdrop(spec) {
    if (GLib.file_test(spec.file, GLib.FileTest.EXISTS))
        return Promise.resolve(null);
    if (!jobs.has(spec.file)) {
        const job = (async () => {
            const made = await frostedPixels(spec);
            const {width, height} = spec.size;
            const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(made.pixels), GdkPixbuf.Colorspace.RGB,
                false, 8, width, height, width * 3);
            await savePng(pixbuf, spec.file, {[SHIFT_NOTE]: made.shift.map(v => v.toFixed(4)).join(',')});
            prune(GLib.path_get_dirname(spec.file), spec.file)
                .catch(e => console.warn(`Atelier: old glass backdrops stay: ${e.message}`));
            return made;
        })().finally(() => jobs.delete(spec.file));
        jobs.set(spec.file, job);
    }
    return jobs.get(spec.file);
}

/**
 * A backdrop made, ready to draw with.
 *
 * @param {object} spec - backdropSpec()
 * @param {object|null} [made] - makeBackdrop()'s, when it made it now (its
 *   pixels at hand); read from its file otherwise
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<object>} {key, surface (Cairo), factor (its pixels per
 *   monitor pixel), shift (how far its picture lies from where it belongs,
 *   its pixels), monitor, sample (its pixels, for what is behind)}
 */
export async function loadBackdrop(spec, made = null, cancellable = null) {
    let sample;
    let shift = made?.shift;
    if (made) {
        const {width, height} = spec.size;
        sample = {pixels: made.pixels, channels: 3, rowstride: width * 3, width, height};
    } else {
        const pixbuf = await decode(spec.file, 0, 0, cancellable);
        sample = {
            pixels: pixbuf.get_pixels(),
            channels: pixbuf.get_n_channels(),
            rowstride: pixbuf.get_rowstride(),
            width: pixbuf.get_width(),
            height: pixbuf.get_height(),
        };
        shift = pixbuf.get_option(`tEXt::${SHIFT_NOTE}`)?.split(',').map(Number);
    }
    const surface = Cairo.ImageSurface.createFromPNG(spec.file);
    const [width, height] = [surface.getWidth(), surface.getHeight()];
    return {
        key: spec.key,
        surface,
        factor: [width / spec.monitor[0], height / spec.monitor[1]],
        shift: shift?.length === 2 && shift.every(Number.isFinite) ? shift : [0, 0],
        monitor: spec.monitor,
        sample,
    };
}

/**
 * Make the backdrop of what the lock screen will show, ahead of time (in
 * the session: as the wallpaper, the style or the monitor changes).
 *
 * @param {object} options - as for lockBackdropSpec()
 * @param {Gio.Settings} options.background
 * @param {Gio.Settings} options.iface
 * @param {number[]} options.monitor
 * @param {number} options.scale
 * @returns {Promise<boolean>} whether there is one now
 */
export async function prepareLockBackdrop({background, iface, monitor, scale}) {
    const spec = lockBackdropSpec(background, iface, monitor, scale);
    if (!spec)
        return false;
    await makeBackdrop(spec);
    return true;
}

/**
 * The backdrop of the wallpaper GNOME's lock screen shows on the main
 * monitor, kept as it changes: the one made, or made now when there is
 * none (unless it is only to be shown).
 */
export class GlassBackdrop {
    /**
     * @param {object} [options]
     * @param {boolean} [options.make] - make it when it isn't there yet
     */
    constructor({make = true} = {}) {
        this._make = make;
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._monitor = null;
        this._scale = 1;
        this._current = null;
        this._loading = null;
        this._cancellable = null;
        /** Called when the backdrop comes, goes or changes. */
        this.onChanged = null;
        const keys = ['picture-uri', 'picture-uri-dark', 'picture-options', 'primary-color', 'secondary-color',
            'color-shading-type'];
        this._signals = [
            ...keys.map(key => [this._background, this._background.connect(`changed::${key}`, () => this._load())]),
            [this._interface, this._interface.connect('changed::color-scheme', () => this._load())],
        ];
    }

    /** @returns {object|null} loadBackdrop()'s, once there is one */
    get current() {
        return this._current;
    }

    /**
     * @param {number[]} monitor - [width, height] of the main monitor, pixels
     * @param {number} scale - the shell's scale factor
     */
    setMonitor(monitor, scale) {
        if (this._monitor?.[0] === monitor[0] && this._monitor?.[1] === monitor[1] && this._scale === scale)
            return;
        this._monitor = [...monitor];
        this._scale = scale;
        this._load();
    }

    async _load() {
        if (!this._monitor || !this._signals)
            return;
        const spec = lockBackdropSpec(this._background, this._interface, this._monitor, this._scale);
        // (The one there, or on its way.)
        if (spec && (spec.key === this._current?.key || spec.key === this._loading))
            return;
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._loading = spec?.key ?? null;
        this._set(null);
        if (!spec || (!this._make && !GLib.file_test(spec.file, GLib.FileTest.EXISTS))) {
            this._loading = null;
            return;
        }
        try {
            const made = await makeBackdrop(spec);
            if (cancellable.is_cancelled())
                return;
            const backdrop = await loadBackdrop(spec, made, cancellable);
            if (!cancellable.is_cancelled())
                this._set(backdrop);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`Atelier: no glass backdrop of ${spec.path}: ${e.message}`);
        } finally {
            if (this._cancellable === cancellable)
                this._loading = null;
        }
    }

    _set(backdrop) {
        if (backdrop === this._current)
            return;
        this._current = backdrop;
        this.onChanged?.();
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._signals?.forEach(([settings, id]) => settings.disconnect(id));
        this._signals = null;
        this._current = null;
        this.onChanged = null;
    }
}

// The masks a paint draws, kept from one paint to the next while they are
// as large (the area they cover goes in steps of this many pixels): the
// digits drawn again and again as they change make no new ones, and leave
// nothing behind for the garbage collector, which can't tell how large
// they are. (One of another size – the digits stretched – lets go of the
// one before at once.)
const MASK_STEP = 32;
// A sketch's frost and tint are made with this much room (logical pixels)
// at least to grow right and down, or half as much again as they cover.
const MATERIAL_ROOM = 128;

class Masks {
    constructor() {
        this._kept = new Map();
    }

    /**
     * The surface of a name: so many pixels, at a device scale.
     *
     * @param {string} name
     * @param {number} width - pixels
     * @param {number} height
     * @param {number} density - device scale
     * @param {Cairo.Format} [format]
     * @param {boolean} [clear] - cleared (unless all of it is drawn anew)
     * @returns {Cairo.ImageSurface}
     */
    surface(name, width, height, density, format = Cairo.Format.A8, clear = true) {
        let surface = this._kept.get(name);
        if (surface && surface.getWidth() === width && surface.getHeight() === height &&
            surface.getDeviceScale()[0] === density && surface.getFormat() === format) {
            if (clear) {
                const cr = new Cairo.Context(surface);
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.paint();
                cr.$dispose();
            }
            return surface;
        }
        surface?.finish();
        surface = new Cairo.ImageSurface(format, width, height);
        surface.setDeviceScale(density, density);
        this._kept.set(name, surface);
        return surface;
    }

    /**
     * @param {string} name
     * @param {object} area - {x, y, width, height} of the drawing it covers
     * @param {number} density - the drawing's device pixels per pixel
     * @param {Function} draw - (cr) => draws it, in the drawing's coordinates
     * @param {boolean} [clear] - cleared first (unless draw() covers it all)
     * @returns {Cairo.ImageSurface} an alpha mask
     */
    over(name, area, density, draw, clear = true) {
        const surface = this.surface(name, Math.round(area.width * density), Math.round(area.height * density), density,
            Cairo.Format.A8, clear);
        const cr = new Cairo.Context(surface);
        cr.translate(-area.x, -area.y);
        draw(cr);
        cr.$dispose();
        return surface;
    }

    /**
     * A mask blurred by about `reach` pixels: drawn that many times smaller
     * (each pixel the mean of the mask's under it) and as large again,
     * smoothly – twice, on grids half a pixel of the small one apart, and
     * the two averaged, so that it blurs alike wherever an edge falls (one
     * grid alone blurs an edge on a line of it less than one between). The
     * small ones are drawn large in colour: Cairo does that fastest.
     *
     * @param {string} name
     * @param {Cairo.ImageSurface} mask - over() the area
     * @param {object} area
     * @param {number} density
     * @param {number} reach - pixels
     * @returns {Cairo.ImageSurface} laid over the area as the mask is (its
     *   alpha the mask)
     */
    blurred(name, mask, area, density, reach) {
        const [width, height] = [Math.round(area.width * density), Math.round(area.height * density)];
        const [columns, rows] = [Math.ceil(area.width / reach) + 2, Math.ceil(area.height / reach) + 2];
        // (Each drawn all over, with SOURCE: none of them cleared first.)
        const out = this.surface(name, width, height, density, Cairo.Format.ARGB32, false);
        const other = this.surface(`${name}:half`, width, height, density, Cairo.Format.ARGB32, false);
        [[out, 0], [other, reach / 2]].forEach(([large, offset], i) => {
            const small = this.surface(`${name}:${i}`, columns, rows, 1 / reach, Cairo.Format.A8, false);
            let cr = new Cairo.Context(small);
            cr.setOperator(Cairo.Operator.SOURCE);
            cr.setSourceSurface(mask, offset, offset);
            cr.getSource().setFilter(Cairo.Filter.GOOD);
            cr.paint();
            cr.$dispose();
            const colour = this.surface(`${name}:${i}:colour`, columns, rows, 1 / reach, Cairo.Format.ARGB32, false);
            cr = new Cairo.Context(colour);
            cr.setOperator(Cairo.Operator.SOURCE);
            cr.setSourceSurface(small, 0, 0);
            cr.paintWithAlpha(0.5);
            cr.$dispose();
            cr = new Cairo.Context(large);
            cr.setOperator(Cairo.Operator.SOURCE);
            cr.setSourceSurface(colour, -offset, -offset);
            cr.getSource().setFilter(Cairo.Filter.GOOD);
            cr.paint();
            cr.$dispose();
        });
        const cr = new Cairo.Context(out);
        cr.setOperator(Cairo.Operator.ADD);
        cr.setSourceSurface(other, 0, 0);
        cr.paint();
        cr.$dispose();
        return out;
    }

    /**
     * A mask less another, moved by whole pixels of the drawing's (smoothly
     * in between would cost each pixel a blend of four).
     *
     * @param {string} name
     * @param {object} area
     * @param {number} density
     * @param {Cairo.ImageSurface} mask - laid over the area
     * @param {Array} other - [mask, dx, dy]: another, moved
     * @returns {Cairo.ImageSurface}
     */
    less(name, area, density, mask, [other, dx = 0, dy = 0]) {
        return this.over(name, area, density, cr => {
            cr.setOperator(Cairo.Operator.SOURCE);
            cr.setSourceSurface(mask, area.x, area.y);
            cr.paint();
            cr.setOperator(Cairo.Operator.DEST_OUT);
            cr.setSourceSurface(other, area.x + dx, area.y + dy);
            cr.paint();
        }, false);
    }
}

/**
 * The material: draws a shape (the digits) in it, over what is drawn
 * already where it lies on the monitor. The shape is filled once, as a
 * mask; all else is that mask laid over the backdrop, the tint and the
 * light, as a GPU would blend them (and about as cheaply).
 */
export class LiquidGlass {
    constructor() {
        this._backdrop = null;
        this._behind = new Map();
        this._masks = new Masks();
        // (What sketch() fills the shape with, while it serves.)
        this._sketch = null;
    }

    /** @returns {object|null} the backdrop it frosts (GlassBackdrop's current) */
    get backdrop() {
        return this._backdrop;
    }

    /** @param {object|null} backdrop - loadBackdrop()'s; null: tinted, not frosted */
    set backdrop(backdrop) {
        if (backdrop === this._backdrop)
            return;
        this._backdrop = backdrop;
        this._behind.clear();
        this._forgetSketch();
    }

    // What a sketch was drawn with, let go of at once (the garbage
    // collector can't tell how large it is).
    _forgetSketch() {
        this._sketch?.surface.finish();
        this._sketch = null;
    }

    /**
     * @param {object} rect - {x, y, width, height} on the monitor
     * @returns {string|null} the backdrop's mean colour there
     */
    behind(rect) {
        const backdrop = this._backdrop;
        if (!backdrop || !(rect.width > 0 && rect.height > 0))
            return null;
        const key = [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(',');
        if (!this._behind.has(key)) {
            const {monitor: [mw, mh], factor: [fx, fy], shift: [sx, sy]} = backdrop;
            // (A few rectangles: the digits as they grow.)
            if (this._behind.size > 32)
                this._behind.clear();
            this._behind.set(key, meanColor(backdrop.sample,
                [(rect.x + sx / fx) / mw, (rect.y + sy / fy) / mh, rect.width / mw, rect.height / mh]));
        }
        return this._behind.get(key);
    }

    /**
     * Draw the shape in glass. The context's matrix is the identity (as an
     * St.DrawingArea gives it): all is in its coordinates, the stage's
     * pixels (its surface may have more: at 150 %, half again as many).
     *
     * @param {Cairo.Context} cr
     * @param {Function|Cairo.Path} path - (cr) => adds the shape to cr's
     *   path (called on other contexts too), or the shape as copyPath()
     *   gave it (copied with the identity matrix)
     * @param {object} options
     * @param {object} options.bounds - {x, y, width, height} of the shape
     * @param {object} options.tone - {color: '#rrggbb', dark}: the tone of
     *   the lock screen's type (lib/lockLook.js)
     * @param {number[]} [options.at] - [x, y] of the drawing's origin on the
     *   monitor: where the backdrop lies behind it
     * @param {number} [options.tintAlpha] - how much of the tint covers the frost
     * @param {number} [options.opacity] - how much the membrane covers the
     *   sharp wallpaper (the material's alpha: a contrast plan raises it)
     * @param {number|object} [options.shadow] - a soft shadow round the
     *   shape: 0 none … 1 at its fullest; or as a plan gives it, {alpha,
     *   blur, y} (blur and y logical pixels; legibilityPlan()'s); null none
     * @param {number} [options.scale] - the shell's scale factor
     * @param {object[]} [options.glyphBoxes] - each glyph's {x, y, width,
     *   height}, for the lens to bend light about each one's middle
     */
    paint(cr, path, {
        bounds, tone, at = [0, 0], tintAlpha = GLASS.tintAlpha, opacity = GLASS.opacity, shadow = 0, scale = 1,
        glyphBoxes = null,
    }) {
        if (!(bounds.width > 0 && bounds.height > 0))
            return;
        const masks = this._masks;
        const light = !tone.dark;
        const halo = typeof shadow === 'number'
            ? shadow > 0 && {...SHADOW, alpha: SHADOW.alpha * Math.min(1, shadow)}
            : shadow?.alpha > 0 && {y: 0, ...shadow, blur: Math.max(1, shadow.blur ?? SHADOW.blur)};
        // What is drawn round the shape (the shadow's reach, or the rim's).
        const placed = this._areaOf(cr, bounds,
            Math.ceil((halo ? 2.5 * halo.blur + Math.abs(halo.y) : 2 * RIM.width + 2) * scale));
        if (!placed)
            return;
        // (Drawn in full: what a sketch was drawn with is let go of.)
        this._forgetSketch();
        const {area, density} = placed;
        const shape = this._shapeOf(path, area, density);
        const {step, away, toward} = this._moves(shape, density, scale);

        cr.save();
        cr.identityMatrix();
        cr.rectangle(area.x, area.y, area.width, area.height);
        cr.clip();

        if (halo) {
            // The shape blurred (by about the blur, as CSS blurs a shadow),
            // a little lower, outside the shape only: under the glass it
            // would show through.
            const blurred = masks.blurred('halo', shape, area, density, halo.blur * scale);
            const outside = masks.over('halo:outside', area, density, c => {
                c.setOperator(Cairo.Operator.SOURCE);
                c.setSourceSurface(blurred, area.x, area.y + step(halo.y * scale));
                c.paint();
                c.setOperator(Cairo.Operator.DEST_OUT);
                c.setSourceSurface(shape, area.x, area.y);
                c.paint();
            }, false);
            if (light)
                cr.setSourceRGBA(0, 0, 0, Math.min(1, halo.alpha));
            else
                cr.setSourceRGBA(1, 1, 1, Math.min(1, halo.alpha * SHADOW.glow));
            cr.maskSurface(outside, area.x, area.y);
        }

        cr.pushGroup();
        this._membrane(cr, {area, density, shape, bounds, tone, at, tintAlpha, scale, glyphBoxes});
        // (As opaque as asked.)
        cr.setOperator(Cairo.Operator.DEST_IN);
        cr.setSourceRGBA(0, 0, 0, Math.min(1, Math.max(0, opacity)));
        cr.paint();
        cr.popGroupToSource();
        cr.maskSurface(shape, area.x, area.y);

        // The light on its edges, and the darker line inside the lower ones.
        // (Masks, not strokes: no lines where a font's outlines overlap.)
        const strength = light ? 1 : 0.5;
        cr.setSourceRGBA(0, 0, 0, INNER.alpha * strength);
        cr.maskSurface(masks.less('inner', area, density, shape, toward(INNER.width)), area.x, area.y);
        this._rim(cr, {area, density, shape, bounds, strength, away});
        cr.setSourceRGBA(1, 1, 1, RIM.exit.alpha * strength);
        cr.maskSurface(masks.less('exit', area, density, shape, toward(RIM.exit.width)), area.x, area.y);
        cr.restore();
    }

    /**
     * Draw the shape in glass quickly: a frame at a time while it changes
     * size (its clock stretched in the editor). The frost and the tint –
     * made once for the drawing and kept while they serve, as fine as the
     * stage's pixels (the frost is blurred: none finer) – and the light
     * along its upper edges, as paint() draws them; without the band along
     * its edges, the lines inside its lower ones and a shadow. As paint()
     * takes it (but for the shadow and the glyphs' boxes).
     *
     * @param {Cairo.Context} cr
     * @param {Function|Cairo.Path} path
     * @param {object} options - bounds, tone, at, tintAlpha, opacity, scale
     */
    sketch(cr, path, {bounds, tone, at = [0, 0], tintAlpha = GLASS.tintAlpha, opacity = GLASS.opacity, scale = 1}) {
        if (!(bounds.width > 0 && bounds.height > 0))
            return;
        const placed = this._areaOf(cr, bounds, Math.ceil((2 * RIM.width + 2) * scale));
        if (!placed)
            return;
        const {area, density} = placed;
        const shape = this._shapeOf(path, area, density);
        const {away} = this._moves(shape, density, scale);
        const material = this._material({area, bounds, tone, at, tintAlpha, opacity});
        // (No clip of its own: the masks are as large as the area.)
        cr.save();
        cr.identityMatrix();
        cr.setSourceSurface(material.surface, material.x, material.y);
        cr.getSource().setFilter(Cairo.Filter.BILINEAR);
        cr.maskSurface(shape, area.x, area.y);
        this._rim(cr, {area, density, shape, bounds, strength: tone.dark ? 0.5 : 1, away});
        cr.restore();
    }

    // Where a paint draws, in the drawing (logical pixels): round the
    // shape's bounds as far as it reaches, as far as the drawing is clipped
    // (only some glyphs drawn anew); null for nowhere.
    _areaOf(cr, {x, y, width, height}, reach) {
        cr.save();
        cr.identityMatrix();
        const [cx1, cy1, cx2, cy2] = cr.clipExtents();
        cr.restore();
        // (On whole pixels of the drawing's – its device pixels, at 150 %
        // half again as many: the masks lie on them pixel on pixel, which
        // Cairo does fastest.)
        const [density] = cr.getTarget().getDeviceScale();
        const [left, top] = [Math.max(cx1, x - reach), Math.max(cy1, y - reach)].map(v => Math.floor(v * density));
        const [right, bottom] = [Math.min(cx2, x + width + reach), Math.min(cy2, y + height + reach)]
            .map(v => Math.ceil(v * density));
        if (!(right > left && bottom > top))
            return null;
        const area = {
            x: left / density,
            y: top / density,
            width: Math.ceil((right - left) / MASK_STEP) * MASK_STEP / density,
            height: Math.ceil((bottom - top) / MASK_STEP) * MASK_STEP / density,
        };
        return {area, density};
    }

    // The shape filled, as a mask over the area.
    _shapeOf(path, area, density) {
        const append = typeof path === 'function' ? path : c => c.appendPath(path);
        return this._masks.over('shape', area, density, c => {
            append(c);
            c.fill();
        });
    }

    // The shape moved a width (logical pixels) away from the light, or
    // toward it, on whole pixels of the drawing's (one at least each way it
    // goes at all), for masks.less(); step() such a move.
    _moves(shape, density, scale) {
        const [lx, ly] = RIM.light;
        const [ux, uy] = [lx / Math.hypot(lx, ly), ly / Math.hypot(lx, ly)];
        const step = v => Math.sign(v) * Math.max(Math.abs(v) > 0.2 ? 1 : 0, Math.round(Math.abs(v * density))) /
            density;
        return {
            step,
            away: w => [shape, step(-ux * w * scale), step(-uy * w * scale)],
            toward: w => [shape, step(ux * w * scale), step(uy * w * scale)],
        };
    }

    // The light caught along the shape's upper and left edges, brighter at
    // its top than at its bottom.
    _rim(cr, {area, density, shape, bounds: {y, height}, strength, away}) {
        const rim = new Cairo.LinearGradient(0, y, 0, y + height);
        rim.addColorStopRGBA(0, 1, 1, 1, RIM.alpha[0] * strength);
        rim.addColorStopRGBA(1, 1, 1, 1, RIM.alpha[1] * strength);
        cr.setSource(rim);
        cr.maskSurface(this._masks.less('rim', area, density, shape, away(RIM.width)), area.x, area.y);
    }

    // What fills the shape in a sketch: the frost as the membrane has it
    // (without the band) and the tint over it, its gradient as the shape's
    // bounds were, as opaque as asked; as fine as the stage's pixels.
    // Kept while it covers the area (made with room to grow right and down,
    // as a stretched clock grows – as far as the monitor goes, at most) and
    // the glass is as it was. {surface, x, y}: where its picture lies in the
    // drawing (a pixel round what it covers: Cairo draws a picture made
    // larger fastest where all it reads is in it).
    _material({area, bounds, tone, at, tintAlpha, opacity}) {
        const backdrop = this._backdrop;
        const key = [backdrop?.key ?? '', ...at, tone.color, Boolean(tone.dark), tintAlpha, opacity].join(' ');
        const kept = this._sketch;
        const covers = ({covered: [x1, y1, x2, y2]}) =>
            area.x >= x1 && area.y >= y1 && area.x + area.width <= x2 && area.y + area.height <= y2;
        if (kept?.key === key && covers(kept))
            return kept;
        this._forgetSketch();
        const [mw, mh] = backdrop?.monitor ?? [Infinity, Infinity];
        const room = (end, size, edge) => Math.max(end, Math.min(end + Math.max(MATERIAL_ROOM, size / 2), edge));
        // (On whole pixels of the stage's.)
        const [x1, y1] = [Math.floor(area.x), Math.floor(area.y)];
        const x2 = Math.ceil(room(area.x + area.width, area.width, mw - at[0]));
        const y2 = Math.ceil(room(area.y + area.height, area.height, mh - at[1]));
        const [x, y] = [x1 - 1, y1 - 1];
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, x2 + 1 - x, y2 + 1 - y);
        const cr = new Cairo.Context(surface);
        if (backdrop) {
            // (Where it lies on the monitor.)
            this._setBackdrop(cr, [at[0] + x, at[1] + y], [0, 0], 1);
            cr.paint();
            if (tone.dark) {
                cr.setSourceRGBA(0, 0, 0, 1 - DIM);
                cr.paint();
            }
        }
        cr.translate(-x, -y);
        this._tint(cr, {bounds, tone, at, tintAlpha});
        cr.setOperator(Cairo.Operator.DEST_IN);
        cr.setSourceRGBA(0, 0, 0, Math.min(1, Math.max(0, opacity)));
        cr.paint();
        cr.$dispose();
        this._sketch = {key, surface, x, y, covered: [x1, y1, x2, y2]};
        return this._sketch;
    }

    // What fills the shape: the backdrop (the frost as light glass lets it
    // through; dark glass, less of it), the band at the edge bending it, and
    // the tint.
    _membrane(cr, {area, density, shape, bounds, tone, at, tintAlpha, scale, glyphBoxes}) {
        const backdrop = this._backdrop;
        const masks = this._masks;
        const light = !tone.dark;
        if (backdrop) {
            this._setBackdrop(cr, at, [0, 0], 1);
            cr.paint();
            // Each glyph's cell, whole pixels, the outer ones to the area's ends.
            const cells = glyphCells(glyphBoxes, bounds);
            const edges = cells.map(cell => Math.round(cell.x));
            edges[0] = area.x;
            edges.push(area.x + area.width);
            // (What is not the shape, blurred: inside, strongest at the edge.
            // Outside it, the shape cuts it away.)
            const outside = masks.over('outside', area, density, c => {
                c.setOperator(Cairo.Operator.SOURCE);
                c.paint();
                c.setOperator(Cairo.Operator.DEST_OUT);
                c.setSourceSurface(shape, area.x, area.y);
                c.paint();
            }, false);
            const band = masks.blurred('band', outside, area, density, BAND.blur * scale);
            cr.setSourceSurface(this._lensed(area, density, cells, edges, at), area.x, area.y);
            cr.maskSurface(band, area.x, area.y);
            // (Darker: as multiplied, black over an opaque backdrop.)
            if (!light) {
                cr.setSourceRGBA(0, 0, 0, 1 - DIM);
                cr.paint();
            }
            cr.setSourceRGBA(1, 1, 1, BAND.light[light ? 0 : 1]);
            cr.maskSurface(band, area.x, area.y);
        }
        this._tint(cr, {bounds, tone, at, tintAlpha});
    }

    // The tint over what is drawn: the tone, with a hint of the colour
    // behind the shape, more of it at the top.
    _tint(cr, {bounds: {x, y, width, height}, tone, at, tintAlpha}) {
        const tint = hexToRgb(glassTint(tone, this.behind({x: at[0] + x, y: at[1] + y, width, height})))
            .map(v => v / 255);
        // (Each end as opaque as it gets at most: a plan's most opaque glass
        // has the tint whole at the top.)
        const alpha = tintAlpha * (this._backdrop ? 1 : BARE_TINT);
        const gradient = new Cairo.LinearGradient(0, y, 0, y + height);
        gradient.addColorStopRGBA(0, ...tint, Math.min(1, alpha * TINT_GRADIENT[0]));
        gradient.addColorStopRGBA(1, ...tint, Math.min(1, alpha * TINT_GRADIENT[1]));
        cr.setSource(gradient);
        cr.paint();
    }

    // The backdrop through the lens about each glyph's middle: drawn small
    // (about as fine as the backdrop is) and large again, it is blended
    // through a mask as it is – drawn through the lens there and then, each
    // pixel would cost Cairo several times as much.
    _lensed(area, density, cells, edges, at) {
        const step = Math.max(1, Math.floor(1 / Math.max(...this._backdrop.factor)));
        const [columns, rows] = [Math.ceil(area.width / step) + 1, Math.ceil(area.height / step) + 1];
        // (Drawn in the area's own coordinates: where it lies on the monitor
        // is where the area does, the glyphs' middles in it.)
        const small = this._masks.surface('lens:small', columns, rows, 1 / step, Cairo.Format.ARGB32, false);
        const origin = [at[0] + area.x, at[1] + area.y];
        let cr = new Cairo.Context(small);
        cr.setOperator(Cairo.Operator.SOURCE);
        cells.forEach((cell, i) => {
            const left = i === 0 ? 0 : edges[i] - area.x;
            const right = i === cells.length - 1 ? columns * step : edges[i + 1] - area.x;
            cr.save();
            cr.rectangle(left, 0, right - left, rows * step);
            cr.clip();
            this._setBackdrop(cr, origin, [cell.center[0] - area.x, cell.center[1] - area.y], LENS);
            cr.paint();
            cr.restore();
        });
        cr.$dispose();
        const large = this._masks.surface('lens', Math.round(area.width * density), Math.round(area.height * density),
            density, Cairo.Format.ARGB32, false);
        cr = new Cairo.Context(large);
        cr.setOperator(Cairo.Operator.SOURCE);
        cr.setSourceSurface(small, 0, 0);
        cr.paint();
        cr.$dispose();
        return large;
    }

    // The backdrop as the source, where it lies behind the drawing, through
    // a lens about a point; the matrix the identity again after.
    _setBackdrop(cr, at, center, lens) {
        const {surface, factor, shift} = this._backdrop;
        const {x, y, scaleX, scaleY} = backdropTransform({at, factor, center, lens, shift});
        cr.identityMatrix();
        cr.translate(x, y);
        cr.scale(scaleX, scaleY);
        cr.setSourceSurface(surface, 0, 0);
        const source = cr.getSource();
        source.setFilter(Cairo.Filter.BILINEAR);
        source.setExtend(Cairo.Extend.PAD);
        cr.identityMatrix();
    }
}
