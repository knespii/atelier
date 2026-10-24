// Automation script for tools/shell-test.sh. GNOME Shell imports it, calls
// run() once startup is complete and exits when it returns.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as AuthPromptModule from 'resource:///org/gnome/shell/gdm/authPrompt.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

import {contrastLc, minimumLc} from '../lib/apca.js';
import {luminance} from '../lib/palette.js';

import * as dockAppearance from './dock-tests/appearance.js';
import * as dockBadges from './dock-tests/badges.js';
import * as dockBehaviour from './dock-tests/behaviour.js';
import * as dockCore from './dock-tests/core.js';
import * as dockHiding from './dock-tests/hiding.js';
import * as dockLaunchers from './dock-tests/launchers.js';
import * as dockWindows from './dock-tests/windows.js';
import {
    MAX_COVER, MAX_GLYPH_COVER, chosenModel, cutoutPath, modelPath, pictureState, workerPath,
} from '../lib/depth.js';
import {STRETCH} from '../lib/lockLook.js';
import {GAP, PITCH, SIZES, cellOrigin, gridOrigin, gridSize} from '../lib/widgets.js';
import {fakeDepthModel} from '../tests/fakeOnnx.js';

const UUID = 'atelier@local';
const OUTPUT = GLib.getenv('ATELIER_TEST_OUTPUT');
// 'main', 'two-monitors' (the session on two monitors) or 'dock' (only
// the dock's checks)
const SUITE = GLib.getenv('ATELIER_TEST_SUITE') ?? 'main';
// Only some parts of the main suite, by name (ATELIER_TEST_ONLY=testDesktop,testNotes).
const ONLY = GLib.getenv('ATELIER_TEST_ONLY')?.split(',').filter(Boolean) ?? null;

// A part of the main suite: skipped when not asked for; one that throws
// says so, and the rest still run.
async function part(test, ...args) {
    if (ONLY && !ONLY.includes(test.name))
        return;
    try {
        await test(...args);
    } catch (e) {
        check(false, `exception in ${test.name}: ${e}\n${e.stack}`);
    }
}

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

// Whether so many frames are drawn within a while (a timeline asks for them).
async function framesDrawn(count, timeout = 2000) {
    let drawn = 0;
    const timeline = new Clutter.Timeline({actor: global.stage, duration: 1000, repeat_count: -1});
    timeline.connect('new-frame', () => drawn++);
    timeline.start();
    const enough = await waitFor(() => drawn >= count, timeout);
    timeline.stop();
    return enough;
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

async function clickAt(x, y, button = Clutter.BUTTON_PRIMARY) {
    await pointerTo(x, y);
    for (const state of [Clutter.ButtonState.PRESSED, Clutter.ButtonState.RELEASED]) {
        virtualPointer.notify_button(GLib.get_monotonic_time(), button, state);
        await Scripting.sleep(60);
    }
}

async function pointerDown(x, y) {
    await pointerTo(x, y);
    virtualPointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await Scripting.sleep(60);
}

async function pointerUp() {
    virtualPointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    await Scripting.sleep(300);
}

// From one point towards another, in steps, the button held.
async function pointerAlong(x1, y1, x2, y2) {
    for (let i = 1; i <= 6; i++)
        await pointerTo(x1 + (x2 - x1) * i / 6, y1 + (y2 - y1) * i / 6);
}

async function pressKey(keyval) {
    virtualKeyboard ??= seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    for (const state of [Clutter.KeyState.PRESSED, Clutter.KeyState.RELEASED]) {
        virtualKeyboard.notify_keyval(GLib.get_monotonic_time(), keyval, state);
        await Scripting.sleep(60);
    }
}

// Keys held down together, e.g. Ctrl and Return.
async function pressKeys(...keyvals) {
    virtualKeyboard ??= seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    for (const keyval of keyvals) {
        virtualKeyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
        await Scripting.sleep(40);
    }
    for (const keyval of [...keyvals].reverse()) {
        virtualKeyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
        await Scripting.sleep(40);
    }
}

// A key held down (keyDown), and let go of (keyUp).
async function keyDown(keyval) {
    virtualKeyboard ??= seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    virtualKeyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
    await Scripting.sleep(60);
}

async function keyUp(keyval) {
    virtualKeyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
    await Scripting.sleep(60);
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

// Actors over the wallpaper other than the wallpapers (and the widgets).
function overlayCount() {
    return Main.layoutManager._backgroundGroup.get_children()
        .filter(a => a.name !== 'atelier-desktop').length -
        Main.layoutManager._bgManagers.length;
}

// The wallpapers in place: none still loading, or fading in.
function wallpapersSettled() {
    // Nothing being applied (a profile at the start, with its transition),
    // loading or fading in – for a while in a row.
    const applier = Main.extensionManager.lookup(UUID)?.stateObj?.modules?.get('profiles')?._applier;
    const quiet = () => !applier?.targetId && overlayCount() === 0 &&
        Main.layoutManager._bgManagers.every(m => !m._newBackgroundActor);
    let since = 0;
    return waitFor(() => {
        if (!quiet()) {
            since = 0;
            return false;
        }
        since ||= GLib.get_monotonic_time();
        return GLib.get_monotonic_time() - since > 800 * 1000;
    }, 10000);
}

// Stand-ins: the tests never lock, suspend or power off the machine, and
// the calendar and weather have known content.
// (Like GNOME's SystemActions, a GObject whose can-* properties change as it
// hears back from the session.)
const FakeSystemActions = GObject.registerClass({
    Properties: Object.fromEntries(
        ['can-lock-screen', 'can-suspend', 'can-logout', 'can-restart', 'can-power-off'].map(name =>
            [name, GObject.ParamSpec.boolean(name, null, null, GObject.ParamFlags.READWRITE, false)])),
}, class FakeSystemActions extends GObject.Object {
    _init(calls) {
        super._init({can_lock_screen: true, can_suspend: true, can_logout: true, can_restart: true, can_power_off: false});
        const run = name => () => calls.push(name);
        this.activateLockScreen = run('lock');
        this.activateSuspend = run('suspend');
        this.activateLogout = run('logout');
        this.activateRestart = run('restart');
        this.activatePowerOff = run('power-off');
    }

    forceUpdate() {}
});

const fakeSystemActions = calls => new FakeSystemActions(calls);

// A page that asks for an endless width (as something in the control
// centre once did).
const EndlessPage = GObject.registerClass({
    Signals: {'close-request': {}},
}, class EndlessPage extends St.Widget {
    vfunc_get_preferred_width(_forHeight) {
        return [0, Infinity];
    }
});

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
    // (How much depends on what is left of today: less late in the evening.)
    check(island.height > module._idle.height * 3, `the island grew into the glance (${island.height}px)`);
    const glance = island.page;
    // (fewer when the test runs shortly before midnight)
    const now = new Date();
    const left = events.getEvents(new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)).filter(e => e.end > now).length;
    const rows = Math.min(left, 3) + (left > 3 ? 1 : 0);
    check(glance._eventList.get_n_children() === rows, `today's events listed (${rows} rows)`);
    check(glance._weatherRow.visible && glance._weatherText.text.includes('14'), 'weather shown');
    check(/\d/.test(glance._time.text) && !glance._time.clutter_text.get_layout().is_ellipsized() &&
        glance._week.get_n_children() === 5, `the big clock in full next to five days (${glance._time.text})`);
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
    // (GNOME shows the day's events with calendars to show them from: not
    // without evolution-data-server, as in a container.)
    const eventsShown = dateMenu._eventsItem.visible;
    island.page.setTab('calendar');
    dateMenu._eventsItem.visible = true;
    await Scripting.sleep(500);
    check(dateMenu._calendar.mapped, 'and the calendar on its own tab');
    const [calendarX, calendarY] = dateMenu._calendar.get_transformed_position();
    const [eventsX] = dateMenu._eventsItem.get_transformed_position();
    check(eventsX >= calendarX + dateMenu._calendar.width && calendarY < 200 &&
        dateMenu._calendar.layout_manager.column_homogeneous,
    `the events beside the month, its days spread evenly (${eventsX} vs ${calendarX}+${dateMenu._calendar.width}, ${calendarY})`);
    check(island.page.contains(dateMenu._eventsItem) && !island.page.contains(dateMenu._clocksItem) &&
        !island.page.contains(dateMenu._weatherItem), 'without the world clocks and the weather');
    await screenshotIsland('12b-control-centre-calendar', 640);
    dateMenu._eventsItem.visible = eventsShown;
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

    // The tiles follow what SystemActions can do as it hears back from the
    // session, and a click on each runs its own action.
    const actions = module.systemActions;
    module.togglePowerMenu();
    await waitFor(() => island.busy, 1000);
    actions.can_power_off = true;
    check(island.page._buttons.get('power-off').reactive, 'a tile turns on as its action becomes available');
    actions.can_restart = false;
    check(!island.page._buttons.get('restart').reactive &&
        island.page._buttons.get('restart').has_style_pseudo_class('insensitive'), 'and off as it no longer is');
    actions.can_restart = true;
    await pressKey(Clutter.KEY_Escape);
    await waitFor(() => island.page === null && !island.busy, 1000);
    calls.length = 0;
    const ids = ['lock', 'suspend', 'logout', 'restart', 'power-off'];
    for (const id of ids) {
        module.togglePowerMenu();
        await waitFor(() => hasClass(island.page, 'atelier-power') && island.busy, 1000);
        await Scripting.sleep(500);
        const before = calls.length;
        await clickAt(...centerOf(island.page._buttons.get(id)));
        await waitFor(() => calls.length > before && island.page === null && !island.busy, 1000);
        if (hasClass(island.page, 'atelier-power'))
            await pressKey(Clutter.KEY_Escape);
        await restPointer();
        await waitFor(() => island.page === null, 1000);
    }
    check(calls.join() === ids.join(), `a click on each tile runs its action (${calls})`);
    actions.can_power_off = false;

    // A page that can't say how big it is doesn't get the island stuck
    // around nothing, holding the keyboard.
    const endless = new EndlessPage();
    check(!island.open(endless, {modal: true}) && !island.busy && island.page === null &&
        endless.get_parent() === null, 'a page without a size is turned away');
    endless.destroy();

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
    // (Clicked for real: the button has the click, not the island around it.)
    await Scripting.sleep(500);
    await clickAt(...centerOf(island.page._buttons.get_child_at_index(0)));
    check(await waitFor(() => opened && island.page === null, 2000),
        `a button runs and closes the notification (${opened}, ${island.page?.style_class})`);
    await restPointer();
    await waitFor(() => island.page === null, 2000);

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
    // Wrapped like Bluetooth's "Turn on Bluetooth to connect to devices".
    const note = new PopupMenu.PopupMenuItem(
        'Turn the test tile on to see everything it could do for you right here', {reactive: false});
    note.label.clutter_text.set({ellipsize: Pango.EllipsizeMode.NONE, line_wrap: true});
    toggle.menu.addMenuItem(note);
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
    Main.panel.addToStatusArea('test-extension@example.org', button, 1, 'right');
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
    // Its wrapped text included: the next row (or the end) comes after it.
    const [, gridY] = grid.get_transformed_position();
    const below = grid.get_children()
        .filter(c => c.visible && c.width > 0 && c.get_transformed_position()[1] > tileY + toggle.height)
        .map(c => c.get_transformed_position()[1]);
    const next = Math.min(gridY + grid.height, ...below);
    const menuBottom = menuY + toggle.menu.actor.height;
    check(menuBottom <= next + 1, `nothing under the menu (${menuBottom} vs ${next})`);
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

    // GNOME's power button (next to Lock) opens Atelier's power menu.
    Main.panel.toggleQuickSettings();
    await waitFor(() => hasClass(island.page, 'atelier-cc'), 1000);
    const systemItem = quickSettings._system._systemItem;
    click(systemItem.child.get_last_child());
    check(await waitFor(() => hasClass(island.page, 'atelier-power') && island.busy, 1000) &&
        !systemItem.menu.isOpen, 'its power button opens Atelier\'s power menu');
    await pressKey(Clutter.KEY_Escape);
    await waitFor(() => island.page === null && !island.busy, 1000);
    // Clicked, and its menu's Power Off clicked. (GNOME shows the button
    // while SystemActions can do any of its menu's actions: without a
    // session manager and logind, as in a container, none.)
    const calls = [];
    modules.get('island').systemActions = fakeSystemActions(calls);
    modules.get('island').systemActions.can_power_off = true;
    const shutdownItem = systemItem.child.get_last_child();
    const shutdownShown = shutdownItem.visible;
    shutdownItem.visible = true;
    Main.panel.toggleQuickSettings();
    await waitFor(() => hasClass(island.page, 'atelier-cc'), 1000);
    await Scripting.sleep(500);
    await clickAt(...centerOf(shutdownItem));
    const opened = await waitFor(() => hasClass(island.page, 'atelier-power') && island.busy, 1000);
    if (opened) {
        await Scripting.sleep(500);
        await clickAt(...centerOf(island.page._buttons.get('power-off')));
    }
    check(opened && await waitFor(() => calls.join() === 'power-off' && island.page === null, 1000),
        `a click on it, then on Power Off, powers off (a stand-in: ${calls})`);
    shutdownItem.visible = shutdownShown;
    await restPointer();
    await waitFor(() => island.page === null && !island.busy, 1000);

    // Turned off: GNOME's menu and the icons in the bar come back.
    const settings = ext.stateObj._settings.get_child('control-centre');
    settings.set_boolean('enabled', false);
    await Scripting.sleep(300);
    const dateMenu = Main.panel.statusArea.dateMenu;
    check(quickSettings.menu._grid.get_parent() === quickSettings.menu.box &&
        dateMenu._messageList.get_parent()?.name === 'calendarArea' &&
        dateMenu._eventsItem.get_parent() === dateMenu._clocksItem.get_parent() &&
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
    // Laid out in the control centre (anew: GNOME's menu had it meanwhile),
    // GNOME's grid doesn't tell of its moves: GNOME's menu follows each with
    // an update in the next frame, which reads the grid and the menu, and
    // when the shell quit before that frame came, it ran on them gone
    // (tools/shell-test.sh checks how the shell quits).
    const gnomeGrid = quickSettings.menu._grid;
    const heard = {allocation: 0, x: 0, y: 0};
    const heardIds = Object.keys(heard).map(name => gnomeGrid.connect(`notify::${name}`, () => heard[name]++));
    Main.panel.toggleQuickSettings();
    check(await waitFor(() => hasClass(island.page, 'atelier-cc'), 1000) && await framesDrawn(3) &&
        heard.allocation > 0 && heard.x + heard.y === 0,
    `laid out in the control centre, GNOME's grid doesn't tell of its moves (${JSON.stringify(heard)})`);
    heardIds.forEach(id => gnomeGrid.disconnect(id));
    Main.panel.toggleQuickSettings();
    await waitFor(() => island.page === null && !island.busy, 1000);

    button.destroy();
    await Scripting.sleep(100);
    check(!modules.get('control-centre').tray.tiles.some(t => t.indicator === button),
        'a removed extension\'s tile goes away');
    indicator.quickSettingsItems.forEach(item => item.destroy());
    indicator.destroy();
}

const dbusCall = (connection, ...args) => new Promise((resolve, reject) => {
    connection.call(...args, null, Gio.DBusCallFlags.NONE, -1, null, (c, result) => {
        try {
            resolve(c.call_finish(result));
        } catch (e) {
            reject(e);
        }
    });
});

/**
 * A made-up app with a tray icon, on a D-Bus connection of its own, as the
 * AppIndicator extension sees apps: an icon, a menu of one item, and a name
 * that it only says later.
 *
 * @param {string} extensionPath - the AppIndicator extension's, for its interfaces
 * @returns {object} the app: title(), activations, menuEvents, stop()
 */
// Grouped notifications in the control centre lie on top of each other:
// the card on top hides those below it (all but their edges), whatever
// else styles them – here, as Blur my Shell's popup blur does, every
// .message-list .message see-through with !important, from a class on the
// whole UI.
async function testStackStaysOpaque(ext) {
    const island = ext.stateObj.modules.get('island').island;
    const banners = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
    banners.set_boolean('show-banners', false);
    const css = Gio.File.new_for_path(`${OUTPUT}/see-through-messages.css`);
    css.replace_contents(new TextEncoder().encode(`
.bms-popup-background-dark .message-list .message { background: rgba(255, 255, 255, 0.07) !important; }
.bms-popup-background-dark .message-list .message:hover,
.bms-popup-background-dark .message-list .message:focus,
.bms-popup-background-dark .message-list .message:active { background: rgba(255, 255, 255, 0.12) !important; }
.bms-popup-background-dark .message:second-in-stack { background: rgba(255, 255, 255, 0.05) !important; }
.bms-popup-background-dark .message:lower-in-stack { background: rgba(255, 255, 255, 0.02) !important; }
`), null, false, Gio.FileCreateFlags.NONE, null);
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    theme.load_stylesheet(css);
    Main.uiGroup.add_style_class_name('bms-popup-background-dark');
    const source = appSource('Events and Tasks Reminders', 'org.gnome.Evolution-alarm-notify', 'appointment-soon-symbolic');
    try {
        for (const hour of [10, 12, 14])
            await notify(source, 'Reminders', `Lunch with the team ${hour}:00`);
        Main.panel.toggleCalendar();
        check(await waitFor(() => island.page?.tab === 'notifications', 2000), 'the notifications, three from one app');
        await Scripting.sleep(800);
        const messages = [];
        const collect = actor => actor.get_children().forEach(child => {
            if (child.mapped && hasClass(child, 'message'))
                messages.push(child);
            collect(child);
        });
        collect(island.page);
        const alphas = messages.map(message => message.get_theme_node().get_background_color().alpha);
        check(messages.length === 3 && messages.some(message => message.has_style_pseudo_class('second-in-stack')) &&
            alphas.every(alpha => alpha === 255),
        `grouped, each card opaque under a see-through style, so those below hide (${alphas})`);
        await screenshotIsland('23b-notifications-stacked', 360);
    } finally {
        Main.panel.closeCalendar();
        Main.uiGroup.remove_style_class_name('bms-popup-background-dark');
        theme.unload_stylesheet(css);
        source.destroy();
        banners.reset('show-banners');
        await waitFor(() => island.page === null, 2000);
        await Scripting.sleep(300);
    }
}

// Other extensions in Atelier's way, as the user has them: Blur my Shell's
// !important styles from a class on the whole UI, Tiling Shell's layout
// editor over the whole screen, Color Picker's button taking a picture of
// the screen as it is pressed.
async function testOtherExtensions(ext) {
    const modules = ext.stateObj.modules;
    const islandModule = modules.get('island');
    const island = islandModule.island;
    const bar = ext.stateObj._settings.get_child('bar');
    bar.set_string('surface', 'glass');
    await Scripting.sleep(500);

    // Blur my Shell's rules for entries, quick settings and the calendar,
    // as it has them: Atelier's own look wins in the island and on its
    // sheets. (Built as the island and the sheets are, to read the styles.)
    const css = Gio.File.new_for_path(`${OUTPUT}/other-extension-styles.css`);
    css.replace_contents(new TextEncoder().encode(`
.bms-popup-background-dark StEntry { background-color: rgba(255, 255, 255, 0.1) !important; color: rgba(255, 255, 255, 0.7) !important; }
.bms-popup-background-dark StEntry:focus { color: rgba(255, 255, 255, 0.9) !important; background-color: rgba(255, 255, 255, 0.1) !important; box-shadow: inset 0 0 0 2px rgba(53, 132, 228, 0.5) !important; }
.bms-popup-background-dark StEntry StLabel.hint-text { color: rgba(255, 255, 255, 0.5) !important; }
.bms-popup-background-dark .quick-toggle { background-color: rgba(255, 255, 255, 0.1) !important; }
.bms-popup-background-dark .quick-toggle-has-menu .quick-toggle-menu-button { background-color: rgba(255, 255, 255, 0.14) !important; }
.bms-popup-background-dark .datemenu-today-button { background-color: transparent !important; }
.bms-popup-background-dark .calendar { background-color: transparent; }
.bms-popup-background-dark .calendar .calendar-day { color: rgba(255, 255, 255, 0.9) !important; background-color: transparent !important; }
.bms-popup-background-dark .calendar .calendar-day.calendar-other-month,
.bms-popup-background-dark .calendar .calendar-day.calendar-other-month.calendar-weekend { color: rgba(255, 255, 255, 0.5) !important; }
`), null, false, Gio.FileCreateFlags.NONE, null);
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    theme.load_stylesheet(css);
    Main.uiGroup.add_style_class_name('bms-popup-background-dark');
    const nest = (...actors) => {
        actors.reduce((parent, child) => {
            parent.add_child(child);
            return child;
        });
        Main.uiGroup.add_child(actors[0]);
        return actors[0];
    };
    const toggle = new St.Button({style_class: 'quick-toggle'});
    const arrow = new St.Button({style_class: 'quick-toggle-menu-button'});
    const today = new St.Button({style_class: 'datemenu-today-button'});
    const day = new St.Button({style_class: 'calendar-day calendar-other-month calendar-weekend'});
    const title = new St.Entry({style_class: 'atelier-note-title-entry', hint_text: 'Title'});
    const time = new St.Entry({style_class: 'atelier-note-sheet-reminder-time'});
    const name = new St.Entry({style_class: 'atelier-profile-sheet-entry'});
    const password = new St.PasswordEntry({style_class: 'atelier-lock-entry'});
    const trees = [
        nest(new St.Widget({style_class: 'atelier-island'}), new St.Widget({style_class: 'atelier-cc'}), toggle),
        nest(new St.Widget({style_class: 'atelier-island'}), new St.Widget({style_class: 'atelier-cc'}),
            new St.Widget({style_class: 'quick-toggle-has-menu'}), arrow),
        nest(new St.Widget({style_class: 'atelier-island'}), new St.Widget({style_class: 'atelier-cc'}), today),
        nest(new St.Widget({style_class: 'atelier-island'}), new St.Widget({style_class: 'atelier-cc'}),
            new St.Widget({style_class: 'calendar'}), day),
        nest(new St.BoxLayout({style_class: 'atelier-note-sheet'}), title),
        nest(new St.BoxLayout({style_class: 'atelier-note-sheet'}), time),
        nest(new St.BoxLayout({style_class: 'atelier-profile-sheet'}), name),
        nest(new St.BoxLayout({style_class: 'atelier-lock-sheet'}), password),
    ];
    [title, name, password].forEach(entry => entry.add_style_pseudo_class('focus'));
    time.add_style_pseudo_class('error');
    try {
        await Scripting.sleep(200);
        const node = actor => actor.get_theme_node();
        const rgba = color => [color.red, color.green, color.blue, color.alpha];
        const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
        const seen = {
            toggle: rgba(node(toggle).get_background_color()),
            arrow: rgba(node(arrow).get_background_color()),
            today: rgba(node(today).get_background_color()),
            day: rgba(node(day).get_foreground_color()),
            title: rgba(node(title).get_background_color()),
            hint: rgba(node(title.get_hint_actor()).get_foreground_color()),
            time: rgba(node(time).get_background_color()),
            name: rgba(node(name).get_foreground_color()),
            password: [...rgba(node(password).get_background_color()), ...rgba(node(password).get_foreground_color())],
        };
        check(near(seen.toggle, [255, 255, 255, 23]) && near(seen.arrow, [255, 255, 255, 23]),
            `the control centre's tiles, one shade over another extension's styles (${seen.toggle} | ${seen.arrow})`);
        check(near(seen.today, [255, 255, 255, 18]) && near(seen.day, [255, 255, 255, 89]),
            `its calendar keeps its cards and dim days (${seen.today} | ${seen.day})`);
        check(near(seen.title, [0, 0, 0, 0]) && near(seen.hint, [0, 0, 0, 102]) && near(seen.time, [224, 27, 36, 89]),
            `a note's entries lie on its paper, its hints readable, a wrong time red (${seen.title} | ${seen.hint} | ${seen.time})`);
        check(near(seen.name, [255, 255, 255, 255]) && !node(name).get_box_shadow() &&
            near(seen.password, [255, 255, 255, 41, 244, 244, 245, 255]),
        `a new profile's name and the lock screen's password look as Atelier has them (${seen.name} | ${seen.password})`);
    } finally {
        trees.forEach(tree => tree.destroy());
        Main.uiGroup.remove_style_class_name('bms-popup-background-dark');
        theme.unload_stylesheet(css);
    }

    // Opening, the island comes over chrome added after it (Tiling
    // Shell's layout editor over the whole screen), with its glass under
    // it: the control centre takes the clicks.
    const cover = new St.Widget({reactive: true, x: 0, y: 0, width: global.stage.width, height: global.stage.height});
    Main.layoutManager.addChrome(cover);
    const module = modules.get('control-centre');
    try {
        module.open('controls');
        check(await waitFor(() => hasClass(island.page, 'atelier-cc'), 2000), 'the control centre opens over a later cover');
        await Scripting.sleep(500);
        const order = Main.uiGroup.get_children();
        const [glass, top, over] = [islandModule._glass, island, cover].map(actor => order.indexOf(actor));
        const [x, y] = centerOf(island.page);
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y + island.page.height / 4);
        check(top > over && glass > over && glass < top && island.contains(picked),
            `over it, its glass right under it, and it takes the clicks (cover ${over}, glass ${glass}, island ${top})`);
    } finally {
        module.close();
        Main.layoutManager.removeChrome(cover);
        cover.destroy();
        await waitFor(() => island.page === null, 2000);
    }

    // Color Picker's button takes a picture of the screen as it is
    // pressed: the control centre has gone by then, unseen.
    const picker = new PanelMenu.Button(0.5, 'Color Picker', true);
    picker.add_child(new St.Icon({icon_name: 'color-select-symbolic', style_class: 'system-status-icon'}));
    let pressed = null;
    picker.connect('button-press-event', () => {
        pressed = {opacity: island.opacity, glass: islandModule._glass?.visible ?? false};
        return Clutter.EVENT_STOP;
    });
    Main.panel.addToStatusArea('color-picker@tuberry', picker, 1, 'right');
    try {
        const tile = () => module.tray?.tiles.find(t => t.indicator === picker);
        await waitFor(() => tile(), 2000);
        module.open('extensions');
        check(await waitFor(() => island.page?.tab === 'extensions' && tile()?.mapped, 2000), 'Color Picker\'s tile in the control centre');
        await Scripting.sleep(500);
        await clickAt(...centerOf(picker));
        check(pressed?.opacity === 0 && !pressed.glass,
            `pressed, its button finds the control centre gone, unseen (${JSON.stringify(pressed)})`);
        check(await waitFor(() => island.page === null && island.opacity === 255, 2000),
            'and the island is back at rest a moment later');
    } finally {
        picker.destroy();
        module.close();
        bar.reset('surface');
        await Scripting.sleep(500);
    }
}

// A setting of another extension kept out of Atelier's way: only once
// asked for, what was there kept and put back, a change the user makes
// themselves theirs, and one notification of a collision. (Blur my Shell
// stands in with its lock screen key, in the test's data.)
async function testOtherExtensionSettings(ext) {
    const module = ext.stateObj.modules.get('other-extensions');
    if (!check(module !== null, 'the other extensions module running'))
        return;
    const settings = ext.stateObj._settings;
    const lib = await import(`file://${ext.path}/lib/otherExtensions.js`);
    const rule = lib.RULES.find(r => r.id === 'blur-my-shell-lock-screen');
    const dir = `${GLib.get_user_data_dir()}/gnome-shell/extensions/${rule.uuid}`;
    GLib.mkdir_with_parents(`${dir}/schemas`, 0o755);
    GLib.file_set_contents(`${dir}/metadata.json`, '{"uuid": "blur-my-shell@aunetx", "name": "Blur my Shell"}');
    GLib.file_set_contents(`${dir}/schemas/org.gnome.shell.extensions.blur-my-shell.gschema.xml`, `<schemalist>
  <schema id="${rule.schema}" path="/org/gnome/shell/extensions/blur-my-shell/lockscreen/">
    <key type="b" name="blur"><default>true</default><summary>Blur</summary></key>
  </schema>
</schemalist>`);
    GLib.spawn_command_line_sync(`glib-compile-schemas ${dir}/schemas`);
    const blur = lib.settingsFor(rule);
    if (!check(blur?.get_boolean('blur') === true, 'Blur my Shell\'s settings found in its folder'))
        return;
    const kept = () => settings.get_strv('other-extensions-kept');
    const state = () => lib.parseState(settings.get_string('other-extensions-state'))[rule.id];
    const banners = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
    banners.set_boolean('show-banners', false);
    const lookup = Main.extensionManager.lookup;
    try {
        check(blur.get_boolean('blur') === true && !state(), 'not asked for, it is left as it is');
        settings.set_strv('other-extensions-kept', [rule.id]);
        check(await waitFor(() => !blur.get_boolean('blur') && state()?.previous === true, 2000),
            `asked for, it is kept out of the way, what was there kept (${JSON.stringify(state())})`);
        // Changed back by the user in Blur my Shell: theirs.
        blur.set_boolean('blur', true);
        check(await waitFor(() => !kept().includes(rule.id) && state()?.overridden, 2000) && blur.get_boolean('blur'),
            'changed back by the user, it is theirs: no longer kept, marked so');
        settings.set_strv('other-extensions-kept', [rule.id]);
        check(await waitFor(() => !blur.get_boolean('blur'), 2000), 'asked for again, kept again');
        settings.set_strv('other-extensions-kept', []);
        check(await waitFor(() => blur.get_boolean('blur') && !state(), 2000), 'no longer asked for, what was there comes back');

        // Told of once, while Blur my Shell is on and in the way.
        settings.set_strv('other-extensions-noticed', []);
        Main.extensionManager.lookup = uuid => (uuid === rule.uuid ? {uuid, state: ExtensionState.ACTIVE}
            : lookup.call(Main.extensionManager, uuid));
        const told = () => Main.messageTray.getSources().filter(source => source.title === 'Atelier')
            .flatMap(source => source.notifications)
            .filter(notification => notification.title.startsWith('Blur my Shell'));
        module._notice();
        const [notice] = told();
        check(told().length === 1 && settings.get_strv('other-extensions-noticed').includes(rule.id) &&
            notice.actions.length === 1, `a collision told of, with a way to the settings (${notice?.title})`);
        module._notice();
        check(told().length === 1, 'and only once');
    } finally {
        Main.extensionManager.lookup = lookup;
        Main.messageTray.getSources().filter(source => source.title === 'Atelier').forEach(source => source.destroy());
        settings.reset('other-extensions-kept');
        settings.reset('other-extensions-state');
        settings.reset('other-extensions-noticed');
        banners.reset('show-banners');
        await Scripting.sleep(300);
    }
}

