// The glass clock's material, Liquid Glass as an iPhone's lock screen has
// it, and as all of Atelier's glass looks (lib/glassLook.js: regular or
// clear glass; none, solid digits in the tone): the digits a translucent
// membrane over the wallpaper. Behind them the wallpaper is frosted –
// blurred, its colours richer, the light coming through brighter (or,
// through dark glass, dimmer) – under a light veil (clear glass: a dimming
// under it) and tinted in the tone (lib/lockLook.js) with a hint of the
// colour behind. Along their edges the glass bends what is behind, as a
// lens about each glyph's middle (what lies further out drawn in, lighter,
// red a little further than blue: a hint of colour at the very rim); the
// light from above catches their edges – strongly along the tops of their
// strokes, faintly along their bottoms, in between along their sides – a
// soft sheen runs across each from its top left, and a fine grain keeps
// the gradients from banding. As opaque as asked, and with a soft shadow
// round them when asked: a contrast plan's means.
//
// The frosted wallpaper – the backdrop – is the whole monitor's, made once
// for a wallpaper and a look (lib/glassBackdrop.js) as GNOME draws it
// there, and kept in Atelier's cache as a small PNG (Cairo in gjs reads
// pictures from PNG files only); digits drawn anywhere on the monitor take
// their part of it. Made in the session ahead of time, or on the lock
// screen when it isn't there yet: the decoding in GdkPixbuf's threads, the
// blur a pass at a time when the shell is idle, never holding anything up.
// Drawn, the digits are filled once, as a mask; all that is smooth of the
// membrane – the frost, the band where it bends, the veils, the tint, the
// sheen – is drawn small and laid over that mask as large again, the light
// along the edges is the shape moved by a pixel or two, added up, and the
// grain a tile (a few milliseconds for a large clock): they can change at
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
    DIM, GLASS, TINT_GRADIENT, backdropKey, backdropSize, backdropTransform, backgroundPixels, frostOf, frostSteps,
    glassTint, glyphCells, grainNoise, lensOf, meanColor, parseColor, pictureArea, rimSteps, sheenLine,
} from '../../lib/glassBackdrop.js';
import {lookOf, resolveVariant} from '../../lib/glassLook.js';
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

// How much lighter the band along the edge where the glass bends what is
// behind is, on light glass and on dark.
const BAND_LIGHT = [0.22, 0.08];
// How much of the light – along its edges, its sheen – dark glass catches.
const DARK_LIGHT = 0.5;
// A soft shadow round the shape (outside it only), at its fullest – as a
// plan's is given (lib/lockLook.js legibilityPlan()): its alpha, its blur
// (as CSS's, logical pixels) and how far down it falls; black round light
// glass, a light glow round dark glass, as dark again as plain.
const SHADOW = {alpha: 0.6, blur: 12, y: 1, glow: 1.2};
// The tint's alpha, without a backdrop to frost (none made yet): more of
// it, in place of the frost.
const BARE_TINT = 1.35;
// What is smooth of the glass is drawn this many logical pixels a pixel
// (the frost is blurred by fourteen, its band by as many), as large again
// it is as fine.
const SMOOTH_PIXEL = 2;
// The grain's tile, pixels each way (of the drawing's: it repeats).
const GRAIN_TILE = 128;

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
 * @param {object} [options.look] - the glass's look (lib/glassLook.js
 *   lookOf()): how rich and bright the frost comes out
 * @param {string} [options.dir] - where it is kept (backdropDir())
 * @returns {object|null} null for a picture that can't be read, or a style
 *   the glass doesn't follow (tiled, spanned)
 */
export function backdropSpec({
    path, style, colors = {primary: '#000000'}, monitor, scale = 1, look = lookOf('regular'), dir = backdropDir(),
}) {
    const picture = path ? pictureState(path) : null;
    if (!picture || !placement(style, monitor, [1, 1]) || !(monitor[0] > 0 && monitor[1] > 0))
        return null;
    const frost = frostOf(look);
    const key = backdropKey(picture, {monitor, scale, style, colors, frost});
    return {
        path, style, colors, monitor, scale, frost, key,
        size: backdropSize(monitor, scale, frost.sigma),
        file: GLib.build_filenamev([dir, `${key}.png`]),
    };
}

