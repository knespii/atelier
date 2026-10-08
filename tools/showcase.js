// Automation script for tools/showcase.sh: Atelier at its best, in pictures
// for the README (docs/screenshots) – and, with ATELIER_SHOWCASE_FRAMES set,
// a few moments in slow motion, frame by frame, each frame with the time it
// shows (takes.json), for a video. GNOME Shell imports it, calls run() once
// startup is complete and exits when it returns.
//
// Coordinates are the stage's: the logical pixels of a 1920×1080 desktop,
// which the 4K monitor at scale 2 shows in twice the detail.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as Scripting from 'resource:///org/gnome/shell/ui/scripting.js';

const UUID = 'atelier@local';
const OUTPUT = GLib.getenv('ATELIER_SHOWCASE_OUTPUT');
const DOCS = GLib.getenv('ATELIER_SHOWCASE_DOCS');
const FRAMES = GLib.getenv('ATELIER_SHOWCASE_FRAMES') || null;
// Only these takes (by name, comma separated), and no pictures: to record
// one again.
const ONLY = GLib.getenv('ATELIER_SHOWCASE_TAKES')?.split(',').filter(Boolean) ?? [];
// Pictures being written at once (PNG takes its time, each on a thread).
const IN_FLIGHT = 10;
// Frames of a take for each frame of a 30 fps video.
const DENSITY = 1.3;

const results = [];
const note = text => results.push(`INFO  ${text}`);
const check = (condition, text) => {
    results.push(`${condition ? 'PASS' : 'FAIL'}  ${text}`);
    return condition;
};

// Slow motion: GNOME's animations and the timeouts of the shell (and so of
// Atelier) all take `slow` times as long; this script's own waits don't.
const realTimeoutAdd = GLib.timeout_add;
const realTimeoutAddSeconds = GLib.timeout_add_seconds;
let slow = 1;

function setSlowMotion(factor) {
    slow = factor;
    St.Settings.get().slow_down_factor = factor;
    if (factor === 1) {
        GLib.timeout_add = realTimeoutAdd;
        GLib.timeout_add_seconds = realTimeoutAddSeconds;
    } else {
        GLib.timeout_add = (priority, interval, ...rest) =>
            realTimeoutAdd(priority, Math.round(interval * factor), ...rest);
        GLib.timeout_add_seconds = (priority, interval, ...rest) =>
            realTimeoutAdd(priority, Math.round(interval * 1000 * factor), ...rest);
    }
}

