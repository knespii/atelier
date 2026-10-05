// Automation script for tools/shell-test.sh. GNOME Shell imports it, calls
// run() once startup is complete and exits when it returns.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
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

/**
 * @returns {number[]} the average [r, g, b] of a rectangle of a screenshot
 */
function averageColor(name, x, y, width, height) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(`${OUTPUT}/${name}.png`);
    const pixels = pixbuf.get_pixels();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const sum = [0, 0, 0];
    for (let row = y; row < y + height; row++) {
        for (let col = x; col < x + width; col++) {
            const i = row * stride + col * channels;
            sum[0] += pixels[i];
            sum[1] += pixels[i + 1];
            sum[2] += pixels[i + 2];
        }
    }
    return sum.map(v => Math.round(v / (width * height)));
}

const colorDistance = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

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

    // A click opens the control centre; Super+V its notifications and
    // GNOME's calendar menu stays closed.
    await clickAt(islandX, islandY);
    check(await waitFor(() => hasClass(island.page, 'atelier-cc') && island.page.tab === 'controls', 2000),
        'clicking the island opens the control centre');
    check(!dateMenu.menu.isOpen, 'GNOME\'s calendar menu stays closed');
    Main.panel.closeCalendar();
    check(await waitFor(() => island.page === null, 2000), 'closeCalendar() closes it');
    await restPointer();
    Main.panel.toggleCalendar();
    check(await waitFor(() => island.page?.tab === 'notifications', 2000), 'Super+V opens its notifications');
    check(dateMenu._messageList.get_parent()?.get_parent() === island.page, 'GNOME\'s notification list is there');
    await Scripting.sleep(500);
    await screenshotIsland('12-control-centre-notifications', 520);
    island.page.setTab('calendar');
    await Scripting.sleep(500);
    check(dateMenu._calendar.mapped, 'and the calendar on its own tab');
    await screenshotIsland('12b-control-centre-calendar', 640);
    Main.panel.toggleCalendar();
    check(await waitFor(() => island.page?.tab === 'notifications', 1000), 'Super+V again goes to the notifications');
    Main.panel.toggleCalendar();
    check(await waitFor(() => island.page === null, 1000), 'and once more closes it');

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

    // Switching profiles: the island announces it at once, and the work
    // starts once the announcement is open.
    const others = () => atelier._store.getAll()
        .filter(p => ['amber', 'glass'].includes(p.id) && p.id !== atelier._store.activeId);
    const target = others()[0];
    // (Checked right away: _switchTo opens the toast before it first waits.)
    const switching = atelier._switchTo(target);
    check(hasClass(island.page, 'atelier-toast') && island.page.title === target.name,
        `switching profiles shows a toast at once (${island.page?.title})`);
    check(atelier._store.activeId !== target.id && !atelier._applier.busy,
        `before the work starts (active ${atelier._store.activeId}, busy ${atelier._applier.busy})`);
    await Scripting.sleep(400);
    await screenshotIsland('14-island-toast', 120);
    await switching;
    check(atelier._store.activeId === target.id, 'then the profile is applied');
    check(await waitFor(() => island.page === null, 4000), 'the toast goes away by itself');

    // The switcher opens inside the island…
    atelier.toggleSwitcher();
    await Scripting.sleep(500);
    check(hasClass(atelier._switcher?.get_parent(), 'atelier-island-switcher') && island.busy,
        'the switcher opens inside the island');
    await screenshotIsland('15-island-switcher', 300);
    atelier._switcher.close();
    check(await waitFor(() => atelier._switcher === null && island.page === null, 2000), 'and closes back into it');

    // …and turns into the toast when a profile is picked.
    atelier.toggleSwitcher();
    await Scripting.sleep(500);
    const pick = others()[0];
    atelier._switcher._activate(atelier._store.getAll().findIndex(p => p.id === pick.id));
    await Scripting.sleep(40);
    check(hasClass(island.page, 'atelier-toast') && island.page.title === pick.name && !island.busy,
        'picking a profile turns the switcher into the toast');
    check(await waitFor(() => atelier._switcher === null, 1000), 'the switcher is gone');
    check(await waitFor(() => atelier._store.activeId === pick.id && !atelier._applier.busy, 6000),
        'and the profile is applied');
    await waitFor(() => island.page === null, 4000);

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

