// The dock's checks for clicking, scrolling and the keyboard (B2): with
// windows of a small test app, a click minimizes its one window or spreads
// out its two (the overview with only them, as it was afterwards); quit
// closes them; scrolling goes through them or switches workspaces; Super+
// number takes GNOME's Super+number shortcuts while it is on and gives them
// back; the dock's shortcut numbers the apps for a while. In the
// preferences: the actions saved as they are picked, and the warning for a
// shortcut that is taken.
//
// shell(t) runs in tools/shell-test.js, prefs(t) in tools/run-prefs.js; t
// is described there.

// The settings these checks change, put back after them.
const KEYS = ['click-action', 'scroll-action', 'scroll-switch-workspace', 'hot-keys', 'hotkeys-overlay',
    'hotkeys-show-dock', 'shortcut-timeout', 'shortcut', 'magnification'];

const APP_ID = 'org.atelier.DockTest';
const OTHER_ID = 'org.atelier.DockOther';

// A GTK window with a title, of an app with an id (each one its own
// process, so that they can be told apart and closed).
const WINDOW_SCRIPT = `
imports.gi.versions.Gtk = '4.0';
const {Gio, Gtk} = imports.gi;
const [id, title] = ARGV;
const app = new Gtk.Application({application_id: id, flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    new Gtk.ApplicationWindow({application: app, title, default_width: 360, default_height: 240}).present();
});
app.run([]);
`;

// Opens test windows and closes every one of them in the end.
class TestWindows {
    constructor(t) {
        this._t = t;
        this._procs = [];
        const {Gio, GLib} = t;
        this._script = GLib.build_filenamev([t.OUTPUT, 'dock-test-window.js']);
        GLib.file_set_contents(this._script, WINDOW_SCRIPT);
        // The app the windows belong to, by its id.
        this._desktop = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'applications',
            `${APP_ID}.desktop`]));
        GLib.mkdir_with_parents(this._desktop.get_parent().get_path(), 0o755);
        GLib.file_set_contents(this._desktop.get_path(),
            `[Desktop Entry]\nType=Application\nName=Dock Test\nExec=gjs ${this._script} ${APP_ID} Test\n` +
            'Icon=application-x-executable\n');
    }

    /** @returns {Promise<Shell.App|null>} the test app, once the shell knows it */
    async app() {
        const system = this._t.Shell.AppSystem.get_default();
        const start = Date.now();
        await this._t.waitFor(() => system.lookup_app(`${APP_ID}.desktop`), 20000);
        this.waited = Date.now() - start;
        return system.lookup_app(`${APP_ID}.desktop`);
    }

    /**
     * @param {string} title
     * @param {string} [id]
     * @returns {Promise<Meta.Window|null>} its window, once it is there
     */
    async open(title, id = APP_ID) {
        const {Gio} = this._t;
        const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
        for (const [name, value] of [['GDK_BACKEND', 'wayland'], ['GSK_RENDERER', 'cairo'], ['NO_AT_BRIDGE', '1'],
            ['GTK_A11Y', 'none']])
            launcher.setenv(name, value, true);
        launcher.unsetenv('DISPLAY');
        this._procs.push(launcher.spawnv(['gjs', this._script, id, title]));
        const find = () => global.display.list_all_windows().find(window => window.title === title) ?? null;
        await this._t.waitFor(() => find()?.get_compositor_private()?.mapped, 10000);
        return find();
    }

    async closeAll() {
        this._procs.forEach(proc => proc.force_exit());
        this._procs = [];
        await this._t.waitFor(() => !global.display.list_all_windows().some(window =>
            [APP_ID, OTHER_ID].includes(window.get_gtk_application_id())), 5000);
        try {
            this._desktop.delete(null);
        } catch {
            // (Gone already.)
        }
    }
}

async function focus(t, window) {
    t.Main.activateWindow(window);
    return t.waitFor(() => global.display.focus_window === window, 2000);
}

