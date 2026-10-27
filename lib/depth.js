// The lock screen's depth effect: what stands nearer than the wallpaper's
// far layer (a hill, a town, the frame of a window) over the lock screen's
// clocks, as if they stood behind it. How near each pixel is comes from a
// model, Depth Anything V2 (in one of three sizes); the wallpaper's subject
// (a person, an animal, a thing), where another model, BiRefNet, is sure of
// one, stands in front too, as on an iPhone. lib/depthWorker.py runs them
// in a process of its own, in the session, and keeps a cutout of the
// wallpaper – what stands in front, the rest see-through – in Atelier's
// cache. The lock screen only shows a cutout that is there, and only where
// the subject leaves the time legible (legibility()). Shared by the shell,
// the preferences and the tests: only GLib/Gio here.

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
        time: 'seconds a wallpaper',
    },
    base: {
        title: 'Base',
        name: 'depth-anything-v2-base.onnx',
        url: `${REPO}/depth-anything-v2-base/resolve/dd4557d492cd7b563738ac8d9ccff9094620983c/onnx/model.onnx`,
        sha256: 'dab40f67d5ead5e0ed52acfae41a717a708b02bc57f6cb761c5de828f26a7289',
        bytes: 388917010,
        label: '389 MB',
        license: 'CC-BY-NC-4.0',
        time: 'about ten seconds a wallpaper',
    },
    large: {
        title: 'Large',
        name: 'depth-anything-v2-large.onnx',
        url: `${REPO}/depth-anything-v2-large/resolve/1fa1591c7b080e98da9655827c3a33a3972a4a83/onnx/model.onnx`,
        sha256: 'a93aa89b5e92e30e0afbe0f7c3ec692b35cfca791ae9004a190fb0ca2010e905',
        bytes: 1336922232,
        label: '1.3 GB',
        license: 'CC-BY-NC-4.0',
        time: 'half a minute or more a wallpaper, and 2.5 GB of memory meanwhile',
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
 * The subject model: BiRefNet lite, which finds the picture's subject as a
 * mask with sharp edges (as an iPhone's Vision does for its depth effect,
 * VNGenerateForegroundInstanceMaskRequest), as the ONNX export on Hugging
 * Face has it at the revision checked here: a picture of 1024 × 1024 in
 * (input_image), the logits of the mask out (output_image). In full
 * precision (fp32): the half-precision file, half as big, gives the same
 * masks but is slower on a processor, which turns it back to full precision
 * op by op (15–16 s a wallpaper against 8–10 s, with 0.7 GB more memory).
 * Never downloaded but when asked, in the settings, and checked as the
 * depth models are.
 */
export const SUBJECT_MODELS = {
    lite: {
        title: 'BiRefNet Lite',
        name: 'birefnet-lite.onnx',
        url: `${REPO}/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model.onnx`,
        sha256: '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333',
        bytes: 224005088,
        label: '224 MB',
        license: 'MIT',
        time: 'about ten seconds a wallpaper, and 5.3 GB of memory meanwhile',
    },
};

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
 * How much of what should show of any one digit the subject may cover (see
 * legibility()): a quarter. With a quarter of its box gone (its foot, a
 * corner) a digit still reads; with a third or more, 3 and 8, 5 and 6, 7
 * and 1 are guessed at rather than read – and a clock is read digit by
 * digit, so one such is enough. A glass digit, which stands behind the
 * subject by a quarter of its height on purpose, then keeps 56 % of it.
 */
export const MAX_GLYPH_COVER = 0.25;

/**
 * How the worker makes a cutout: raised whenever it makes them otherwise
 * (4: by how near it is, not by what stands out; 5: with the subject too,
 * and saying which models made it), so the old ones are made anew.
 */
export const CUTOUT_VERSION = 5;

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

/**
 * @param {string} id - one of SUBJECT_MODELS
 * @returns {string} where that model is kept
 */
export function subjectModelPath(id) {
    return GLib.build_filenamev([GLib.get_user_data_dir(), APP_DIR, 'models', SUBJECT_MODELS[id].name]);
}

/**
 * The subject model the depth effect uses: the one chosen in the settings,
 * or none; with nothing chosen, the one downloaded, if one is (so a
 * download is all it takes).
 *
 * @param {string} chosen - the subject-model setting: an id of
 *   SUBJECT_MODELS, 'none', or ''
 * @param {Function} [there] - (id) => whether that model is downloaded
 * @returns {string} an id of SUBJECT_MODELS, or 'none'
 */
export function chosenSubjectModel(chosen,
    there = id => GLib.file_test(subjectModelPath(id), GLib.FileTest.EXISTS)) {
    if (chosen === 'none' || Object.hasOwn(SUBJECT_MODELS, chosen))
        return chosen;
    return Object.keys(SUBJECT_MODELS).find(id => there(id)) ?? 'none';
}

/**
 * The models a cutout is made with now: the depth model and the subject
 * model the settings choose, each if it is downloaded.
 *
 * @param {string} depth - the depth-model setting
 * @param {string} subject - the subject-model setting
 * @param {Function} [there] - (path) => whether that file is there
 * @returns {{model: string|null, subject: string|null}} their paths, as the
 *   worker's --model and --subject; null for none
 */
export function cutoutModels(depth, subject, there = path => GLib.file_test(path, GLib.FileTest.EXISTS)) {
    const model = modelPath(chosenModel(depth, id => there(modelPath(id))));
    const id = chosenSubjectModel(subject, other => there(subjectModelPath(other)));
    const found = id === 'none' ? null : subjectModelPath(id);
    return {model: there(model) ? model : null, subject: found && there(found) ? found : null};
}

/**
 * @param {{model: string|null, subject: string|null}} models - see cutoutModels()
 * @returns {string} which models made a cutout, as the worker writes it in
 *   the cutout (its atelier-models text): their files' names, '-' for none
 */
export function modelsTag({model, subject}) {
    return [model, subject].map(path => (path ? GLib.path_get_basename(path) : '-')).join(' ');
}

/**
 * The text a PNG keeps before its picture (its tEXt chunks), as the worker
 * writes it: which models made a cutout, how big the wallpaper is.
 *
 * @param {Uint8Array} bytes - the start of the file (a few kilobytes do)
 * @returns {object} keyword → text; none for what is not a PNG
 */
export function pngText(bytes) {
    const text = {};
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 8 || signature.some((byte, i) => bytes[i] !== byte))
        return text;
    for (let at = 8; at + 12 <= bytes.length;) {
        const length = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        if (type === 'IDAT' || type === 'IEND' || at + 12 + length > bytes.length)
            break;
        if (type === 'tEXt') {
            // (A keyword, a zero, the text: Latin-1.)
            const data = bytes.subarray(at + 8, at + 8 + length);
            const zero = data.indexOf(0);
            if (zero > 0)
                text[String.fromCharCode(...data.subarray(0, zero))] = String.fromCharCode(...data.subarray(zero + 1));
        }
        at += 12 + length;
    }
    return text;
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
 * Whether the depth effect may stay over a clock: the time has to stay
 * legible, as on an iPhone, where the subject over the type's boxes turns
 * the effect off once it covers too much. Digit by digit – no digit may
 * lose more than MAX_GLYPH_COVER of what should show of it (for a glass
 * face, its height above the share at its foot that may stand behind the
 * subject) – and as a whole: the clock's box, or its digits' boxes together,
 * no more than MAX_COVER (MAX_COVER_GLASS for a glass face) covered.
 *
 * The board asks it for each clock under the cutout as it lays them out
 * (for the glass face: overlap STRETCH.overlap of lib/lockLook.js, glass
 * true; its box the digits' box, as cover() has it now); the effect is off
 * as soon as one clock says no.
 *
 * @param {object} cutout - its pixels, as for coverage()
 * @param {object} shown - where the cutout is drawn on the monitor (see
 *   placement())
 * @param {object} clock - on the monitor, in pixels
 * @param {object[]} clock.glyphs - {x, y, width, height} of each digit's
 *   ink (a colon may be left out: covered, it costs the time nothing)
 * @param {object} [clock.box] - {x, y, width, height} of the whole clock;
 *   without it, its digits' boxes together
 * @param {number} [clock.overlap] - the share of each digit's height, at
 *   its foot, that stands behind the subject on purpose (0 … 1)
 * @param {boolean} [clock.glass] - whether it is the glass face
 * @returns {{stays: boolean, whole: number, worst: number, glyph: number}}
 *   whether the effect may stay; how much of the clock is covered; how much
 *   of what should show of a digit is covered at the most, and which digit
 *   that is (an index of glyphs, -1 for none)
 */
export function legibility(cutout, shown, {glyphs = [], box = null, overlap = 0, glass = false}) {
    let [worst, glyph, covered, area] = [0, -1, 0, 0];
    glyphs.forEach((rect, i) => {
        const shows = {...rect, height: rect.height * (1 - Math.min(1, Math.max(0, overlap)))};
        const lost = coverage(cutout, shown, shows, 1024);
        if (lost > worst)
            [worst, glyph] = [lost, i];
        // (The whole of it, foot and all, for the clock as a whole.)
        if (!box && rect.width > 0 && rect.height > 0) {
            covered += coverage(cutout, shown, rect, 1024) * rect.width * rect.height;
            area += rect.width * rect.height;
        }
    });
    const whole = box ? coverage(cutout, shown, box) : area > 0 ? covered / area : 0;
    const stays = worst <= MAX_GLYPH_COVER && whole <= (glass ? MAX_COVER_GLASS : MAX_COVER);
    return {stays, whole, worst, glyph};
}

/**
 * @param {number} progress - from the clock (0) to the prompt (1)
 * @returns {number} how much of the cutout shows: all of it at rest, none
 *   once the prompt is a third of the way up (and the wallpaper blurs,
 *   which the cutout, sharp, would stand out from) – and as much of the
 *   lock screen's clocks behind it, which go with it, as one picture
 */
export function cutoutOpacity(progress) {
    return Math.max(0, Math.min(1, 1 - progress * 3));
}