/**
 * @param {Gio.Settings} background - org.gnome.desktop.background
 * @param {Gio.Settings} iface - org.gnome.desktop.interface
 * @param {number[]} monitor - [width, height] of the main monitor, pixels
 * @param {number} scale - the shell's scale factor
 * @param {object} [look] - as for backdropSpec()
 * @returns {object|null} backdropSpec() of what GNOME's lock screen shows
 *   (lib/depth.js lockWallpaper())
 */
export function lockBackdropSpec(background, iface, monitor, scale, look = lookOf('regular')) {
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
        look,
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
    }, {sigma: size.sigma, saturation: spec.frost.saturation, lift: spec.frost.lift}));
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
 * @param {object|null} [options.look] - none: no glass, no backdrop
 * @returns {Promise<boolean>} whether there is one now
 */
export async function prepareLockBackdrop({background, iface, monitor, scale, look = lookOf('regular')}) {
    const spec = look ? lockBackdropSpec(background, iface, monitor, scale, look) : null;
    if (!spec)
        return false;
    await makeBackdrop(spec);
    return true;
}

/**
 * The backdrop of the wallpaper GNOME's lock screen shows on the main
 * monitor, for the glass's look, kept as either changes: the one made, or
 * made now when there is none (unless it is only to be shown); none for no
 * glass.
 */