// A scroll down (or up) as the dock gets it.
function scroll(t, down) {
    const {Clutter} = t;
    return {
        get_scroll_direction: () => (down ? Clutter.ScrollDirection.DOWN : Clutter.ScrollDirection.UP),
        get_scroll_delta: () => [0, down ? 1 : -1],
    };
}

// The windows the overview shows.
async function overviewWindows(t) {
    const {WindowPreview} = await import('resource:///org/gnome/shell/ui/windowPreview.js');
    const found = [];
    const walk = actor => {
        for (const child of actor.get_children()) {
            if (child instanceof WindowPreview)
                found.push(child.metaWindow);
            walk(child);
        }
    };
    walk(t.Main.layoutManager.overviewGroup);
    return found;
}

async function showOverview(t) {
    t.Main.overview.show();
    await t.waitFor(() => t.Main.overview.visible && !t.Main.overview.animationInProgress, 3000);
    await t.sleep(300);
}

async function hideOverview(t) {
    t.Main.overview.hide();
    await t.waitFor(() => !t.Main.overview.visible && !t.Main.overview.animationInProgress, 3000);
    await t.sleep(200);
}

export async function shell(t) {
    const windows = new TestWindows(t);
    try {
        await clicks(t, windows);
        await keyboard(t);
    } finally {
        if (t.Main.overview.visible)
            await hideOverview(t);
        await windows.closeAll();
        KEYS.forEach(key => t.settings.reset(key));
        global.workspace_manager.get_workspace_by_index(0)?.activate(global.get_current_time());
        // (Windows coming up in the background said so in the island.)
        t.Main.messageTray.getSources().forEach(source => [...source.notifications].forEach(n => n.destroy()));
        await t.sleep(300);
    }
}