/** @param {number} ms - real milliseconds */
function sleep(ms) {
    return new Promise(resolve => realTimeoutAdd(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(ms)), () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

/** @param {number} ms - milliseconds as shown (slowed down in a take) */
const wait = ms => sleep(ms * slow);

async function waitFor(predicate, timeout = 5000) {
    const start = GLib.get_monotonic_time();
    while (!predicate()) {
        if (GLib.get_monotonic_time() - start > timeout * 1000 * slow)
            return false;
        await sleep(40);
    }
    return true;
}

const hasClass = (actor, name) => Boolean(actor?.has_style_class_name?.(name));

function centerOf(actor) {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return [x + width / 2, y + height / 2];
}

async function capture(path, area = null) {
    const file = Gio.File.new_for_path(path);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    const screenshot = new Shell.Screenshot();
    if (area)
        await screenshot.screenshot_area(...area, stream);
    else
        await screenshot.screenshot(false, stream);
    stream.close(null);
}

// The top middle of the screen, where the island is.
const islandArea = (height, width = 1100) => [(1920 - width) / 2, 0, width, height];
// The island and a sheet dripped from it (not the widgets at the left).
const SHEET_AREA = [400, 0, 1120, 720];

/**
 * A picture for the README, as a JPEG: of the whole screen (1920 wide), or
 * of an area, in twice the detail.
 *
 * @param {string} name - of the file
 * @param {number[]|null} area - [x, y, width, height]
 */
async function still(name, area = null) {
    const png = `${OUTPUT}/${name}.png`;
    await capture(png, area);
    let pixbuf = GdkPixbuf.Pixbuf.new_from_file(png);
    if (!area)
        pixbuf = pixbuf.scale_simple(1920, 1080, GdkPixbuf.InterpType.HYPER);
    pixbuf.savev(`${DOCS}/${name}.jpg`, 'jpeg', ['quality'], ['88']);
    note(`${name}.jpg`);
}

// Input through virtual devices, as a user's: hover, grabs and focus behave
// as they do for one. What the pointer does goes into the take being
// recorded, to be drawn in the video.
const seat = () => global.stage.context.get_backend().get_default_seat();
let pointer = null;
let keyboard = null;
let pointerAt = [1700, 960];
let pressed = false;
let recorder = null;

function movePointer(x, y) {
    pointer ??= seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
    pointerAt = [x, y];
    recorder?.pointer();
}

const easeInOut = t => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/** Along an eased path, in `ms` as shown. */
async function glide(x, y, ms = 500) {
    const [x0, y0] = pointerAt;
    const steps = Math.max(1, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
        const t = easeInOut(i / steps);
        movePointer(x0 + (x - x0) * t, y0 + (y - y0) * t);
        await wait(ms / steps);
    }
}

async function button(state) {
    pointer ??= seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, state);
    pressed = state === Clutter.ButtonState.PRESSED;
    recorder?.pointer();
    // (In real time: held as long as slowed down, a press turns into
    // something else.)
    await sleep(60);
}

const press = () => button(Clutter.ButtonState.PRESSED);
const release = () => button(Clutter.ButtonState.RELEASED);

async function clickAt(x, y, ms = 450) {
    await glide(x, y, ms);
    await wait(90);
    await press();
    await release();
}

// Away from the island, the widgets and the dock.
const rest = () => glide(1700, 960, 1);

/**
 * Keys held down together, e.g. Control and Return – in real time: held as
 * long as slowed down, they would repeat.
 */
async function keys(...keyvals) {
    keyboard ??= seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    for (const keyval of keyvals) {
        keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.PRESSED);
        await sleep(30);
    }
    for (const keyval of [...keyvals].reverse()) {
        keyboard.notify_keyval(GLib.get_monotonic_time(), keyval, Clutter.KeyState.RELEASED);
        await sleep(30);
    }
}

/** Written into the entry with the key focus, at `perSecond` characters a second. */
async function type(text, perSecond = 14) {
    for (const char of text) {
        global.stage.get_key_focus()?.insert_unichar?.(char);
        await wait(1000 / perSecond);
    }
}

/**
 * Pictures of the stage (or an area of it) one after another, each with the
 * time it shows, while something happens in slow motion; with what the
 * pointer did, and marks set on the way.
 */
class Recorder {
    constructor(name, area, factor) {
        this.name = name;
        this._area = area;
        this._factor = factor;
        this._dir = `${FRAMES}/${name}`;
        GLib.mkdir_with_parents(this._dir, 0o755);
        this._frames = [];
        this._pointer = [];
        this._marks = {};
        this._pending = new Set();
        this._running = false;
        this._failed = null;
    }

    /** @returns {number} the milliseconds shown since the start */
    get now() {
        return (GLib.get_monotonic_time() - this._start) / 1000 / this._factor;
    }

    start() {
        this._start = GLib.get_monotonic_time();
        this._running = true;
        this.pointer();
        this._loop = this._run();
    }

    async _run() {
        // As many as a 30 fps video needs, a few more.
        const interval = 1000 / 30 * this._factor / DENSITY;
        let n = 0;
        while (this._running) {
            const due = this._start + n * interval * 1000;
            const now = GLib.get_monotonic_time();
            if (now < due) {
                await sleep(Math.min(20, (due - now) / 1000));
                continue;
            }
            if (this._pending.size >= IN_FLIGHT) {
                await Promise.race(this._pending);
                continue;
            }
            const file = `${String(n).padStart(5, '0')}.png`;
            const time = this.now;
            const done = capture(`${this._dir}/${file}`, this._area).catch(e => (this._failed = e));
            this._frames.push([file, Math.round(time * 10) / 10]);
            n++;
            const tracked = done.then(() => this._pending.delete(tracked));
            this._pending.add(tracked);
            // (The stage gets to draw the next frame meanwhile.)
            await sleep(1);
        }
        await Promise.all(this._pending);
    }

