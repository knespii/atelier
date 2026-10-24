import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    LOCK_FONTS, LOCK_STYLES, POSTER_KEYS, ProfileStore, describeProfile, effectiveWallpaper, giveLockscreen,
    giveWidgets, keepLockscreen, keepWidgets, normalizeLockscreen, normalizePaletteOptions, normalizeProfile,
    readCurrentAppearance, readLockscreen, writeLockscreen,
} from '../lib/profiles.js';
import {
    deleteWallpaperIfUnused, importWallpaper, isInLibrary, listWallpapers, prettyName, wallpaperFolder,
} from '../lib/paths.js';
import {assert, assertEqual, freshDir, writeFile} from './util.js';

function makeStore() {
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.atelier'});
    settings.reset('profiles');
    settings.reset('active-profile');
    return new ProfileStore(settings);
}

export function testNormalizeRejectsGarbage() {
    assertEqual(normalizeProfile(null), null);
    assertEqual(normalizeProfile({name: 'no id'}), null);

    const profile = normalizeProfile({
        id: 'x', name: '  Night  ', pictureOptions: 'bogus', colorScheme: 'purple',
        accentColor: 'magenta', gtkTheme: 42, font: 'Inter 11', gtk4: 'yes',
    });
    assertEqual(profile.name, 'Night');
    assertEqual(profile.pictureOptions, 'zoom');
    assertEqual([profile.colorScheme, profile.accentColor, profile.gtkTheme], [null, null, null]);
    assertEqual([profile.font, profile.gtk4], ['Inter 11', false]);
    assertEqual(normalizeProfile({id: 'y', accentColor: 'auto'}).accentColor, 'auto');
    assertEqual(normalizeProfile({id: 'y', accentColor: 'constructor'}).accentColor, null,
        'inherited object keys are not accent colors');
    assertEqual(normalizeProfile({id: 'y', pictureOptions: 'none'}).pictureOptions, 'none');
}

export function testDarkWallpaperVariant() {
    const profile = normalizeProfile({id: 'd', wallpaper: '/l.jpg', wallpaperDark: '/d.jpg'});
    assertEqual(effectiveWallpaper(profile, 'prefer-dark'), '/d.jpg');
    assertEqual(effectiveWallpaper(profile, 'default'), '/l.jpg');
    assertEqual(normalizeProfile({id: 'd', wallpaper: '/l.jpg', wallpaperDark: '/l.jpg'}).wallpaperDark, null,
        'same file twice is no variant');
    assertEqual(normalizeProfile({id: 'd', wallpaperDark: '/d.jpg'}).wallpaperDark, null,
        'no variant without a wallpaper');

    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    background.set_string('picture-uri', 'file:///w/light.jpg');
    background.set_string('picture-uri-dark', 'file:///w/dark.jpg');
    const current = readCurrentAppearance(null);
    assertEqual([current.wallpaper, current.wallpaperDark], ['/w/light.jpg', '/w/dark.jpg']);
    background.set_string('picture-uri-dark', 'file:///w/light.jpg');
    assertEqual(readCurrentAppearance(null).wallpaperDark, null);
    background.reset('picture-uri');
    background.reset('picture-uri-dark');
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
    assertEqual(store.activeId, '', 'removing the active profile clears it');
    assertEqual(store.getAll().length, 1);
}

export function testStoreSurvivesCorruptJson() {
    const store = makeStore();
    store._settings.set_string('profiles', '{not json');
    assertEqual(store.getAll(), []);
    store._settings.set_string('profiles', '[{"id":"a","name":"A"},{"id":"a","name":"dup"},7]');
    assertEqual(store.getAll().map(l => l.name), ['A']);
}

