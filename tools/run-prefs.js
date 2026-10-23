// Open the extension's preferences without the Extensions app.
//
//   make prefs                    interactive window, settings kept in memory
//   make prefs-screenshots        render the pages to tests/output/prefs
//
// Options: --sample (add sample profiles), --screenshots DIR (render the pages),
// --selftest (drive the main flows and report PASS/FAIL). Both quit afterwards.
// Needs GI_TYPELIB_PATH/LD_LIBRARY_PATH pointing at GNOME Shell's private
// libraries (/usr/lib/gnome-shell; /usr/lib64/gnome-shell on Fedora), which
// the Makefile sets, because the Extensions app code imports Shew.

import Adw from 'gi://Adw?version=1';
import Gdk from 'gi://Gdk?version=4.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Graphene from 'gi://Graphene';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';
import {exportProfile} from '../lib/profileTransfer.js';

import * as dockAppearance from './dock-tests/appearance.js';
import * as dockBadges from './dock-tests/badges.js';
import * as dockBehaviour from './dock-tests/behaviour.js';
import * as dockCore from './dock-tests/core.js';
import * as dockHiding from './dock-tests/hiding.js';
import * as dockLaunchers from './dock-tests/launchers.js';

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
    // (Lock screens of their own, as the shell gives every profile one.)
    const glassClock = {id: 'clock', kind: 'clock', size: 'tall', x: 13, y: 2, fine: true, face: 'glass'};
    const stackedClock = {id: 'clock', kind: 'clock', size: 'large', x: 2, y: 2, fine: true, face: 'stacked'};
    const profiles = [
        {id: 'amber', name: 'Amber', wallpaper: `${bg}/amber-d.jxl`, colorScheme: 'prefer-dark', accentColor: 'orange', iconTheme: 'Adwaita',
            lockscreen: {widgets: [glassClock], gnomeClock: false, depthEffect: true}},
        {id: 'glass', name: 'Glass Chip', wallpaper: `${bg}/glass-chip-l.jxl`, colorScheme: 'default', accentColor: 'auto', gtkTheme: 'Adwaita', shellTheme: '', font: 'Cantarell 11',
            lockscreen: {widgets: [stackedClock], style: 'modern', clockFont: 'serif', gnomeClock: false}},
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
    // (Under load, the first snapshot of a page can come back empty: again.)
    let node = null;
    for (let i = 0; i < 20 && !node; i++) {
        const snapshot = new Gtk.Snapshot();
        new Gtk.WidgetPaintable({widget: window}).snapshot(snapshot, window.get_width(), window.get_height());
        node = snapshot.to_node();
        if (!node)
            await sleep(100);
    }
    const texture = window.get_renderer().render_texture(node, null);
    texture.save_to_png(GLib.build_filenamev([screenshotDir, `${name}.png`]));
    print(`saved ${name}.png`);
}

