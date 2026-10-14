// The dock's section "Extra icons": Show Applications (the system's icon or
// GNOME's dots; at the start or the end, at the very edge in panel mode), the trash, drives (mounted only,
// network ones), file manager windows with the place they show, pinned
// and running apps.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {addRow} from './common.js';

/**
 * @param {Adw.PreferencesPage} page
 * @param {object} ctx - {settings, binder}
 * @returns {Adw.PreferencesGroup}
 */
export function build(page, {settings, binder}) {
    const group = new Adw.PreferencesGroup({
        title: 'Extra icons',
        description: 'Besides the apps: the app grid, the trash and drives.',
    });

    const showApps = expander(group, settings, binder, 'show-show-apps-button', 'Show Applications button',
        'Opens the app grid');
    const icon = binder.bindCombo(showApps, settings, 'show-apps-icon', 'Icon', '', [
        ['SYSTEM', 'The system\'s own'], ['GRID', 'Grid of dots']]);
    icon.subtitle = 'The system\'s is Ubuntu\'s on Ubuntu, the dots elsewhere';
    const atStart = position(showApps, settings, binder);
    const atEdge = binder.bindSwitch(showApps, settings, 'show-apps-always-in-the-edge', 'At the very edge in panel mode',
        'At the end of the bar (or its start), away from the apps rather than beside them');
    binder.bindSensitive(icon, settings, 'show-show-apps-button');
    binder.bindSensitive(atStart, settings, 'show-show-apps-button');
    // (Only panel mode has an edge apart from the apps.)
    const syncEdge = () => {
        atEdge.sensitive = settings.get_boolean('show-show-apps-button') && settings.get_boolean('extend-height');
    };
    syncEdge();
    binder.connect(settings, 'changed::show-show-apps-button', syncEdge);
    binder.connect(settings, 'changed::extend-height', syncEdge);

    binder.bindSwitch(group, settings, 'show-trash', 'Trash', 'Full while anything is in it; its menu empties it');

    const drives = expander(group, settings, binder, 'show-mounts', 'Drives',
        'USB sticks, discs and other drives; their menus unmount and eject them');
    const onlyMounted = binder.bindSwitch(drives, settings, 'show-mounts-only-mounted', 'Only mounted',
        'Not those that would be mounted when clicked');
    const network = binder.bindSwitch(drives, settings, 'show-mounts-network', 'Network', 'Shared folders on other computers');
    binder.bindSensitive(onlyMounted, settings, 'show-mounts');
    binder.bindSensitive(network, settings, 'show-mounts');

    const isolate = binder.bindSwitch(group, settings, 'isolate-locations', 'File manager windows as their own icons',
        'A window showing the trash or a drive goes with its icon, not with the file manager\'s');
    const syncIsolate = () => {
        isolate.sensitive = settings.get_boolean('show-trash') || settings.get_boolean('show-mounts');
    };
    syncIsolate();
    binder.connect(settings, 'changed::show-trash', syncIsolate);
    binder.connect(settings, 'changed::show-mounts', syncIsolate);

    binder.bindSwitch(group, settings, 'show-favorites', 'Show pinned apps');
    binder.bindSwitch(group, settings, 'show-running', 'Show running apps',
        'Those with windows that count (see Clicking and scrolling)');
    return group;
}

// Where along the dock: after the apps or before them.
function position(group, settings, binder) {
    const row = new Adw.ComboRow({
        title: 'Position',
        subtitle: 'In a bar down a side, the end is its bottom',
        model: Gtk.StringList.new(['At the end', 'At the start']),
    });
    const sync = () => (row.selected = settings.get_boolean('show-apps-at-top') ? 1 : 0);
    sync();
    binder.connect(settings, 'changed::show-apps-at-top', sync);
    binder.connect(row, 'notify::selected', () => {
        if (settings.get_boolean('show-apps-at-top') !== (row.selected === 1))
            settings.set_boolean('show-apps-at-top', row.selected === 1);
    });
    addRow(group, row);
    return binder.register('show-apps-at-top', row);
}

// A switch that opens to the options it has.
function expander(group, settings, binder, key, title, subtitle) {
    const row = new Adw.ExpanderRow({title, subtitle, show_enable_switch: true});
    binder.bind(settings, key, row, 'enable-expansion');
    binder.register(key, row);
    group.add(row);
    return row;
}