    pointer() {
        this._pointer.push([Math.round(this.now * 10) / 10, ...pointerAt.map(v => Math.round(v * 10) / 10), pressed]);
    }

    mark(name) {
        this._marks[name] = Math.round(this.now);
    }

    async stop() {
        this._running = false;
        await this._loop;
        if (this._failed)
            throw this._failed;
        return {
            name: this.name,
            area: this._area ?? [0, 0, global.stage.width, global.stage.height],
            scale: 2,
            slow: this._factor,
            frames: this._frames,
            pointer: this._pointer,
            marks: this._marks,
        };
    }
}

const takes = [];

/**
 * Something happening, recorded in slow motion.
 *
 * @param {string} name - of its folder
 * @param {number[]|null} area - of the stage, or all of it
 * @param {Function} action - what happens; waits as shown with wait()
 * @param {number} [slower] - this many times slower still (more frames,
 *   for a moment played back slower than it happened)
 */
async function take(name, area, action, slower = 1) {
    // (4K pictures take longer: slower still.)
    const factor = (area ? 10 : 16) * slower;
    await rest();
    await sleep(500);
    setSlowMotion(factor);
    recorder = new Recorder(name, area, factor);
    try {
        recorder.start();
        await action(recorder);
    } finally {
        const done = recorder.stop();
        recorder = null;
        try {
            takes.push(await done);
        } finally {
            setSlowMotion(1);
        }
    }
    note(`take ${name}: ${takes.at(-1).frames.length} frames over ${Math.round(takes.at(-1).frames.at(-1)[1])} ms`);
    await sleep(800);
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

// The monitor at scale 2: a 1920×1080 desktop in twice the detail.
async function doubleScale() {
    const state = await displayConfig('GetCurrentState', null,
        '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})');
    const [serial, monitors] = state.recursiveUnpack();
    const [[connector], modes] = monitors[0];
    const mode = modes.find(m => m[6]['is-current']);
    await displayConfig('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})',
        [serial, 1, [[0, 0, 2.0, 0, true, [[connector, mode[0], {}]]]], {}]));
}

// A day as a calendar could have it, the evening still ahead (the session
// itself has no calendars, weather or accounts).
const Events = GObject.registerClass(
class AtelierShowcaseEvents extends Calendar.EventSourceBase {
    _init() {
        super._init();
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const at = (days, hours, minutes = 0) =>
            new Date(today.getFullYear(), today.getMonth(), today.getDate() + days, hours, minutes);
        const inMinutes = minutes => new Date(Math.ceil((now.getTime() + minutes * 60000) / 900000) * 900000);
        const event = (summary, date, end) => ({id: summary, summary, date, end});
        this._events = [
            event('Yoga', inMinutes(40), inMinutes(100)),
            event('Dinner with friends', inMinutes(130), inMinutes(220)),
            event('Design review', at(1, 10), at(1, 11)),
            event('Print shop', at(3, 14), at(3, 15)),
            event('Gallery opening', at(8, 18), at(8, 21)),
            event('Studio day', at(-4, 9), at(-4, 17)),
            event('Dentist', at(11, 8, 30), at(11, 9)),
            event('Trip to the mountains', at(15, 0), at(17, 0)),
        ];
    }

    get isLoading() {
        return false;
    }

    get hasCalendars() {
        return true;
    }

    requestRange() {}

    getEvents(begin, end) {
        return this._events.filter(e => e.date < end && e.end > begin).sort((a, b) => a.date - b.date);
    }

    hasEvents(day) {
        const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        return this.getEvents(day, end).length > 0;
    }
});