async function clicks(t, windows) {
    const {Main, check, settings} = t;
    const app = await windows.app();
    if (!check(app !== null, `the test app is known to the shell (after ${windows.waited} ms)`))
        return;
    const first = await windows.open('Dock Test 1');
    const other = await windows.open('Dock Other', OTHER_ID);
    if (!check(first && other && t.Shell.WindowTracker.get_default().get_window_app(first) === app,
        'a test window, of the test app'))
        return;
    const itemOf = () => t.module.dock.items.get(app.get_id());
    check(await t.waitFor(() => itemOf()?.icon.windows.length === 1, 3000), 'the app is in the dock, running');

    // A click on the app focused with one window minimizes it; with two,
    // it spreads them out alone in the overview.
    settings.set_string('click-action', 'focus-minimize-or-appspread');
    await focus(t, first);
    itemOf().icon.activate(1);
    check(await t.waitFor(() => first.minimized, 2000), 'focus-minimize-or-appspread, one window: minimized');
    // (Once it has gone down.)
    await t.sleep(600);
    itemOf().icon.activate(1);
    check(await t.waitFor(() => !first.minimized && global.display.focus_window === first, 2000),
        'and brought up again');

    const second = await windows.open('Dock Test 2');
    await focus(t, second);
    const {Workspace} = await import('resource:///org/gnome/shell/ui/workspace.js');
    const original = Workspace.prototype._isOverviewWindow;
    const spread = t.module.services.spread;
    check(spread.supported, 'the shell lets the app\'s windows be spread out');
    itemOf().icon.activate(1);
    check(await t.waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 3000) &&
        spread.app === app, 'two windows: spread out in the overview');
    await t.sleep(300);
    let shown = await overviewWindows(t);
    check(shown.length === 2 && shown.includes(first) && shown.includes(second),
        `only the app's windows (${shown.map(w => w.title).join(', ')})`);
    await t.screenshot('61-dock-app-spread');
    await hideOverview(t);
    check(spread.app === null && Workspace.prototype._isOverviewWindow === original,
        'put back as the overview goes');
    await showOverview(t);
    shown = await overviewWindows(t);
    check(shown.includes(other) && shown.length === 3, `then the overview has every window (${shown.length})`);
    await hideOverview(t);

    // Scrolling on the app goes through its windows, a while apart.
    settings.set_string('scroll-action', 'cycle-windows');
    await focus(t, second);
    const icon = itemOf().icon;
    icon.vfunc_scroll_event(scroll(t, true));
    check(await t.waitFor(() => global.display.focus_window === first, 1000), 'scrolling on the app: its next window');
    icon.vfunc_scroll_event(scroll(t, true));
    await t.sleep(100);
    check(global.display.focus_window === first, 'not at once again');
    await t.sleep(400);
    icon.vfunc_scroll_event(scroll(t, false));
    check(await t.waitFor(() => global.display.focus_window === second, 1000), 'scrolling up: back');

    // Or switches workspaces; so does scrolling on the dock between apps.
    const manager = global.workspace_manager;
    if (check(manager.n_workspaces >= 2, `a workspace after this one (${manager.n_workspaces})`)) {
        settings.set_string('scroll-action', 'switch-workspace');
        await t.sleep(400);
        // (On the test app, which is in the dock only where its windows are,
        // then on the first pinned app.)
        icon.vfunc_scroll_event(scroll(t, true));
        check(await t.waitFor(() => manager.get_active_workspace_index() === 1, 2000),
            'switch-workspace: scrolling down, the next workspace');
        await t.sleep(400);
        t.module.dock.orderedItems[0].icon.vfunc_scroll_event(scroll(t, false));
        check(await t.waitFor(() => manager.get_active_workspace_index() === 0, 2000), 'up, back');
        await t.sleep(400);

        settings.set_string('scroll-action', 'do-nothing');
        // (Between apps where they are at rest: not magnified into it.)
        settings.set_boolean('magnification', false);
        const {scrollDock} = await import('../../shell/dock/actions.js');
        const dock = t.module.dock;
        dock.force(true);
        await t.sleep(400);
        // (Its item came anew with its windows on this workspace.)
        const item = itemOf();
        await t.pointerTo(...t.centerOf(item));
        const onApp = item.icon.vfunc_scroll_event(scroll(t, true));
        const onDock = scrollDock(dock, scroll(t, true));
        check(onApp === t.Clutter.EVENT_PROPAGATE && onDock === t.Clutter.EVENT_PROPAGATE &&
            manager.get_active_workspace_index() === 0, 'do-nothing: on an app, scrolling does nothing');
        const [x, y] = dock.container.get_transformed_position();
        await t.pointerTo(x + 3, y + dock.container.height / 2);
        scrollDock(dock, scroll(t, true));
        check(await t.waitFor(() => manager.get_active_workspace_index() === 1, 2000),
            'scrolling on the dock between apps: the next workspace');
        await t.sleep(400);
        settings.set_boolean('scroll-switch-workspace', false);
        check(scrollDock(dock, scroll(t, false)) === t.Clutter.EVENT_PROPAGATE &&
            manager.get_active_workspace_index() === 1, 'not with scroll-switch-workspace off');
        dock.force(false);
        manager.get_workspace_by_index(0).activate(global.get_current_time());
        await t.waitFor(() => manager.get_active_workspace_index() === 0, 2000);
        await t.restPointer();
    }

    // Super+number opens an app as a click does (going on to its next
    // window here).
    settings.reset('click-action');
    await focus(t, second);
    const index = t.module.dock.orderedItems.indexOf(itemOf());
    t.module.services.hotkeys.activate(index);
    check(await t.waitFor(() => global.display.focus_window === first, 1000),
        `its Super+number goes on to its next window (app ${index + 1})`);

    // Quit closes its windows (not the other app's).
    settings.set_string('click-action', 'quit');
    itemOf().icon.activate(1);
    check(await t.waitFor(() => app.get_windows().length === 0, 5000) &&
        global.display.list_all_windows().includes(other), 'quit closes the app\'s windows, only those');
    settings.reset('click-action');
}

