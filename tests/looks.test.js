import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {LookStore, describeLook, normalizeLook} from '../lib/looks.js';
import {importWallpaper, isInLibrary, prettyName, deleteWallpaperIfUnused} from '../lib/paths.js';
import {assert, assertEqual, freshDir, writeFile} from './util.js';

function makeStore() {
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.bg-changer'});
    settings.reset('looks');
    settings.reset('active-look');
    return new LookStore(settings);
}

export function testNormalizeRejectsGarbage() {
    assertEqual(normalizeLook(null), null);
    assertEqual(normalizeLook({name: 'no id'}), null);

    const look = normalizeLook({
        id: 'x', name: '  Night  ', pictureOptions: 'bogus', colorScheme: 'purple',
        accentColor: 'magenta', gtkTheme: 42, font: 'Inter 11', gtk4: 'yes',
    });
    assertEqual(look.name, 'Night');
    assertEqual(look.pictureOptions, 'zoom');
    assertEqual([look.colorScheme, look.accentColor, look.gtkTheme], [null, null, null]);
    assertEqual([look.font, look.gtk4], ['Inter 11', false]);
    assertEqual(normalizeLook({id: 'y', accentColor: 'auto'}).accentColor, 'auto');
}

export function testStoreRoundTrip() {
    const store = makeStore();
    const a = store.add({name: 'A', wallpaper: '/a.jpg', gtkTheme: 'Adwaita'});
    const b = store.add({name: 'B', wallpaper: '/b.jpg'});
    assert(a.id && b.id && a.id !== b.id, 'ids are unique');
    assertEqual(store.getAll().map(l => l.name), ['A', 'B']);

    store.update(b.id, {name: 'B2', iconTheme: 'Conflux', id: 'ignored'});
    assertEqual(store.get(b.id).name, 'B2');
    assertEqual(store.get(b.id).iconTheme, 'Conflux');

    store.move(b.id, -1);
    assertEqual(store.getAll().map(l => l.name), ['B2', 'A']);
    store.move(b.id, -1); // already first: no-op
    assertEqual(store.getAll().map(l => l.name), ['B2', 'A']);

    store.activeId = a.id;
    assertEqual(store.remove(a.id).name, 'A');
    assertEqual(store.activeId, '', 'removing the active look clears it');
    assertEqual(store.getAll().length, 1);
}

export function testStoreSurvivesCorruptJson() {
    const store = makeStore();
    store._settings.set_string('looks', '{not json');
    assertEqual(store.getAll(), []);
    store._settings.set_string('looks', '[{"id":"a","name":"A"},{"id":"a","name":"dup"},7]');
    assertEqual(store.getAll().map(l => l.name), ['A']);
}

export function testDescribeLook() {
    const look = normalizeLook({
        id: 'x', gtkTheme: 'Orchis', shellTheme: '', font: 'Inter 11',
        colorScheme: 'prefer-dark', accentColor: 'auto',
    });
    assertEqual(describeLook(look).map(p => `${p.label}=${p.value}`),
        ['GTK=Orchis', 'Shell=Default', 'Font=Inter 11', 'Style=Dark', 'Accent=Auto']);
}

export function testPrettyName() {
    assertEqual(prettyName('/x/sunflower_hill-bicycle.jpg'), 'Sunflower Hill Bicycle');
    assertEqual(prettyName('/x/1a2b3c4d-ship-in-the-meadow.png'), 'Ship In The Meadow');
    assertEqual(prettyName('/home/u/.config/background'), 'Background');
}

export async function testImportCopiesIntoLibrary() {
    // ~/.config/background style: a JPEG without extension at a fixed path
    const dir = freshDir('import');
    const source = GLib.build_filenamev([dir, 'background']);
    const jpegHeader = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]);
    GLib.file_set_contents(source, jpegHeader);

    const imported = await importWallpaper(source);
    assert(isInLibrary(imported), `${imported} is in the library`);
    assert(imported.endsWith('-background.jpg'), `type sniffed from content: ${imported}`);
    assert(GLib.file_test(imported, GLib.FileTest.EXISTS), 'copy exists');
    assertEqual(await importWallpaper(imported), imported, 'library files are not copied again');

    const slideshow = GLib.build_filenamev([dir, 'day.xml']);
    writeFile(slideshow, '<background/>');
    assertEqual(await importWallpaper(slideshow), slideshow, 'slideshows are referenced');

    const text = GLib.build_filenamev([dir, 'notes.txt']);
    writeFile(text, 'hello');
    let error = null;
    try {
        await importWallpaper(text);
    } catch (e) {
        error = e;
    }
    assert(error, 'non-images are rejected');

    assertEqual(await deleteWallpaperIfUnused(imported, [{wallpaper: imported}]), false);
    assert(GLib.file_test(imported, GLib.FileTest.EXISTS), 'still used: kept');
    assertEqual(await deleteWallpaperIfUnused(imported, [{wallpaper: '/x', wallpaperDark: imported}]), false);
    assert(GLib.file_test(imported, GLib.FileTest.EXISTS), 'used as a dark variant: kept');

    // The desktop still showing the file (e.g. the look on screen was deleted)
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    background.set_string('picture-uri-dark', GLib.filename_to_uri(imported, null));
    assertEqual(await deleteWallpaperIfUnused(imported, []), false);
    assert(GLib.file_test(imported, GLib.FileTest.EXISTS), 'desktop background: kept');
    background.reset('picture-uri-dark');

    assertEqual(await deleteWallpaperIfUnused(imported, []), true);
    assert(!GLib.file_test(imported, GLib.FileTest.EXISTS), 'unused: deleted');
    await deleteWallpaperIfUnused(source, []);
    assert(GLib.file_test(source, GLib.FileTest.EXISTS), 'files outside the library are never deleted');
}
