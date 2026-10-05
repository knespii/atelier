// Discovery of installed GTK, shell, icon and cursor themes.
// Shared by the shell and the preferences: only GLib/Gio may be used here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {settingsIfInstalled} from './looks.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');

export const USER_THEME_UUID = 'user-theme@gnome-shell-extensions.gcampax.github.com';
const USER_THEME_SCHEMA = 'org.gnome.shell.extensions.user-theme';

// Themes GTK 3 provides without any files on disk.
const BUILTIN_GTK_THEMES = ['Adwaita', 'HighContrast'];
const IGNORED_ICON_THEMES = ['default', 'hicolor', 'locolor'];

const fn = (...parts) => GLib.build_filenamev(parts);
const decoder = new TextDecoder();

/** @returns {string[]} theme directories, in the order GTK and User Themes search them */
export function themeDirs() {
    return [
        fn(GLib.get_home_dir(), '.themes'),
        fn(GLib.get_user_data_dir(), 'themes'),
        ...GLib.get_system_data_dirs().map(dir => fn(dir, 'themes')),
    ];
}

/** @returns {string[]} icon and cursor theme directories, in lookup order */
export function iconDirs() {
    return [
        fn(GLib.get_home_dir(), '.icons'),
        fn(GLib.get_user_data_dir(), 'icons'),
        ...GLib.get_system_data_dirs().map(dir => fn(dir, 'icons')),
    ];
}

function shellModeThemeDirs() {
    return GLib.get_system_data_dirs().map(dir => fn(dir, 'gnome-shell', 'theme'));
}

function extensionDirs() {
    return [
        fn(GLib.get_user_data_dir(), 'gnome-shell', 'extensions'),
        ...GLib.get_system_data_dirs().map(dir => fn(dir, 'gnome-shell', 'extensions')),
    ];
}

async function fileType(path) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async('standard::type',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        return info.get_file_type();
    } catch {
        return Gio.FileType.UNKNOWN;
    }
}

const isDir = async path => await fileType(path) === Gio.FileType.DIRECTORY;
const isFile = async path => await fileType(path) === Gio.FileType.REGULAR;

async function readBytes(file) {
    const [bytes] = await file.load_contents_async(null);
    return bytes;
}

/**
 * @param {string} path
 * @param {Gio.FileType} type - the type of children to return
 * @returns {Promise<string[]>} names of the children (symlinks are followed)
 */
async function listChildren(path, type) {
    let enumerator;
    try {
        enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null);
    } catch {
        return [];
    }

    const names = [];
    for (;;) {
        const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
        if (infos.length === 0)
            break;
        for (const info of infos) {
            if (info.get_file_type() === type)
                names.push(info.get_name());
        }
    }
    return names.sort();
}

/**
 * Guess whether a shell stylesheet was written for a current GNOME.
 * GNOME 43 replaced the system menu with quick settings; stylesheets that
 * don't style them predate it and leave GNOME 48 half-themed and broken.
 *
 * @param {Gio.File} cssFile
 * @returns {Promise<'ok'|'outdated'>}
 */
export async function shellThemeCompatibility(cssFile) {
    const queue = [cssFile];
    const seen = new Set();
    while (queue.length > 0 && seen.size < 16) {
        const file = queue.shift();
        if (seen.has(file.get_uri()))
            continue;
        seen.add(file.get_uri());

        let text;
        try {
            text = decoder.decode(await readBytes(file));
        } catch {
            continue;
        }
        if (text.includes('.quick-settings'))
            return 'ok';

        for (const [, target] of text.matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)/g)) {
            // Importing the stylesheet built into the shell keeps a theme current.
            if (target.startsWith('resource://'))
                return 'ok';
            queue.push(target.includes('://')
                ? Gio.File.new_for_uri(target)
                : file.get_parent().resolve_relative_path(target));
        }
    }
    return 'outdated';
}

async function inspectGtkTheme(name, path) {
    if (!await isFile(fn(path, 'gtk-3.0', 'gtk.css')))
        return null;
    const gtk4 = await isFile(fn(path, 'gtk-4.0', 'gtk.css'));
    const gtk4Dark = gtk4 && await isFile(fn(path, 'gtk-4.0', 'gtk-dark.css'));
    return {name, path, gtk4, gtk4Dark};
}

async function inspectShellTheme(name, path) {
    const stylesheet = fn(path, 'gnome-shell', 'gnome-shell.css');
    if (!await isFile(stylesheet))
        return null;
    const compat = await shellThemeCompatibility(Gio.File.new_for_path(stylesheet));
    return {name, path, stylesheet, compat};
}

async function inspectIconDir(name, path) {
    const result = {icon: null, cursor: null};
    if (await isDir(fn(path, 'cursors')))
        result.cursor = {name, path};

    if (IGNORED_ICON_THEMES.includes(name))
        return result;

    const index = Gio.File.new_for_path(fn(path, 'index.theme'));
    try {
        const keyFile = new GLib.KeyFile();
        keyFile.load_from_bytes(new GLib.Bytes(await readBytes(index)), GLib.KeyFileFlags.NONE);
        const get = key => {
            try {
                return keyFile.get_string('Icon Theme', key);
            } catch {
                return '';
            }
        };
        // Cursor-only themes have an index.theme without icon directories.
        // Adwaita is marked hidden, but it is the default and must stay selectable.
        const hidden = get('Hidden').trim() === 'true' && name !== 'Adwaita';
        if (get('Directories').trim() && !hidden)
            result.icon = {name, path, displayName: get('Name') || name};
    } catch {
        // no index.theme: not an icon theme
    }
    return result;
}

