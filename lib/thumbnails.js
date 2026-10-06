// Wallpaper thumbnails, smaller copies of pictures and accent color detection.
// Shared by the shell and the preferences: only GLib/Gio/GdkPixbuf may be used here.
// Decoding and encoding run in GdkPixbuf's worker threads, so the shell never
// blocks on a large wallpaper. A copy carries the time its picture was last
// changed and is made anew when the picture changes: the wallpaper portal,
// say, writes every wallpaper it sets to ~/.config/background.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {isSlideshow, pictureCopyDir, thumbnailDir} from './paths.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'replace_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'move_async');
Gio._promisify(Gio.File.prototype, 'set_attributes_async', 'set_attributes_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');

export const THUMB_WIDTH = 400;
export const THUMB_HEIGHT = 250;

const pending = new Map();

const sha1 = text => GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, text, -1);

/**
 * @param {string} wallpaper - path of a wallpaper
 * @returns {string} where its thumbnail is (or will be) stored
 */
export function thumbnailPath(wallpaper) {
    return GLib.build_filenamev([thumbnailDir(), `${sha1(wallpaper)}.jpg`]);
}

/**
 * @param {string} path
 * @returns {number|null} when the file was last changed, in whole seconds
 *   (as thumbnails keep it by the freedesktop.org spec, and as any file
 *   system can), or null when it can't be read
 */
function modifiedTime(path) {
    try {
        return Gio.File.new_for_path(path).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_uint64('time::modified');
    } catch {
        return null;
    }
}

/**
 * @param {string} copy - a thumbnail or another copy of a picture
 * @param {number|null} time - when the picture was last changed
 * @returns {boolean} whether the copy is of the picture as it is now (when
 *   that can't be told, an existing copy is)
 */
function isFresh(copy, time) {
    const copyTime = modifiedTime(copy);
    return copyTime !== null && (time === null || copyTime === time);
}

/**
 * @param {string} wallpaper
 * @returns {boolean} whether its thumbnail is there, of the wallpaper as it is now
 */
