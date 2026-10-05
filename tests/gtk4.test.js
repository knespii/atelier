import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {hasGtk4Support, linkGtk4Theme, linkedGtk4Theme, unlinkGtk4Theme} from '../lib/gtk4.js';
import {assert, assertEqual, freshDir, writeFile} from './util.js';

const fn = (...parts) => GLib.build_filenamev(parts);

function setup() {
    const root = freshDir('gtk4');
    const theme = fn(root, 'themes', 'Modern');
    writeFile(fn(theme, 'gtk-4.0', 'gtk.css'), '/* light */');
    writeFile(fn(theme, 'gtk-4.0', 'gtk-dark.css'), '/* dark */');
    writeFile(fn(theme, 'gtk-4.0', 'assets', 'check.svg'), '<svg/>');
    const lightOnly = fn(root, 'themes', 'LightOnly');
    writeFile(fn(lightOnly, 'gtk-4.0', 'gtk.css'), '/* light only */');
    const gtk3Only = fn(root, 'themes', 'Old');
    writeFile(fn(gtk3Only, 'gtk-3.0', 'gtk.css'), '');

    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.atelier'});
    settings.reset('gtk4-link');
    return {config: fn(root, 'config', 'gtk-4.0'), theme, lightOnly, gtk3Only, settings};
}

const target = path => Gio.File.new_for_path(path)
    .query_info('standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
    .get_symlink_target();

export async function testLinkAndUnlink() {
    const {config, theme, settings} = setup();
    assert(hasGtk4Support(theme));

    let result = await linkGtk4Theme(settings, theme, true, config);
    assertEqual(result, {ok: true, changed: true});
    assertEqual(target(fn(config, 'gtk.css')), fn(theme, 'gtk-4.0', 'gtk-dark.css'), 'dark variant');
    assertEqual(target(fn(config, 'assets')), fn(theme, 'gtk-4.0', 'assets'));
    assertEqual(linkedGtk4Theme(settings), theme);

    result = await linkGtk4Theme(settings, theme, true, config);
    assertEqual(result, {ok: true, changed: false}, 'relinking the same theme is a no-op');

    result = await linkGtk4Theme(settings, theme, false, config);
    assertEqual(result.changed, true);
    assertEqual(target(fn(config, 'gtk.css')), fn(theme, 'gtk-4.0', 'gtk.css'), 'light variant');

    assertEqual(await unlinkGtk4Theme(settings, config), true);
    assert(!GLib.file_test(fn(config, 'gtk.css'), GLib.FileTest.EXISTS), 'gtk.css removed');
    assert(!GLib.file_test(fn(config, 'assets'), GLib.FileTest.EXISTS), 'assets removed');
    assertEqual(linkedGtk4Theme(settings), null);
    assertEqual(await unlinkGtk4Theme(settings, config), false, 'nothing left to remove');
}

export async function testDarkFallsBackToLight() {
    const {config, lightOnly, settings} = setup();
    await linkGtk4Theme(settings, lightOnly, true, config);
    assertEqual(target(fn(config, 'gtk.css')), fn(lightOnly, 'gtk-4.0', 'gtk.css'));
    assert(!GLib.file_test(fn(config, 'assets'), GLib.FileTest.EXISTS), 'no assets link');
}

export async function testRefusesToTouchUserFiles() {
    const {config, theme, gtk3Only, settings} = setup();
    writeFile(fn(config, 'gtk.css'), '/* my own tweaks */');

    const result = await linkGtk4Theme(settings, theme, false, config);
    assertEqual(result.ok, false);
    const [contents] = GLib.file_get_contents(fn(config, 'gtk.css')).slice(1);
    assertEqual(new TextDecoder().decode(contents), '/* my own tweaks */', 'user file untouched');

    assertEqual((await linkGtk4Theme(settings, gtk3Only, false, config)).ok, false, 'GTK 3 only theme');
    assert(!hasGtk4Support(gtk3Only));

    // A file the user put back after we linked must survive unlinking.
    settings.set_string('gtk4-link', JSON.stringify({theme, links: {'gtk.css': fn(theme, 'gtk-4.0', 'gtk.css')}}));
    await unlinkGtk4Theme(settings, config);
    assert(GLib.file_test(fn(config, 'gtk.css'), GLib.FileTest.EXISTS), 'regular file kept');
}

export async function testLeavesForeignLinksAlone() {
    const {config, theme, lightOnly, settings} = setup();
    await linkGtk4Theme(settings, theme, false, config);

    // A theme installer replaces our link with its own (ln -sf).
    const link = Gio.File.new_for_path(fn(config, 'gtk.css'));
    link.delete(null);
    link.make_symbolic_link(fn(lightOnly, 'gtk-4.0', 'gtk.css'), null);

    const result = await linkGtk4Theme(settings, theme, true, config);
    assertEqual(result.ok, false, 'a link pointing elsewhere is not ours');
    await unlinkGtk4Theme(settings, config);
    assertEqual(target(fn(config, 'gtk.css')), fn(lightOnly, 'gtk-4.0', 'gtk.css'), 'foreign link kept');
    assert(!GLib.file_test(fn(config, 'assets'), GLib.FileTest.EXISTS), 'our assets link removed');
}
