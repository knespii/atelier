// The dock's checks for indicators and badges (B3): the running marks in
// every style, on every side, in the icon's colour or the settings'; the
// count of an app's notifications; counts, progress and urgency apps send
// over Unity's launcher API; the preferences' rows.
//
// shell(t) runs in tools/shell-test.js, prefs(t) in tools/run-prefs.js; t
// is described there.

// The settings these checks change, put back after them.
const KEYS = ['running-indicator-style', 'running-indicator-dominant-color', 'custom-theme-customize-running-dots',
    'custom-theme-running-dots-color', 'custom-theme-running-dots-border-color',
    'custom-theme-running-dots-border-width', 'show-icons-notifications-counter',
    'application-counter-overrides-notifications', 'show-icons-emblems', 'dance-urgent-applications',
    'dock-position'];

const STYLES = ['DEFAULT', 'DOT', 'DOTS', 'SQUARES', 'DASHES', 'SEGMENTED', 'SOLID', 'CILIORA', 'METRO', 'BINARY'];

// Two windows of a little GTK app passing for the app given (its windows
// carry the app's id, so the shell takes them for the app's).
const WINDOWS_APP = id => `
imports.gi.versions.Gtk = '4.0';
const {Gio, Gtk} = imports.gi;
const app = new Gtk.Application({application_id: '${id}', flags: Gio.ApplicationFlags.NON_UNIQUE});
app.connect('activate', () => {
    for (let i = 0; i < 2; i++) {
        const window = new Gtk.ApplicationWindow({application: app, title: 'Dock test ' + i,
            default_width: 320, default_height: 200});
        window.present();
    }
});
app.run([]);
`;

const rectOf = actor => {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height)};
};

// The item of an app in the main dock, a little around it.
async function shoot(t, name, item) {
    const r = rectOf(item);
    const pad = 10;
    await t.screenshotArea(name, r.x - pad, r.y - pad, r.width + 2 * pad, r.height + 2 * pad);
    return {...r, pad};
}

/**
 * Send what an app would send over Unity's launcher API.
 *
 * @param {object} t
 * @param {string} appId - "….desktop"
 * @param {object} values - {count, count-visible, progress, progress-visible, urgent}
 */
function launcherUpdate(t, appId, values) {
    const {GLib, Gio} = t;
    const types = {count: 'x', progress: 'd'};
    const properties = Object.fromEntries(Object.entries(values)
        .map(([key, value]) => [key, new GLib.Variant(types[key] ?? 'b', value)]));
    Gio.DBus.session.emit_signal(null, '/com/canonical/unity/launcherentry/atelier',
        'com.canonical.Unity.LauncherEntry', 'Update',
        new GLib.Variant('(sa{sv})', [`application://${appId}`, properties]));
}

async function setDock(t, values) {
    const before = t.module.dock;
    for (const [key, value] of Object.entries(values)) {
        if (value === null)
            t.settings.reset(key);
        else
            t.settings.set_string(key, value);
    }
    if ('dock-position' in values)
        await t.waitFor(() => t.module.dock && t.module.dock !== before, 1000);
    await t.sleep(900);
}

export async function shell(t) {
    const {AppFavorites, check} = t;
    const favorites = AppFavorites.getAppFavorites().getFavorites();
    if (!check(favorites.length > 0, 'a pinned app to mark'))
        return;
    const app = favorites[0];
    const appId = app.get_id();
    let proc = null;
    try {
        proc = await openWindows(t, appId);
        if (proc)
            await styles(t, app);
        await notifications(t, appId);
        await launcherApi(t, appId);
    } finally {
        proc?.force_exit();
        if (proc)
            check(await t.waitFor(() => app.get_windows().length === 0, 5000), 'the test windows are closed');
        await setDock(t, Object.fromEntries(KEYS.map(key => [key, null])));
    }
    const item = t.module.dock.items.get(appId);
    const decorations = item?.icon._decorations;
    check(item && !decorations._area.visible && !decorations._badge.visible && !decorations._progress.visible &&
        !decorations.wiggling, 'at the defaults, nothing of it shows on a pinned app without windows');
}

