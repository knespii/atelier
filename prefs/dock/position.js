// The dock's section "Position and size": the edge, the monitor (or every
// monitor), panel mode, always visible, how long it may be, the icons'
// size.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

const SIDES = [['BOTTOM', 'Bottom'], ['TOP', 'Top'], ['LEFT', 'Left'], ['RIGHT', 'Right']];

/**
 * @param {Adw.PreferencesPage} page
 * @param {object} ctx - {settings, binder}
 * @returns {Adw.PreferencesGroup}
 */
export function build(page, {settings, binder}) {
    const group = new Adw.PreferencesGroup({
        title: 'Position and size',
        description: 'Dynamic Music Pill sits at the end of the dock while it is at the top or the bottom.',
    });
    binder.bindCombo(group, settings, 'dock-position', 'Position', 'The edge of the screen it is at', SIDES);
    monitorRow(group, settings, binder);
    binder.bindSwitch(group, settings, 'multi-monitor', 'On every monitor',
        'The others have the same apps; the pill stays in the main one');

    const panel = new Adw.ExpanderRow({
        title: 'Panel mode',
        subtitle: 'Along the whole edge, touching it',
        show_enable_switch: true,
    });
    binder.bind(settings, 'extend-height', panel, 'enable-expansion');
    binder.register('extend-height', panel);
    group.add(panel);
    binder.bindSwitch(panel, settings, 'always-center-icons', 'Icons in the middle',
        'Rather than at the start of the edge');

    binder.bindSwitch(group, settings, 'dock-fixed', 'Always visible',
        'It never moves away, and maximized windows end where it begins');
    binder.bindSwitch(group, settings, 'show-in-overview', 'In the overview',
        'In place of GNOME\'s dash there');
    binder.bindSpin(group, settings, 'height-fraction', 'Maximum length', 'Percent of the edge',
        {lower: 10, upper: 100, step: 5, scale: 100});
    binder.bindSpin(group, settings, 'icon-size', 'Icon size',
        'In pixels; smaller when the apps don\'t all fit', {lower: 16, upper: 64, step: 2});
    binder.bindSwitch(group, settings, 'icon-size-fixed', 'Fixed size',
        'When the apps don\'t all fit, the dock scrolls instead');
    return group;
}

// The main monitor, the monitors plugged in (by their connectors) and the
// one chosen, also while it isn't plugged in.
function monitorRow(group, settings, binder) {
    const key = 'preferred-monitor-by-connector';
    const row = new Adw.ComboRow({title: 'Monitor', subtitle: 'Where the dock is (the main one, on every monitor)'});
    const monitors = Gdk.Display.get_default()?.get_monitors() ?? null;
    let values = [];
    let syncing = false;
    const sync = () => {
        const chosen = settings.get_string(key);
        const options = [['primary', 'Primary']];
        for (let i = 0; monitors && i < monitors.get_n_items(); i++) {
            const monitor = monitors.get_item(i);
            const connector = monitor.get_connector();
            if (connector)
                options.push([connector, monitor.get_model() ? `${monitor.get_model()} (${connector})` : connector]);
        }
        if (!options.some(([value]) => value === chosen))
            options.push([chosen, `${chosen} (not connected)`]);
        values = options.map(([value]) => value);
        syncing = true;
        row.model = Gtk.StringList.new(options.map(([, label]) => label));
        row.selected = values.indexOf(chosen);
        syncing = false;
    };
    sync();
    binder.connect(settings, `changed::${key}`, sync);
    if (monitors)
        binder.connect(monitors, 'items-changed', sync);
    binder.connect(row, 'notify::selected', () => {
        const value = values[row.selected];
        if (!syncing && value !== undefined && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    group.add(row);
    binder.register(key, row);
}
