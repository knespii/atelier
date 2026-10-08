// The row of the dock's status that brings Dash to Dock's settings over
// (lib/dockImport.js says how): "Import from Dash to Dock…". Dash to
// Dock's settings are only read, never written; Atelier's are written at
// once, in one go. The row greys out when Dash to Dock isn't installed.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {describeKeys, mapDashToDock} from '../../lib/dockImport.js';
import {toast} from '../widgets.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.dash-to-dock';
const UUID = 'dash-to-dock@micxgx.gmail.com';
const SUBTITLE = 'Its position, hiding, clicks, marks and look, as this dock\'s';

/**
 * Dash to Dock's schema: installed with the system's, or in its
 * extension's folder (the user's, then the system's).
 *
 * @returns {Gio.SettingsSchema|null}
 */
export function findSchema() {
    const installed = Gio.SettingsSchemaSource.get_default()?.lookup(SCHEMA_ID, true);
    if (installed)
        return installed;
    for (const dataDir of [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]) {
        const dir = GLib.build_filenamev([dataDir, 'gnome-shell', 'extensions', UUID, 'schemas']);
        if (!GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS))
            continue;
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(dir,
                Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup(SCHEMA_ID, false);
            if (schema)
                return schema;
        } catch (e) {
            logError(e, `Dash to Dock's schemas in ${dir}`);
        }
    }
    return null;
}

/** @returns {Gio.Settings|null} Dash to Dock's settings, to read */
function openDashToDock() {
    const schema = findSchema();
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

/**
 * Write Dash to Dock's settings into the dock's.
 *
 * @param {Gio.Settings} source - Dash to Dock's (only read)
 * @param {Gio.Settings} settings - the dock's
 * @returns {object} {imported, ignored}: how many were written, how many
 *   have nothing to go to
 */
export function importSettings(source, settings) {
    const schema = source.settings_schema;
    const read = key => (schema.has_key(key) ? source.get_value(key).recursiveUnpack() : undefined);
    const keys = describeKeys(settings.settings_schema);
    const {values, ignored} = mapDashToDock(read, keys);
    // (In one go, and nothing of it when a key fails.)
    settings.delay();
    try {
        for (const [key, value] of values) {
            const type = keys[key].type;
            if (type === 'b')
                settings.set_boolean(key, value);
            else if (type === 'i')
                settings.set_int(key, value);
            else if (type === 'd')
                settings.set_double(key, value);
            else if (type === 'as')
                settings.set_strv(key, value);
            else
                settings.set_string(key, value);
        }
        settings.apply();
    } catch (e) {
        settings.revert();
        throw e;
    }
    return {imported: values.length, ignored: ignored.length};
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {Adw.PreferencesPage} page
 * @param {object} ctx - {settings, binder}
 * @returns {Adw.ActionRow} the row, for the status group; row.openSource
 *   (→ Dash to Dock's Gio.Settings or null) may be replaced, then
 *   row.syncSource() called (the checks give it settings in memory)
 */
export function build(page, {settings, binder}) {
    const row = new Adw.ActionRow({title: 'Import from Dash to Dock…', activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    row.openSource = openDashToDock;
    row.syncSource = () => {
        const found = row.openSource() !== null;
        row.sensitive = found;
        row.subtitle = found ? SUBTITLE : 'Dash to Dock isn\'t installed, so there is nothing to bring over';
    };
    row.syncSource();

    row.runImport = () => {
        const source = row.openSource();
        if (!source)
            return null;
        const result = importSettings(source, settings);
        toast(row, `${plural(result.imported, 'setting', 'settings')} imported, ${result.ignored} not applicable`);
        return result;
    };
    binder.connect(row, 'activated', () => {
        const dialog = new Adw.AlertDialog({
            heading: 'Import from Dash to Dock?',
            body: 'The dock\'s settings become Dash to Dock\'s, where it has them. Dash to Dock\'s stay as they are.',
            close_response: 'cancel',
            default_response: 'import',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('import', 'Import');
        dialog.set_response_appearance('import', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_, response) => {
            if (response === 'import')
                row.runImport();
        });
        dialog.present(row);
    });
    return row;
}
