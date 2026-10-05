import GLib from 'gi://GLib';

import {locateTheme, scanThemes} from '../lib/themes.js';
import {assert, assertEqual, freshDir, writeFile} from './util.js';

const fn = (...parts) => GLib.build_filenamev(parts);

function fakeTree() {
    const root = freshDir('themes');
    const user = fn(root, 'user-themes');
    const system = fn(root, 'system-themes');
    const icons = fn(root, 'icons');

    // GTK 3 only theme with a 2021-era shell stylesheet
    writeFile(fn(user, 'Old', 'gtk-3.0', 'gtk.css'), '/* gtk3 */');
    writeFile(fn(user, 'Old', 'gnome-shell', 'gnome-shell.css'), '#panel { color: red; }');
    // Modern theme: GTK 3 + 4 (with dark variant) and a current shell stylesheet
    writeFile(fn(user, 'Modern', 'gtk-3.0', 'gtk.css'), '');
    writeFile(fn(user, 'Modern', 'gtk-4.0', 'gtk.css'), '');
    writeFile(fn(user, 'Modern', 'gtk-4.0', 'gtk-dark.css'), '');
    writeFile(fn(user, 'Modern', 'gnome-shell', 'gnome-shell.css'), '@import url("parts.css");');
    writeFile(fn(user, 'Modern', 'gnome-shell', 'parts.css'), '.quick-settings { padding: 1px; }');
    // Shell-only theme extending the built-in stylesheet
    writeFile(fn(user, 'Extends', 'gnome-shell', 'gnome-shell.css'),
        '@import url("resource:///org/gnome/theme/gnome-shell.css");');
    // Noise that must be ignored
    writeFile(fn(user, 'Archive.tar.xz'), 'not a directory');
    writeFile(fn(user, 'Empty', 'README'), '');
    // Same name in a later directory loses
    writeFile(fn(system, 'Modern', 'gtk-3.0', 'gtk.css'), '');

    writeFile(fn(icons, 'Pretty', 'index.theme'),
        '[Icon Theme]\nName=Pretty Icons\nDirectories=48x48/apps\n');
    writeFile(fn(icons, 'Pointer', 'index.theme'), '[Icon Theme]\nName=Pointer\n');
    writeFile(fn(icons, 'Pointer', 'cursors', 'default'), '');
    writeFile(fn(icons, 'Secret', 'index.theme'),
        '[Icon Theme]\nName=Secret\nHidden=true\nDirectories=48x48/apps\n');
    writeFile(fn(icons, 'hicolor', 'index.theme'),
        '[Icon Theme]\nName=Hicolor\nDirectories=48x48/apps\n');
    writeFile(fn(icons, 'loose.png'), '');

    return {themes: [user, system], icons: [icons], shellModes: [fn(root, 'none')], user};
}

export async function testGtkThemes() {
    const dirs = fakeTree();
    const {gtk} = await scanThemes(dirs);
    assertEqual(gtk.map(t => t.name), ['Modern', 'Old']);

    const modern = gtk.find(t => t.name === 'Modern');
    assertEqual([modern.gtk4, modern.gtk4Dark], [true, true], 'Modern GTK4 support');
    assertEqual(modern.path, fn(dirs.user, 'Modern'), 'first directory wins');
    assertEqual(gtk.find(t => t.name === 'Old').gtk4, false, 'Old has no GTK4');
}

export async function testShellCompatibility() {
    const {shell} = await scanThemes(fakeTree());
    const compat = Object.fromEntries(shell.map(t => [t.name, t.compat]));
    assertEqual(compat, {Extends: 'ok', Modern: 'ok', Old: 'outdated'});
}

export async function testIconsAndCursors() {
    const {icons, cursors} = await scanThemes(fakeTree());
    assertEqual(icons.map(t => [t.name, t.displayName]), [['Pretty', 'Pretty Icons']]);
    assertEqual(cursors.map(t => t.name), ['Pointer']);
}

export async function testMissingDirectories() {
    const result = await scanThemes({themes: ['/nonexistent'], icons: [], shellModes: []});
    assertEqual(result, {gtk: [], shell: [], icons: [], cursors: []});
}

export async function testRealSystemScanDoesNotThrow() {
    const result = await scanThemes();
    assert(result.gtk.some(t => t.name === 'Adwaita'), 'Adwaita is always offered');
    assert(result.gtk.every(t => !t.name.endsWith('.tar.xz')), 'archives are ignored');
}

export async function testLocateTheme() {
    assert(await locateTheme('gtk', 'Adwaita') !== null, 'Adwaita GTK theme');
    assertEqual(await locateTheme('shell', ''), '', 'default shell theme needs no files');
    assert(await locateTheme('icons', 'Adwaita'), 'Adwaita icons');
    assert(await locateTheme('cursors', 'Adwaita'), 'Adwaita cursors');
    for (const kind of ['gtk', 'shell', 'icons', 'cursors'])
        assertEqual(await locateTheme(kind, 'No-Such-Theme-42'), null, kind);
}