export function hasThumbnail(wallpaper) {
    return isFresh(thumbnailPath(wallpaper), modifiedTime(wallpaper));
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

/**
 * Save a copy of a picture, with the time the picture was last changed.
 * It is written aside and moved into place, so a reader never sees a
 * half-written copy, nor one without its time.
 *
 * @param {GdkPixbuf.Pixbuf} pixbuf
 * @param {string} path
 * @param {number|null} time - see modifiedTime()
 * @param {boolean} png - PNG (keeps transparency) rather than JPEG
 */
async function saveCopy(pixbuf, path, time, png) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    const partial = Gio.File.new_for_path(`${path}.${GLib.uuid_string_random().slice(0, 8)}.partial`);
    try {
        const stream = await partial.replace_async(null, false, Gio.FileCreateFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        await new Promise((resolve, reject) => {
            pixbuf.save_to_streamv_async(stream, png ? 'png' : 'jpeg', png ? [] : ['quality'], png ? [] : ['90'], null,
                (_, res) => {
                    try {
                        resolve(GdkPixbuf.Pixbuf.save_to_stream_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        await stream.close_async(GLib.PRIORITY_DEFAULT, null);
        if (time !== null) {
            const info = new Gio.FileInfo();
            info.set_attribute_uint64('time::modified', time);
            await partial.set_attributes_async(info, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        }
        await partial.move_async(Gio.File.new_for_path(path), Gio.FileCopyFlags.OVERWRITE,
            GLib.PRIORITY_DEFAULT, null, null);
    } catch (e) {
        partial.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        throw e;
    }
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
 * Scale and center-crop an image so it fills width × height.
 *
 * @param {string} imagePath
 * @param {number} width
 * @param {number} height
 * @returns {Promise<GdkPixbuf.Pixbuf>}
 */
async function renderCover(imagePath, width, height) {
    const [, imageWidth, imageHeight] = await getFileInfo(imagePath);
    if (!imageWidth || !imageHeight)
        throw new Error(`Unsupported image ${imagePath}`);

    // Let the loader downscale while decoding (cheap for JPEG); keep both
    // sides at least as long as the longer one wanted, so the crop below
    // works whatever the EXIF orientation.
    const factor = Math.min(1, Math.max(width, height) / Math.min(imageWidth, imageHeight));
    let pixbuf = await loadAtScale(imagePath,
        Math.max(1, Math.round(imageWidth * factor)), Math.max(1, Math.round(imageHeight * factor)));
    pixbuf = pixbuf.apply_embedded_orientation() ?? pixbuf;

    const w = pixbuf.get_width();
    const h = pixbuf.get_height();
    const scale = Math.max(width / w, height / h);
    const coverW = Math.max(width, Math.round(w * scale));
    const coverH = Math.max(height, Math.round(h * scale));
    if (coverW !== w || coverH !== h)
        pixbuf = pixbuf.scale_simple(coverW, coverH, GdkPixbuf.InterpType.BILINEAR);

    const x = Math.floor((coverW - width) / 2);
    const y = Math.floor((coverH - height) / 2);
    // new_subpixbuf shares memory with its parent; copy() makes it standalone.
    return pixbuf.new_subpixbuf(x, y, width, height).copy();
}

/**
 * Make a copy of a picture unless it is there, of the picture as it is now.
 * Concurrent requests for the same copy share one job.
 *
 * @param {string} picture
 * @param {string} target - where the copy goes
 * @param {Function} render - async () => the copy, a GdkPixbuf
 * @param {boolean} [keepAlpha] - transparent pictures stay so (as PNG)
 * @returns {Promise<string>} target
 */
function ensureCopy(picture, target, render, keepAlpha = false) {
    const time = modifiedTime(picture);
    if (isFresh(target, time))
        return Promise.resolve(target);

    // (A job for the picture as it was doesn't do.)
    const key = `${target}\n${time}`;
    if (!pending.has(key)) {
        const job = (async () => {
            const pixbuf = await render();
            await saveCopy(pixbuf, target, time, keepAlpha && pixbuf.get_has_alpha());
            return target;
        })().finally(() => pending.delete(key));
        pending.set(key, job);
    }
    return pending.get(key);
}

/**
 * Create the thumbnail for a wallpaper unless it is there already.
 *
 * @param {string} wallpaper
 * @returns {Promise<string>} the thumbnail path
 */
export function ensureThumbnail(wallpaper) {
    return ensureCopy(wallpaper, thumbnailPath(wallpaper), async () => {
        const image = isSlideshow(wallpaper) ? await firstSlideshowImage(wallpaper) : wallpaper;
        return renderCover(image, THUMB_WIDTH, THUMB_HEIGHT);
    });
}

/**
 * A copy of a picture that fills width × height pixels (scaled and cropped
 * to its middle), to show it at that size: the picture may be many times
 * larger, and St would decode it whole on the main thread and keep it for
 * the rest of the session.
 *
 * @param {string} picture
 * @param {number} width - in pixels
 * @param {number} height
 * @returns {Promise<string>} the copy's path
 */
export function ensurePictureCopy(picture, width, height) {
    const target = GLib.build_filenamev([pictureCopyDir(), `${sha1(picture)}-${width}x${height}`]);
    return ensureCopy(picture, target, () => renderCover(picture, width, height), true);
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

/**
 * Small pixel sample of a wallpaper (taken from its thumbnail), for color
 * extraction.
 *
 * @param {string} wallpaper
 * @param {number} [width]
 * @param {number} [height]
 * @returns {Promise<{pixels: Uint8Array, channels: number, rowstride: number, width: number}>}
 */
export async function sampleWallpaper(wallpaper, width = 64, height = 40) {
    const thumbnail = await ensureThumbnail(wallpaper);
    const pixbuf = await loadAtScale(thumbnail, width, height);
    return {
        pixels: pixbuf.get_pixels(),
        channels: pixbuf.get_n_channels(),
        rowstride: pixbuf.get_rowstride(),
        width: pixbuf.get_width(),
    };
}