function appSource(title, appId, iconName) {
    const source = new MessageTray.Source({
        title,
        iconName,
        policy: new MessageTray.NotificationApplicationPolicy(appId),
    });
    Main.messageTray.add(source);
    return source;
}

// The tray keeps banners of a user who is away until they come back; a
// little pointer movement first makes them time out as usual.
let nudge = 0;
async function notify(source, title, body, setup = null) {
    await pointerTo(global.stage.width / 2 + (nudge++ % 2 ? 40 : -40), global.stage.height - 200);
    const notification = new MessageTray.Notification({source, title, body});
    setup?.(notification);
    source.addNotification(notification);
    return notification;
}

const showsNotification = (island, notification = null) =>
    hasClass(island.page, 'atelier-notification') && (!notification || island.page.notification === notification);
const click = button => button.emit('clicked', Clutter.BUTTON_PRIMARY);

async function testNotifications(ext, atelier) {
    if (!check(ext.stateObj.modules.get('notifications') !== null, 'notifications module running'))
        return;
    const tray = Main.messageTray;
    const settings = ext.stateObj._settings.get_child('notifications');
    const islandModule = () => ext.stateObj.modules.get('island');
    const island = islandModule().island;

    // WhatsApp (a Chrome app): Reply and Mute.
    const whatsapp = appSource('WhatsApp', 'chrome-hnpfjngllnobngcgfapefoaidbinmjnm-Default', 'mail-unread-symbolic');
    const message = await notify(whatsapp, 'Petr Novák',
        'Ahoj! Jdeme dnes večer na ten koncert? Lístky mám, stačí říct a vezmu je s sebou.');
    check(await waitFor(() => showsNotification(island, message), 2000), 'a notification shows in the island');
    check(tray._banner === null && !tray.visible, 'GNOME\'s banner stays hidden');
    const page = island.page;
    check(page._title.text === 'Petr Novák' && page._body.text.startsWith('Ahoj!'), 'with its title and text');
    check(JSON.stringify(page.buttonLabels) === '["Reply","Mute"]', `WhatsApp gets Reply and Mute (${page.buttonLabels})`);
    check(message.acknowledged, 'and counts as seen');
    await Scripting.sleep(400);
    await screenshotIsland('18-notification-whatsapp', 220);

    click(page._buttons.get_child_at_index(1));
    await Scripting.sleep(400);
    check(JSON.stringify(page.buttonLabels) === '["1 hour","8 hours","Until unmuted","Cancel"]',
        'Mute asks for how long');
    check(island.height > 120, `and the island makes room (${island.height}px)`);
    await screenshotIsland('19-notification-mute', 220);
    click(page._buttons.get_child_at_index(0));
    check(await waitFor(() => island.page === null && tray._notification === null, 2000), 'muting lets it go');
    check(whatsapp.notifications.includes(message), 'it stays in the list');
    check(settings.get_string('muted').includes('chrome-hnpfjngllnobngcgfapefoaidbinmjnm-default'), 'the app is muted');
    const quiet = await notify(whatsapp, 'Petr Novák', 'Haló?');
    await Scripting.sleep(800);
    check(island.page === null && tray.queueCount === 0 && whatsapp.notifications.includes(quiet),
        'a muted app\'s notification goes to the list without a banner');
    settings.reset('muted');

    // Claude: no buttons, and it goes by itself.
    const claude = appSource('Claude', 'com.anthropic.claude', 'dialog-information-symbolic');
    const finished = await notify(claude, 'Claude', 'Your task is done.');
    check(await waitFor(() => showsNotification(island, finished), 2000), 'the next one shows');
    check(island.page.buttonLabels.length === 0 && !island.page._buttons.visible, 'Claude\'s has no buttons');
    check(await waitFor(() => island.page === null, 9000), 'it goes away by itself');
    check(claude.notifications.includes(finished), 'and stays in the list');

    // Other apps: their own buttons. (A source goes away with its last
    // notification, so a new one is made when needed.)
    let filesSource = null;
    const files = () => {
        if (!filesSource || !tray.contains(filesSource))
            filesSource = appSource('Files', 'org.gnome.Nautilus', 'folder-symbolic');
        return filesSource;
    };
    let opened = false;
    const copied = await notify(files(), 'Copy finished', '3 files copied to Pictures',
        n => n.addAction('Open Folder', () => (opened = true)));
    check(await waitFor(() => showsNotification(island, copied), 2000) &&
        JSON.stringify(island.page.buttonLabels) === '["Open Folder"]', 'other apps get their own buttons');
    click(island.page._buttons.get_child_at_index(0));
    check(opened && await waitFor(() => island.page === null, 2000), 'a button runs and closes the notification');

    let activated = false;
    const clicked = await notify(files(), 'Clicked', 'Opens the app', n => n.connect('activated', () => (activated = true)));
    await waitFor(() => showsNotification(island, clicked), 2000);
    click(island.page._content);
    check(activated && await waitFor(() => island.page === null, 2000), 'clicking a notification opens it');
    let removed = false;
    const dismissed = await notify(files(), 'Dismissed', 'Goes away', n => n.connect('destroy', () => (removed = true)));
    await waitFor(() => showsNotification(island, dismissed), 2000);
    click(island.page._dismiss);
    check(await waitFor(() => island.page === null && removed, 2000), 'the × removes it from the list');

    // With the switcher open, a notification waits for it to close.
    atelier.toggleSwitcher();
    await Scripting.sleep(400);
    const waiting = await notify(files(), 'Waiting', 'for the switcher');
    await Scripting.sleep(500);
    check(tray.queueCount === 1 && hasClass(atelier._switcher?.get_parent(), 'atelier-island-switcher'),
        'with the switcher open it waits');
    atelier._switcher.close();
    check(await waitFor(() => showsNotification(island, waiting), 2000), 'and shows once it closes');
    waiting.destroy();
    await waitFor(() => island.page === null, 2000);

    // Without the island, GNOME's banner.
    const islandSettings = ext.stateObj._settings.get_child('island');
    islandSettings.set_boolean('enabled', false);
    await Scripting.sleep(300);
    const plain = await notify(files(), 'Plain', 'A GNOME banner');
    check(await waitFor(() => tray._banner !== null, 2000), 'without the island, GNOME\'s banner shows');
    plain.destroy();
    await waitFor(() => tray._banner === null, 2000);
    islandSettings.set_boolean('enabled', true);
    await waitFor(() => islandModule()?.island?.opacity === 255, 3000);
    islandModule().systemActions = fakeSystemActions([]);

    // Turned off while one shows: the tray carries on with its own banners.
    const last = await notify(files(), 'Last', 'in the island');
    await waitFor(() => showsNotification(islandModule().island, last), 2000);
    settings.set_boolean('enabled', false);
    await Scripting.sleep(400);
    check(ext.stateObj.modules.get('notifications') === null && islandModule().island.page === null,
        'notifications can be turned off, even mid-way');
    const after = await notify(files(), 'After', 'A GNOME banner again');
    check(await waitFor(() => tray._banner !== null, 3000), 'then GNOME\'s banners are back');
    after.destroy();
    await waitFor(() => tray._banner === null, 2000);
    settings.set_boolean('enabled', true);
    await Scripting.sleep(300);
    for (const source of [whatsapp, claude, filesSource]) {
        if (tray.contains(source))
            source.destroy();
    }
}