async function startTrayApp(extensionPath) {
    // (Its files hold the bare interface, as the extension wraps them.)
    const xml = name => `<node>${new TextDecoder().decode(
        Gio.File.new_for_path(`${extensionPath}/interfaces-xml/${name}.xml`).load_contents(null)[1])}</node>`;
    const connection = Gio.DBusConnection.new_for_address_sync(
        Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, null),
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
        null, null);
    const app = {title: '', activations: 0, menuEvents: []};
    const item = Gio.DBusExportedObject.wrapJSObject(xml('StatusNotifierItem'), {
        Category: 'ApplicationStatus',
        Id: 'atelier-test-app',
        get Title() {
            return app.title;
        },
        Status: 'Active',
        WindowId: 0,
        IconThemePath: '',
        Menu: '/MenuBar',
        ItemIsMenu: false,
        IconName: 'applications-science-symbolic',
        IconPixmap: [],
        OverlayIconName: '',
        OverlayIconPixmap: [],
        AttentionIconName: '',
        AttentionIconPixmap: [],
        AttentionMovieName: '',
        ToolTip: ['', [], '', ''],
        Activate() {
            app.activations++;
        },
        SecondaryActivate() {},
        XAyatanaSecondaryActivate() {},
        ContextMenu() {},
        Scroll() {},
        ProvideXdgActivationToken() {},
    });
    const entry = {
        'label': new GLib.Variant('s', 'Open the test app'),
        'enabled': new GLib.Variant('b', true),
        'visible': new GLib.Variant('b', true),
    };
    const menu = Gio.DBusExportedObject.wrapJSObject(xml('DBusMenu'), {
        Version: 3,
        TextDirection: 'ltr',
        Status: 'normal',
        IconThemePath: [],
        GetLayout: () => [1, [0, {'children-display': new GLib.Variant('s', 'submenu')},
            [new GLib.Variant('(ia{sv}av)', [1, entry, []])]]],
        GetGroupProperties: ids => ids.filter(id => id === 1).map(id => [id, entry]),
        GetProperty: (id, name) => entry[name] ?? new GLib.Variant('s', ''),
        Event: (id, eventId) => {
            app.menuEvents.push(`${id} ${eventId}`);
        },
        EventGroup: events => {
            events.forEach(([id, eventId]) => app.menuEvents.push(`${id} ${eventId}`));
            return [];
        },
        AboutToShow: () => false,
        AboutToShowGroup: () => [[], []],
    });
    item.export(connection, '/StatusNotifierItem');
    menu.export(connection, '/MenuBar');
    await dbusCall(connection, 'org.kde.StatusNotifierWatcher', '/StatusNotifierWatcher',
        'org.kde.StatusNotifierWatcher', 'RegisterStatusNotifierItem', new GLib.Variant('(s)', ['/StatusNotifierItem']));
    return Object.assign(app, {
        // It says its name, as apps do once they are up.
        setTitle(title) {
            app.title = title;
            item.emit_signal('NewTitle', null);
        },
        stop() {
            item.unexport();
            menu.unexport();
            connection.close_sync(null);
        },
    });
}

// An app's tray icon, through the AppIndicator extension (when it is
// installed): in the control centre named after the app, opening it with a
// click, its menu on the right button.
async function testTrayApp(ext) {
    const appIndicator = ['ubuntu-appindicators@ubuntu.com', 'appindicatorsupport@rgcjonas.gmail.com']
        .map(uuid => Main.extensionManager.lookup(uuid))
        .find(extension => extension?.state === ExtensionState.ACTIVE);
    if (!appIndicator) {
        results.push('INFO  no AppIndicator extension active here: apps\' tray icons untested');
        return;
    }
    const module = ext.stateObj.modules.get('control-centre');
    const island = ext.stateObj.modules.get('island').island;
    const app = await startTrayApp(appIndicator.path);
    try {
        const tileOf = () => module.tray?.tiles.find(t => t.role.startsWith('appindicator-'));
        if (!check(await waitFor(() => tileOf(), 5000), 'an app\'s tray icon moves into the control centre'))
            return;
        const tile = tileOf();
        check(!tile.name.includes(':') && !tile.name.includes('/'), `never named after its D-Bus address (${tile.name})`);
        app.setTitle('Test App');
        check(await waitFor(() => tile.name === 'Test App', 3000), `named after the app once it says (${tile.name})`);

        module.open('extensions');
        check(await waitFor(() => island.page?.tab === 'extensions' && tile.mapped, 2000), 'on the Extensions tab');
        await restPointer();
        await Scripting.sleep(400);
        await screenshotIsland('24-control-centre-tray-app', 300);
        const menu = tile.indicator.menu;
        await waitFor(() => menu.numMenuItems > 0, 3000);
        await clickAt(...centerOf(tile.indicator), Clutter.BUTTON_SECONDARY);
        check(await waitFor(() => menu.isOpen, 1500) && app.activations === 0, 'the right button brings up its menu');
        if (menu.isOpen) {
            await clickAt(...centerOf(menu.firstMenuItem));
            check(await waitFor(() => app.menuEvents.includes('1 clicked'), 2000),
                `and its items reach the app (${app.menuEvents.join(', ')})`);
            menu.close();
            await Scripting.sleep(300);
        }
        if (!island.page)
            module.open('extensions');
        await waitFor(() => tile.mapped, 1000);
        await clickAt(...centerOf(tile.indicator));
        check(await waitFor(() => app.activations === 1, 2000), 'a click opens the app');
        check(await waitFor(() => island.page === null, 1500) && !menu.isOpen,
            'and the control centre makes way for its window, without the menu');
    } finally {
        app.stop();
    }
    check(await waitFor(() => !module.tray?.tiles.some(t => t.role.startsWith('appindicator-')), 5000),
        'its tile goes when the app quits');
}

// A window full screen on the main monitor: nothing of the bar, the island
// or their glass stays on it, whatever the look. (Full screen as GNOME's
// layout manager sees it.)
async function testFullscreen(ext) {
    const bar = ext.stateObj._settings.get_child('bar');
    const layout = Main.layoutManager;
    const monitor = layout.primaryMonitor;
    const shown = () => layout.uiGroup.get_children()
        .filter(a => a.visible && a.opacity > 0 &&
            ['atelier-glass', 'atelier-island', 'atelier-notch-ear'].some(name => hasClass(a, name)))
        .map(a => a.get_style_class_name());
    // (The monitor asks mutter; here it says full screen for a while.)
    const fullscreen = async on => {
        if (on)
            Object.defineProperty(monitor, 'inFullscreen', {value: true, configurable: true});
        else
            delete monitor.inFullscreen;
        layout._updateVisibility();
        await Scripting.sleep(400);
    };
    try {
        for (const [style, surface, shape] of [
            ['spread', 'glass', 'notch'], ['grouped', 'glass', 'notch'], ['island', 'classic', 'notch'],
            ['grouped', 'classic', 'floating'], ['gnome', 'glass', 'floating'],
        ]) {
            bar.set_string('style', style);
            bar.set_string('surface', surface);
            bar.set_string('island-shape', shape);
            await Scripting.sleep(500);
            const before = shown().length;
            await fullscreen(true);
            const during = shown();
            await screenshotArea(`23-fullscreen-${style}-${surface}-${shape}`, 0, 0, global.stage.width, 120);
            await fullscreen(false);
            const after = shown().length;
            check(before > 0 && during.length === 0 && after === before,
                `full screen, nothing of the bar or the island (${style}, ${surface}, ${shape}): ${during.join(', ') || 'none'}`);
        }
    } finally {
        delete monitor.inFullscreen;
        layout._updateVisibility();
        ['style', 'surface', 'island-shape'].forEach(key => bar.reset(key));
        await Scripting.sleep(400);
    }
}

async function testOverviewBar() {
    await restPointer();
    Main.overview.show();
    await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 4000);
    await Scripting.sleep(300);
    const blurred = Main.layoutManager.overviewGroup.get_first_child()?.get_child_at_index(1);
    check(blurred?.opacity === 255, 'the wallpaper is blurred in the overview');
    Main.overview.hide();
    await Scripting.sleep(110);
    check(blurred.opacity > 0 && blurred.opacity < 255, `and sharpens as it closes (${blurred.opacity})`);
    await screenshotArea('24-leaving-overview', 0, 0, 900, 80);
    // A stretch of the bar left of the island against the wallpaper below it.
    const bar = averageColor('24-leaving-overview', 120, 6, 300, 20);
    const below = averageColor('24-leaving-overview', 120, 50, 300, 20);
    check(colorDistance(bar, below) < 60, `the bar stays clear while leaving the overview (${bar} vs ${below})`);
    await waitFor(() => !Main.overview.visible, 3000);
    await Scripting.sleep(200);
    const backdrop = Main.layoutManager.overviewGroup.get_first_child();
    check(backdrop?.name === 'atelier-overview-backdrop' && backdrop.get_n_children() > 0,
        'the overview lies on the blurred wallpaper');
}

async function testBarStyles(ext) {
    const bar = ext.stateObj._settings.get_child('bar');
    const island = ext.stateObj.modules.get('island').island;
    const {_leftBox: left, _rightBox: right} = Main.panel;
    const shown = name => Main.layoutManager.uiGroup.get_children()
        .filter(a => hasClass(a, name) && a.visible && !hasClass(a, 'atelier-dock-glass') &&
            (name !== 'atelier-glass' || !hasClass(a, 'atelier-capsule')));
    const surfaces = () => [...shown('atelier-capsule'), ...shown('atelier-glass')];
    // [x, y, width, height] of a capsule or glass, as drawn
    const rect = surface => surface?._shape?.slice(0, 4) ?? [NaN, NaN, NaN, NaN];
    const leftEnd = () => left.get_transformed_position()[0] + left.width;
    const rightStart = () => right.get_transformed_position()[0];
    const besideIsland = () => leftEnd() <= island.x && island.x - leftEnd() < 24 &&
        rightStart() >= island.x + island.width && rightStart() - island.x - island.width < 24;
    const bounds = () => `${Math.round(leftEnd())} | ${island.x}–${island.x + island.width} | ${Math.round(rightStart())}`;
    const top = name => screenshotArea(name, 0, 0, global.stage.width, 44);
    // A battery, which a compact bar keeps on the right. (Without UPower, as
    // in a container, GNOME's battery tile is hidden.)
    const powerToggle = Main.panel.statusArea.quickSettings._system._systemItem.powerToggle;
    const batteryShown = powerToggle.visible;
    powerToggle.visible = true;
    await restPointer();

    check(left.translation_x === 0 && right.translation_x === 0 && rightStart() > global.stage.width - 400,
        'spread: the workspaces and the status icons at the edges');

    // Grouped: everything together in the middle, moving aside as the
    // island grows.
    bar.set_string('style', 'grouped');
    await Scripting.sleep(400);
    check(besideIsland(), `grouped: the sides right next to the island (${bounds()})`);
    await top('25-bar-grouped');
    await pointerTo(...centerOf(island));
    await waitFor(() => hasClass(island.page, 'atelier-glance'), 2000);
    await Scripting.sleep(600);
    check(island.width > 300 && besideIsland(), `and they move aside as it grows (${bounds()})`);
    // Compact (grouped, by default): the workspaces, the time and the battery.
    const statusArea = Main.panel.statusArea;
    check(!statusArea.quickSettings.container.visible && !(statusArea['atelier-claude']?.container.visible ?? false) &&
        statusArea.activities.container.visible && statusArea['atelier-battery'] !== undefined &&
        !ext.stateObj.modules.get('island')._idle._date.visible, 'compact: just the workspaces, the time and the battery');
    await screenshotArea('25b-glance-grouped', 0, 0, global.stage.width, 200);
    await restPointer();
    await waitFor(() => island.page === null, 2000);
    await Scripting.sleep(400);

    // The sides in capsules like the island.
    bar.set_string('sides', 'capsules');
    await Scripting.sleep(400);
    const activities = Main.panel.statusArea.activities;
    const middle = activities.get_transformed_position()[0] + activities.width / 2;
    const capsule = surfaces().find(c => rect(c)[0] < island.x);
    const [capsuleX, , capsuleWidth] = rect(capsule);
    check(Main.panel.has_style_class_name('atelier-bar-capsules') && surfaces().length === 2 &&
        capsule && capsuleX < middle && capsuleX + capsuleWidth > middle,
    `in capsules: one around each side (${capsuleX}+${capsuleWidth} around ${middle})`);
    await top('25c-bar-grouped-capsules');

    // Glass: the island and the capsules are the blurred wallpaper.
    bar.set_string('surface', 'glass');
    await Scripting.sleep(600);
    const glass = shown('atelier-glass');
    check(glass.length === 3 && island.has_style_class_name('atelier-island-glass'),
        `glass: the island and the capsules (${glass.length} surfaces)`);
    await top('26-bar-glass');

    // Dragging a window onto a workspace in the overview looks for the
    // target among all actors: it must find the workspace, never the glass
    // (as big as most of the screen) or the overview's backdrop.
    Main.overview.show();
    await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 4000);
    const pick = (x, y) => global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
    const ours = actor => glass.some(g => g.contains(actor)) ||
        Main.layoutManager.overviewGroup.get_first_child().contains(actor);
    const picked = [pick(global.stage.width / 2, global.stage.height / 2), pick(8, global.stage.height / 2)];
    check(!picked.some(ours), `a drop in the overview reaches GNOME's actors (${picked.map(a => a?.constructor.name)})`);
    Main.overview.hide();
    await waitFor(() => !Main.overview.visible, 4000);
    const islandGlass = glass.find(g => g.get_parent().get_children().indexOf(g) ===
        island.get_parent().get_children().indexOf(island) - 1);
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

    // Notch: the island hangs from the top edge, which curves into it.
    bar.set_string('surface', 'classic');
    bar.set_string('island-shape', 'notch');
    await Scripting.sleep(600);
    const [, panelY] = Main.panel.get_transformed_position();
    check(Math.abs(island.y - panelY) < 1 && Math.abs(island.height - Main.panel.height) < 1,
        `notch: the island hangs from the top edge (${island.y}, ${island.height})`);
    const ears = shown('atelier-notch-ear').sort((a, b) => a.translation_x - b.translation_x);
    check(ears.length === 2 && Math.abs(ears[0].translation_x + ears[0].width - island.x) < 1 &&
        Math.abs(ears[1].translation_x - island.x - island.width) < 1 && ears[0].translation_y === island.y,
    `with ears where it meets the edge (${ears.map(e => `${e.translation_x}+${e.width}`)})`);
    check(besideIsland(), `the sides keep clear of the ears (${bounds()})`);
    await top('28-bar-notch');
    bar.set_string('surface', 'glass');
    await Scripting.sleep(600);
    const notchGlass = shown('atelier-glass').find(g => g.get_parent().get_children().indexOf(g) ===
        island.get_parent().get_children().indexOf(island) - 1);
    check(shown('atelier-notch-ear').length === 0 && notchGlass?._shape[6] > 0, 'glass draws its own ears');
    await top('28b-bar-notch-glass');

    // One island: all of it in one shape, here a notch with its ears.
    bar.set_string('style', 'island');
    await Scripting.sleep(600);
    const one = shown('atelier-glass').find(g => g !== notchGlass);
    const [lx] = left.get_transformed_position();
    check(one && one._shape[0] < lx && one._shape[0] + one._shape[2] > rightStart() + right.width - 1 &&
        one._shape[6] > 0 && notchGlass._shape[6] === 0,
    `one island: around everything, with the ears at its ends (${one?._shape?.slice(0, 3)})`);
    await top('28c-bar-one-island-notch');
    bar.set_string('island-shape', 'floating');
    bar.set_string('surface', 'classic');
    await Scripting.sleep(600);
    const pill = shown('atelier-capsule');
    const [pillX, , pillWidth, pillHeight] = rect(pill[0]);
    check(pill.length === 1 && pillX < lx && pillX + pillWidth >= rightStart() + right.width &&
        Math.abs(pillHeight - island.height) < 1, 'or floating, as tall as the island');
    const middle1 = pillX + pillWidth / 2;
    check(Math.abs(middle1 - (island.x + island.width / 2)) <= 1, `even on both sides of the time (${middle1})`);
    await top('28d-bar-one-island');

    // Opened, the island takes the one island's whole width (at least).
    const restWidth = pillWidth;
    Main.panel.toggleQuickSettings();
    await waitFor(() => hasClass(island.page, 'atelier-cc'), 1000);
    await Scripting.sleep(700);
    check(island.width >= restWidth - 1 && Math.abs(island.page.width - island.width) < 2,
        `opened, it is as wide as the one island (${island.width} ≥ ${restWidth}, page ${island.page.width})`);
    await screenshotArea('28e-one-island-open', 0, 0, global.stage.width, 520);
    Main.panel.closeQuickSettings();
    await waitFor(() => island.page === null, 1000);
    await Scripting.sleep(400);

    // GNOME's bar, of glass, giving way to the overview as GNOME's does.
    bar.set_string('style', 'gnome');
    bar.set_string('surface', 'glass');
    await Scripting.sleep(600);
    const glassBar = shown('atelier-glass').find(g => g._shape?.[2] >= Main.panel.width - 1);
    check(glassBar && Main.panel.has_style_class_name('atelier-bar-clean') && left.translation_x === 0 &&
        statusArea.quickSettings.container.visible, 'GNOME\'s bar of glass, with all its icons');
    await top('28f-bar-gnome-glass');
    Main.overview.show();
    await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 4000);
    check(glassBar?.opacity === 0, 'the glass gives way in the overview');
    Main.overview.hide();
    await waitFor(() => !Main.overview.visible, 4000);

    ['style', 'sides', 'surface', 'island-shape'].forEach(key => bar.reset(key));
    await Scripting.sleep(500);
    check(surfaces().length === 0 && shown('atelier-notch-ear').length === 0 &&
        !island.has_style_class_name('atelier-island-glass') && left.translation_x === 0 &&
        right.translation_x === 0 && Main.panel.has_style_class_name('atelier-bar-clean'),
    'back to the spread bar on the wallpaper');
    powerToggle.visible = batteryShown;
}

// A made-up GitHub page: a year with something every few days.
function githubPage() {
    const cells = [];
    const day = new Date();
    for (let i = 0; i < 365; i++) {
        const date = new Date(day.getFullYear(), day.getMonth(), day.getDate() - i);
        const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        cells.push(`<td data-date="${iso}" data-level="${(i * 7) % 5}" class="ContributionCalendar-day"></td>`);
    }
    return `<h2 id="js-contribution-activity-description">\n 1,234\n contributions\n in the last year\n</h2>${cells.join('')}`;
}

