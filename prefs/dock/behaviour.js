// The dock's sections "Clicking and scrolling" and "Keyboard": what clicks
// and scrolling on an app do, which windows count, Super+number and the
// shortcut that shows the dock – with a warning when that shortcut is one
// Atelier or GNOME already has.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ShortcutRow} from '../shortcutRow.js';

const CLICK_ACTIONS = [
    ['skip', 'Bring up the window'],
    ['minimize', 'Minimize'],
    ['launch', 'Open a new window'],
    ['cycle-windows', 'Go through the windows'],
    ['minimize-or-overview', 'Minimize, or the overview'],
    ['appspread', 'Spread the windows out'],
    ['minimize-or-appspread', 'Minimize, or spread the windows out'],
    ['focus-or-appspread', 'Focus, or spread the windows out'],
    ['focus-minimize-or-appspread', 'Focus, minimize, or spread the windows out'],
    ['quit', 'Quit'],
];
const SCROLL_ACTIONS = [
    ['do-nothing', 'Nothing'],
    ['cycle-windows', 'Go through the windows'],
    ['switch-workspace', 'Switch workspaces'],
];
const ROOT_SCHEMA = 'org.gnome.shell.extensions.atelier';
const GNOME_SCHEMA = 'org.gnome.shell.keybindings';

/**
 * @param {Adw.PreferencesPage} _page
 * @param {object} ctx - {settings, binder}
 * @returns {Adw.PreferencesGroup[]}
 */
export function build(_page, {settings, binder}) {
    return [clicking(settings, binder), keyboard(settings, binder)];
}

function clicking(settings, binder) {
    const group = new Adw.PreferencesGroup({
        title: 'Clicking and scrolling',
        description: 'An app without windows here opens, whatever the click. Ctrl and a click open a new window.',
    });
    binder.bindCombo(group, settings, 'click-action', 'Click', '', CLICK_ACTIONS);
    binder.bindCombo(group, settings, 'shift-click-action', 'Shift and click', '', CLICK_ACTIONS);
    binder.bindCombo(group, settings, 'middle-click-action', 'Middle click', '', CLICK_ACTIONS);
    binder.bindCombo(group, settings, 'shift-middle-click-action', 'Shift and middle click', '', CLICK_ACTIONS);
    binder.bindSwitch(group, settings, 'activate-single-window', 'Only the latest window',
        'Brought up, an app brings up its latest window rather than all of them');
    binder.bindCombo(group, settings, 'scroll-action', 'Scrolling on an app', '', SCROLL_ACTIONS);
    binder.bindSwitch(group, settings, 'scroll-switch-workspace', 'Scrolling on the dock switches workspaces',
        'Between the apps, not on them');
    binder.bindSwitch(group, settings, 'isolate-workspaces', 'Only windows on this workspace',
        'The apps with windows elsewhere aren\'t in the dock, and a click opens one here');
    binder.bindSwitch(group, settings, 'isolate-monitors', 'Only windows on the dock\'s monitor');
    binder.bindSwitch(group, settings, 'workspace-agnostic-urgent-windows', 'Urgent windows from every workspace',
        'A window asking for attention counts wherever it is');
    return group;
}

function keyboard(settings, binder) {
    const group = new Adw.PreferencesGroup({
        title: 'Keyboard',
        description: 'While Super+number is on, GNOME\'s own Super+number shortcuts for the pinned apps are off.',
    });
    binder.bindSwitch(group, settings, 'hot-keys', 'Super+number',
        'Super with 1 to 0 opens the dock\'s apps in order; with Shift as Shift and click, with Ctrl in a new window');
    const rows = [
        binder.bindSwitch(group, settings, 'hotkeys-overlay', 'Show numbers', 'On the apps, for a while'),
        binder.bindSwitch(group, settings, 'hotkeys-show-dock', 'Show the dock', 'For a while, when it is away'),
    ];

    const shortcut = new ShortcutRow({settings, key: 'shortcut', title: 'Shortcut'});
    shortcut.subtitle = 'Shows the numbers and the dock without opening an app';
    // (It lets go of its setting as it goes.)
    shortcut.connect('destroy', () => shortcut.disconnectSettings());
    group.add(binder.register('shortcut', shortcut));
    rows.push(shortcut);

    const warning = new Adw.ActionRow({title: 'This shortcut is taken', css_classes: ['warning'], visible: false});
    warning.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic'}));
    group.add(warning);
    shortcut.warning = warning;
    watchConflicts(settings, binder, warning);

    rows.push(binder.bindSpin(group, settings, 'shortcut-timeout', 'For how long', 'Seconds',
        {lower: 0, upper: 10, step: 0.5, digits: 1}));
    rows.forEach(row => binder.bindSensitive(row, settings, 'hot-keys'));
    return group;
}

// The shortcut as Gtk names it, to compare ('<Super>q' and '<super>Q'
// alike); null for none.
function normalize(accel) {
    if (!accel)
        return null;
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    return ok && key ? Gtk.accelerator_name(key, mods) : null;
}

// Atelier's settings (all of them, not only the dock's), from the schemas
// beside the extension as GNOME reads them.
function atelierSettings(dock) {
    let source = Gio.SettingsSchemaSource.get_default();
    const dir = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_parent().get_child('schemas');
    try {
        source = Gio.SettingsSchemaSource.new_from_directory(dir.get_path(), source, false);
    } catch {
        // (Installed with the system's schemas.)
    }
    const schema = source?.lookup(ROOT_SCHEMA, true);
    return schema ? new Gio.Settings({settings_schema: schema, backend: dock.backend}) : null;
}

// Every shortcut of a settings object (and its children) whose key starts
// so: [settings, key, label].
function shortcutKeys(settings, prefix, label) {
    const keys = settings.settings_schema.list_keys()
        .filter(key => key.startsWith(prefix) &&
            settings.settings_schema.get_key(key).get_value_type().dup_string() === 'as')
        .map(key => [settings, key, label]);
    return [...keys, ...settings.list_children().flatMap(child =>
        shortcutKeys(settings.get_child(child), prefix, label))];
}

// The warning shows while the shortcut is one of Atelier's (atelier-*) or
// GNOME's.
function watchConflicts(settings, binder, warning) {
    const others = [];
    const root = atelierSettings(settings);
    if (root)
        others.push(...shortcutKeys(root, 'atelier-', 'Atelier'));
    if (Gio.SettingsSchemaSource.get_default().lookup(GNOME_SCHEMA, true))
        others.push(...shortcutKeys(new Gio.Settings({schema_id: GNOME_SCHEMA}), '', 'GNOME'));
    const sync = () => {
        const mine = settings.get_strv('shortcut').map(normalize).filter(Boolean);
        const taken = others.filter(([other, key]) =>
            other.get_strv(key).some(accel => mine.includes(normalize(accel))));
        warning.visible = taken.length > 0;
        warning.subtitle = taken.map(([, key, label]) => `${label}: ${key}`).join(', ');
    };
    sync();
    binder.connect(settings, 'changed::shortcut', sync);
    // (Watched by each object once: keys of children are watched by theirs.)
    for (const other of new Set(others.map(([object]) => object)))
        binder.connect(other, 'changed', sync);
}
