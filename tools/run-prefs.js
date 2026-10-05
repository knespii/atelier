// Open the extension's preferences without the Extensions app.
//
//   make prefs                    interactive window, settings kept in memory
//   make prefs-screenshots        render the pages to tests/output/prefs
//
// Options: --sample (add sample profiles), --screenshots DIR (render the pages),
// --selftest (drive the main flows and report PASS/FAIL). Both quit afterwards.
// Needs GI_TYPELIB_PATH/LD_LIBRARY_PATH pointing at /usr/lib/gnome-shell,
// which the Makefile sets, because the Extensions app code imports Shew.

import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

for (const name of ['org.gnome.Shell.Extensions.src', 'gnome-shell-dbus-interfaces'])
    Gio.Resource.load(`/usr/share/gnome-shell/${name}.gresource`)._register();

const {ExtensionPrefsDialog} = await import(
    'resource:///org/gnome/Shell/Extensions/js/extensionPrefsDialog.js');

const args = System.programArgs;
const screenshotDir = args.includes('--screenshots') ? args[args.indexOf('--screenshots') + 1] : null;
const selftest = args.includes('--selftest');
let failures = 0;

const dir = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
const [, metadataBytes] = dir.get_child('metadata.json').load_contents(null);
const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));

function extensionSettings() {
    const source = Gio.SettingsSchemaSource.new_from_directory(
        dir.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
    return new Gio.Settings({settings_schema: source.lookup(metadata['settings-schema'], true)});
}

function seedSampleProfiles() {
    const bg = '/usr/share/backgrounds/gnome';
    const profiles = [
        {id: 'amber', name: 'Amber', wallpaper: `${bg}/amber-d.jxl`, colorScheme: 'prefer-dark', accentColor: 'orange', iconTheme: 'Adwaita'},
        {id: 'glass', name: 'Glass Chip', wallpaper: `${bg}/glass-chip-l.jxl`, colorScheme: 'default', accentColor: 'auto', gtkTheme: 'Adwaita', shellTheme: '', font: 'Cantarell 11'},
        {id: 'desert', name: 'Desert', wallpaper: `${bg}/fold-d.jxl`, gtkTheme: 'Desert-Green-1.3', shellTheme: 'Desert-Green-1.3', cursorTheme: 'Bibata-Modern-Classic'},
    ];
    const settings = extensionSettings();
    settings.set_string('profiles', JSON.stringify(profiles));
    settings.set_string('active-profile', 'amber');
}

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

function findDescendant(widget, predicate) {
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        if (predicate(child))
            return child;
        const found = findDescendant(child, predicate);
        if (found)
            return found;
    }
    return null;
}

function render(window, name) {
    const snapshot = new Gtk.Snapshot();
    new Gtk.WidgetPaintable({widget: window}).snapshot(snapshot, window.get_width(), window.get_height());
    const texture = window.get_renderer().render_texture(snapshot.to_node(), null);
    texture.save_to_png(GLib.build_filenamev([screenshotDir, `${name}.png`]));
    print(`saved ${name}.png`);
}

function check(condition, message) {
    print(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
    if (!condition)
        failures++;
}

async function runSelftest(window) {
    window.visible_page_name = 'profiles';
    const page = window.visible_page;
    const store = page._store;
    const before = store.getAll().length;

    await page._saveCurrent();
    await sleep(500);
    const editor = window.visible_dialog;
    check(editor?._look === null, 'Save Current Setup opens an editor for a new profile');
    await editor._save();
    await sleep(300);
    const profiles = store.getAll();
    check(profiles.length === before + 1, 'saving the editor adds the profile');
    const added = profiles.at(-1);
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    check(added.gtkTheme === iface.get_string('gtk-theme') && added.font === iface.get_string('font-name'),
        `current themes captured (${added.gtkTheme}, ${added.font})`);
    check(added.wallpaper === null || added.wallpaper.includes('/atelier/wallpapers/') ||
        added.wallpaper.endsWith('.xml'), `wallpaper imported or referenced (${added.wallpaper})`);
    check(window.visible_dialog === null, 'editor closed after saving');

    await page._edit(added);
    await sleep(300);
    const second = window.visible_dialog;
    second._nameRow.text = 'Renamed';
    second._schemeToggles.active_name = 'prefer-dark';
    second._fontRow.enable_expansion = false;
    await second._save();
    await sleep(300);
    const renamed = store.get(added.id);
    check(renamed.name === 'Renamed' && renamed.colorScheme === 'prefer-dark' && renamed.font === null,
        'editing updates name, style and font');

    page._duplicate(renamed);
    const copy = store.getAll().at(-1);
    check(copy.id !== renamed.id && copy.wallpaper === renamed.wallpaper && copy.name === 'Renamed (copy)',
        'duplicate shares the wallpaper');

    store.move(copy.id, -1);
    check(store.getAll().at(-2).id === copy.id, 'move up');
    check(page._rows.length === store.getAll().length, 'list shows every profile');
}

async function takeScreenshots(window) {
    await sleep(2000);
    render(window, 'profiles');

    window.visible_page_name = 'settings';
    await sleep(1000);
    render(window, 'settings');

    window.visible_page_name = 'profiles';
    const page = window.visible_page;
    const [, second] = page._store.getAll();
    await page._edit(second);
    await sleep(2000);
    render(window, 'editor-top');

    const scrolled = findDescendant(window.visible_dialog, w => w instanceof Gtk.ScrolledWindow);
    if (scrolled) {
        scrolled.vadjustment.value = scrolled.vadjustment.upper;
        await sleep(500);
        render(window, 'editor-bottom');
    }
    window.visible_dialog?.close();
    await sleep(300);
}

async function automate(window, app) {
    try {
        if (screenshotDir)
            await takeScreenshots(window);
        if (selftest)
            await runSelftest(window);
    } catch (e) {
        failures++;
        logError(e, 'automation failed');
    } finally {
        app.quit();
    }
}

if (args.includes('--sample'))
    seedSampleProfiles();

Adw.init();
const app = new Adw.Application({
    application_id: 'org.gnome.Shell.Extensions.AtelierDev',
    flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
    const window = new ExtensionPrefsDialog({
        uuid: metadata.uuid,
        dir,
        path: dir.get_path(),
        metadata,
    });
    window.application = app;
    if (screenshotDir || selftest)
        window.connect('loaded', () => automate(window, app));
    window.present();
});
// After the top-level await above, run() would block inside a promise job and
// starve every promise; runAsync() keeps them flowing.
await app.runAsync([]);
if (failures > 0)
    System.exit(1);