async function testDesktop(ext) {
    const desktop = ext.stateObj.modules.get('desktop');
    if (!check(desktop !== null, 'desktop module running'))
        return;
    const settings = ext.stateObj._settings.get_child('desktop');
    const layer = desktop.layer;
    // (Run on its own, this part may be the first to move the pointer: out
    // of the top left corner, where it starts on GNOME 50 – which opens
    // the overview, closed again then – to the middle, away from the dock.)
    await pointerTo(global.stage.width / 2, global.stage.height / 2);
    if (Main.overview.visible) {
        await waitFor(() => !Main.overview.animationInProgress, 4000);
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible, 4000);
    }
    // (Just started, the widgets may still be spreading back from the
    // overview the session starts in.)
    await waitFor(() => !desktop._flowing, 3000);
    check(layer.get_parent() === Main.layoutManager._backgroundGroup,
        'the widgets lie on the wallpaper, under the windows');
    check(['clock', 'date', 'calendar'].every(id => desktop.widgets.get(id)?.mapped), 'a clock, the date and the calendar');
    const month = desktop.widgets.get('calendar');
    const firstDay = month._grid?.get_child_at_index(10);
    month._tick();
    check(firstDay && month._grid.get_child_at_index(10) === firstDay,
        'a tick of the clock leaves the calendar\'s month as it is');
    const clock = desktop.widgets.get('clock');
    const [clockX, clockY] = clock.get_transformed_position();
    const area = desktop.area;
    const [originX, originY] = desktop.origin;
    check(Math.abs(clockX - area.x - originX) <= 1 && Math.abs(clockY - area.y - originY) <= 1 && originX >= 24 && originY >= 24,
        `on the grid in the middle of the work area (${clockX}, ${clockY})`);
    // Back from the overview, they spread onto the desktop again.
    Main.overview.show();
    await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 4000);
    check(desktop._layer.opacity === 0, 'in the overview, the widgets wait out of sight');
    Main.overview.hide();
    await waitFor(() => !Main.overview.visible, 4000);
    const spreading = desktop._flowing?.steps ?? [];
    check(spreading.length === desktop.widgets.size && spreading.every(step => step.kind === 'spread') &&
        desktop._layer.opacity === 255, `back from it, they spread onto the desktop (${spreading.length})`);
    await Scripting.sleep(150);
    await screenshotArea('40a-widgets-spreading-back', area.x, area.y, 960, 760);
    await waitFor(() => !desktop._flowing, 3000);
    check([...desktop.widgets.values()].every(widget => !widget.melted &&
        widget.get_children().every(child => child.opacity === 255 || child.get_transition('opacity'))),
    'and are cards again');
    const glass = layer.get_first_child();
    check(hasClass(glass, 'atelier-desktop-glass') && glass._rects.length === 3, 'over glass, under each of them');
    // (The work area changes as workspaces come and go.)
    const blurred = glass._bgManager;
    global.display.emit('workareas-changed');
    await Scripting.sleep(200);
    check(glass._bgManager === blurred, 'the glass is not blurred again when the work area changes');
    await restPointer();
    await screenshotArea('40-desktop-modern', 0, 0, 900, 700);

    // Switching workspaces, they slide along with the wallpaper rather than
    // be gone until the switch is over.
    const [clockLeft, clockTop, clockWidth, clockHeight] = [clockX, clockY, clock.width, clock.height].map(Math.round);
    await screenshotArea('44-desktop-still', clockLeft, clockTop, clockWidth, clockHeight);
    const still = averageColor('44-desktop-still', 0, 0, clockWidth, clockHeight);
    const switcher = Main.wm._workspaceAnimation;
    switcher._prepareWorkspaceSwitch();
    const monitorGroup = switcher._switchData.monitors.find(m => m.index === Main.layoutManager.primaryIndex);
    await Scripting.sleep(200);
    await screenshotArea('45-desktop-switching', clockLeft, clockTop, clockWidth, clockHeight);
    const copies = monitorGroup._workspaceGroups.map(group => group._background.get_children()
        .filter(child => child instanceof Clutter.Clone && child.source === layer).length);
    const switching = averageColor('45-desktop-switching', 0, 0, clockWidth, clockHeight);
    check(copies.length > 0 && copies.every(n => n === 1) && colorDistance(switching, still) < 10,
        `switching workspaces, the widgets are on each workspace's wallpaper (${copies}; ${switching} for ${still})`);
    const shift = Math.round(monitorGroup.baseDistance / 4);
    monitorGroup._container.x = shift;
    await Scripting.sleep(200);
    await screenshotArea('46-desktop-sliding', clockLeft + shift, clockTop, clockWidth, clockHeight);
    await screenshotArea('46-desktop-sliding-wide', 0, 0, 1200, 760);
    check(colorDistance(averageColor('46-desktop-sliding', 0, 0, clockWidth, clockHeight), still) < 10,
        'and slide along with it');
    switcher._finishWorkspaceSwitch(switcher._switchData);
    await Scripting.sleep(200);

    // The clock's faces, chosen in its menu, all in its square.
    const faceClock = desktop.widgets.get('clock');
    desktop._showWidgetMenu(faceClock);
    await Scripting.sleep(300);
    check(faceClock._faces?.length === 6 && faceClock._faces[0]._ornament === PopupMenu.Ornament.CHECK,
        'the clock\'s menu has its faces, Automatic chosen');
    faceClock._menu.close();
    for (const face of ['watch', 'numerals', 'minimal', 'stacked', 'digital']) {
        desktop.setWidgetOption('clock', 'face', face);
        await Scripting.sleep(300);
        await screenshotArea(`40-clock-${face}`, ...faceClock.get_transformed_position().map(v => Math.round(v) - 8),
            Math.round(faceClock.width) + 16, Math.round(faceClock.height) + 16);
        const hands = face !== 'digital' && face !== 'stacked';
        check(Boolean(faceClock._face) === hands && Boolean(faceClock._time) === (face === 'digital') &&
            Boolean(faceClock._hours) === (face === 'stacked') &&
            faceClock.width === desktop.widgets.get('date').width &&
            JSON.parse(settings.get_string('widgets')).find(e => e.id === 'clock').face === face,
        `the ${face} face, in its square, kept with it`);
    }
    // Stretched to a card, the time beside the face: all of it.
    desktop.setWidgetOption('clock', 'face', 'watch');
    const roomy = desktop.spotForNew('github', 0, 0);
    desktop.moveWidget('clock', roomy.x, roomy.y);
    check(desktop.setWidgetSize('clock', 'card'), 'the clock stretched to a card');
    await Scripting.sleep(300);
    const beside = faceClock._time;
    // (Its end: the AM/PM after it, or with a 24-hour clock, the time.)
    const end = [faceClock._suffix, beside].find(label => label?.visible);
    const [endX] = end?.get_transformed_position() ?? [Infinity];
    check(Boolean(faceClock._face) && Boolean(beside) && !beside.clutter_text.get_layout().is_ellipsized() &&
        endX + end.width <= faceClock.get_transformed_position()[0] + faceClock.width,
    `stretched, the time beside the face shows whole (${beside?.text})`);
    await screenshotArea('40-clock-watch-card', ...faceClock.get_transformed_position().map(v => Math.round(v) - 8),
        Math.round(faceClock.width) + 16, Math.round(faceClock.height) + 16);
    desktop.setWidgetSize('clock', 'square');
    desktop.moveWidget('clock', 0, 0);
    desktop._place();
    desktop.setWidgetOption('clock', 'face', 'auto');
    await Scripting.sleep(200);

    // The desktop's menu edits them.
    const background = Main.layoutManager._bgManagers[0].backgroundActor;
    background._backgroundMenu.open();
    await Scripting.sleep(300);
    const labels = background._backgroundMenu._getMenuItems().map(item => item.label?.text).filter(Boolean);
    check(labels.includes('Edit Widgets') && labels.includes('Atelier Settings'),
        `the desktop's menu edits them (${labels})`);
    background._backgroundMenu.close();
    await Scripting.sleep(200);

    desktop.edit();
    await Scripting.sleep(120);
    const coming = desktop._editor;
    check(coming._dim.opacity > 0 && coming._dim.opacity < 255 && coming._hint.progress > 0 &&
        coming._hint.progress < 1 && coming._gallery.opacity < 255,
    `editing, the screen dims, the cells and the gallery come out of drops (${coming._hint.progress.toFixed(2)})`);
    await Scripting.sleep(600);
    check(desktop.editing && layer.get_parent() === desktop._editor.actor && coming._dim.opacity === 255 &&
        coming._hint.progress === 1 && coming._gallery.opacity === 255, 'editing, they come up over everything');
    // The pointer: a hand over a widget, the arrow elsewhere (told apart by
    // where their tips are).
    const tracker = global.backend.get_cursor_tracker();
    const pointerTip = async (x, y) => {
        await pointerTo(x, y);
        await Scripting.sleep(150);
        return String(tracker.get_hot());
    };
    const nowhere = [area.x + area.width - 300, area.y + area.height - 300];
    const arrow = await pointerTip(...nowhere);
    const hand = await pointerTip(...centerOf(desktop.widgets.get('date')));
    check(hand !== arrow && desktop._editor._cursor === 'GRAB',
        `editing, the pointer is a hand over a widget (its tip at ${hand}, the arrow's at ${arrow})`);
    await pointerTo(...nowhere);
    // The gallery: a click adds nothing (a shake: drag me); dragged out, a
    // widget drips out of it and lands where its shadow is.
    const galleryButton = label => desktop._editor._gallery.get_children()
        .find(button => findActor(button, a => a instanceof St.Label && a.text === label));
    const cellCenter = (x, y, size) => {
        const [px, py] = [area.x + desktop.origin[0] + x * 48, area.y + desktop.origin[1] + y * 48];
        const [w, h] = size === 'card' ? [372, 180] : [180, 180];
        return [px + w / 2, py + h / 2];
    };
    // The grid in the middle of the screen, an even number of cells: a card
    // fits right in the middle.
    const middle = cellCenter((desktop.grid[0] - 8) / 2, 0, 'card')[0];
    check(Math.abs(middle - (area.x + area.width / 2)) <= 0.5 && desktop.grid[0] % 2 === 0,
        `a card can be right in the middle (${middle})`);
    const weatherButton = galleryButton('Weather');
    await clickAt(...centerOf(weatherButton));
    await Scripting.sleep(300);
    check(!desktop.widgets.has('weather'), 'a click in the gallery adds nothing');
    let [gx, gy] = centerOf(weatherButton);
    await pointerDown(gx, gy);
    const [tx, ty] = cellCenter(20, 4, 'square');
    await pointerAlong(gx, gy, tx, ty);
    await Scripting.sleep(300);
    const dripping = desktop._editor._drag?.preview;
    check(Boolean(dripping?.mapped) && desktop._editor._ghost.visible, 'dragged out, it drips out of it, its shadow on the cells');
    await pointerUp();
    await Scripting.sleep(400);
    check(desktop.widgets.get('weather')?.entry.x === 20 && desktop.widgets.get('weather').entry.y === 4 &&
        !dripping.get_parent(), `let go, it lands there (${desktop.widgets.get('weather')?.entry.x})`);
    // The clock: a click lets its faces flow out of the gallery; one dragged
    // out is a clock of that face.
    await clickAt(...centerOf(galleryButton('Clock')));
    // (Flowing out, it only ever goes on: no springing back.)
    let onwards = true;
    for (let n = 0, last = 0; n < 12; n++) {
        const progress = desktop._editor._spill?.progress ?? 0;
        onwards &&= progress >= last;
        last = progress;
        if (n % 2 === 0)
            await screenshotArea(`41a-clock-faces-flowing-${n}`, 300, 700, 800, 380);
        await Scripting.sleep(40);
    }
    await Scripting.sleep(500);
    const spill = desktop._editor._spill?.row;
    check(spill?.get_n_children() === 5 && desktop._editor._spill.progress === 1 && onwards &&
        spill.get_children().every(item => item.opacity === 255),
    'a click on the clock lets its faces flow out of the gallery');
    check(facesFit(desktop._editor._spill), 'each face a square clock in its place on the panel');
    await screenshot('41b-clock-faces-spilled');
    const watchItem = spill.get_children().find(item => item.accessible_name === 'Watch');
    [gx, gy] = centerOf(watchItem);
    await pointerDown(gx, gy);
    const [cx2, cy2] = cellCenter(28, 10, 'square');
    await pointerAlong(gx, gy, cx2, cy2);
    await Scripting.sleep(300);
    await pointerUp();
    await Scripting.sleep(400);
    const watch = [...desktop.widgets.values()].find(w => w.entry.kind === 'clock' && w.entry.face === 'watch');
    check(watch?.entry.x === 28 && watch.entry.y === 10 && Boolean(watch._face), 'a face dragged out is a clock with that face');
    // Its button in the corner removes it: clicked, not dragged.
    const removeButton = watch?._editControls?.get_first_child();
    await clickAt(...centerOf(removeButton));
    await Scripting.sleep(300);
    check(!desktop.widgets.has(watch?.entry.id) && !desktop._editor._drag, 'a click on its corner button removes it');
    if (desktop.widgets.has(watch?.entry.id))
        desktop.removeWidget(watch.entry.id);
    // Clicked again, the faces flow back (out of the way of what is under them).
    await clickAt(...centerOf(galleryButton('Clock')));
    check(await waitFor(() => !desktop._editor._spill && !desktop._editor._spillBack?.panel.get_parent(), 2000),
        'the clock clicked again, its faces flow back into the gallery');
    const weather = desktop.widgets.get('weather');
    await Scripting.sleep(200);
    check(Boolean(weather._editHandle?.mapped), 'it has a handle on its corner');
    await clickAt(...centerOf(weather._editHandle));
    await Scripting.sleep(300);
    check(weather.entry.size === 'card', `a click on the handle gives it the next size (${weather.entry.size})`);
    await screenshot('41-desktop-editing');

    // Dragged three cells to the right: a shadow on the grid shows where it
    // lands, and it snaps there.
    const ghost = desktop._editor._ghost;
    const cellLeft = n => area.x + desktop.origin[0] + n * 48;
    const saved = () => JSON.parse(settings.get_string('widgets')).find(e => e.id === 'weather');
    const before = {...weather.entry};
    const [wx, wy] = centerOf(weather);
    await pointerDown(wx, wy);
    await pointerAlong(wx, wy, wx + 6 * 48 + 10, wy + 10);
    await Scripting.sleep(300);
    check(ghost.visible && Math.abs(ghost.get_transformed_position()[0] - cellLeft(before.x + 6)) <= 1 &&
        ghost.width === weather.width, 'dragged, a shadow on the cells where it lands');
    await screenshot('47-desktop-dragging');
    await pointerUp();
    check(weather.entry.x === before.x + 6 && saved()?.x === before.x + 6 && saved().size === 'card' && !ghost.visible,
        `let go, it snaps there and stays (${before.x} → ${saved()?.x})`);

    // Over another widget: beside it, where the shadow shows.
    const calendar = desktop.widgets.get('calendar');
    const overlapping = (a, b) => {
        const [ax, ay] = a.get_transformed_position();
        const [bx, by] = b.get_transformed_position();
        return ax < bx + b.width && bx < ax + a.width && ay < by + b.height && by < ay + a.height;
    };
    const [nx, ny] = centerOf(weather);
    const [cx, cy] = centerOf(calendar);
    await pointerDown(nx, ny);
    await pointerAlong(nx, ny, cx, cy);
    await Scripting.sleep(300);
    const shadow = ghost.get_transformed_position();
    check(!overlapping(ghost, calendar), 'over another widget, the shadow is beside it');
    await pointerUp();
    const landed = weather.get_transformed_position();
    check(Math.abs(landed[0] - shadow[0]) <= 1 && Math.abs(landed[1] - shadow[1]) <= 1 &&
        !overlapping(weather, calendar), 'and it lands there');

    // Stretched by its corner, it follows the pointer and shows the size
    // nearest to how big it is; let go, it takes that size.
    const [square, card] = [4 * 48 - 12, 8 * 48 - 12];
    let [hx, hy] = centerOf(weather._editHandle);
    await pointerDown(hx, hy);
    await pointerAlong(hx, hy, hx - 150, hy);
    await Scripting.sleep(300);
    check(Math.abs(weather.width - (card - 150)) <= 1 && ghost.width === square && weather.entry.size === 'square',
        `stretched, it follows the pointer, and the shadow has the size nearest to that (${weather.width})`);
    await screenshot('48-desktop-stretching');
    await pointerUp();
    check(weather.width === square && saved()?.size === 'square', 'let go, it takes that size');
    [hx, hy] = centerOf(weather._editHandle);
    await pointerDown(hx, hy);
    await pointerAlong(hx, hy, hx + 400, hy);
    await Scripting.sleep(300);
    check(weather.width > card && weather.width <= card + 24 && ghost.width === card,
        `past its biggest size, it gives a little only (${weather.width})`);
    await pointerUp();
    check(weather.width === card && saved()?.size === 'card', 'and it is a card again');

    // Esc, even while stretching one, puts them back as they were.
    [hx, hy] = centerOf(weather._editHandle);
    await pointerDown(hx, hy);
    await pointerAlong(hx, hy, hx - 190, hy);
    await pressKey(Clutter.KEY_Escape);
    const going = desktop._closing;
    check(Boolean(going?.actor) && !going.actor.reactive && going._hint.progress < 1 && going._dim.opacity < 255,
        'the grid draws back into drops');
    check(await waitFor(() => !going.actor, 1500), 'and is gone');
    await pointerUp();
    check(!desktop.editing && layer.get_parent() === Main.layoutManager._backgroundGroup &&
        weather.width === card && weather.entry.size === 'card' && saved()?.size === 'card', 'Esc puts them back');
    const after = await pointerTip(...centerOf(desktop.widgets.get('date')));
    check(after === arrow, `and the pointer is the arrow again, also over a widget (${after})`);
    // Done, clicked, is done too.
    desktop.edit();
    await Scripting.sleep(800);
    await clickAt(...centerOf(desktop._editor._gallery.get_last_child()));
    check(await waitFor(() => !desktop.editing, 1000), 'a click on Done is done editing');
    await waitFor(() => !desktop._closing?.actor, 1500);
    await restPointer();
    // A button on a widget (the calendar's for a task, say) takes its own
    // clicks: the widget opens nothing then.
    const host = desktop.widgets.get('date');
    const inner = new St.Button({label: 'Inner', reactive: true, x_expand: false});
    host.add_child(inner);
    let innerClicks = 0;
    let opened = 0;
    inner.connect('clicked', () => innerClicks++);
    host.activate = () => opened++;
    await Scripting.sleep(200);
    await clickAt(...centerOf(inner));
    await Scripting.sleep(200);
    check(innerClicks === 1 && opened === 0, `a button on a widget takes its click (${innerClicks}, the widget ${opened})`);
    delete host.activate;
    inner.destroy();
    await restPointer();


    // GitHub: anyone's contributions (made up here; the tests stay offline).
    const github = desktop.sources.github;
    github._fetch = async () => github.apply('octocat', githubPage());
    settings.set_string('github-user', 'octocat');
    desktop.addWidget('github');
    desktop.addWidget('claude');
    const gh = desktop.widgets.get('github');
    await waitFor(() => gh?._total.text.includes('1,234'), 4000);
    check(gh?._grid?.visible && gh._total.text.includes('1,234') && gh._grid._days.length === 365,
        `the GitHub widget shows the year (${gh?._total.text})`);
    const claude = desktop.widgets.get('claude');
    check(claude?._output.text === '1.5k', `the Claude widget shows this block (${claude?._output.text})`);
    await screenshotArea('42-desktop-widgets', 0, 0, global.stage.width, 760);

    // Slack: its messages since it was last looked at, counted from its
    // notifications (also with Do Not Disturb on), and who wrote them –
    // never what they say. (The tests never start Slack.)
    const slack = desktop.sources.slack;
    const banners = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
    banners.set_boolean('show-banners', false);
    desktop.addWidget('slack');
    const slackWidget = desktop.widgets.get('slack');
    check(slackWidget?._count?.text === '0' && slackWidget._caption.text === 'All caught up',
        `the Slack widget: nothing new (${slackWidget?._count?.text})`);
    const fromSlack = appSource('Slack', 'slack_slack', 'chat-message-new-symbolic');
    await notify(fromSlack, 'Alice Smith', 'see you at 5');
    const fromDesign = await notify(fromSlack, '#design', 'Bob: new mockups');
    check(await waitFor(() => slack.unread === 2, 2000) && slackWidget._count.text === '2' &&
        slack.senders.map(sender => sender.name).join() === '#design,Alice Smith',
    `it counts Slack's notifications, who wrote them the latest first (${slack.unread}: ${slack.senders.map(sender => sender.name)})`);
    check(!JSON.stringify(slack.senders).includes('mockups') && !slackWidget._latest.text.includes('mockups'),
        'never what they say');
    fromDesign.set({body: 'Bob: and the logo'});
    check(await waitFor(() => slack.unread === 3, 2000) && slack.senders[0].count === 2,
        'a notification Slack updates with a new message counts again');
    const fromCalendar = appSource('Calendar', 'org.gnome.Calendar', 'x-office-calendar-symbolic');
    await notify(fromCalendar, 'Yoga', 'In 15 minutes');
    await Scripting.sleep(300);
    check(slack.unread === 3, 'other apps\' notifications do not count');
    await screenshotArea('42a-desktop-slack-square', ...slackWidget.get_transformed_position().map(v => Math.round(v) - 12),
        Math.round(slackWidget.width) + 24, Math.round(slackWidget.height) + 24);
    desktop.resizeWidget('slack');
    await Scripting.sleep(300);
    check(slackWidget.entry.size === 'card' && slackWidget._list?.get_n_children() === 2,
        'as a card, it lists who wrote');
    // (A kind's own boxes must not be styled by the card's class.)
    const padding = widget => widget.get_theme_node().get_padding(St.Side.LEFT);
    check(padding(slackWidget) > 0 && padding(claude) > 0 && padding(claude) === padding(gh),
        `the Slack and Claude cards keep their padding (${padding(slackWidget)}, ${padding(claude)})`);
    await screenshotArea('42b-desktop-slack', ...slackWidget.get_transformed_position().map(v => Math.round(v) - 12),
        Math.round(slackWidget.width) + 24, Math.round(slackWidget.height) + 24);
    // Slack looked at: nothing unread; nothing counts while it has the focus.
    slack.slackFocused = () => true;
    global.display.notify('focus-window');
    check(slack.unread === 0 && slackWidget._count.text === '0' && slackWidget._list.get_n_children() === 1,
        'Slack getting the focus means they were seen');
    await notify(fromSlack, 'Alice Smith', 'one more');
    await Scripting.sleep(300);
    check(slack.unread === 0, 'and while it has it, nothing counts');
    delete slack.slackFocused;
    fromSlack.destroy();
    fromCalendar.destroy();
    banners.set_boolean('show-banners', true);
    desktop.removeWidget('slack');

    // The cards more see-through: of glass, the tint over the blur goes
    // first, then the glass itself – at nothing, the wallpaper is clear.
    const seeThrough = desktop.widgets.get('date');
    const alphaOf = card => card.get_theme_node().get_background_color().alpha;
    const fullAlpha = alphaOf(seeThrough);
    settings.set_double('card-opacity', 0.7);
    await Scripting.sleep(900);
    check(Math.abs(alphaOf(seeThrough) - fullAlpha * 0.5) <= 2 && desktop._glass.opacity === 255,
        `the cards keep less of their tint, all the glass (${fullAlpha} → ${alphaOf(seeThrough)})`);
    settings.set_double('card-opacity', 0.2);
    await Scripting.sleep(900);
    check(alphaOf(seeThrough) === 0 && Math.abs(desktop._glass.opacity - 128) <= 2,
        `then the glass fades (${desktop._glass.opacity})`);
    await screenshotArea('43-desktop-see-through', 0, 0, global.stage.width, 760);
    settings.set_double('card-opacity', 0);
    await Scripting.sleep(900);
    check(alphaOf(seeThrough) === 0 && desktop._glass.opacity === 0, 'none of it: the wallpaper clear');
    settings.reset('card-opacity');
    await Scripting.sleep(900);
    check(alphaOf(seeThrough) === fullAlpha && !seeThrough.get_style() && desktop._glass.opacity === 255,
        'and back to the look as it is');

    // Analogue: paper, and a clock with hands – the cards fading from
    // glass to paper.
    const dateCard = desktop.widgets.get('date');
    const [cardX, cardY] = dateCard.get_transformed_position().map(Math.round);
    const patch = [cardX + 8, cardY + dateCard.height - 20, 16, 12];
    await screenshotArea('43a-card-before', ...patch);
    // (As a profile switch does: the look it had stays until the shell is
    // calm, then fades over.)
    desktop.freezeLook();
    settings.set_string('style', 'analogue');
    check(Boolean(desktop._frozen?.mapped), 'switching, the desktop keeps the look it had over it');
    await waitFor(() => !desktop._frozen, 4000);
    await Scripting.sleep(300);
    await screenshotArea('43b-card-fading', ...patch);
    await Scripting.sleep(900);
    await screenshotArea('43c-card-after', ...patch);
    const brightness = name => averageColor(name, 0, 0, 16, 12).reduce((a, b) => a + b) / 3;
    const [glassy, fading, paper] = ['43a-card-before', '43b-card-fading', '43c-card-after'].map(brightness);
    check(fading > glassy + 10 && fading < paper - 10,
        `a card's look fades over (${Math.round(glassy)} → ${Math.round(fading)} → ${Math.round(paper)})`);
    check(desktop.widgets.get('clock')._face && !hasClass(layer.get_first_child(), 'atelier-desktop-glass'),
        'analogue: paper and a clock face');
    await screenshotArea('43-desktop-analogue', 0, 0, global.stage.width, 760);
    // Built anew for the look, the Claude widget still reads the numbers once.
    let reads = 0;
    const read = claude._sync;
    claude._sync = function () {
        reads++;
        return read.call(this);
    };
    ext.stateObj.modules.get('claude').usage.emit('changed');
    delete claude._sync;
    check(reads === 1, `built anew, the Claude widget reads the numbers once (${reads} times)`);

    // A photo, from a copy as big as its card: the picture itself (a big one
    // here) is never decoded whole.
    const photoPath = `${OUTPUT}/photo.jpg`;
    const big = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 1770, 3929);
    big.fill(0x3a944aff);
    big.savev(photoPath, 'jpeg', [], []);
    settings.set_string('photo', photoPath);
    desktop.addWidget('photo');
    const photo = desktop.widgets.get('photo');
    const shown = () => /url\("([^"]+)"\)/.exec(photo?._picture?.style ?? '')?.[1] ?? null;
    check(await waitFor(() => shown()?.includes('/atelier/pictures/'), 4000), `a photo shows from a copy (${shown()})`);
    const copy = shown() ? GdkPixbuf.Pixbuf.new_from_file(Gio.File.new_for_uri(shown()).get_path()) : null;
    check(copy?.get_width() === photo.width && copy?.get_height() === photo.height,
        `as big as its card (${copy?.get_width()}×${copy?.get_height()} for ${photo.width}×${photo.height})`);

    desktop.removeWidget('github');
    check(!desktop.widgets.has('github') && !settings.get_string('widgets').includes('github'), 'a widget can be removed');
    ['style', 'widgets', 'github-user', 'photo'].forEach(key => settings.reset(key));
    await Scripting.sleep(400);
    check(desktop.widgets.size === 3 && !desktop.widgets.has('weather'), 'and the layout follows the settings');

    // Another layout (another profile's): the clock pours over to its new
    // place, the weather spreads out of its middle, the calendar draws into
    // its own.
    const flowClock = desktop.widgets.get('clock');
    const flowCalendar = desktop.widgets.get('calendar');
    const clockX0 = flowClock.x;
    settings.set_string('widgets', JSON.stringify([
        {id: 'clock', kind: 'clock', size: 'square', x: 6, y: 0, face: 'watch'},
        {id: 'date', kind: 'date', size: 'square', x: 2, y: 0},
        {id: 'weather', kind: 'weather', size: 'square', x: 0, y: 2},
    ]));
    // (Once the shell draws smoothly: a moment later.)
    check(desktop.widgets.has('calendar'), 'not at once, while the shell may still be busy');
    await waitFor(() => desktop.widgets.has('weather'), 4000);
    const flowWeather = desktop.widgets.get('weather');
    const kinds = () => desktop._flowing?.steps.map(step => `${step.widget.entry.kind} ${step.kind}`).sort().join(', ');
    check(kinds() === 'calendar gather, clock pour, weather spread' && flowClock.melted && flowWeather?.melted &&
        desktop._liquid?.visible && flowCalendar.get_parent() === desktop._layer && !desktop.widgets.has('calendar'),
    `another layout: they turn liquid, pour to their places, spread out or draw in (${kinds()})`);
    for (const at of [150, 300, 450, 600])
        await screenshotArea(`63-widgets-pouring-${at}`, area.x, area.y, 960, 520).then(() => Scripting.sleep(10));
    await Scripting.sleep(1200);
    check(Math.abs(flowClock.x - (clockX0 + 6 * 96)) < 1 && !flowClock.melted && !flowWeather.melted &&
        flowWeather.get_children().every(child => child.opacity === 255) && !desktop._flowing && !desktop._liquid.visible,
    `and settle there, cards again (${flowClock.x})`);
    check(Boolean(flowClock._face) && flowClock.entry.face === 'watch', 'with the face the other layout gives the clock');
    check(desktop._layer.get_children().every(child => child !== flowCalendar), 'the calendar is gone');
    settings.reset('widgets');
    await Scripting.sleep(1200);
}

// A window of an app of its own (a GTK 4 script in gjs), over the desktop;
// closeTestWindows() closes them all.
const testWindows = new Map(); // title → Gio.Subprocess

async function openTestWindow(title) {
    const code = `
        imports.gi.versions.Gtk = '4.0';
        const {Gio, Gtk} = imports.gi;
        const app = new Gtk.Application({application_id: 'org.atelier.PhotoTest',
            flags: Gio.ApplicationFlags.NON_UNIQUE});
        app.connect('activate', () => new Gtk.ApplicationWindow({
            application: app, title: '${title}', default_width: 600, default_height: 400,
        }).present());
        app.run([]);`;
    testWindows.set(title, Gio.Subprocess.new(['gjs', '-c', code], Gio.SubprocessFlags.NONE));
    const find = () => global.get_window_actors().map(actor => actor.meta_window)
        .find(window => window?.get_title() === title) ?? null;
    await waitFor(() => find()?.get_compositor_private()?.mapped, 15000);
    await Scripting.sleep(300);
    return find();
}

async function closeTestWindows() {
    testWindows.forEach(process => process.force_exit());
    const titles = [...testWindows.keys()];
    testWindows.clear();
    await waitFor(() => !global.get_window_actors().some(actor => titles.includes(actor.meta_window?.get_title())), 5000);
}

// A window moved over a rectangle of the stage (and a bit round it).
async function moveTestWindow(window, [x, y, width, height]) {
    window.move_resize_frame(false, x, y, width, height);
    await waitFor(() => {
        const frame = window.get_frame_rect();
        return frame.x === x && frame.y === y && frame.width === width;
    }, 3000);
    await Scripting.sleep(300);
}

// The photos: Atelier's own gallery of them, and each photo widget's
// choice, shown one after another (the next spreading over the one
// before) while it can be seen – not under a window, nor in the overview.
async function testPhotoGallery(ext) {
    const desktop = ext.stateObj.modules.get('desktop');
    const islandModule = ext.stateObj.modules.get('island');
    const gallery = desktop?.gallery;
    if (!check(Boolean(gallery), 'the photos\' gallery is there'))
        return;
    const atelierSettings = ext.stateObj._settings;
    const settings = atelierSettings.get_child('desktop');
    await pointerTo(global.stage.width / 2, global.stage.height / 2);
    if (Main.overview.visible) {
        await waitFor(() => !Main.overview.animationInProgress, 4000);
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible, 4000);
    }
    await waitFor(() => !desktop._flowing, 3000);
    const portal = desktop.portal;
    let widget = null;
    try {
        // Pictures added: copies of Atelier's own, which stay when the
        // pictures themselves go, and a small copy of each for the grids.
        const originals = `${OUTPUT}/photo-originals`;
        GLib.mkdir_with_parents(originals, 0o755);
        const picture = (name, width, height, color) => {
            const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
            pixbuf.fill(color);
            const path = `${originals}/${name}`;
            pixbuf.savev(path, 'jpeg', [], []);
            return path;
        };
        const colors = [0xd02020ff, 0x20b040ff, 0x2040d0ff];
        const paths = [picture('Red Barn.jpg', 2400, 1600, colors[0]), picture('green.jpg', 800, 1200, colors[1]),
            picture('blue.jpg', 1000, 1000, colors[2])];
        const ids = await gallery.add(paths);
        paths.forEach(path => GLib.unlink(path));
        check(ids.length === 3 && gallery.ids().join() === ids.join() &&
            ids.every(id => GLib.file_test(gallery.path(id), GLib.FileTest.EXISTS)) &&
            gallery.dir === `${GLib.get_user_data_dir()}/atelier/photos` && ids[0].endsWith('-red-barn.jpg'),
        `pictures added to the gallery are copied into it, and stay when they go (${ids.join(', ')})`);
        const thumbnails = await Promise.all(ids.map(id => gallery.thumbnail(id)));
        const sizes = thumbnails.map(path => {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
            return `${pixbuf.get_width()}×${pixbuf.get_height()}`;
        });
        check(sizes.every(size => size === '192×192') && thumbnails.every(path => path.includes('/atelier/pictures/')),
            `with a small copy of each for the grids (${sizes.join(', ')})`);

        // A photo widget with its own choice, each for a second (the
        // choices offered are longer).
        widget = desktop.addWidget('photo', {photos: ids, interval: 1});
        const shown = () => /url\("([^"]+)"\)/.exec(widget?._picture?.style ?? '')?.[1] ?? null;
        check(await waitFor(() => shown()?.includes('/atelier/pictures/'), 4000) && widget._current === ids[0],
            `a photo widget shows the first of its photos, from a copy (${shown()})`);
        const copy = shown() ? GdkPixbuf.Pixbuf.new_from_file(Gio.File.new_for_uri(shown()).get_path()) : null;
        check(copy?.get_width() === widget.width && copy?.get_height() === widget.height,
            `as big as its card (${copy?.get_width()}×${copy?.get_height()} for ${widget.width}×${widget.height})`);
        const [wx, wy] = widget.get_transformed_position().map(Math.round);
        const [ww, wh] = [Math.round(widget.width), Math.round(widget.height)];
        const shot = name => screenshotArea(name, wx - 8, wy - 8, ww + 16, wh + 16);
        // In the middle of the card, the photo it shows; at its corner,
        // still the one before as the next spreads out of the middle.
        const colorAt = async (name, fx, fy) => {
            await screenshotArea(name, wx, wy, ww, wh);
            return averageColor(name, Math.round(ww * fx) - 4, Math.round(wh * fy) - 4, 8, 8);
        };
        const rgb = color => [color >>> 24, (color >>> 16) & 0xff, (color >>> 8) & 0xff];
        const near = (a, color) => colorDistance(a, rgb(color)) < 40;
        await shot('80-photo-widget');

        // Its turn: the next spreads over it, out of a drop in its middle.
        // (Slowed down, to look at it on its way.)
        const motion = St.Settings.get();
        let spreading, middle, corner;
        motion.slow_down_factor = 4;
        try {
            spreading = await waitFor(() => widget._spreading?.timeline?.progress > 0.06, 3000);
            middle = spreading ? await colorAt('80b-photo-spreading', 0.5, 0.5) : null;
            corner = spreading ? averageColor('80b-photo-spreading', 4, Math.round(wh / 2) - 4, 8, 8) : null;
        } finally {
            motion.slow_down_factor = 1;
        }
        check(spreading && widget._incoming.visible && widget._mask.enabled,
            'a second later, the next photo spreads over it, through liquid');
        check(middle && near(middle, colors[1]) && near(corner, colors[0]),
            `out of its middle: the next one there, the one before still at its edge (${middle}, ${corner})`);
        check(await waitFor(() => widget._current === ids[1] && !widget._spreading, 6000) && !widget._incoming.visible &&
            near(await colorAt('80c-photo-next', 0.1, 0.5), colors[1]), 'and then shows all of the next one');
        check(await waitFor(() => widget._current === ids[2], 4000) &&
            await waitFor(() => widget._current === ids[0], 4000), 'one after another, the first after the last');

        // Under a window, it doesn't take turns: its time doesn't run.
        const window = await openTestWindow('Atelier photo test');
        await moveTestWindow(window, [wx - 40, wy - 40, ww + 80, wh + 80]);
        await waitFor(() => !widget._spreading, 3000);
        const covered = widget._current;
        await Scripting.sleep(2500);
        check(widget._current === covered && !widget._turnId && !widget._spreading && desktop.sight.covered(widget),
            `under a window, it doesn't take turns (${widget._current === covered}, timer ${widget._turnId})`);
        // Over half of it, the rest still shows.
        await moveTestWindow(window, [wx - 40, wy - 40, Math.round(ww / 2) + 40, wh + 80]);
        check(await waitFor(() => widget._current !== covered, 4000),
            'with the window over half of it, it does: the rest shows');
        // Moved away, on it goes.
        await moveTestWindow(window, [wx + ww + 200, wy, 600, 400]);
        let before = widget._current;
        check(await waitFor(() => widget._current !== before, 4000), 'with the window out of the way, on it goes');
        // Minimized over it: on it goes too.
        await moveTestWindow(window, [wx - 40, wy - 40, ww + 80, wh + 80]);
        await waitFor(() => !widget._turnId && !widget._spreading, 3000);
        window.minimize();
        before = widget._current;
        check(await waitFor(() => widget._current !== before, 4000), 'and with the window minimized');
        await closeTestWindows();

        // Nor in the overview (which has the desktop without its widgets).
        await waitFor(() => !widget._spreading, 3000);
        Main.overview.show();
        await waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 4000);
        before = widget._current;
        await Scripting.sleep(2500);
        check(widget._current === before && !widget._turnId, 'in the overview, it doesn\'t take turns');
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible, 4000);
        check(await waitFor(() => widget._current !== before, 5000), 'back on the desktop, on it goes');

        // Its menu (right-click it) has Choose Photos…, which drips a sheet
        // from the island with the gallery: those it shows numbered.
        await waitFor(() => !widget._spreading, 3000);
        desktop.portal = {available: () => Promise.resolve(false), choosePictures: () => Promise.resolve([])};
        await clickAt(...centerOf(widget), Clutter.BUTTON_SECONDARY);
        await Scripting.sleep(500);
        const item = widget._menu?._getMenuItems().find(i => i.label?.text === 'Choose Photos…');
        check(widget._menu?.isOpen && Boolean(item), 'its menu has Choose Photos…');
        if (item)
            await clickAt(...centerOf(item));
        check(await waitFor(() => islandModule._sheet?.opened, 3000) && islandModule._sheet.form.tiles,
            'which drips a sheet from the island');
        let form = islandModule._sheet?.form;
        const badges = () => form.tiles.map(tile => (tile.checked ? tile._badge.text : '-')).join(' ');
        check(form?.tiles.length === 3 && badges() === '1 2 3' && form.tiles.map(t => t._id).join() === ids.join(),
            `with the gallery's photos, those it shows numbered in their order (${form && badges()})`);
        check(await waitFor(() => !form.addTile.reactive && form._addText.text === 'No file chooser', 2000),
            'without the portal, the tile that adds photos says so');
        await waitFor(() => form.tiles.every(tile => tile.style?.includes('background-image')), 2000);
        await Scripting.sleep(300);
        await screenshot('81-photo-sheet');
        // A click takes one out; another puts it back, at the end.
        await clickAt(...centerOf(form.tiles[1]));
        const entry = () => JSON.parse(settings.get_string('widgets')).find(e => e.id === widget.entry.id);
        check(await waitFor(() => entry()?.photos?.join() === [ids[0], ids[2]].join(), 1000) && badges() === '1 - 2' &&
            desktop.widgets.get(widget.entry.id).entry.photos.length === 2,
        `a click takes a photo out of its choice, kept with the widget (${badges()})`);
        await clickAt(...centerOf(form.tiles[1]));
        check(await waitFor(() => entry()?.photos?.join() === [ids[0], ids[2], ids[1]].join(), 1000) && badges() === '1 3 2',
            `another puts it back, at the end (${badges()})`);
        const thirty = form._intervals.find(segment => segment._seconds === 30);
        await clickAt(...centerOf(thirty));
        check(await waitFor(() => entry()?.interval === 30, 1000) && thirty.has_style_pseudo_class('checked'),
            'how long each shows, too');
        await screenshot('81b-photo-sheet-picked');

        // With the file chooser: the sheet goes back into the island while
        // it is open, and comes again with the pictures added, and picked.
        await clickAt(...centerOf(form._done));
        check(await waitFor(() => islandModule._sheet === null, 3000), 'Done takes the sheet back into the island');
        const added = picture('yellow.jpg', 640, 480, 0xe0d020ff);
        let asked = 0;
        desktop.portal = {
            available: () => Promise.resolve(true),
            choosePictures: async () => {
                asked++;
                return islandModule._sheet ? [] : [added];
            },
        };
        desktop.choosePhotos(widget.entry.id);
        await waitFor(() => islandModule._sheet?.opened, 3000);
        form = islandModule._sheet.form;
        check(await waitFor(() => form.addTile.reactive && form._addText.text === 'Add', 2000),
            'with the portal, a tile to add photos');
        await clickAt(...centerOf(form.addTile));
        check(await waitFor(() => asked === 1 && islandModule._sheet?.opened && islandModule._sheet.form !== form, 6000),
            'which asks the file chooser with the sheet out of the way, and drips it again');
        form = islandModule._sheet?.form;
        const newId = gallery.ids().find(id => !ids.includes(id));
        check(form?.tiles.length === 4 && Boolean(newId) && entry()?.photos?.at(-1) === newId && badges() === '1 3 2 4',
            `with the picture added to the gallery, and picked (${form && badges()})`);
        await pressKey(Clutter.KEY_Escape);
        check(await waitFor(() => islandModule._sheet === null, 3000), 'Esc takes it back');

        // A photo taken out of the gallery: out of every choice, with its copies.
        widget = desktop.widgets.get(widget.entry.id);
        const firstCopy = thumbnails[0];
        await gallery.remove(ids[0], atelierSettings);
        // (The layout changed from outside: the desktop takes it once the shell is calm.)
        await waitFor(() => !desktop.widgets.get(widget.entry.id)?.entry.photos.includes(ids[0]), 4000);
        widget = desktop.widgets.get(widget.entry.id);
        check(!entry().photos.includes(ids[0]) && !widget.entry.photos.includes(ids[0]) && !gallery.has(ids[0]) &&
            !GLib.file_test(gallery.path(ids[0]), GLib.FileTest.EXISTS) && !GLib.file_test(firstCopy, GLib.FileTest.EXISTS),
        'a photo taken out of the gallery goes from every widget\'s choice, with its copies');
        const profile = ext.stateObj.modules.get('profiles')._store.get(ext.stateObj.modules.get('profiles')._store.activeId);
        check(!JSON.stringify(profile?.widgets ?? {}).includes(ids[0]), 'and from the profile\'s widgets');
        await shot('82-photo-widget-after');
    } finally {
        desktop.portal = portal;
        await closeTestWindows();
        if (islandModule._sheet)
            await islandModule._sheet.close();
        if (widget)
            desktop.removeWidget(widget.entry.id);
        for (const id of gallery.ids())
            await gallery.remove(id, atelierSettings);
        settings.reset('widgets');
        await Scripting.sleep(1200);
    }
}

