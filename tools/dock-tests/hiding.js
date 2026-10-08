// The dock's checks for hiding (B1): out of the way of real windows in
// each mode, hidden until called, hiding when the pointer leaves, the edge
// on another side, pushing against the edge, full screen, urgent windows,
// and the timing. And the preferences' section "Hiding".
//
// shell(t) runs in tools/shell-test.js, prefs(t) in tools/run-prefs.js; t
// is described there.

import Graphene from 'gi://Graphene';

// The settings these checks change, put back after them.
const KEYS = ['intellihide', 'intellihide-mode', 'autohide', 'manualhide', 'require-pressure-to-show',
    'pressure-threshold', 'animation-time', 'show-delay', 'hide-delay', 'autohide-in-fullscreen',
    'show-dock-urgent-notify', 'dock-position', 'dock-fixed'];

// Those the dock is built anew for (shell/dock/module.js).
const REBUILD_KEYS = ['dock-position', 'dock-fixed', 'autohide-in-fullscreen'];

/**
 * Change dock settings, and wait for the dock built anew if it is.
 *
 * @param {object} t
 * @param {object} values - key → value (a string, boolean, number), or
 *   null to reset it
 */
async function setDock(t, values) {
    const before = t.module.dock;
    for (const [key, value] of Object.entries(values)) {
        if (value === null)
            t.settings.reset(key);
        else if (typeof value === 'boolean')
            t.settings.set_boolean(key, value);
        else if (typeof value === 'string')
            t.settings.set_string(key, value);
        else
            t.settings.set_double(key, value);
    }
    const rebuilt = Object.keys(values).some(key => REBUILD_KEYS.includes(key));
    if (rebuilt)
        await t.waitFor(() => t.module.dock && t.module.dock !== before, 1000);
    // (Its icons come in, growing, and it is placed as they do.)
    await t.sleep(rebuilt ? 900 : 100);
}

// All the way away, or back (not on the way).
const settled = dock => !dock.container.get_transition('translation-x') &&
    !dock.container.get_transition('translation-y') && !dock.timers.has('hide');
const away = dock => dock.hidden && settled(dock);
const back = dock => !dock.hidden && settled(dock);

const windows = new Map(); // title → Gio.Subprocess

/**
 * Open a window of an app of its own (a GTK 4 script in gjs) and wait for
 * it.
 *
 * @param {object} t
 * @param {string} name - a letter: its app is org.atelier.DockTest<name>
 * @returns {Meta.Window|null}
 */
async function openWindow(t, name) {
    const {Gio} = t;
    const title = `Atelier dock test ${name}`;
    const code = `
        imports.gi.versions.Gtk = '4.0';
        const {Gio, Gtk} = imports.gi;
        const app = new Gtk.Application({application_id: 'org.atelier.DockTest${name}',
            flags: Gio.ApplicationFlags.NON_UNIQUE});
        app.connect('activate', () => new Gtk.ApplicationWindow({
            application: app, title: '${title}', default_width: 600, default_height: 300,
        }).present());
        app.run([]);`;
    windows.set(title, Gio.Subprocess.new(['gjs', '-c', code], Gio.SubprocessFlags.NONE));
    const find = () => global.get_window_actors().map(actor => actor.meta_window)
        .find(window => window?.get_title() === title) ?? null;
    await t.waitFor(() => find()?.get_compositor_private()?.mapped, 15000);
    await t.sleep(300);
    return find();
}

async function closeWindows(t) {
    windows.forEach(process => process.force_exit());
    const titles = [...windows.keys()];
    windows.clear();
    await t.waitFor(() => !global.get_window_actors().some(actor => titles.includes(actor.meta_window?.get_title())),
        5000);
}

/**
 * Move a window, and wait until it is there.
 *
 * @param {object} t
 * @param {Meta.Window} window
 * @param {object} rect - {x, y, width, height}
 */
async function moveWindow(t, window, rect) {
    window.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
    await t.waitFor(() => {
        const frame = window.get_frame_rect();
        return frame.x === rect.x && frame.y === rect.y;
    }, 2000);
}

export async function shell(t) {
    const {check} = t;
    if (!check(t.module.dock !== null, 'hiding: the dock is there'))
        return;
    try {
        await timing(t);
        await coveringWindows(t);
        await manual(t);
        await autohide(t);
        await pressure(t);
        await fullscreen(t);
    } finally {
        await closeWindows(t);
        await setDock(t, Object.fromEntries(KEYS.map(key => [key, null])));
        await t.restPointer();
        // (A window asking for attention says so in a notification.)
        t.Main.messageTray.getSources().forEach(source => [...source.notifications].forEach(n => n.destroy()));
    }
    check(await t.waitFor(() => back(t.module.dock), 2000), 'hiding: shown again, at the bottom, as it was');
}