async function keyboard(t) {
    const {Main, Shell, Clutter, check, settings} = t;
    const allowed = name => Main.wm._allowedKeybindings[name];
    const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
    check(allowed('switch-to-application-1') === modes && allowed('open-new-window-application-9') === modes,
        'GNOME\'s Super+number shortcuts to begin with');

    settings.set_double('shortcut-timeout', 1);
    settings.set_boolean('hot-keys', true);
    check(allowed('switch-to-application-1') === Shell.ActionMode.NONE &&
        allowed('open-new-window-application-9') === Shell.ActionMode.NONE,
    'Super+number on: GNOME\'s are off');
    check(allowed('app-hotkey-1') === modes && allowed('app-ctrl-hotkey-10') === modes && allowed('shortcut') === modes,
        'the dock\'s are on, and its shortcut');

    // The shortcut numbers the apps for a while, and shows the dock.
    const hotkeys = t.module.services.hotkeys;
    const numbers = () => t.module.dock.orderedItems.map(item => item.icon._number)
        .filter(label => label?.get_parent());
    await t.pressKeys(Clutter.KEY_Super_L, Clutter.KEY_q);
    check(await t.waitFor(() => numbers().length > 0, 2000), `Super+Q numbers the apps (${numbers().length})`);
    const labels = numbers();
    check(labels[0]?.text === '1' && labels[0].has_style_class_name('atelier-dock-number') &&
        labels.length === Math.min(10, t.module.dock.orderedItems.length), 'from 1, at most 10');
    check(hotkeys._forced.has(t.module.dock), 'and keeps the dock shown');
    await t.screenshotArea('62-dock-numbers', 0, global.stage.height - 140, global.stage.width, 140);
    if (Main.overview.visible)
        await hideOverview(t);
    check(await t.waitFor(() => numbers().length === 0, 2500) && hotkeys._forced.size === 0,
        'they go after the timeout, and the dock is free to go');

    settings.set_boolean('hot-keys', false);
    check(allowed('switch-to-application-1') === modes && allowed('open-new-window-application-9') === modes,
        'Super+number off: GNOME\'s are back');
    check(allowed('app-hotkey-1') === Shell.ActionMode.NONE && allowed('shortcut') === Shell.ActionMode.NONE,
        'and the dock\'s gone');
}

export async function prefs(t) {
    const {page, settings, check, sleep} = t;
    const rows = page.rows;
    const combo = rows.get('click-action');
    const last = combo.model.get_n_items() - 1;
    combo.selected = last;
    await sleep(50);
    check(settings.get_string('click-action') === 'quit', `the click action is saved (${settings.get_string('click-action')})`);
    settings.set_string('click-action', 'focus-minimize-or-appspread');
    await sleep(50);
    check(combo.selected === 8, 'and shown when it changes');
    rows.get('shift-middle-click-action').selected = 5;
    rows.get('scroll-action').selected = 2;
    await sleep(50);
    check(settings.get_string('shift-middle-click-action') === 'appspread' &&
        settings.get_string('scroll-action') === 'switch-workspace', 'so are the others and scrolling');
    ['click-action', 'shift-middle-click-action', 'scroll-action'].forEach(key => settings.reset(key));

    const shortcut = rows.get('shortcut');
    check(!shortcut.sensitive, 'the shortcut is greyed out while Super+number is off');
    settings.set_boolean('hot-keys', true);
    await sleep(50);
    check(shortcut.sensitive && !shortcut.warning.visible, 'and there with it on, Super+Q not taken');
    // Super+S is GNOME's (the quick settings).
    settings.set_strv('shortcut', ['<Super>s']);
    await sleep(50);
    check(shortcut.warning.visible && shortcut.warning.subtitle.startsWith('GNOME: '),
        `a shortcut GNOME has is taken (${shortcut.warning.subtitle})`);
    // Super+W opens Atelier's switcher.
    settings.set_strv('shortcut', ['<Super>w']);
    await sleep(50);
    check(shortcut.warning.visible && shortcut.warning.subtitle.includes('Atelier: atelier-open-switcher'),
        `so is one Atelier has (${shortcut.warning.subtitle})`);
    settings.reset('shortcut');
    await sleep(50);
    check(!shortcut.warning.visible, 'the warning goes with the shortcut');
    settings.reset('hot-keys');
}