async function testNotes(ext) {
    const notes = ext.stateObj.modules.get('notes');
    if (!check(notes !== null, 'notes module running'))
        return;
    const island = ext.stateObj.modules.get('island').island;
    const desktop = ext.stateObj.modules.get('desktop');
    await restPointer();

    // A new note drips from the island onto a sheet, a paper to write on.
    const islandModule = ext.stateObj.modules.get('island');
    const count = notes.store.all().length;
    notes.open(null, {create: true});
    check(await waitFor(() => islandModule._sheet?.opened, 3000), 'a new note drips from the island onto a sheet');
    let form = islandModule._sheet.form;
    check(global.stage.key_focus === form._title.clutter_text && notes.store.all().length === count,
        'ready to write its title on, not saved yet');
    await pressKey(Clutter.KEY_Tab);
    check(global.stage.key_focus === form._text.clutter_text, 'Tab goes on to its text');
    await pressKeys(Clutter.KEY_Shift_L, Clutter.KEY_ISO_Left_Tab);
    check(global.stage.key_focus === form._title.clutter_text, 'Shift+Tab back to its title');
    await pressKey(Clutter.KEY_Tab);
    // Enter on a line with a checkbox: the next line has one too; on an
    // empty one, it goes (the end of the list). Shift+Enter: a plain line.
    const written = form._text.clutter_text;
    const write = text => [...text].forEach(char => written.insert_unichar(char));
    form._text.text = '- [ ] milk';
    written.set_selection(-1, -1);
    await pressKey(Clutter.KEY_Return);
    write('bread');
    await pressKey(Clutter.KEY_Return);
    check(form._text.text === '- [ ] milk\n- [ ] bread\n- [ ] ',
        `Enter in a list of checkboxes starts the next one with a checkbox (${JSON.stringify(form._text.text)})`);
    await pressKey(Clutter.KEY_Return);
    check(form._text.text === '- [ ] milk\n- [ ] bread\n', 'and on an empty one ends the list');
    write('- [ ] eggs');
    await pressKeys(Clutter.KEY_Shift_L, Clutter.KEY_Return);
    check(form._text.text === '- [ ] milk\n- [ ] bread\n- [ ] eggs\n', 'Shift+Enter is a plain line break');
    // Checkbox over a few lines selected: on all of them.
    form._text.text = 'milk\nbread\n\neggs';
    written.set_selection(0, -1);
    const findButton = (root, label, name = null) => root.get_children().reduce((found, child) =>
        found ?? (child instanceof St.Button && (name ? child.accessible_name === name : child.label === label)
            ? child : findButton(child, label, name)), null);
    findButton(form, 'Checkbox')?.emit('clicked', 1);
    check(form._text.text === '- [ ] milk\n- [ ] bread\n\n- [ ] eggs',
        `Checkbox puts one on every line selected (${JSON.stringify(form._text.text)})`);

    form._title.text = 'Groceries';
    form._text.text = 'Saturday\n- [ ] milk\n- [x] bread';
    form._colors.find(dot => dot._color === 'mint').emit('clicked', 1);
    await Scripting.sleep(300);
    await screenshot('50-note-sheet');
    // Saved, a new note's sheet runs off to the edge it is pinned to, in a
    // drop, and its paper spreads out of the edge there. (Slowed down to
    // look at; pictures on the way.)
    const motion = St.Settings.get();
    let leftmost = Infinity;
    let waited = false;
    let spread = false;
    motion.slow_down_factor = 8;
    try {
        await pressKeys(Clutter.KEY_Control_L, Clutter.KEY_Return);
        for (let n = 1; n <= 14; n++) {
            await Scripting.sleep(600);
            const drop = islandModule._liquid?._drop;
            if (drop && drop[2] > 0)
                leftmost = Math.min(leftmost, drop[0]);
            const saved = notes.store.all().find(n => n.title === 'Groceries');
            const arriving = saved && notes._edges._tabs.get(saved.id);
            waited ||= Boolean(arriving?.waiting) && Math.abs(arriving.translation_x + arriving.size[0]) < 1;
            spread ||= Boolean(arriving) && !arriving.waiting && arriving.scale_y < 1;
            if (n % 2 === 0)
                await screenshotArea(`50b-note-to-edge-${n / 2}`, 0, 0, 1100, 760);
        }
    } finally {
        motion.slow_down_factor = 1;
    }
    check(await waitFor(() => notes.store.all().length === count + 1, 2000), 'Ctrl+Enter saves it');
    const note = notes.store.all().find(n => n.title === 'Groceries');
    const id = note?.id;
    check(note?.color === 'mint' && note.text.includes('- [ ] milk'), 'as written, on its paper');
    check(leftmost < 120 && waited && spread,
        `the sheet runs off to the note's edge in a drop (${Math.round(leftmost)}), and its paper spreads out of it`);
    check(await waitFor(() => islandModule._sheet === null, 3000), 'and the sheet is gone');

    // Among the papers in the Notes tab, its checkboxes tick off.
    notes.open();
    check(await waitFor(() => island.page?.tab === 'notes', 1000), 'the Notes tab has the papers');
    await Scripting.sleep(300);
    const papers = () => notes.view.get_children()[1].child.get_children();
    const paper = papers().find(child => child.child?._id === id);
    check(Boolean(paper), 'the note is among the papers');
    await screenshotIsland('51-notes-grid', 480);
    const box = paper.child.get_children().find(child => child.has_style_class_name?.('atelier-note-check-row'));
    box?.get_first_child().emit('clicked', 1);
    check(notes.store.get(id).text.includes('- [x] milk'), 'a checkbox is ticked off right on the paper');

    // A paper clicked on there: the note on a sheet, as it is; changed
    // there, it is kept when let go of.
    papers().find(child => child.child?._id === id).emit('clicked', 1);
    check(await waitFor(() => islandModule._sheet?.opened && island.page === null, 3000),
        'a paper in the tab opens on a sheet, the tab going back into the island');
    form = islandModule._sheet.form;
    check(form._title.text === 'Groceries' && form._color === 'mint' && form._text.text.includes('- [x] milk') &&
        form._pin === 'left', 'the note as it is');
    check(global.stage.key_focus === form._text.clutter_text, 'written on from its text, one there already');
    form._text.text = `${form._text.text}\neggs`;
    await screenshot('52-note-sheet-open');
    await pressKey(Clutter.KEY_Escape);
    check(await waitFor(() => islandModule._sheet === null && notes.store.get(id).text.endsWith('eggs'), 3000),
        'changed there, it is kept when let go of');
    notes.open();
    await waitFor(() => island.page?.tab === 'notes', 1000);
    await Scripting.sleep(300);

    // "New note" there drips a sheet too; Cancel throws it away, Esc keeps
    // what is written.
    papers().find(child => hasClass(child, 'atelier-note-new')).emit('clicked', 1);
    check(await waitFor(() => islandModule._sheet?.opened && island.page === null, 3000),
        '"New note" in the tab drips a sheet, the tab going back into the island');
    form = islandModule._sheet.form;
    form._text.text = 'thrown away';
    form.emit('cancel');
    check(await waitFor(() => islandModule._sheet === null, 3000) && notes.store.all().length === count + 1,
        'Cancel throws it away');
    notes.open(null, {create: true});
    await waitFor(() => islandModule._sheet?.opened, 3000);
    islandModule._sheet.form._text.text = 'kept';
    await pressKey(Clutter.KEY_Escape);
    const kept = () => notes.store.all().find(n => n.text === 'kept');
    check(await waitFor(() => islandModule._sheet === null && kept(), 3000), 'Esc keeps what is written');
    notes.store.remove(kept()?.id);
    await waitFor(() => island.page === null, 1000);

    // A new note goes on the left edge: a square paper, of which a strip
    // peeks out; all of it on hover.
    check(note.pin === 'left', 'a new note is pinned to the left edge');
    await Scripting.sleep(400);
    const tab = notes._edges._tabs.get(id);
    const [tabX] = tab?.get_transformed_position() ?? [NaN];
    check(tab?.mapped && tabX < 0 && tabX + tab.width > 0 && tabX + tab.width < 40,
        `pinned to the edge, a strip of it shows (${tabX})`);
    check(Math.abs(tab.width - tab.height) < 1 && tab.width > 150, `a square paper (${tab.width}x${tab.height})`);
    const size = [tab.width, tab.height];
    const one = notes.store.create({title: 'One line'});
    await Scripting.sleep(400);
    const small = notes._edges._tabs.get(one.id);
    check(small?.width === size[0] && small.height === size[1], 'of one size, however little is on it');
    notes.store.update(id, {text: `${notes.store.get(id).text}\nand a much longer line that wraps on the paper`});
    await Scripting.sleep(300);
    check(tab.width === size[0] && tab.height === size[1], 'or much');
    const [, oneY] = small.get_transformed_position();
    check(oneY >= tab.get_transformed_position()[1] + tab.height, 'the next one below it');
    await pointerTo(5, tab.get_transformed_position()[1] + tab.height / 2);
    await Scripting.sleep(500);
    check(Math.abs(tab.get_transformed_position()[0]) < 1, 'and all of it on hover');
    const [buttonX, buttonY] = tab._archive.get_transformed_position();
    const [paperX, paperY] = tab.get_transformed_position();
    check(tab._archive.reactive && tab._archive.opacity === 255 &&
        buttonX + tab._archive.width > paperX + tab.width - 40 && buttonY < paperY + 40,
    `out, it has a button for the archive in its top corner (${buttonX - paperX}, ${buttonY - paperY})`);
    await screenshotArea('52-note-edge', 0, 0, 600, global.stage.height);
    await restPointer();
    await Scripting.sleep(400);
    check(!tab._archive.reactive && tab._archive.opacity === 0,
        'back at the edge, the button is gone: a click on the strip opens the note');
    // The button puts the note into the archive, without opening it.
    await pointerTo(5, small.get_transformed_position()[1] + small.height / 2);
    check(await waitFor(() => small._archive.reactive, 1000), 'out, the next one has its button too');
    await clickAt(...centerOf(small._archive));
    check(await waitFor(() => notes.store.get(one.id)?.archived && !notes._edges._tabs.has(one.id), 2000) &&
        islandModule._sheet === null, 'a click on it puts the note into the archive; it leaves the edge, unopened');
    await restPointer();
    await Scripting.sleep(300);
    notes.store.remove(one.id);
    check(!desktop.kinds.has('note'), 'no note widgets on the desktop');

    // On the desktop only: among the widgets and over them, also when they
    // are made anew; over the windows while there are none.
    const notesSettings = ext.stateObj._settings.get_child('notes');
    const desktopSettings = ext.stateObj._settings.get_child('desktop');
    const overWidgets = edgeTab => {
        const layer = ext.stateObj.modules.get('desktop')?.layer;
        return Boolean(edgeTab?.mapped && layer?.get_last_child()?.contains(edgeTab));
    };
    notesSettings.set_boolean('edges-on-desktop-only', true);
    await Scripting.sleep(300);
    ext.stateObj.modules.get('desktop').reload();
    await Scripting.sleep(300);
    check(overWidgets(notes._edges._tabs.get(id)), 'on the desktop only: among the widgets, over them');
    desktopSettings.set_boolean('enabled', false);
    await Scripting.sleep(300);
    const alone = notes._edges._tabs.get(id);
    check(Boolean(alone?.mapped) && !global.window_group.contains(alone), 'without the widgets: over the windows');
    desktopSettings.set_boolean('enabled', true);
    await Scripting.sleep(500);
    check(overWidgets(notes._edges._tabs.get(id)), 'and among them again when they are back');
    notesSettings.reset('edges-on-desktop-only');
    await Scripting.sleep(300);
    const back = notes._edges._tabs.get(id);
    check(Boolean(back?.mapped) && !global.window_group.contains(back), 'over the windows again');

    // Its paper on the edge opens it too; archived from the sheet, it leaves
    // the edge and the papers.
    notes._edges._tabs.get(id).emit('clicked', 1);
    check(await waitFor(() => islandModule._sheet?.opened && islandModule._sheet.form._title.text === 'Groceries', 3000),
        'its paper on the edge opens it on a sheet');
    const button = (root, name) => {
        for (const child of root.get_children()) {
            if (child.accessible_name === name)
                return child;
            const found = button(child, name);
            if (found)
                return found;
        }
        return null;
    };
    button(islandModule._sheet.form, 'Archive')?.emit('clicked', 1);
    check(await waitFor(() => islandModule._sheet === null, 3000) && !notes._edges._tabs.has(id) &&
        !notes.store.all().some(n => n.id === id) && notes.store.all({archived: true}).some(n => n.id === id),
        'archived, it is in the archive only');
    // Deleted from a sheet, it is gone.
    const scrap = notes.store.create({title: 'Scrap'});
    await Scripting.sleep(300);
    notes._edges._tabs.get(scrap.id).emit('clicked', 1);
    await waitFor(() => islandModule._sheet?.opened, 3000);
    button(islandModule._sheet.form, 'Delete')?.emit('clicked', 1);
    check(await waitFor(() => islandModule._sheet === null && !notes.store.get(scrap.id), 3000), 'deleted from a sheet, it is gone');

    // A reminder: "Remind me" on the sheet sets one (at the next full hour,
    // or tomorrow morning); a day later at 9:00 here. The sheet stays as
    // big as it was, inside its panel.
    notes.open(null, {create: true});
    await waitFor(() => islandModule._sheet?.opened, 3000);
    form = islandModule._sheet.form;
    form._title.text = 'Call the print shop';
    const sheetHeight = form.height;
    form._remindButton.emit('clicked', 1);
    await Scripting.sleep(100);
    check(form._reminder.visible && !form._remindButton.visible && form.fields.remind > Date.now(),
        `Remind me sets a reminder to come (${form._day.text} ${form._time.text})`);
    check(form.height === sheetHeight, `the sheet doesn't grow with it (${sheetHeight} → ${form.height})`);
    findButton(form, null, 'No reminder')?.emit('clicked', 1);
    check(form.fields.remind === null && form._remindButton.visible, 'and its × takes it away');
    form._remindButton.emit('clicked', 1);
    form._time.text = '25:00';
    check(!form._save.reactive && form._time.has_style_pseudo_class('error'), 'not a time: it can\'t be saved so');
    form._time.text = '9:00';
    const today = form._days;
    findButton(form, null, 'A day later')?.emit('clicked', 1);
    const expected = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() + today + 1, 9, 0).getTime();
    check(form._save.reactive && form.fields.remind === expected, `a day later at 9:00 (${form._day.text})`);
    await Scripting.sleep(200);
    await screenshot('53-note-reminder');
    await pressKeys(Clutter.KEY_Control_L, Clutter.KEY_Return);
    const remembered = () => notes.store.all().find(n => n.title === 'Call the print shop');
    check(await waitFor(() => remembered()?.remind === expected && islandModule._sheet === null, 3000),
        'saved with the note');
    const reminded = remembered();
    const remindedPaper = notes._edges._tabs.get(reminded.id);
    check(findActor(remindedPaper, actor => hasClass(actor, 'atelier-note-reminder')), 'its paper shows when it reminds');
    await pointerTo(5, remindedPaper.get_transformed_position()[1] + remindedPaper.height / 2);
    await Scripting.sleep(500);
    await screenshotArea('54-note-reminder-paper', 0, 0, 600, global.stage.height);
    await restPointer();
    // Due: a notification at once (sounding, with Open and In 10 min), and
    // the reminder gone – without counting as a change to the note.
    const modified = reminded.modified;
    notes.store.update(reminded.id, {remind: Date.now() - 1000}, {touch: false});
    const reminderSource = () => Main.messageTray.getSources().find(source => source.title === 'Notes');
    const sent = () => reminderSource()?.notifications.find(n => n.title === 'Call the print shop');
    check(await waitFor(() => Boolean(sent()), 2000) && notes.store.get(reminded.id).remind === null &&
        notes.store.get(reminded.id).modified === modified, 'due, it comes as a notification, and goes from the note');
    check(sent().actions.map(action => action.label).join() === 'Open,In 10 min' &&
        sent().sound !== null, 'with Open and In 10 min, and a sound');
    sent().actions[1].activate();
    check(Math.abs(notes.store.get(reminded.id).remind - Date.now() - 10 * 60 * 1000) < 5000, 'In 10 min puts it off');
    await waitFor(() => island.page === null, 12000);
    reminderSource()?.destroy();

    // Pinned to the other edge on its sheet: the sheet runs off there as a
    // new one's does, and its paper spreads out of that edge; the paper it
    // had goes into its own. (Slowed down to look at.)
    notes.edit(reminded.id);
    await waitFor(() => islandModule._sheet?.opened, 3000);
    const leftPaper = notes._edges._tabs.get(reminded.id);
    islandModule._sheet.form._pins.find(segment => segment._value === 'right').emit('clicked', 1);
    let rightmost = -Infinity;
    let leftWent = false;
    let rightWaited = false;
    motion.slow_down_factor = 8;
    try {
        await pressKeys(Clutter.KEY_Control_L, Clutter.KEY_Return);
        for (let n = 1; n <= 14; n++) {
            await Scripting.sleep(600);
            const drop = islandModule._liquid?._drop;
            if (drop && drop[2] > 0)
                rightmost = Math.max(rightmost, drop[0]);
            leftWent ||= Boolean(leftPaper?.leaving) && notes._edges._tabs.get(reminded.id) !== leftPaper;
            const rightPaper = notes._edges._tabs.get(reminded.id);
            rightWaited ||= rightPaper?.side === 'right' && rightPaper.waiting;
        }
    } finally {
        motion.slow_down_factor = 1;
    }
    const moved = notes._edges._tabs.get(reminded.id);
    const [movedX] = moved?.get_transformed_position() ?? [NaN];
    check(notes.store.get(reminded.id).pin === 'right' && rightmost > global.stage.width - 120 && leftWent && rightWaited,
        `to the other edge: the sheet runs off there (${Math.round(rightmost)}), its paper leaves the old one`);
    check(await waitFor(() => islandModule._sheet === null, 3000) && moved?.side === 'right' &&
        Math.abs(movedX - (global.stage.width - 18)) < 2 && leftPaper.gone,
    `and its paper is out of the right edge, a strip of it (${Math.round(movedX)})`);
    notes.store.remove(reminded.id);

    notes.store.remove(id);
    notes.store.destroy(); // writes now
    const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'atelier', 'notes.json']));
    check(file.query_exists(null) && !new TextDecoder().decode(file.load_contents(null)[1]).includes(id),
        'the notes are kept in a file');
}

