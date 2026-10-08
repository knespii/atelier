// The dock's checks for extra icons (B4): the trash (full once a file is
// trashed – in the test session's own data dir –, its menu asking before
// it empties it), drives (made up, passed to the dock's locations), the
// Show Applications button at the start, the end and the edge in panel
// mode, opening the app grid. And the preferences' rows for them.
//
// shell(t) runs in tools/shell-test.js, prefs(t) in tools/run-prefs.js; t
// is described there.

// The settings these checks change, put back after them.
const KEYS = ['show-trash', 'show-mounts', 'show-mounts-only-mounted', 'show-mounts-network', 'isolate-locations',
    'show-show-apps-button', 'show-apps-at-top', 'show-apps-always-in-the-edge', 'extend-height'];

const TRASH_ID = 'atelier-location:trash';

/**
 * Change dock settings and wait for the dock (built anew, when panel mode
 * changes) laid out.
 *
 * @param {object} t
 * @param {object} values - key → boolean, or null to reset it
 */
async function setDock(t, values) {
    const before = t.module.dock;
    for (const [key, value] of Object.entries(values)) {
        if (value === null)
            t.settings.reset(key);
        else
            t.settings.set_boolean(key, value);
    }
    if ('extend-height' in values)
        await t.waitFor(() => t.module.dock && t.module.dock !== before, 1000);
    // (Its icons come in, growing, and it is placed as they do.)
    await t.sleep(900);
}

// The name of the icon an item shows.
const iconName = item => item?.icon?.icon?.icon?.gicon?.get_names?.()[0] ?? null;

export async function shell(t) {
    const {check} = t;
    const locations = t.module.services.locations;
    const dock = t.module.dock;
    check(locations.apps().length === 0 && !dock._showApps && !locations._fileManager,
        'extra icons: none by default (no trash, drives, Show Applications)');
    try {
        await trash(t, locations);
        await drives(t, locations);
        await showApps(t);
        const monitor = t.module.dock.monitor;
        await setDock(t, {'show-trash': true, 'show-show-apps-button': true});
        await t.screenshotArea('60-dock-extra-icons', monitor.x, monitor.y + monitor.height - 140, monitor.width, 140);
    } finally {
        await setDock(t, Object.fromEntries(KEYS.map(key => [key, null])));
    }
    check(locations.apps().length === 0 && !locations._trash && !locations._volumeMonitor &&
        !locations._fileManager && !t.module.dock._showApps,
    'turned off again, nothing of them is left (no trash watched, no volume monitor, no file manager proxy)');
}

