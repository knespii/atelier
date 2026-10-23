// The lock screen's depth effect: what stands nearer than the wallpaper's
// far layer (a hill, a town, the frame of a window) over the lock screen's
// clocks, as if they stood behind it. How near each pixel is comes from a
// model, Depth Anything V2 (in one of three sizes); lib/depthWorker.py runs
// it in a process of its own, in the session, and keeps a cutout of the
// wallpaper – what stands in front, the rest see-through – in Atelier's
// cache. The lock screen only shows a cutout that is there. Shared by the
// shell, the preferences and the tests: only GLib/Gio here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const APP_DIR = 'atelier';

const REPO = 'https://huggingface.co/onnx-community';

/**
 * The models, as ONNX exports of Depth Anything V2 on Hugging Face (each
 * at the revision checked here): never downloaded but when asked, in the
 * settings, and checked against the size and SHA-256 Hugging Face gives.
 * The bigger, the finer what it sees, the longer it takes.
 */
export const MODELS = {
    small: {
        title: 'Small',
        name: 'depth-anything-v2-small.onnx',
        url: `${REPO}/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx`,
        sha256: 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c',
        bytes: 99060839,
        label: '99 MB',
        license: 'Apache-2.0',
        time: 'seconds',
    },
    base: {
        title: 'Base',
        name: 'depth-anything-v2-base.onnx',
        url: `${REPO}/depth-anything-v2-base/resolve/dd4557d492cd7b563738ac8d9ccff9094620983c/onnx/model.onnx`,
        sha256: 'dab40f67d5ead5e0ed52acfae41a717a708b02bc57f6cb761c5de828f26a7289',
        bytes: 388917010,
        label: '389 MB',
        license: 'CC-BY-NC-4.0',
        time: 'about ten seconds',
    },
    large: {
        title: 'Large',
        name: 'depth-anything-v2-large.onnx',
        url: `${REPO}/depth-anything-v2-large/resolve/1fa1591c7b080e98da9655827c3a33a3972a4a83/onnx/model.onnx`,
        sha256: 'a93aa89b5e92e30e0afbe0f7c3ec692b35cfca791ae9004a190fb0ca2010e905',
        bytes: 1336922232,
        label: '1.3 GB',
        license: 'CC-BY-NC-4.0',
        time: 'half a minute or more, and 3.5 GB of memory meanwhile',
    },
};

/**
 * The model offered first: Base, a quarter of Large's sums, so it is done
 * in seconds rather than in half a minute, and without gigabytes of memory
 * – on a laptop, once per wallpaper, while the user works. Large, the
 * finest, is there to choose.
 */
export const DEFAULT_MODEL = 'base';

/**
 * How much of a clock the subject may cover and the effect still be on:
 * the share of the clock's box where the subject stands (where the cutout
 * is more than half opaque). Over it, as on an iPhone, the clock would be
 * hard to read: the cutout goes, and the whole clock shows.
 */
export const MAX_COVER = 0.4;
// A glass clock's digits go down behind the subject on purpose, a quarter
// of them: more of them may be covered before the effect gives up.
export const MAX_COVER_GLASS = 0.6;

/**
 * How the worker makes a cutout: raised whenever it makes them otherwise
 * (4: by how near it is, not by what stands out), so
 * the old ones are made anew.
 */
export const CUTOUT_VERSION = 4;

/** The picture options GNOME draws a picture with and the effect follows. */
const STYLES = ['zoom', 'scaled', 'centered', 'stretched'];

/**
 * @param {string} id - one of MODELS
 * @returns {string} where that model is kept
 */
export function modelPath(id) {
    return GLib.build_filenamev([GLib.get_user_data_dir(), APP_DIR, 'models', MODELS[id].name]);
}

/**
 * The model the depth effect uses: the one chosen in the settings; with
 * none chosen, the biggest one downloaded, or the one offered first.
 *
 * @param {string} chosen - the depth-model setting: an id of MODELS, or ''
 * @param {Function} [there] - (id) => whether that model is downloaded
 * @returns {string} an id of MODELS
 */
export function chosenModel(chosen, there = id => GLib.file_test(modelPath(id), GLib.FileTest.EXISTS)) {
    if (Object.hasOwn(MODELS, chosen))
        return chosen;
    return ['large', 'base', 'small'].find(id => there(id)) ?? DEFAULT_MODEL;
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
 * Where what stands in front starts under a clock: going down a strip of
 * the monitor, the first row it fills a good part of.
 *
 * @param {object} cutout - as for coverage()
 * @param {object} shown - as for coverage()
 * @param {object} strip - {x, width, from, to} on the monitor: the clock's
 *   span, and from where to where to look down
 * @param {number} [share] - how much of the row it has to fill
 * @returns {number|null} the row's y on the monitor; null if nothing
 *   stands in front there
 */
export function subjectTop(cutout, shown, {x, width, from, to}, share = 0.3) {
    if (!(width > 0) || !(to > from) || !(shown.width > 0 && shown.height > 0))
        return null;
    const columns = Math.max(1, Math.min(96, Math.round(width / 4)));
    // (A row of the cutout at a time.)
    const step = Math.max(1, shown.height / cutout.height);
    for (let y = from; y < to; y += step) {
        const v = Math.floor((y - shown.y) * cutout.height / shown.height);
        if (v < 0 || v >= cutout.height)
            continue;
        let covered = 0;
        for (let column = 0; column < columns; column++) {
            const u = Math.floor((x + (column + 0.5) * width / columns - shown.x) * cutout.width / shown.width);
            if (u >= 0 && u < cutout.width && cutout.pixels[v * cutout.rowstride + u * 4 + 3] >= 128)
                covered++;
        }
        if (covered >= share * columns)
            return y;
    }
    return null;
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