// It moves for as long as animation-time says.
async function timing(t) {
    const {check} = t;
    const dock = t.module.dock;
    for (const time of [0.2, 0.6]) {
        await setDock(t, {'animation-time': time});
        dock.hider._slide(true);
        const duration = dock.container.get_transition('translation-y')?.get_duration();
        check(duration === time * 1000, `it moves for animation-time (${time} s: ${duration} ms)`);
        await t.waitFor(() => settled(dock), 2000);
        dock.hider._slide(false);
        await t.waitFor(() => settled(dock), 2000);
    }
    await setDock(t, {'animation-time': null});
}

// Real windows over it, in each mode.
async function coveringWindows(t) {
    const {Meta, check} = t;
    // (A new window that doesn't get the focus asks for attention.)
    await setDock(t, {'show-dock-urgent-notify': false});
    const dock = t.module.dock;
    const a = await openWindow(t, 'A');
    const b = await openWindow(t, 'B');
    if (!check(a && b, 'two windows of two apps open'))
        return;
    const rect = dock.staticRect;
    await moveWindow(t, b, {x: 40, y: 80, width: 400, height: 250});
    await moveWindow(t, a, {x: rect.x, y: rect.y - 250, width: 600, height: 300});
    const mode = async (name, focused, hidden, why) => {
        await setDock(t, {'intellihide-mode': name});
        focused.activate(global.get_current_time());
        const ok = await t.waitFor(() => (hidden ? away(dock) : back(dock)), 3000);
        await t.sleep(400);
        check(ok && dock.hidden === hidden, `${name}: ${why} → ${dock.hidden ? 'away' : 'shown'}`);
    };
    await mode('FOCUS_APPLICATION_WINDOWS', a, true, 'the focused app\'s window over it');
    await t.screenshot('65-dock-hiding-covered');
    await mode('FOCUS_APPLICATION_WINDOWS', b, false, 'another app\'s window over it');
    await mode('ALL_WINDOWS', b, true, 'another app\'s window over it');
    await mode('MAXIMIZED_WINDOWS', a, false, 'a window over it, not maximized');
    a.make_above();
    await mode('FOCUS_APPLICATION_WINDOWS', b, true, 'another app\'s window kept on top over it');
    a.unmake_above();
    a.maximize(Meta.MaximizeFlags.BOTH);
    await t.waitFor(() => a.maximized_horizontally && a.maximized_vertically, 2000);
    await mode('MAXIMIZED_WINDOWS', b, true, 'another app\'s maximized window');
    await mode('ALWAYS_ON_TOP', a, false, 'the focused app\'s maximized window');
    a.unmaximize(Meta.MaximizeFlags.BOTH);
    await moveWindow(t, a, {x: rect.x, y: rect.y - 250, width: 600, height: 300});
    a.minimize();
    await mode('ALL_WINDOWS', b, false, 'the window over it minimized');
    a.unminimize();
    await mode('ALL_WINDOWS', b, true, 'and back');
    // Out of the way of windows off, nothing covers it.
    await setDock(t, {'intellihide': false});
    check(await t.waitFor(() => back(dock), 2000), 'out of the way of windows off: shown under a window');
    await setDock(t, {'intellihide': null, 'intellihide-mode': null});

    // A window of it asking for attention brings it back for a while.
    await setDock(t, {'manualhide': true});
    await t.waitFor(() => away(dock), 2000);
    global.display.emit('window-demands-attention', a);
    await t.sleep(500);
    check(dock.hidden, 'a window asking for attention, with show-dock-urgent-notify off: it stays away');
    await setDock(t, {'show-dock-urgent-notify': null});
    global.display.emit('window-demands-attention', a);
    check(await t.waitFor(() => back(dock), 1500), 'with it on, a window asking for attention brings it back');
    check(await t.waitFor(() => away(dock), 5000), 'for a while');
    await setDock(t, {'manualhide': null});
    await closeWindows(t);
}