export class GlassBackdrop {
    /**
     * @param {object} [options]
     * @param {boolean} [options.make] - make it when it isn't there yet
     * @param {string} [options.variant] - lib/glassLook.js VARIANTS
     */
    constructor({make = true, variant = 'regular'} = {}) {
        this._make = make;
        this._look = lookOf(variant);
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

    /** @param {string} variant - the glass's (lib/glassLook.js VARIANTS): 'off', none */
    setVariant(variant) {
        const look = lookOf(variant);
        if (look === this._look)
            return;
        this._look = look;
        this._load();
    }

    async _load() {
        if (!this._monitor || !this._signals)
            return;
        const spec = this._look
            ? lockBackdropSpec(this._background, this._interface, this._monitor, this._scale, this._look) : null;
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
        // (Each drawn all over, with SOURCE: none of them cleared first –
        // but the halves, as SOURCE through an alpha only blends with what
        // was there: each drawing would blur more than the one before.)
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
            const colour = this.surface(`${name}:${i}:colour`, columns, rows, 1 / reach, Cairo.Format.ARGB32);
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

// The grain's tiles, one for each amplitude, made once.
const grains = new Map();

/**
 * Fine grain against banding, for a look's amplitude (lib/glassLook.js
 * grain): each pixel a little lighter or darker, in a tile that repeats, a
 * pixel of it one of the drawing's. Made the first time it is asked for
 * (some milliseconds: ahead of time, in the session, see clock.js
 * GlassWarmUp), kept after.
 *
 * @param {number} amplitude - how much lighter or darker, on average
 * @param {number} [density] - the drawing's device pixels per pixel
 * @returns {Cairo.SurfacePattern}
 */
export function grainPattern(amplitude, density = 1) {
    let tile = grains.get(amplitude);
    if (!tile) {
        tile = new Cairo.ImageSurface(Cairo.Format.ARGB32, GRAIN_TILE, GRAIN_TILE);
        const cr = new Cairo.Context(tile);
        cr.setOperator(Cairo.Operator.SOURCE);
        grainNoise(GRAIN_TILE * GRAIN_TILE).forEach((v, i) => {
            const white = v > 0 ? 1 : 0;
            cr.setSourceRGBA(white, white, white, Math.abs(v) * 2 * amplitude);
            cr.rectangle(i % GRAIN_TILE, Math.floor(i / GRAIN_TILE), 1, 1);
            cr.fill();
        });
        cr.$dispose();
        grains.set(amplitude, tile);
    }
    tile.setDeviceScale(density, density);
    const pattern = new Cairo.SurfacePattern(tile);
    pattern.setExtend(Cairo.Extend.REPEAT);
    pattern.setFilter(Cairo.Filter.NEAREST);
    return pattern;
}

/**
 * The variant of glass the lock screen's glass clocks are drawn in, kept
 * as it changes: Atelier's glass-variant setting – none ('off': solid
 * digits) while GNOME's high contrast is on (lib/glassLook.js
 * resolveVariant()).
 */
export class GlassVariant {
    /**
     * @param {Gio.Settings|null} settings - Atelier's; none: regular glass
     * @param {Function} [onChanged] - called when the variant changes
     */
    constructor(settings, onChanged = null) {
        this._settings = settings;
        this._onChanged = onChanged;
        const a11y = 'org.gnome.desktop.a11y.interface';
        this._a11y = Gio.SettingsSchemaSource.get_default()?.lookup(a11y, true)?.has_key('high-contrast')
            ? new Gio.Settings({schema_id: a11y}) : null;
        this._variant = this._resolve();
        this._signals = [
            ...settings ? [[settings, settings.connect('changed::glass-variant', () => this._sync())]] : [],
            ...this._a11y ? [[this._a11y, this._a11y.connect('changed::high-contrast', () => this._sync())]] : [],
        ];
    }

    /** @returns {string} one of lib/glassLook.js VARIANTS */
    get variant() {
        return this._variant;
    }

    _resolve() {
        return resolveVariant(this._settings?.get_string('glass-variant') ?? 'regular',
            {highContrast: this._a11y?.get_boolean('high-contrast') ?? false});
    }

    _sync() {
        const variant = this._resolve();
        if (variant === this._variant)
            return;
        this._variant = variant;
        this._onChanged?.(variant);
    }

    destroy() {
        this._signals?.forEach(([settings, id]) => settings.disconnect(id));
        this._signals = null;
        this._onChanged = null;
    }
}

/**
 * The material: draws a shape (the digits) in it, over what is drawn
 * already where it lies on the monitor. The shape is filled once, as a
 * mask; all else is that mask laid over the membrane (drawn small: smooth
 * all of it), the grain and the light, as a GPU would blend them (and about
 * as cheaply).
 */
export class LiquidGlass {
    constructor() {
        this._backdrop = null;
        // (Its red, green and blue apart: for the lens to bend each its own way.)
        this._channels = null;
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
        // (Let go of at once: the garbage collector can't tell how large they are.)
        this._channels?.forEach(channel => channel.finish());
        this._channels = null;
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
     *   height}, for the lens to bend light about each one's middle, and
     *   its sheen
     * @param {string} [options.variant] - the glass's (lib/glassLook.js
     *   VARIANTS): 'off', solid in the tone
     */
    paint(cr, path, {
        bounds, tone, at = [0, 0], tintAlpha = GLASS.tintAlpha, opacity = GLASS.opacity, shadow = 0, scale = 1,
        glyphBoxes = null, variant = 'regular',
    }) {
        if (!(bounds.width > 0 && bounds.height > 0))
            return;
        const look = lookOf(variant);
        const light = !tone.dark;
        const halo = typeof shadow === 'number'
            ? shadow > 0 && {...SHADOW, alpha: SHADOW.alpha * Math.min(1, shadow)}
            : shadow?.alpha > 0 && {y: 0, ...shadow, blur: Math.max(1, shadow.blur ?? SHADOW.blur)};
        // What is drawn round the shape (the shadow's reach, or the rim's).
        const placed = this._areaOf(cr, bounds,
            Math.ceil((halo ? 2.5 * halo.blur + Math.abs(halo.y) : 2 * (look?.rim.width ?? 0) + 2) * scale));
        if (!placed)
            return;
        // (Drawn in full: what a sketch was drawn with is let go of.)
        this._forgetSketch();
        const {area, density} = placed;
        const shape = this._shapeOf(path, area, density);

        cr.save();
        cr.identityMatrix();
        cr.rectangle(area.x, area.y, area.width, area.height);
        cr.clip();
        if (halo)
            this._halo(cr, {area, density, path, halo, light, scale});
        if (look) {
            const membrane = this._membrane({
                area, path, bounds, tone, at, tintAlpha, opacity, scale, glyphBoxes, look,
            });
            cr.setSourceSurface(membrane.surface, membrane.x, membrane.y);
            cr.getSource().setFilter(Cairo.Filter.BILINEAR);
            cr.maskSurface(shape, area.x, area.y);
            cr.setSource(grainPattern(look.grain, density));
            cr.maskSurface(shape, area.x, area.y);
            this._rim(cr, {area, density, path, shape, look, strength: light ? 1 : DARK_LIGHT, scale});
        } else {
            this._solid(cr, {area, shape, tone});
        }
        cr.restore();
    }

    /**
     * Draw the shape in glass quickly: a frame at a time while it changes
     * size (its clock stretched in the editor). The frost, the veils and
     * the tint – made once for the drawing and kept while they serve, as
     * fine as the stage's pixels (the frost is blurred: none finer) – and
     * the light along the tops of its strokes, as paint() draws them;
     * without the band along its edges, the light along its other edges,
     * its sheen and grain, and a shadow. As paint() takes it (but for the
     * shadow and the glyphs' boxes).
     *
     * @param {Cairo.Context} cr
     * @param {Function|Cairo.Path} path
     * @param {object} options - bounds, tone, at, tintAlpha, opacity, scale,
     *   variant
     */
    sketch(cr, path, {
        bounds, tone, at = [0, 0], tintAlpha = GLASS.tintAlpha, opacity = GLASS.opacity, scale = 1, variant = 'regular',
    }) {
        if (!(bounds.width > 0 && bounds.height > 0))
            return;
        const look = lookOf(variant);
        const placed = this._areaOf(cr, bounds, Math.ceil((2 * (look?.rim.width ?? 0) + 2) * scale));
        if (!placed)
            return;
        const {area, density} = placed;
        const shape = this._shapeOf(path, area, density);
        // (No clip of its own: the masks are as large as the area.)
        cr.save();
        cr.identityMatrix();
        if (look) {
            const material = this._material({area, bounds, tone, at, tintAlpha, opacity, look});
            cr.setSourceSurface(material.surface, material.x, material.y);
            cr.getSource().setFilter(Cairo.Filter.BILINEAR);
            cr.maskSurface(shape, area.x, area.y);
            // (The light along the tops of its strokes: the strongest of it.)
            const down = this._step(look.rim.width * scale, density);
            cr.setSourceRGBA(1, 1, 1, look.rim.top * (tone.dark ? DARK_LIGHT : 1));
            cr.maskSurface(this._masks.less('rim', area, density, shape, [shape, 0, down]), area.x, area.y);
        } else {
            this._solid(cr, {area, shape, tone});
        }
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
        return this._masks.over('shape', area, density, c => {
            appendTo(c, path);
            c.fill();
        });
    }

    // What lies outside the shape, as a mask over the area: this opaque
    // (the shape cut out of it).
    _outside(name, path, area, density, alpha = 1) {
        return this._masks.over(name, area, density, c => {
            c.setOperator(Cairo.Operator.SOURCE);
            c.setSourceRGBA(0, 0, 0, alpha);
            c.paint();
            appendTo(c, path);
            c.setOperator(Cairo.Operator.CLEAR);
            c.fill();
        }, false);
    }

    // A length (logical pixels, scaled) on whole pixels of the drawing's,
    // one at least where it is any: what the masks are moved by.
    _step(length, density) {
        return Math.sign(length) * Math.max(Math.abs(length) > 0.2 ? 1 : 0, Math.round(Math.abs(length * density))) /
            density;
    }

    // The grid what is smooth of the glass is drawn on: a pixel of it
    // SMOOTH_PIXEL logical pixels, over the area and one of its pixels round
    // it; its own coordinates are the drawing's from (x, y) on.
    _smoothGrid(area, scale) {
        const density = 1 / (SMOOTH_PIXEL * scale);
        return {
            density,
            x: area.x - 1 / density,
            y: area.y - 1 / density,
            width: Math.ceil(area.width * density) + 2,
            height: Math.ceil(area.height * density) + 2,
        };
    }

    // No glass: the shape solid, in the tone.
    _solid(cr, {area, shape, tone}) {
        const [r, g, b] = hexToRgb(tone.color).map(v => v / 255);
        cr.setSourceRGB(r, g, b);
        cr.maskSurface(shape, area.x, area.y);
    }

    // A soft shadow round the shape: the shape blurred (by about the blur,
    // as CSS blurs a shadow; drawn small, it is as soft), a little lower,
    // outside the shape only – under the glass it would show through.
    _halo(cr, {area, density, path, halo, light, scale}) {
        const masks = this._masks;
        const grid = this._smoothGrid(area, scale);
        const local = {x: 0, y: 0, width: grid.width / grid.density, height: grid.height / grid.density};
        const filled = masks.surface('halo:shape', grid.width, grid.height, grid.density);
        let c = new Cairo.Context(filled);
        c.translate(-grid.x, -grid.y);
        appendTo(c, path);
        c.fill();
        c.$dispose();
        const blurred = masks.blurred('halo', filled, local, grid.density, halo.blur * scale);
        const coloured = masks.surface('halo:coloured', grid.width, grid.height, grid.density, Cairo.Format.ARGB32);
        c = new Cairo.Context(coloured);
        if (light)
            c.setSourceRGBA(0, 0, 0, Math.min(1, halo.alpha));
        else
            c.setSourceRGBA(1, 1, 1, Math.min(1, halo.alpha * SHADOW.glow));
        c.maskSurface(blurred, 0, 0);
        c.$dispose();
        cr.setSourceSurface(coloured, grid.x, grid.y + this._step(halo.y * scale, density));
        cr.getSource().setFilter(Cairo.Filter.BILINEAR);
        cr.maskSurface(this._outside('halo:outside', path, area, density), area.x, area.y);
    }

    // The membrane: the backdrop (the frost as light glass lets it through;
    // dark glass, less of it), what the glass bends at its edges, the
    // look's veils, the tint and the sheen – smooth all of it, drawn small
    // – as opaque as asked. {surface, x, y}: where it lies in the drawing.
    _membrane({area, path, bounds, tone, at, tintAlpha, opacity, scale, glyphBoxes, look}) {
        const grid = this._smoothGrid(area, scale);
        const surface = this._masks.surface('membrane', grid.width, grid.height, grid.density, Cairo.Format.ARGB32,
            false);
        const cr = new Cairo.Context(surface);
        const light = !tone.dark;
        // (Where its own coordinates lie on the monitor.)
        const origin = [at[0] + grid.x, at[1] + grid.y];
        cr.setOperator(Cairo.Operator.SOURCE);
        if (this._backdrop) {
            this._setBackdrop(cr, origin, [0, 0], 1);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
            this._bend(cr, {grid, origin, path, bounds, glyphBoxes, look, light, scale});
            // (Darker: as multiplied, black over an opaque backdrop.)
            if (!light) {
                cr.setSourceRGBA(0, 0, 0, 1 - DIM);
                cr.paint();
            }
        } else {
            cr.setSourceRGBA(0, 0, 0, 0);
            cr.paint();
            cr.setOperator(Cairo.Operator.OVER);
        }
        this._veils(cr, look);
        cr.translate(-grid.x, -grid.y);
        this._tint(cr, {bounds, tone, at, tintAlpha});
        this._sheen(cr, {bounds, glyphBoxes, look, strength: light ? 1 : DARK_LIGHT});
        cr.identityMatrix();
        cr.setOperator(Cairo.Operator.DEST_IN);
        cr.setSourceRGBA(0, 0, 0, Math.min(1, Math.max(0, opacity)));
        cr.paint();
        cr.$dispose();
        return {surface, x: grid.x, y: grid.y};
    }

    // Where the glass bends what is behind: a band in from the edge as deep
    // as the look's lens (what is outside the shape, blurred: strongest at
    // the edge), what is behind each glyph drawn there through a lens about
    // its middle – red, green and blue each bent its own way – twice over
    // (at the very edge, mostly bent) and a little lighter. In the grid's
    // coordinates, on the frost.
    _bend(cr, {grid, origin, path, bounds, glyphBoxes, look, light, scale}) {
        const masks = this._masks;
        const local = {x: 0, y: 0, width: grid.width / grid.density, height: grid.height / grid.density};
        const outside = masks.surface('membrane:outside', grid.width, grid.height, grid.density, Cairo.Format.A8,
            false);
        let c = new Cairo.Context(outside);
        c.setOperator(Cairo.Operator.SOURCE);
        c.setSourceRGBA(0, 0, 0, 1);
        c.paint();
        c.translate(-grid.x, -grid.y);
        appendTo(c, path);
        c.setOperator(Cairo.Operator.CLEAR);
        c.fill();
        c.$dispose();
        const band = masks.blurred('membrane:band', outside, local, grid.density, look.lens.width * scale);
        const bent = masks.surface('membrane:bent', grid.width, grid.height, grid.density, Cairo.Format.ARGB32, false);
        c = new Cairo.Context(bent);
        // Each glyph's cell, the outer ones to the grid's ends.
        const cells = glyphCells(glyphBoxes, bounds);
        const edges = cells.map(cell => cell.x - grid.x);
        edges[0] = 0;
        edges.push(local.width);
        const channels = look.aberration > 0 ? this._channelsOf() : null;
        cells.forEach((cell, i) => {
            const lens = lensOf([cell.box.width / 2, cell.box.height / 2], look.lens.shift * scale, look.aberration);
            const center = [cell.center[0] - grid.x, cell.center[1] - grid.y];
            c.save();
            c.rectangle(edges[i], 0, edges[i + 1] - edges[i], local.height);
            c.clip();
            c.setOperator(Cairo.Operator.SOURCE);
            this._setBackdrop(c, origin, center, lens.green, channels?.[1]);
            c.paint();
            if (channels) {
                c.setOperator(Cairo.Operator.ADD);
                this._setBackdrop(c, origin, center, lens.red, channels[0]);
                c.paint();
                this._setBackdrop(c, origin, center, lens.blue, channels[2]);
                c.paint();
            }
            c.restore();
        });
        c.$dispose();
        for (let i = 0; i < 2; i++) {
            cr.setSourceSurface(bent, 0, 0);
            cr.maskSurface(band, 0, 0);
        }
        cr.setSourceRGBA(1, 1, 1, BAND_LIGHT[light ? 0 : 1]);
        cr.maskSurface(band, 0, 0);
    }

    // The backdrop's red, green and blue each on its own (opaque: added up,
    // the backdrop again), made once for a backdrop.
    _channelsOf() {
        if (!this._channels) {
            const {surface} = this._backdrop;
            const [width, height] = [surface.getWidth(), surface.getHeight()];
            this._channels = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(([r, g, b]) => {
                const channel = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, height);
                const cr = new Cairo.Context(channel);
                cr.setOperator(Cairo.Operator.SOURCE);
                cr.setSourceSurface(surface, 0, 0);
                cr.paint();
                cr.setOperator(Cairo.Operator.MULTIPLY);
                cr.setSourceRGB(r, g, b);
                cr.paint();
                cr.$dispose();
                return channel;
            });
        }
        return this._channels;
    }

    // The look's veils over the frost: dark under light (clear glass dims
    // what is behind it, to keep what is on it legible).
    _veils(cr, look) {
        if (look.dim > 0) {
            cr.setSourceRGBA(0, 0, 0, look.dim);
            cr.paint();
        }
        if (look.veil > 0) {
            cr.setSourceRGBA(1, 1, 1, look.veil);
            cr.paint();
        }
    }

    // A soft sheen across each glyph, as the look has it: from where the
    // light comes from, fading out a part of the way across.
    _sheen(cr, {bounds, glyphBoxes, look, strength}) {
        const {angle, alpha, reach} = look.sheen;
        if (!(alpha > 0 && reach > 0))
            return;
        for (const cell of glyphCells(glyphBoxes, bounds)) {
            const sheen = new Cairo.LinearGradient(...sheenLine(cell.box, angle));
            sheen.addColorStopRGBA(0, 1, 1, 1, alpha * strength);
            sheen.addColorStopRGBA(Math.min(1, reach), 1, 1, 1, 0);
            cr.save();
            cr.rectangle(cell.x, bounds.y, cell.width, bounds.height);
            cr.clip();
            cr.setSource(sheen);
            cr.paint();
            cr.restore();
        }
    }

    // The light from above along the shape's edges, as the look has it:
    // along the tops of its strokes strongest, along their bottoms
    // faintest, along their sides in between. What lies outside the shape,
    // moved a rim's width down (up, aside), lies on the shape just under
    // its tops (over its bottoms, inside its sides): added up so many times
    // over as each needs (quick, done that way), then only on the shape.
    _rim(cr, {area, density, path, shape, look, strength, scale}) {
        const steps = rimSteps(look.rim, strength);
        const outside = this._outside('rim:outside', path, area, density, steps.unit);
        const w = this._step(look.rim.width * scale, density);
        const rim = this._masks.over('rim', area, density, c => {
            c.setOperator(Cairo.Operator.ADD);
            for (const [dx, dy, times] of [[0, w, steps.top], [0, -w, steps.bottom], [w, 0, steps.side],
                [-w, 0, steps.side]]) {
                c.setSourceSurface(outside, area.x + dx, area.y + dy);
                for (let i = 0; i < times; i++)
                    c.paint();
            }
            c.setOperator(Cairo.Operator.DEST_IN);
            c.setSourceSurface(shape, area.x, area.y);
            c.paint();
        });
        cr.setSourceRGB(1, 1, 1);
        cr.maskSurface(rim, area.x, area.y);
    }

    // What fills the shape in a sketch: the frost as the membrane has it
    // (without the band), the veils and the tint over it, its gradient as
    // the shape's bounds were, as opaque as asked; as fine as the stage's
    // pixels. Kept while it covers the area (made with room to grow right
    // and down, as a stretched clock grows – as far as the monitor goes, at
    // most) and the glass is as it was. {surface, x, y}: where its picture
    // lies in the drawing (a pixel round what it covers: Cairo draws a
    // picture made larger fastest where all it reads is in it).
    _material({area, bounds, tone, at, tintAlpha, opacity, look}) {
        const backdrop = this._backdrop;
        const key = [backdrop?.key ?? '', ...at, tone.color, Boolean(tone.dark), tintAlpha, opacity, look.dim,
            look.veil].join(' ');
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
        this._veils(cr, look);
        cr.translate(-x, -y);
        this._tint(cr, {bounds, tone, at, tintAlpha});
        cr.setOperator(Cairo.Operator.DEST_IN);
        cr.setSourceRGBA(0, 0, 0, Math.min(1, Math.max(0, opacity)));
        cr.paint();
        cr.$dispose();
        this._sketch = {key, surface, x, y, covered: [x1, y1, x2, y2]};
        return this._sketch;
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

    // The backdrop (or one of its colours) as the source, where it lies
    // behind the drawing, through a lens about a point; the matrix the
    // identity again after.
    _setBackdrop(cr, at, center, lens, surface = this._backdrop.surface) {
        const {factor, shift} = this._backdrop;
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

// The shape added to a context's path: drawn by a function, or a path copied.
function appendTo(cr, path) {
    if (typeof path === 'function')
        path(cr);
    else
        cr.appendPath(path);
}
