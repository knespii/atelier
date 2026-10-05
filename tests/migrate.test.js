import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {LEGACY_SCHEMA, legacyWallpaperDir, migrateFromBgChanger} from '../lib/migrate.js';
import {wallpaperDir} from '../lib/paths.js';
import {assert, assertEqual, writeFile} from './util.js';

const fn = (...parts) => GLib.build_filenamev(parts);
const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);
const uri = path => Gio.File.new_for_path(path).get_uri();

function resetAll() {
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.atelier'});
    const legacy = new Gio.Settings({schema_id: LEGACY_SCHEMA});
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    for (const s of [settings, legacy])
        s.settings_schema.list_keys().forEach(key => s.reset(key));
    background.reset('picture-uri');
    background.reset('picture-uri-dark');
    return {settings, legacy, background};
}

export async function testNothingToTakeOver() {
    const {settings, legacy, background} = resetAll();
    const result = await migrateFromBgChanger(settings, legacy, {background});
    assertEqual(result, {migrated: false});
    assertEqual(settings.get_boolean('migrated-from-bg-changer'), true, 'flag set');
    assertEqual(settings.get_string('profiles'), '[]');
}

export async function testTakesOverProfilesFilesAndSettings() {
    const {settings, legacy, background} = resetAll();
    const oldDir = legacyWallpaperDir();
    const light = fn(oldDir, 'aaaa1111-village.jpg');
    const dark = fn(oldDir, 'bbbb2222-village-night.jpg');
    writeFile(light, 'light picture');
    writeFile(dark, 'dark picture');
    const outside = '/usr/share/backgrounds/gnome/amber-d.jxl';

    legacy.set_string('looks', JSON.stringify([
        {id: 'orig', name: 'Original', wallpaper: light, wallpaperDark: dark, gtkTheme: 'Adwaita-dark'},
        {id: 'amber', name: 'Amber', wallpaper: outside, accentColor: 'orange'},
    ]));
    legacy.set_string('active-look', 'orig');
    legacy.set_strv('bgc-open-switcher', ['<Control>minus']);
    legacy.set_string('transition', 'fade');
    legacy.set_uint('transition-duration', 1200);
    legacy.set_boolean('first-run-done', true);
    settings.set_string('profiles', JSON.stringify([{id: 'keep', name: 'Made in Atelier'}]));
    background.set_string('picture-uri', uri(light));
    background.set_string('picture-uri-dark', uri(dark));

    const result = await migrateFromBgChanger(settings, legacy, {background});
    assertEqual(result, {migrated: true, profiles: 2, files: 2});

    const profiles = JSON.parse(settings.get_string('profiles'));
    assertEqual(profiles.map(p => p.id), ['orig', 'amber', 'keep'], 'old profiles first, own ones kept');
    const original = profiles[0];
    assert(original.wallpaper.startsWith(`${wallpaperDir()}/`), `moved: ${original.wallpaper}`);
    assert(original.wallpaperDark.startsWith(`${wallpaperDir()}/`), 'dark variant moved');
    assert(exists(original.wallpaper) && exists(original.wallpaperDark), 'copies exist');
    assertEqual(original.gtkTheme, 'Adwaita-dark');
    assertEqual(profiles[1].wallpaper, outside, 'files outside the library keep their path');

    assert(!exists(light) && !exists(dark), 'old copies removed');
    assert(!exists(oldDir), 'old library removed');
    assertEqual(background.get_string('picture-uri'), uri(original.wallpaper), 'desktop follows');
    assertEqual(background.get_string('picture-uri-dark'), uri(original.wallpaperDark));

    assertEqual(settings.get_string('active-profile'), 'orig');
    assertEqual(settings.get_strv('atelier-open-switcher'), ['<Control>minus']);
    assertEqual(settings.get_string('transition'), 'fade');
    assertEqual(settings.get_uint('transition-duration'), 1200);
    assertEqual(settings.get_boolean('first-run-done'), true);

    // A second start changes nothing.
    settings.set_string('profiles', '[]');
    assertEqual(await migrateFromBgChanger(settings, legacy, {background}), {migrated: false});
    assertEqual(settings.get_string('profiles'), '[]');
}

export async function testUnchangedKeysKeepAtelierDefaults() {
    const {settings, legacy, background} = resetAll();
    legacy.set_string('looks', '[]');
    settings.set_strv('atelier-open-switcher', ['<Super>a']);
    await migrateFromBgChanger(settings, legacy, {background});
    assertEqual(settings.get_strv('atelier-open-switcher'), ['<Super>a'],
        'keys BG Changer never changed are not copied');
    assertEqual(settings.get_boolean('migrated-from-bg-changer'), true);
}
