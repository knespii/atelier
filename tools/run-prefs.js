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
    return settings;
}

function seedNotifications(settings) {
    // Apps GNOME has seen sending notifications, and one muted for an hour.
    new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'}).set_strv('application-children',
        ['org-gnome-nautilus', 'org-gnome-texteditor', 'com-anthropic-claude', 'chrome-hnpfjngllnobngcgfapefoaidbinmjnm-default']);
    const until = Math.floor(GLib.get_real_time() / 1000000) + 3600;
    settings.get_child('notifications').set_string('muted', JSON.stringify({'org-gnome-texteditor': until}));
}

async function seedPalette(settings) {
    // Normally written by the shell; the preferences only show it.
    const {paletteForWallpaper} = await import('../lib/wallpaperPalette.js');
    const palette = await paletteForWallpaper('/usr/share/backgrounds/gnome/amber-d.jxl', {});
    settings.get_child('palette').set_string('current', JSON.stringify(palette));
}

/** Show a section of the sidebar and return its page. */
async function section(window, id) {
    window.atelierView.showSection(id);
    await sleep(400);
    return window.atelierView._pages.get(id);
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

async function render(window, name) {
    // The window may be between frames without a renderer for a moment.
    for (let i = 0; i < 20 && !window.get_renderer(); i++)
        await sleep(100);
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
    const page = await section(window, 'profiles');
    const store = page._store;
    const before = store.getAll().length;

    await page._saveCurrent();
    await sleep(500);
    const editor = window.visible_dialog;
    check(editor?._profile === null, 'Save Current Setup opens an editor for a new profile');
    await editor._save();
    await sleep(300);
    const profiles = store.getAll();
    check(profiles.length === before + 1, 'saving the editor adds the profile');
    const added = profiles.at(-1);
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    check(added.gtkTheme === iface.get_string('gtk-theme') && added.font === iface.get_string('font-name'),
        `current themes captured (${added.gtkTheme}, ${added.font})`);
    check(added.palette?.variant === store.settings.get_child('palette').get_string('variant'),
        'and the palette options');
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

    // Sidebar search narrows the sections.
    const view = window.atelierView;
    view._search.text = 'terminal';
    await sleep(300);
    check(view._list.get_selected_row()?.section.id === 'appearance', 'search finds the Appearance section');
    view._search.text = '';
    await sleep(200);

    // Appearance: switching the palette source updates the settings.
    const appearance = await section(window, 'appearance');
    appearance._sourceToggles.active_name = 'preset';
    check(appearance._palette.get_string('source') === 'preset' && appearance._presetRow.visible,
        'palette source switches to fixed palettes');
    appearance._presetButtons.get('sea').active = true;
    check(appearance._palette.get_string('preset') === 'sea', 'a fixed palette can be picked');
    appearance._sourceToggles.active_name = 'wallpaper';
    appearance._variants.setSelected('muted');
    check(appearance._palette.get_string('variant') === 'muted', 'variant cards set the variant');
    appearance._palette.reset('variant');

    // Island: the switches write the island's settings; turning it off
    // disables its options.
    const island = await section(window, 'island');
    const islandSettings = island._island;
    const dateRow = findDescendant(island, w => w instanceof Adw.SwitchRow && w.title === 'Show the date');
    dateRow.active = true;
    check(islandSettings.get_boolean('show-date'), 'Show the date writes the island setting');
    island._enabled.active = false;
    check(!islandSettings.get_boolean('enabled') && !dateRow.sensitive, 'turning the island off greys out its options');
    island._enabled.active = true;
    islandSettings.reset('show-date');

    // Notifications: buttons per app and muted apps.
    const notifications = await section(window, 'notifications');
    const rules = notifications._settings;
    const filesRow = notifications._appRows.find(row => row.appId === 'org-gnome-nautilus');
    check(filesRow?.selected === 0, 'apps start with their own buttons');
    filesRow.selected = 1;
    check(JSON.parse(rules.get_string('app-buttons'))['org-gnome-nautilus'] === 'none',
        'choosing None for an app is saved');
    const whatsappRow = notifications._appRows.find(row => row.appId === 'chrome-hnpfjngllnobngcgfapefoaidbinmjnm-default');
    check(whatsappRow?.selected === 2, 'WhatsApp has Reply and Mute');
    check(notifications._mutedRows.some(row => row.appId === 'org-gnome-texteditor'), 'muted apps are listed');
    const unmute = findDescendant(notifications._mutedRows[0], w => w instanceof Gtk.Button && w.label === 'Unmute');
    unmute.emit('clicked');
    await sleep(200);
    check(!rules.get_string('muted').includes('texteditor') && notifications._mutedRows[0].appId === undefined,
        'Unmute lifts the mute');
    rules.reset('app-buttons');

    // Top bar and control centre.
    const bar = await section(window, 'top-bar');
    const barSettings = store.settings.get_child('bar');
    bar._style.selected = 2;
    bar._surface.selected = 1;
    bar._shape.selected = 1;
    check(barSettings.get_string('style') === 'grouped' && barSettings.get_string('surface') === 'glass' &&
        barSettings.get_string('island-shape') === 'notch', 'bar style, glass and notch are saved');
    ['style', 'surface', 'island-shape'].forEach(key => barSettings.reset(key));
    await sleep(100);
    check(bar._style.selected === 1, 'and the rows follow the settings');
    check(bar._claude.active && !bar._weather.active, 'the Claude module is on, the weather off');
    bar._weather.active = true;
    bar._claude.active = false;
    check(JSON.stringify(barSettings.get_strv('modules')) === '["weather"]', 'modules are switched on and off');
    barSettings.reset('modules');
    bar._controlCentre.active = false;
    check(!store.settings.get_child('control-centre').get_boolean('enabled') && !bar._extensions.sensitive,
        'without the control centre, its options are greyed out');
    bar._controlCentre.active = true;
}

async function takeScreenshots(window) {
    await sleep(2000);
    for (const id of ['island', 'notifications', 'top-bar', 'profiles', 'wallpapers', 'appearance', 'system']) {
        await section(window, id);
        await sleep(id === 'appearance' ? 1200 : 600);
        await render(window, id);
    }

    const page = await section(window, 'profiles');
    const [, second] = page._store.getAll();
    await page._edit(second);
    await sleep(2000);
    await render(window, 'editor-top');

    const scrolled = findDescendant(window.visible_dialog, w => w instanceof Gtk.ScrolledWindow);
    if (scrolled) {
        scrolled.vadjustment.value = scrolled.vadjustment.upper;
        await sleep(500);
        await render(window, 'editor-bottom');
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

if (args.includes('--sample')) {
    const settings = seedSampleProfiles();
    seedNotifications(settings);
    await seedPalette(settings);
}

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
