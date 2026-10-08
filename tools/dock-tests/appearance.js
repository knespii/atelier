// The dock's checks for appearance and the import from Dash to Dock (B5):
// a fixed opacity, more opaque near a window and less away from it, the
// dock's own colour, compact and square corners, all of it over glass
// too; the preferences' rows for each mode, and Dash to Dock's settings
// brought over.
//
// shell(t) runs in tools/shell-test.js, prefs(t) in tools/run-prefs.js; t
// is described there.

// The settings these checks change, put back after them.
const KEYS = ['transparency-mode', 'background-opacity', 'customize-alphas', 'min-alpha', 'max-alpha',
    'custom-background-color', 'background-color', 'custom-theme-shrink', 'force-straight-corner'];

// The title of the window these checks open.
const TITLE = 'atelier-dock-appearance';
// A small GTK window, open until it is closed (or killed).
const WINDOW_SCRIPT = `
imports.gi.versions.Gtk = '4.0';
const {Gtk, GLib} = imports.gi;
Gtk.init();
const loop = new GLib.MainLoop(null, false);
const window = new Gtk.Window({title: '${TITLE}', default_width: 360, default_height: 240});
window.connect('close-request', () => loop.quit());
window.present();
loop.run();
`;

// The opacity of the dock's background, 0–1.
const alphaOf = dock => dock.container.get_theme_node().get_background_color().alpha / 255;
const near = (a, b) => Math.abs(a - b) < 0.01;

/**
 * Change dock settings, and wait for the dock built anew (when it is)
 * and placed.
 *
 * @param {object} t
 * @param {Gio.Settings} settings
 * @param {object} values - key → value (a string, boolean, number), or
 *   null to reset it
 */
async function set(t, settings, values) {
    const before = t.module.dock;
    let rebuilt = false;
    for (const [key, value] of Object.entries(values)) {
        if (value === null)
            settings.reset(key);
        else if (typeof value === 'boolean')
            settings.set_boolean(key, value);
        else if (typeof value === 'string')
            settings.set_string(key, value);
        else
            settings.set_double(key, value);
        rebuilt ||= key === 'surface';
    }
    if (rebuilt)
        await t.waitFor(() => t.module.dock && t.module.dock !== before, 1000);
    await t.sleep(rebuilt ? 900 : 400);
}

/**
 * Open the test window.
 *
 * @param {object} t
 * @returns {Promise<object|null>} {window (a Meta.Window), process}
 */
async function openWindow(t) {
    const {Gio} = t;
    const process = Gio.Subprocess.new(['gjs', '-c', WINDOW_SCRIPT], Gio.SubprocessFlags.NONE);
    let window = null;
    await t.waitFor(() => {
        window = global.get_window_actors().map(actor => actor.meta_window)
            .find(w => w.get_title() === TITLE) ?? null;
        return window !== null;
    }, 8000);
    if (!window) {
        process.force_exit();
        return null;
    }
    // (Shown, and placed by the shell: a move before then is undone.)
    await t.waitFor(() => window.get_compositor_private()?.mapped && window.get_frame_rect().width > 0, 3000);
    await t.sleep(500);
    return {window, process};
}

async function closeWindow(t, opened) {
    if (!opened)
        return;
    opened.process.force_exit();
    await t.waitFor(() => !global.get_window_actors().some(actor => actor.meta_window.get_title() === TITLE), 3000);
}

