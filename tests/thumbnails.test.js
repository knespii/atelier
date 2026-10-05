import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {
    THUMB_HEIGHT, THUMB_WIDTH, accentForWallpaper, accentFromPixbuf, ensureThumbnail,
    hasThumbnail, removeThumbnail,
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

export function testAccentFromSolidColors() {
    const cases = {
        teal: 0x2190a4ff,
        orange: 0xed5b00ff,
        blue: 0x3584e4ff,
        purple: 0x9141acff,
        green: 0x3a944aff,
        red: 0xe62d42ff,
        slate: 0x808080ff,
    };
    for (const [expected, rgba] of Object.entries(cases))
        assertEqual(accentFromPixbuf(solid(64, 40, rgba)), expected, `0x${rgba.toString(16)}`);
}

export function testAccentFollowsDominantColor() {
    // Mostly sky blue with a small orange object
    const pixbuf = solid(100, 100, 0x2f80d8ff);
    solid(20, 20, 0xed5b00ff).copy_area(0, 0, 20, 20, pixbuf, 40, 40);
    assertEqual(accentFromPixbuf(pixbuf), 'blue');
}

export async function testAccentForWallpaper() {
    const wallpaper = savePng(solid(1200, 800, 0xd56199ff), 'pink.png');
    assertEqual(await accentForWallpaper(wallpaper), 'pink');
}
