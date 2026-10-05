import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    MARKER, gtk3Stylesheet, gtk4Stylesheet, hasGtk4Support, legacyLinks, removeLegacyAssetsLink,
    themeStylesheet, writeStylesheet,
} from '../lib/gtkCss.js';
import {buildPalette} from '../lib/palette.js';
import {assert, assertEqual, freshDir, writeFile} from './util.js';

const fn = (...parts) => GLib.build_filenamev(parts);
const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);
const read = path => new TextDecoder().decode(GLib.file_get_contents(path)[1]);
const target = path => Gio.File.new_for_path(path)
    .query_info('standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
    .get_symlink_target();

function themes() {
    const root = freshDir('gtkcss');
    const modern = fn(root, 'themes', 'Modern');
    writeFile(fn(modern, 'gtk-4.0', 'gtk.css'), '/* light */');
    writeFile(fn(modern, 'gtk-4.0', 'gtk-dark.css'), '/* dark */');
    const lightOnly = fn(root, 'themes', 'LightOnly');
    writeFile(fn(lightOnly, 'gtk-4.0', 'gtk.css'), '/* light only */');
    const old = fn(root, 'themes', 'Old');
    writeFile(fn(old, 'gtk-3.0', 'gtk.css'), '');
    return {root, modern, lightOnly, old, config: fn(root, 'config')};
}

export function testThemeStylesheet() {
    const {modern, lightOnly, old} = themes();
    assertEqual(themeStylesheet(modern, true), fn(modern, 'gtk-4.0', 'gtk-dark.css'));
    assertEqual(themeStylesheet(modern, false), fn(modern, 'gtk-4.0', 'gtk.css'));
    assertEqual(themeStylesheet(lightOnly, true), fn(lightOnly, 'gtk-4.0', 'gtk.css'), 'dark falls back');
    assertEqual(themeStylesheet(old, false), null);
    assertEqual(themeStylesheet('', false), null);
    assert(hasGtk4Support(modern) && !hasGtk4Support(old));
}

export function testGtk4Stylesheet() {
    assertEqual(gtk4Stylesheet({}), null, 'nothing to write');

    const {modern} = themes();
    const css = fn(modern, 'gtk-4.0', 'gtk-dark.css');
    const withTheme = gtk4Stylesheet({themeCss: css});
    assert(withTheme.startsWith(MARKER), 'marked as ours');
    assert(withTheme.includes(`@import url("${GLib.filename_to_uri(css, null)}");`), 'imports the theme');
    assert(!withTheme.includes(':root'), 'no colors without a palette');

    const palette = buildPalette({source: '#2f8fb0'});
    const colored = gtk4Stylesheet({palette});
    assert(colored.includes(`--accent-bg-color: ${palette.light.primary};`), 'accent from the palette');
    assert(colored.includes(`--window-bg-color: mix(@window_bg_color, ${palette.light.primary}, 0.1);`),
        'surfaces tinted, so light and dark both keep working');

    const mono = gtk4Stylesheet({palette: buildPalette({source: '#2f8fb0', variant: 'monochrome'})});
    assert(!mono.includes('mix('), 'monochrome doesn\'t tint');
}

export function testGtk3Stylesheet() {
    assertEqual(gtk3Stylesheet({}), null);
    const palette = buildPalette({source: '#c8892b'});
    const css = gtk3Stylesheet({palette});
    assert(css.startsWith(MARKER));
    assert(css.includes(`@define-color theme_selected_bg_color ${palette.light.primary};`));
}

export async function testWriteOwnFiles() {
    const {config} = themes();
    const path = fn(config, 'gtk-4.0', 'gtk.css');
    const css = `${MARKER} test */\n:root {}\n`;

    assertEqual(await writeStylesheet(path, null), {ok: true, changed: false}, 'nothing to remove');
    assertEqual(await writeStylesheet(path, css), {ok: true, changed: true}, 'created');
    assertEqual(read(path), css);
    assertEqual(await writeStylesheet(path, css), {ok: true, changed: false}, 'unchanged');
    assertEqual(await writeStylesheet(path, `${css}/* more */\n`), {ok: true, changed: true}, 'replaced');
    assertEqual(await writeStylesheet(path, null), {ok: true, changed: true}, 'removed');
    assert(!exists(path));
}

export async function testLeavesForeignFilesAlone() {
    const {config, modern} = themes();
    const path = fn(config, 'gtk-4.0', 'gtk.css');
    writeFile(path, '/* my own tweaks */');
    const result = await writeStylesheet(path, `${MARKER} x */\n`);
    assertEqual(result.ok, false);
    assertEqual(read(path), '/* my own tweaks */', 'user file untouched');
    assertEqual((await writeStylesheet(path, null)).ok, false, 'and never deleted');

    const linkPath = fn(config, 'gtk-4.0-links', 'gtk.css');
    GLib.mkdir_with_parents(GLib.path_get_dirname(linkPath), 0o755);
    Gio.File.new_for_path(linkPath).make_symbolic_link(fn(modern, 'gtk-4.0', 'gtk.css'), null);
    assertEqual((await writeStylesheet(linkPath, `${MARKER} x */\n`)).ok, false, 'foreign link kept');
    assertEqual(target(linkPath), fn(modern, 'gtk-4.0', 'gtk.css'));
}

export async function testReplacesBgChangerLinks() {
    const {config, modern} = themes();
    const dir = fn(config, 'gtk-4.0');
    GLib.mkdir_with_parents(dir, 0o755);
    const css = fn(modern, 'gtk-4.0', 'gtk-dark.css');
    const assets = fn(modern, 'gtk-4.0', 'assets');
    Gio.File.new_for_path(fn(dir, 'gtk.css')).make_symbolic_link(css, null);
    Gio.File.new_for_path(fn(dir, 'assets')).make_symbolic_link(assets, null);

    const generated = gtk4Stylesheet({themeCss: css});
    assertEqual(await writeStylesheet(fn(dir, 'gtk.css'), generated, {legacyTarget: css}),
        {ok: true, changed: true});
    assertEqual(read(fn(dir, 'gtk.css')), generated, 'link replaced by a generated file');
    assertEqual(await removeLegacyAssetsLink(dir, '/somewhere/else'), false, 'other links stay');
    assertEqual(await removeLegacyAssetsLink(dir, assets), true);
    assert(!exists(fn(dir, 'assets')));
}

export function testLegacyLinks() {
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.atelier'});
    settings.set_string('gtk4-link', JSON.stringify({theme: '/t', links: {'gtk.css': '/t/gtk.css'}}));
    assertEqual(legacyLinks(settings), {'gtk.css': '/t/gtk.css'});
    settings.set_string('gtk4-link', 'not json');
    assertEqual(legacyLinks(settings), {});
    settings.reset('gtk4-link');
    assertEqual(legacyLinks(settings), {});
}