function fakeWeather() {
    const client = Main.panel.statusArea.dateMenu._weatherItem._weatherClient;
    const now = Math.floor(Date.now() / 1000);
    const forecast = (hours, temp, icon) => ({
        get_value_update: () => [true, now + hours * 3600],
        get_value_temp: () => [true, temp],
        get_symbolic_icon_name: () => icon,
    });
    const info = {
        is_valid: () => true,
        get_location_name: () => 'Prague',
        get_symbolic_icon_name: () => 'weather-few-clouds-night-symbolic',
        get_temp_summary: () => '14 °C',
        get_conditions: () => '-',
        get_sky: () => 'Partly cloudy',
        get_forecast_list: () => [
            forecast(1, 13, 'weather-few-clouds-night-symbolic'),
            forecast(2, 12, 'weather-clear-night-symbolic'),
            forecast(3, 11, 'weather-clear-night-symbolic'),
            forecast(4, 11, 'weather-overcast-symbolic'),
            forecast(5, 10, 'weather-overcast-symbolic'),
            forecast(6, 10, 'weather-showers-scattered-symbolic'),
            forecast(7, 9, 'weather-showers-scattered-symbolic'),
            forecast(8, 9, 'weather-overcast-symbolic'),
        ],
    };
    for (const [name, value] of [['available', true], ['loading', false], ['hasLocation', true], ['info', info]])
        Object.defineProperty(client, name, {value, configurable: true});
    client.update = () => {};
    client.emit('changed');
}

// A year of contributions, made up, as GitHub's page has them.
function contributions() {
    const cells = [];
    const day = new Date();
    for (let i = 0; i < 365; i++) {
        const date = new Date(day.getFullYear(), day.getMonth(), day.getDate() - i);
        const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const noise = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
        const busy = (0.55 + 0.45 * Math.sin(i / 19)) * (date.getDay() % 6 === 0 ? 0.35 : 1) * (i < 120 ? 1.2 : 0.8);
        const level = Math.max(0, Math.min(4, Math.floor(busy * noise * 5.2)));
        cells.push(`<td data-date="${iso}" data-level="${level}" class="ContributionCalendar-day"></td>`);
    }
    return `<h2 id="js-contribution-activity-description">\n 1,873\n contributions\n in the last year\n</h2>${cells.join('')}`;
}

function utcDay(days) {
    const now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + days));
}

// The Wi-Fi's name is the machine's own: "Home" in the pictures.
function hideNetworkName() {
    const grid = Main.panel.statusArea.quickSettings?.menu?._grid;
    for (const toggle of grid?.get_children() ?? []) {
        if (typeof toggle._transformSubtitle === 'function' && toggle.subtitle) {
            toggle._transformSubtitle = () => 'Home';
            toggle.subtitle = 'Home';
        }
    }
}

async function fillIn(ext) {
    hideNetworkName();
    const dateMenu = Main.panel.statusArea.dateMenu;
    dateMenu._setEventSource(new Events());
    fakeWeather();
    const desktop = ext.stateObj.modules.get('desktop');
    const tasks = desktop.sources.tasks;
    tasks.refresh = () => {};
    tasks.complete = () => {};
    tasks.tasks = [
        {id: 'invoice', title: 'Send the invoice', due: utcDay(1)},
        {id: 'plants', title: 'Water the plants', due: null},
    ];
    tasks._set('ready');
    const github = desktop.sources.github;
    github._fetch = async () => github.apply('octocat', contributions());
    // Slack: a few messages since it was last looked at (who, never what).
    const slack = desktop.sources.slack;
    slack.unread = 3;
    slack.senders = [
        {name: 'Mia', count: 2, time: Date.now() - 4 * 60000},
        {name: '#design', count: 1, time: Date.now() - 16 * 60000},
    ];
    slack.emit('changed');
    ext.stateObj._settings.get_child('desktop').set_string('github-user', 'octocat');
    // Built anew, the widgets take it all.
    desktop.reload();
    await sleep(1500);
}

/** Switched to, and done with. */
async function switchTo(atelier, id) {
    const profile = atelier._store.get(id);
    await atelier._switchTo(profile);
    await waitFor(() => !atelier._applier.busy && Main.layoutManager._backgroundGroup.get_children()
        .filter(a => a.name !== 'atelier-desktop').length === Main.layoutManager._bgManagers.length, 10000);
    await sleep(1500);
}

const reveal = () => Main.layoutManager._backgroundGroup.get_children()
    .filter(a => a.name !== 'atelier-desktop').length > Main.layoutManager._bgManagers.length;