function check(condition, message) {
    print(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
    if (!condition)
        failures++;
}

// Stand-ins for Blur my Shell and Tiling Shell, installed for the user in
// the test's data dir (their folders with their settings schemas), for the
// Other Extensions section to list.
function installStandIns() {
    const standIns = [
        ['blur-my-shell@aunetx', 'Blur my Shell', 'org.gnome.shell.extensions.blur-my-shell.lockscreen',
            '/org/gnome/shell/extensions/blur-my-shell/lockscreen/', '<key type="b" name="blur"><default>true</default></key>'],
        ['tilingshell@ferrarodomenico.com', 'Tiling Shell', 'org.gnome.shell.extensions.tilingshell',
            '/org/gnome/shell/extensions/tilingshell/', '<key type="b" name="enable-snap-assist"><default>true</default></key>'],
    ];
    for (const [uuid, name, id, path, key] of standIns) {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', uuid]);
        GLib.mkdir_with_parents(`${dir}/schemas`, 0o755);
        GLib.file_set_contents(`${dir}/metadata.json`, JSON.stringify({uuid, name}));
        GLib.file_set_contents(`${dir}/schemas/${id}.gschema.xml`,
            `<schemalist><schema id="${id}" path="${path}">${key}</schema></schemalist>`);
        GLib.spawn_command_line_sync(`glib-compile-schemas ${dir}/schemas`);
    }
}

async function checkOtherExtensions(window) {
    const page = await section(window, 'other-extensions');
    const settings = page._settings;
    const blur = page._rows.get('blur-my-shell-lock-screen')?.row;
    check(page._rows.size === 2 && blur && !blur.active && blur.subtitle.includes('Now: on'),
        `Other Extensions lists the installed ones, each setting as it is now (${blur?.subtitle})`);
    blur.active = true;
    check(settings.get_strv('other-extensions-kept').includes('blur-my-shell-lock-screen'),
        'switched on, Atelier is asked to keep it');
    blur.active = false;
    check(!settings.get_strv('other-extensions-kept').includes('blur-my-shell-lock-screen'), 'switched off, no longer');
    findDescendant(page, w => w instanceof Gtk.Button && w.label === 'Keep the Recommended')?.emit('clicked');
    const kept = settings.get_strv('other-extensions-kept');
    check(kept.includes('blur-my-shell-lock-screen') && !kept.includes('tiling-shell-snap-assistant') && blur.active,
        `Keep the Recommended: those that break something, not the snap assistant (${kept})`);
    settings.reset('other-extensions-kept');
}

// The depth effect's rows, with stand-ins for what is there and for the
// download (nothing is downloaded here): each step says what it needs.
async function checkDepth(window) {
    const page = await section(window, 'lock-screen');
    const setup = page._depth;
    const lock = setup._settings;
    const missing = {python: true, missing: [], model: 'missing'};
    // (Its rows at the bottom of the page, for pictures of them.)
    const scrolled = findDescendant(page, w => w instanceof Gtk.ScrolledWindow);
    const toBottom = () => (scrolled.vadjustment.value = scrolled.vadjustment.upper);
    const {MODELS, modelPath} = await import('../lib/depth.js');
    const real = await setup.probe(modelPath(setup.model));
    check(real.model === 'missing', `with no model kept, it says so (${JSON.stringify(real)})`);

    // The model to use: none chosen and none there, Base is offered; each
    // says how big it is, its licence and about how long it takes.
    check(setup.model === 'base' && setup.modelRow.selected === 1 &&
        setup.modelRow.subtitle.includes('389 MB') && setup.modelRow.subtitle.includes('CC-BY-NC-4.0') &&
        setup.modelRow.subtitle.endsWith('not downloaded'),
    `Base offered first (${setup.modelRow.subtitle})`);
    setup.modelRow.selected = 0;
    check(lock.get_string('depth-model') === 'small' && setup.model === 'small', 'Small chosen in the list');
    await sleep(200);
    check(setup.modelRow.subtitle.includes('99 MB') && setup.modelRow.subtitle.includes('Apache-2.0') &&
        !setup.modelRow.subtitle.includes('non-commercial'), `Small: its size, a free licence (${setup.modelRow.subtitle})`);
    lock.set_string('depth-model', 'large');
    await sleep(200);
    check(setup.modelRow.selected === 2 && setup.modelRow.subtitle.includes('1.3 GB'),
        `the list follows the setting (${setup.modelRow.subtitle})`);
    lock.reset('depth-model');
    // (Large downloaded, none chosen: it is the one used, and ready.)
    GLib.mkdir_with_parents(GLib.path_get_dirname(modelPath('large')), 0o755);
    GLib.file_set_contents(modelPath('large'), '');
    check(setup.model === 'large', 'none chosen: the biggest one downloaded is used');
    GLib.unlink(modelPath('large'));
    check(setup.model === 'base', 'and without it, Base');
    await setup.refresh();
    const showing = async state => {
        setup.probe = () => Promise.resolve(state);
        await setup.refresh();
    };
    await showing({python: false, missing: [], model: 'missing'});
    check(setup.statusRow.title === 'Python 3 is missing' && setup.commandRow.visible &&
        setup.commandRow.title === 'sudo apt install python3', 'without Python, how to install it');
    await showing({python: true, missing: ['python3-onnxruntime', 'python3-pil'], model: 'missing'});
    check(setup.statusRow.title === 'Python packages are missing' && setup.againButton.visible &&
        setup.commandRow.title === 'sudo apt install python3-onnxruntime python3-pil' && !setup.downloadButton.visible,
    `without onnxruntime, the command to install it, to copy (${setup.commandRow.title})`);
    setup.copyButton.emit('clicked');
    const copied = await new Promise(resolve => setup.commandRow.get_clipboard().read_text_async(null, (clipboard, res) => {
        try {
            resolve(clipboard.read_text_finish(res));
        } catch {
            resolve(null);
        }
    }));
    check(copied === setup.commandRow.title, `which Copy copies (${copied})`);
    await showing(missing);
    toBottom();
    await sleep(300);
    check(setup.statusRow.title === 'The model isn\'t downloaded' && setup.downloadButton.visible &&
        setup.downloadButton.label === 'Download Model (389 MB)…' && !setup.commandRow.visible,
    'with the packages, the model to download – only when asked');
    await render(window, 'lock-screen-depth-download');

    // Downloading: its progress, then ready (and the cutout asked for).
    let finish, asked;
    setup.download = (model, target, {onProgress}) => new Promise(resolve => {
        asked = [model, target];
        onProgress(200 * 1024 * 1024, 389 * 1024 * 1024);
        finish = resolve;
    });
    lock.set_boolean('depth-effect', true);
    const request = lock.get_string('depth-request');
    setup.downloadButton.emit('clicked');
    await sleep(100);
    check(setup.statusRow.title === 'Downloading the model…' && setup.statusRow.subtitle === '200.0 of 389.0 MB' &&
        setup.cancelButton.visible && !setup.downloadButton.visible && Math.abs(setup._progress.fraction - 200 / 389) < 0.01,
    `while it downloads, how far it is (${setup.statusRow.subtitle})`);
    check(asked[0] === MODELS.base && asked[1] === modelPath('base') && !setup.modelRow.sensitive,
        'the chosen model, to where it is kept; no other chosen meanwhile');
    await render(window, 'lock-screen-depth-downloading');
    setup.probe = () => Promise.resolve({...missing, model: 'ok'});
    finish();
    await sleep(200);
    check(setup.statusRow.title === 'Ready' && setup.computeButton.visible && lock.get_string('depth-request') !== request,
        'downloaded: ready, and the shell asked for the cutout');

    // A download that fails says why.
    setup.probe = () => Promise.resolve(missing);
    setup.download = () => Promise.reject(new Error('no network here'));
    await setup.refresh();
    setup.downloadButton.emit('clicked');
    await sleep(200);
    check(setup.statusRow.title === 'The download failed' && setup.statusRow.subtitle.includes('no network here') &&
        setup.downloadButton.visible, `a failed download says why, to try again (${setup.statusRow.subtitle})`);
    await showing({...missing, model: 'does not load: INVALID_PROTOBUF'});
    check(setup.statusRow.title === 'The model doesn\'t load' && setup.downloadButton.visible,
        'a model that doesn\'t load is downloaded again');

    // Ready: how the shell is coming on with the cutout.
    await showing({...missing, model: 'ok'});
    lock.set_string('depth-status', 'working');
    check(setup.statusRow.subtitle === 'Making the cutout of this wallpaper…' && !setup.computeButton.sensitive,
        'the cutout being made');
    lock.set_string('depth-status', 'failed: the disk is full');
    check(setup.statusRow.subtitle.endsWith('the disk is full') && setup.computeButton.sensitive,
        'one that failed says why, to try again');
    lock.set_string('depth-status', 'ready');
    check(setup.statusRow.subtitle.startsWith('The cutout of this wallpaper is made'), 'and one made');
    toBottom();
    await sleep(300);
    await render(window, 'lock-screen-depth-ready');
    lock.set_boolean('depth-effect', false);
    check(!setup.computeButton.visible && !setup.switchRow.active, 'switched off, nothing to compute');
    lock.set_boolean('enabled', false);
    check(!page._depthGroup.sensitive, 'without Atelier on the lock screen, greyed out');
    ['enabled', 'depth-status', 'depth-request', 'depth-model'].forEach(key => lock.reset(key));

    // The real check, with a made-up model where the model is kept.
    const {fakeDepthModel} = await import('../tests/fakeOnnx.js');
    GLib.file_set_contents(modelPath('base'), fakeDepthModel());
    const {probe} = await import('../prefs/depthSetup.js');
    const found = await probe(modelPath('base'));
    check(found.model === 'ok' || found.missing.length > 0, `a model kept is checked: it loads (${JSON.stringify(found)})`);
    GLib.unlink(modelPath('base'));
}

async function runSelftest(window) {
    await checkOtherExtensions(window);
    await checkDepth(window);
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
    const {readLockscreen} = await import('../lib/profiles.js');
    check(JSON.stringify(added.lockscreen) === JSON.stringify(readLockscreen(store.settings.get_child('lockscreen'))),
        'with the lock screen there is now');
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
    await sleep(100);
    check(page._rows.length === store.getAll().length, 'a card for every profile');
    check(page._rows.filter(card => card.has_css_class('active')).length === (store.activeId ? 1 : 0),
        'the one in use stands out');

    // Exported to a folder and imported back.
    const count = store.getAll().length;
    const exported = await exportProfile(renamed, GLib.get_user_cache_dir());
    const imported = await page._import(exported);
    await sleep(100);
    check(imported?.name === 'Renamed' && imported.id !== renamed.id && store.getAll().length === count + 1 &&
        page._rows.some(card => card.profileId === imported.id), 'an exported profile can be imported');
    check(JSON.stringify(imported.lockscreen) === JSON.stringify(renamed.lockscreen), 'with its lock screen');
    const amberCard = page._rows.find(card => card.profileId === 'amber');
    check(amberCard && findDescendant(amberCard, w => w instanceof Gtk.Label &&
        w.label.includes('Lock screen: Glass clock, Inter, depth effect')), 'a card says its lock screen');

    // Toasts go to Atelier's own overlay (prefs.js replaces the window's
    // content, and with it the window's overlay); after the ones before it.
    const {toast} = await import('../prefs/widgets.js');
    toast(page, 'Selftest toast');
    const overlay = window.atelierView.toastOverlay;
    let shown = null;
    for (let i = 0; i < 60 && !shown; i++) {
        await sleep(250);
        shown = findDescendant(overlay, w => w instanceof Gtk.Label && w.label === 'Selftest toast');
    }
    check(shown, 'a toast shows over the settings');

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
    bar._style.setSelected('grouped');
    bar._surface.setSelected('glass');
    bar._shape.setSelected('notch');
    const sideLabels = [];
    findDescendant(bar._sides, w => {
        if (w instanceof Gtk.Label)
            sideLabels.push(w);
        return false;
    });
    check(sideLabels.length === 2 && !sideLabels.some(label => label.get_layout().is_ellipsized()),
        'the sides\' toggles are not cut short');
    bar._sides.active_name = 'capsules';
    check(barSettings.get_string('style') === 'grouped' && barSettings.get_string('surface') === 'glass' &&
        barSettings.get_string('island-shape') === 'notch' && barSettings.get_string('sides') === 'capsules',
    'bar style, glass, notch and capsules are saved');
    barSettings.set_string('style', 'island');
    check(!bar._sidesRow.sensitive && bar._compact.sensitive, 'sides only matter when grouped or spread');
    bar._compact.active = false;
    check(!barSettings.get_boolean('compact'), 'the compact bar can be turned off');
    barSettings.reset('compact');
    barSettings.set_string('style', 'spread');
    check(!bar._compact.sensitive, 'it only matters grouped or as one island');
    ['style', 'surface', 'island-shape', 'sides'].forEach(key => barSettings.reset(key));
    await sleep(100);
    check(bar._style.selectedId === 'spread' && bar._shape.selectedId === 'floating' &&
        bar._sides.active_name === 'wallpaper' && bar._sidesRow.sensitive, 'and the cards follow the settings');
    check(bar._claude.active && !bar._weather.active, 'the Claude module is on, the weather off');
    bar._weather.active = true;
    bar._claude.active = false;
    check(JSON.stringify(barSettings.get_strv('modules')) === '["weather"]', 'modules are switched on and off');
    barSettings.reset('modules');
    bar._controlCentre.active = false;
    check(!store.settings.get_child('control-centre').get_boolean('enabled') && !bar._extensions.sensitive,
        'without the control centre, its options are greyed out');
    bar._controlCentre.active = true;

    // Desktop widgets.
    const desktop = await section(window, 'desktop');
    const desktopSettings = store.settings.get_child('desktop');
    // Desktop Icons (Ubuntu's) on, it says so; off, it doesn't.
    check(!desktop._desktopIcons.visible, 'without Desktop Icons, no notice about it');
    desktop.syncDesktopIcons(1);
    const noticed = desktop._desktopIcons.visible;
    desktop.syncDesktopIcons(2);
    check(noticed && !desktop._desktopIcons.visible, 'with Desktop Icons on, a notice about it; off, none');
    desktop._style.setSelected('analogue');
    check(desktopSettings.get_string('style') === 'analogue' && !desktop._glass.sensitive,
        'the Analogue look is saved, glass is for Modern only');
    desktop._opacity.value = 40;
    check(Math.abs(desktopSettings.get_double('card-opacity') - 0.4) < 0.001, 'how see-through the cards are is saved');
    desktopSettings.reset('card-opacity');
    desktop._github.text = 'not a user!';
    check(desktopSettings.get_string('github-user') === '' && desktop._github.has_css_class('error'),
        'a GitHub name that can\'t be is refused');
    desktop._github.text = 'octocat';
    check(desktopSettings.get_string('github-user') === 'octocat' && !desktop._github.has_css_class('error'),
        'any GitHub user can be set');
    desktopSettings.set_string('photo', '/tmp/pictures');
    await sleep(50);
    check(desktop._photo.subtitle === '/tmp/pictures' && desktop._clearPhoto.visible, 'the photo shows where it is from');
    ['style', 'github-user', 'photo'].forEach(key => desktopSettings.reset(key));
    // The photos: the gallery, and the photo widgets of the profile in use.
    const photos = desktop._photos;
    check(Boolean(findDescendant(photos, w => w instanceof Adw.ButtonRow && w.title === 'Add Photos…')) &&
        Boolean(findDescendant(desktop, w => w instanceof Adw.PreferencesGroup && w.title === 'Without Photos Picked')),
    'the Desktop page has the photos: Add Photos…, and the picture for widgets without any picked');
    check(photos.tiles.length === 0 && photos._empty.visible, 'the gallery has no photos at first, and says so');
    const originals = GLib.build_filenamev([GLib.get_user_cache_dir(), 'photo-originals']);
    GLib.mkdir_with_parents(originals, 0o755);
    const pictures = ['a', 'b', 'c'].map((name, i) => {
        const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 1200, 800);
        pixbuf.fill([0xd02020ff, 0x20b040ff, 0x2040d0ff][i]);
        const path = GLib.build_filenamev([originals, `${name}.jpg`]);
        pixbuf.savev(path, 'jpeg', [], []);
        return path;
    });
    const ids = await photos.gallery.add(pictures);
    await sleep(300);
    check(photos.tiles.map(tile => tile.photoId).join() === ids.join() && !photos._empty.visible,
        `photos added show in the gallery's grid (${photos.tiles.length})`);
    check(desktop._photoWidgets._none.visible && desktop._photoWidgets.rows.length === 0,
        'without photo widgets, it says how to add one');
    desktopSettings.set_string('widgets', JSON.stringify([
        {id: 'photo', kind: 'photo', size: 'square', x: 0, y: 0, fine: true},
        {id: 'photo-2', kind: 'photo', size: 'large', x: 4, y: 0, photos: [ids[2]], interval: 30, fine: true},
    ]));
    await sleep(200);
    const widgetRows = desktop._photoWidgets.rows;
    check(widgetRows.length === 2 && widgetRows[0].subtitle.startsWith('No photos picked') &&
        widgetRows[1].subtitle === '1 photo, each for 30 s', `a row for each photo widget (${widgetRows.map(r => r.subtitle)})`);
    const chooser = desktop._photoWidgets.choose('photo');
    await sleep(500);
    check(chooser.tiles.length === 3 && chooser.tiles.every(tile => !tile.active) && chooser.intervals.active_name === '10',
        'Choose… opens the gallery to pick from, nothing picked yet');
    chooser.tiles[1].active = true;
    chooser.tiles[0].active = true;
    chooser.intervals.active_name = '5';
    await sleep(200);
    const photoEntry = id => JSON.parse(desktopSettings.get_string('widgets')).find(e => e.id === id);
    check(photoEntry('photo').photos.join() === [ids[1], ids[0]].join() && photoEntry('photo').interval === 5 &&
        chooser.tiles[1].badge.label === '1' && chooser.tiles[0].badge.label === '2',
    'picked there, the widget\'s photos (numbered in the order picked) and how long each shows are kept');
    await render(window, 'desktop-photos-chooser');
    chooser.close();
    await sleep(300);
    // (The photos on the page, for a picture of it.)
    const scrolled = findDescendant(desktop, w => w instanceof Gtk.ScrolledWindow);
    const [, top] = photos.compute_point(scrolled.get_child(), new Graphene.Point({x: 0, y: 0}));
    scrolled.vadjustment.value = top.y - 24;
    await sleep(400);
    await render(window, 'desktop-photos');
    photos.tiles.find(tile => tile.photoId === ids[1]).removeButton.emit('clicked');
    await sleep(500);
    check(photos.tiles.map(tile => tile.photoId).join() === [ids[0], ids[2]].join() &&
        !GLib.file_test(photos.gallery.path(ids[1]), GLib.FileTest.EXISTS),
    'a photo can be taken out of the gallery');
    check(photoEntry('photo').photos.join() === ids[0] && desktop._photoWidgets.rows.length === 2 &&
        desktop._photoWidgets.rows[0].subtitle === '1 photo, each for 5 s',
    'and out of the widgets\' choice');
    for (const id of photos.gallery.ids())
        await photos.gallery.remove(id, store.settings);
    desktopSettings.reset('widgets');

    // The lock screen's type: its colour (Auto, or one chosen) and font.
    const lockPage = await section(window, 'lock-screen');
    const lockSettings = store.settings.get_child('lockscreen');
    check(lockPage._colorAuto.active && lockSettings.get_string('clock-color') === 'auto' &&
        lockPage._colorButton.sensitive, 'the lock screen\'s colour is picked from the wallpaper at first');
    const orange = new Gdk.RGBA();
    orange.parse('#ff8800');
    lockPage._colorButton.rgba = orange;
    check(lockSettings.get_string('clock-color') === '#ff8800' && !lockPage._colorAuto.active,
        `a colour chosen is kept, Auto off (${lockSettings.get_string('clock-color')})`);
    lockPage._colorAuto.active = true;
    check(lockSettings.get_string('clock-color') === 'auto', 'Auto again');
    lockPage._colorAuto.active = false;
    check(lockSettings.get_string('clock-color') === '#ff8800', 'and off, the colour the button has');
    lockSettings.set_string('clock-color', 'auto');
    check(lockPage._colorAuto.active, 'set elsewhere, shown');
    const fonts = lockPage._fontCombo;
    check(fonts.model.get_n_items() === 5 && fonts.selected === 0 && lockSettings.get_string('clock-font') === 'inter' &&
        fonts.subtitle.includes('Atelier'), `the typefaces on offer, Inter at first (${fonts.subtitle})`);
    fonts.selected = 4;
    check(lockSettings.get_string('clock-font') === 'serif' && fonts.subtitle.length > 0,
        `a font chosen is kept, said as it is here (${fonts.subtitle})`);
    // Set elsewhere (a profile applied, say): shown, and nothing written
    // back – a write would land in the profile in use.
    let written = 0;
    const writes = lockSettings.connect('changed::clock-font', () => written++);
    for (const [id, index] of [['flex', 1], ['thin', 2], ['heavy', 2], ['inter', 0]]) {
        written = 0;
        lockSettings.set_string('clock-font', id);
        check(fonts.selected === index && written === 1 && lockSettings.get_string('clock-font') === id,
            `${id} set elsewhere: shown as ${fonts.model.get_string(index)}, nothing written back (${written})`);
    }
    lockSettings.disconnect(writes);

    // The clocks' weight and width: as each face has them at first, or on
    // a slider – in tens, written once it is let be; set elsewhere, shown.
    const weight = lockPage._weight;
    check(weight.automatic.active && !weight.scale.sensitive && weight.scale.get_value() === 600 &&
        lockSettings.get_int('clock-weight') === 0, `the clocks' weight as each face has it (${weight.scale.get_value()})`);
    let weights = 0;
    const weightWrites = lockSettings.connect('changed::clock-weight', () => weights++);
    weight.automatic.active = false;
    check(lockSettings.get_int('clock-weight') === 600 && weight.scale.sensitive && weights === 1,
        'Automatic off: the weight it shows, set');
    weights = 0;
    for (const value of [455, 512, 487])
        weight.scale.emit('change-value', Gtk.ScrollType.JUMP, value);
    await sleep(500);
    check(lockSettings.get_int('clock-weight') === 490 && weights === 1,
        `dragged: in tens, written once let be (${lockSettings.get_int('clock-weight')}, ${weights} writes)`);
    weights = 0;
    lockSettings.set_string('clock-font', 'flex');
    lockSettings.set_int('clock-weight', 950);
    check(weight.scale.get_value() === 950 && weight.scale.get_adjustment().get_upper() === 1000 && weights === 1,
        `on Roboto Flex's weight axis, to 1000; set elsewhere, shown, nothing written back (${weights})`);
    lockSettings.set_int('clock-weight', 0);
    lockSettings.set_string('clock-font', 'thin');
    check(weight.automatic.active && weight.scale.get_value() === 200, `Thin: its own weight (${weight.scale.get_value()})`);
    lockSettings.disconnect(weightWrites);
    const width = lockPage._width;
    check(width.automatic.active && width.scale.get_value() === 90 && width.row.subtitle.startsWith('As each'),
        'the width as each face has it: the glass clock a little narrower');
    lockSettings.set_int('clock-width', 120);
    check(!width.automatic.active && width.scale.get_value() === 120 && width.row.subtitle.includes('width axis'),
        `a width set, shown (${width.row.subtitle})`);
    width.automatic.active = true;
    check(lockSettings.get_int('clock-width') === 0, 'Automatic again');

    // Colours from the wallpaper, each checked where the clocks are.
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    for (const key of ['picture-uri', 'picture-uri-dark'])
        background.set_string(key, 'file:///usr/share/backgrounds/gnome/amber-d.jxl');
    const sampled = () => lockPage._sampled?.endsWith('amber-d.jxl') && lockPage._swatches.length > 0;
    for (let i = 0; i < 60 && !sampled(); i++)
        await sleep(100);
    const swatches = lockPage._swatches;
    check(swatches.length > 0 && swatches.every(swatch => /^#[0-9a-f]{6}$/.test(swatch.color) && swatch.button.tooltip_text),
        `colours from the wallpaper (${swatches.map(swatch => `${swatch.color}${swatch.reaches ? '' : ' (faint)'}`)})`);
    swatches[0].button.active = true;
    check(lockSettings.get_string('clock-color') === swatches[0].color && !lockPage._colorAuto.active,
        'one picked: the colour of the clocks, Auto off');
    lockSettings.set_string('clock-color', 'auto');
    check(swatches.every(swatch => !swatch.button.active) && lockPage._colorAuto.active, 'Auto again: none picked');
    lockSettings.set_string('clock-color', swatches.at(-1).color);
    check(swatches.at(-1).button.active && swatches.filter(swatch => swatch.button.active).length === 1,
        'set elsewhere, shown');
    lockSettings.set_int('clock-weight', 300);
    // (The Type group in sight.)
    const lockScroll = findDescendant(lockPage, w => w instanceof Gtk.ScrolledWindow);
    lockScroll.get_child().scroll_to(lockPage._swatchRowWidget, null);
    await sleep(400);
    await render(window, 'lock-screen-type');
    lockScroll.vadjustment.value = 0;
    for (const key of ['clock-color', 'clock-font', 'clock-weight', 'clock-width'])
        lockSettings.reset(key);
    for (const key of ['picture-uri', 'picture-uri-dark'])
        background.reset(key);

    const notesSettings = store.settings.get_child('notes');
    desktop._notes.active = false;
    check(!notesSettings.get_boolean('enabled') && !desktop._edgesOnDesktop.sensitive,
        'notes can be turned off, and their options grey out');
    notesSettings.reset('enabled');

    // The dock (tools/dock-tests). t: {window, page (the dock's page: its
    // rows by key in page.rows), settings (the dock's), check, sleep,
    // section, findDescendant, Adw, Gtk, Gio, GLib}.
    const dockPage = await section(window, 'dock');
    const t = {
        window, page: dockPage, settings: store.settings.get_child('dock'), check, sleep, section,
        findDescendant, Adw, Gtk, Gio, GLib,
    };
    for (const suite of [dockCore, dockHiding, dockBehaviour, dockBadges, dockLaunchers, dockAppearance])
        await suite.prefs(t);
}

async function takeScreenshots(window) {
    await sleep(2000);
    for (const id of ['island', 'notifications', 'top-bar', 'lock-screen', 'desktop', 'dock', 'profiles', 'wallpapers', 'appearance', 'other-extensions', 'system']) {
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
        installStandIns();
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
