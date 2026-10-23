// The lock screen's depth effect: what stands in front of the wallpaper's
// sky (a hill, a town) and its subject (a person, a flower) over the lock
// screen's clocks, as if they stood behind it. The sky is told by its
// colours, the subject by a small model (u2netp, which rembg uses);
// lib/depthWorker.py does both in a process of its own, in the session, and
// keeps a cutout of the wallpaper – what stands in front, the rest
// see-through – in Atelier's cache. The lock screen only shows a cutout that
// is there. Shared by the shell, the preferences and the tests: only
// GLib/Gio here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const APP_DIR = 'atelier';

/**
 * The model, as rembg has it: never downloaded but when asked, in the
 * settings. Its MD5 is the one rembg checks (rembg/sessions/u2netp.py).
 */
export const MODEL = {
    name: 'u2netp.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    md5: '8e83ca70e441ab06c318d82300c84806',
    label: '4.7 MB',
    // (Anything bigger is not it: the download stops.)
    maxBytes: 10 * 1024 * 1024,
};

/**
 * How much of a clock the subject may cover and the effect still be on:
 * the share of the clock's box where the subject stands (where the cutout
 * is more than half opaque). Over it, as on an iPhone, the clock would be
 * hard to read: the cutout goes, and the whole clock shows.
 */
export const MAX_COVER = 0.4;

/**
 * How the worker makes a cutout: raised whenever it makes them otherwise
 * (2: what stands in front of the sky as well as the subject), so the old
 * ones are made anew.
 */
export const CUTOUT_VERSION = 2;

/** The picture options GNOME draws a picture with and the effect follows. */
const STYLES = ['zoom', 'scaled', 'centered', 'stretched'];

/** @returns {string} where the model is kept */
export function modelPath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), APP_DIR, 'models', MODEL.name]);
}

/** @returns {string} the worker that makes a cutout (lib/depthWorker.py) */
export function workerPath() {
    return Gio.File.new_for_uri(import.meta.url).get_parent().get_child('depthWorker.py').get_path();
}

/** @returns {string} the folder of the cutouts */
export function depthDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), APP_DIR, 'depth']);
}

/**
 * The wallpaper GNOME's lock screen shows: the desktop's, the dark one
 * when the style is dark (as GNOME's ui/background.js picks it).
 *
 * @param {Gio.Settings} background - org.gnome.desktop.background
 * @param {Gio.Settings} iface - org.gnome.desktop.interface
 * @returns {string|null} its path; null for none, or a slideshow
 */
export function lockWallpaper(background, iface) {
    if (background.get_string('picture-options') === 'none')
        return null;
    const dark = iface.get_string('color-scheme') === 'prefer-dark';
    const uri = background.get_string(dark ? 'picture-uri-dark' : 'picture-uri');
    const path = uri ? Gio.File.new_for_commandline_arg(uri).get_path() : null;
    return path && !path.toLowerCase().endsWith('.xml') ? path : null;
}

/**
 * @param {string} path
 * @returns {{path: string, mtime: number, size: number}|null} the picture
 *   as it is now; null when it can't be read
 */
export function pictureState(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('time::modified,standard::size',
            Gio.FileQueryInfoFlags.NONE, null);
        return {path, mtime: info.get_attribute_uint64('time::modified'), size: info.get_size()};
    } catch {
        return null;
    }
}

/**
 * The name of a cutout: the picture (where it is, when it was changed and
 * how big it is), the monitor it was made for and how the worker makes it,
 * so a picture written anew, or a worker that knows better, gets a cutout
 * of its own.
 *
 * @param {{path: string, mtime: number, size: number}} picture
 * @param {number[]} monitor - [width, height] in pixels
 * @returns {string}
 */
export function cutoutKey({path, mtime, size}, [width, height]) {
    const text = [path, mtime, size, `${Math.round(width)}x${Math.round(height)}`, `v${CUTOUT_VERSION}`].join('\n');
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, text, -1);
}

