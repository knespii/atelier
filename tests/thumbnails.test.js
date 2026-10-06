import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    THUMB_HEIGHT, THUMB_WIDTH, ensurePictureCopy, ensureThumbnail, hasThumbnail, removeThumbnail, sampleWallpaper,
} from '../lib/thumbnails.js';
import {assert, assertEqual, freshDir, writeFile} from './util.js';

function solid(width, height, rgba) {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, width, height);
    pixbuf.fill(rgba);
    return pixbuf;
}

function savePng(pixbuf, name) {
    const path = GLib.build_filenamev([freshDir('thumbs'), name]);
    pixbuf.savev(path, 'png', [], []);
    return path;
}

export async function testLandscapeAndPortraitThumbnails() {
    for (const [w, h] of [[1600, 900], [900, 1600], [300, 200]]) {
        const wallpaper = savePng(solid(w, h, 0x2190a4ff), `${w}x${h}.png`);
        const thumb = await ensureThumbnail(wallpaper);
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file(thumb);
        assertEqual([pixbuf.get_width(), pixbuf.get_height()], [THUMB_WIDTH, THUMB_HEIGHT], `${w}x${h}`);
        assert(hasThumbnail(wallpaper));
        await removeThumbnail(wallpaper);
        assert(!hasThumbnail(wallpaper), 'thumbnail removed');
    }
}

export async function testConcurrentRequestsShareOneJob() {
    const wallpaper = savePng(solid(800, 600, 0xff0000ff), 'red.png');
    const [a, b] = await Promise.all([ensureThumbnail(wallpaper), ensureThumbnail(wallpaper)]);
    assertEqual(a, b);
}

export async function testSlideshowUsesFirstImage() {
    const image = savePng(solid(800, 500, 0x3a944aff), 'first.png');
    const xml = GLib.build_filenamev([freshDir('slideshow'), 'day.xml']);
    writeFile(xml, `<background>
  <static><duration>60</duration><file>
    <size width="800" height="500">${image}</size>
  </file></static>
</background>`);
    const thumb = await ensureThumbnail(xml);
    assert(GLib.file_test(thumb, GLib.FileTest.EXISTS));
}

export async function testSampleWallpaper() {
    const wallpaper = savePng(solid(1200, 800, 0x2190a4ff), 'sample.png');
    const sample = await sampleWallpaper(wallpaper, 32, 20);
    assertEqual(sample.width, 32);
    assert(sample.pixels.length >= 20 * sample.rowstride - sample.rowstride, 'pixels for every row');
    assertEqual([sample.pixels[0], sample.pixels[1], sample.pixels[2]], [0x21, 0x90, 0xa4]);
}

function setModified(path, seconds) {
    const info = new Gio.FileInfo();
    info.set_attribute_uint64('time::modified', seconds);
    Gio.File.new_for_path(path).set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
}

export async function testThumbnailFollowsAChangedPicture() {
    // As the wallpaper portal does: every picture to the same file.
    const wallpaper = GLib.build_filenamev([freshDir('portal'), 'background']);
    // (Thumbnails are JPEG: the colors come back near, not exact.)
    const color = async () => {
        const {pixels} = await sampleWallpaper(wallpaper, 8, 5);
        return ['red', 'green', 'blue'].find((_, i) => pixels[i] > 200);
    };
    solid(1200, 800, 0xff0000ff).savev(wallpaper, 'png', [], []);
    setModified(wallpaper, 1700000000);
    assertEqual(await color(), 'red', 'at first');
    assert(hasThumbnail(wallpaper));

    const next = `${wallpaper}.new`;
    solid(1200, 800, 0x0000ffff).savev(next, 'png', [], []);
    setModified(next, 1700000100);
    Gio.File.new_for_path(next).move(Gio.File.new_for_path(wallpaper), Gio.FileCopyFlags.OVERWRITE, null, null);
    assert(!hasThumbnail(wallpaper), 'the thumbnail is of the picture as it was');
    assertEqual(await color(), 'blue', 'once it changed');
    assert(hasThumbnail(wallpaper), 'and the thumbnail made anew');

    // A picture put back with an older time is another picture too.
    solid(1200, 800, 0x00ff00ff).savev(next, 'png', [], []);
    setModified(next, 1600000000);
    Gio.File.new_for_path(next).move(Gio.File.new_for_path(wallpaper), Gio.FileCopyFlags.OVERWRITE, null, null);
    assertEqual(await color(), 'green', 'older or not');
}

export async function testPictureCopies() {
    // A tall photo as a square card: no bigger than that, cut from its middle.
    const photo = GLib.build_filenamev([freshDir('photos'), 'photo.jpg']);
    const opaque = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 1770, 3929);
    opaque.fill(0x3a944aff);
    opaque.savev(photo, 'jpeg', [], []);
    const copy = await ensurePictureCopy(photo, 180, 180);
    let pixbuf = GdkPixbuf.Pixbuf.new_from_file(copy);
    assertEqual([pixbuf.get_width(), pixbuf.get_height(), pixbuf.get_has_alpha()], [180, 180, false]);
    assertEqual(await ensurePictureCopy(photo, 180, 180), copy, 'made once');
    const [wide, again] = await Promise.all([ensurePictureCopy(photo, 372, 180), ensurePictureCopy(photo, 372, 180)]);
    assertEqual(wide, again, 'one job for both');
    pixbuf = GdkPixbuf.Pixbuf.new_from_file(wide);
    assertEqual([pixbuf.get_width(), pixbuf.get_height()], [372, 180], 'each size its own');

    // Transparent stays transparent.
    const sticker = savePng(solid(400, 300, 0x00ff0080), 'sticker.png');
    pixbuf = GdkPixbuf.Pixbuf.new_from_file(await ensurePictureCopy(sticker, 100, 100));
    assert(pixbuf.get_has_alpha(), 'with transparency');
}