// Profiles: the switcher grows out of the island; the next one is picked
// with the keyboard and revealed by a growing circle.
async function takeSwitcher({atelier}) {
    await take('switcher', null, async t => {
        await wait(250);
        t.mark('open');
        atelier.toggleSwitcher();
        await wait(900);
        const index = atelier._store.getAll().findIndex(p => p.id === 'dune');
        const from = atelier._switcher._selected ?? 0;
        for (let i = from; i < index; i++) {
            t.mark(`right-${i}`);
            await keys(Clutter.KEY_Right);
            await wait(240);
        }
        await wait(350);
        t.mark('enter');
        await keys(Clutter.KEY_Return);
        // (The work starts once the island has said which profile it is.)
        await waitFor(() => atelier._applier.busy || reveal(), 4000);
        t.mark('reveal');
        await waitFor(() => !atelier._applier.busy && !reveal(), 12000);
        await wait(400);
        t.mark('end');
    });
}

// The next profile at once, as with a shortcut.
async function takeNext({atelier}, name, id) {
    await take(name, null, async t => {
        await wait(250);
        t.mark('switch');
        const done = atelier._switchTo(atelier._store.get(id));
        await waitFor(() => atelier._applier.busy || reveal(), 4000);
        t.mark('reveal');
        await done;
        await waitFor(() => !atelier._applier.busy && !reveal(), 12000);
        await wait(500);
        t.mark('end');
    });
}

// The island: resting on it, a glance; a click, the control centre.
async function takeIsland({island}) {
    await take('island', [320, 0, 1280, 720], async t => {
        movePointer(1180, 560);
        await wait(300);
        const [x, y] = centerOf(island);
        t.mark('hover');
        await glide(x + 4, y + 2, 650);
        await waitFor(() => hasClass(island.page, 'atelier-glance'), 3000);
        t.mark('glance');
        await wait(1900);
        t.mark('click');
        await press();
        await release();
        await waitFor(() => hasClass(island.page, 'atelier-cc'), 3000);
        t.mark('control-centre');
        await glide(x + 160, y + 150, 700);
        await wait(1500);
        t.mark('close');
        await keys(Clutter.KEY_Escape);
        await waitFor(() => island.page === null, 3000);
        await glide(1180, 560, 500);
        await wait(500);
        t.mark('end');
    });
}

// Another profile, whose widgets are elsewhere: once its look is in, they
// pour over there, liquid; a new one spreads out of its middle.
async function takePour({atelier, desktop}) {
    // (From Dune, as the switcher leaves it, when recorded on its own.)
    if (atelier._store.activeId !== 'dune')
        await switchTo(atelier, 'dune');
    await take('pour', null, async t => {
        await wait(250);
        t.mark('switch');
        const done = atelier._switchTo(atelier._store.get('candy'));
        await waitFor(() => atelier._applier.busy || reveal(), 4000);
        t.mark('reveal');
        await done;
        await waitFor(() => desktop._flowing, 10000);
        t.mark('flow');
        await waitFor(() => !desktop._flowing && !desktop._frozen, 10000);
        await wait(700);
        t.mark('end');
    }, 2);
}

// A new note drips from the island; written on and saved, it runs off to
// the edge in a drop, and its paper spreads out of the edge there – all of
// it under the pointer.
async function takeNote({notes, islandModule}) {
    await take('note', null, async t => {
        await wait(300);
        t.mark('open');
        notes.open(null, {create: true});
        await waitFor(() => islandModule._sheet?.opened, 4000);
        t.mark('opened');
        await wait(250);
        const form = islandModule._sheet.form;
        form._title.grab_key_focus();
        t.mark('type');
        await type('Print shop', 16);
        await wait(150);
        await keys(Clutter.KEY_Tab);
        await type('Posters, A2 – 20 copies', 18);
        await wait(450);
        t.mark('color');
        form._colors.find(dot => dot._color === 'peach').emit('clicked', 1);
        await wait(700);
        t.mark('save');
        await keys(Clutter.KEY_Control_L, Clutter.KEY_Return);
        await waitFor(() => islandModule._sheet === null, 6000);
        t.mark('arrived');
        await wait(500);
        const tab = [...notes._edges._tabs.values()].at(-1);
        if (tab) {
            const [, tabY] = tab.get_transformed_position();
            t.mark('hover');
            await glide(8, tabY + tab.height / 2, 450);
        }
        await wait(1100);
        t.mark('end');
    });
}

