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
    'custom-background-color', 'background-color', 'custom-theme-shrink', 'force-straight-corner', 'intellihide'];

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

// Another, all magenta: a colour the dock's glass would show at once if it
// read the window (it never does).
const MAGENTA_TITLE = 'atelier-dock-plain-glass';
const MAGENTA = [255, 0, 255];
const MAGENTA_SCRIPT = `
imports.gi.versions.Gtk = '4.0';
imports.cairo;
const {Gtk, GLib} = imports.gi;
Gtk.init();
const loop = new GLib.MainLoop(null, false);
const window = new Gtk.Window({title: '${MAGENTA_TITLE}', default_width: 420, default_height: 240});
const area = new Gtk.DrawingArea({hexpand: true, vexpand: true});
area.set_draw_func((_, cr) => {
    cr.setSourceRGB(1, 0, 1);
    cr.paint();
});
window.set_child(area);
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
 * Open a test window.
 *
 * @param {object} t
 * @param {string} [title] - its title, as its script has it
 * @param {string} [script] - the GJS that shows it
 * @returns {Promise<object|null>} {window (a Meta.Window), process, title}
 */
async function openWindow(t, title = TITLE, script = WINDOW_SCRIPT) {
    const {Gio} = t;
    const process = Gio.Subprocess.new(['gjs', '-c', script], Gio.SubprocessFlags.NONE);
    let window = null;
    await t.waitFor(() => {
        window = global.get_window_actors().map(actor => actor.meta_window)
            .find(w => w.get_title() === title) ?? null;
        return window !== null;
    }, 8000);
    if (!window) {
        process.force_exit();
        return null;
    }
    // (Shown, and placed by the shell: a move before then is undone.)
    await t.waitFor(() => window.get_compositor_private()?.mapped && window.get_frame_rect().width > 0, 3000);
    await t.sleep(500);
    return {window, process, title};
}

async function closeWindow(t, opened) {
    if (!opened)
        return;
    const gone = () => !global.get_window_actors().some(actor => actor.meta_window.get_title() === opened.title);
    // (Asked to close first; killed only if it doesn't.)
    opened.window.delete(global.get_current_time());
    if (!await t.waitFor(gone, 3000))
        opened.process.force_exit();
    await t.waitFor(gone, 3000);
}

/**
 * The dock's glass near a window: over a neutral grey, not the wallpaper
 * where it rests (which cast its colour on it over windows), eased in;
 * nothing of the window in it (a magenta one); in the overview none is
 * near; away from windows, the wallpaper's glass again. Over GNOME's amber,
 * a wallpaper with colour in it.
 *
 * @param {object} t
 * @param {Dock} dock - of glass, as the profile has it
 */
async function plainGlass(t, dock) {
    const {check, Main} = t;
    const glass = dock._glass;
    const scope = isNear => dock._vibrant?.[isNear ? 1 : 0]?.scope ?? '-';
    const background = new t.Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const uris = ['picture-uri', 'picture-uri-dark'].map(key => [key, background.get_string(key)]);
    const amber = t.Gio.File.new_for_path('/usr/share/backgrounds/gnome/amber-d.jxl').get_uri();
    // (Beside the first icon, half way up: in the shape, not on an icon,
    // in from its rim.)
    const glassColor = async name => {
        const [x, y] = dock.container.get_transformed_position();
        await t.screenshot(name);
        return t.averageColor(name, Math.round(x) + 6, Math.round(y + dock.container.height / 2) - 3, 3, 6);
    };
    const chroma = rgb => Math.max(...rgb) - Math.min(...rgb);
    const shown = rgb => rgb.map(Math.round).join(', ');
    const shot = name => {
        const rect = dock.staticRect;
        return t.screenshotArea(name, Math.max(0, rect.x - 80), Math.max(0, rect.y - 60),
            Math.min(global.stage.width, rect.width + 160), Math.min(global.stage.height - rect.y + 60, rect.height + 120));
    };
    const plainAll = () => glass._plain?.opacity === 255 && !glass._plain.get_transition('opacity');
    const grey = dock._nearColor();
    let opened = null;
    uris.forEach(([key]) => background.set_string(key, amber));
    await set(t, t.settings, {'intellihide': false});
    try {
        await t.sleep(1500);
        const away = await glassColor('69a-dock-glass-away');
        check(!dock.theming.near && glass.plain === null && glass._wallpaper.visible &&
            t.hasClass(dock.container, scope(false)) && chroma(away) > 6,
        `away from windows, its glass is of the wallpaper (${shown(away)})`);
        opened = await openWindow(t, MAGENTA_TITLE, MAGENTA_SCRIPT);
        if (!check(opened !== null, 'a magenta window opens'))
            return;
        const rect = dock.staticRect;
        const frame = opened.window.get_frame_rect();
        opened.window.move_frame(true, rect.x - 40, rect.y + rect.height - frame.height);
        check(await t.waitFor(() => dock.theming.near && glass.plain === grey &&
            t.hasClass(dock.container, scope(true)), 2000),
        `a window behind it: its glass over a neutral grey (${glass.plain}, of ${grey}), its type as over windows`);
        check(/^#([0-9a-f]{2})\1\1$/.test(grey), `the grey is grey (${grey})`);
        check(await t.waitFor(() => glass._plain && glass._plain.opacity > 0 && glass._plain.opacity < 255, 400),
            `eased in, not at once (${glass._plain?.opacity})`);
        check(await t.waitFor(plainAll, 1000) && !glass._wallpaper.visible,
            'then all there, the wallpaper under it not drawn');
        await t.sleep(200);
        const over = await glassColor('69b-dock-glass-near');
        await shot('69c-dock-over-window-after');
        check(chroma(over) <= 6, `neutral over the window: no colour of the wallpaper nor of the window (${shown(over)})`);
        // (What it was: the wallpaper's glass over the window.)
        glass.setPlain(null);
        await t.waitFor(() => glass._plain?.opacity === 0 && !glass._plain.get_transition('opacity'), 1000);
        await t.sleep(200);
        const before = await glassColor('69d-dock-glass-wallpaper-over-window');
        await shot('69e-dock-over-window-before');
        check(chroma(before) > 6, `the wallpaper's glass there would cast its colour (${shown(before)})`);
        dock.syncNear();
        check(await t.waitFor(() => glass.plain === grey && plainAll(), 1000), 'over the grey again');
        Main.overview.show();
        check(await t.waitFor(() => Main.overview.visible && !dock.theming.near && glass.plain === null, 3000),
            'in the overview, the wallpaper\'s glass: no window is near there');
        Main.overview.hide();
        check(await t.waitFor(() => !Main.overview.visible && glass.plain === grey, 3000), 'back from it, the grey again');
        opened.window.move_frame(true, rect.x, 100);
        check(await t.waitFor(() => !dock.theming.near && glass.plain === null &&
            t.hasClass(dock.container, scope(false)), 2000), 'the window away from it: of the wallpaper again');
        check(await t.waitFor(() => glass._plain.opacity === 0 && glass._wallpaper.visible, 1000),
            'the grey eased out, the wallpaper drawn again');
        await t.sleep(200);
        const back = await glassColor('69f-dock-glass-away-again');
        check(chroma(back) > 6 && Math.abs(chroma(back) - chroma(away)) < 12,
            `as it was away from windows (${shown(back)}; ${shown(away)} before)`);
    } finally {
        await closeWindow(t, opened);
        await set(t, t.settings, {'intellihide': null});
        uris.forEach(([key, uri]) => background.set_string(key, uri));
        await t.sleep(500);
    }
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

        // Over glass: clear as the profile has it; otherwise the opacity
        // is shared – below 40 % the glass itself fades, above it a wash
        // comes in on it.
        await set(t, bar, {'surface': 'glass'});
        dock = t.module.dock;
        check(dock._glass && dock.container.has_style_class_name('atelier-dock-glassy') &&
            dock.container.get_style() === null && alphaOf(dock) === 0,
        'over glass, as the profile: clear, no style of its own');
        await plainGlass(t, dock);
        await set(t, settings, {'transparency-mode': 'FIXED', 'background-opacity': 0.2});
        check(await t.waitFor(() => alphaOf(dock) === 0 && Math.abs(dock._glass.opacity - 128) <= 2, 2000),
            `over glass, fixed at 20%: no wash, half the glass (${dock._glass.opacity})`);
        await set(t, settings, {'background-opacity': 0});
        check(await t.waitFor(() => dock._glass.opacity === 0, 2000), 'at nothing: clear, no glass either');
        await set(t, settings, {'background-opacity': 0.7});
        check(await t.waitFor(() => near(alphaOf(dock), 0.5) && dock._glass.opacity === 255, 2000),
            `fixed at 70%: all the glass and a wash of half the colour on it (${alphaOf(dock).toFixed(2)})`);
        await t.screenshotArea('69-dock-glass-fixed', 0, global.stage.height - 120, global.stage.width, 120);
        await set(t, settings, {'transparency-mode': 'DYNAMIC', 'background-opacity': null});
        check(await t.waitFor(() => alphaOf(dock) === 0 && Math.abs(dock._glass.opacity - 128) <= 2, 2000),
            `over glass, more opaque near windows: half the glass away from them (${dock._glass.opacity})`);
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
    const {page, settings, check, sleep, Adw, Gio, GLib} = t;
    const rows = page.rows;

    // The opacities of the mode chosen, a colour with either opacity.
    const shown = keys => keys.filter(key => rows.get(key)?.visible);
    const OPACITIES = ['background-opacity', 'customize-alphas', 'min-alpha', 'max-alpha', 'custom-background-color',
        'background-color'];
    const waiting = () => shown(OPACITIES).join() === 'background-opacity' && !rows.get('background-opacity').sensitive;
    check(waiting(), 'as the profile: no colour, the opacity there but waiting for Fixed');
    rows.get('transparency-mode').selected = 1;
    await sleep(50);
    check(settings.get_string('transparency-mode') === 'FIXED' &&
        shown(OPACITIES).join() === 'background-opacity,custom-background-color,background-color',
    `fixed: its opacity and the colour (${shown(OPACITIES).join(', ')})`);
    rows.get('background-opacity').value = 30;
    await sleep(50);
    check(Math.abs(settings.get_double('background-opacity') - 0.3) < 0.001, 'the opacity in percent');
    settings.set_string('transparency-mode', 'DYNAMIC');
    await sleep(50);
    check(shown(OPACITIES).join() ===
        'customize-alphas,min-alpha,max-alpha,custom-background-color,background-color',
    `more opaque near windows: the two opacities and the colour (${shown(OPACITIES).join(', ')})`);
    check(!rows.get('min-alpha').sensitive && !rows.get('background-color').sensitive,
        'greyed out until they are the user\'s own');
    rows.get('customize-alphas').active = true;
    rows.get('custom-background-color').active = true;
    check(rows.get('max-alpha').sensitive && rows.get('background-color').sensitive, 'and then not');
    for (const key of ['custom-theme-shrink', 'force-straight-corner']) {
        rows.get(key).active = true;
        check(settings.get_boolean(key), `${key} is saved`);
    }
    KEYS.forEach(key => settings.reset(key));
    await sleep(50);
    check(waiting() && rows.get('transparency-mode').selected === 0, 'and back as the profile');

    // Dash to Dock's settings, from its installed schema (in memory here,
    // as all of the preferences' settings), brought over.
    const row = t.findDescendant(page, w => w instanceof Adw.ActionRow && w.title === 'Import from Dash to Dock…');
    // (check() says nothing back here.)
    check(row !== null, 'the status has a row that imports Dash to Dock\'s settings');
    if (!row)
        return;
    // (The user's Dash to Dock, or the system's Ubuntu Dock: Ubuntu
    // installs its schema with the system's.)
    const SCHEMA_ID = 'org.gnome.shell.extensions.dash-to-dock';
    const dir = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share', 'gnome-shell', 'extensions',
        'dash-to-dock@micxgx.gmail.com', 'schemas']);
    const schema = GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS)
        ? Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false)
            .lookup(SCHEMA_ID, false)
        : Gio.SettingsSchemaSource.get_default().lookup(SCHEMA_ID, true);
    if (!schema) {
        print(`SKIP  neither Dash to Dock (in ${dir}) nor Ubuntu Dock is installed`);
        return;
    }
    const dashToDock = new Gio.Settings({settings_schema: schema});
    // Where Ubuntu Dock is installed and Dash to Dock isn't (Ubuntu), its
    // settings are what comes over, and are named so.
    const installed = uuid => [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()].some(dataDir =>
        GLib.file_test(GLib.build_filenamev([dataDir, 'gnome-shell', 'extensions', uuid, 'metadata.json']),
            GLib.FileTest.EXISTS));
    if (installed('ubuntu-dock@ubuntu.com') && !installed('dash-to-dock@micxgx.gmail.com')) {
        // (Only here: the shell's checks import this file too.)
        const {findSchema, sourceName: nameOf} = await import('../../prefs/dock/import.js');
        check(findSchema() !== null && nameOf() === 'Ubuntu Dock', 'Ubuntu Dock\'s settings are found, as its');
    }
    const openSource = row.openSource;
    const sourceName = row.sourceName;
    row.openSource = () => null;
    row.syncSource();
    check(!row.sensitive && row.subtitle.includes('isn\'t installed'), 'without Dash to Dock it greys out, and says why');
    row.openSource = () => dashToDock;
    row.sourceName = () => 'Dash to Dock';
    row.syncSource();
    check(row.sensitive && row.subtitle.startsWith('Its position'), 'with it, it can be pressed');
    row.sourceName = () => 'Ubuntu Dock';
    row.syncSource();
    check(row.sensitive && row.subtitle.startsWith('Ubuntu Dock\'s, which are Dash to Dock\'s'),
        'with Ubuntu Dock\'s, it says they are Ubuntu Dock\'s');
    row.sourceName = sourceName;

    dashToDock.set_enum('dock-position', 3); // LEFT
    dashToDock.set_string('click-action', 'focus-minimize-or-previews');
    dashToDock.set_double('pressure-threshold', 40);
    dashToDock.set_int('dash-max-icon-size', 40);
    settings.set_boolean('enabled', false);
    row.emit('activated');
    await sleep(300);
    const dialog = t.window.visible_dialog;
    check(dialog instanceof Adw.AlertDialog, 'it asks first');
    check(settings.get_string('dock-position') === 'BOTTOM', 'and nothing changes until it is answered');
    dialog?.emit('response', 'import');
    dialog?.force_close();
    await sleep(300);
    check(settings.get_string('dock-position') === 'LEFT' &&
        settings.get_string('click-action') === 'focus-minimize-or-appspread' &&
        settings.get_double('pressure-threshold') === 40 && settings.get_int('icon-size') === 40,
    `Dash to Dock's settings brought over (${settings.get_string('dock-position')}, ` +
        `${settings.get_string('click-action')}, ${settings.get_double('pressure-threshold')}, ` +
        `${settings.get_int('icon-size')})`);
    check(!settings.get_boolean('enabled'), 'whether the dock is on stays as it was');
    check(dashToDock.get_string('dock-position') === 'LEFT' &&
        dashToDock.get_string('click-action') === 'focus-minimize-or-previews' &&
        dashToDock.list_keys().every(key => key === 'dock-position' || key === 'click-action' ||
            key === 'pressure-threshold' || key === 'dash-max-icon-size' || dashToDock.get_user_value(key) === null),
    'Dash to Dock\'s own are left as they are');

    row.openSource = openSource;
    row.syncSource();
    ['dock-position', 'click-action', 'pressure-threshold', 'dash-max-icon-size']
        .forEach(key => dashToDock.reset(key));
    settings.settings_schema.list_keys().forEach(key => settings.reset(key));
    await sleep(50);
}
