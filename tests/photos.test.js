import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {PhotoGallery, forgetPhoto} from '../lib/gallery.js';
import {
    GRID_THUMB, MAX_PHOTOS, addToSelection, cleanSelection, dropPhoto, intervalOf, isCovered, nextIndex, parseGallery,
    photoName, timeLeft, toggleSelection,
} from '../lib/photos.js';
import {ensurePictureCopy} from '../lib/thumbnails.js';
import {assert, assertEqual, freshDir} from './util.js';

export function testSelection() {
    assertEqual(toggleSelection([], 'a'), ['a'], 'picked');
    assertEqual(toggleSelection(['a', 'b'], 'c'), ['a', 'b', 'c'], 'at the end: in the order picked');
    assertEqual(toggleSelection(['a', 'b', 'c'], 'b'), ['a', 'c'], 'and out again');
    const full = Array.from({length: MAX_PHOTOS}, (_, i) => `p${i}`);
    assertEqual(toggleSelection(full, 'more'), full, 'not past the most a widget takes');
    assertEqual(toggleSelection(full, 'p3').length, MAX_PHOTOS - 1, 'though one can go');
    assertEqual(toggleSelection(['a'], 'b', 1), ['a'], 'a smaller most');
    assertEqual(cleanSelection(['a', 'a', 7, '', 'b', null, 'gone'], ['a', 'b']), ['a', 'b'],
        'photos there are, each once');
    assertEqual(cleanSelection('a'), [], 'nothing that is no list');
    assertEqual(cleanSelection([...full, 'x']).length, MAX_PHOTOS);
    assertEqual(addToSelection(['a'], ['b', 'a', 'c']), ['a', 'b', 'c'], 'added ones at the end, once');
    assertEqual(addToSelection(full.slice(1), ['x', 'y']), [...full.slice(1), 'x'], 'as many as fit');
}

export function testNextPhoto() {
    assertEqual(nextIndex(['a', 'b', 'c'], 'a'), 1);
    assertEqual(nextIndex(['a', 'b', 'c'], 'c'), 0, 'the first after the last');
    assertEqual(nextIndex(['a', 'b'], 'gone'), 0, 'the first when it shows none of them');
    assertEqual(nextIndex(['a', 'b'], null), 0);
    assertEqual(nextIndex([], 'a'), -1, 'none');
    assertEqual(nextIndex(['a'], 'a'), 0, 'one only: itself');
}

export function testInterval() {
    assertEqual(intervalOf({}), 10, 'ten seconds by default');
    assertEqual(intervalOf({interval: 30}), 30);
    assertEqual(intervalOf({interval: 0.5}), 0.5, 'less too (the tests take that)');
    assertEqual(intervalOf({interval: -3}), 10);
    assertEqual(intervalOf({interval: 'soon'}), 10);
    assertEqual(intervalOf({interval: 1e9}), 3600, 'an hour at most');
    assertEqual(timeLeft(10000, 4000), 6000, 'what is left of its time in sight');
    assertEqual(timeLeft(10000, 0), 10000);
    assertEqual(timeLeft(10000, 12000), 250, 'a moment at least, back in sight');
}

export function testGalleryNames() {
    const name = photoName('Sunflower Hill (2).JPG', 1700000000000, 'a1b2c3');
    assertEqual(name, `${(1700000000000).toString(36)}-a1b2c3-sunflower-hill-2.jpg`, 'when, a few letters, its name');
    assertEqual(photoName('Žluťoučký kůň.png', 5, 'zzzzzz'), '00000005-zzzzzz-zlutoucky-kun.png', 'no accents');
    assertEqual(photoName('.jpg', 5, 'abcdef', 'jpeg'), '00000005-abcdef-photo.jpeg', 'a name of some sort');
    const later = photoName('b.jpg', 2000, 'bbbbbb');
    const earlier = photoName('a.jpg', 1000, 'aaaaaa');
    assertEqual(parseGallery([later, '.x.partial', 'notes.json', earlier, `.${earlier}.partial`]),
        [{id: earlier, added: 1000}, {id: later, added: 2000}], 'the first added first; nothing else');
    const same = [photoName('y.jpg', 1000, 'yyyyyy'), photoName('x.jpg', 1000, 'xxxxxx')];
    assertEqual(parseGallery(same).map(p => p.id), [...same].sort(), 'added at once: by name');
}

export function testDropPhoto() {
    const layout = [
        {id: 'clock', kind: 'clock'},
        {id: 'photo', kind: 'photo', photos: ['a', 'b']},
        {id: 'photo-2', kind: 'photo', photos: ['b'], interval: 5},
    ];
    const dropped = dropPhoto(layout, 'b');
    assertEqual(dropped.map(e => e.photos ?? null), [null, ['a'], []], 'gone from every widget\'s choice');
    assertEqual(dropped[2].interval, 5, 'the rest as it was');
    assert(dropPhoto(layout, 'c') === layout, 'the same layout when none had it');
}