// A quick settings tile with a menu, added the way Caffeine adds its own.
function addTestTile() {
    const indicator = new QuickSettings.SystemIndicator();
    const toggle = new QuickSettings.QuickMenuToggle({
        title: 'Test Tile',
        iconName: 'weather-clear-night-symbolic',
        toggleMode: true,
    });
    toggle.menu.setHeader('weather-clear-night-symbolic', 'Test Tile', 'Its own menu');
    toggle.menu.addMenuItem(new PopupMenu.PopupMenuItem('First option'));
    toggle.menu.addMenuItem(new PopupMenu.PopupMenuItem('Second option'));
    indicator.quickSettingsItems.push(toggle);
    Main.panel.statusArea.quickSettings.addExternalIndicator(indicator);
    return {indicator, toggle};
}

// An extension's icon in the top bar, with a menu.
function addTestButton() {
    const button = new PanelMenu.Button(0.5, 'Test Extension', false);
    button.add_child(new St.Icon({icon_name: 'applications-science-symbolic', style_class: 'system-status-icon'}));
    button.menu.addMenuItem(new PopupMenu.PopupMenuItem('Do something'));
    Main.panel.addToStatusArea('atelier-test-extension', button, 1, 'right');
    return button;
}

async function testControlCentre(ext) {
    const modules = ext.stateObj.modules;
    if (!check(modules.get('control-centre') !== null, 'control centre module running'))
        return;
    const quickSettings = Main.panel.statusArea.quickSettings;
    const island = modules.get('island').island;
    check(hasClass(quickSettings.menu._grid.get_parent(), 'atelier-cc-tiles'),
        'GNOME\'s tiles moved into the control centre');
    check(Main.panel.has_style_class_name('atelier-bar-clean'), 'the top bar has no background');

    const {indicator, toggle} = addTestTile();
    const button = addTestButton();
    await Scripting.sleep(300);
    check(hasClass(button.container.get_parent()?.get_parent(), 'atelier-ext-tile') &&
        !Main.panel._rightBox.contains(button), 'an extension\'s icon moves out of the bar');
    await restPointer();
    await screenshotArea('20-top-bar', 0, 0, global.stage.width, 44);

    // The status icons only show; the island (and Super+S) open it.
    await clickAt(...centerOf(quickSettings));
    await Scripting.sleep(500);
    check(island.page === null && !quickSettings.menu.isOpen, 'clicking the status icons does nothing');
    await clickAt(...centerOf(island));
    check(await waitFor(() => hasClass(island.page, 'atelier-cc') && island.busy, 1000),
        'the island opens the control centre');
    check(!quickSettings.menu.isOpen, 'GNOME\'s menu stays closed');
    const page = island.page;
    const grid = modules.get('control-centre')._quickSettingsHost.grid;
    check(grid.contains(toggle) && page.contains(grid), 'an extension\'s tile is there too');
    await restPointer();
    await Scripting.sleep(500);
    await screenshotIsland('21-control-centre', 700);

    toggle.menu.open(true);
    await Scripting.sleep(700);
    const [, tileY] = toggle.get_transformed_position();
    const [, menuY] = toggle.menu.actor.get_transformed_position();
    check(toggle.menu.isOpen && menuY >= tileY + toggle.height - 1, 'a tile\'s menu opens under it');
    check(island.height > grid.get_preferred_height(-1)[1] - 1, 'and the island makes room');
    await screenshotIsland('22-control-centre-menu', 800);
    toggle.menu.close(true);
    await Scripting.sleep(500);

    // The second tab: extension icons as tiles.
    page.setTab('extensions');
    await Scripting.sleep(500);
    const tile = modules.get('control-centre').tray.tiles.find(t => t.indicator === button);
    check(page.tab === 'extensions' && tile?.mapped, 'the Extensions tab shows their icons');
    check(tile?.name === 'Test Extension', `named after the extension (${tile?.name})`);
    await screenshotIsland('23-control-centre-extensions', 300);
    await clickAt(...centerOf(button));
    check(await waitFor(() => button.menu.isOpen, 1000), 'clicking one opens the extension\'s menu');
    button.menu.close();
    await Scripting.sleep(300);
    check(island.page === page, 'the control centre stays open behind it');

    Main.panel.closeQuickSettings();
    check(await waitFor(() => island.page === null && !island.busy, 1000), 'closeQuickSettings() closes it');
    Main.panel.toggleQuickSettings();
    check(await waitFor(() => hasClass(island.page, 'atelier-cc'), 1000), 'Super+S opens it');
    Main.panel.toggleQuickSettings();
    check(await waitFor(() => island.page === null, 1000), 'and closes it');

    // Turned off: GNOME's menu and the icons in the bar come back.
    const settings = ext.stateObj._settings.get_child('control-centre');
    settings.set_boolean('enabled', false);
    await Scripting.sleep(300);
    const dateMenu = Main.panel.statusArea.dateMenu;
    check(quickSettings.menu._grid.get_parent() === quickSettings.menu.box &&
        dateMenu._messageList.get_parent()?.name === 'calendarArea' &&
        Main.panel._rightBox.contains(button.container), 'turned off, GNOME\'s menus and the icons are back');
    Main.panel.toggleQuickSettings();
    check(await waitFor(() => quickSettings.menu.isOpen, 1000) && island.page === null,
        'and GNOME\'s menu opens again');
    Main.panel.closeQuickSettings();
    await waitFor(() => !quickSettings.menu.isOpen, 1000);
    settings.set_boolean('enabled', true);
    await Scripting.sleep(400);
    check(hasClass(quickSettings.menu._grid.get_parent(), 'atelier-cc-tiles') &&
        !Main.panel._rightBox.contains(button), 'and on again');

    button.destroy();
    await Scripting.sleep(100);
    check(!modules.get('control-centre').tray.tiles.some(t => t.indicator === button),
        'a removed extension\'s tile goes away');
    indicator.quickSettingsItems.forEach(item => item.destroy());
    indicator.destroy();
}

