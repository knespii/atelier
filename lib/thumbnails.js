// Wallpaper thumbnails and accent color detection.
// Shared by the shell and the preferences: only GLib/Gio/GdkPixbuf may be used here.
// Decoding and encoding run in GdkPixbuf's worker threads, so the shell never
// blocks on a large wallpaper.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ACCENT_COLORS} from './looks.js';
import {isSlideshow, thumbnailDir} from './paths.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'replace_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');

export const THUMB_WIDTH = 400;
export const THUMB_HEIGHT = 250;

const pending = new Map();

/**
 * @param {string} wallpaper - path of a wallpaper
 * @returns {string} where its thumbnail is (or will be) stored
 */
export function thumbnailPath(wallpaper) {
    const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, wallpaper, -1);
    return GLib.build_filenamev([thumbnailDir(), `${hash}.jpg`]);
}

/**
 * @param {string} wallpaper
 * @returns {boolean}
 */
export function hasThumbnail(wallpaper) {
    return GLib.file_test(thumbnailPath(wallpaper), GLib.FileTest.EXISTS);
}

function getFileInfo(path) {
    return new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.get_file_info_async(path, null, (_, res) => {
            try {
                resolve(GdkPixbuf.Pixbuf.get_file_info_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function loadAtScale(path, width, height) {
    const stream = await Gio.File.new_for_path(path).read_async(GLib.PRIORITY_DEFAULT, null);
    try {
        return await new Promise((resolve, reject) => {
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, width, height, true, null,
                (_, res) => {
                    try {
                        resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    } finally {
        stream.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }
}

async function saveJpeg(pixbuf, path) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    // replace() writes to a temporary file and renames it when closed, so a
    // reader never sees a half-written thumbnail.
    const stream = await Gio.File.new_for_path(path).replace_async(null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, GLib.PRIORITY_DEFAULT, null);
    await new Promise((resolve, reject) => {
        pixbuf.save_to_streamv_async(stream, 'jpeg', ['quality'], ['90'], null, (_, res) => {
            try {
                resolve(GdkPixbuf.Pixbuf.save_to_stream_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
    await stream.close_async(GLib.PRIORITY_DEFAULT, null);
}

/**
 * A GNOME XML slideshow lists the images it cycles through; use the first.
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
async function firstSlideshowImage(path) {
    const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
    const match = new TextDecoder().decode(bytes).match(/<(?:file|from|size[^>]*)>\s*([^<\s][^<]*?)\s*</);
    if (!match)
        throw new Error(`No image found in slideshow ${path}`);
    return match[1];
}

/**
 * Scale and center-crop an image so it fills THUMB_WIDTH × THUMB_HEIGHT.
 *
 * @param {string} imagePath
 * @returns {Promise<GdkPixbuf.Pixbuf>}
 */
async function renderThumbnail(imagePath) {
    const [, width, height] = await getFileInfo(imagePath);
    if (!width || !height)
        throw new Error(`Unsupported image ${imagePath}`);

    // Let the loader downscale while decoding (cheap for JPEG); keep both sides
    // at least THUMB_WIDTH so the crop below works whatever the EXIF orientation.
    const shortSide = Math.min(width, height);
    const factor = Math.min(1, THUMB_WIDTH / shortSide);
    let pixbuf = await loadAtScale(imagePath,
        Math.max(1, Math.round(width * factor)), Math.max(1, Math.round(height * factor)));
    pixbuf = pixbuf.apply_embedded_orientation() ?? pixbuf;

    const w = pixbuf.get_width();
    const h = pixbuf.get_height();
    const scale = Math.max(THUMB_WIDTH / w, THUMB_HEIGHT / h);
    const coverW = Math.max(THUMB_WIDTH, Math.round(w * scale));
    const coverH = Math.max(THUMB_HEIGHT, Math.round(h * scale));
    if (coverW !== w || coverH !== h)
        pixbuf = pixbuf.scale_simple(coverW, coverH, GdkPixbuf.InterpType.BILINEAR);

    const x = Math.floor((coverW - THUMB_WIDTH) / 2);
    const y = Math.floor((coverH - THUMB_HEIGHT) / 2);
    // new_subpixbuf shares memory with its parent; copy() makes it standalone.
    return pixbuf.new_subpixbuf(x, y, THUMB_WIDTH, THUMB_HEIGHT).copy();
}

/**
 * Create the thumbnail for a wallpaper unless it exists already.
 * Concurrent requests for the same wallpaper share one job.
 *
 * @param {string} wallpaper
 * @returns {Promise<string>} the thumbnail path
 */
export function ensureThumbnail(wallpaper) {
    const target = thumbnailPath(wallpaper);
    if (GLib.file_test(target, GLib.FileTest.EXISTS))
        return Promise.resolve(target);

    if (!pending.has(target)) {
        const job = (async () => {
            const image = isSlideshow(wallpaper)
                ? await firstSlideshowImage(wallpaper) : wallpaper;
            await saveJpeg(await renderThumbnail(image), target);
            return target;
        })().finally(() => pending.delete(target));
        pending.set(target, job);
    }
    return pending.get(target);
}

/**
 * @param {string} wallpaper
 */
export async function removeThumbnail(wallpaper) {
    try {
        await Gio.File.new_for_path(thumbnailPath(wallpaper)).delete_async(GLib.PRIORITY_DEFAULT, null);
    } catch {
        // already gone
    }
}

function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r)
            h = ((g - b) / d) % 6;
        else if (max === g)
            h = (b - r) / d + 2;
        else
            h = (r - g) / d + 4;
        h *= 60;
        if (h < 0)
            h += 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
}

function hexToHsv(hex) {
    const n = parseInt(hex.slice(1), 16);
    return rgbToHsv((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255);
}

const hueDistance = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/**
 * Pick the GNOME accent color closest to the dominant vivid hue of an image.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf
 * @returns {string} one of the keys of ACCENT_COLORS
 */
export function accentFromPixbuf(pixbuf) {
    const small = pixbuf.scale_simple(48, 30, GdkPixbuf.InterpType.BILINEAR);
    const pixels = small.get_pixels();
    const channels = small.get_n_channels();
    const stride = small.get_rowstride();

    const bins = new Array(36).fill(0);
    let vivid = 0;
    let lit = 0;
    for (let y = 0; y < small.get_height(); y++) {
        for (let x = 0; x < small.get_width(); x++) {
            const i = y * stride + x * channels;
            const [h, s, v] = rgbToHsv(pixels[i] / 255, pixels[i + 1] / 255, pixels[i + 2] / 255);
            if (v < 0.2)
                continue; // near-black pixels say nothing about the palette
            lit++;
            if (s < 0.2)
                continue;
            const weight = s * v;
            bins[Math.floor(h / 10) % 36] += weight;
            vivid += weight;
        }
    }

    // Mostly gray, black or white images get the neutral accent.
    if (lit === 0 || vivid / lit < 0.08)
        return 'slate';

    // Smooth the circular histogram, then take the strongest hue.
    let best = 0;
    let bestScore = -1;
    for (let i = 0; i < 36; i++) {
        const score = bins[(i + 35) % 36] * 0.5 + bins[i] + bins[(i + 1) % 36] * 0.5;
        if (score > bestScore) {
            bestScore = score;
            best = i;
        }
    }
    const hue = best * 10 + 5;

    let accent = 'blue';
    let distance = Infinity;
    for (const [name, hex] of Object.entries(ACCENT_COLORS)) {
        if (name === 'slate')
            continue;
        const d = hueDistance(hue, hexToHsv(hex)[0]);
        if (d < distance) {
            distance = d;
            accent = name;
        }
    }
    return accent;
}

/**
 * @param {string} wallpaper
 * @returns {Promise<string>} the accent color matching the wallpaper
 */
export async function accentForWallpaper(wallpaper) {
    const thumbnail = await ensureThumbnail(wallpaper);
    return accentFromPixbuf(await loadAtScale(thumbnail, THUMB_WIDTH, THUMB_HEIGHT));
}