export function testCovered() {
    const card = [100, 100, 200, 100];
    assert(!isCovered(card, []), 'nothing over it');
    assert(isCovered(card, [[0, 0, 1000, 1000]]), 'a window over all of it');
    assert(!isCovered(card, [[0, 0, 250, 1000]]), 'over part of it: the rest shows');
    assert(isCovered(card, [[0, 0, 250, 1000], [250, 50, 100, 300]]), 'two windows side by side, over all of it');
    assert(!isCovered(card, [[0, 0, 250, 1000], [251, 50, 100, 300]]), 'with a pixel between them');
    assert(!isCovered(card, [[0, 0, 1000, 150], [0, 160, 1000, 100]]), 'or a strip');
    assert(isCovered(card, [[0, 0, 1000, 150], [0, 140, 1000, 100]]), 'over each other');
    assert(!isCovered(card, [[400, 0, 100, 100]]), 'beside it');
    assert(isCovered(card, [[100, 100, 100, 100], [200, 100, 100, 50], [200, 150, 100, 50]]), 'in pieces');
    assert(!isCovered(card, [[100, 100, 100, 100], [200, 100, 100, 50], [200, 150, 99, 50]]), 'but for a corner');
}

function picture(dir, name, width, height) {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
    pixbuf.fill(0x3a944aff);
    const path = GLib.build_filenamev([dir, name]);
    pixbuf.savev(path, 'jpeg', [], []);
    return path;
}

export async function testGallery() {
    const originals = freshDir('photo-originals');
    const gallery = new PhotoGallery(GLib.build_filenamev([freshDir('photo-gallery'), 'photos']));
    let told = 0;
    const listener = gallery.connect(() => told++);
    assertEqual(gallery.photos(), [], 'none at first');
    const notPicture = GLib.build_filenamev([originals, 'notes.txt']);
    GLib.file_set_contents(notPicture, 'not a picture');
    const ids = await gallery.add([picture(originals, 'Tall One.jpg', 300, 800), notPicture,
        picture(originals, 'wide.jpg', 900, 300)]);
    assertEqual(ids.length, 2, 'pictures only');
    assertEqual(gallery.ids(), ids, 'in the order added');
    assert(ids[0].endsWith('-tall-one.jpg'), ids[0]);
    assert(told === 1, `and said so (${told})`);
    // Copies: they stay when the pictures themselves go.
    GLib.unlink(GLib.build_filenamev([originals, 'wide.jpg']));
    assert(GLib.file_test(gallery.path(ids[1]), GLib.FileTest.EXISTS), 'its own copy');
    const thumb = GdkPixbuf.Pixbuf.new_from_file(await gallery.thumbnail(ids[1]));
    assertEqual([thumb.get_width(), thumb.get_height()], [GRID_THUMB, GRID_THUMB], 'a small copy for the grids');
    const shown = await ensurePictureCopy(gallery.path(ids[1]), 372, 180);
    await gallery.remove(ids[1]);
    assertEqual(gallery.ids(), [ids[0]], 'one taken out');
    assert(!GLib.file_test(gallery.path(ids[1]), GLib.FileTest.EXISTS) && !GLib.file_test(shown, GLib.FileTest.EXISTS),
        'with its copies');
    gallery.disconnect(listener);
    gallery.destroy();
}

export function testForgetPhoto() {
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.atelier'});
    const desktop = settings.get_child('desktop');
    const layout = [{id: 'photo', kind: 'photo', size: 'square', x: 0, y: 0, photos: ['a', 'b'], fine: true}];
    desktop.set_string('widgets', JSON.stringify(layout));
    settings.set_string('profiles', JSON.stringify([
        {id: 'one', name: 'One', widgets: {layout, style: 'modern'}},
        {id: 'two', name: 'Two', widgets: {layout: [{...layout[0], photos: ['b', 'c']}], style: 'modern'}},
        {id: 'three', name: 'Three'},
    ]));
    forgetPhoto(settings, 'b');
    assertEqual(JSON.parse(desktop.get_string('widgets'))[0].photos, ['a'], 'gone from the desktop\'s widget');
    const profiles = JSON.parse(settings.get_string('profiles'));
    assertEqual(profiles.map(p => p.widgets?.layout[0].photos ?? null), [['a'], ['c'], null], 'and every profile\'s');
    ['widgets'].forEach(key => desktop.reset(key));
    settings.reset('profiles');
}