// Hidden until called: away until hider.reveal() or the edge, and away
// again when the pointer isn't there; on the left too.
async function manual(t) {
    const {Main, check} = t;
    await t.restPointer();
    await setDock(t, {'manualhide': true});
    let dock = t.module.dock;
    check(await t.waitFor(() => away(dock), 2000) && dock.hider.edge.visible, 'hidden until called: away, its edge waiting');
    await t.sleep(1000);
    check(dock.hidden, 'and it stays away');
    dock.hider.reveal();
    check(await t.waitFor(() => back(dock), 1000), 'called (hider.reveal()), it comes back');
    check(await t.waitFor(() => away(dock), 4000), 'and goes when the pointer isn\'t on it');

    await setDock(t, {'dock-position': 'LEFT'});
    dock = t.module.dock;
    const monitor = Main.layoutManager.monitors[dock.monitorIndex];
    const rect = dock.staticRect;
    check(await t.waitFor(() => away(dock), 2000), 'left: away');
    await t.pointerTo(monitor.x, rect.y + rect.height / 2);
    check(await t.waitFor(() => back(dock) && dock.hider.revealed, 2000), 'left: its edge brings it back');
    await t.sleep(2000);
    check(!dock.hidden && dock.hider.revealed, 'left: it stays while the pointer rests at the edge');
    await t.restPointer();
    check(await t.waitFor(() => away(dock), 4000), 'left: and goes once the pointer leaves');
    await setDock(t, {'dock-position': null, 'manualhide': null});
}