async function openWindows(t, appId) {
    const {Gio, check} = t;
    const id = appId.replace(/\.desktop$/, '');
    const proc = Gio.Subprocess.new(['gjs', '-c', WINDOWS_APP(id)], Gio.SubprocessFlags.NONE);
    const icon = () => t.module.dock.items.get(appId)?.icon;
    if (check(await t.waitFor(() => icon()?.windows.length === 2, 15000),
        `two windows of ${t.module.dock.items.get(appId)?.icon.app.get_name()} open (${icon()?.windows.length})`))
        return proc;
    proc.force_exit();
    return null;
}

// Each style: drawn in place of GNOME's dot (which stays for the default).
async function styles(t, app) {
    const {check, settings} = t;
    const appId = app.get_id();
    const icon = () => t.module.dock.items.get(appId).icon;
    // (The windows keep the dock away; it comes back for the pictures.)
    t.module.dock.force(true);
    try {
        for (const style of STYLES) {
            settings.set_string('running-indicator-style', style);
            await t.sleep(250);
            const decorations = icon()._decorations;
            const drawn = style !== 'DEFAULT';
            check(decorations._area.visible === drawn && icon()._dot.visible === !drawn &&
                (!drawn || decorations._state?.n === 2),
            `${style}: ${drawn ? 'drawn for the two windows, GNOME\'s dot hidden' : 'GNOME\'s dot'}`);
            await shoot(t, `64-dock-mark-${style.toLowerCase()}`, t.module.dock.items.get(appId));
        }

        // The settings' colours, with a border.
        settings.set_string('running-indicator-style', 'SOLID');
        settings.set_string('custom-theme-running-dots-color', '#ff2000');
        settings.set_string('custom-theme-running-dots-border-color', '#00ff00');
        settings.set_int('custom-theme-running-dots-border-width', 2);
        settings.set_boolean('custom-theme-customize-running-dots', true);
        await t.sleep(250);
        let state = icon()._decorations._state;
        check(state?.body.join() === '255,32,0' && state.border.join() === '0,255,0' && state.borderWidth === 2,
            `the custom colours (${state?.body}, ${state?.border}, ${state?.borderWidth})`);
        const area = icon()._decorations._area;
        const box = await shoot(t, '64-dock-mark-custom', t.module.dock.items.get(appId));
        const r = rectOf(area);
        const bar = t.averageColor('64-dock-mark-custom', r.x - box.x + box.pad + Math.round(r.width / 2) - 4,
            r.y - box.y + box.pad + r.height - 4, 8, 2);
        check(bar[0] > 150 && bar[2] < 100, `the bar is drawn in it (${bar.map(Math.round)})`);
        // The icon's own colour comes first.
        settings.set_boolean('running-indicator-dominant-color', true);
        await t.sleep(250);
        state = icon()._decorations._state;
        check(Array.isArray(state?.body) && state.body.length === 3 && state.border.join() === '0,255,0',
            `the icon's own colour (${state?.body}), the border still the settings'`);
        await shoot(t, '64-dock-mark-own-colour', t.module.dock.items.get(appId));
        for (const key of ['running-indicator-dominant-color', 'custom-theme-customize-running-dots',
            'custom-theme-running-dots-color', 'custom-theme-running-dots-border-color',
            'custom-theme-running-dots-border-width'])
            settings.reset(key);

        // On the other sides, at the icon's edge towards the dock's edge.
        settings.set_string('running-indicator-style', 'DOTS');
        for (const side of ['LEFT', 'TOP', 'RIGHT']) {
            await setDock(t, {'dock-position': side});
            t.module.dock.force(true);
            await t.sleep(500);
            const decorations = icon()._decorations;
            const offset = {LEFT: -decorations._area.translation_x, RIGHT: decorations._area.translation_x,
                TOP: -decorations._area.translation_y}[side];
            check(decorations._area.visible && !icon()._dot.visible && offset > 0,
                `${side.toLowerCase()}: drawn towards the edge (${offset} px off the icon)`);
            await shoot(t, `64-dock-mark-dots-${side.toLowerCase()}`, t.module.dock.items.get(appId));
        }
        await setDock(t, {'dock-position': null});
        t.module.dock.force(true);
        settings.reset('running-indicator-style');
        await t.sleep(250);
        check(icon()._dot.visible && !icon()._decorations._area.visible, 'GNOME\'s dot back at the default');
    } finally {
        t.module.dock.force(false);
    }
}