// The trash: its item, full once a file is trashed, its menu asking before
// it empties it.
async function trash(t, locations) {
    const {check, Gio, GLib, Main} = t;
    await setDock(t, {'show-trash': true});
    let dock = t.module.dock;
    const item = dock.items.get(TRASH_ID);
    check(item?.mapped && locations.apps().map(app => app.get_id()).join() === TRASH_ID,
        'the trash: an item in the dock');
    check(await t.waitFor(() => locations._trash.count === 0, 5000) && iconName(item) === 'user-trash',
        `empty, with the empty trash's icon (${locations._trash.count}, ${iconName(item)})`);
    // File manager windows go with it, but there is no file manager here.
    check(locations._fileManager && !locations._fileManager.available && locations.windowsFor(item.app).length === 0,
        'without a file manager answering, it has no windows (and takes none)');

    // Only ever the test session's own trash.
    const data = GLib.get_user_data_dir();
    const isolated = Boolean(t.OUTPUT) && data === GLib.build_filenamev([t.OUTPUT, 'data']);
    if (!check(isolated, `the test session has its own trash (${data})`))
        return;
    const path = GLib.build_filenamev([data, 'atelier-trash-check.txt']);
    GLib.file_set_contents(path, 'to the trash');
    Gio.File.new_for_path(path).trash(null);
    const trashed = GLib.build_filenamev([data, 'Trash', 'files', 'atelier-trash-check.txt']);
    check(GLib.file_test(trashed, GLib.FileTest.EXISTS), 'a file trashed lands in it');
    check(await t.waitFor(() => iconName(dock.items.get(TRASH_ID)) === 'user-trash-full', 5000),
        `and its icon is the full trash's (${locations._trash.count}, ${iconName(dock.items.get(TRASH_ID))})`);

    // Its menu empties it, once asked; cancelled, nothing goes.
    const icon = dock.items.get(TRASH_ID).icon;
    icon.popupMenu();
    await t.sleep(300);
    const entries = icon._menu._getMenuItems().filter(entry => entry.label?.text);
    const empty = entries.find(entry => entry.label.text === 'Empty Trash…');
    check(icon._menu.isOpen && empty?.sensitive, `its menu has Empty Trash… (${entries.map(e => e.label.text).join(', ')})`);
    empty?.activate(t.Clutter.get_current_event());
    await t.sleep(400);
    const dialogs = Main.layoutManager.modalDialogGroup.get_children()
        .filter(actor => actor.has_style_class_name?.('atelier-empty-trash-dialog') || actor.constructor.name.includes('EmptyTrash'));
    check(dialogs.length === 1 && dialogs[0].visible, 'which asks first');
    dialogs.forEach(dialog => dialog.close());
    await t.sleep(600);
    check(GLib.file_test(trashed, GLib.FileTest.EXISTS) &&
        iconName(dock.items.get(TRASH_ID)) === 'user-trash-full', 'cancelled, the trash stays full');

    // (Emptied item by item, as without Files; Files isn't asked here.)
    const emptied = await locations._trash.deleteItems();
    check(emptied && !GLib.file_test(trashed, GLib.FileTest.EXISTS), 'emptied, the file is gone');
    dock = t.module.dock;
    check(await t.waitFor(() => iconName(dock.items.get(TRASH_ID)) === 'user-trash', 5000),
        `and its icon is the empty trash's again (${iconName(dock.items.get(TRASH_ID))})`);
    await setDock(t, {'show-trash': null});
    check(!t.module.dock.items.has(TRASH_ID) && !locations._trash, 'turned off, it goes');
}

// Drives: made-up ones passed to the locations, as the volume monitor's
// would be.
async function drives(t, locations) {
    const {check, Gio} = t;
    const fake = (key, name, more = {}) => ({
        id: `atelier-location:drive:${key}`, name, uri: `file:///nowhere/${key}`,
        icon: new Gio.ThemedIcon({name: 'drive-removable-media'}),
        mounted: true, network: false, usable: true, shadowed: false, volume: null, mount: null, ...more,
    });
    const made = [fake('test-b', 'Test Stick'), fake('test-a', 'Test Disc', {mounted: false}),
        fake('test-c', 'Test Share', {network: true})];
    const ours = () => locations.apps().map(app => app.get_id()).filter(id => id.includes(':test-'));
    await setDock(t, {'show-mounts': true});
    locations._onMountsChanged([...locations._readMounts(), ...made]);
    await t.sleep(900);
    let dock = t.module.dock;
    check(ours().join() === 'atelier-location:drive:test-b' && dock.items.get('atelier-location:drive:test-b')?.mapped,
        `a drive mounted: an item in the dock (not one unmounted, nor on the network: ${ours().join()})`);
    const icon = dock.items.get('atelier-location:drive:test-b')?.icon;
    icon?.popupMenu();
    await t.sleep(300);
    const labels = icon?._menu?._getMenuItems().filter(entry => entry.label?.text).map(entry => entry.label.text) ?? [];
    check(labels.join() === 'Open', `its menu: Open (nothing to unmount here: ${labels.join(', ')})`);
    icon?._menu?.close();

    await setDock(t, {'show-mounts-only-mounted': false, 'show-mounts-network': true});
    locations._onMountsChanged([...locations._readMounts(), ...made]);
    await t.sleep(900);
    dock = t.module.dock;
    check(ours().join() === 'atelier-location:drive:test-a,atelier-location:drive:test-c,atelier-location:drive:test-b',
        `with those unmounted and on the network, all of them, by name (${ours().join()})`);
    const box = dock.box.get_children();
    const indexOf = id => box.indexOf(dock.items.get(id));
    check(indexOf('atelier-location:drive:test-a') > box.indexOf(dock._separator2), 'after the apps');

    locations._onMountsChanged();
    await t.sleep(900);
    check(ours().length === 0 && !t.module.dock.items.has('atelier-location:drive:test-b'), 'gone, the items go');
    await setDock(t, {'show-mounts': null, 'show-mounts-only-mounted': null, 'show-mounts-network': null});
    check(!locations._volumeMonitor, 'turned off, the volume monitor is let go of');
}

