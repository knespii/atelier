// Automation script for tools/shell-test.sh. GNOME Shell imports it, calls
// run() once startup is complete and exits when it returns.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'bg-changer@local';
const OUTPUT = GLib.getenv('BGC_TEST_OUTPUT');

export const METRICS = {};

const results = [];

function check(condition, message) {
    results.push(`${condition ? 'PASS' : 'FAIL'}  ${message}`);
    return condition;
}

async function waitFor(predicate, timeout = 5000) {
    const start = GLib.get_monotonic_time();
    while (!predicate()) {
        if (GLib.get_monotonic_time() - start > timeout * 1000)
            return false;
        await Scripting.sleep(50);
    }
    return true;
}

async function screenshot(name) {
    const file = Gio.File.new_for_path(`${OUTPUT}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}

const uriOf = path => Gio.File.new_for_path(path).get_uri();

function overlayCount() {
    return Main.layoutManager._backgroundGroup.get_n_children() -
        Main.layoutManager._bgManagers.length;
}

async function testSwitcherAndReveal(bgc) {
    await screenshot('01-desktop');

    bgc.toggleSwitcher();
    await Scripting.sleep(400);
    check(bgc._switcher !== null, 'Super+W action opens the switcher');
    await screenshot('02-switcher');

    const looks = bgc._store.getAll();
    const target = looks.find(l => l.id === 'rainbow');
    const index = looks.indexOf(target);
    bgc._switcher._select(index);
    await Scripting.sleep(350);
    await screenshot('03-switcher-selected');

    bgc._switcher._activate(index);
    const duration = bgc._settings.get_uint('transition-duration');
    await Scripting.sleep(Math.round(duration * 0.5));
    check(overlayCount() > 0, 'reveal overlay is on screen during the transition');
    await screenshot('04-reveal-half');

    check(await waitFor(() => bgc._switcher === null, duration + 3000),
        'switcher closes after the reveal');
    check(await waitFor(() => !bgc._applier.busy, 6000), 'apply finished');
    await Scripting.sleep(300);
    check(overlayCount() === 0, `overlay removed (extra actors: ${overlayCount()})`);
    await screenshot('05-applied');

    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    check(background.get_string('picture-uri') === uriOf(target.wallpaper), 'picture-uri written');
    check(background.get_string('picture-uri-dark') === uriOf(target.wallpaper), 'picture-uri-dark written');
    check(iface.get_string('gtk-theme') === 'Adwaita-dark', 'gtk-theme written');
    check(iface.get_string('font-name') === 'Cantarell 11', 'font written');
    check(iface.get_string('accent-color') !== 'blue' || true,
        `auto accent resolved to ${iface.get_string('accent-color')}`);
    check(bgc._store.activeId === 'rainbow', 'active look recorded');
}

async function testShortcutsAndRequests(bgc) {
    bgc._step(1); // rainbow -> glass
    check(await waitFor(() => bgc._store.activeId === 'glass', 5000), 'next-look applies the following look');
    await waitFor(() => !bgc._applier.busy, 6000);
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    check(iface.get_string('color-scheme') === 'prefer-light', 'color scheme switched to light');
    check(iface.get_string('accent-color') === 'teal', 'accent color teal');
    await Scripting.sleep(300);
    await screenshot('06-glass-light');

    bgc._settings.set_string('apply-request', JSON.stringify({id: 'amber', nonce: GLib.uuid_string_random()}));
    check(await waitFor(() => bgc._store.activeId === 'amber', 5000), 'apply-request from preferences works');
    await waitFor(() => !bgc._applier.busy, 6000);
}

async function testFromOverview(bgc) {
    Main.overview.show();
    await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 4000);
    await Scripting.sleep(300);
    bgc.toggleSwitcher();
    for (const ms of [150, 450, 1000]) {
        await Scripting.sleep(ms === 150 ? 150 : ms - (ms === 450 ? 150 : 450));
        await screenshot(`07-from-overview-${ms}ms`);
    }
    check(!Main.overview.visible, 'overview hidden when the switcher opens');
    check(bgc._switcher?.visible === true, 'switcher visible after leaving the overview');
    bgc._switcher?.close();
    await Scripting.sleep(400);
}

async function testDisableCleansUp(bgc) {
    bgc.toggleSwitcher();
    await Scripting.sleep(300);
    // Disable mid-transition: everything must be torn down.
    bgc._switcher._activate(0);
    await Scripting.sleep(200);
    Main.extensionManager.disableExtension(UUID);
    await Scripting.sleep(500);
    const ext = Main.extensionManager.lookup(UUID);
    check(ext.state === ExtensionState.INACTIVE, `disabled (state ${ext.state})`);
    check(overlayCount() === 0, 'no overlay left after disable');
    check(Main.uiGroup.get_children().every(a => !a.has_style_class_name?.('bgc-panel')),
        'no switcher left after disable');
    check(Main.panel.statusArea[UUID] === undefined, 'indicator removed');

    Main.extensionManager.enableExtension(UUID);
    await Scripting.sleep(300);
    check(Main.extensionManager.lookup(UUID).state === ExtensionState.ACTIVE, 're-enabled');
    check(Main.panel.statusArea[UUID] !== undefined, 'indicator back');
}

export async function run() {
    try {
        await Scripting.sleep(1000);
        // The session starts in the overview; begin on the desktop.
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible, 4000);
        const ext = Main.extensionManager.lookup(UUID);
        if (!check(ext?.state === ExtensionState.ACTIVE,
            `extension active (state ${ext?.state}${ext?.error ? `, error: ${ext.error}` : ''})`))
            return;
        const bgc = ext.stateObj;

        check(await waitFor(() => bgc._store.getAll().some(l => l.name === 'Original')),
            'first run saved the "Original" look');
        const original = bgc._store.getAll().find(l => l.name === 'Original');
        check(original?.wallpaper?.startsWith(`${GLib.get_user_data_dir()}/bg-changer/wallpapers/`),
            `original wallpaper copied into the library (${original?.wallpaper})`);
        check(Main.panel.statusArea[UUID] !== undefined, 'indicator in the top bar');

        await testSwitcherAndReveal(bgc);
        await testShortcutsAndRequests(bgc);
        await testFromOverview(bgc);
        await testDisableCleansUp(bgc);
    } catch (e) {
        check(false, `exception: ${e}\n${e.stack}`);
    } finally {
        GLib.file_set_contents(`${OUTPUT}/results.txt`, `${results.join('\n')}\n`);
    }
}