export function testDescribeProfile() {
    const profile = normalizeProfile({
        id: 'x', gtkTheme: 'Orchis', shellTheme: '', font: 'Inter 11',
        colorScheme: 'prefer-dark', accentColor: 'auto',
    });
    assertEqual(describeProfile(profile).map(p => `${p.label}=${p.value}`),
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
    const leftovers = GLib.Dir.open(GLib.path_get_dirname(imported), 0);
    for (let name; (name = leftovers.read_name());)
        assert(!name.endsWith('.partial'), `no temporary file left (${name})`);
    leftovers.close();
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

    // The desktop still showing the file (e.g. the profile on screen was deleted)
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

export function testPaletteOptions() {
    assertEqual(normalizePaletteOptions(null), null);
    assertEqual(normalizePaletteOptions({source: 'bogus', swatch: 12, preset: '', variant: 'loud'}),
        {source: 'wallpaper', swatch: 7, preset: 'ochre', variant: 'vibrant'});
    const profile = normalizeProfile({id: 'p', palette: {source: 'preset', preset: 'sea', variant: 'muted'}});
    assertEqual(profile.palette, {source: 'preset', swatch: 0, preset: 'sea', variant: 'muted'});
    assert(describeProfile(profile).some(p => p.label === 'Palette' && p.value === 'Sea, muted'));
}

export async function testListWallpapers() {
    const dir = freshDir('folder');
    const png = GLib.build_filenamev([dir, 'b-sunset.png']);
    const jpg = GLib.build_filenamev([dir, 'a-hill.jpg']);
    GLib.file_set_contents(png, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    GLib.file_set_contents(jpg, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0]));
    writeFile(GLib.build_filenamev([dir, 'notes.txt']), 'not a picture');
    GLib.mkdir_with_parents(GLib.build_filenamev([dir, 'sub.jpg']), 0o755);
    assertEqual(await listWallpapers(dir), [jpg, png], 'images only, sorted');

    const missing = GLib.build_filenamev([dir, 'Wallpapers']);
    assertEqual(await listWallpapers(missing), []);
    assert(!GLib.file_test(missing, GLib.FileTest.EXISTS), 'not created unless asked');
    await listWallpapers(missing, {create: true});
    assert(GLib.file_test(missing, GLib.FileTest.IS_DIR), 'created on request');

    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.atelier'});
    settings.set_string('wallpaper-folder', dir);
    assertEqual(wallpaperFolder(settings), dir);
    settings.reset('wallpaper-folder');
    assert(wallpaperFolder(settings).endsWith('/Wallpapers'), 'default folder');
}

export function testProfilesKeepTheirWidgets() {
    const store = makeStore();
    const desktop = store.settings.get_child('desktop');
    desktop.reset('widgets');
    desktop.reset('style');
    const a = store.add({name: 'A', wallpaper: null});
    store.settings.set_string('active-profile', a.id);
    assertEqual(store.get(a.id).widgets, null, 'none kept until they are edited');

    desktop.set_string('widgets', JSON.stringify([{id: 'clock', kind: 'clock', size: 'card', x: 3, y: 1},
        {id: 'x', kind: 'toaster', x: 0, y: 0}]));
    desktop.set_string('style', 'analogue');
    keepWidgets(store, desktop);
    const kept = store.get(a.id).widgets;
    assertEqual(kept.layout.map(e => [e.kind, e.size, e.x]), [['clock', 'card', 6]], 'only known widgets (on the finer grid)');
    assertEqual([kept.style, kept.glass], ['analogue', true]);
    assert(describeProfile(store.get(a.id)).some(p => p.label === 'Widgets' && p.value === '1 widget'));

    const odd = normalizeProfile({id: 'b', widgets: {layout: 'nope'}});
    assertEqual(odd.widgets, null, 'a broken layout is dropped');
    store.settings.reset('active-profile');
    keepWidgets(store, desktop);
    desktop.reset('widgets');
    desktop.reset('style');
}

export function testProfilesFromBeforeGetTheirOwnWidgets() {
    const store = makeStore();
    const desktop = store.settings.get_child('desktop');
    desktop.set_string('widgets', JSON.stringify([{id: 'date', kind: 'date', size: 'square', x: 0, y: 0}]));
    const a = store.add({name: 'A'});
    const b = store.add({name: 'B', widgets: {layout: [], style: 'analogue', glass: false}});
    assertEqual(giveWidgets(store, desktop), 1, 'only the one without');
    assertEqual(store.get(a.id).widgets.layout.map(e => e.kind), ['date']);
    assertEqual(store.get(b.id).widgets.style, 'analogue', 'the other keeps its own');
    assertEqual(giveWidgets(store, desktop), 0, 'once');
    desktop.reset('widgets');
}

// The lockscreen settings as they come, but for what a test sets.
function lockSettingsOf(store) {
    const lock = store.settings.get_child('lockscreen');
    lock.settings_schema.list_keys().forEach(key => lock.reset(key));
    return lock;
}

const GLASS_CLOCK = {id: 'clock', kind: 'clock', size: 'tall', x: 13, y: 2, fine: true, face: 'glass'};

export function testLockscreenKeptValid() {
    assertEqual(normalizeLockscreen(null), null);
    assertEqual(normalizeLockscreen({style: 'modern'}), null, 'without a layout, none');
    const odd = normalizeLockscreen({
        widgets: [GLASS_CLOCK, {id: 'g', kind: 'github', size: 'card', x: 0, y: 0}],
        style: 'neon', clockColor: 'red', clockFont: 'comic', clockWeight: 1200, clockWidth: -5,
        gnomeClock: 'no', depthEffect: 1, enabled: false, island: false, depthModel: 'large',
    });
    assertEqual(odd.widgets.map(e => [e.kind, e.size, e.face]), [['clock', 'tall', 'glass']],
        'only what the lock screen has');
    assertEqual([odd.style, odd.clockColor, odd.clockFont, odd.clockWeight, odd.clockWidth],
        ['bare', 'auto', 'inter', 1000, 0], 'what is not valid, as it comes');
    assertEqual([odd.gnomeClock, odd.depthEffect], [true, false]);
    assertEqual(Object.keys(odd),
        ['widgets', 'style', 'clockColor', 'clockFont', 'clockWeight', 'clockWidth', 'gnomeClock', 'depthEffect'],
        'nothing that holds for every profile');
    const fine = normalizeLockscreen({widgets: '[{"kind":"battery","x":1,"y":1}]', style: 'analogue',
        clockColor: '#FFcc00', clockFont: 'thin', clockWeight: 650, clockWidth: 120, gnomeClock: false,
        depthEffect: true});
    assertEqual(fine.widgets.map(e => [e.id, e.size, e.x]), [['battery', 'small', 2]],
        'the layout as the settings keep it, JSON, will do');
    assertEqual([fine.style, fine.clockColor, fine.clockFont, fine.clockWeight, fine.clockWidth, fine.gnomeClock,
        fine.depthEffect], ['analogue', '#FFcc00', 'thin', 650, 120, false, true], 'valid values, as they are');
    assertEqual(normalizeLockscreen(fine), fine, 'the same, cleaned up again');
    assertEqual(normalizeProfile({id: 'p', lockscreen: fine}).lockscreen, fine, 'in a profile');
    assertEqual(normalizeProfile({id: 'p'}).lockscreen, null, 'none: the lock screen is left as it is');
}

export function testLockscreenClockOfItsOwnSize() {
    // A glass clock stretched to a size of its own keeps it, in the profile
    // and on the lock screen it is written to; the biggest clock is the one
    // that covers most cells.
    const poster = normalizeLockscreen({widgets: [
        {id: 'stacked', kind: 'clock', size: 'tall', x: 0, y: 2, fine: true, face: 'stacked'},
        {...GLASS_CLOCK, id: 'glass', size: '9x11', x: 13},
    ]});
    assertEqual(poster.widgets.map(e => e.size), ['tall', '9x11'], 'kept as it is');
    assertEqual(normalizeLockscreen(poster), poster, 'and again');
    const profile = normalizeProfile({id: 'p', lockscreen: poster});
    assertEqual(profile.lockscreen, poster, 'in a profile');
    assertEqual(describeProfile(profile).find(p => p.label === 'Lock screen')?.value, 'Glass clock, Inter',
        'nine by eleven cells: bigger than a tall clock');
    const lock = lockSettingsOf(makeStore());
    try {
        writeLockscreen(lock, poster);
        assertEqual(readLockscreen(lock), poster, 'written and read back');
    } finally {
        lockSettingsOf(makeStore());
    }
}

export function testLockscreenAsTheSchemaHasIt() {
    const lock = lockSettingsOf(makeStore());
    const schema = lock.settings_schema;
    const range = key => schema.get_key(key).get_range().recursiveUnpack();
    assertEqual(range('clock-font'), ['enum', LOCK_FONTS], 'the fonts');
    assertEqual(range('style'), ['enum', LOCK_STYLES], 'the looks');
    assertEqual([range('clock-weight'), range('clock-width')], [['range', [0, 1000]], ['range', [0, 200]]]);
    assert(POSTER_KEYS.every(key => schema.has_key(key)), 'every key there');
    assertEqual(POSTER_KEYS.filter(key => ['enabled', 'island', 'password-field', 'depth-model', 'subject-model',
        'edit-request', 'depth-request', 'depth-status'].includes(key)), [], 'none of those for every profile');
    assertEqual(readLockscreen(lock), normalizeLockscreen({widgets: []}), 'as it comes, as a profile has it');
}

export function testLockscreenWrittenWhereItDiffers() {
    const lock = lockSettingsOf(makeStore());
    lock.set_boolean('island', false);
    lock.set_string('depth-model', 'large');
    lock.set_string('subject-model', 'lite');
    const changed = [];
    const id = lock.connect('changed', (_, key) => changed.push(key));
    const poster = normalizeLockscreen({widgets: [GLASS_CLOCK], clockFont: 'flex', clockWeight: 700,
        gnomeClock: false, depthEffect: true});
    try {
        assertEqual(writeLockscreen(lock, poster), ['widgets', 'clock-font', 'clock-weight', 'gnome-clock',
            'depth-effect'], 'only what differs');
        assertEqual(readLockscreen(lock), poster, 'read back as written');
        changed.length = 0;
        assertEqual(writeLockscreen(lock, poster), [], 'nothing again');
        // The same layout, its JSON written otherwise.
        lock.set_string('widgets', JSON.stringify([{face: 'glass', x: 13, y: 2, id: 'clock', kind: 'clock',
            size: 'tall', fine: true}]));
        changed.length = 0;
        assertEqual(writeLockscreen(lock, poster), [], 'the same layout, however its JSON is written');
        assertEqual(changed, [], 'and no key changed');
        assertEqual([lock.get_boolean('island'), lock.get_string('depth-model'), lock.get_string('subject-model'),
            lock.get_boolean('enabled'), lock.get_boolean('password-field')], [false, 'large', 'lite', true, true],
        'what holds for every profile left as it is');
        assertEqual(writeLockscreen(lock, null), [], 'no lock screen: nothing written');
    } finally {
        lock.disconnect(id);
        lockSettingsOf(makeStore());
    }
}

export function testProfilesKeepTheirLockScreen() {
    const store = makeStore();
    const lock = lockSettingsOf(store);
    lock.set_string('widgets', JSON.stringify([GLASS_CLOCK]));
    const a = store.add({name: 'A'});
    const b = store.add({name: 'B', lockscreen: {widgets: [], style: 'modern', gnomeClock: true}});
    assertEqual(giveLockscreen(store, lock), 1, 'only the one without');
    assertEqual(store.get(a.id).lockscreen.widgets.map(e => e.face), ['glass'], 'a copy of the one there is');
    assertEqual(store.get(b.id).lockscreen.style, 'modern', 'the other keeps its own');
    assertEqual(giveLockscreen(store, lock), 0, 'once');

    let writes = 0;
    const id = store.settings.connect('changed::profiles', () => writes++);
    try {
        assert(!keepLockscreen(store, lock), 'none in use: kept nowhere');
        store.activeId = a.id;
        assert(!keepLockscreen(store, lock) && writes === 0, 'as the profile has it: not written again');
        lock.set_string('clock-font', 'serif');
        lock.set_boolean('depth-effect', true);
        assert(keepLockscreen(store, lock), 'edited: kept');
        assertEqual([store.get(a.id).lockscreen.clockFont, store.get(a.id).lockscreen.depthEffect], ['serif', true],
            'in the profile in use');
        assertEqual(store.get(b.id).lockscreen.clockFont, 'inter', 'and only there');
        assertEqual(describeProfile(store.get(a.id)).find(p => p.label === 'Lock screen')?.value,
            'Glass clock, Serif, depth effect');

        // Switched to the other: its own lock screen, and the first keeps its.
        writeLockscreen(lock, store.get(b.id).lockscreen);
        store.activeId = b.id;
        assertEqual(readLockscreen(lock), store.get(b.id).lockscreen, 'the other\'s lock screen shows');
        assert(!keepLockscreen(store, lock), 'which it has already');
        assertEqual(store.get(a.id).lockscreen.clockFont, 'serif', 'the first as it was');

        // A new profile of the setup there is now has it too.
        const c = store.add({name: 'C', lockscreen: readLockscreen(lock)});
        assertEqual(store.get(c.id).lockscreen, store.get(b.id).lockscreen);
    } finally {
        store.settings.disconnect(id);
        store.settings.reset('active-profile');
        lockSettingsOf(store);
    }
}

export function testDescribeLockscreen() {
    const said = lockscreen => describeProfile(normalizeProfile({id: 'x', lockscreen}))
        .find(p => p.label === 'Lock screen')?.value;
    assertEqual(said({widgets: []}), undefined, 'GNOME\'s lock screen as it is: nothing to say');
    assertEqual(said({widgets: [], gnomeClock: false}), 'No clock');
    assertEqual(said({widgets: [GLASS_CLOCK, {id: 'battery', kind: 'battery', x: 13, y: 14, fine: true}]}),
        'Glass clock, Inter');
    assertEqual(said({widgets: [{id: 'c', kind: 'clock', size: 'square', x: 0, y: 0, fine: true, face: 'digital'},
        GLASS_CLOCK], clockFont: 'flex', clockWeight: 700, depthEffect: true}),
    'Glass clock, Roboto Flex 700, depth effect', 'the biggest clock');
    assertEqual(said({widgets: [{id: 'c', kind: 'clock', size: 'large', x: 0, y: 0, fine: true}], clockFont: 'default'}),
        'Clock, Default font', 'a clock of no face of its own');
    assertEqual(said({widgets: [{id: 'battery', kind: 'battery', x: 0, y: 0, fine: true}]}), '1 widget, Inter');
    assertEqual(said(null), undefined, 'none: not said');
}