// Editing the widgets: a click on the clock in the gallery lets its faces
// flow out of it; one dragged out is a clock with that face.
async function takeFaces({desktop}) {
    await take('faces', [320, 360, 1280, 720], async t => {
        await wait(200);
        t.mark('edit');
        desktop.edit();
        await wait(900);
        const editor = desktop._editor;
        t.mark('click');
        await clickAt(...centerOf(editor._clockButton), 650);
        await waitFor(() => editor._spill?.progress === 1, 4000);
        t.mark('spilled');
        await wait(550);
        const watch = editor._spill.panel.get_children().find(item => item.accessible_name === 'Watch');
        const [sx, sy] = centerOf(watch);
        await glide(sx, sy, 550);
        await wait(120);
        await press();
        t.mark('drag');
        await glide(600, 640, 1100);
        await wait(400);
        await release();
        t.mark('dropped');
        await wait(1000);
        await glide(1200, 760, 450);
        t.mark('done');
        desktop.stopEditing();
        await wait(900);
        t.mark('end');
    });
}

// The pictures for the README.
async function stills(ctx) {
    const {ext, atelier, island, islandModule, notes} = ctx;

    await switchTo(atelier, 'midnight');
    await rest();
    await sleep(800);
    await still('desktop');

    // The island: a glance, the control centre and its tabs.
    const [x, y] = centerOf(island);
    await glide(x, y, 300);
    await waitFor(() => hasClass(island.page, 'atelier-glance'), 3000);
    await sleep(900);
    await still('island-glance', islandArea(420));
    await press();
    await release();
    await waitFor(() => hasClass(island.page, 'atelier-cc'), 3000);
    await glide(x + 160, y + 160, 200);
    await sleep(900);
    await still('control-centre', islandArea(420));
    island.page.setTab('calendar');
    await sleep(900);
    await still('control-centre-calendar', islandArea(560));
    island.page.setTab('notes');
    await sleep(900);
    await still('control-centre-notes', islandArea(500));
    Main.panel.closeQuickSettings();
    await waitFor(() => island.page === null, 3000);
    await rest();
    await sleep(600);

    // Claude Code's numbers.
    const indicator = Main.panel.statusArea['atelier-claude'];
    if (indicator) {
        await glide(...centerOf(indicator), 300);
        await waitFor(() => hasClass(island.page, 'atelier-preview'), 3000);
        await sleep(900);
        await still('claude', islandArea(420));
        await rest();
        await waitFor(() => island.page === null, 3000);
        await sleep(600);
    }

    // A notification, in the island.
    const source = new MessageTray.Source({
        title: 'Calendar',
        iconName: 'org.gnome.Calendar',
        policy: new MessageTray.NotificationApplicationPolicy('org.gnome.Calendar'),
    });
    Main.messageTray.add(source);
    await glide(1600, 900, 100);
    source.addNotification(new MessageTray.Notification({
        source, title: 'Yoga in 15 minutes', body: 'At the studio on the corner – bring the mat',
    }));
    if (await waitFor(() => hasClass(island.page, 'atelier-notification'), 4000)) {
        await sleep(900);
        await still('notification', islandArea(260));
    }
    await waitFor(() => island.page === null, 12000);
    source.destroy();
    await sleep(600);

    // The switcher, a profile on its way in, a new one dripping.
    atelier.toggleSwitcher();
    await sleep(900);
    const profiles = atelier._store.getAll();
    atelier._switcher._select(profiles.findIndex(p => p.id === 'ember'));
    await sleep(700);
    await still('switcher', islandArea(330, 1500));
    await keys(Clutter.KEY_Escape);
    await waitFor(() => island.page === null, 4000);
    await sleep(800);

    atelier.toggleSwitcher();
    await sleep(900);
    const last = atelier._switcher._cards.length - 1;
    atelier._switcher._select(last);
    await sleep(500);
    atelier._switcher._activate(last);
    await waitFor(() => islandModule._sheet?.opened && islandModule._sheet.opacity === 255, 6000);
    islandModule._sheet.form._name.text = 'Ember at night';
    await sleep(600);
    await still('new-profile', SHEET_AREA);
    await keys(Clutter.KEY_Escape);
    await waitFor(() => islandModule._sheet === null && islandModule._liquid === null, 4000);
    await sleep(800);

    // Notes: on a sheet from the island, and on the edge of the screen.
    notes.open('note-groceries');
    await waitFor(() => islandModule._sheet?.opened && islandModule._sheet.opacity === 255, 6000);
    await sleep(600);
    await still('note', SHEET_AREA);
    await keys(Clutter.KEY_Escape);
    await waitFor(() => islandModule._sheet === null, 4000);
    await sleep(800);

    // The widgets on paper.
    await switchTo(atelier, 'lagoon');
    await rest();
    await sleep(800);
    const desktopSettings = ext.stateObj._settings.get_child('desktop');
    desktopSettings.set_string('style', 'analogue');
    await sleep(1500);
    await still('widgets-analogue');
    desktopSettings.set_string('style', 'modern');
    await sleep(1000);

    // The dock.
    const dock = ext.stateObj.modules.get('dock')?.dock;
    if (dock) {
        const [dx, dy] = dock.actor.get_transformed_position();
        const [dw, dh] = dock.actor.get_transformed_size();
        await still('dock', [Math.round(dx - 60), Math.round(dy - 40), Math.round(dw + 120), Math.round(dh + 60)]);
    }

    // The bar's other looks: grouped in capsules, of glass.
    const bar = ext.stateObj._settings.get_child('bar');
    bar.set_string('style', 'grouped');
    bar.set_string('sides', 'capsules');
    await sleep(1500);
    await still('bar-grouped', [0, 0, 1920, 90]);
    bar.reset('style');
    bar.reset('sides');
    await sleep(800);
}