/**
 * @param {{path: string, mtime: number, size: number}} picture
 * @param {number[]} monitor - [width, height]
 * @returns {string} where its cutout is (or will be)
 */
export function cutoutPath(picture, monitor) {
    return GLib.build_filenamev([depthDir(), `${cutoutKey(picture, monitor)}.png`]);
}

/**
 * Where GNOME draws a picture on a monitor, as mutter does
 * (meta-background.c, get_texture_area(); whole pixels as it has them).
 *
 * @param {string} style - the picture options: zoom, scaled, centered or
 *   stretched (the tiled and spanned ones are not followed)
 * @param {number[]} monitor - [width, height]
 * @param {number[]} picture - [width, height] of the picture, turned as
 *   its camera says (as GNOME turns it)
 * @returns {{x: number, y: number, width: number, height: number}|null}
 *   relative to the monitor; null for a style that isn't followed
 */
export function placement(style, [mw, mh], [pw, ph]) {
    if (!STYLES.includes(style) || !(pw > 0 && ph > 0 && mw > 0 && mh > 0))
        return null;
    const half = v => Math.trunc(v / 2);
    if (style === 'stretched')
        return {x: 0, y: 0, width: mw, height: mh};
    if (style === 'centered') {
        const [width, height] = [Math.trunc(pw), Math.trunc(ph)];
        return {x: half(mw) - half(width), y: half(mh) - half(height), width, height};
    }
    const [sx, sy] = [mw / pw, mh / ph];
    if ((style === 'scaled' && sx < sy) || (style === 'zoom' && sx > sy)) {
        const height = Math.trunc(ph * sx);
        return {x: 0, y: half(mh) - half(height), width: mw, height};
    }
    const width = Math.trunc(pw * sy);
    return {x: half(mw) - half(width), y: 0, width, height: mh};
}

/**
 * How much of a rectangle on the monitor the subject covers.
 *
 * @param {object} cutout - its pixels, RGBA
 * @param {Uint8Array} cutout.pixels
 * @param {number} cutout.width
 * @param {number} cutout.height
 * @param {number} cutout.rowstride
 * @param {object} shown - where the cutout is drawn: {x, y, width, height}
 *   on the monitor (see placement())
 * @param {object} rect - {x, y, width, height} on the monitor (a clock)
 * @param {number} [samples] - at most this many points looked at, about
 * @returns {number} 0 (none of it) … 1 (all of it); what lies off the
 *   picture counts as uncovered
 */
export function coverage(cutout, shown, rect, samples = 4096) {
    if (!(rect.width > 0 && rect.height > 0) || !(shown.width > 0 && shown.height > 0))
        return 0;
    const step = Math.max(1, Math.sqrt(rect.width * rect.height / samples));
    const [columns, rows] = [Math.max(1, Math.round(rect.width / step)), Math.max(1, Math.round(rect.height / step))];
    let covered = 0;
    for (let row = 0; row < rows; row++) {
        // (The middle of each little cell of the rectangle.)
        const y = rect.y + (row + 0.5) * rect.height / rows;
        const v = Math.floor((y - shown.y) * cutout.height / shown.height);
        if (v < 0 || v >= cutout.height)
            continue;
        for (let column = 0; column < columns; column++) {
            const x = rect.x + (column + 0.5) * rect.width / columns;
            const u = Math.floor((x - shown.x) * cutout.width / shown.width);
            if (u >= 0 && u < cutout.width && cutout.pixels[v * cutout.rowstride + u * 4 + 3] >= 128)
                covered++;
        }
    }
    return covered / (columns * rows);
}

/**
 * @param {number} progress - from the clock (0) to the prompt (1)
 * @returns {number} how much of the cutout shows: all of it at rest, none
 *   once the prompt is a third of the way up (and the wallpaper blurs,
 *   which the cutout, sharp, would stand out from)
 */
export function cutoutOpacity(progress) {
    return Math.max(0, Math.min(1, 1 - progress * 3));
}