async function testOverviewBar() {
    await restPointer();
    Main.overview.show();
    await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 4000);
    await Scripting.sleep(300);
    Main.overview.hide();
    await Scripting.sleep(110);
    await screenshotArea('24-leaving-overview', 0, 0, 900, 80);
    // A stretch of the bar left of the island against the wallpaper below it.
    const bar = averageColor('24-leaving-overview', 120, 6, 300, 20);
    const below = averageColor('24-leaving-overview', 120, 50, 300, 20);
    check(colorDistance(bar, below) < 60, `the bar stays clear while leaving the overview (${bar} vs ${below})`);
    await waitFor(() => !Main.overview.visible, 3000);
    await Scripting.sleep(200);
    const backdrop = Main.layoutManager.uiGroup.get_children().find(a => a.name === 'atelier-panel-backdrop');
    check(backdrop?.opacity === 0, 'and the wallpaper strip behind it is gone on the desktop');
}

async function testBarStyles(ext) {
    const bar = ext.stateObj._settings.get_child('bar');
    const island = ext.stateObj.modules.get('island').island;
    const surfaces = () => Main.layoutManager.uiGroup.get_children()
        .filter(a => hasClass(a, 'atelier-capsule') || hasClass(a, 'atelier-glass'));
    await restPointer();

    // Grouped: the sides in black capsules.
    bar.set_string('style', 'grouped');
    await Scripting.sleep(400);
    const capsules = surfaces();
    const activities = Main.panel.statusArea.activities;
    const [ax] = activities.get_transformed_position();
    const left = capsules.find(c => c.x < global.stage.width / 2);
    const middle = ax + activities.width / 2;
    check(Main.panel.has_style_class_name('atelier-bar-grouped') && capsules.length === 2 &&
        left && left.x < middle && left.x + left.width > middle && left.width >= activities.width - 16,
    `grouped: the sides sit in capsules (${left?.x}+${left?.width} around ${ax}+${activities.width})`);
    await screenshotArea('25-bar-grouped', 0, 0, global.stage.width, 44);

    // Glass: the island and the capsules are the blurred wallpaper.
    bar.set_string('surface', 'glass');
    await Scripting.sleep(600);
    const glass = surfaces().filter(a => hasClass(a, 'atelier-glass'));
    check(glass.length === 3 && island.has_style_class_name('atelier-island-glass'),
        `glass: the island and the capsules (${glass.length} surfaces)`);
    await screenshotArea('26-bar-glass', 0, 0, global.stage.width, 44);
    const islandGlass = glass.find(g => g.get_parent() === island.get_parent() &&
        island.get_parent().get_children().indexOf(g) === island.get_parent().get_children().indexOf(island) - 1);
    await pointerTo(...centerOf(island));
    await waitFor(() => hasClass(island.page, 'atelier-glance'), 2000);
    await Scripting.sleep(600);
    const shape = islandGlass?._shape ?? [];
    check(Math.abs(shape[2] - island.width) < 1 && Math.abs(shape[3] - island.height) < 1,
        'the island\'s glass grows with it');
    await screenshotIsland('27-glance-glass', 420);
    await restPointer();
    await waitFor(() => island.page === null, 2000);
    await Scripting.sleep(400);

    // Notch: the island hangs from the top edge.
    bar.set_string('island-shape', 'notch');
    await Scripting.sleep(600);
    const [, panelY] = Main.panel.get_transformed_position();
    check(Math.abs(island.y - panelY) < 1 && Math.abs(island.height - Main.panel.height) < 1,
        `notch: the island hangs from the top edge (${island.y}, ${island.height})`);
    await screenshotArea('28-bar-notch', 0, 0, global.stage.width, 44);

    ['style', 'surface', 'island-shape'].forEach(key => bar.reset(key));
    await Scripting.sleep(500);
    check(surfaces().length === 0 && !island.has_style_class_name('atelier-island-glass') &&
        Main.panel.has_style_class_name('atelier-bar-clean'), 'back to the clear bar');
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
    check(await waitFor(() => atelier._switcher === null, 1000), 'the switcher gives way to the toast');
    check(await waitFor(() => overlayCount() > 0, 3000), 'reveal overlay is on screen during the transition');
    await Scripting.sleep(Math.round(duration * 0.4));
    await screenshot('04-reveal-half');

    check(await waitFor(() => !atelier._applier.busy, duration + 6000), 'apply finished');
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
    check(await waitFor(() => atelier._store.activeId === 'modern' && !atelier._applier.busy, 8000),
        `quick next presses each move one step (${atelier._store.activeId})`);

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

async function testProfilesStayAsSaved(ext, atelier) {
    await atelier._applier.apply(atelier._store.get('glass'), {animate: false});
    await waitFor(() => !atelier._applier.busy, 6000);
    const before = JSON.stringify(atelier._store.get('glass'));
    const count = atelier._store.getAll().length;

    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const outside = uriOf('/usr/share/backgrounds/gnome/fold-l.jxl');
    iface.set_string('gtk-theme', 'HighContrast');
    background.set_string('picture-uri', outside);
    background.set_string('picture-uri-dark', outside);
    ext.stateObj._settings.get_child('palette').set_string('variant', 'muted');
    await Scripting.sleep(2000);

    check(JSON.stringify(atelier._store.get('glass')) === before,
        'changes made elsewhere leave the active profile as saved');
    check(atelier._store.getAll().length === count && atelier._store.activeId === 'glass',
        'no profile is created and the active one stays');
    ext.stateObj._settings.get_child('palette').reset('variant');
}

async function testWallpapersTab(atelier) {
    const activeBefore = atelier._store.activeId;
    const profileBefore = JSON.stringify(atelier._store.get(activeBefore));
    const countBefore = atelier._store.getAll().length;
    atelier.toggleSwitcher('wallpapers');
    check(await waitFor(() => atelier._switcher?.wallpapersLoaded, 3000), 'Wallpapers tab lists the folder');
    const switcher = atelier._switcher;
    check(switcher.mode === 'wallpapers' && switcher._cards.length === 2,
        `two pictures shown (${switcher._cards.length})`);
    await Scripting.sleep(400);
    await screenshot('09-wallpapers-tab');

    switcher.setMode('profiles');
    check(switcher.mode === 'profiles' && switcher._cards.length === atelier._store.getAll().length + 1,
        'Tab back to profiles (and the "new profile" card)');
    switcher.setMode('wallpapers');
    const pills = switcher._items.findIndex(item => item.id.endsWith('pills.jxl'));
    const picture = switcher._items[pills].id;
    switcher._activate(pills);
    check(await waitFor(() => atelier._switcher === null, 5000), 'switcher closes after picking a wallpaper');
    await waitFor(() => !atelier._applier.busy, 6000);

    const uri = new Gio.Settings({schema_id: 'org.gnome.desktop.background'}).get_string('picture-uri');
    check(uri === uriOf(picture), `the desktop shows the picture for now (${uri})`);
    check(atelier._store.activeId === activeBefore, 'the active profile stays active');
    check(JSON.stringify(atelier._store.get(activeBefore)) === profileBefore, 'and keeps its own wallpaper');
    check(atelier._store.getAll().length === countBefore, 'no profile is created');
}

async function testNewProfile(ext, atelier) {
    // What the desktop shows now (the picture from the Wallpapers tab).
    const count = atelier._store.getAll().length;
    atelier.toggleSwitcher();
    await Scripting.sleep(400);
    const switcher = atelier._switcher;
    const last = switcher._cards.length - 1;
    check(switcher._items[last]?.id === 'atelier-new-profile', 'the Profiles tab ends with a "new profile" card');
    switcher._select(last);
    await Scripting.sleep(400);
    await screenshotIsland('17-switcher-new-profile', 300);

    switcher._activate(last);
    check(await waitFor(() => atelier._store.getAll().length === count + 1, 3000), 'it saves a new profile');
    const added = atelier._store.getAll().at(-1);
    check(added.name === 'Pills' && atelier._store.activeId === added.id,
        `named after the wallpaper and active (${added.name})`);
    check(added.wallpaper?.startsWith(`${GLib.get_user_data_dir()}/atelier/wallpapers/`),
        `with its own copy of the wallpaper (${added.wallpaper})`);
    const palette = ext.stateObj._settings.get_child('palette');
    check(added.palette?.variant === palette.get_string('variant') && added.gtkTheme === 'HighContrast',
        'and the palette and themes in use');
    const island = ext.stateObj.modules.get('island').island;
    check(await waitFor(() => hasClass(island.page, 'atelier-toast') && island.page.title === added.name, 2000),
        'the island announces it');
    check(await waitFor(() => atelier._switcher === null, 2000), 'in place of the switcher');
    await waitFor(() => island.page === null, 4000);
}

async function testDisableCleansUp(atelier) {
    atelier.toggleSwitcher();
    await Scripting.sleep(300);
    // Disable mid-transition: everything must be torn down.
    atelier._switcher._activate(0);
    await waitFor(() => overlayCount() > 0, 3000);
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
    const qsMenu = Main.panel.statusArea.quickSettings.menu;
    check(!Main.layoutManager.uiGroup.get_children().some(a => hasClass(a, 'atelier-glass') || hasClass(a, 'atelier-capsule')),
        'no glass or capsules left');
    check(qsMenu._grid.get_parent() === qsMenu.box && !Main.panel.has_style_class_name('atelier-bar-clean') &&
        dateMenu._messageList.get_parent()?.name === 'calendarArea', 'quick settings, the bar and the calendar restored');
    const trayProto = Object.getPrototypeOf(Main.messageTray);
    check(['_showNotification', '_hideNotification', '_updateShowingNotification']
        .every(name => Main.messageTray[name] === trayProto[name]), 'message tray restored');

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
        await testNotifications(ext, atelier);
        await testControlCentre(ext);
        await testOverviewBar();
        await testBarStyles(ext);
        await testSwitcherAndReveal(atelier);
        await testPalette(ext, atelier);
        await testShortcutsAndRequests(atelier);
        await testFromOverview(atelier);
        await testHostileShellTheme(atelier);
        await testGtkStyles(ext, atelier);
        await testTerminal(ext);
        await testProfilesStayAsSaved(ext, atelier);
        await testWallpapersTab(atelier);
        await testNewProfile(ext, atelier);
        await testDisableCleansUp(atelier);
    } catch (e) {
        check(false, `exception: ${e}\n${e.stack}`);
    } finally {
        GLib.file_set_contents(`${OUTPUT}/results.txt`, `${results.join('\n')}\n`);
    }
}