// The count of an app's notifications in the tray, none with Do Not
// Disturb on.
async function notifications(t, appId) {
    const {Main, MessageTray, Gio, check} = t;
    const icon = () => t.module.dock.items.get(appId).icon;
    const badge = () => icon()._decorations._badge;
    const source = new MessageTray.Source({
        title: 'Dock test',
        iconName: 'mail-unread-symbolic',
        policy: new MessageTray.NotificationApplicationPolicy(appId.replace(/\.desktop$/, '')),
    });
    Main.messageTray.add(source);
    const banners = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
    try {
        for (const title of ['One', 'Two'])
            source.addNotification(new MessageTray.Notification({source, title, body: 'For the dock'}));
        check(await t.waitFor(() => badge().visible && badge().text === '2', 2000),
            `two notifications: the badge says 2 (${badge().visible ? badge().text : 'none'})`);
        t.module.dock.force(true);
        await t.sleep(400);
        await shoot(t, '64-dock-badge-notifications', t.module.dock.items.get(appId));
        t.module.dock.force(false);
        banners.set_boolean('show-banners', false);
        check(await t.waitFor(() => !badge().visible, 2000), 'none with Do Not Disturb on');
        banners.reset('show-banners');
        check(await t.waitFor(() => badge().text === '2' && badge().visible, 2000), 'back with it off');
        t.settings.set_boolean('show-icons-notifications-counter', false);
        check(await t.waitFor(() => !badge().visible, 2000), 'none with the counter off');
        t.settings.reset('show-icons-notifications-counter');
        check(await t.waitFor(() => badge().visible, 2000), 'and back');
    } finally {
        banners.reset('show-banners');
        source.destroy();
    }
    check(await t.waitFor(() => !badge().visible, 2000), 'gone with the notifications');
    // (They were shown in the island; it lets them go.)
    await t.sleep(1000);
}

// Counts, progress and urgency an app sends over D-Bus.
async function launcherApi(t, appId) {
    const {Main, MessageTray, check} = t;
    const badges = t.module.services.badges;
    const icon = () => t.module.dock.items.get(appId).icon;
    const decorations = () => icon()._decorations;
    check(badges._updateId > 0 && badges._ownerId > 0, 'it listens for the launcher API');
    launcherUpdate(t, appId, {'count': 5, 'count-visible': true, 'progress': 0.5, 'progress-visible': true});
    check(await t.waitFor(() => decorations()._badge.visible && decorations()._badge.text === '5' &&
        decorations()._progress.visible && decorations()._progressValue === 0.5, 3000),
    `count 5 and progress 0.5 sent: the badge says 5, the progress shows (${decorations()._badge.text}, ${decorations()._progressValue})`);
    t.module.dock.force(true);
    await t.sleep(400);
    await shoot(t, '64-dock-badge-progress', t.module.dock.items.get(appId));
    t.module.dock.force(false);

    // With notifications too: the app's count first, or both.
    const source = new MessageTray.Source({
        title: 'Dock test',
        iconName: 'mail-unread-symbolic',
        policy: new MessageTray.NotificationApplicationPolicy(appId.replace(/\.desktop$/, '')),
    });
    Main.messageTray.add(source);
    try {
        source.addNotification(new MessageTray.Notification({source, title: 'One', body: 'For the dock'}));
        await t.sleep(300);
        check(decorations()._badge.text === '5', `the app's count first (${decorations()._badge.text})`);
        t.settings.set_boolean('application-counter-overrides-notifications', false);
        check(await t.waitFor(() => decorations()._badge.text === '6', 2000),
            `or both added up (${decorations()._badge.text})`);
        t.settings.reset('application-counter-overrides-notifications');
    } finally {
        source.destroy();
    }
    check(await t.waitFor(() => decorations()._badge.text === '5', 2000), 'the notification gone, its count goes');

    // Urgent: it wiggles until it isn't.
    launcherUpdate(t, appId, {urgent: true});
    check(await t.waitFor(() => decorations().wiggling, 2000), 'an urgent app wiggles');
    const angles = new Set();
    t.module.dock.force(true);
    // (Over a whole round: swings, then a rest.)
    for (let i = 0; i < 50; i++) {
        angles.add(Math.round(icon().icon.rotation_angle_z));
        await t.sleep(50);
    }
    check(angles.size > 2, `its icon swings (${[...angles]})`);
    t.settings.set_boolean('dance-urgent-applications', false);
    check(await t.waitFor(() => !decorations().wiggling && icon().icon.rotation_angle_z === 0, 1000),
        'not with wiggling off');
    t.settings.reset('dance-urgent-applications');
    check(await t.waitFor(() => decorations().wiggling, 1000), 'and again with it on');
    launcherUpdate(t, appId, {urgent: false});
    check(await t.waitFor(() => !decorations().wiggling && icon().icon.rotation_angle_z === 0, 2000),
        'it stops once the app is no longer urgent');
    t.module.dock.force(false);

    // Badges off: nothing shows, and nothing is listened to.
    t.settings.set_boolean('show-icons-emblems', false);
    check(await t.waitFor(() => !decorations()._badge.visible && !decorations()._progress.visible, 2000),
        'with badges off, neither the count nor the progress');
    check(badges._updateId === 0 && badges._ownerId === 0 && badges.countFor(appId) === 0 &&
        badges._sources.size === 0, 'and nothing is listened to');
    launcherUpdate(t, appId, {'count': 7, 'count-visible': true});
    await t.sleep(300);
    check(!decorations()._badge.visible, 'counts sent meanwhile are not taken');
    t.settings.reset('show-icons-emblems');
    await t.sleep(200);
    check(badges._updateId > 0 && !decorations()._badge.visible, 'badges on again, with nothing left over');
}