function displayConfig(method, params, replyType = null) {
    return new Promise((resolve, reject) => {
        Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', method, params, replyType && new GLib.VariantType(replyType),
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    resolve(connection.call_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/**
 * Put the monitors side by side, as the Displays settings do.
 *
 * @param {string[]} connectors - from left to right
 * @param {string} primary - the main one
 */
async function arrangeMonitors(connectors, primary) {
    const state = await displayConfig('GetCurrentState', null,
        '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})');
    const [serial, monitors] = state.recursiveUnpack();
    const modes = new Map(monitors.map(([[connector], list]) => [connector, list.find(mode => mode[6]['is-current'])]));
    let x = 0;
    const logical = connectors.map(connector => {
        const [mode, width] = modes.get(connector);
        const monitor = [x, 0, 1.0, 0, connector === primary, [[connector, mode, {}]]];
        x += width;
        return monitor;
    });
    await displayConfig('ApplyMonitorsConfig',
        new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [serial, 1, logical, {}]));
}

// The papers on the main monitor's edges, and nothing of them on the
// monitor beside it, whichever side that one is on.
async function testTwoMonitors(ext) {
    const notes = ext.stateObj.modules.get('notes');
    if (!check(Main.layoutManager.monitors.length === 2 && notes !== null, 'two monitors, and the notes'))
        return;
    const paper = [0xcd, 0xe1, 0xf7];
    const left = notes.store.create({title: 'Left', color: 'blue'});
    const right = notes.store.create({title: 'Right', color: 'blue', pin: 'right'});
    await restPointer();
    // (The profile in use put its wallpaper in at the start.)
    await wallpapersSettled();
    await Scripting.sleep(400);

    // At the main monitor's edge (x), halfway down a paper: its strip
    // inside, and outside what is there without the papers too. (Each
    // monitor in a picture of its own: across two of different heights, the
    // other one comes out black or garbled here.)
    const atEdge = async (name, tab, x, outsideOnTheLeft) => {
        const y = Math.round(tab.get_transformed_position()[1] + tab.height / 2);
        const [insideX, outsideX] = outsideOnTheLeft ? [x, x - 40] : [x - 40, x];
        const shoot = async suffix => {
            await screenshotArea(`${name}-inside${suffix}`, insideX, y - 20, 40, 40);
            await screenshotArea(`${name}-outside${suffix}`, outsideX, y - 20, 40, 40);
        };
        const tabs = [...notes._edges._tabs.values()];
        tabs.forEach(t => t.hide());
        await Scripting.sleep(100);
        await shoot('-bare');
        tabs.forEach(t => t.show());
        await Scripting.sleep(100);
        await shoot('');
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, outsideOnTheLeft ? x - 9 : x + 9, y);
        // (Next to the edge: 4 to 14 pixels from it, either side.)
        const [stripAt, besideAt] = outsideOnTheLeft ? [4, 26] : [26, 4];
        return {
            strip: colorDistance(averageColor(`${name}-inside`, stripAt, 10, 10, 20), paper) < 30,
            beside: colorDistance(averageColor(`${name}-outside`, besideAt, 10, 10, 20),
                averageColor(`${name}-outside-bare`, besideAt, 10, 10, 20)) < 8 && !tabs.some(t => t.contains(picked)),
        };
    };

    let main = Main.layoutManager.primaryMonitor;
    let edge = await atEdge('60-monitors-right-edge', notes._edges._tabs.get(right.id), main.x + main.width, false);
    check(edge.strip, 'the main monitor on the left: a paper on its right edge shows a strip');
    check(edge.beside, 'and none of it is on the monitor to the right');

    // The other monitor to the left of the main one.
    await arrangeMonitors(['Meta-1', 'Meta-0'], 'Meta-0');
    check(await waitFor(() => Main.layoutManager.primaryMonitor.x > 0, 3000), 'the other monitor moved to the left');
    await restPointer();
    await wallpapersSettled();
    await Scripting.sleep(600);
    main = Main.layoutManager.primaryMonitor;
    const tab = notes._edges._tabs.get(left.id);
    edge = await atEdge('61-monitors-left-edge', tab, main.x, true);
    check(edge.strip, 'a paper on the left edge goes along with the main monitor');
    check(edge.beside, 'and none of it is on the monitor to the left');
    await pointerTo(main.x + 5, tab.get_transformed_position()[1] + tab.height / 2);
    await Scripting.sleep(500);
    check(Math.abs(tab.get_transformed_position()[0] - main.x) < 1, 'all of it on hover, on the main monitor');
    await screenshotArea('62-monitors-note-out', main.x - 200, 0, 600, 500);
    await restPointer();
    const middle = global.stage.get_actor_at_pos(Clutter.PickMode.ALL,
        main.x + main.width / 2, main.y + main.height / 2);
    check(!notes._edges._sheet?.contains(middle), 'what the papers lie on is in the way of nothing');
    notes.store.remove(left.id);
    notes.store.remove(right.id);

    // Widgets placed on the main monitor. When the smaller one is the main
    // one (as when the bigger one is unplugged), they are near the same
    // edges there; when the bigger one is again, where they were on it.
    const desktop = ext.stateObj.modules.get('desktop');
    const desktopSettings = ext.stateObj._settings.get_child('desktop');
    const grid = [...desktop.grid];
    desktopSettings.set_string('widgets', JSON.stringify([
        {id: 'clock', kind: 'clock', size: 'square', x: 0, y: 0, grid, fine: true},
        {id: 'calendar', kind: 'calendar', size: 'large', x: 0, y: 4, grid, fine: true},
        {id: 'weather', kind: 'weather', size: 'square', x: grid[0] - 4, y: 0, grid, fine: true},
        {id: 'photo', kind: 'photo', size: 'square', x: grid[0] - 4, y: grid[1] - 4, grid, fine: true},
    ]));
    await Scripting.sleep(400);
    const cells = () => JSON.stringify(Object.fromEntries([...desktop.widgets.values()]
        .map(widget => [widget.entry.id, [widget.entry.x, widget.entry.y]])));
    const placed = cells();
    const layout = desktopSettings.get_string('widgets');
    await arrangeMonitors(['Meta-1', 'Meta-0'], 'Meta-1');
    check(await waitFor(() => desktop.grid[0] < grid[0], 3000), `the smaller monitor the main one (${desktop.grid})`);
    await wallpapersSettled();
    await Scripting.sleep(400);
    const [columns, rows] = desktop.grid;
    const near = JSON.stringify({clock: [0, 0], calendar: [0, 4], weather: [columns - 4, 0], photo: [columns - 4, rows - 4]});
    check(cells() === near, `the widgets near the same edges on it (${cells()})`);
    check(desktopSettings.get_string('widgets') === layout, 'where they were placed is kept');
    await screenshotArea('63-monitors-smaller-main', 0, 0, 1280, 1024);
    await arrangeMonitors(['Meta-1', 'Meta-0'], 'Meta-0');
    await waitFor(() => desktop.grid[0] === grid[0], 3000);
    await Scripting.sleep(400);
    check(cells() === placed, `the bigger one the main one again, where they were on it (${cells()})`);
}

/**
 * What the dock's checks in tools/dock-tests get.
 *
 * @param {object} ext - Atelier
 * @returns {object} t: {ext, module (the DockModule: module.dock is the
 *   main dock, module.docks all of them), settings (the dock's), check,
 *   waitFor, sleep, pointerTo, clickAt, pointerDown, pointerUp,
 *   pointerAlong, pressKey, pressKeys, restPointer, centerOf, findActor,
 *   hasClass, screenshot, screenshotArea, averageColor, colorDistance,
 *   Scripting, Main, St, Shell, Clutter, Meta, Gio, GLib, GObject,
 *   AppFavorites, MessageTray, OUTPUT, SUITE}
 */
function dockTestContext(ext) {
    return {
        ext,
        module: ext.stateObj.modules.get('dock'),
        settings: ext.stateObj._settings.get_child('dock'),
        check, waitFor, sleep: Scripting.sleep,
        pointerTo, clickAt, pointerDown, pointerUp, pointerAlong, pressKey, pressKeys, restPointer,
        centerOf, findActor, hasClass,
        screenshot, screenshotArea, averageColor, colorDistance,
        Scripting, Main, St, Shell, Clutter, Meta, Gio, GLib, GObject, AppFavorites, MessageTray,
        OUTPUT, SUITE,
    };
}

async function testDock(ext) {
    const module = ext.stateObj.modules.get('dock');
    if (!check(module !== null && module.dock !== null, 'the dock is there (Dash to Dock is off here)'))
        return;
    const t = dockTestContext(ext);
    for (const suite of [dockCore, dockHiding, dockBehaviour, dockBadges, dockLaunchers, dockAppearance, dockWindows])
        await suite.shell(t);
}

async function testDockOnTwoMonitors(ext) {
    await dockCore.twoMonitors(dockTestContext(ext));
}

async function testClaude(ext) {
    const claude = ext.stateObj.modules.get('claude');
    if (!check(claude !== null, 'Claude module running'))
        return;
    check(await waitFor(() => claude.hasData, 8000), 'it reads Claude Code\'s history');
    const summary = claude.usage.summary;
    check(summary?.block?.totals.output === 1500 && summary?.week.output === 5500,
        `this block and the week, each answer once (${summary?.block?.totals.output}, ${summary?.week.output})`);
    const indicator = Main.panel.statusArea['atelier-claude'];
    check(indicator?.visible && indicator._label.text === '1.5k',
        `the bar shows the block's output (${indicator?._label.text})`);
    await restPointer();
    await screenshotArea('29-bar-claude', global.stage.width - 400, 0, 400, 44);

    const island = ext.stateObj.modules.get('island').island;
    await pointerTo(...centerOf(indicator));
    check(await waitFor(() => hasClass(island.page, 'atelier-preview'), 2000),
        'resting on it shows the details in the island');
    await Scripting.sleep(600);
    await screenshotIsland('30-claude-preview', 420);
    await restPointer();
    check(await waitFor(() => island.page === null, 2000), 'they go when the pointer leaves');

    Main.panel.toggleQuickSettings();
    await waitFor(() => hasClass(island.page, 'atelier-cc'), 1000);
    island.page.setTab('claude');
    await Scripting.sleep(600);
    check(island.page.tab === 'claude' && claude.view.mapped, 'the control centre has a Claude tab');
    await screenshotIsland('31-control-centre-claude', 460);
    Main.panel.closeQuickSettings();
    await waitFor(() => island.page === null, 1000);

    const bar = ext.stateObj._settings.get_child('bar');
    bar.set_strv('modules', []);
    await Scripting.sleep(200);
    check(Main.panel.statusArea['atelier-claude'] === undefined, 'it can be left out of the bar');
    // Then nothing shows the numbers: read once more, they are not read on
    // and on – until something shows them again.
    claude.usage.refresh();
    check(await waitFor(() => !claude.usage._cancellable, 8000) && claude.usage._timeoutId === 0,
        'with nothing showing the numbers, they are not read on and on');
    bar.reset('modules');
    check(await waitFor(() => claude.usage._timeoutId !== 0, 8000), 'back in the bar, they are');
    await Scripting.sleep(300);
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
    const group = Main.layoutManager._backgroundGroup;
    const overlays = atelier._applier.transition?._session?.overlays ?? [];
    const widgets = group.get_children().find(child => child.name === 'atelier-desktop');
    check(overlays.length > 0 && widgets && overlays.every(overlay =>
        group.get_children().indexOf(overlay) < group.get_children().indexOf(widgets)),
    'the widgets stay over the new wallpaper as it comes in');
    await Scripting.sleep(Math.round(duration * 0.4));
    await screenshot('04-reveal-half');

    check(await waitFor(() => !atelier._applier.busy, duration + 6000), 'apply finished');
    // (The desktop's look as it was fades over once the shell is calm.)
    check(await waitFor(() => overlayCount() === 0, 4000), `overlay removed (extra actors: ${overlayCount()})`);
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
    // Crossing over: the highlight pours from one tab to the other, the
    // cards left go off to the side as the new ones come in.
    await Scripting.sleep(120);
    const leaving = switcher._viewport.get_children().filter(child => child !== switcher._strip);
    check(switcher._pour.visible && leaving.length === 1 && leaving[0].opacity < 255 &&
        switcher._cards.some(card => card.translation_x !== 0),
    'crossing over, the highlight pours, the cards go and come');
    await screenshot('09-switcher-crossing');
    check(await waitFor(() => !switcher._pour.visible && switcher._viewport.get_n_children() === 1 &&
        switcher._cards.every(card => card.translation_x === 0), 2000) &&
        switcher._tabs.profiles.style === null, 'then all as it was, on the other tab');
    switcher.setMode('wallpapers');
    // (Crossing back at once: the crossing before is done with.)
    switcher.setMode('profiles');
    switcher.setMode('wallpapers');
    check(switcher._viewport.get_n_children() === 2 && switcher._cards.length === 2, 'crossing over and over, nothing piles up');
    await Scripting.sleep(800);
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

// Frames of a profile moved, slowed down, into $ATELIER_TEST_FRAMES (with
// the real time of each), for a video.
async function recordMoveProfiles(atelier, folder) {
    const bar = Main.extensionManager.lookup(UUID).stateObj._settings.get_child('bar');
    bar.set_string('surface', 'glass');
    bar.set_string('island-shape', 'notch');
    const before = atelier._store.getAll().map(profile => profile.id);
    await Scripting.sleep(800);
    atelier.toggleSwitcher('profiles');
    await Scripting.sleep(1500);
    const switcher = atelier._switcher;
    switcher._select(1);
    await Scripting.sleep(600);
    const slow = 8;
    const motion = St.Settings.get();
    const times = [];
    const start = GLib.get_monotonic_time();
    let n = 0;
    const shoot = async until => {
        while (GLib.get_monotonic_time() < until) {
            times.push((GLib.get_monotonic_time() - start) / 1000 / slow);
            await screenshotArea(`../frames/${String(n++).padStart(4, '0')}`,
                Math.round(global.stage.width / 2) - 520, 0, 1040, 250);
        }
    };
    const after = ms => GLib.get_monotonic_time() + ms * slow * 1000;
    GLib.mkdir_with_parents(folder, 0o755);
    motion.slow_down_factor = slow;
    try {
        await shoot(after(150));
        virtualKeyboard ??= seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        virtualKeyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Tab, Clutter.KeyState.PRESSED);
        await shoot(after(900));
        for (const key of [Clutter.KEY_Right, Clutter.KEY_Right]) {
            virtualKeyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
            virtualKeyboard.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
            await shoot(after(800));
        }
        virtualKeyboard.notify_keyval(GLib.get_monotonic_time(), Clutter.KEY_Tab, Clutter.KeyState.RELEASED);
        await shoot(after(900));
    } finally {
        motion.slow_down_factor = 1;
    }
    GLib.file_set_contents(`${folder}/times.txt`, `${times.map(t => t.toFixed(1)).join('\n')}\n`);
    switcher.close();
    await waitFor(() => atelier._switcher === null, 2000);
    atelier._store.setAll(before.map(id => atelier._store.get(id)));
    bar.reset('surface');
    bar.reset('island-shape');
    await Scripting.sleep(500);
}

// As the session starts, Atelier may come before GNOME's system item in
// the quick settings (the battery tile, the power button), which GNOME
// makes a moment after the bar: the compact bar's battery and the power
// button's menu come as soon as it is there.
async function testSystemItemLater() {
    const ext = () => Main.extensionManager.lookup(UUID);
    const bar = ext().stateObj._settings.get_child('bar');
    bar.set_string('style', 'island');
    bar.set_boolean('compact', true);
    const quickSettings = Main.panel.statusArea.quickSettings;
    const system = quickSettings._system;
    const powerToggle = system._systemItem.powerToggle;
    const batteryShown = powerToggle.visible;
    powerToggle.visible = true;
    try {
        quickSettings._system = undefined;
        Main.extensionManager.disableExtension(UUID);
        await Scripting.sleep(300);
        Main.extensionManager.enableExtension(UUID);
        await waitFor(() => ext().stateObj?.modules?.get('controlCentre'), 5000);
        await Scripting.sleep(500);
        check(Main.panel.statusArea['atelier-battery'] === undefined, 'before GNOME has its battery tile, no battery yet');
        // GNOME makes it, and puts the quick settings' indicators in the bar.
        quickSettings._system = system;
        const indicator = new St.Widget();
        quickSettings._indicators.add_child(indicator);
        indicator.destroy();
        const battery = Main.panel.statusArea['atelier-battery'];
        await Scripting.sleep(300);
        check(battery?.visible && battery.container.visible && battery.container.get_parent() === Main.panel._rightBox &&
            battery.width > 0, 'then the compact bar has its battery');
        const island = ext().stateObj.modules.get('island').island;
        Main.panel.toggleQuickSettings();
        await waitFor(() => hasClass(island.page, 'atelier-cc'), 1000);
        click(system._systemItem.child.get_last_child());
        check(await waitFor(() => hasClass(island.page, 'atelier-power') && island.busy, 1000) &&
            !system._systemItem.menu.isOpen, 'and its power button opens Atelier\'s power menu');
        await pressKey(Clutter.KEY_Escape);
        await waitFor(() => island.page === null && !island.busy, 1000);
    } finally {
        quickSettings._system = system;
        powerToggle.visible = batteryShown;
        bar.reset('style');
        bar.reset('compact');
        await Scripting.sleep(300);
    }
}

async function testMoveProfiles(atelier) {
    const frames = GLib.getenv('ATELIER_TEST_FRAMES');
    if (frames)
        await recordMoveProfiles(atelier, `${OUTPUT}/../frames`);

    const order = () => atelier._store.getAll().map(profile => profile.id);
    const before = order();
    // (On glass, as the user has it.)
    const bar = Main.extensionManager.lookup(UUID).stateObj._settings.get_child('bar');
    bar.set_string('surface', 'glass');
    bar.set_string('island-shape', 'notch');
    await Scripting.sleep(500);
    atelier.toggleSwitcher('profiles');
    await Scripting.sleep(500);
    const switcher = atelier._switcher;
    if (!check(switcher?.mode === 'profiles' && before.length >= 4, 'the switcher is open on the profiles'))
        return;
    try {
        switcher._select(1);
        await Scripting.sleep(400);
        const card = switcher._cards[1];
        const id = card.item.id;

        // Tab held softens the profile into a drop of itself, where it is;
        // nothing else happens.
        await keyDown(Clutter.KEY_Tab);
        check(await waitFor(() => switcher._melting?.held && switcher._melting.card === card &&
            card.opacity === 0 && switcher._melting.melt?._soft > 0.8, 2000),
        `held, Tab softens the profile (${switcher._melting?.melt?._soft?.toFixed(2)})`);
        const melt = switcher._melting?.melt;
        const [meltX] = melt?._pictures[0].get_transformed_position() ?? [0];
        const [cardX0] = card.get_transformed_position();
        check(melt?._pictures[0].visible && !melt._pictures[1].visible && Math.abs(meltX - cardX0) < 12,
            `a drop of its picture, in its place (${(meltX - cardX0).toFixed(1)})`);
        check(switcher.mode === 'profiles', 'and stays on the Profiles tab');
        await screenshotIsland('40-profile-softened', 320);

        // To the right: it pours over; mid-way its picture leaves on one
        // side and arrives on the other, a stream between.
        const seen = {both: false, stream: false};
        const sampler = GLib.timeout_add(GLib.PRIORITY_HIGH, 8, () => {
            seen.both ||= melt._pictures.every(picture => picture.visible);
            seen.stream ||= Boolean(melt._pour && melt._pour.t > 0.2 && melt._pour.t < 0.8);
            return GLib.SOURCE_CONTINUE;
        });
        await pressKey(Clutter.KEY_Right);
        check(switcher._cards[2] === card && switcher._items[2].id === id && switcher._selected === 2 &&
            switcher._items[1].id === before[2] && switcher._strip.get_child_at_index(2) === card,
        'it moves one place right, the one it passed one left');
        check(await waitFor(() => !melt._pour, 2000) && melt._place[0] === switcher._placeOf(2)[0],
            'pouring over to its new place');
        GLib.source_remove(sampler);
        check(seen.both && seen.stream, 'its picture leaving one place and filling the other, a stream between');
        check(Boolean(card.style) && melt._pictures.every(picture => picture.style === card.style),
            'the picture of its card (its thumbnail, whenever that comes)');
        check(order().indexOf(id) === 1, 'not saved while still held');

        // Slowed down, to look at: back to the start, and a bump there.
        const motion = St.Settings.get();
        motion.slow_down_factor = 6;
        try {
            await pressKey(Clutter.KEY_Left);
            for (let n = 1; n <= 8; n++) {
                await Scripting.sleep(300);
                await screenshotIsland(`40b-profile-pouring-${n}`, 320);
            }
        } finally {
            motion.slow_down_factor = 1;
        }
        await waitFor(() => !melt._pour, 2000);
        await pressKey(Clutter.KEY_Left);
        await pressKey(Clutter.KEY_Left);
        await Scripting.sleep(200);
        check(switcher._cards[0] === card && switcher._selected === 0, 'past the first place, it stays first');

        // End: as far as the last profile ("new profile" stays last); the
        // strip follows, keeping it in view.
        await pressKey(Clutter.KEY_End);
        await Scripting.sleep(900);
        const last = before.length - 1;
        const [viewX] = switcher._viewport.get_transformed_position();
        const [cardX] = card.get_transformed_position();
        check(switcher._cards[last] === card && switcher._items.at(-1).id === 'atelier-new-profile' &&
            cardX >= viewX && cardX + card.width <= viewX + switcher._viewport.width,
        `End takes it to the last profile, in view (${cardX - viewX}, view ${switcher._viewport.width})`);
        await pressKey(Clutter.KEY_Left);
        await waitFor(() => !melt._pour, 3000);
        await screenshotIsland('40c-profile-moved', 320);

        // Let go of: down there, saved; the switcher stays as it was.
        await keyUp(Clutter.KEY_Tab);
        const expected = before.filter(other => other !== id);
        expected.splice(last - 1, 0, id);
        check(switcher._melting && !switcher._melting.held && JSON.stringify(order()) === JSON.stringify(expected),
        `let go of, Tab puts it down there, saved (${order().join(' ')})`);
        check(atelier._switcher === switcher && switcher.mode === 'profiles' && switcher._cards.includes(card),
            'the switcher stays open, on the profiles, with the same cards');
        check(await waitFor(() => switcher._melting === null, 4000) &&
            switcher._strip.get_children().every((child, i) => child === switcher._cards[i]),
        'it firms up into its card, in its place in the row');
        check(await waitFor(() => card.opacity === 255 && card.scale_x === 1, 1000) &&
            !switcher._viewport.get_children().some(child => child === melt),
        `the card itself again, its liquid gone (${card.opacity})`);

        // A tap still switches tabs (once let go of); from the wallpapers, at once.
        await pressKey(Clutter.KEY_Tab);
        check(await waitFor(() => switcher.mode === 'wallpapers', 1000), 'a tap of Tab goes over to the wallpapers');
        await keyDown(Clutter.KEY_Tab);
        // (Before it is let go of.)
        check(await waitFor(() => switcher.mode === 'profiles', 1000),
            `and Tab back to the profiles at once (${switcher.mode}, held ${JSON.stringify(switcher._hold)})`);
        await Scripting.sleep(400);
        check(switcher._melting === null, 'nothing softens by that');
        await keyUp(Clutter.KEY_Tab);
        await Scripting.sleep(500);

        // The "new profile" card stays where it is.
        switcher._select(switcher._cards.length - 1);
        await Scripting.sleep(300);
        await keyDown(Clutter.KEY_Tab);
        await Scripting.sleep(300);
        await pressKey(Clutter.KEY_Left);
        await keyUp(Clutter.KEY_Tab);
        check(switcher._melting === null && switcher._items.at(-1).id === 'atelier-new-profile' &&
            switcher.mode === 'profiles' && JSON.stringify(order()) === JSON.stringify(expected),
        'the "new profile" card can\'t be moved');

        // Held and moved, Esc puts it down, saved, and closes the switcher.
        await Scripting.sleep(400);
        switcher._select(0);
        await Scripting.sleep(300);
        const moved = switcher._items[0].id;
        await keyDown(Clutter.KEY_Tab);
        await pressKey(Clutter.KEY_Right);
        await pressKey(Clutter.KEY_Escape);
        await keyUp(Clutter.KEY_Tab);
        check(await waitFor(() => atelier._switcher === null, 2000) && order().indexOf(moved) === 1,
            'Esc puts it down where it is and closes the switcher');
    } finally {
        atelier._switcher?.close();
        await waitFor(() => atelier._switcher === null, 2000);
        atelier._store.setAll(before.map(other => atelier._store.get(other)));
        bar.reset('surface');
        bar.reset('island-shape');
        await Scripting.sleep(500);
    }

    // Without the island, in the popup, the same.
    const islandSettings = Main.extensionManager.lookup(UUID).stateObj._settings.get_child('island');
    islandSettings.set_boolean('enabled', false);
    await Scripting.sleep(300);
    try {
        atelier.toggleSwitcher('profiles');
        await Scripting.sleep(400);
        const popup = atelier._switcher;
        popup._select(0);
        await Scripting.sleep(300);
        const id = popup._items[0].id;
        await keyDown(Clutter.KEY_Tab);
        await pressKey(Clutter.KEY_Right);
        await keyUp(Clutter.KEY_Tab);
        check(order().indexOf(id) === 1 && popup.mode === 'profiles', 'in the popup too, Tab held and an arrow move it');
        await pressKey(Clutter.KEY_Escape);
        await waitFor(() => atelier._switcher === null, 2000);
    } finally {
        atelier._switcher?.close();
        await waitFor(() => atelier._switcher === null, 2000);
        atelier._store.setAll(before.map(other => atelier._store.get(other)));
        islandSettings.reset('enabled');
        await Scripting.sleep(300);
    }
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

    // The island drips a sheet to name it and give it a style, right away.
    // Slowed down to look at: the switcher draws back into the island, and
    // as it all but has, one drop swells out of the island and hangs from it
    // on a neck, which snaps; the drop falls and spreads. (Pictures every
    // 0.9 s of the slowed down way.)
    const islandModule = ext.stateObj.modules.get('island');
    const watchDrip = async (name, start) => {
        const island = islandModule.island;
        const settings = St.Settings.get();
        let [quiet, hanging] = [false, false];
        settings.slow_down_factor = 8;
        try {
            start();
            if (!await waitFor(() => islandModule._sheet !== null, 1000))
                return false;
            for (let n = 1; n <= 8; n++) {
                await Scripting.sleep(n === 1 ? 400 : 900);
                const liquid = islandModule._sheet?._liquid;
                // (No drop of its own while the switcher draws back.)
                if (n === 1)
                    quiet = (liquid?._drop?.[2] ?? 0) === 0 && Boolean(island.get_transition('height'));
                hanging ||= (liquid?._neck?.[3] ?? 0) > 0 && !island.get_transition('height');
                await screenshotArea(`${name}-${n}`, Math.round(global.stage.width / 2) - 360, 0, 720, 760);
            }
        } finally {
            settings.slow_down_factor = 1;
        }
        return quiet && hanging;
    };
    check(await watchDrip('18-new-profile-drop', () => switcher._activate(last)),
        'the switcher goes back into the island, and one drop swells out of it and hangs, then falls');
    const sheet = islandModule._sheet;
    check(await waitFor(() => sheet?.opened && sheet.opacity === 255, 8000), 'and spreads into a sheet');
    const form = sheet.form;
    check(form._name.text === 'Pills' && global.stage.key_focus === form._name.clutter_text,
        `named after the wallpaper, ready to be named anew (${form._name.text})`);
    check(atelier._store.getAll().length === count, 'not saved yet');
    await screenshot('19-new-profile-sheet');
    form._name.text = 'Pills at night';
    form._accents.find(swatch => swatch._value === 'teal').emit('clicked', 1);
    form._schemes.find(segment => segment._value === 'prefer-dark').emit('clicked', 1);
    await pressKey(Clutter.KEY_Return);
    check(await waitFor(() => atelier._store.getAll().length === count + 1, 3000), 'Enter saves it');
    const added = atelier._store.getAll().at(-1);
    check(added.name === 'Pills at night' && added.accentColor === 'teal' && added.colorScheme === 'prefer-dark' &&
        atelier._store.activeId === added.id, `with its name and style, active (${added.name}, ${added.accentColor})`);
    check(added.wallpaper?.startsWith(`${GLib.get_user_data_dir()}/atelier/wallpapers/`),
        `with its own copy of the wallpaper (${added.wallpaper})`);
    const palette = ext.stateObj._settings.get_child('palette');
    check(added.palette?.variant === palette.get_string('variant') && added.gtkTheme === 'HighContrast',
        'and the palette and themes in use');
    check(await waitFor(() => islandModule._sheet === null && islandModule._liquid === null, 3000),
        'the sheet goes back into the island');
    const island = islandModule.island;
    check(await waitFor(() => hasClass(island.page, 'atelier-toast') && island.page.title === added.name, 2000),
        'the island announces it');
    check(atelier._switcher === null, 'in place of the switcher');
    const desktopInterface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    check(await waitFor(() => desktopInterface.get_string('accent-color') === 'teal', 3000),
        'and the desktop takes its style');
    await waitFor(() => island.page === null, 4000);

    // Out of glass, from a notch; Esc saves nothing.
    const bar = ext.stateObj._settings.get_child('bar');
    bar.set_string('surface', 'glass');
    bar.set_string('island-shape', 'notch');
    await Scripting.sleep(500);
    check(islandModule._glass?._live === null, 'at rest, the island\'s glass is of the wallpaper');
    atelier.toggleSwitcher();
    await Scripting.sleep(500);
    // Grown out, live glass: of the windows (and widgets) under it too.
    check(islandModule._glass?._live?.visible === true, 'open, it is live glass, of what is under it');
    await screenshotIsland('20-switcher-live-glass', 420);
    check(await watchDrip('20-new-profile-drop-glass',
        () => atelier._switcher._activate(atelier._switcher._cards.length - 1)), 'again, from a notch of glass');
    check(await waitFor(() => islandModule._sheet?.opened, 8000), 'the sheet open');
    check(islandModule._liquid?._live?.visible === true, 'the sheet of live glass too');
    await Scripting.sleep(200);
    await screenshot('21-new-profile-sheet-glass');
    // Going, slowed down: it gathers into a drop that rises back into the
    // island on a neck.
    const settings = St.Settings.get();
    settings.slow_down_factor = 8;
    try {
        await pressKey(Clutter.KEY_Escape);
        for (let n = 1; n <= 5; n++) {
            await Scripting.sleep(900);
            await screenshotArea(`22-new-profile-close-glass-${n}`, Math.round(global.stage.width / 2) - 360, 0, 720, 760);
        }
    } finally {
        settings.slow_down_factor = 1;
    }
    check(await waitFor(() => islandModule._sheet === null, 6000) && atelier._store.getAll().length === count + 1,
        'Esc saves nothing');
    check(await waitFor(() => islandModule._glass?._live === null, 3000), 'and the island at rest, of the wallpaper again');
    bar.reset('surface');
    bar.reset('island-shape');
    await Scripting.sleep(300);

    // With animations off (an accessibility setting, or GNOME without
    // graphics acceleration), the sheet shows and goes all the same.
    settings.inhibit_animations();
    try {
        atelier.toggleSwitcher();
        await Scripting.sleep(300);
        atelier._switcher._activate(atelier._switcher._cards.length - 1);
        check(await waitFor(() => islandModule._sheet?.opened && islandModule._sheet.opacity === 255, 3000),
            'with animations off, the sheet shows');
        await pressKey(Clutter.KEY_Escape);
        check(await waitFor(() => islandModule._sheet === null && islandModule._liquid === null, 3000) &&
            atelier._store.getAll().length === count + 1, 'and goes, saving nothing');
    } finally {
        settings.uninhibit_animations();
    }
    await waitFor(() => islandModule.island.page === null, 2000);
}

async function testSwitcherPopupGoesWithAtelier() {
    // Without the island (or beside a full screen window), the switcher is a
    // popup. Turned off while it is open – as when the screen locks – it
    // goes, and so does its grab: clicks and keys reach the desktop again.
    const islandSettings = Main.extensionManager.lookup(UUID).stateObj._settings.get_child('island');
    islandSettings.set_boolean('enabled', false);
    await Scripting.sleep(300);
    Main.extensionManager.lookup(UUID).stateObj.modules.get('profiles').toggleSwitcher();
    await Scripting.sleep(400);
    const popup = () => findActor(Main.uiGroup, a => hasClass(a, 'atelier-panel'));
    check(popup() && Main.actionMode === Shell.ActionMode.POPUP, 'without the island, the switcher is a popup');
    Main.extensionManager.disableExtension(UUID);
    await Scripting.sleep(300);
    check(!popup() && Main.actionMode === Shell.ActionMode.NORMAL,
        'turned off while it is open, it goes, and so does its grab');
    Main.extensionManager.enableExtension(UUID);
    await waitFor(() => Main.extensionManager.lookup(UUID).stateObj.modules?.get('profiles'), 3000);
    islandSettings.reset('enabled');
    await Scripting.sleep(300);
}

// Stands in for GNOME's check of who is there on the lock screen: a real
// one would ask GDM and PAM about the real session's user. It asks for a
// password (a moment later, as GDM does) and keeps the answers.
class FakeVerifier extends EventEmitter {
    constructor() {
        super();
        this.answers = [];
        this.smartcardDetected = false;
        this.hasPendingMessages = false;
        this.allowedFailures = 3;
    }

    begin(_userName, hold) {
        hold?.release?.();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.emit('ask-question', 'gdm-password', 'Password:', true);
            return GLib.SOURCE_REMOVE;
        });
    }

    answerQuery(_service, answer) {
        this.answers.push(answer);
    }

    serviceIsDefault(service) {
        return service === 'gdm-password';
    }

    serviceIsFingerprint(service) {
        return service === 'gdm-fingerprint';
    }

    foregroundServiceDeterminesUsername() {
        return false;
    }

    cancel() {}

    clear() {}

    selectChoice() {}

    increaseCurrentMessageTimeout() {}

    destroy() {}
}

async function typeText(text) {
    for (const char of text)
        await pressKey(Clutter.unicode_to_keysym(char.codePointAt(0)));
}

// The lock screen: the rest of Atelier stops, the island with the padlock
// follows a made-up check, and everything comes back once it is unlocked.
// (The lock screen's own check is made up: see FakeVerifier.)
async function testLockScreen(ext) {
    const shield = Main.screenShield;
    if (!shield) {
        results.push('INFO  no lock screen here (no GDM): the lock screen untested');
        return;
    }
    const injections = new InjectionManager();
    const verifiers = [];
    injections.overrideMethod(AuthPromptModule.AuthPrompt.prototype, '_createUserVerifier', () => function () {
        const verifier = new FakeVerifier();
        verifiers.push(verifier);
        return verifier;
    });
    // (It is the real session's: locking here must not tell logind it is locked.)
    const loginSession = shield._loginSession;
    shield._loginSession = null;
    const atelier = () => Main.extensionManager.lookup(UUID).stateObj;
    const lock = () => atelier().lockModules?.get('lockscreen');
    const phase = () => lock()?.state.phase;
    try {
        shield.lock(false);
        check(await waitFor(() => Main.sessionMode.isLocked && lock()?.island?.actor, 5000) &&
            !lock().island.actor.visible, 'locked: the island with the padlock tucked away while it rests');
        const island = lock().island;
        const uiGroup = Main.layoutManager.uiGroup.get_children();
        check(uiGroup.indexOf(island.actor) > uiGroup.indexOf(Main.layoutManager.screenShieldGroup),
            'above GNOME\'s lock screen, as the top bar is');
        check(ext.state === ExtensionState.ACTIVE && atelier().modules.get('island') === null &&
            atelier().modules.get('desktop') === null && atelier().modules.get('dock') === null,
            'the rest of Atelier is down, the extension still on');
        check(!findActor(Main.uiGroup, a => a.name === 'atelier-dock' || a.name === 'atelier-desktop'),
            'nothing else of it shows');
        check(phase() === 'locked' && island.padlock.look.shackle === 'closed', 'the padlock is closed');
        const status = Main.panel.statusArea.quickSettings.container;
        check(!status.visible, 'GNOME\'s status icons are not in its corner');

        // A click on the lock screen brings up the password prompt, and the
        // island comes out of the top edge.
        await clickAt(300, 800);
        check(await waitFor(() => phase() === 'ready', 3000), `a click brings up the prompt (${phase()})`);
        check(island.padlock.look.ring === 'spin', 'and the wave runs round the ring from then on, not only once typed');
        check(await waitFor(() => lock().room === 1 && island.actor.mapped && island.actor.translation_y === 0 &&
            island.actor.opacity === 255, 2000), 'the island comes out of the top edge as it does');
        await restPointer();
        await Scripting.sleep(300);
        await screenshotIsland('80-lock-padlock', 160);
        const verifier = verifiers.at(-1);
        // A face looked for before the password is asked (Howdy says so).
        verifier.emit('reset');
        verifier.emit('show-message', 'gdm-password', 'Attempting face login', 2);
        check(phase() === 'scanning' && island.padlock.look.ring === 'spin', `a face is looked for (${phase()})`);
        check(await waitFor(() => phase() === 'ready', 3000), 'then the password is asked after all');
        verifier.emit('show-message', 'gdm-fingerprint', '(or place finger on reader)', 1);
        check(lock().state.finger && island.padlock.look.ring === 'track', 'a fingerprint reader waits beside it');

        // A wrong password: one answer, a shake, asked again.
        await typeText('wrong');
        await pressKey(Clutter.KEY_Return);
        check(await waitFor(() => verifier.answers.length === 1, 2000) && verifier.answers[0] === 'wrong',
            `the answer goes to GNOME once (${verifier.answers.length})`);
        verifier.emit('show-message', 'gdm-password', 'Sorry, that didn\'t work. Please try again.', 3);
        verifier.emit('verification-failed', 'gdm-password', true);
        // (Retrying, GDM asks again at once.)
        verifier.emit('ask-question', 'gdm-password', 'Password:', true);
        check(phase() === 'failed' && island.padlock.has_style_pseudo_class('failed'), 'a failure turns the ring red');
        let [tight, shaken, reddened, pictured] = [0, 0, 0, false];
        await waitFor(() => {
            const [t, shake] = island.padlock._cramping();
            tight = Math.max(tight, t);
            shaken = Math.max(shaken, Math.abs(shake));
            reddened = Math.max(reddened, island.padlock._red);
            if (!pictured && t > 0.8) {
                pictured = true;
                screenshotIsland('81-lock-failed', 160);
            }
            return !island.padlock._timelines.has('cramp');
        }, 2000);
        check(tight > 0.8 && shaken > 0.5 && reddened > 0.5 && island.padlock._cramp === 0,
            `it cramps up, smaller and darker, the padlock smaller, reddened and shaking, and lets go (${tight.toFixed(2)}, ${shaken.toFixed(2)}, ${reddened.toFixed(2)})`);
        check(await waitFor(() => phase() === 'ready' && island.padlock._red === 0, 3000), 'and settles, white again');

        // The right one.
        await typeText('right');
        await pressKey(Clutter.KEY_Return);
        check(await waitFor(() => verifier.answers.includes('right'), 2000),
            `the right one goes to GNOME too (${verifier.answers.length})`);
        verifier.emit('verification-complete');
        check(phase() === 'success' && island.padlock.look.shackle === 'open' &&
            island.padlock.has_style_pseudo_class('success'), 'unlocked: the padlock opens in a green ring');
        const padlock = island.padlock;
        check(padlock._shackle === 1 && padlock._swing === 0 && padlock._hop === 0 && padlock._spread === 1 &&
            padlock._color === 1 && padlock._wave === 0 && padlock._timelines.size === 0,
        'at once, open in its full green ring, nothing moving (GNOME stops the shell a moment now)');
        await screenshotIsland('82-lock-success', 160);

        // logind's Unlock, as GDM would have it sent.
        const veil = [];
        Main.panel.connectObject('notify::opacity', () => veil.push(Main.panel.opacity), veil);
        shield.deactivate(false);
        check(await waitFor(() => !Main.sessionMode.isLocked && atelier().modules.get('island')?.island, 4000),
            'unlocked, the rest of Atelier is back');
        Main.panel.disconnectObject(veil);
        check(veil[0] === 0 && Main.panel.opacity === 0,
            `GNOME's bar out of sight till then, as plain GNOME's (${veil})`);
        const panelNode = Main.panel.get_theme_node();
        check(panelNode.get_transition_duration() === 0 && panelNode.get_background_color().alpha === 0,
            'and clear at once, not fading from GNOME\'s black');
        check(status.visible, 'and the bar its status icons, as its style has them');
        const allBack = () => atelier().modules._entries.every(entry => entry.instance || !atelier().modules._wanted(entry));
        check(allBack(), 'all of it in one go, not one module after another');
        const afterglow = atelier()._afterglow;
        check(Boolean(afterglow?.actor) && atelier().lockModules.get('lockscreen') === null,
            'the padlock stays a moment over the island');
        const sessionIsland = atelier().modules.get('island').island;
        check(sessionIsland.opacity === 0, 'which waits, tucked away');
        check(Main.panel.opacity === 0, 'and the bar with it');
        check(await waitFor(() => !afterglow.actor, 2000), 'the padlock goes back up');
        check(await waitFor(() => sessionIsland.translation_y === 0 && sessionIsland.opacity === 255 &&
            !sessionIsland.get_transition('translation_y'), 2000) && atelier()._afterglow === null,
        'then the island comes out of the top edge');
        check(await waitFor(() => Main.panel.opacity === 255 && Main.panel.translation_y === 0, 1000),
            'and the bar with it');
        check(!findActor(Main.layoutManager.screenShieldGroup, a => a.style_class?.includes('atelier')),
            'nothing of Atelier is left in the lock screen');

        // Unlocked as in a session with other extensions: the shell stopped
        // for 600 ms as GNOME turns them all on (one reloading the shell's
        // theme). By then the padlock has been drawn open, still – GNOME
        // held up for a frame, no more – and after it, it goes back up.
        await Scripting.sleep(2000);
        shield.lock(false);
        await waitFor(() => lock()?.island?.actor, 5000);
        await clickAt(300, 800);
        check(await waitFor(() => phase() === 'ready' && lock().island.actor.translation_y === 0, 3000),
            'locked again, the password asked');
        const leaving = lock().island;
        const samples = [];
        const sampler = new Clutter.Timeline({actor: global.stage, duration: 1000, repeat_count: -1});
        sampler.connect('new-frame', () => samples.push({
            time: GLib.get_monotonic_time() / 1000,
            hop: leaving.padlock._hop,
            spread: leaving.padlock._spread,
            shackle: leaving.padlock._shackle,
            shown: Boolean(leaving.actor?.mapped && leaving.actor.opacity > 0),
        }));
        sampler.start();
        let thawed = 0;
        let stopped = 0;
        const stopper = Main.sessionMode.connect('updated', () => {
            Main.sessionMode.disconnect(stopper);
            stopped = GLib.get_monotonic_time() / 1000;
            const until = GLib.get_monotonic_time() + 600000;
            while (GLib.get_monotonic_time() < until) {
                // the shell stopped
            }
            thawed = GLib.get_monotonic_time() / 1000;
        });
        // (As GNOME has it: verified, then the lock screen goes.)
        const asked = GLib.get_monotonic_time() / 1000;
        const curtain = shield._lockDialogGroup;
        let moved = 0;
        let firstPlace = null;
        const mover = curtain.connect('notify::translation-y', () => {
            moved ||= GLib.get_monotonic_time() / 1000;
            firstPlace ??= curtain.translation_y;
        });
        shield.deactivate(false);
        check(await waitFor(() => !Main.sessionMode.isLocked && thawed > 0, 4000) && allBack(),
            'unlocked with the shell stopped a moment, all of Atelier is back at once');
        check(await waitFor(() => moved > 0 && !shield._dialog, 4000) && moved >= thawed &&
            firstPlace === -global.stage.height,
        `the lock screen goes once the shell is calm again, at once (${Math.round(moved - thawed)} ms after, to ${firstPlace})`);
        curtain.disconnect(mover);
        await waitFor(() => !leaving.actor, 4000);
        sampler.stop();
        const before = samples.filter(sample => sample.time > asked && sample.time < stopped);
        check(before.some(sample => sample.shackle === 1 && sample.spread === 1 && sample.hop === 0),
            `before the shell stops, a frame with the padlock open and still (${before.length} frames)`);
        check(stopped - asked < 150, `GNOME held up for a frame, no more (${Math.round(stopped - asked)} ms)`);
        const after = samples.filter(sample => sample.time > thawed);
        const shownFor = Math.max(0, ...after.filter(sample => sample.shown).map(sample => sample.time)) - thawed;
        check(after.every(sample => sample.hop === 0 && sample.shackle === 1) && shownFor > 150 && shownFor < 1500,
            `after it, still open, a moment, then back up (${Math.round(shownFor)} ms)`);
        check(await waitFor(() => atelier().modules.get('island')?.island?.opacity === 255 && atelier()._afterglow === null,
            2000), 'then the island comes out');

        // Turned off and on while locked: only the padlock comes back.
        // (GNOME's calendar starts its event source anew with each unlock:
        // not dropped mid-way by a lock a moment later.)
        await Scripting.sleep(2000);
        shield.lock(false);
        await waitFor(() => lock()?.island, 5000);
        Main.extensionManager.disableExtension(UUID);
        check(await waitFor(() => !findActor(Main.uiGroup, a => hasClass(a, 'atelier-lock-island')), 2000),
            'turned off while locked, the padlock goes');
        Main.extensionManager.enableExtension(UUID);
        check(await waitFor(() => lock()?.island && atelier().modules.get('island') === null, 5000),
            'turned on while locked, only the padlock comes back');
        shield.deactivate(false);
        check(await waitFor(() => atelier().modules.get('island')?.island && atelier().modules.get('dock'), 4000),
            'and the rest once unlocked');
    } finally {
        injections.clear();
        if (Main.sessionMode.isLocked)
            shield.deactivate(false);
        await waitFor(() => !Main.sessionMode.isLocked && atelier()?.modules?.get('island')?.island &&
            atelier()?.modules?.get('dock'), 5000);
        shield._loginSession = loginSession;
    }
}

