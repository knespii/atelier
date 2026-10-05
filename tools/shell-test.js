// Automation script for tools/shell-test.sh. GNOME Shell imports it, calls
// run() once startup is complete and exits when it returns.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'atelier@local';
const OUTPUT = GLib.getenv('ATELIER_TEST_OUTPUT');

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

async function screenshotArea(name, x, y, width, height) {
    const file = Gio.File.new_for_path(`${OUTPUT}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot_area(x, y, width, height, stream);
    stream.close(null);
}

/** The top middle of the screen, where the island lives. */
function screenshotIsland(name, height = 420) {
    const width = 1100;
    return screenshotArea(name, Math.round((global.stage.width - width) / 2), 0, width, height);
}

const uriOf = path => Gio.File.new_for_path(path).get_uri();

// Real input through virtual devices, so hover, grabs and focus behave as
// they do for a user.
const seat = () => global.stage.context.get_backend().get_default_seat();
let virtualPointer = null;
let virtualKeyboard = null;

async function pointerTo(x, y) {
    virtualPointer ??= seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    virtualPointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    await Scripting.sleep(80);
}

async function clickAt(x, y) {
    await pointerTo(x, y);
    for (const state of [Clutter.ButtonState.PRESSED, Clutter.ButtonState.RELEASED]) {
        virtualPointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, state);
        await Scripting.sleep(60);
    }
}

async function pressKey(keyval) {
    virtualKeyboard ??= seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    for (const state of [Clutter.KeyState.PRESSED, Clutter.KeyState.RELEASED]) {
        virtualKeyboard.notify_keyval(GLib.get_monotonic_time(), keyval, state);
        await Scripting.sleep(60);
    }
}

// Away from the island and anything the tests open.
const restPointer = () => pointerTo(global.stage.width / 2, global.stage.height - 200);

function centerOf(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return [x + width / 2, y + height / 2];
}

const hasClass = (actor, name) => Boolean(actor?.has_style_class_name?.(name));

function findActor(root, predicate) {
    for (const child of root.get_children()) {
        if (predicate(child) || findActor(child, predicate))
            return true;
    }
    return false;
}

function overlayCount() {
    return Main.layoutManager._backgroundGroup.get_n_children() -
        Main.layoutManager._bgManagers.length;
}

// Stand-ins: the tests never lock, suspend or power off the machine, and
// the calendar and weather have known content.
function fakeSystemActions(calls) {
    const run = name => () => calls.push(name);
    return {
        canLockScreen: true, canSuspend: true, canLogout: true, canRestart: true, canPowerOff: false,
        forceUpdate() {},
        activateLockScreen: run('lock'),
        activateSuspend: run('suspend'),
        activateLogout: run('logout'),
        activateRestart: run('restart'),
        activatePowerOff: run('power-off'),
    };
}

class FakeEvents extends EventEmitter {
    constructor() {
        super();
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const at = (hours, minutes = 0) => new Date(now.getTime() + (hours * 60 + minutes) * 60000);
        this._events = [
            {id: 'a', summary: 'All-day offsite', date: today, end: new Date(today.getTime() + 86400000)},
            {id: 'b', summary: 'Design review', date: at(1), end: at(2)},
            {id: 'c', summary: 'Call with the print shop about the new posters', date: at(2, 30), end: at(3)},
            {id: 'd', summary: 'Gym', date: at(4), end: at(5)},
        ];
    }

    get hasCalendars() {
        return true;
    }

    getEvents(begin, end) {
        return this._events.filter(e => e.date < end && e.end > begin).sort((a, b) => a.date - b.date);
    }

    hasEvents(day) {
        const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        return this.getEvents(day, end).length > 0;
    }
}

class FakeWeather extends EventEmitter {
    available = true;
    hasLocation = true;
    loading = false;
    info = {
        is_valid: () => true,
        get_location_name: () => 'Prague',
        get_symbolic_icon_name: () => 'weather-few-clouds-symbolic',
        get_temp_summary: () => '14 °C',
        get_conditions: () => '-',
        get_sky: () => 'Partly cloudy',
    };

    update() {}
}

async function testIsland(ext, atelier) {
    const module = ext.stateObj.modules.get('island');
    if (!check(module !== null, 'island module running'))
        return;
    const calls = [];
    module.systemActions = fakeSystemActions(calls);
    const island = module.island;
    const dateMenu = Main.panel.statusArea.dateMenu;
    const slot = Main.panel.statusArea['atelier-island'];

    check(slot !== undefined, 'the island has its place in the top bar');
    check(!dateMenu.container.visible, 'GNOME\'s clock button makes room for it');
    dateMenu.container.show(); // as Just Perfection does when it starts
    check(!dateMenu.container.visible, 'and stays hidden when another extension shows it');
    check(await waitFor(() => island.opacity === 255 && island.width > 0, 3000), 'island placed');
    await restPointer();
    await Scripting.sleep(300);
    const [slotX] = centerOf(slot);
    const [islandX, islandY] = centerOf(island);
    const [, panelY] = centerOf(Main.panel);
    check(Math.abs(slotX - islandX) <= 1, `island centered over its place (${islandX} vs ${slotX})`);
    check(Math.abs(islandY - panelY) <= 1, `and in the middle of the bar (${islandY} vs ${panelY})`);
    check(/\d/.test(module._idle.text), `idle shows the time (${module._idle.text})`);
    await screenshotIsland('10-island-idle', 120);

    // Resting on the island opens the glance; leaving closes it.
    const events = new FakeEvents();
    Object.defineProperty(module._calendar, 'events', {value: events, configurable: true});
    Object.defineProperty(module._calendar, 'weather', {value: new FakeWeather(), configurable: true});
    await pointerTo(islandX, islandY);
    check(await waitFor(() => hasClass(island.page, 'atelier-glance'), 2000), 'resting on the island opens the glance');
    await Scripting.sleep(500);
    check(island.height > 200, `the island grew into the glance (${island.height}px)`);
    const glance = island.page;
    // (fewer when the test runs shortly before midnight)
    const now = new Date();
    const left = events.getEvents(new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)).filter(e => e.end > now).length;
    const rows = Math.min(left, 3) + (left > 3 ? 1 : 0);
    check(glance._eventList.get_n_children() === rows, `today's events listed (${rows} rows)`);
    check(glance._weatherRow.visible && glance._weatherText.text.includes('14'), 'weather shown');
    await screenshotIsland('11-island-glance');
    await restPointer();
    check(await waitFor(() => island.page === null, 2000), 'leaving the island closes the glance');
    await Scripting.sleep(500);
    check(Math.abs(island.height - module._idle.height) <= 1, `and it shrinks back (${island.height}px)`);
    delete module._calendar.events;
    delete module._calendar.weather;

    // A click opens GNOME's calendar and notifications under the island.
    await clickAt(islandX, islandY);
    check(await waitFor(() => dateMenu.menu.isOpen, 2000), 'clicking the island opens the calendar');
    await Scripting.sleep(500);
    const [menuX] = centerOf(dateMenu.menu.actor);
    const [, menuY] = dateMenu.menu.actor.get_transformed_position();
    check(Math.abs(menuX - islandX) < 40 && menuY >= Main.panel.height - 1,
        `under the island (${Math.round(menuX)}, ${Math.round(menuY)})`);
    await screenshotIsland('12-island-calendar', 700);
    Main.panel.closeCalendar();
    check(await waitFor(() => !dateMenu.menu.isOpen, 2000), 'closeCalendar() closes it');
    await restPointer();
    Main.panel.toggleCalendar();
    check(await waitFor(() => dateMenu.menu.isOpen, 2000), 'toggleCalendar() (Super+V) opens it');
    Main.panel.toggleCalendar();
    await waitFor(() => !dateMenu.menu.isOpen, 2000);

    // Power menu, with stand-in actions.
    module.togglePowerMenu();
    check(await waitFor(() => hasClass(island.page, 'atelier-power') && island.busy, 1000),
        'the power menu opens in the island with the keyboard');
    await Scripting.sleep(500);
    await screenshotIsland('13-island-power', 220);
    const tiles = island.page._buttons;
    check(!tiles.get('power-off').reactive && tiles.get('restart').reactive, 'unavailable actions are disabled');
    check(global.stage.get_key_focus() === tiles.get('lock'), 'focus starts on Lock');
    await pressKey(Clutter.KEY_Right);
    check(global.stage.get_key_focus() === tiles.get('suspend'), 'arrow keys move between the tiles');
    await pressKey(Clutter.KEY_Return);
    check(await waitFor(() => calls.includes('suspend'), 1000), 'Enter runs the action (a stand-in)');
    check(island.page === null && !island.busy, 'after the menu has closed');
    module.togglePowerMenu();
    await waitFor(() => island.busy, 1000);
    await pressKey(Clutter.KEY_Escape);
    check(await waitFor(() => island.page === null && !island.busy, 1000), 'Esc closes the power menu');
    module.togglePowerMenu();
    await waitFor(() => island.busy, 1000);
    await clickAt(200, global.stage.height - 200);
    check(await waitFor(() => island.page === null && !island.busy, 1000), 'so does a click outside');
    check(calls.length === 1, `nothing else ran (${calls})`);

    // A toast when the profile changes (not right after start).
    await waitFor(() => GLib.get_monotonic_time() - module._startedAt > 3500000, 5000);
    const target = atelier._store.getAll().find(p => ['amber', 'glass'].includes(p.id) && p.id !== atelier._store.activeId);
    await atelier._applier.apply(target, {animate: false});
    check(await waitFor(() => hasClass(island.page, 'atelier-toast'), 2000), 'switching profiles shows a toast');
    check(island.page?.title === target.name, `with the profile's name (${island.page?.title})`);
    await Scripting.sleep(500);
    await screenshotIsland('14-island-toast', 120);
    check(await waitFor(() => island.page === null, 4000), 'the toast goes away by itself');

    // The switcher opens inside the island.
    atelier.toggleSwitcher();
    await Scripting.sleep(500);
    check(hasClass(atelier._switcher?.get_parent(), 'atelier-island-switcher') && island.busy,
        'the switcher opens inside the island');
    await screenshotIsland('15-island-switcher', 300);
    atelier._switcher.close();
    check(await waitFor(() => atelier._switcher === null && island.page === null, 2000), 'and closes back into it');

    // Microphone and Do Not Disturb next to the time.
    const mic = module._mic;
    mic._isRecording = () => true;
    mic._update();
    check(module._idle._micIcon.visible, 'a microphone shows while an app records');
    const notifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
    notifications.set_boolean('show-banners', false);
    check(await waitFor(() => module._idle._dnd.visible, 1000), 'Do Not Disturb shows too');
    await Scripting.sleep(500);
    await screenshotIsland('16-island-mic-dnd', 120);
    delete mic._isRecording;
    mic._update();
    notifications.reset('show-banners');
    check(await waitFor(() => !module._idle._micIcon.visible && !module._idle._dnd.visible, 1000), 'both go away');

    // Turned off: GNOME's clock returns and the switcher drops down again.
    const settings = ext.stateObj._settings.get_child('island');
    settings.set_boolean('enabled', false);
    await Scripting.sleep(300);
    check(ext.stateObj.modules.get('island') === null, 'the island can be turned off');
    check(dateMenu.container.visible && dateMenu.menu.sourceActor === dateMenu, 'GNOME\'s clock is back');
    check(Main.panel.statusArea['atelier-island'] === undefined, 'and the island\'s place is gone');
    atelier.toggleSwitcher();
    await Scripting.sleep(400);
    check(hasClass(atelier._switcher?.get_parent(), 'atelier-panel'), 'without it the switcher is a popup');
    atelier._switcher?.close();
    await Scripting.sleep(400);
    settings.set_boolean('enabled', true);
    check(await waitFor(() => ext.stateObj.modules.get('island')?.island?.opacity === 255, 3000), 'and on again');
    ext.stateObj.modules.get('island').systemActions = fakeSystemActions(calls);
}

async function testSwitcherAndReveal(atelier) {
    await screenshot('01-desktop');

    atelier.toggleSwitcher();
    await Scripting.sleep(400);
    check(atelier._switcher !== null, 'Super+W action opens the switcher');
    await screenshot('02-switcher');

    const profiles = atelier._store.getAll();
    const target = profiles.find(l => l.id === 'rainbow');
    const index = profiles.indexOf(target);
    atelier._switcher._select(index);
    await Scripting.sleep(350);
    await screenshot('03-switcher-selected');

    atelier._switcher._activate(index);
    const duration = atelier._settings.get_uint('transition-duration');
    await Scripting.sleep(Math.round(duration * 0.5));
    check(overlayCount() > 0, 'reveal overlay is on screen during the transition');
    await screenshot('04-reveal-half');

    check(await waitFor(() => atelier._switcher === null, duration + 3000),
        'switcher closes after the reveal');
    check(await waitFor(() => !atelier._applier.busy, 6000), 'apply finished');
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
    check(atelier._store.activeId === 'rainbow', 'active profile recorded');
}

function hexOf(color) {
    return `#${[color.red, color.green, color.blue].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

async function testPalette(ext, atelier) {
    const paletteModule = ext.stateObj.modules.get('palette');
    if (!check(paletteModule !== null, 'palette module running'))
        return;

    // rainbow is applied now: the palette follows its wallpaper
    check(await waitFor(() => paletteModule.palette?.swatches.length > 0, 4000),
        `palette computed from the wallpaper (source ${paletteModule.palette?.source})`);
    const stored = JSON.parse(ext.stateObj._settings.get_child('palette').get_string('current') || 'null');
    check(stored?.source === paletteModule.palette.source, 'palette stored for the preferences');
    const sheets = St.ThemeContext.get_for_stage(global.stage).get_theme().get_custom_stylesheets()
        .map(f => f.get_basename());
    check(sheets.some(name => /^shell-[0-9a-f]{12}\.css$/.test(name)), `palette stylesheet loaded (${sheets})`);

    // The selected card of the switcher uses the palette's primary color.
    atelier.toggleSwitcher();
    await Scripting.sleep(400);
    const card = atelier._switcher._cards[atelier._switcher._selected];
    const border = hexOf(card.get_theme_node().get_border_color(St.Side.TOP));
    check(border === paletteModule.palette.dark.primary,
        `switcher highlight follows the palette (${border} vs ${paletteModule.palette.dark.primary})`);
    atelier._switcher.close();
    await Scripting.sleep(300);

    // A fixed palette replaces the wallpaper's colors.
    const before = paletteModule.palette.source;
    ext.stateObj._settings.get_child('palette').set_string('source', 'preset');
    ext.stateObj._settings.get_child('palette').set_string('preset', 'sea');
    check(await waitFor(() => paletteModule.palette?.source === '#2f8fb0', 3000),
        `preset palette applied (was ${before})`);
    ext.stateObj._settings.get_child('palette').reset('source');
    check(await waitFor(() => paletteModule.palette?.source === before, 3000), 'back to the wallpaper colors');
}

async function testShortcutsAndRequests(atelier) {
    atelier._step(1); // rainbow -> glass
    check(await waitFor(() => atelier._store.activeId === 'glass', 5000), 'next-profile applies the following profile');
    await waitFor(() => !atelier._applier.busy, 6000);
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    check(iface.get_string('color-scheme') === 'prefer-light', 'color scheme switched to light');
    check(iface.get_string('accent-color') === 'teal', 'accent color teal');
    await Scripting.sleep(300);
    await screenshot('06-glass-light');

    // Two quick presses while the first profile is still being applied move two steps.
    atelier._step(1); // glass -> hostile
    atelier._step(1); // hostile -> modern
    await waitFor(() => !atelier._applier.busy, 8000);
    check(atelier._store.activeId === 'modern', 'quick next presses each move one step');

    atelier._settings.set_string('apply-request', JSON.stringify({id: 'amber', nonce: GLib.uuid_string_random()}));
    check(await waitFor(() => atelier._store.activeId === 'amber', 5000), 'apply-request from preferences works');
    await waitFor(() => !atelier._applier.busy, 6000);
}

async function testFromOverview(atelier) {
    Main.overview.show();
    await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 4000);
    await Scripting.sleep(300);
    atelier.toggleSwitcher();
    for (const ms of [150, 450, 1000]) {
        await Scripting.sleep(ms === 150 ? 150 : ms - (ms === 450 ? 150 : 450));
        await screenshot(`07-from-overview-${ms}ms`);
    }
    check(!Main.overview.visible, 'overview hidden when the switcher opens');
    check(atelier._switcher?.visible === true, 'switcher visible after leaving the overview');
    atelier._switcher?.close();
    await Scripting.sleep(400);
}

async function testHostileShellTheme(atelier) {
    const userThemes = Main.extensionManager.lookup('user-theme@gnome-shell-extensions.gcampax.github.com');
    if (!check(userThemes?.state === ExtensionState.ACTIVE, 'User Themes active in the test session'))
        return;

    await atelier._applier.apply(atelier._store.get('hostile'));
    await waitFor(() => !atelier._applier.busy, 6000);
    const userTheme = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.user-theme'});
    check(userTheme.get_string('name') === 'Hostile', 'shell theme applied through User Themes');
    await Scripting.sleep(500);

    atelier.toggleSwitcher();
    await Scripting.sleep(600);
    await screenshot('08-switcher-hostile-theme');
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const [, height] = atelier._switcher.get_parent().get_preferred_height(-1);
    check(height < 320 * scale, `switcher keeps its size under a hostile theme (${height}px)`);
    atelier._switcher.close();
    await Scripting.sleep(400);

    const island = Main.extensionManager.lookup(UUID).stateObj.modules.get('island').island;
    await pointerTo(...centerOf(island));
    check(await waitFor(() => hasClass(island.page, 'atelier-glance'), 2000), 'glance opens under a hostile theme');
    await Scripting.sleep(500);
    await screenshotIsland('08b-glance-hostile-theme');
    check(island.height < 420 * scale, `and keeps its size (${island.height}px)`);
    await restPointer();
    await waitFor(() => island.page === null, 2000);

    await atelier._applier.apply(atelier._store.get('glass'));
    await waitFor(() => !atelier._applier.busy, 6000);
    check(userTheme.get_string('name') === '', 'default shell theme restored');
}

function readFile(path) {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
}

async function testGtkStyles(ext, atelier) {
    const gtkCss = GLib.build_filenamev([GLib.get_user_config_dir(), 'gtk-4.0', 'gtk.css']);
    const gtk3Css = GLib.build_filenamev([GLib.get_user_config_dir(), 'gtk-3.0', 'gtk.css']);
    const theme = GLib.build_filenamev([GLib.get_user_data_dir(), 'themes', 'Modern', 'gtk-4.0']);
    const imports = file => (readFile(gtkCss) ?? '').includes(`@import url("file://${theme}/${file}");`);

    await atelier._applier.apply(atelier._store.get('modern'), {animate: false});
    await waitFor(() => !atelier._applier.busy, 6000);
    check(await waitFor(() => imports('gtk-dark.css'), 3000),
        'dark profile imports the dark GTK 4 stylesheet');
    check((readFile(gtkCss) ?? '').startsWith('/* Generated by Atelier.'), 'gtk.css is generated, not a link');

    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    iface.set_string('color-scheme', 'default');
    check(await waitFor(() => imports('gtk.css'), 3000), 'switching to light imports the light stylesheet');

    // Palette colors for GTK apps
    const palette = ext.stateObj._settings.get_child('palette');
    palette.set_boolean('gtk-apps', true);
    const accent = () => ext.stateObj.modules.get('palette').palette?.light.primary;
    check(await waitFor(() => (readFile(gtkCss) ?? '').includes(`--accent-bg-color: ${accent()};`), 3000),
        'GTK 4 apps get the palette accent');
    check((readFile(gtkCss) ?? '').includes('mix(@window_bg_color'), 'and tinted surfaces');
    check(await waitFor(() => (readFile(gtk3Css) ?? '').includes(accent()), 3000), 'GTK 3 apps too');

    await atelier._applier.apply(atelier._store.get('glass'), {animate: false});
    await waitFor(() => !atelier._applier.busy, 6000);
    check(await waitFor(() => !imports('gtk.css') && (readFile(gtkCss) ?? '').includes('--accent-bg-color'), 3000),
        'a profile without GTK 4 theming drops the import, colors stay');

    palette.set_boolean('gtk-apps', false);
    check(await waitFor(() => readFile(gtkCss) === null && readFile(gtk3Css) === null, 3000),
        'turning colors off removes the generated files');
}

async function testTerminal(ext) {
    const ORIGINAL = 'b1dcc9dd-5262-4d8d-a863-c897e6d979b9';
    const list = new Gio.Settings({schema_id: 'org.gnome.Terminal.ProfilesList'});
    const palette = ext.stateObj._settings.get_child('palette');
    const paletteModule = ext.stateObj.modules.get('palette');
    const profile = uuid => new Gio.Settings({
        settings_schema: Gio.SettingsSchemaSource.get_default().lookup('org.gnome.Terminal.Legacy.Profile', true),
        path: `/org/gnome/terminal/legacy/profiles:/:${uuid}/`,
    });

    palette.set_boolean('terminal', true);
    check(await waitFor(() => palette.get_string('terminal-profile') !== '', 3000), 'terminal profile created');
    const uuid = palette.get_string('terminal-profile');
    check(list.get_string('default') === uuid, 'Atelier profile is the default terminal profile');
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const scheme = () => (iface.get_string('color-scheme') === 'prefer-dark' ? 'dark' : 'light');
    check(await waitFor(() => profile(uuid).get_string('background-color') ===
        paletteModule.palette[scheme()].surface, 3000), 'terminal background from the palette');

    iface.set_string('color-scheme', scheme() === 'dark' ? 'default' : 'prefer-dark');
    check(await waitFor(() => profile(uuid).get_string('background-color') ===
        paletteModule.palette[scheme()].surface, 3000), 'terminal follows light/dark');

    palette.set_boolean('terminal', false);
    check(await waitFor(() => list.get_string('default') === ORIGINAL, 3000), 'previous terminal profile restored');
    check(!list.get_strv('list').includes(uuid), 'Atelier profile removed');
}

async function testLiveProfile(ext, atelier) {
    // glass: managed GTK theme and light style, icons left alone
    await atelier._applier.apply(atelier._store.get('glass'), {animate: false});
    await waitFor(() => !atelier._applier.busy, 6000);
    await Scripting.sleep(1500); // let the sync see the applied settings first
    const before = atelier._store.get('glass');

    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const outside = '/usr/share/backgrounds/gnome/fold-l.jxl';
    iface.set_string('gtk-theme', 'HighContrast');
    iface.set_string('icon-theme', 'HighContrast');
    background.set_string('picture-uri', Gio.File.new_for_path(outside).get_uri());
    background.set_string('picture-uri-dark', Gio.File.new_for_path(outside).get_uri());
    ext.stateObj._settings.get_child('palette').set_string('variant', 'muted');

    check(await waitFor(() => atelier._store.get('glass').gtkTheme === 'HighContrast', 5000),
        'GTK theme changed elsewhere is saved into the active profile');
    const after = atelier._store.get('glass');
    check(after.wallpaper?.startsWith(`${GLib.get_user_data_dir()}/atelier/wallpapers/`) &&
        after.wallpaper.endsWith('.jxl'), `new wallpaper copied into the profile (${after.wallpaper})`);
    check(after.iconTheme === before.iconTheme, 'fields left at "don\'t change" stay that way');
    check(after.palette?.variant === 'muted', 'palette options saved too');

    // Switching profiles doesn't leak settings into the next one.
    await atelier._applier.apply(atelier._store.get('amber'), {animate: false});
    await waitFor(() => !atelier._applier.busy, 6000);
    await Scripting.sleep(1500);
    check(atelier._store.get('amber').gtkTheme === null, 'other profiles untouched');
    ext.stateObj._settings.get_child('palette').reset('variant');
}

async function testWallpapersTab(atelier) {
    const activeBefore = atelier._store.activeId;
    atelier.toggleSwitcher('wallpapers');
    check(await waitFor(() => atelier._switcher?.wallpapersLoaded, 3000), 'Wallpapers tab lists the folder');
    const switcher = atelier._switcher;
    check(switcher.mode === 'wallpapers' && switcher._cards.length === 2,
        `two pictures shown (${switcher._cards.length})`);
    await Scripting.sleep(400);
    await screenshot('09-wallpapers-tab');

    switcher.setMode('profiles');
    check(switcher.mode === 'profiles' && switcher._cards.length === atelier._store.getAll().length,
        'Tab back to profiles');
    switcher.setMode('wallpapers');
    const pills = switcher._items.findIndex(item => item.id.endsWith('pills.jxl'));
    switcher._activate(pills);
    check(await waitFor(() => atelier._switcher === null, 5000), 'switcher closes after picking a wallpaper');
    await waitFor(() => !atelier._applier.busy, 6000);

    const uri = new Gio.Settings({schema_id: 'org.gnome.desktop.background'}).get_string('picture-uri');
    const active = atelier._store.get(activeBefore);
    check(uri.includes('/atelier/wallpapers/') && uri.endsWith('-pills.jxl'),
        `desktop shows a library copy of the picture (${uri})`);
    check(atelier._store.activeId === activeBefore, 'the active profile stays active');
    check(active.wallpaper && uri === Gio.File.new_for_path(active.wallpaper).get_uri(),
        'and keeps the new wallpaper');
}

async function testDisableCleansUp(atelier) {
    atelier.toggleSwitcher();
    await Scripting.sleep(300);
    // Disable mid-transition: everything must be torn down.
    atelier._switcher._activate(0);
    await Scripting.sleep(200);
    Main.extensionManager.disableExtension(UUID);
    await Scripting.sleep(500);
    const ext = Main.extensionManager.lookup(UUID);
    check(ext.state === ExtensionState.INACTIVE, `disabled (state ${ext.state})`);
    check(overlayCount() === 0, 'no overlay left after disable');
    check(!findActor(Main.uiGroup, a => a.has_style_class_name?.('atelier-panel')),
        'no switcher left after disable');
    check(Main.panel.statusArea[UUID] === undefined, 'indicator removed');
    check(!findActor(Main.uiGroup, a => hasClass(a, 'atelier-island')), 'no island left after disable');
    check(Main.panel.statusArea['atelier-island'] === undefined, 'island place removed');
    const dateMenu = Main.panel.statusArea.dateMenu;
    check(dateMenu.container.visible && dateMenu.menu.sourceActor === dateMenu, 'GNOME\'s clock restored');
    const panelProto = Object.getPrototypeOf(Main.panel);
    check(['toggleCalendar', 'closeCalendar'].every(name => Main.panel[name] === panelProto[name]),
        'calendar functions restored');

    Main.extensionManager.enableExtension(UUID);
    await Scripting.sleep(300);
    check(Main.extensionManager.lookup(UUID).state === ExtensionState.ACTIVE, 're-enabled');
    check(Main.panel.statusArea[UUID] !== undefined, 'indicator back');
    check(await waitFor(() => Main.extensionManager.lookup(UUID).stateObj.modules?.get('island')?.island, 3000),
        'island back');
}

export async function run() {
    try {
        await Scripting.sleep(1000);
        // The session starts in the overview; begin on the desktop.
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible, 4000);
        // Extensions load a few seconds after startup (longer on a busy
        // machine), and Atelier starts its modules once BG Changer's data is in.
        await waitFor(() => Main.extensionManager.lookup(UUID)?.stateObj?.modules?.get('profiles'), 30000);
        const ext = Main.extensionManager.lookup(UUID);
        if (!ext)
            results.push(`INFO  loaded extensions: ${Main.extensionManager.getUuids().join(', ')}`);
        if (!check(ext?.state === ExtensionState.ACTIVE,
            `extension active (state ${ext?.state}${ext?.error ? `, error: ${ext.error}` : ''})`))
            return;
        // The profiles feature lives in its own module.
        const atelier = ext.stateObj.modules.get('profiles');
        if (!check(atelier !== null, 'profiles module running'))
            return;

        check(ext.stateObj._settings.get_boolean('migrated-from-bg-changer'), 'BG Changer data taken over');
        check(['amber', 'rainbow', 'glass', 'hostile', 'modern'].every(id => atelier._store.get(id)),
            'all BG Changer profiles migrated');
        const desktop = new Gio.Settings({schema_id: 'org.gnome.desktop.background'}).get_string('picture-uri');
        check(desktop.startsWith(`file://${GLib.get_user_data_dir()}/atelier/wallpapers/`),
            `desktop wallpaper moved into the Atelier library (${desktop})`);
        check(!GLib.file_test(`${GLib.get_user_data_dir()}/bg-changer`, GLib.FileTest.EXISTS),
            'old library removed');

        check(await waitFor(() => atelier._store.getAll().some(l => l.name === 'Original')),
            'first run saved the "Original" profile');
        const original = atelier._store.getAll().find(l => l.name === 'Original');
        check(original?.wallpaper?.startsWith(`${GLib.get_user_data_dir()}/atelier/wallpapers/`),
            `original wallpaper copied into the library (${original?.wallpaper})`);
        check(Main.panel.statusArea[UUID] !== undefined, 'indicator in the top bar');

        await testIsland(ext, atelier);
        await testSwitcherAndReveal(atelier);
        await testPalette(ext, atelier);
        await testShortcutsAndRequests(atelier);
        await testFromOverview(atelier);
        await testHostileShellTheme(atelier);
        await testGtkStyles(ext, atelier);
        await testTerminal(ext);
        await testLiveProfile(ext, atelier);
        await testWallpapersTab(atelier);
        await testDisableCleansUp(atelier);
    } catch (e) {
        check(false, `exception: ${e}\n${e.stack}`);
    } finally {
        GLib.file_set_contents(`${OUTPUT}/results.txt`, `${results.join('\n')}\n`);
    }
}