export async function prefs(t) {
    const {page, settings, check, sleep} = t;
    const rows = page.rows;
    const keys = ['running-indicator-style', 'running-indicator-dominant-color', 'custom-theme-customize-running-dots',
        'custom-theme-running-dots-color', 'custom-theme-running-dots-border-color',
        'custom-theme-running-dots-border-width', 'show-icons-emblems', 'show-icons-notifications-counter',
        'application-counter-overrides-notifications', 'dance-urgent-applications', 'hide-tooltip'];
    const missing = keys.filter(key => !rows.has(key));
    check(missing.length === 0, `the rows of indicators and badges (missing: ${missing.join(', ') || 'none'})`);

    const style = rows.get('running-indicator-style');
    style.selected = 2;
    await sleep(50);
    check(settings.get_string('running-indicator-style') === 'DOTS',
        `the style is saved (${settings.get_string('running-indicator-style')})`);
    settings.set_string('running-indicator-style', 'BINARY');
    await sleep(50);
    check(style.selected === 9, 'and shown when it changes');
    settings.reset('running-indicator-style');

    const colourRows = ['custom-theme-running-dots-color', 'custom-theme-running-dots-border-color',
        'custom-theme-running-dots-border-width'].map(key => rows.get(key));
    check(colourRows.every(row => !row.sensitive), 'the colours greyed out without custom colours');
    rows.get('custom-theme-customize-running-dots').enable_expansion = true;
    await sleep(50);
    check(settings.get_boolean('custom-theme-customize-running-dots') && colourRows.every(row => row.sensitive),
        'and there with them');
    rows.get('custom-theme-running-dots-border-width').value = 2;
    await sleep(50);
    check(settings.get_int('custom-theme-running-dots-border-width') === 2, 'the border width is saved');
    settings.reset('custom-theme-running-dots-border-width');
    settings.reset('custom-theme-customize-running-dots');

    const counters = ['show-icons-notifications-counter', 'application-counter-overrides-notifications']
        .map(key => rows.get(key));
    rows.get('show-icons-emblems').enable_expansion = false;
    await sleep(50);
    check(!settings.get_boolean('show-icons-emblems') && counters.every(row => !row.sensitive),
        'badges off: their counters greyed out');
    settings.reset('show-icons-emblems');
    await sleep(50);
    check(counters.every(row => row.sensitive), 'on: there');
    rows.get('hide-tooltip').active = true;
    check(settings.get_boolean('hide-tooltip'), 'hiding the apps\' names is saved');
    settings.reset('hide-tooltip');
}
