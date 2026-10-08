// The dock's own checks: where it is on every edge, how long it is, its
// icons fitting, panel mode, always visible, the pill's handle, dropping,
// Dash to Dock; on two monitors, which monitors get a dock. And its
// preferences' position and size.
//
// shell(t) and twoMonitors(t) run in tools/shell-test.js, prefs(t) in
// tools/run-prefs.js; t is described there.

// The settings these checks change, put back after them.
const KEYS = ['dock-position', 'dock-fixed', 'height-fraction', 'icon-size-fixed', 'extend-height',
    'multi-monitor', 'preferred-monitor-by-connector', 'show-in-overview', 'magnification'];

// Those the dock is built anew for (shell/dock/module.js).
const REBUILD_KEYS = ['dock-position', 'multi-monitor', 'preferred-monitor-by-connector', 'dock-fixed',
    'extend-height', 'icon-size-fixed', 'autohide-in-fullscreen', 'icon-size'];

const rectOf = actor => {
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x, y, width, height};
};

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width &&
    a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Change dock settings and wait for the dock built anew, laid out.
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
        else if (Number.isInteger(value) && key === 'icon-size')
            t.settings.set_int(key, value);
        else
            t.settings.set_double(key, value);
    }
    if (Object.keys(values).some(key => REBUILD_KEYS.includes(key)))
        await t.waitFor(() => t.module.dock && t.module.dock !== before, 1000);
    // (Its icons come in, growing, and it is placed as they do.)
    await t.sleep(900);
}

export async function shell(t) {
    const {Main, St, Shell, AppFavorites, check} = t;
    const module = t.module;
    let dock = module.dock;
    await t.restPointer();
    await t.sleep(500);
    const monitor = Main.layoutManager.primaryMonitor;
    const [dockX, dockY] = dock.actor.get_transformed_position();
    check(Math.abs(dockX + dock.actor.width / 2 - (monitor.x + monitor.width / 2)) <= 1 &&
        dockY + dock.actor.height <= monitor.y + monitor.height && dockY > monitor.height - 150,
    `at the bottom, in the middle (${dockX}, ${dockY})`);
    const favorites = AppFavorites.getAppFavorites().getFavorites();
    check(favorites.length > 0 && favorites.every(app => dock.items.get(app.get_id())?.mapped),
        `with the pinned apps (${favorites.length})`);
    check(!dock.hidden, 'shown while no window covers it');
    check(dock.iconSize === 48 && !dock._scroll, `its icons the size asked for (${dock.iconSize})`);
    await t.screenshotArea('60-dock', monitor.x, monitor.y + monitor.height - 140, monitor.width, 140);

    // Brought back by the bottom edge, it stays while the pointer rests
    // there (going, it would uncover the edge under the pointer and come
    // back, on and on), and goes once the pointer leaves.
    await t.pointerTo(dockX + dock.actor.width / 2, monitor.y + monitor.height - 1);
    dock.reveal();
    await t.sleep(2000);
    check(dock.hider.revealed, 'brought back by the edge, it stays while the pointer rests there');
    await t.restPointer();
    check(await t.waitFor(() => !dock.hider.revealed, 3000), 'and goes once the pointer leaves');

    // Dynamic Music Pill finds it where it finds Dash to Dock's row.
    const handle = Main.panel.statusArea['dash-to-dock'];
    check(handle?._box === dock.box && !Object.keys(Main.panel.statusArea).includes('dash-to-dock'),
        'Dynamic Music Pill finds its row (hidden from the other items of the bar)');
    const pill = new St.Widget({style_class: 'music-pill-container', width: 120, height: 40});
    dock.box.add_child(pill);
    dock._redisplay();
    check(pill.get_parent() === dock.box && dock.box.get_last_child() === pill, 'the pill stays at its end');

    // An app dropped on it is pinned.
    const system = Shell.AppSystem.get_default();
    const installed = system.get_installed().map(info => system.lookup_app(info.get_id())).filter(Boolean);
    const app = installed.find(a => !AppFavorites.getAppFavorites().isFavorite(a.get_id()));
    if (app) {
        dock.acceptDrop({app}, null, 10000, 0);
        check(await t.waitFor(() => AppFavorites.getAppFavorites().isFavorite(app.get_id()) &&
            dock.items.has(app.get_id()), 1000), `an app dropped on it is pinned (${app.get_name()})`);
        AppFavorites.getAppFavorites().removeFavorite(app.get_id());
        await t.sleep(400);
    }

    // With Dash to Dock on, it goes (and gives the pill back).
    Object.defineProperty(module, 'blocked', {get: () => true, configurable: true});
    module._sync();
    check(module.dock === null && Main.panel.statusArea['dash-to-dock'] === undefined &&
        pill.get_parent() === null && !pill._destroyed, 'with Dash to Dock on, it goes and lets the pill go');
    delete module.blocked;
    module._sync();
    check(module.dock !== null, 'and comes back without it');
    pill.destroy();

    // (Pinning said so in the island, over where the dock is at the top.)
    Main.messageTray.getSources().forEach(source => [...source.notifications].forEach(n => n.destroy()));
    try {
        await inOverview(t, monitor);
        await magnification(t);
        await sides(t, monitor);
        await fixed(t, monitor);
        await fitting(t, installed);
        await extended(t, monitor);
        await pillAndDrop(t, installed);
    } finally {
        await setDock(t, Object.fromEntries(KEYS.map(key => [key, null])));
    }
    dock = module.dock;
    check(dock?.side === 'BOTTOM' && dock.iconSize === 48, 'at the bottom again, as it was');
}