// The Show Applications button: at the end, at the start, at the edge in
// panel mode; it opens the app grid.
async function showApps(t) {
    const {check, Main} = t;
    await setDock(t, {'show-show-apps-button': true});
    let dock = t.module.dock;
    let button = dock._showApps;
    const own = () => dock.box.get_children().filter(child => child === button || dock._isItem(child));
    check(button?.mapped && button.get_parent() === dock.box && own().at(-1) === button,
        'Show Applications: at the end of the apps');
    const item = [...dock.items.values()][0];
    check(item && Math.abs(button.height - item.height) <= 2 && Math.abs(button.width - item.width) <= 2,
        `as big as the apps (${button.width}×${button.height}, an app ${item?.width}×${item?.height})`);

    await setDock(t, {'show-apps-at-top': true});
    check(own()[0] === button && button.get_parent() === dock.box, 'at the start of them');

    await setDock(t, {'extend-height': true});
    dock = t.module.dock;
    button = dock._showApps;
    check(button?.mapped && button.get_parent() === dock._startSlot && dock._startSlot.visible,
        'in panel mode, at the start of the edge');
    await setDock(t, {'show-apps-at-top': null});
    const [containerX] = dock.container.get_transformed_position();
    const [buttonX] = button.get_transformed_position();
    check(button.get_parent() === dock._endSlot &&
        Math.abs(containerX + dock.container.width - (buttonX + button.width)) <= 16,
    `and at its end (${buttonX + button.width} px, the edge ends at ${containerX + dock.container.width})`);
    await setDock(t, {'show-apps-always-in-the-edge': false});
    check(button.get_parent() === dock.box, 'or beside the apps, if asked');
    await setDock(t, {'extend-height': null, 'show-apps-always-in-the-edge': null});

    // Clicked, the app grid opens.
    dock = t.module.dock;
    button = dock._showApps;
    await t.clickAt(...t.centerOf(button));
    check(await t.waitFor(() => Main.overview.visible && Main.overview.dash.showAppsButton.checked, 3000),
        'clicked, it opens the app grid');
    check(button.toggleButton.checked, 'and looks pressed while it is open');
    Main.overview.hide();
    check(await t.waitFor(() => !Main.overview.visible && !Main.overview.animationInProgress, 3000) &&
        !button.toggleButton.checked, 'closed, it looks as before');
    await t.restPointer();
    await setDock(t, {'show-show-apps-button': null});
    check(!t.module.dock._showApps, 'turned off, it goes');
}

// The page's extra icons.
export async function prefs(t) {
    const {page, settings, check, sleep} = t;
    const rows = page.rows;
    check(KEYS.filter(key => key !== 'extend-height').concat(['show-favorites', 'show-running'])
        .every(key => rows.has(key)), 'extra icons: a row for each');

    rows.get('show-trash').active = true;
    check(settings.get_boolean('show-trash'), 'the trash is saved');
    settings.reset('show-trash');

    const nested = [['show-show-apps-button', 'show-apps-at-top'],
        ['show-mounts', 'show-mounts-only-mounted'], ['show-mounts', 'show-mounts-network']];
    for (const [parent, child] of nested) {
        settings.set_boolean(parent, false);
        await sleep(50);
        const off = rows.get(child).sensitive;
        settings.set_boolean(parent, true);
        await sleep(50);
        check(!off && rows.get(child).sensitive && rows.get(parent).enable_expansion,
            `${child}: only with ${parent} on`);
        settings.reset(parent);
    }
    const edge = rows.get('show-apps-always-in-the-edge');
    settings.set_boolean('show-show-apps-button', true);
    await sleep(50);
    const withoutPanel = edge.sensitive;
    settings.set_boolean('extend-height', true);
    await sleep(50);
    check(!withoutPanel && edge.sensitive, 'at the edge: only in panel mode');
    ['show-show-apps-button', 'extend-height'].forEach(key => settings.reset(key));

    await sleep(50);
    const isolate = rows.get('isolate-locations');
    const alone = isolate.sensitive;
    settings.set_boolean('show-mounts', true);
    await sleep(50);
    check(!alone && isolate.sensitive, 'file manager windows: only with the trash or drives');
    settings.reset('show-mounts');
}