export async function run() {
    // GNOME's helper for these scripts quits after a while without calls.
    const helperId = realTimeoutAddSeconds(GLib.PRIORITY_DEFAULT, 10, () => {
        Scripting.waitTestWindows();
        return GLib.SOURCE_CONTINUE;
    });
    try {
        await sleep(1000);
        Main.overview.hide();
        await waitFor(() => !Main.overview.visible, 4000);
        await waitFor(() => Main.extensionManager.lookup(UUID)?.stateObj?.modules?.get('profiles'), 30000);
        const ext = Main.extensionManager.lookup(UUID);
        await doubleScale();
        check(await waitFor(() => global.stage.width === 1920, 5000), 'a 1920×1080 desktop at scale 2');
        await sleep(2000);
        const islandModule = ext.stateObj.modules.get('island');
        const ctx = {
            ext,
            atelier: ext.stateObj.modules.get('profiles'),
            islandModule,
            island: islandModule.island,
            notes: ext.stateObj.modules.get('notes'),
            desktop: ext.stateObj.modules.get('desktop'),
        };
        await fillIn(ext);

        // Slow motion reaches what the extension waits for, too.
        setSlowMotion(2);
        check(GLib.timeout_add !== realTimeoutAdd, 'timeouts can be slowed down');
        setSlowMotion(1);

        if (FRAMES) {
            const all = {
                'switcher': () => takeSwitcher(ctx),
                'pour': () => takePour(ctx),
                'island': () => takeIsland(ctx),
                'note': () => takeNote(ctx),
                'faces': () => takeFaces(ctx),
                'next-lagoon': () => takeNext(ctx, 'next-lagoon', 'lagoon'),
            };
            await rest();
            for (const name of ONLY.length > 0 ? ONLY : Object.keys(all))
                await all[name]();
            // (Recorded again, a take replaces the one there was.)
            const file = `${FRAMES}/takes.json`;
            let kept = [];
            if (ONLY.length > 0 && GLib.file_test(file, GLib.FileTest.EXISTS))
                kept = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(file)[1]));
            const names = new Set(takes.map(recorded => recorded.name));
            GLib.file_set_contents(file, JSON.stringify([...kept.filter(old => !names.has(old.name)), ...takes], null, 1));
        }
        if (ONLY.length === 0)
            await stills(ctx);
    } catch (e) {
        check(false, `exception: ${e}\n${e.stack}`);
    } finally {
        setSlowMotion(1);
        GLib.source_remove(helperId);
        GLib.file_set_contents(`${OUTPUT}/results.txt`, `${results.join('\n')}\n`);
    }
}