// At the top (below the top bar), the left and the right: at the edge, a
// row or a column, away off the screen.
async function sides(t, monitor) {
    const {Main, Clutter, check} = t;
    const panel = Main.layoutManager.panelBox;
    for (const side of ['TOP', 'LEFT', 'RIGHT']) {
        await setDock(t, {'dock-position': side});
        const dock = t.module.dock;
        const rect = rectOf(dock.actor);
        const gap = {
            TOP: rect.y - (monitor.y + (panel.visible ? panel.height : 0)),
            LEFT: rect.x - monitor.x,
            RIGHT: monitor.x + monitor.width - (rect.x + rect.width),
        }[side];
        check(dock.side === side && gap >= 0 && gap <= 8,
            `${side.toLowerCase()}: at its edge (${gap} px from it, at ${rect.x}, ${rect.y}, ${rect.width}×${rect.height})`);
        const vertical = side !== 'TOP';
        check(dock.box.orientation === (vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL) &&
            (vertical ? rect.height > rect.width : rect.width > rect.height),
        `${side.toLowerCase()}: ${vertical ? 'a column' : 'a row'}`);
        await t.screenshotArea(`60-dock-${side.toLowerCase()}`, monitor.x, monitor.y, monitor.width, monitor.height);
        dock.hider._slide(true);
        await t.sleep(500);
        const away = rectOf(dock.container);
        check(!overlaps(away, monitor), `${side.toLowerCase()}: away, none of it on the screen`);
        dock.hider._slide(false);
        await t.sleep(500);
    }
    await setDock(t, {'dock-position': null});
}

// Always visible: the work area is smaller by the dock, and as it was
// without.
async function fixed(t, monitor) {
    const {Main, check} = t;
    const index = Main.layoutManager.primaryIndex;
    const before = Main.layoutManager.getWorkAreaForMonitor(index);
    await setDock(t, {'dock-fixed': true});
    const dock = t.module.dock;
    await t.waitFor(() => Main.layoutManager.getWorkAreaForMonitor(index).height < before.height, 2000);
    const during = Main.layoutManager.getWorkAreaForMonitor(index);
    const shrunk = before.height - during.height;
    const thickness = dock.staticRect.height;
    check(shrunk >= thickness && shrunk <= thickness + 8 + 1 && during.y === before.y,
        `always visible, the work area is smaller by the dock (${shrunk} px, the dock ${thickness} px)`);
    check(!dock.hidden && dock.staticRect.y + dock.staticRect.height <= monitor.y + monitor.height,
        'and it is shown');
    await setDock(t, {'dock-fixed': null});
    await t.waitFor(() => Main.layoutManager.getWorkAreaForMonitor(index).height === before.height, 2000);
    check(Main.layoutManager.getWorkAreaForMonitor(index).height === before.height, 'and as it was without');
}

// Many pinned apps in a short dock: smaller icons, or (keeping their size)
// a dock that scrolls.
async function fitting(t, installed) {
    const {St, check} = t;
    const favorites = global.settings.get_strv('favorite-apps');
    const many = [...new Set([...favorites, ...installed.map(app => app.get_id())])].slice(0, 16);
    try {
        global.settings.set_strv('favorite-apps', many);
        await setDock(t, {'height-fraction': 0.3});
        let dock = t.module.dock;
        await t.waitFor(() => dock.iconSize < 48, 2000);
        const max = Math.floor(dock.monitor.width * 0.3);
        check(many.length >= 12 && dock.iconSize < 48 && dock.actor.width <= max,
            `${many.length} apps in 30 % of the edge: smaller icons (${dock.iconSize} px), ${dock.actor.width} px long`);
        await setDock(t, {'icon-size-fixed': true});
        dock = t.module.dock;
        check(dock.iconSize === 48 && dock._scroll instanceof St.ScrollView && dock.actor.width <= max,
            `keeping their size, they scroll (${dock.iconSize} px, ${dock.actor.width} px long)`);
        await t.screenshotArea('60-dock-scrolling', 0, dock.monitor.height - 140, dock.monitor.width, 140);
    } finally {
        global.settings.set_strv('favorite-apps', favorites);
        await setDock(t, {'height-fraction': null, 'icon-size-fixed': null});
    }
}