/**
 * Collect entries per name; earlier directories win, like GTK's own lookup.
 *
 * @param {string[]} baseDirs
 * @param {Function} inspect - async (name, path) => entry|null
 * @returns {Promise<Map<string, object>>}
 */
async function collect(baseDirs, inspect) {
    const found = new Map();
    for (const base of baseDirs) {
        const names = await listChildren(base, Gio.FileType.DIRECTORY);
        const entries = await Promise.all(names.map(name => inspect(name, fn(base, name))));
        names.forEach((name, i) => {
            if (entries[i] && !found.has(name))
                found.set(name, entries[i]);
        });
    }
    return found;
}

const sortedValues = map => [...map.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));

/**
 * Find every installed theme. Only directories with the expected content are
 * considered, so archives or stray files in theme folders are ignored.
 *
 * @param {object} [dirs] - override the searched directories (for tests)
 * @param {string[]} [dirs.themes]
 * @param {string[]} [dirs.icons]
 * @param {string[]} [dirs.shellModes]
 * @returns {Promise<{gtk: object[], shell: object[], icons: object[], cursors: object[]}>}
 */
export async function scanThemes(dirs = {}) {
    const themes = dirs.themes ?? themeDirs();
    const icons = dirs.icons ?? iconDirs();
    const shellModes = dirs.shellModes ?? shellModeThemeDirs();

    const [gtk, shell, iconDirEntries] = await Promise.all([
        collect(themes, inspectGtkTheme),
        collect(themes, inspectShellTheme),
        collect(icons, inspectIconDir),
    ]);

    if (!dirs.themes) {
        for (const name of BUILTIN_GTK_THEMES) {
            if (!gtk.has(name))
                gtk.set(name, {name, path: null, gtk4: false, gtk4Dark: false});
        }
    }

    // Stylesheets of session modes (e.g. GNOME Classic) are valid User Themes names.
    for (const base of shellModes) {
        for (const file of await listChildren(base, Gio.FileType.REGULAR)) {
            const name = file.replace(/\.css$/, '');
            if (file.endsWith('.css') && !shell.has(name))
                shell.set(name, {name, path: base, stylesheet: fn(base, file), compat: 'ok'});
        }
    }

    const iconThemes = new Map();
    const cursors = new Map();
    for (const [name, entry] of iconDirEntries) {
        if (entry.icon)
            iconThemes.set(name, entry.icon);
        if (entry.cursor)
            cursors.set(name, entry.cursor);
    }

    return {
        gtk: sortedValues(gtk),
        shell: sortedValues(shell),
        icons: sortedValues(iconThemes),
        cursors: sortedValues(cursors),
    };
}

/**
 * Find the directory of one installed theme, searching like GTK does.
 *
 * @param {'gtk'|'shell'|'icons'|'cursors'} kind
 * @param {string} name
 * @returns {Promise<string|null>} the theme directory, '' for themes that
 *   need no files (built-in GTK themes, the default shell theme), or null
 *   when the theme isn't installed
 */
export async function locateTheme(kind, name) {
    const checks = {
        gtk: [themeDirs(), dir => isFile(fn(dir, 'gtk-3.0', 'gtk.css'))],
        shell: [themeDirs(), dir => isFile(fn(dir, 'gnome-shell', 'gnome-shell.css'))],
        icons: [iconDirs(), dir => isFile(fn(dir, 'index.theme'))],
        cursors: [iconDirs(), dir => isDir(fn(dir, 'cursors'))],
    };
    if (!name)
        return kind === 'shell' ? '' : null;

    const [bases, test] = checks[kind];
    for (const base of bases) {
        if (await test(fn(base, name)))
            return fn(base, name);
    }

    if (kind === 'gtk' && BUILTIN_GTK_THEMES.includes(name))
        return '';
    if (kind === 'shell') {
        for (const base of shellModeThemeDirs()) {
            if (await isFile(fn(base, `${name}.css`)))
                return base;
        }
    }
    return null;
}

/**
 * Locate the settings schema of User Themes. Like the shell, prefer the
 * schema shipped inside an installed copy of the extension.
 *
 * @returns {Gio.SettingsSchema|null}
 */
export function findUserThemeSchema() {
    const defaultSource = Gio.SettingsSchemaSource.get_default();
    for (const base of extensionDirs()) {
        const schemaDir = fn(base, USER_THEME_UUID, 'schemas');
        if (!GLib.file_test(fn(schemaDir, 'gschemas.compiled'), GLib.FileTest.EXISTS))
            continue;
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(
                schemaDir, defaultSource, false);
            const schema = source.lookup(USER_THEME_SCHEMA, true);
            if (schema)
                return schema;
        } catch {
            // broken schema dir, try the next one
        }
    }
    return defaultSource?.lookup(USER_THEME_SCHEMA, true) ?? null;
}

/** @returns {Gio.Settings|null} settings of User Themes, if it is installed */
export function getUserThemeSettings() {
    const schema = findUserThemeSchema();
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

/**
 * Whether User Themes is installed and switched on, judged from the shell's
 * settings (for the preferences, which can't ask the shell directly).
 *
 * @returns {boolean}
 */
export function isUserThemeEnabled() {
    const shell = settingsIfInstalled('org.gnome.shell');
    if (!shell || shell.get_boolean('disable-user-extensions'))
        return false;
    return shell.get_strv('enabled-extensions').includes(USER_THEME_UUID) &&
        !shell.get_strv('disabled-extensions').includes(USER_THEME_UUID) &&
        findUserThemeSchema() !== null;
}