export async function shell(t) {
    const {check} = t;
    const settings = t.settings;
    const bar = t.ext.stateObj._settings.get_child('bar');
    let opened = null;
    try {
        await t.restPointer();
        let dock = t.module.dock;
        check(dock.container.get_style() === null && near(alphaOf(dock), 0.82) &&
            !dock.container.has_style_class_name('atelier-dock-shrink') &&
            !dock.container.has_style_class_name('atelier-dock-straight'),
        `as the profile: no style of its own, the stylesheet's dark (${alphaOf(dock).toFixed(2)})`);

        // A fixed opacity, in the dock's dark or a colour of its own.
        await set(t, settings, {'transparency-mode': 'FIXED', 'background-opacity': 0.3});
        const color = dock.container.get_theme_node().get_background_color();
        check(near(alphaOf(dock), 0.3) && color.red === 18 && color.green === 18 && color.blue === 22,
            `fixed at 30%: the dock's dark, 0.3 (${alphaOf(dock).toFixed(2)})`);
        await set(t, settings, {'custom-background-color': true, 'background-color': '#3366ff'});
        const own = dock.container.get_theme_node().get_background_color();
        check(own.red === 0x33 && own.green === 0x66 && own.blue === 0xff && near(alphaOf(dock), 0.3),
            'its own colour, at that opacity');
        await set(t, settings, {'custom-background-color': null, 'background-color': null});

        // More opaque while a window is near it.
        await set(t, settings, {'transparency-mode': 'DYNAMIC'});
        check(!dock.theming.near && near(alphaOf(dock), 0.2) &&
            dock.container.has_style_class_name('atelier-dock-dynamic'),
        `more opaque near windows: with none near, 0.2 (${alphaOf(dock).toFixed(2)})`);
        opened = await openWindow(t);
        if (check(opened !== null, 'a test window opens')) {
            const rect = dock.staticRect;
            const frame = opened.window.get_frame_rect();
            opened.window.move_frame(true, rect.x, rect.y - frame.height + 20);
            check(await t.waitFor(() => dock.theming.near && near(alphaOf(dock), 0.8), 2000),
                `a window over it: 0.8 (${alphaOf(dock).toFixed(2)}, the window at ` +
                `${opened.window.get_frame_rect().y}–${opened.window.get_frame_rect().y + frame.height}, the dock at ${rect.y})`);
            opened.window.move_frame(true, rect.x, 100);
            check(await t.waitFor(() => !dock.theming.near && near(alphaOf(dock), 0.2), 2000),
                `away again: 0.2 (${alphaOf(dock).toFixed(2)})`);
            await set(t, settings, {'customize-alphas': true, 'min-alpha': 0.1, 'max-alpha': 0.9});
            check(near(alphaOf(dock), 0.1), `the user's opacity away (${alphaOf(dock).toFixed(2)})`);
            opened.window.move_frame(true, rect.x, rect.y - frame.height + 20);
            check(await t.waitFor(() => near(alphaOf(dock), 0.9), 2000),
                `and near (${alphaOf(dock).toFixed(2)})`);
            await closeWindow(t, opened);
            opened = null;
            check(await t.waitFor(() => near(alphaOf(dock), 0.1), 2000), 'the window gone, it is as away again');
        }

        // Compact, square corners.
        await set(t, settings, {'transparency-mode': null, 'customize-alphas': null, 'min-alpha': null,
            'max-alpha': null});
        check(dock.container.get_style() === null && near(alphaOf(dock), 0.82) &&
            !dock.container.has_style_class_name('atelier-dock-dynamic'),
        'as the profile again: no style of its own');
        const height = dock.staticRect.height;
        await set(t, settings, {'custom-theme-shrink': true});
        const node = dock.container.get_theme_node();
        check(dock.container.has_style_class_name('atelier-dock-shrink') &&
            node.get_padding(t.St.Side.TOP) < 6 && dock.staticRect.height < height,
        `compact: less room around the icons, a thinner dock (${height} → ${dock.staticRect.height})`);
        await set(t, settings, {'force-straight-corner': true});
        check(dock.container.has_style_class_name('atelier-dock-straight') &&
            dock.container.get_theme_node().get_border_radius(t.St.Corner.TOPLEFT) === 0,
        'square corners');
        await t.screenshotArea('68-dock-compact-square', 0, global.stage.height - 120, global.stage.width, 120);
        await set(t, settings, {'custom-theme-shrink': null, 'force-straight-corner': null});
        check(!dock.container.has_style_class_name('atelier-dock-shrink') &&
            !dock.container.has_style_class_name('atelier-dock-straight') && dock.staticRect.height === height,
        'and back');

        // Over glass: clear as the profile has it, a wash on the blur
        // otherwise; the glass itself stays.
        await set(t, bar, {'surface': 'glass'});
        dock = t.module.dock;
        check(dock._glass && dock.container.has_style_class_name('atelier-dock-glassy') &&
            dock.container.get_style() === null && alphaOf(dock) === 0,
        'over glass, as the profile: clear, no style of its own');
        await set(t, settings, {'transparency-mode': 'FIXED', 'background-opacity': 0.3});
        check(near(alphaOf(dock), 0.3) && dock._glass.visible && dock._glass.opacity === 255,
            `over glass, fixed at 30%: a wash of 0.3 on the glass, which stays (${alphaOf(dock).toFixed(2)})`);
        await t.screenshotArea('69-dock-glass-fixed', 0, global.stage.height - 120, global.stage.width, 120);
        await set(t, settings, {'transparency-mode': 'DYNAMIC', 'background-opacity': null});
        check(near(alphaOf(dock), 0.2), `over glass, more opaque near windows: 0.2 away (${alphaOf(dock).toFixed(2)})`);
        await set(t, settings, {'force-straight-corner': true});
        check(await t.waitFor(() => dock._glass._shape?.[4] === 0, 1000),
            `square corners over glass, the glass's too (${dock._glass._shape?.[4]})`);
    } finally {
        await closeWindow(t, opened);
        await set(t, settings, Object.fromEntries(KEYS.map(key => [key, null])));
        await set(t, bar, {'surface': null});
    }
    const dock = t.module.dock;
    check(dock && !dock._glass && dock.container.get_style() === null && near(alphaOf(dock), 0.82),
        'as it was');
}

export async function prefs(t) {
    void t;
}