// Panel mode: along all of the edge.
async function extended(t, monitor) {
    const {check} = t;
    await setDock(t, {'extend-height': true});
    const rect = rectOf(t.module.dock.actor);
    check(rect.x === monitor.x && rect.width === monitor.width && rect.y + rect.height === monitor.y + monitor.height,
        `panel mode: along all of the edge (${rect.x}, ${rect.width}×${rect.height})`);
    await t.screenshotArea('60-dock-panel', monitor.x, monitor.y + monitor.height - 140, monitor.width, 140);
    await setDock(t, {'extend-height': null});
}

// The pill's handle only on a row; on a column, an app dropped lands by y.
async function pillAndDrop(t, installed) {
    const {Main, AppFavorites, check} = t;
    check(Main.panel.statusArea['dash-to-dock']?._box === t.module.dock.box, 'the pill\'s handle on a dock at the bottom');
    await setDock(t, {'dock-position': 'LEFT'});
    const dock = t.module.dock;
    check(Main.panel.statusArea['dash-to-dock'] === undefined, 'and none on a dock at the left');
    const favorites = global.settings.get_strv('favorite-apps');
    const app = installed.find(a => !favorites.includes(a.get_id()));
    if (app) {
        // Far right, at the top: by y, it is first.
        dock.acceptDrop({app}, null, 10000, 0);
        check(await t.waitFor(() => AppFavorites.getAppFavorites().getFavorites()[0]?.get_id() === app.get_id(), 1000),
            'an app dropped at the top of a column is pinned first');
        global.settings.set_strv('favorite-apps', favorites);
        await t.sleep(300);
    }
}

// On two monitors: a dock on each, the pill only in the main one; the main
// dock on the monitor of its connector, or on the main monitor.
export async function twoMonitors(t) {
    const {Main, check} = t;
    const module = t.module;
    if (!check(module?.dock && Main.layoutManager.monitors.length === 2, 'the dock, on two monitors'))
        return;
    try {
        await setDock(t, {'multi-monitor': true});
        const [main, other] = module.docks;
        check(module.docks.length === 2 && main.monitorIndex === Main.layoutManager.primaryIndex &&
            other.monitorIndex !== main.monitorIndex, 'on every monitor: a dock on each');
        const handle = Main.panel.statusArea['dash-to-dock'];
        check(handle?._box === main.box && handle._box !== other.box, 'the pill only in the main one');
        const otherMonitor = Main.layoutManager.monitors[other.monitorIndex];
        check(overlaps(rectOf(other.actor), otherMonitor), 'the other on its monitor');
        await setDock(t, {'multi-monitor': null});
        check(module.docks.length === 1, 'and one again without');

        const manager = global.backend.get_monitor_manager();
        const index = manager.get_monitor_for_connector('Meta-1');
        await setDock(t, {'preferred-monitor-by-connector': 'Meta-1'});
        const monitor = Main.layoutManager.monitors[index];
        check(index >= 0 && index !== Main.layoutManager.primaryIndex && module.dock.monitorIndex === index &&
            overlaps(rectOf(module.dock.actor), monitor), `on the monitor of its connector (Meta-1, ${index})`);
        await t.screenshot('64-monitors-dock-on-meta-1');
        await setDock(t, {'preferred-monitor-by-connector': 'Nowhere-9'});
        check(module.dock.monitorIndex === Main.layoutManager.primaryIndex,
            'a connector not plugged in: on the main monitor');
    } finally {
        await setDock(t, Object.fromEntries(KEYS.map(key => [key, null])));
    }
}

