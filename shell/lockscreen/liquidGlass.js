// The glass clock's backdrop: the wallpaper GNOME's lock screen shows on
// the main monitor, as GNOME draws it there, blurred as the clock's glass
// blurs it (lib/glassLook.js) and small (lib/glassBackdrop.js) – what the
// glass clock's digits take to read is weighed on it (board.js; the GPU
// draws them: glassText.js). Kept in Atelier's cache as a small PNG, made
// once for a wallpaper and a look, in the session ahead of time, or on the
// lock screen when it isn't there yet: the decoding in GdkPixbuf's threads,
// the blur a pass at a time when the shell is idle, never holding anything
// up. And the variant of glass the clocks are drawn in.
//
// Only GdkPixbuf, Gio and GLib here.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {lockWallpaper, pictureState, placement} from '../../lib/depth.js';
import {backdropKey, backdropSize, backgroundPixels, frostOf, frostSteps, parseColor, pictureArea} from '../../lib/glassBackdrop.js';
import {lookOf, resolveVariant} from '../../lib/glassLook.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'replace_async');
Gio._promisify(Gio.File.prototype, 'move_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');

const KEPT = 4; // backdrops kept: the newest (the light style's and the dark one's, another monitor's)

/** @returns {string} the folder of the backdrops */
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
 * @returns {Promise<object>} {key, factor (its pixels per monitor pixel),
 *   shift (how far its picture lies from where it belongs, its pixels),
 *   monitor, sample (its pixels, for what is behind)}
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
    return {
        key: spec.key,
        factor: [sample.width / spec.monitor[0], sample.height / spec.monitor[1]],
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