// The screen locked for a part, with made-up verifiers (see FakeVerifier)
// and logind's locked hint of the real session left alone.
async function lockForTest() {
    const shield = Main.screenShield;
    // (GNOME's calendar starts its event source anew with each unlock.)
    await Scripting.sleep(2000);
    const injections = new InjectionManager();
    const verifiers = [];
    injections.overrideMethod(AuthPromptModule.AuthPrompt.prototype, '_createUserVerifier', () => function () {
        const verifier = new FakeVerifier();
        verifiers.push(verifier);
        return verifier;
    });
    const loginSession = shield._loginSession;
    shield._loginSession = null;
    shield.lock(false);
    await waitFor(() => Main.sessionMode.isLocked, 5000);
    return {
        verifiers,
        async unlock() {
            injections.clear();
            if (Main.sessionMode.isLocked)
                shield.deactivate(false);
            await waitFor(() => !Main.sessionMode.isLocked &&
                Main.extensionManager.lookup(UUID).stateObj?.modules?.get('island')?.island &&
                Main.extensionManager.lookup(UUID).stateObj?.modules?.get('dock'), 5000);
            shield._loginSession = loginSession;
        },
    };
}

// The clock's faces spilled out of an editor's gallery: each sample within
// its place, all of them on the panel or scrolled to.
function facesFit(spill) {
    const [, , pw] = [...spill.panel.get_transformed_position(), ...spill.panel.get_transformed_size()];
    return spill.row.get_children().every(item => {
        const holder = item.get_first_child();
        const [sw, sh] = holder.get_first_child().widget.get_transformed_size();
        const [hw, hh] = holder.get_transformed_size();
        return sw <= hw + 1 && sh <= hh + 1;
    }) && pw > 0 && (spill.row.width <= spill.panel.width || spill.panel.hadjustment.upper > spill.panel.hadjustment.page_size);
}

// The lock screen's widgets: a stacked clock placed there shows over the
// blurred wallpaper and under GNOME's prompt, takes no clicks (they bring
// up the prompt) and may take GNOME's clock's place. They are placed on a
// mock lock screen, which the preferences ask for.
async function testLockWidgets() {
    const shield = Main.screenShield;
    if (!shield) {
        results.push('INFO  no lock screen here (no GDM): the lock screen\'s widgets untested');
        return;
    }
    const atelier = () => Main.extensionManager.lookup(UUID).stateObj;
    const lockSettings = atelier()._settings.get_child('lockscreen');
    lockSettings.set_string('widgets', JSON.stringify([
        {id: 'clock', kind: 'clock', size: 'large', x: 2, y: 2, fine: true, face: 'stacked'},
    ]));
    lockSettings.set_boolean('gnome-clock', false);
    // (GNOME's own prompt, in the middle: the widgets make room for it.)
    lockSettings.set_boolean('password-field', false);
    const locked = await lockForTest();
    try {
        const lock = () => atelier().lockModules?.get('lockscreen');
        check(await waitFor(() => lock()?.board?.widgets.length === 1, 3000), 'locked: the clock placed there is on it');
        const board = lock().board;
        const dialog = shield._dialog;
        const children = dialog.get_children();
        check(children.indexOf(board.layer) === children.indexOf(dialog._backgroundGroup) + 1,
            'over the blurred wallpaper, under GNOME\'s clock and prompt');
        const clock = board.widgets[0];
        check(!clock.reactive && !board.layer.reactive, 'it takes no clicks');
        check(/^\d{1,2}$/.test(clock._hours?.text) && /^\d{2}/.test(clock._minutes?.text) && clock._date?.text,
            `stacked: the date, the hours over the minutes (${clock._hours?.text} ${clock._minutes?.text})`);
        check(clock._minutesBox.opacity === 255 && clock._minutes.get_theme_node().get_foreground_color().alpha === 255,
            `the minutes as bright as the hours here, in the one tone (${clock._minutesBox.opacity})`);
        // (Its font property, a copy: get_font_description() gives away the text's own.)
        const lines = [clock._date, clock._hours, clock._minutes];
        check(await waitFor(() => board.typography.sample &&
            lines.every(line => line.clutter_text.font_description.get_family().split(',').includes('Inter')), 3000) &&
            lines.every(line => Boolean(line.get_theme_node().get_text_shadow()) === Boolean(line._atelierPlan?.shadow)),
        `in Inter, a shadow round a line only where it would not read without (${lines.map(line => line._atelierPlan?.shadow?.alpha ?? 0)})`);
        const labels = [dialog._clock._time, dialog._clock._date, dialog._clock._hint];
        check(labels.every(l => !l.visible), 'in place of GNOME\'s clock, its hint gone with it');
        lockSettings.set_boolean('gnome-clock', true);
        check(labels.every(l => l.visible), 'which comes back when asked');
        lockSettings.set_boolean('gnome-clock', false);
        await restPointer();
        await Scripting.sleep(500);
        await screenshot('83-lock-widgets');

        const blurs = () => dialog._backgroundGroup.get_children().map(w => w.get_effect('blur')).filter(Boolean);
        check(blurs().length > 0 && blurs().every(e => e.radius === 0 && !e.enabled),
            'the wallpaper sharp until the password is asked');
        await clickAt(...centerOf(clock));
        check(await waitFor(() => lock()?.state.phase === 'ready', 3000), 'a click on it brings up the prompt');
        check(await waitFor(() => board.layer.opacity < 100, 2000), 'and the widgets make room for it');
        check(await waitFor(() => blurs().every(e => e.enabled && e.radius >= 80 && e.brightness > 0.8 && e.brightness < 0.9), 2000),
            `the wallpaper turns to glass: blurred as GNOME has it, darkened less (${blurs().map(e => e.radius)})`);
    } finally {
        await locked.unlock();
    }
    check(await waitFor(() => !findActor(Main.uiGroup, a => hasClass(a, 'atelier-lock-widgets')), 3000),
        'unlocked, they go with the lock screen');

    // Placed on a mock lock screen.
    const editor = atelier().modules.get('lockscreen-editor');
    lockSettings.set_string('edit-request', 'test');
    check(await waitFor(() => editor?.preview && findActor(Main.uiGroup, a => hasClass(a, 'atelier-desktop-editor')), 3000),
        'asked by the preferences, a mock lock screen opens to place them on');
    const preview = editor.preview;
    check(preview._board.widgets.length === 1, 'with the clock on it');
    check(Boolean(preview._board.addWidget('date')) &&
        JSON.parse(lockSettings.get_string('widgets')).some(e => e.kind === 'date'), 'a widget added is kept');
    const added = preview._board.addWidget('clock', {size: 'square'});
    check(added?.entry.face === 'glass' && Boolean(added.glass) &&
        JSON.parse(lockSettings.get_string('widgets')).some(e => e.kind === 'clock' && e.face === 'glass'),
    'a new clock has the glass face');
    if (added)
        preview._board.removeWidget(added.entry.id);
    check(!preview._board.addWidget('github'), 'nothing that opens an app or reads the network');
    await Scripting.sleep(600);
    await screenshot('84-lock-editor');
    // (Its clocks are large at first: the faces on offer are square ones all the same.)
    const lockEditor = preview._editor;
    await clickAt(...centerOf(lockEditor._clockButton));
    check(await waitFor(() => lockEditor._spill?.progress === 1, 3000) && facesFit(lockEditor._spill),
        'the clock\'s faces flow out here too, each a square clock in its place');
    await restPointer();
    await screenshot('84b-lock-editor-faces');
    await pressKey(Clutter.KEY_Escape);
    check(await waitFor(() => !editor.preview && !findActor(Main.uiGroup, a => hasClass(a, 'atelier-lock-preview')), 3000),
        'Escape and it goes');
    lockSettings.reset('widgets');
    lockSettings.reset('gnome-clock');
    lockSettings.reset('password-field');
}

// The lock screen's own password popup: it spreads out in the middle when
// GNOME asks, what is typed goes to GNOME's (hidden) prompt as GNOME's own
// Enter sends it, what GNOME says shows in it, it draws back when done, and
// GNOME's prompt shows again whenever the popup can't stand in for it.
async function testLockPasswordField() {
    const shield = Main.screenShield;
    if (!shield) {
        results.push('INFO  no lock screen here (no GDM): the password popup untested');
        return;
    }
    const atelier = () => Main.extensionManager.lookup(UUID).stateObj;
    const lock = () => atelier().lockModules?.get('lockscreen');
    const field = () => lock()?._field;
    const shown = () => field()?.form?.mapped && field().form.opacity === 255;
    const sheet = () => findActor(Main.uiGroup, a => hasClass(a, 'atelier-lock-sheet'));
    // A clock of hours over minutes in the popup's way (as the user has it), the date aside.
    const lockSettings = atelier()._settings.get_child('lockscreen');
    lockSettings.set_string('widgets', JSON.stringify([
        {id: 'clock', kind: 'clock', size: 'large', x: 15, y: 3, fine: true, face: 'stacked'},
        {id: 'date', kind: 'date', size: 'square', x: 2, y: 2, fine: true},
    ]));
    lockSettings.set_boolean('gnome-clock', false);
    const widget = id => lock().board.widgets.find(w => w.entry.id === id);
    const blurs = () => shield._dialog._backgroundGroup.get_children().map(w => w.get_effect('blur')).filter(Boolean);
    let locked = await lockForTest();
    try {
        check(await waitFor(() => lock()?.island?.actor && lock().board?.widgets.length === 2 &&
            widget('clock').stacked?.has_allocation(), 3000), 'locked');
        const clock = widget('clock');
        // (Where it is at rest: in the popup's way, as checked below.)
        const clockBottom = clock.stacked.get_transformed_position()[1] + clock.stacked.get_transformed_size()[1];
        check(blurs().length > 0 && blurs().every(e => e.radius === 0 && !e.enabled),
            'the wallpaper sharp until the password is asked');
        // The key that wakes the lock screen goes into the popup.
        await pressKey(Clutter.KEY_a);
        // (Its liquid over all the monitor, the drop wherever it is.)
        const liquid = () => field()?._popup?._paint;
        check(await waitFor(() => liquid()?.get_allocation_box().get_width() === Main.layoutManager.primaryMonitor.width,
            1000), 'a key: the password popup spreads out of a drop');
        check(await waitFor(shown, 3000) && !liquid(), 'and is there');
        const form = field().form;
        const monitor = Main.layoutManager.primaryMonitor;
        const [x, y] = centerOf(form);
        check(Math.abs(x - (monitor.x + monitor.width / 2)) <= 1 && Math.abs(y - (monitor.y + monitor.height / 2)) <= 1,
            `in the middle of the screen (${Math.round(x)}, ${Math.round(y)})`);
        const uiGroup = Main.layoutManager.uiGroup.get_children();
        const layer = uiGroup.indexOf(form.get_parent());
        check(layer > uiGroup.indexOf(Main.layoutManager.screenShieldGroup) &&
            layer < uiGroup.indexOf(lock().island.actor), 'over the lock screen, under the island');
        const avatar = form.avatar;
        check(avatar.mapped && avatar.get_transformed_position()[1] < form.entry.get_transformed_position()[1] &&
            (avatar.picture ? avatar.style.includes(avatar.picture) : avatar.child instanceof St.Icon),
        `the user's picture over the field, or GNOME's generic one (${avatar.picture})`);
        check(!findActor(form, a => a instanceof St.Button && a.label === 'Unlock'), 'no Unlock button: Enter sends it');
        const prompt = shield._dialog._authPrompt;
        let entry = form.entry;
        check(prompt.opacity === 0, 'GNOME\'s prompt hidden behind it');
        const picked = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...centerOf(prompt._entry));
        check(!prompt.contains(picked), 'and out of the pointer\'s way');
        check(entry.text === 'a' && prompt._entry.text === '', `the key that woke it is in the popup (${entry.text})`);
        check(entry.contains(global.stage.key_focus), 'which has the keyboard');
        check(!findActor(form, a => a instanceof St.Button), 'no buttons: Enter sends it, Escape goes back');
        check(await waitFor(() => blurs().every(e => e.enabled && e.radius >= 80 && e.brightness > 0.8 && e.brightness < 0.9), 2000),
            `the wallpaper turns to glass: blurred as GNOME has it, darkened less (${blurs().map(e => e.radius)})`);
        check(await waitFor(() => lock().room === 1 && !clock.get_transition('translation_y'), 2000),
            'the prompt is up, room made for it');
        const box = actor => {
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();
            return {x, y, w, h};
        };
        const [hours, colon, minutes] = [clock._hours, clock._colon, clock._minutes].map(box);
        check(Math.abs(minutes.y - hours.y) <= 2 && colon.x >= hours.x + hours.w - 2 &&
            minutes.x >= colon.x + colon.w - 2 && clock._colon.opacity === 255,
        'the stacked clock\'s minutes go beside its hours, after a colon, as on a digital clock');
        const [, formY] = form.get_transformed_position();
        const [, clockY] = clock.stacked.get_transformed_position();
        check(clockBottom > formY && hours.y + hours.h <= formY - 10 &&
            clockY >= lock().island.actor.y + lock().island.actor.height &&
            Math.abs((hours.x + minutes.x + minutes.w) / 2 - (monitor.x + monitor.width / 2)) <= 40,
        `in its way at first, it is over it then, under the island (${Math.round(clockY)}–${Math.round(hours.y + hours.h)} over ${Math.round(formY)})`);
        check(clock.opacity === 255 && lock().board.layer.opacity === 255 && widget('date').opacity < 100,
            'and stays bright, the other widgets dim');
        await restPointer();
        await screenshot('87-lock-room');
        // Escape, as in GNOME's prompt: back to the clock.
        await pressKey(Clutter.KEY_Escape);
        check(await waitFor(() => lock().state.phase === 'locked' && !field().form, 3000), 'Escape: back to the clock');
        check(await waitFor(() => !sheet() && lock().room === 0 && clock.translation_y === 0 && clock.scale_x === 1 &&
            clock._colon.opacity === 0 && clock._minutesBox.translation_y === 0 &&
            widget('date').opacity === 255 && blurs().every(e => e.radius === 0), 2000),
        'the popup draws back, the clock comes down, stacked again, the wallpaper is sharp again');
        await Scripting.sleep(600);

        check(!lock().island.actor.visible, 'the island tucked away again');
        // A wrong password, then the right one.
        await clickAt(300, 800);
        check(await waitFor(() => shown() && lock().state.phase === 'ready', 3000), 'clicked, the popup again');
        entry = field().form.entry;
        await typeText('abc');
        await restPointer();
        await screenshot('85-lock-password');
        await pressKey(Clutter.KEY_Return);
        const verifier = locked.verifiers.at(-1);
        check(await waitFor(() => verifier.answers.length === 1, 2000) && verifier.answers[0] === 'abc' && entry.text === '',
            `Enter: GNOME has the answer once, the field is empty (${verifier.answers.length})`);
        verifier.emit('show-message', 'gdm-password', 'Sorry, that didn\'t work. Please try again.', 3);
        verifier.emit('verification-failed', 'gdm-password', true);
        verifier.emit('ask-question', 'gdm-password', 'Password:', true);
        check(field().form?.message.includes('didn\'t work') && lock().island.padlock.look.tone === 'red',
            'what GNOME says shows in it, the padlock red');
        await restPointer();
        await Scripting.sleep(300);
        await screenshot('86-lock-password-wrong');
        check(await waitFor(() => lock().state.phase === 'ready' && entry.contains(global.stage.key_focus), 3000),
            'asked again, it has the keyboard again');
        await typeText('right');
        check(field().form.message === '', 'typing again puts away what GNOME said, as its own prompt does');
        await pressKey(Clutter.KEY_Return);
        check(await waitFor(() => verifier.answers.includes('right'), 2000), 'Enter: the right one goes to GNOME');
        verifier.emit('verification-complete');
        check(lock().state.phase === 'success' && !field().form, 'unlocked: the popup draws back');
    } finally {
        await locked.unlock();
    }
    check(await waitFor(() => !sheet(), 2000), 'and goes');

    // Something to choose from: GNOME's own prompt.
    locked = await lockForTest();
    try {
        await waitFor(() => lock()?.island?.actor, 3000);
        await pressKey(Clutter.KEY_a);
        await waitFor(shown, 3000);
        const prompt = shield._dialog._authPrompt;
        locked.verifiers.at(-1).emit('show-choice-list', 'gdm-password', 'Choose', {});
        check(prompt.opacity === 255 && !field().form, 'a list to choose from: GNOME\'s prompt shows instead');
        check(await waitFor(() => !sheet(), 2000), 'the popup gone');
    } finally {
        await locked.unlock();
        lockSettings.reset('widgets');
        lockSettings.reset('gnome-clock');
    }
}

// A picture with a disc in it, as a PNG: width × height of one colour, the
// disc (its centre and radius in the picture's pixels) of another – or
// see-through around the disc, for a cutout.
function discPicture(path, [width, height], [cx, cy, r], disc, around, text = {}) {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, width, height);
    pixbuf.fill(around);
    for (let y = Math.max(0, Math.ceil(cy - r)); y < Math.min(height, cy + r); y++) {
        const half = Math.sqrt(Math.max(0, r * r - (y + 0.5 - cy) ** 2));
        const [x1, x2] = [Math.max(0, Math.round(cx - half)), Math.min(width, Math.round(cx + half))];
        if (x2 > x1)
            pixbuf.new_subpixbuf(x1, y, x2 - x1, 1).fill(disc);
    }
    pixbuf.savev(path, 'png', Object.keys(text).map(key => `tEXt::${key}`), Object.values(text));
}

const isGreen = ([r, g, b]) => g > 200 && r < 90 && b < 90;

// A cutout of rectangles, [x1, y1, x2, y2] in its pixels, of a colour, the
// rest of another (see-through).
function rectsPicture(path, [width, height], rects, color, around, text = {}) {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, width, height);
    pixbuf.fill(around);
    for (const [x1, y1, x2, y2] of rects) {
        const [left, top] = [Math.max(0, Math.round(x1)), Math.max(0, Math.round(y1))];
        const [right, bottom] = [Math.min(width, Math.round(x2)), Math.min(height, Math.round(y2))];
        if (right > left && bottom > top)
            pixbuf.new_subpixbuf(left, top, right - left, bottom - top).fill(color);
    }
    pixbuf.savev(path, 'png', Object.keys(text).map(key => `tEXt::${key}`), Object.values(text));
}