// The page's position and size.
export async function prefs(t) {
    const {page, settings, check, sleep} = t;
    const rows = page.rows;
    rows.get('icon-size').value = 40;
    rows.get('intellihide').active = false;
    check(settings.get_int('icon-size') === 40 && !settings.get_boolean('intellihide'),
        'the dock\'s icon size and hiding are saved');
    ['icon-size', 'intellihide'].forEach(key => settings.reset(key));

    const position = rows.get('dock-position');
    position.selected = position.model.get_n_items() - 1;
    await sleep(50);
    check(settings.get_string('dock-position') === 'RIGHT', `the edge is saved (${settings.get_string('dock-position')})`);
    settings.set_string('dock-position', 'TOP');
    await sleep(50);
    check(position.selected === 1, 'and shown when it changes');
    settings.reset('dock-position');

    const monitor = rows.get('preferred-monitor-by-connector');
    check(monitor.model.get_string(0) === 'Primary', 'the monitor: the main one first');
    settings.set_string('preferred-monitor-by-connector', 'Nowhere-9');
    await sleep(50);
    const last = monitor.model.get_n_items() - 1;
    check(monitor.selected === last && monitor.model.get_string(last).includes('Nowhere-9'),
        'a monitor not plugged in is kept');
    monitor.selected = 0;
    await sleep(50);
    check(settings.get_string('preferred-monitor-by-connector') === 'primary', 'and the main one chosen');

    rows.get('height-fraction').value = 50;
    await sleep(50);
    check(Math.abs(settings.get_double('height-fraction') - 0.5) < 0.001, 'the length in percent');
    settings.reset('height-fraction');

    rows.get('extend-height').enable_expansion = true;
    check(settings.get_boolean('extend-height'), 'panel mode');
    settings.reset('extend-height');

    settings.set_boolean('enabled', false);
    await sleep(50);
    check(!rows.get('dock-position').get_ancestor(t.Adw.PreferencesGroup).sensitive &&
        rows.get('enabled').get_ancestor(t.Adw.PreferencesGroup).sensitive,
    'the dock off, its options grey out (not the switch)');
    settings.reset('enabled');
}

// In the overview, in place of GNOME's dash: the dash hidden and taking no
// room, the dock staying, the overview clear of it; off, as GNOME has it.
async function inOverview(t, monitor) {
    const {Main, check} = t;
    const controls = Main.overview._overview._controls;
    Main.overview.show();
    await t.waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 4000);
    await t.sleep(300);
    const dock = t.module.dock;
    const [, top] = dock.container.get_transformed_position();
    const workspaces = controls._workspacesDisplay;
    const [, wsY] = workspaces.get_transformed_position();
    const wsBottom = wsY + workspaces.height;
    const room = t.module.services.overview.room;
    check(!Main.overview.dash.visible && !dock.hidden && dock.container.opacity === 255 &&
        top < monitor.y + monitor.height && room.size >= dock.staticRect.height && wsBottom <= top &&
        controls.margin_bottom === 0,
    `in the overview, the dock in place of GNOME's dash, the workspaces clear of it (${Math.round(wsBottom)} ≤ ${Math.round(top)})`);
    await t.screenshot('60-dock-overview');
    Main.overview.hide();
    await t.waitFor(() => !Main.overview.visible, 4000);
    await setDock(t, {'show-in-overview': false});
    Main.overview.show();
    await t.waitFor(() => Main.overview.visible && !Main.overview.animationInProgress, 4000);
    await t.sleep(300);
    check(Main.overview.dash.visible && t.module.dock.hidden && t.module.services.overview.room.size === 0,
        'off: the dock goes in the overview, GNOME\'s dash is there');
    Main.overview.hide();
    await t.waitFor(() => !Main.overview.visible, 4000);
    await setDock(t, {'show-in-overview': null});
}

// Along the dock, the icon under the pointer grows, those beside it less,
// the others move apart; the dock keeps its size; away, they ease back.
async function magnification(t) {
    const {check} = t;
    const dock = t.module.dock;
    const items = dock.orderedItems.filter(item => item.visible);
    const middle = items[Math.floor(items.length / 2)];
    const [width, height] = [dock.container.width, dock.container.height];
    const [cx, cy] = t.centerOf(middle);
    await t.pointerTo(cx, cy);
    await t.sleep(70);
    const swelling = middle.child.scale_x;
    check(swelling > 1.01 && swelling < 1.29, `coming onto the dock, it swells rather than jumps (${swelling.toFixed(2)})`);
    await t.pointerTo(cx + 1, cy);
    await t.sleep(400);
    const scales = items.map(item => item.child.scale_x);
    const index = items.indexOf(middle);
    check(scales[index] > 1.25 && scales[index - 1] > 1 && scales[index - 1] < scales[index] &&
        items[index - 1].child.translation_x < 0 && items[index + 1].child.translation_x > 0,
    `under the pointer an icon grows, those beside it less, moving apart (${scales.map(s => s.toFixed(2)).join(' ')})`);
    check(dock.container.width === width && dock.container.height === height, 'the dock keeps its size');
    await t.screenshotArea('60-dock-magnified', 0, global.stage.height - 200, global.stage.width, 200);
    await t.restPointer();
    await t.sleep(600);
    check(items.every(item => item.child.scale_x === 1 && item.child.translation_x === 0), 'away, they are as they were');
    await setDock(t, {'magnification': false});
    await t.pointerTo(cx, cy);
    await t.sleep(400);
    check(middle.child.scale_x === 1, 'off: no magnification');
    await t.restPointer();
    await setDock(t, {'magnification': null});
}
