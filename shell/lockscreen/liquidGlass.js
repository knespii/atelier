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
const BAND = {blur: 6, light: [0.16, 0.06]};
// The rim: light caught along the upper and left edges – the shape less
// itself moved away from the light, by the rim's width (logical pixels) –
// brighter at the top than at the bottom; and where the light leaves it,
// lower and right, a thinner one. On dark glass half as bright.
const RIM = {width: 1.6, light: [-0.45, -1], alpha: [0.78, 0.3], exit: {width: 0.9, alpha: 0.32}};
// Inside the lower edges, a little further in, a darker line (the glass
// is thick there), faint.
const INNER = {width: 2.6, alpha: 0.08};
// A soft shadow round the shape (outside it only), at its fullest: the
// shape blurred this much (logical pixels), black this dark round light
// glass; dark glass a light glow.
const SHADOW = {blur: 10, alpha: 0.5, glow: 0.5};
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
async function savePng(pixbuf, path) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    const partial = Gio.File.new_for_path(`${path}.${GLib.uuid_string_random().slice(0, 8)}.partial`);
    try {
        const stream = await partial.replace_async(null, false, Gio.FileCreateFlags.NONE, GLib.PRIORITY_LOW, null);
        await new Promise((resolve, reject) => {
            pixbuf.save_to_streamv_async(stream, 'png', [], [], null, (_, res) => {
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

// The monitor's backdrop, frosted: its pixels.
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
    return stepwise(frostSteps(canvas.get_pixels(), {
        width, height, channels: canvas.get_n_channels(), rowstride: canvas.get_rowstride(),
    }, {sigma: size.sigma}));
}

const jobs = new Map();

/**
 * Make a backdrop unless it is there (made before, for the picture as it
 * is now): a job for each, shared by whoever asks for it meanwhile, and
 * done once begun (a tenth of a second or so; whoever no longer needs it
 * just stops waiting).
 *
 * @param {object} spec - backdropSpec()
 * @returns {Promise<Uint8Array|null>} its pixels (RGB, width × 3 bytes a
 *   row) when made now; null when it was there
 */
export function makeBackdrop(spec) {
    if (GLib.file_test(spec.file, GLib.FileTest.EXISTS))
        return Promise.resolve(null);
    if (!jobs.has(spec.file)) {
        const job = (async () => {
            const pixels = await frostedPixels(spec);
            const {width, height} = spec.size;
            const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(pixels), GdkPixbuf.Colorspace.RGB,
                false, 8, width, height, width * 3);
            await savePng(pixbuf, spec.file);
            prune(GLib.path_get_dirname(spec.file), spec.file)
                .catch(e => console.warn(`Atelier: old glass backdrops stay: ${e.message}`));
            return pixels;
        })().finally(() => jobs.delete(spec.file));
        jobs.set(spec.file, job);
    }
    return jobs.get(spec.file);
}

/**
 * A backdrop made, ready to draw with.
 *
 * @param {object} spec - backdropSpec()
 * @param {Uint8Array|null} [pixels] - its pixels, if they are at hand
 *   (makeBackdrop()); read from its file otherwise
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<object>} {key, surface (Cairo), factor (its pixels per
 *   monitor pixel), monitor, sample (its pixels, for what is behind)}
 */
export async function loadBackdrop(spec, pixels = null, cancellable = null) {
    let sample;
    if (pixels) {
        const {width, height} = spec.size;
        sample = {pixels, channels: 3, rowstride: width * 3, width, height};
    } else {
        const pixbuf = await decode(spec.file, 0, 0, cancellable);
        sample = {
            pixels: pixbuf.get_pixels(),
            channels: pixbuf.get_n_channels(),
            rowstride: pixbuf.get_rowstride(),
            width: pixbuf.get_width(),
            height: pixbuf.get_height(),
        };
    }
    const surface = Cairo.ImageSurface.createFromPNG(spec.file);
    const [width, height] = [surface.getWidth(), surface.getHeight()];
    return {
        key: spec.key,
        surface,
        factor: [width / spec.monitor[0], height / spec.monitor[1]],
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
            const pixels = await makeBackdrop(spec);
            if (cancellable.is_cancelled())
                return;
            const backdrop = await loadBackdrop(spec, pixels, cancellable);
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
// they are.
const MASK_STEP = 32;

class Masks {
    constructor() {
        this._kept = new Map();
    }

    // The surface of a name, cleared: so many pixels, at a device scale.
    _get(name, width, height, density, format = Cairo.Format.A8) {
        let surface = this._kept.get(name);
        if (surface && surface.getWidth() === width && surface.getHeight() === height &&
            surface.getDeviceScale()[0] === density && surface.getFormat() === format) {
            const cr = new Cairo.Context(surface);
            cr.setOperator(Cairo.Operator.CLEAR);
            cr.paint();
            cr.$dispose();
            return surface;
        }
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
     * @returns {Cairo.ImageSurface} an alpha mask
     */
    over(name, area, density, draw) {
        const surface = this._get(name, Math.ceil(area.width * density), Math.ceil(area.height * density), density);
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
        const [width, height] = [Math.ceil(area.width * density), Math.ceil(area.height * density)];
        const [columns, rows] = [Math.ceil(area.width / reach) + 2, Math.ceil(area.height / reach) + 2];
        const out = this._get(name, width, height, density, Cairo.Format.ARGB32);
        const other = this._get(`${name}:half`, width, height, density, Cairo.Format.ARGB32);
        [[out, 0], [other, reach / 2]].forEach(([large, offset], i) => {
            const small = this._get(`${name}:${i}`, columns, rows, 1 / reach);
            let cr = new Cairo.Context(small);
            cr.setSourceSurface(mask, offset, offset);
            cr.getSource().setFilter(Cairo.Filter.GOOD);
            cr.paint();
            cr.$dispose();
            const colour = this._get(`${name}:${i}:colour`, columns, rows, 1 / reach, Cairo.Format.ARGB32);
            cr = new Cairo.Context(colour);
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
     * A mask less another, moved by whole pixels (smoothly in between would
     * cost each pixel a blend of four).
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
            cr.setSourceSurface(mask, area.x, area.y);
            cr.paint();
            cr.setOperator(Cairo.Operator.DEST_OUT);
            cr.setSourceSurface(other, area.x + Math.round(dx), area.y + Math.round(dy));
            cr.paint();
        });
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
            const [mw, mh] = backdrop.monitor;
            // (A few rectangles: the digits as they grow.)
            if (this._behind.size > 32)
                this._behind.clear();
            this._behind.set(key, meanColor(backdrop.sample, [rect.x / mw, rect.y / mh, rect.width / mw, rect.height / mh]));
        }
        return this._behind.get(key);
    }

    /**
     * Draw the shape in glass. The context's matrix is the identity (as an
     * St.DrawingArea gives it): all is in its pixels, which are the
     * stage's.
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
     * @param {number} [options.shadow] - a soft shadow round the shape:
     *   0 none … 1 at its fullest
     * @param {number} [options.scale] - the shell's scale factor
     * @param {object[]} [options.glyphBoxes] - each glyph's {x, y, width,
     *   height}, for the lens to bend light about each one's middle
     */
    paint(cr, path, {
        bounds, tone, at = [0, 0], tintAlpha = GLASS.tintAlpha, opacity = GLASS.opacity, shadow = 0, scale = 1,
        glyphBoxes = null,
    }) {
        const {x, y, width, height} = bounds;
        if (!(width > 0 && height > 0))
            return;
        const masks = this._masks;
        const append = typeof path === 'function' ? path : c => c.appendPath(path);
        const light = !tone.dark;
        // (What is drawn round the shape: the shadow's reach, or the rim's.)
        const reach = Math.ceil((shadow > 0 ? 2.5 * SHADOW.blur : 2 * RIM.width + 2) * scale);
        const area = {x: Math.floor(x - reach), y: Math.floor(y - reach)};
        area.width = Math.ceil((Math.ceil(x + width + reach) - area.x) / MASK_STEP) * MASK_STEP;
        area.height = Math.ceil((Math.ceil(y + height + reach) - area.y) / MASK_STEP) * MASK_STEP;
        const [density] = cr.getTarget().getDeviceScale();

        const shape = masks.over('shape', area, density, c => {
            append(c);
            c.fill();
        });
        const [lx, ly] = RIM.light;
        const [ux, uy] = [lx / Math.hypot(lx, ly), ly / Math.hypot(lx, ly)];
        // (A whole pixel at least, each way it goes at all.)
        const step = v => Math.sign(v) * Math.max(Math.abs(v) > 0.2 ? 1 : 0, Math.round(Math.abs(v)));
        const away = w => [shape, step(-ux * w * scale), step(-uy * w * scale)];
        const toward = w => [shape, step(ux * w * scale), step(uy * w * scale)];

        cr.save();
        cr.identityMatrix();
        cr.rectangle(area.x, area.y, area.width, area.height);
        cr.clip();

        if (shadow > 0) {
            // (Outside the shape only: under the glass it would show through.)
            const halo = masks.blurred('halo', shape, area, density, SHADOW.blur * scale);
            const cut = new Cairo.Context(halo);
            cut.setOperator(Cairo.Operator.DEST_OUT);
            cut.setSourceSurface(shape, 0, 0);
            cut.paint();
            cut.$dispose();
            if (light)
                cr.setSourceRGBA(0, 0, 0, SHADOW.alpha * shadow);
            else
                cr.setSourceRGBA(1, 1, 1, SHADOW.glow * shadow);
            cr.maskSurface(halo, area.x, area.y);
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
        const rim = new Cairo.LinearGradient(0, y, 0, y + height);
        rim.addColorStopRGBA(0, 1, 1, 1, RIM.alpha[0] * strength);
        rim.addColorStopRGBA(1, 1, 1, 1, RIM.alpha[1] * strength);
        cr.setSource(rim);
        cr.maskSurface(masks.less('rim', area, density, shape, away(RIM.width)), area.x, area.y);
        cr.setSourceRGBA(1, 1, 1, RIM.exit.alpha * strength);
        cr.maskSurface(masks.less('exit', area, density, shape, toward(RIM.exit.width)), area.x, area.y);
        cr.restore();
    }

    // What fills the shape: the backdrop (the frost as light glass lets it
    // through; dark glass, less of it), the band at the edge bending it, and
    // the tint.
    _membrane(cr, {area, density, shape, bounds, tone, at, tintAlpha, scale, glyphBoxes}) {
        const backdrop = this._backdrop;
        const masks = this._masks;
        const light = !tone.dark;
        const {x, y, width, height} = bounds;
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
                c.paint();
                c.setOperator(Cairo.Operator.DEST_OUT);
                c.setSourceSurface(shape, area.x, area.y);
                c.paint();
            });
            const band = masks.blurred('band', outside, area, density, BAND.blur * scale);
            cells.forEach((cell, i) => {
                cr.save();
                cr.rectangle(edges[i], area.y, edges[i + 1] - edges[i], area.height);
                cr.clip();
                this._setBackdrop(cr, at, cell.center, LENS);
                cr.maskSurface(band, area.x, area.y);
                cr.restore();
            });
            // (Darker: as multiplied, black over an opaque backdrop.)
            if (!light) {
                cr.setSourceRGBA(0, 0, 0, 1 - DIM);
                cr.paint();
            }
            cr.setSourceRGBA(1, 1, 1, BAND.light[light ? 0 : 1]);
            cr.maskSurface(band, area.x, area.y);
        }
        const tint = hexToRgb(glassTint(tone, this.behind({x: at[0] + x, y: at[1] + y, width, height})))
            .map(v => v / 255);
        const alpha = Math.min(1, tintAlpha * (backdrop ? 1 : BARE_TINT));
        const gradient = new Cairo.LinearGradient(0, y, 0, y + height);
        gradient.addColorStopRGBA(0, ...tint, Math.min(1, alpha * TINT_GRADIENT[0]));
        gradient.addColorStopRGBA(1, ...tint, Math.min(1, alpha * TINT_GRADIENT[1]));
        cr.setSource(gradient);
        cr.paint();
    }

    // The backdrop as the source, where it lies behind the drawing, through
    // a lens about a point; the matrix the identity again after.
    _setBackdrop(cr, at, center, lens) {
        const {surface, factor} = this._backdrop;
        const {x, y, scaleX, scaleY} = backdropTransform({at, factor, center, lens});
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