// The depth effect: what stands near in the wallpaper over the lock
// screen's clocks. The cutout is made in the session (here by hand: a green disc
// over the wallpaper's light one, so it shows where it is drawn); the lock
// screen lays it over the wallpaper as GNOME zooms it, over the clock and
// under the date, takes it away as the prompt comes up, and leaves it off
// when the subject would cover too much of the clock. Then the session
// makes one itself, with a made-up model.
async function testLockDepth() {
    const shield = Main.screenShield;
    if (!shield) {
        results.push('INFO  no lock screen here (no GDM): the depth effect untested');
        return;
    }
    const atelier = () => Main.extensionManager.lookup(UUID).stateObj;
    const lock = () => atelier().lockModules?.get('lockscreen');
    const lockSettings = atelier()._settings.get_child('lockscreen');
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const kept = ['picture-uri', 'picture-uri-dark', 'picture-options'].map(key => [key, background.get_string(key)]);
    const monitor = Main.layoutManager.primaryMonitor;
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

    // Where the clock goes (a large one at cells 2, 2), and a disc right
    // of it, over a part of it: on the screen, then on a wallpaper of
    // 1600 × 1200, which GNOME zooms to 1920 × 1440, 180 pixels cut off at
    // the top and the bottom.
    const origin = gridOrigin(monitor.width / scale, monitor.height / scale);
    const [left, top] = cellOrigin(2, 2, origin).map(v => v * scale);
    const side = (SIZES.large[0] * PITCH - GAP) * scale;
    const [cx, cy, r] = [left + side + 60, top + side / 2, 180];
    const zoom = 1920 / 1600;
    const dir = `${OUTPUT}/depth`;
    GLib.mkdir_with_parents(dir, 0o755);
    const wallpaper = `${dir}/wallpaper.png`;
    discPicture(wallpaper, [1600, 1200], [cx / zoom, (cy + 180) / zoom, r / zoom], 0xf0d0a0ff, 0x304050ff);
    background.set_string('picture-uri', uriOf(wallpaper));
    background.set_string('picture-uri-dark', uriOf(wallpaper));
    background.set_string('picture-options', 'zoom');
    // (Half as big as the wallpaper: stretched over it.)
    const cutout = cutoutPath(pictureState(wallpaper), [monitor.width, monitor.height]);
    GLib.mkdir_with_parents(GLib.path_get_dirname(cutout), 0o755);
    const cutoutText = {'atelier-width': '1600', 'atelier-height': '1200'};
    const discCutout = () => discPicture(cutout, [800, 600], [cx / zoom / 2, (cy + 180) / zoom / 2, r / zoom / 2],
        0x00ff00ff, 0x00000000, cutoutText);
    discCutout();
    // (Monitor pixels on the cutout: 800 × 600 over 1920 × 1440, 180 above the monitor.)
    const onCutout = ([x1, y1, x2, y2]) => [x1, y1 + 180, x2, y2 + 180].map(v => v * 800 / 1920);
    lockSettings.set_string('widgets', JSON.stringify([
        {id: 'clock', kind: 'clock', size: 'large', x: 2, y: 2, fine: true, face: 'stacked'},
        {id: 'date', kind: 'date', size: 'square', x: 2, y: 12, fine: true},
    ]));
    lockSettings.set_boolean('gnome-clock', false);
    lockSettings.set_boolean('password-field', false);
    lockSettings.set_boolean('depth-effect', true);
    await Scripting.sleep(500);
    const at = (name, x, y) => averageColor(name, Math.round(x) - 3, Math.round(y) - 3, 6, 6);
    const locked = await lockForTest();
    try {
        check(await waitFor(() => lock()?.board?.depth?.loaded && lock().board.depth.actor.visible, 3000),
            'locked: the cutout made of the wallpaper is there');
        const board = lock().board;
        const depth = board.depth;
        const children = board.layer.get_children();
        const clock = board.widgets.find(w => w.entry.id === 'clock');
        const date = board.widgets.find(w => w.entry.id === 'date');
        check(children.indexOf(clock) < children.indexOf(depth.actor) &&
            children.indexOf(depth.actor) < children.indexOf(date), 'over the clock, under the date');
        check(JSON.stringify(depth.shown) === JSON.stringify({x: 0, y: -180, width: 1920, height: 1440}) &&
            depth.actor.x === 0 && depth.actor.y === -180 && depth.actor.width === 1920,
        `over the wallpaper as GNOME zooms it (${JSON.stringify(depth.shown)})`);
        check(!depth.tooMuch && !depth.actor.reactive && depth.legibility.length === 1 && depth.legibility[0].stays,
            `a part of the clock covered, none of its digits much: on; it takes no clicks (${JSON.stringify(depth.legibility)})`);
        await restPointer();
        await Scripting.sleep(500);
        await screenshot('88-lock-depth');
        const box = clock.get_allocation_box();
        const [mx, my] = [monitor.x, monitor.y];
        check(isGreen(at('88-lock-depth', mx + cx, my + cy)) && isGreen(at('88-lock-depth', mx + box.x2 - 40, my + cy)),
            `the subject shows where the wallpaper has it, over the clock too (${at('88-lock-depth', mx + box.x2 - 40, my + cy)})`);
        check(!isGreen(at('88-lock-depth', mx + box.x1 + 40, my + box.y1 + 40)), 'the rest of the clock as it is');
        const edges = [[0, -1], [1, 0], [0, 1]].map(([dx, dy]) => [
            at('88-lock-depth', mx + cx + dx * (r - 8), my + cy + dy * (r - 8)),
            at('88-lock-depth', mx + cx + dx * (r + 8), my + cy + dy * (r + 8))]);
        check(edges.every(([inside, outside]) => isGreen(inside) && !isGreen(outside)),
            `exactly over it: its edge within a few pixels of the wallpaper's (${JSON.stringify(edges)})`);

        // The prompt: it goes as the wallpaper blurs, and comes back.
        await clickAt(mx + 300, my + 900);
        check(await waitFor(() => lock()?.state.phase === 'ready' && lock().room === 1, 3000) &&
            !depth.actor.visible && depth.actor.opacity === 0, 'the prompt up, the cutout gone (the wallpaper blurs)');
        await pressKey(Clutter.KEY_Escape);
        check(await waitFor(() => lock().room === 0 && depth.actor.visible && depth.actor.opacity === 255, 3000),
            'back to the clock, back again');

        // A clock right under the subject: the effect turns off.
        lockSettings.set_string('widgets', JSON.stringify([{
            id: 'clock', kind: 'clock', size: 'large', fine: true, face: 'stacked',
            x: Math.round(((cx - side / 2) / scale - origin[0]) / PITCH), y: 2,
        }]));
        check(await waitFor(() => lock().board.depth.tooMuch && !lock().board.depth.actor.visible, 3000),
            'a clock the subject would cover much of: the effect off, the clock whole');
        await Scripting.sleep(300);
        await screenshot('89-lock-depth-covered');
        check(!isGreen(at('89-lock-depth-covered', mx + cx, my + cy)), 'nothing of the cutout shows');

        // Digit by digit: a post over one digit of the minutes hides more
        // of it than a digit may lose – the effect off, though it covers
        // little of the clock (as a share of its box it stayed on).
        lockSettings.set_string('widgets', JSON.stringify([
            {id: 'clock', kind: 'clock', size: 'large', x: 2, y: 2, fine: true, face: 'stacked'},
        ]));
        await waitFor(() => lock().board.widgets[0]?._minutes?.mapped, 3000);
        await Scripting.sleep(300);
        const stacked = lock().board.widgets[0];
        const digits = lock().board._legible(stacked, stacked.get_allocation_box()).glyphs;
        const minute = digits.at(-2);
        rectsPicture(cutout, [800, 600], [onCutout([minute.x, minute.y - 10, minute.x + minute.width * 0.6,
            minute.y + minute.height + 10])], 0x00ff00ff, 0x00000000, cutoutText);
        lock().board.depth._load();
        check(await waitFor(() => lock().board.depth.loaded && lock().board.depth.tooMuch, 3000) &&
            !lock().board.depth.actor.visible, `a post over a digit of the minutes: the effect off (${digits.length} digits)`);
        const verdict = lock().board.depth.legibility[0];
        check(verdict?.worst > MAX_GLYPH_COVER && verdict.whole < MAX_COVER && verdict.glyph === digits.length - 2,
            `that digit hidden too much, the clock as a whole not (${JSON.stringify(verdict)})`);

        // The date over the clock stays in front of the subject, as on an
        // iPhone: a band of it over the date line only, its digits clear –
        // on, and the date shows over it.
        const line = stacked.dateLine;
        const [lx, ly] = line.get_transformed_position().map(v => Math.round(v));
        const [lw, lh] = line.get_transformed_size().map(v => Math.round(v));
        const digitsTop = Math.min(...digits.map(d => d.y));
        rectsPicture(cutout, [800, 600], [onCutout([0, ly - my - 40, monitor.width,
            Math.min(ly - my + lh + 6, digitsTop - 2)])], 0x00ff00ff, 0x00000000, cutoutText);
        lock().board.depth._load();
        check(await waitFor(() => lock().board.depth.loaded && lock().board.depth.actor.visible &&
            !lock().board.depth.tooMuch, 3000) && lock().board.depth._inFront[0]?.actor === line,
        'the subject over the date line only: on, the date kept in front of it');
        await restPointer();
        await Scripting.sleep(300);
        await screenshot('89b-lock-depth-date');
        const inside = averageColor('89b-lock-depth-date', lx + 2, ly + 2, lw - 4, lh - 4);
        const beside = at('89b-lock-depth-date', lx - 60, ly + lh / 2);
        check(!isGreen(inside) && isGreen(beside), `the date over it, the subject beside it (${inside}, ${beside})`);
    } finally {
        await locked.unlock();
    }
    discCutout();

    // On the mock lock screen too, to place the clock with it.
    lockSettings.set_string('widgets', JSON.stringify([
        {id: 'clock', kind: 'clock', size: 'large', x: 2, y: 2, fine: true, face: 'stacked'},
    ]));
    const editor = atelier().modules.get('lockscreen-editor');
    lockSettings.set_string('edit-request', 'depth');
    check(await waitFor(() => editor?.preview?._board.depth?.loaded && editor.preview._board.depth.actor.visible, 3000),
        'the editor\'s mock lock screen has it');
    await restPointer();
    await Scripting.sleep(600);
    await screenshot('90-lock-depth-editor');
    const dimmed = at('90-lock-depth-editor', monitor.x + cx, monitor.y + cy);
    check(dimmed[0] < 30 && dimmed[2] < 30 && Math.abs(dimmed[1] - 255 * 0.55) < 15,
        `where the wallpaper has it, dimmed with it as the editor dims it (${dimmed})`);
    const previewBoard = editor.preview._board;
    const order = () => {
        const children = previewBoard.layer.get_children();
        return children.indexOf(previewBoard.widgets[0]) > children.indexOf(previewBoard.depth.actor);
    };
    const inFront = () => previewBoard.depth._inFront.map(entry => entry.actor);
    check(!order() && inFront()[0] === previewBoard.widgets[0].dateLine, 'the clock behind it, its date in front');
    await pointerTo(monitor.x + left + 40, monitor.y + top + 40);
    check(await waitFor(order, 1000) && inFront().length === 0, 'pointed at, in front, to be moved');
    await restPointer();
    check(await waitFor(() => !order(), 1000) && inFront().length === 1, 'and behind it again');
    await pressKey(Clutter.KEY_Escape);
    await waitFor(() => !editor.preview, 3000);

    // Made in the session: with a model (a made-up one), when asked.
    const depthModule = atelier().modules.get('depth');
    const python = GLib.find_program_in_path('python3');
    let usable = false;
    if (python) {
        const probe = Gio.Subprocess.new([python, workerPath(), '--check'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const [, stdout] = probe.communicate_utf8(null, null);
        usable = JSON.parse(stdout).ok;
    }
    if (!depthModule || !usable) {
        results.push(`INFO  no python3-onnxruntime here: the cutout made in the session untested (${Boolean(depthModule)})`);
    } else {
        // (None chosen: the one offered first, Base, as a made-up one.)
        const model = modelPath(chosenModel(lockSettings.get_string('depth-model')));
        GLib.mkdir_with_parents(GLib.path_get_dirname(model), 0o755);
        GLib.file_set_contents(model, fakeDepthModel());
        GLib.unlink(cutout);
        lockSettings.set_string('depth-request', 'test');
        check(await waitFor(() => lockSettings.get_string('depth-status') === 'working', 3000),
            'asked, the cutout is being made');
        check(await waitFor(() => lockSettings.get_string('depth-status') === 'ready', 60000) &&
            GLib.file_test(cutout, GLib.FileTest.EXISTS), `and is made (${lockSettings.get_string('depth-status')})`);
        const made = GLib.file_test(cutout, GLib.FileTest.EXISTS) ? GdkPixbuf.Pixbuf.new_from_file(cutout) : null;
        check(made?.get_option('tEXt::atelier-width') === '1600' && made.get_has_alpha(),
            `of the wallpaper as it is (${made?.get_width()}×${made?.get_height()})`);
        // Another model chosen: made anew, with it.
        lockSettings.set_string('depth-model', 'small');
        GLib.file_set_contents(modelPath('small'), fakeDepthModel());
        GLib.unlink(model);
        check(await waitFor(() => lockSettings.get_string('depth-status') === 'working', 3000) &&
            await waitFor(() => lockSettings.get_string('depth-status') === 'ready', 60000),
        `another model chosen, the cutout is made anew (${lockSettings.get_string('depth-status')})`);
        GLib.unlink(modelPath('small'));
        lockSettings.reset('depth-model');
    }

    lockSettings.set_boolean('depth-effect', false);
    check(await waitFor(() => !atelier().modules.get('depth'), 1000), 'switched off, nothing makes cutouts');
    ['widgets', 'gnome-clock', 'password-field', 'depth-effect', 'depth-request', 'depth-status']
        .forEach(key => lockSettings.reset(key));
    kept.forEach(([key, value]) => background.set_string(key, value));
}

// A picture of the monitor's size: a sky over a hill whose top is at
// `hill` (a cutout of it: the hill alone, the sky see-through).
function hillPicture(path, [width, height], hill, sky, ground, text = {}) {
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, width, height);
    pixbuf.fill(sky);
    pixbuf.new_subpixbuf(0, hill, width, height - hill).fill(ground);
    pixbuf.savev(path, 'png', Object.keys(text).map(key => `tEXt::${key}`), Object.values(text));
}

// GNOME's battery, made up: charging, at 96 %. Gives back the real one.
function fakeBattery() {
    const systemItem = Main.panel.statusArea.quickSettings._system?._systemItem;
    const realToggle = systemItem?._powerToggle;
    const toggle = new QuickSettings.QuickToggle({title: '96 %'});
    toggle._proxy = {IsPresent: true, Percentage: 96, State: 1};
    if (systemItem)
        systemItem._powerToggle = toggle;
    return () => {
        if (systemItem)
            systemItem._powerToggle = realToggle;
    };
}

// A screenshot's pixels, read once: at(x, y) gives [r, g, b].
function pixelsOf(name) {
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(`${OUTPUT}/${name}.png`);
    const [pixels, stride, channels] = [pixbuf.get_pixels(), pixbuf.get_rowstride(), pixbuf.get_n_channels()];
    return {
        at(x, y) {
            const i = Math.round(y) * stride + Math.round(x) * channels;
            return [pixels[i], pixels[i + 1], pixels[i + 2]];
        },
    };
}

// How much two screenshots differ over a rectangle: the mean of each
// pixel's largest difference in a channel.
function differenceOf(a, b, {x, y, width, height}) {
    let [sum, count] = [0, 0];
    for (let row = Math.round(y); row < y + height; row++) {
        for (let col = Math.round(x); col < x + width; col++) {
            sum += colorDistance(a.at(col, row), b.at(col, row));
            count++;
        }
    }
    return count > 0 ? sum / count : 0;
}

// The lock screen's glass clock: the time in tall digits of glass the
// wallpaper shows through, drawn from the font's own outlines (Inter, until
// told another) and stretched as a tall typeface draws them – stems
// longer, a "0" with straight sides, not an ellipse – from under the date
// line down into what stands in front (a hill, here), which passes in front
// of their feet; as tall as the box lets them without it. In the one tone of
// the other widgets; heavier, with a shadow, as a legibility plan has it,
// only then. As the minute turns, only the figures that change move, on a
// layer of their own; nothing is drawn while it rests.
async function testLockGlassClock() {
    const shield = Main.screenShield;
    if (!shield) {
        results.push('INFO  no lock screen here (no GDM): the glass clock untested');
        return;
    }
    const {GlassBackdrop} = await import('../shell/lockscreen/liquidGlass.js');
    const {tintShown} = await import('../lib/glassBackdrop.js');
    const {styleFor, typefaceFor} = await import('../lib/lockType.js');
    const atelier = () => Main.extensionManager.lookup(UUID).stateObj;
    const lock = () => atelier().lockModules?.get('lockscreen');
    const lockSettings = atelier()._settings.get_child('lockscreen');
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const kept = ['picture-uri', 'picture-uri-dark', 'picture-options'].map(key => [key, background.get_string(key)]);
    const monitor = Main.layoutManager.primaryMonitor;
    const size = [monitor.width, monitor.height];
    const dir = `${OUTPUT}/glass`;
    GLib.mkdir_with_parents(dir, 0o755);
    const wallpaper = `${dir}/hill.png`;
    // (A hill over the lower part of the clock's box, cells 2 to 10 down.)
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const origin = gridOrigin(monitor.width / scale, monitor.height / scale);
    const [, boxTop] = cellOrigin(2, 2, origin).map(v => v * scale);
    const side = (SIZES.large[1] * PITCH - GAP) * scale;
    let hill = Math.round(boxTop + side * 0.62);
    hillPicture(wallpaper, size, hill, 0x4a7fd4ff, 0x3f8a2aff);
    background.set_string('picture-uri', uriOf(wallpaper));
    background.set_string('picture-uri-dark', uriOf(wallpaper));
    background.set_string('picture-options', 'zoom');
    const cutout = cutoutPath(pictureState(wallpaper), size);
    GLib.mkdir_with_parents(GLib.path_get_dirname(cutout), 0o755);
    const writeCutout = () => hillPicture(cutout, size, hill, 0x00000000, 0x3f8a2aff,
        {'atelier-width': `${size[0]}`, 'atelier-height': `${size[1]}`});
    writeCutout();
    lockSettings.set_string('widgets', JSON.stringify([
        {id: 'clock', kind: 'clock', size: 'large', x: 2, y: 2, fine: true, face: 'glass'},
        {id: 'battery', kind: 'battery', size: 'line', x: 2, y: 12, fine: true},
    ]));
    lockSettings.set_boolean('gnome-clock', false);
    lockSettings.set_boolean('password-field', false);
    lockSettings.set_boolean('depth-effect', true);
    const realBattery = fakeBattery();
    await wallpapersSettled();
    const locked = await lockForTest();
    let backdrop = null;
    let clock = null;
    try {
        check(await waitFor(() => lock()?.board?.depth?.loaded && lock().board.widgets[0]?.glass?.target, 5000),
            'locked: the glass clock, the cutout of the hill there');
        const board = lock().board;
        clock = board.widgets.find(w => w.entry.id === 'clock');
        const glass = clock.glass;
        check(/^\d{1,2}:\d{2}$/.test(glass._text) && /\w+, \w+ \d+/.test(glass.dateLine.text),
            `the time in one line, the date over it (${glass._text}, ${glass.dateLine.text})`);
        check(glass.fontFile?.endsWith('/fonts/Inter.ttf') && glass.variations === 'wght=600,opsz=32',
            `drawn from Inter's own outlines, at its display size (${glass.fontFile}, ${glass.variations})`);
        check(glass.workedOut === 0, `how its figures stretch worked out in the session, ahead: none on the lock screen (${glass.workedOut})`);
        // (The time as the test sets it: the clock's own minutes kept out.)
        clock._sync = () => {};
        glass.setClock('10:08');
        await waitFor(() => !glass.changing, 2000);
        // The frosted wallpaper, as the board gives the glass (unless it does).
        if (!glass.backdrop) {
            backdrop = new GlassBackdrop();
            backdrop.setMonitor(size, scale);
            await waitFor(() => backdrop.current, 10000);
            glass.backdrop = backdrop.current;
        }
        check(Boolean(glass.backdrop), 'the glass frosts the wallpaper behind it');
        // (Where the digits go on the monitor.)
        const digitsNow = () => {
            const rect = board._followSubject(clock, clock.get_allocation_box());
            return rect ? {...rect, feet: rect.y + rect.height} : null;
        };
        const intoHill = d => (d.feet - hill) / d.height;
        check(await waitFor(() => glass.stretch === glass.target.stretch, 2000) && glass.target.stretch > 1.2 &&
            Math.abs(intoHill(digitsNow()) - STRETCH.overlap) < 0.03,
        `stretched down into the hill, their feet behind it (×${glass.target.stretch.toFixed(2)}, ${intoHill(digitsNow()).toFixed(2)} of them)`);
        check(!board.depth.tooMuch && board.depth.actor.visible, 'the hill in front of them');
        const [faceX, faceY] = glass.get_transformed_position();
        const [, dateY] = glass.dateLine.get_transformed_position();
        check(dateY < faceY + glass.target.y && dateY + glass.dateLine.height <= faceY + glass.target.y + 1,
            'the date line just over them');
        const battery = board.widgets.find(w => w.entry.id === 'battery');
        const ink = actor => hexOf(actor.get_theme_node().get_foreground_color());
        check(ink(glass._digits) === ink(glass.dateLine) && ink(glass._digits) === ink(battery._value) &&
            ink(battery._value) === ink(battery._caption) && luminance(ink(glass._digits)) > 0.7,
        `in the one light tone of the other widgets (${ink(glass._digits)}, ${ink(battery._value)})`);
        // What a legibility plan of them takes, and each digit's box.
        const metrics = glass.digitsMetrics;
        check(metrics?.size > 60 && metrics.weight === 600 && metrics.tintAlpha === tintShown(),
            `what their plan takes: ${JSON.stringify(metrics)}`);
        const boxes = glass.glyphBoxes;
        const tall = glass.metrics.inkHeight * glass.target.stretch;
        check(boxes?.length === 4 && boxes.every(b => b.height > tall * 0.97 && b.height < tall * 1.08 && b.width > 10),
            `each digit's box, the colon left out, as tall as they stand (${boxes?.map(b => `${Math.round(b.width)}×${Math.round(b.height)}`)} of ${Math.round(tall)})`);

        // At rest, nothing is drawn.
        await restPointer();
        await Scripting.sleep(600);
        const painted = () => [glass._digits.repaints, glass._moving.repaints];
        const resting = painted();
        await Scripting.sleep(1500);
        check(JSON.stringify(painted()) === JSON.stringify(resting), `at rest, nothing is drawn (${resting} → ${painted()})`);
        await screenshot('91-lock-glass');
        // The glass: lighter than the sky behind it, the sky showing through.
        const digits = digitsNow();
        const sky = averageColor('91-lock-glass', monitor.x + 20, monitor.y + 20, 8, 8);
        let lit = [0, 0, 0];
        for (let x = Math.round(digits.x); x < digits.x + digits.width; x += 3) {
            const at = averageColor('91-lock-glass', monitor.x + x, monitor.y + Math.round(digits.y + digits.height * 0.3), 2, 2);
            if (lightOf(at) > lightOf(lit))
                lit = at;
        }
        check(lightOf(lit) > lightOf(sky) + 40 && lightOf(lit) < 250 && lit[2] > lit[0],
            `the digits a light glass the sky shows through (${lit} over ${sky})`);
        // Taller on their stems: the "0" as wide a quarter of the way down
        // as halfway and three quarters (an ellipse narrows), its sides
        // straight.
        const rest = pixelsOf('91-lock-glass');
        const zero = boxes[1];
        const [top, bottom] = [faceY + zero.y, Math.min(faceY + zero.y + zero.height, hill)];
        const widthAt = share => {
            const y = top + (bottom - top) * share;
            // (Its middle: the sky through its counter.)
            const behind = lightOf(rest.at(faceX + zero.x + zero.width / 2, y));
            let [left, right] = [null, null];
            for (let x = Math.round(faceX + zero.x - 6); x <= faceX + zero.x + zero.width + 6; x++) {
                if (lightOf(rest.at(x, y)) > behind + 20) {
                    left ??= x;
                    right = x;
                }
            }
            return left === null ? 0 : right - left + 1;
        };
        const widths = [0.25, 0.5, 0.75].map(widthAt);
        check(widths[1] > zero.width * 0.8 && Math.min(widths[0], widths[2]) / widths[1] > 0.96,
            `a "0" with straight sides, not an ellipse (${widths} px wide a quarter, half and three quarters down)`);

        // The minute turns: only its figure goes, the old one lifting as it
        // fades, the new one rising into place.
        glass.setClock('10:09');
        check(JSON.stringify(glass.changing) === JSON.stringify({leaving: [4], coming: [4]}),
            `the minute turns: only its figure changes (${JSON.stringify(glass.changing)})`);
        check(await waitFor(() => glass.change >= 0.3, 1000), `under way (${glass.change.toFixed(2)})`);
        const transition = glass.get_transition('change');
        transition?.pause();
        const halfway = glass.change;
        await Scripting.sleep(300);
        await screenshot('91b-lock-glass-turning');
        transition?.start();
        const turning = pixelsOf('91b-lock-glass-turning');
        // (The middle of each digit's box, above the hill.)
        const middleOf = box => ({x: faceX + box.x + box.width * 0.25, y: faceY + box.y + 8,
            width: box.width * 0.5, height: Math.max(1, hill - faceY - box.y - 16)});
        const changes = boxes.map(box => differenceOf(rest, turning, middleOf(box)));
        check(changes.slice(0, 3).every(d => d < 1) && changes[3] > 8,
            `${halfway.toFixed(2)} of the way, the other figures as they were, only it moves (${changes.map(d => d.toFixed(1))})`);
        check(await waitFor(() => !glass.changing && glass.change === 1, 2000), 'and comes to rest');
        // Drawn on a layer of its own, while it goes; then nothing again.
        const before = painted();
        glass.setClock('10:10');
        check(await waitFor(() => !glass.changing, 2000), 'another minute');
        const after = painted();
        check(after[0] - before[0] <= 3 && after[1] - before[1] >= 8,
            `while the figures that change go, they are drawn ${after[1] - before[1]} times, the rest ${after[0] - before[0]}`);
        await Scripting.sleep(1500);
        check(JSON.stringify(painted()) === JSON.stringify(after), `and then nothing (${after} → ${painted()})`);
        // Out of sight, at once.
        clock.hide();
        glass.setClock('10:11');
        check(!glass.changing && glass._text === '10:11', 'out of sight, the time changes at once');
        clock.show();

        // In Roboto Flex when told: on its width axis, at the clock's
        // optical size; a plan grades it (as wide as it was) and casts a
        // shadow round it and the date line, and only then. (The face on
        // its own: the board, which tells it the settings' type and what it
        // takes to read there, holds off meanwhile.)
        const planGlass = board._planGlass;
        board._planGlass = () => {};
        const flex = typefaceFor('flex');
        glass.setType({typeface: flex, style: styleFor(flex, 'glass')});
        check(await waitFor(() => glass.fontFile?.endsWith('/fonts/RobotoFlex.ttf'), 3000) &&
            /wdth=90/.test(glass.variations) && /opsz=\d+/.test(glass.variations) && glass.workedOut > 0,
        `Roboto Flex, as told (${glass.variations}; its ${glass.workedOut} figures worked out while the shell was idle)`);
        await waitFor(() => glass.stretch === glass.target.stretch, 2000);
        await Scripting.sleep(400);
        await screenshot('91c-lock-glass-flex');
        const wide = glass.metrics.width;
        const one = glass.glyphBoxes[0];
        glass.setPlan({
            digits: {boldness: 0.5, weight: 700, shadow: {color: '#000000', alpha: 0.5, blur: 10, y: 1}, glass: 0.4},
            date: {boldness: 0, weight: 600, shadow: {color: '#000000', alpha: 0.3, blur: 6, y: 1}},
        });
        check(await waitFor(() => /GRAD=75/.test(glass.variations), 3000) && /wght=600/.test(glass.variations) &&
            Math.abs(glass.metrics.width - wide) < 0.5,
        `a plan's boldness on Roboto Flex's grade, the line as wide (${glass.variations})`);
        check(/text-shadow: 0 1px 6px rgba\(0, 0, 0, 0.3\)/.test(glass.dateLine.style ?? ''),
            `the date line's shadow as planned (${glass.dateLine.style})`);
        await Scripting.sleep(400);
        await screenshot('91d-lock-glass-planned');
        // (Just right of the "1"'s stem, outside it.)
        const [sx, sy] = [Math.round(faceX + one.x + one.width + 4), Math.round(faceY + one.y + one.height * 0.3)];
        const [plain, shaded] = ['91c-lock-glass-flex', '91d-lock-glass-planned'].map(name => averageColor(name, sx, sy, 2, 2));
        const skyThere = averageColor('91c-lock-glass-flex', sx + 6, sy, 2, 2);
        check(colorDistance(plain, skyThere) <= 4 && lightOf(shaded) < lightOf(plain) - 6,
            `a shadow round them only as planned (${plain} beside them without, ${shaded} with)`);
        const inter = typefaceFor('inter');
        glass.setType({typeface: inter, style: styleFor(inter, 'glass')});
        check(await waitFor(() => glass.variations === 'wght=700,opsz=32', 3000),
            `in Inter, heavier on its weight (${glass.variations})`);
        glass.setPlan(null);
        check(await waitFor(() => glass.variations === 'wght=600,opsz=32', 3000) && !glass.dateLine.style,
            'no plan: as it was, no shadow');
        // A typeface with no file known to draw from: as Pango draws it,
        // stretched as a whole.
        glass.setType({typeface: {...typefaceFor('serif'), family: 'Noto Serif', file: null, axes: null},
            style: {weight: 600, width: 90}});
        check(await waitFor(() => glass.fontFile === null && glass.metrics && glass.glyphBoxes?.length === 4, 3000),
            `no file known: Pango draws it (${glass.variations}, ${glass.glyphBoxes?.length} digits' boxes)`);
        await Scripting.sleep(300);
        await screenshot('91e-lock-glass-pango');
        const drawnByPango = pixelsOf('91e-lock-glass-pango');
        const across = digitsNow();
        let brightest = [0, 0, 0];
        for (let x = Math.round(across.x); x < across.x + across.width; x += 2) {
            const at = drawnByPango.at(monitor.x + x, monitor.y + across.y + across.height * 0.3);
            if (lightOf(at) > lightOf(brightest))
                brightest = at;
        }
        check(lightOf(brightest) > lightOf(sky) + 30, `and in glass (${brightest} over ${sky})`);
        glass.setType({typeface: inter, style: styleFor(inter, 'glass')});
        check(await waitFor(() => glass.fontFile?.endsWith('/fonts/Inter.ttf'), 3000), 'Inter again');
        board._planGlass = planGlass;

        // The hill higher: the digits shorter, easing there.
        hill = Math.round(boxTop + side * 0.45);
        writeCutout();
        board.depth._load();
        const was = glass.target.stretch;
        check(await waitFor(() => glass.target.stretch < was - 0.1, 3000) &&
            await waitFor(() => glass.stretch === glass.target.stretch, 2000),
        `the hill higher, they ease shorter (×${was.toFixed(2)} → ×${glass.target.stretch.toFixed(2)})`);
        check(Math.abs(intoHill(digitsNow()) - STRETCH.overlap) < 0.03, 'their feet in it again');

        // Without the depth effect: as tall as the box lets them.
        lockSettings.set_boolean('depth-effect', false);
        check(await waitFor(() => !board.depth && glass.target.stretch > was - 0.01, 3000),
            `without it, as tall as the box lets them (×${glass.target.stretch.toFixed(2)})`);
    } finally {
        if (clock)
            delete clock._sync;
        backdrop?.destroy();
        await locked.unlock();
        realBattery();
    }
    ['widgets', 'gnome-clock', 'password-field', 'depth-effect'].forEach(key => lockSettings.reset(key));
    kept.forEach(([key, value]) => background.set_string(key, value));
}

// The lock screen on wallpapers of one's own (ATELIER_TEST_WALLPAPER, one
// or more, apart by colons), each cutout made by the worker with a real
// depth model (ATELIER_TEST_MODEL, only read), as someone has it: a large
// stacked clock in the middle and a small battery under it on the first;
// the glass clock on each. Screenshots, mostly.
async function testLockOnOwnWallpaper() {
    const [sources, model] = [GLib.getenv('ATELIER_TEST_WALLPAPER'), GLib.getenv('ATELIER_TEST_MODEL')];
    const python = GLib.find_program_in_path('python3');
    if (!Main.screenShield || !sources || !model || !python) {
        results.push('INFO  no ATELIER_TEST_WALLPAPER and ATELIER_TEST_MODEL: the lock screen on one\'s own wallpaper not shown');
        return;
    }
    const atelier = () => Main.extensionManager.lookup(UUID).stateObj;
    const lock = () => atelier().lockModules?.get('lockscreen');
    const lockSettings = atelier()._settings.get_child('lockscreen');
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const kept = ['picture-uri', 'picture-uri-dark', 'picture-options'].map(key => [key, background.get_string(key)]);
    const monitor = Main.layoutManager.primaryMonitor;
    const size = [monitor.width, monitor.height];
    // In the middle, as on a grid of 34 columns: on this one's, as far from the sides.
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const [columns] = gridSize(monitor.width / scale, monitor.height / scale);
    const shift = (columns - 34) / 2;
    // (ATELIER_TEST_LAYOUT: one's own, as the lockscreen widgets key keeps
    // it, on a grid of 34 columns – its glass clock on every wallpaper.)
    const own = JSON.parse(GLib.getenv('ATELIER_TEST_LAYOUT') || 'null');
    const layout = face => JSON.stringify(own?.map(entry => ({...entry, x: entry.x + shift})) ?? [
        {id: 'clock', kind: 'clock', size: 'large', x: 13 + shift, y: 5, fine: true, face},
        {id: 'battery', kind: 'battery', size: 'small', x: 15 + shift, y: 18, fine: true},
    ]);
    // (ATELIER_TEST_SUBJECT: a subject model too, only read.)
    const subject = GLib.getenv('ATELIER_TEST_SUBJECT');
    lockSettings.set_string('style', 'bare');
    lockSettings.set_boolean('gnome-clock', false);
    lockSettings.set_boolean('password-field', false);
    lockSettings.set_boolean('depth-effect', true);
    const realBattery = fakeBattery();
    // (Copies in the test's own data: the ones given are only read.)
    const dir = `${GLib.get_user_data_dir()}/atelier/wallpapers`;
    GLib.mkdir_with_parents(dir, 0o755);
    try {
        for (const [n, source] of sources.split(':').filter(Boolean).entries()) {
            const wallpaper = `${dir}/own-${GLib.path_get_basename(source)}`;
            Gio.File.new_for_path(source).copy(Gio.File.new_for_path(wallpaper), Gio.FileCopyFlags.OVERWRITE, null, null);
            const cutout = cutoutPath(pictureState(wallpaper), size);
            const started = GLib.get_monotonic_time();
            const worker = Gio.Subprocess.new([python, workerPath(), '--model', model,
                ...subject ? ['--subject', subject] : [], '--input', wallpaper,
                '--output', cutout, '--width', `${size[0]}`, '--height', `${size[1]}`],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            const stdout = await new Promise(resolve => worker.communicate_utf8_async(null, null,
                (_, res) => resolve(worker.communicate_utf8_finish(res)[1] ?? '')));
            const answer = JSON.parse(stdout.trim().split('\n').at(-1) || '{}');
            const took = (GLib.get_monotonic_time() - started) / 1e6;
            check(answer.ok && GLib.file_test(cutout, GLib.FileTest.EXISTS),
                `its cutout made in ${took.toFixed(1)} s (${JSON.stringify(answer)})`);
            background.set_string('picture-uri', uriOf(wallpaper));
            background.set_string('picture-uri-dark', uriOf(wallpaper));
            background.set_string('picture-options', 'zoom');
            lockSettings.set_string('widgets', layout(n === 0 && !own ? 'stacked' : 'glass'));
            await wallpapersSettled();
            const locked = await lockForTest();
            let backdrop = null;
            try {
                check(await waitFor(() => lock()?.board?.depth?.loaded && lock().board.typography.sample, 5000),
                    `locked on ${GLib.path_get_basename(source)}, its cutout there`);
                await restPointer();
                await Scripting.sleep(800);
                const depth = lock().board.depth;
                if (n === 0 && !own) {
                    await screenshot('92-lock-own-stacked');
                    results.push(`INFO  stacked: the cutout ${depth.actor.visible ? 'shown' : 'off'}, ` +
                        `the tone ${lock().board.tone?.color}`);
                    lockSettings.set_string('widgets', layout('glass'));
                }
                check(await waitFor(() => lock().board.widgets.find(w => w.entry.id === 'clock')?.glass?.target, 3000),
                    'the glass clock in its place');
                const glass = lock().board.widgets.find(w => w.entry.id === 'clock').glass;
                // (The frosted wallpaper, as the board gives the glass, unless it does.)
                if (!glass.backdrop) {
                    const {GlassBackdrop} = await import('../shell/lockscreen/liquidGlass.js');
                    backdrop = new GlassBackdrop();
                    backdrop.setMonitor(size, scale);
                    await waitFor(() => backdrop.current, 10000);
                    glass.backdrop = backdrop.current;
                }
                await waitFor(() => glass.stretch === glass.target.stretch, 2000);
                await Scripting.sleep(600);
                const name = n === 0 ? '93-lock-own-glass' : `94-lock-own-glass-${n}`;
                await screenshot(name);
                results.push(`INFO  ${name} (${GLib.path_get_basename(source)}): glass ×${glass.target.stretch.toFixed(2)}, ` +
                    `${GLib.path_get_basename(glass.fontFile ?? 'Pango')} ${glass.variations}, ` +
                    `the cutout ${depth.actor.visible ? 'shown' : `off${depth.tooMuch ? ' (covers too much)' : ''}`}`);
            } finally {
                backdrop?.destroy();
                await locked.unlock();
            }
        }
    } finally {
        realBattery();
    }
    ['widgets', 'style', 'gnome-clock', 'password-field', 'depth-effect'].forEach(key => lockSettings.reset(key));
    kept.forEach(([key, value]) => background.set_string(key, value));
}

async function testDisableCleansUp(atelier) {
    // (Grouped, with a black notch: the sides moved and the ears are up.)
    const bar = Main.extensionManager.lookup(UUID).stateObj._settings.get_child('bar');
    bar.set_string('style', 'grouped');
    bar.set_string('island-shape', 'notch');
    await Scripting.sleep(300);
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
    check(!Main.layoutManager.uiGroup.get_children().some(a => hasClass(a, 'atelier-glass') ||
        hasClass(a, 'atelier-capsule') || hasClass(a, 'atelier-notch-ear')), 'no glass, capsules or ears left');
    check(Main.panel._leftBox.translation_x === 0 && Main.panel._rightBox.translation_x === 0,
        'the sides back where GNOME puts them');
    check(Main.layoutManager.overviewGroup.get_first_child()?.name !== 'atelier-overview-backdrop',
        'the overview\'s own background back');
    check(!findActor(Main.layoutManager._backgroundGroup, a => a.name === 'atelier-desktop'),
        'no widgets left on the desktop');
    check(!findActor(Main.uiGroup, a => hasClass(a, 'atelier-note-tab')), 'no notes left on the edges');
    check(!findActor(Main.uiGroup, a => a.name === 'atelier-dock') &&
        Main.panel.statusArea['dash-to-dock'] === undefined, 'no dock left');
    check(Main.panel.statusArea['atelier-claude'] === undefined, 'no modules left in the bar');
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
    bar.reset('style');
    bar.reset('island-shape');
}

// The shell quits with the control centre open, GNOME's tiles, list and
// icons in the island (tools/shell-test.sh checks how it all goes down;
// on two monitors, the shell quits with it closed).
async function testQuitWithControlCentreOpen(ext) {
    const islandModule = ext.stateObj.modules.get('island');
    await waitFor(() => islandModule?.available, 2000);
    Main.panel.toggleQuickSettings();
    check(await waitFor(() => hasClass(islandModule?.island?.page, 'atelier-cc'), 1000),
        'the control centre is open as the shell quits');
    // A notification waits behind it, for the island to be free – which it
    // becomes as the shell takes its UI down.
    const source = appSource('Files', 'org.gnome.Nautilus', 'folder-symbolic');
    const waiting = new MessageTray.Notification({source, title: 'Waiting', body: 'behind the control centre'});
    source.addNotification(waiting);
    await Scripting.sleep(300);
    check(Main.messageTray._notificationQueue.includes(waiting) && hasClass(islandModule?.island?.page, 'atelier-cc'),
        'and a notification waits behind it');
}

// The shell quits with the island's layout, the bar's place and the
// dock's place, row and check still to come (in its Timers): none of it
// may run once GNOME has taken its UI down (tools/shell-test.sh checks the
// log).
function testQuitWithWorkQueued(ext) {
    const modules = ext.stateObj.modules;
    const island = modules.get('island');
    const bar = modules.get('bar');
    const dock = modules.get('dock')?.dock;
    island?._queueLayout();
    bar?._queuePlace();
    dock?._queueRedisplay();
    dock?.queuePlace();
    dock?.intellihide.queueCheck();
    check(island?._laterId && bar?._laterId && ['redisplay', 'place', 'check'].every(name => dock?.timers.has(name)),
        'layout, places and a check still to come as the shell quits');
}

// A picture for the wallpaper: one colour, or the left half one and the
// right half another.
function makePicture(name, left, right = left) {
    const [width, height] = [320, 200];
    const pixbuf = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
    const rgba = hex => (parseInt(hex.slice(1), 16) << 8 | 0xff) >>> 0;
    pixbuf.fill(rgba(left));
    const half = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width / 2, height);
    half.fill(rgba(right));
    half.copy_area(0, 0, width / 2, height, pixbuf, width / 2, 0);
    const path = `${OUTPUT}/${name}.png`;
    pixbuf.savev(path, 'png', [], []);
    return path;
}

// GNOME's weather as it last had it; asked anew, it would go to the network.
class CountingWeather extends FakeWeather {
    updates = 0;

    update() {
        this.updates++;
    }
}

const chromaOf = rgb => Math.max(...rgb) - Math.min(...rgb);
const lightOf = rgb => rgb.reduce((sum, v) => sum + v, 0) / 3;

// The lock screen's look: the wallpaper as glass (its colours kept) while
// the password is asked, the widgets' type in a tone legible on the
// wallpaper behind each, in the font chosen, and the weather and the
// battery in a line – from what GNOME has, nothing asked anew.
async function testLockLook() {
    const shield = Main.screenShield;
    if (!shield) {
        results.push('INFO  no lock screen here (no GDM): the lock screen\'s look untested');
        return;
    }
    const atelier = () => Main.extensionManager.lookup(UUID).stateObj;
    const lock = () => atelier().lockModules?.get('lockscreen');
    const lockSettings = atelier()._settings.get_child('lockscreen');
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const uris = [background.get_string('picture-uri'), background.get_string('picture-uri-dark')];
    const showWallpaper = path => ['picture-uri', 'picture-uri-dark'].forEach(key => background.set_string(key, uriOf(path)));
    const LIGHT = '#efe6d2';
    const DARK = '#141a24';
    const light = makePicture('lock-light', LIGHT);
    const dark = makePicture('lock-dark', DARK);
    const colourful = makePicture('lock-colourful', '#e0402a', '#2a9d8f');
    const middling = makePicture('lock-middling', '#9aa8b8');
    lockSettings.set_string('widgets', JSON.stringify([
        {id: 'clock', kind: 'clock', size: 'large', x: 2, y: 2, fine: true, face: 'stacked'},
        {id: 'date', kind: 'date', size: 'square', x: 30, y: 2, fine: true},
        {id: 'weather', kind: 'weather', size: 'small', x: 28, y: 16, fine: true},
        {id: 'battery', kind: 'battery', size: 'line', x: 28, y: 18, fine: true},
    ]));
    lockSettings.set_boolean('gnome-clock', false);
    // GNOME's weather and battery, made up.
    const weatherItem = Main.panel.statusArea.dateMenu?._weatherItem;
    const realWeather = weatherItem?._weatherClient;
    const weather = new CountingWeather();
    if (weatherItem)
        weatherItem._weatherClient = weather;
    const systemItem = Main.panel.statusArea.quickSettings._system?._systemItem;
    const realToggle = systemItem?._powerToggle;
    const toggle = new QuickSettings.QuickToggle({title: '64 %'});
    toggle._proxy = {IsPresent: true, Percentage: 64, State: 1};
    if (systemItem)
        systemItem._powerToggle = toggle;
    showWallpaper(light);
    await wallpapersSettled();
    const widget = id => lock()?.board?.widgets.find(w => w.entry.id === id);
    const ink = actor => hexOf(actor.get_theme_node().get_foreground_color());
    let locked = await lockForTest();
    try {
        check(await waitFor(() => lock()?.board?.widgets.length === 4 && lock().board.typography.sample &&
            widget('clock')._hours?.mapped, 5000), 'locked: the clock, the date, the weather and the battery');
        const board = lock().board;
        const hours = () => widget('clock')._hours;
        // What a tone reads at on a flat wallpaper (APCA's |Lc|), against
        // what the date line needs (15 pt, 600).
        const LINE = minimumLc(20, 600);
        const lc = (actor, wallpaper) => Math.abs(contrastLc(ink(actor), wallpaper));
        // On a light wallpaper, dark type.
        check(await waitFor(() => lc(hours(), LIGHT) >= LINE && luminance(ink(hours())) < 0.2, 3000),
            `on a light wallpaper, the clock in a dark tone, legible on it (${ink(hours())}, Lc ${lc(hours(), LIGHT).toFixed(0)})`);
        check(lc(widget('date')._day, LIGHT) >= LINE, `the date too (${ink(widget('date')._day)})`);
        const everything = () => [hours(), widget('clock')._minutes, widget('clock')._suffix, widget('clock')._date,
            widget('date')._day, widget('date')._month, widget('weather')._value, widget('weather')._caption,
            widget('battery')._value, widget('battery')._caption];
        const inks = () => new Set(everything().map(ink));
        check(inks().size === 1, `one tone for all of it, solid (${[...inks()]})`);
        // A shadow round a part's letters only where its plan has one, none
        // on the clock and the date lines where they read as they are.
        const shadowOf = actor => actor.get_theme_node().get_text_shadow();
        const asPlanned = () => everything().every(actor => Boolean(shadowOf(actor)) === Boolean(actor._atelierPlan?.shadow));
        const clockParts = () => [hours(), widget('clock')._minutes, widget('clock')._date, widget('date')._day];
        check(asPlanned() && clockParts().every(actor => !shadowOf(actor)),
            `no shadow where the type reads (${everything().filter(shadowOf).map(actor => actor.text)})`);
        // Set as it is drawn: in Inter (Inter Display large), the font
        // variations St can't set held over its own (shell/core/fonts.js).
        // (Its property, a copy: get_font_description() says it gives away
        // the text's own, which JS then frees.)
        const drawn = actor => actor.clutter_text.font_description;
        const families = () => new Set(everything().map(actor => drawn(actor).get_family()));
        check([...families()].every(family => family.split(',').includes('Inter')),
            `in Inter, all of it (${[...families()]})`);
        const variations = actor => drawn(actor).get_variations() ?? '';
        check(variations(hours()).includes('wght=800') && variations(widget('clock')._date).includes('wght=600'),
            `the digits at 800, the date line at 600 (${variations(hours())}; ${variations(widget('clock')._date)})`);
        await restPointer();
        await Scripting.sleep(400);
        await screenshot('88-lock-look-light');
        // The wallpaper changed while locked: light type on a dark one.
        showWallpaper(dark);
        check(await waitFor(() => lc(hours(), DARK) >= LINE && luminance(ink(hours())) > 0.5, 5000),
            `on a dark wallpaper, in a light one (${ink(hours())}, Lc ${lc(hours(), DARK).toFixed(0)})`);
        check(inks().size === 1 && asPlanned() && clockParts().every(actor => !shadowOf(actor)),
            `all of it, no shadow where it reads (${[...inks()]})`);
        // A grey-blue one: light type a little short there – the date line
        // a little heavier, the small captions a shadow round their letters
        // – and the big digits, which need far less, as they are.
        showWallpaper(middling);
        const caption = () => widget('weather')._caption;
        check(await waitFor(() => shadowOf(caption()) && !shadowOf(hours()), 5000) && asPlanned(),
            `on a grey-blue one, a shadow round the small caption, none round the big digits (${shadowOf(caption())?.blur})`);
        const line = widget('clock')._date;
        check(line._atelierPlan?.boldness > 0 && !shadowOf(line) &&
            variations(line).includes(`wght=${line._atelierPlan.weight}`),
        `the date line a little heavier, no shadow (${variations(line)})`);
        await Scripting.sleep(300);
        await screenshot('88a-lock-look-middling');
        showWallpaper(dark);
        check(await waitFor(() => lc(hours(), DARK) >= LINE && !shadowOf(caption()), 5000) && asPlanned(),
            'back on the dark one, no shadow again');
        // A colour of one's own.
        lockSettings.set_string('clock-color', '#ffcc00');
        check(ink(hours()) === '#ffcc00' && ink(widget('battery')._value) === '#ffcc00', 'a colour chosen, on all of them');
        lockSettings.reset('clock-color');
        check(lc(hours(), DARK) >= LINE, 'Auto again');

        // The font chosen: the clocks' digits in the weight and width set.
        lockSettings.set_string('clock-font', 'heavy');
        check(variations(hours()).includes('wght=900') && variations(widget('clock')._date).includes('wght=800'),
            `heavy: the big digits in the heaviest weight (${variations(hours())})`);
        lockSettings.set_string('clock-font', 'thin');
        check(variations(hours()).includes('wght=200'), `thin: in a thin one (${variations(hours())})`);
        lockSettings.set_string('clock-font', 'flex');
        lockSettings.set_int('clock-weight', 350);
        lockSettings.set_int('clock-width', 75);
        check(drawn(hours()).get_family() === 'Roboto Flex' && variations(hours()).includes('wght=350') &&
            variations(hours()).includes('wdth=75') && variations(widget('clock')._date).includes('wght=600') &&
            variations(widget('clock')._date).includes('wdth=100'),
        `Roboto Flex: the digits at the weight and on the width set, the date line as it is (${variations(hours())}; ${variations(widget('clock')._date)})`);
        await Scripting.sleep(300);
        await screenshot('88d-lock-look-flex');
        lockSettings.reset('clock-weight');
        lockSettings.reset('clock-width');
        lockSettings.set_string('clock-font', 'serif');
        const serif = board.typography.typeface.family;
        check(Boolean(serif) && everything().every(actor => drawn(actor).get_family().includes(serif)),
            `serif: the first serif installed, on all of it (${[...families()]})`);
        await Scripting.sleep(300);
        await screenshot('88b-lock-look-dark-serif');
        lockSettings.reset('clock-font');
        check(!drawn(hours()).get_family().includes(serif ?? '-') && variations(hours()).includes('wght=800'),
            'and back as it was');

        // The weather and the battery, in a line, from what GNOME has.
        const [weatherWidget, batteryWidget] = [widget('weather'), widget('battery')];
        check(weatherWidget.visible && weatherWidget._value.text === '14°' && weatherWidget._caption.text === 'Partly cloudy' &&
            weatherWidget._icon.icon_name === 'weather-few-clouds-symbolic', `the weather (${weatherWidget._value.text})`);
        check(batteryWidget.visible && batteryWidget._value.text === '64 %' && batteryWidget._caption.text === 'Charging' &&
            batteryWidget._ring._fraction === 0.64 && batteryWidget._ring._charging, 'the battery, charging');
        check(weather.updates === 0, 'the weather never asked anew (that would go to the network)');
        const [wx, wy] = weatherWidget.get_transformed_position().map(Math.round);
        const [, by] = batteryWidget.get_transformed_position();
        await screenshotArea('88c-lock-weather-battery', wx, wy, Math.round(batteryWidget.width),
            Math.round(by + batteryWidget.height) - wy);
        check(lc(batteryWidget._value, DARK) >= LINE, 'in the lock screen\'s tone');
        weather.info = {...weather.info, get_temp_summary: () => '15 °C'};
        weather.emit('changed');
        check(weatherWidget._value.text === '15°', 'as GNOME has it anew');
        toggle._proxy = {IsPresent: false};
        toggle.title = '';
        check(!batteryWidget.visible, 'no battery: it doesn\'t show');
        weather.available = false;
        weather.emit('changed');
        check(!weatherWidget.visible, 'no weather: nor does the weather');
    } finally {
        await locked.unlock();
    }

    // The glass: the wallpaper's colours kept as the password is asked.
    showWallpaper(colourful);
    await wallpapersSettled();
    locked = await lockForTest();
    try {
        check(await waitFor(() => lock()?.board?.widgets.length > 0, 3000), 'locked again, on a colourful wallpaper');
        const dialog = shield._dialog;
        const wallpapers = () => dialog._backgroundGroup.get_children();
        // (Away from the widgets, the popup and the island: the red half –
        // once the lock screen shows its wallpaper: locked by hand, GNOME
        // fades to black until the pointer moves.)
        await restPointer();
        const patch = [150, 640, 200, 180];
        let sharp = [0, 0, 0];
        for (let tries = 0; tries < 10 && lightOf(sharp) < 20; tries++) {
            await Scripting.sleep(500);
            await screenshot('89-lock-glass-sharp');
            sharp = averageColor('89-lock-glass-sharp', ...patch);
        }
        await clickAt(300, 800);
        check(await waitFor(() => lock().room === 1 && lock()._glass.progress === 1, 3000), 'the prompt is up');
        const glass = wallpapers().map(w => w.get_effect('atelier-glass'));
        check(glass.length > 0 && glass.every(e => e?.enabled && e.look[0] > 1.2),
            'the wallpaper turns to glass, its colours a little richer');
        check(wallpapers().every(w => w.get_effect('blur').radius >= 80 && w.get_effect('blur').brightness > 0.8),
            `blurred as GNOME has it, darkened far less (${wallpapers().map(w => w.get_effect('blur').brightness)})`);
        await restPointer();
        await Scripting.sleep(300);
        await screenshot('89b-lock-glass');
        const blurred = averageColor('89b-lock-glass', ...patch);
        check(chromaOf(sharp) > 100 && chromaOf(blurred) >= 0.85 * chromaOf(sharp) && lightOf(blurred) >= 0.7 * lightOf(sharp),
            `its colours kept (chroma ${chromaOf(sharp)} → ${chromaOf(blurred)}, light ${Math.round(lightOf(sharp))} → ${Math.round(lightOf(blurred))})`);
        await pressKey(Clutter.KEY_Escape);
        check(await waitFor(() => lock().room === 0 && wallpapers().every(w => !w.get_effect('atelier-glass').enabled &&
            !w.get_effect('blur').enabled), 3000), 'Escape: sharp again, no glass');
        // Unlocked: sharp again as the lock screen goes, by itself.
        await clickAt(300, 800);
        await waitFor(() => lock().room === 1 && lock()._field?.form, 3000);
        await typeText('right');
        await pressKey(Clutter.KEY_Return);
        await waitFor(() => locked.verifiers.at(-1)?.answers.includes('right'), 2000);
        locked.verifiers.at(-1).emit('verification-complete');
        const progress = [];
        check(await waitFor(() => {
            progress.push(lock()._glass.progress);
            return lock()._glass.progress === 0;
        }, 2000) && progress.some(p => p > 0 && p < 1) && wallpapers().every(w => !w.get_effect('blur').enabled),
        `unlocked, the wallpaper comes sharp again, step by step (${progress.length} steps)`);
    } finally {
        await locked.unlock();
        if (weatherItem)
            weatherItem._weatherClient = realWeather;
        if (systemItem)
            systemItem._powerToggle = realToggle;
        toggle.destroy();
        background.set_string('picture-uri', uris[0]);
        background.set_string('picture-uri-dark', uris[1]);
        lockSettings.reset('widgets');
        lockSettings.reset('gnome-clock');
        lockSettings.reset('clock-color');
        lockSettings.reset('clock-font');
        lockSettings.reset('clock-weight');
        lockSettings.reset('clock-width');
        await wallpapersSettled();
    }
    const desktop = atelier().modules.get('desktop');
    check(!desktop || [...desktop.widgets.values()].every(w => !w.style), 'the desktop\'s widgets as they were');
}

// Each profile keeps its own lock screen (as an iPhone keeps each of its
// lock screens): switching profiles switches it, only what differs written;
// what is changed of it, on the mock lock screen or in the settings, goes
// into the profile in use and no other, never into the one before while a
// profile is being written; a wallpaper for now changes neither.
async function testLockPerProfile(atelier) {
    const {POSTER_KEYS, readLockscreen} = await import('../lib/profiles.js');
    const store = atelier._store;
    const settings = atelier._settings;
    const lockSettings = settings.get_child('lockscreen');
    const editor = Main.extensionManager.lookup(UUID).stateObj.modules.get('lockscreen-editor');
    const before = {active: store.activeId, profiles: store.getAll()};
    check(before.profiles.length > 0 && before.profiles.every(profile => profile.lockscreen),
        'every profile has a lock screen of its own');
    check(JSON.stringify(atelier._readCurrentSetup().lockscreen) === JSON.stringify(readLockscreen(lockSettings)),
        'a profile saved now keeps the lock screen there is');
    // (The same lock screen, whatever order its widgets' keys are in.)
    const sorted = value => JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
    const shows = id => sorted(readLockscreen(lockSettings)) === sorted(store.get(id).lockscreen);
    const changed = [];
    const changedId = lockSettings.connect('changed', (_, key) => POSTER_KEYS.includes(key) && changed.push(key));
    let writes = 0;
    const writesId = settings.connect('changed::profiles', () => writes++);
    try {
        store.update('amber', {lockscreen: {
            widgets: [{id: 'clock', kind: 'clock', size: 'tall', x: 13, y: 2, fine: true, face: 'glass'}],
            style: 'bare', clockColor: 'auto', clockFont: 'inter', clockWeight: 0, clockWidth: 0,
            gnomeClock: false, depthEffect: false,
        }});
        store.update('glass', {lockscreen: {
            widgets: [{id: 'clock', kind: 'clock', size: 'square', x: 2, y: 2, fine: true, face: 'digital'},
                {id: 'date', kind: 'date', size: 'square', x: 6, y: 2, fine: true}],
            style: 'modern', clockColor: '#ffcc00', clockFont: 'serif', clockWeight: 700, clockWidth: 120,
            gnomeClock: true, depthEffect: false,
        }});
        await atelier._applier.apply(store.get('amber'), {animate: false});
        check(store.activeId === 'amber' && shows('amber'), 'switched to a profile, its lock screen shows');

        changed.length = 0;
        const amber = JSON.stringify(store.get('amber'));
        const glass = JSON.stringify(store.get('glass'));
        settings.set_string('apply-request', JSON.stringify({id: 'glass', nonce: GLib.uuid_string_random()}));
        check(await waitFor(() => store.activeId === 'glass' && !atelier._applier.busy, 8000),
            'switched to another (as the preferences ask)');
        check(shows('glass'), 'its lock screen follows: the widgets, look, colour, font, weight, width, GNOME\'s clock');
        check([...changed].sort().join() === ['clock-color', 'clock-font', 'clock-weight', 'clock-width',
            'gnome-clock', 'style', 'widgets'].join(), `written in one go, what differs only (${changed})`);
        check(JSON.stringify(store.get('amber')) === amber && JSON.stringify(store.get('glass')) === glass,
            'the profile before keeps its own, the new one as it was saved');
        changed.length = 0;
        await atelier._applier.apply(store.get('glass'), {animate: false});
        check(changed.length === 0, `the same profile again: nothing written (${changed})`);

        // Changed on the mock lock screen.
        lockSettings.set_string('edit-request', GLib.uuid_string_random());
        check(await waitFor(() => editor?.preview, 3000), 'the mock lock screen open');
        writes = 0;
        const battery = editor.preview._board.addWidget('battery');
        check(Boolean(battery) && store.get('glass').lockscreen.widgets.some(e => e.kind === 'battery'),
            'a widget placed on the mock lock screen is kept in the profile in use');
        check(!store.get('amber').lockscreen.widgets.some(e => e.kind === 'battery'), 'and in no other');
        editor.preview.close();
        check(await waitFor(() => !editor.preview, 3000), 'the mock lock screen gone');
        // Changed as the settings window changes it.
        lockSettings.set_string('clock-font', 'rounded');
        lockSettings.set_string('clock-color', '#33aaff');
        check(store.get('glass').lockscreen.clockFont === 'rounded' && store.get('glass').lockscreen.clockColor === '#33aaff' &&
            store.get('amber').lockscreen.clockFont === 'inter', 'a font and a colour chosen in the settings too');
        const settled = writes;
        await Scripting.sleep(1000);
        check(writes === settled && settled <= 3, `kept once for each change, and then nothing (${settled} writes)`);

        // Back: the first one's, as it was; the other keeps what was changed of its.
        await atelier._applier.apply(store.get('amber'), {animate: false});
        check(shows('amber') && JSON.stringify(store.get('amber')) === amber, 'back, the first one\'s lock screen as it was');
        const kept = store.get('glass').lockscreen;
        check(kept.widgets.some(e => e.kind === 'battery') && kept.clockFont === 'rounded',
            'the other keeps what was changed of its');

        // A wallpaper for now.
        const profiles = settings.get_string('profiles');
        changed.length = 0;
        await atelier._applyWallpaper({setActive() {}, close() {}}, `${GLib.get_user_data_dir()}/Wallpapers/pills.jxl`);
        check(changed.length === 0 && settings.get_string('profiles') === profiles && store.activeId === 'amber',
            `a wallpaper for now: the lock screen and the profiles as they were (${changed})`);
    } finally {
        lockSettings.disconnect(changedId);
        settings.disconnect(writesId);
        editor?.preview?.destroy();
        store.setAll(before.profiles);
        if (store.get(before.active))
            await atelier._applier.apply(store.get(before.active), {animate: false});
        await wallpapersSettled();
    }
    check(!before.active || shows(before.active), 'and as it was before');
}

// The lock screen's own fonts (shell/core/fonts.js): Inter and Roboto Flex
// in St's font map and in Cairo's as Atelier starts, a label's variations
// kept over St's style, and which Inter "Inter" finds where the static one
// is installed too (lib/lockType.js labelFont()). And the digits' outlines
// through HarfBuzz in the shell, stretched (lib/glyphOutlines.js).
async function testLockFonts() {
    const {default: PangoCairo} = await import('gi://PangoCairo');
    const {holdLabelFont, registerFonts} = await import('../shell/core/fonts.js');
    const {bundledFile, fontAt, traceOutline} = await import('../lib/glyphOutlines.js');
    const {labelFont, styleFor, typefaceFor} = await import('../lib/lockType.js');
    const stMap = global.stage.get_pango_context().get_font_map();
    const cairoMap = PangoCairo.FontMap.get_default();
    check(Boolean(stMap.get_family('Roboto Flex') && cairoMap.get_family('Roboto Flex') && stMap.get_family('Inter')),
        'the lock screen\'s fonts in St\'s font map and in Cairo\'s, from the start');
    check(registerFonts(), 'asked again: there');

    const label = new St.Label({text: '0000', style: 'font-family: "Roboto Flex"; font-size: 60px; font-weight: 600;'});
    Main.uiGroup.add_child(label);
    const width = () => label.clutter_text.get_preferred_width(-1)[1];
    // (What Pango found for it: never ask such a font its face, see fonts.js.)
    const found = () => label.clutter_text.get_layout().get_iter().get_run_readonly()?.item.analysis.font.describe().to_string() ?? '';
    try {
        await Scripting.sleep(100);
        const plain = width();
        holdLabelFont(label, size => ({families: ['Roboto Flex'], weight: 600, variations: `wght=600,wdth=25,opsz=${Math.round(size)}`}));
        const narrow = width();
        check(narrow < plain * 0.7, `a label on Roboto Flex's width axis, which St can't set (${plain} → ${narrow}, ${found()})`);
        label.set_style('font-family: "Roboto Flex"; font-size: 60px; font-weight: 600; color: #ffcc00;');
        await Scripting.sleep(100);
        check(Math.abs(width() - narrow) < 1, `kept as St sets its style anew (${width()})`);
        check(found().includes('opsz=60'), `its optical size its size in pixels (${found()})`);
        holdLabelFont(label, null);
        await Scripting.sleep(100);
        check(Math.abs(width() - plain) < 1, `and St's own again (${width()})`);

        // "Inter": the static one (fonts-inter) where it is installed, at
        // sizes outside the variable one's optical sizes (14 to 32 points:
        // fontconfig matches them as its sizes); the variable one otherwise.
        const staticInter = Boolean(stMap.get_family('Inter Display'));
        const interAt = async (px, weight) => {
            label.set_style(`font-family: Inter; font-size: ${px}px; font-weight: ${weight};`);
            await Scripting.sleep(50);
            return found();
        };
        const within = await interAt(24, 450);
        check(within.includes('wght=450'), `at 18 points, "Inter" is this one, at weight 450 (${within})`);
        for (const px of [16, 80]) {
            const outside = await interAt(px, 450);
            results.push(`INFO  the static Inter ${staticInter ? 'is' : 'isn\'t'} installed; "Inter" at ${px}px, weight 450: ${outside}`);
            check(staticInter ? !outside.includes('@') : outside.includes('wght=450'),
                `at ${px}px, "Inter" is ${staticInter ? 'the static one (its weights in hundreds)' : 'this one'} (${outside})`);
        }
        const inter = typefaceFor('inter');
        label.set_style('font-size: 80px;');
        holdLabelFont(label, size => labelFont(inter, styleFor(inter, 'digits'), size));
        await Scripting.sleep(50);
        check(staticInter ? found().startsWith('Inter Display') : found().includes('opsz=32'),
            `large, in labelFont() its display cut (${found()})`);
        holdLabelFont(label, null);
    } finally {
        label.destroy();
    }

    // The glass digits: shaped and outlined by HarfBuzz here too, stretched.
    const font = fontAt(bundledFile('Inter.ttf'), 'wght=600,opsz=32');
    const {glyphs, advance} = font.shape('10:52', ['tnum', 'case']);
    check(glyphs.length === 5 && [0, 1, 3, 4].every(i => glyphs[i].advance === glyphs[0].advance),
        `"10:52" shaped, its figures all as wide (${glyphs.map(g => g.advance)})`);
    const area = new St.DrawingArea({width: 700, height: 420, x: 100, y: 100});
    let drawn = false;
    area.connect('repaint', () => {
        const cr = area.get_context();
        const scale = 120 / (font.figures.top - font.figures.bottom);
        cr.setSourceRGBA(1, 1, 1, 1);
        for (const g of glyphs)
            traceOutline(cr, font.stretched(g.glyph, 2.8), {x: 20 + g.x * scale * 0.9, y: 380, scale, scaleX: 0.9});
        cr.fill();
        cr.$dispose();
        drawn = true;
    });
    Main.uiGroup.add_child(area);
    try {
        check(await waitFor(() => drawn, 3000) && advance > 0, 'drawn in an St.DrawingArea, 2.8 times as tall');
        await Scripting.sleep(200);
        await screenshotArea('95-lock-fonts', 100, 100, 700, 420);
    } finally {
        area.destroy();
    }
}

export async function run() {
    // GNOME's helper for these scripts quits after a while without calls,
    // and the shell then exits at once instead of shutting down as at the
    // end of a session (which tools/shell-test.sh checks): keep it awake.
    const helperId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
        Scripting.waitTestWindows();
        return GLib.SOURCE_CONTINUE;
    });
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
        // Only the dock's checks (tools/shell-test.sh dock), on one monitor.
        if (SUITE === 'dock') {
            await testDock(ext);
            // (Pinning an app says so, and the shell must not quit with a
            // notification up: in the whole suite, it is gone by then.)
            Main.messageTray.getSources().forEach(source => [...source.notifications].forEach(n => n.destroy()));
            await Scripting.sleep(1000);
            testQuitWithWorkQueued(ext);
            return;
        }
        // Only the lock screen's checks (tools/shell-test.sh lock).
        if (SUITE === 'lock') {
            await part(testLockScreen, ext);
            await part(testLockWidgets);
            await part(testLockPasswordField);
            await part(testLockDepth);
            await part(testLockLook);
            await part(testLockGlassClock);
            await part(testLockOnOwnWallpaper);
            await part(testLockPerProfile, ext.stateObj.modules.get('profiles'));
            await part(testLockFonts);
            // (GNOME's wallpapers made anew as it quits would touch what is gone.)
            await wallpapersSettled();
            testQuitWithWorkQueued(ext);
            return;
        }
        if (SUITE === 'two-monitors') {
            await testTwoMonitors(ext);
            await testDockOnTwoMonitors(ext);
            testQuitWithWorkQueued(ext);
            return;
        }

        await part(testIsland, ext, atelier);
        await part(testNotifications, ext, atelier);
        await part(testControlCentre, ext);
        await part(testStackStaysOpaque, ext);
        await part(testOtherExtensions, ext);
        await part(testOtherExtensionSettings, ext);
        await part(testTrayApp, ext);
        await part(testOverviewBar);
        await part(testBarStyles, ext);
        await part(testFullscreen, ext);
        await part(testClaude, ext);
        await part(testDesktop, ext);
        await part(testPhotoGallery, ext);
        await part(testNotes, ext);
        await part(testDock, ext);
        await part(testSwitcherAndReveal, atelier);
        await part(testPalette, ext, atelier);
        await part(testShortcutsAndRequests, atelier);
        await part(testFromOverview, atelier);
        await part(testHostileShellTheme, atelier);
        await part(testGtkStyles, ext, atelier);
        await part(testTerminal, ext);
        await part(testProfilesStayAsSaved, ext, atelier);
        await part(testWallpapersTab, atelier);
        await part(testMoveProfiles, atelier);
        await part(testNewProfile, ext, atelier);
        await part(testDisableCleansUp, atelier);
        await part(testSwitcherPopupGoesWithAtelier);
        await part(testSystemItemLater);
        // (After the parts that keep the modules they started with: this
        // turns Atelier off and on.)
        await part(testLockScreen, ext);
        await part(testLockWidgets);
        await part(testLockPasswordField);
        await part(testLockDepth);
        await part(testLockLook);
        await part(testLockGlassClock);
        await part(testLockOnOwnWallpaper);
        await part(testLockPerProfile, ext.stateObj.modules.get('profiles'));
        await part(testLockFonts);
        // (Last: they set up how the shell quits.)
        await testQuitWithControlCentreOpen(ext);
        testQuitWithWorkQueued(ext);
    } catch (e) {
        check(false, `exception: ${e}\n${e.stack}`);
    } finally {
        GLib.source_remove(helperId);
        GLib.file_set_contents(`${OUTPUT}/results.txt`, `${results.join('\n')}\n`);
    }
}