// Hiding when the pointer leaves: away with the pointer elsewhere, back at
// the edge (after the show delay), staying while the pointer is on it.
async function autohide(t) {
    const {Main, check} = t;
    const dock = t.module.dock;
    await t.restPointer();
    await setDock(t, {'autohide': true});
    await t.sleep(600);
    check(back(dock), 'hiding when the pointer leaves, out of the way of windows too: shown while none covers it');
    await setDock(t, {'intellihide': false});
    check(await t.waitFor(() => away(dock), 2000), 'only hiding when the pointer leaves: away, the pointer elsewhere');
    const monitor = Main.layoutManager.monitors[dock.monitorIndex];
    const rect = dock.staticRect;
    await setDock(t, {'show-delay': 0.8});
    await t.pointerTo(rect.x + rect.width / 2, monitor.y + monitor.height - 1);
    await t.sleep(400);
    check(dock.hidden, 'at the edge, it waits for the show delay');
    check(await t.waitFor(() => back(dock), 2000), 'then comes back');
    await t.pointerTo(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await t.sleep(2500);
    check(!dock.hidden && dock.container.hover, 'it stays while the pointer is on it');
    await t.restPointer();
    check(await t.waitFor(() => away(dock), 3000), 'and goes when the pointer leaves');
    await setDock(t, {'autohide': null, 'intellihide': null, 'show-delay': null});
    check(await t.waitFor(() => back(dock), 2000), 'out of the way of windows only: shown again');
}

// Pushing against the edge: a barrier there only while it is away; the
// pressure brings it back. Without barriers, the edge does.
async function pressure(t) {
    const {Main, Meta, check} = t;
    let dock = t.module.dock;
    await t.restPointer();
    await setDock(t, {'manualhide': true, 'require-pressure-to-show': true});
    if (!dock.hider.barriersSupported) {
        check(await t.waitFor(() => away(dock), 2000) && dock.hider.edge.visible && !dock.hider._barrier,
            'no barriers here: the edge brings it back instead');
        return;
    }
    check(await t.waitFor(() => away(dock) && dock.hider._barrier, 2000) && !dock.hider.edge.visible,
        'pushing against the edge: away, a barrier at the edge (and no strip)');
    const monitor = Main.layoutManager.monitors[dock.monitorIndex];
    const barrier = dock.hider._barrier;
    check(barrier?.y1 === monitor.y + monitor.height && barrier.y2 === barrier.y1 &&
        barrier.directions === Meta.BarrierDirection.NEGATIVE_Y,
    `along the bottom edge, letting the pointer back up (${barrier?.x1}–${barrier?.x2} at ${barrier?.y1})`);
    dock.hider._pressure.emit('trigger');
    check(await t.waitFor(() => back(dock), 1000), 'the pressure brings it back');
    check(await t.waitFor(() => !dock.hider._barrier, 1000), 'and the barrier goes once it is back');
    check(await t.waitFor(() => away(dock) && dock.hider._barrier, 5000), 'away again: the barrier again');
    Main.overview.show();
    check(await t.waitFor(() => Main.overview.visible && !dock.hider._barrier, 3000), 'none in the overview');
    Main.overview.hide();
    await t.waitFor(() => !Main.overview.visible, 3000);
    check(await t.waitFor(() => away(dock) && dock.hider._barrier, 3000), 'and there again after it');

    const old = dock.hider;
    await setDock(t, {'dock-position': 'TOP'});
    dock = t.module.dock;
    check(!old._barrier && !old._pressure, 'built anew, no barrier is left of the old dock');
    check(await t.waitFor(() => away(dock) && dock.hider._barrier, 2000) &&
        dock.hider._barrier.directions === Meta.BarrierDirection.POSITIVE_Y &&
        dock.hider._barrier.y1 === monitor.y, 'at the top: the barrier along the top edge');
    await setDock(t, {'require-pressure-to-show': null});
    check(!dock.hider._barrier && dock.hider.edge.visible, 'not pushing any more: no barrier, the edge strip');
    await setDock(t, {'dock-position': null, 'manualhide': null});
}

// In fullscreen too: the dock isn't hidden with the rest of the chrome,
// it goes as if covered (and its edge brings it back).
async function fullscreen(t) {
    const {Main, check} = t;
    await setDock(t, {'autohide-in-fullscreen': true});
    const dock = t.module.dock;
    const monitor = Main.layoutManager.monitors[dock.monitorIndex];
    try {
        Object.defineProperty(monitor, 'inFullscreen', {value: true, configurable: true});
        Main.layoutManager._updateVisibility();
        dock.hider.sync();
        check(await t.waitFor(() => away(dock), 2000) && dock.actor.visible && dock.hider.edge.visible,
            'in fullscreen too: over a window filling the screen it goes as if covered, its edge there');
    } finally {
        delete monitor.inFullscreen;
        Main.layoutManager._updateVisibility();
        dock.hider.sync();
    }
    check(await t.waitFor(() => back(dock), 2000), 'and back without it');
    await setDock(t, {'autohide-in-fullscreen': null});
}

// The page's section "Hiding".
export async function prefs(t) {
    const {page, settings, check, sleep} = t;
    const rows = page.rows;
    const keys = ['intellihide', 'intellihide-mode', 'autohide', 'manualhide', 'require-pressure-to-show',
        'pressure-threshold', 'autohide-in-fullscreen', 'show-dock-urgent-notify', 'timing', 'animation-time',
        'show-delay', 'hide-delay'];
    check(keys.every(key => rows.get(key)), `hiding: its rows (${keys.filter(key => !rows.get(key)).join(', ') || 'all'})`);
    const mode = rows.get('intellihide-mode');
    const threshold = rows.get('pressure-threshold');
    check(mode.sensitive && !threshold.sensitive, 'the mode with out of the way of windows; no pressure without pushing');
    settings.set_boolean('intellihide', false);
    settings.set_boolean('require-pressure-to-show', true);
    await sleep(50);
    check(!mode.sensitive && threshold.sensitive, 'no mode without it; the pressure when pushing');
    settings.set_boolean('dock-fixed', true);
    await sleep(50);
    check(['intellihide', 'autohide', 'manualhide', 'require-pressure-to-show', 'pressure-threshold']
        .every(key => !rows.get(key).sensitive) && rows.get('animation-time').sensitive,
    'always visible: what hides it greys out (not the timing)');

    mode.selected = 2;
    rows.get('show-delay').value = 0.5;
    await sleep(50);
    check(settings.get_string('intellihide-mode') === 'MAXIMIZED_WINDOWS' &&
        Math.abs(settings.get_double('show-delay') - 0.5) < 1e-6, 'the mode and the delay are saved');
    ['intellihide', 'require-pressure-to-show', 'dock-fixed', 'intellihide-mode', 'show-delay']
        .forEach(key => settings.reset(key));
    await picture(t);
}

// A picture of the section, its timing open (in tests/output/prefs).
async function picture(t) {
    const {window, page, Gtk, GLib, sleep} = t;
    const output = GLib.getenv('ATELIER_PREFS_OUTPUT');
    const timing = page.rows.get('timing');
    const group = timing.get_ancestor(t.Adw.PreferencesGroup);
    const scrolled = t.findDescendant(page, w => w instanceof Gtk.ScrolledWindow);
    if (!output || !scrolled || !window.get_renderer())
        return;
    timing.expanded = true;
    await sleep(400);
    const [, point] = group.compute_point(scrolled.get_child(), new Graphene.Point({x: 0, y: 0}));
    scrolled.vadjustment.value = point.y - 12;
    await sleep(400);
    const snapshot = new Gtk.Snapshot();
    new Gtk.WidgetPaintable({widget: window}).snapshot(snapshot, window.get_width(), window.get_height());
    window.get_renderer().render_texture(snapshot.to_node(), null)
        .save_to_png(GLib.build_filenamev([output, 'dock-hiding.png']));
    timing.expanded = false;
    scrolled.vadjustment.value = 0;
}
