// One-time takeover of the data of BG Changer, the previous name of Atelier:
// profiles (then called looks), shortcuts, transition settings and the
// wallpaper library.
// Shared by the shell and the tests: only GLib/Gio may be used here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {wallpaperDir} from './paths.js';
import {normalizeProfile} from './profiles.js';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'copy_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

export const LEGACY_SCHEMA = 'org.gnome.shell.extensions.bg-changer';
export const LEGACY_UUID = 'bg-changer@local';
const FLAG = 'migrated-from-bg-changer';

// BG Changer key → Atelier key, for keys copied as they are.
const KEY_MAP = {
    'first-run-done': 'first-run-done',
    'transition': 'transition',
    'transition-duration': 'transition-duration',
    'show-indicator': 'show-indicator',
    'bgc-open-switcher': 'atelier-open-switcher',
    'bgc-next-look': 'atelier-next-profile',
    'bgc-previous-look': 'atelier-previous-profile',
    'gtk4-link': 'gtk4-link',
};

const fn = (...parts) => GLib.build_filenamev(parts);

/** @returns {string} where BG Changer kept its copies of wallpapers */
export function legacyWallpaperDir() {
    return fn(GLib.get_user_data_dir(), 'bg-changer', 'wallpapers');
}

function legacyCacheDir() {
    return fn(GLib.get_user_cache_dir(), 'bg-changer');
}

/**
 * @param {Gio.Settings|null} legacy
 * @returns {boolean} whether BG Changer stored anything
 */
function hasLegacyData(legacy) {
    return Boolean(legacy) &&
        legacy.settings_schema.list_keys().some(key => legacy.get_user_value(key) !== null);
}

async function listFiles(dir) {
    let enumerator;
    try {
        enumerator = await Gio.File.new_for_path(dir).enumerate_children_async(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
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
            if (info.get_file_type() === Gio.FileType.REGULAR)
                names.push(info.get_name());
        }
    }
    return names;
}

/**
 * Copy every file of the old library into the new one.
 *
 * @param {string} from
 * @param {string} to
 * @returns {Promise<Map<string, string>>} old path → new path
 */
async function copyLibrary(from, to) {
    const copied = new Map();
    const names = await listFiles(from);
    if (names.length > 0)
        GLib.mkdir_with_parents(to, 0o755);
    for (const name of names) {
        let target = fn(to, name);
        if (GLib.file_test(target, GLib.FileTest.EXISTS))
            target = fn(to, `${GLib.uuid_string_random().slice(0, 8)}-${name}`);
        await Gio.File.new_for_path(fn(from, name)).copy_async(Gio.File.new_for_path(target),
            Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, null, null);
        copied.set(fn(from, name), target);
    }
    return copied;
}

async function deleteQuietly(path) {
    try {
        await Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null);
    } catch {
        // already gone or not empty
    }
}

/**
 * Take over BG Changer's data unless that already happened. Wallpapers are
 * copied first, the desktop background is pointed at the copies and only
 * then are the originals removed, so the desktop never shows a missing file.
 *
 * @param {Gio.Settings} settings - Atelier's settings
 * @param {Gio.Settings|null} legacy - BG Changer's settings, if its schema is known
 * @param {object} [options]
 * @param {Gio.Settings} [options.background] - org.gnome.desktop.background
 * @returns {Promise<{migrated: boolean, profiles?: number, files?: number}>}
 */
export async function migrateFromBgChanger(settings, legacy, {background = null} = {}) {
    if (settings.get_boolean(FLAG))
        return {migrated: false};
    if (!hasLegacyData(legacy)) {
        settings.set_boolean(FLAG, true);
        return {migrated: false};
    }

    const copied = await copyLibrary(legacyWallpaperDir(), wallpaperDir());
    const remap = path => (path && copied.get(path)) || path;

    let looks = [];
    try {
        looks = JSON.parse(legacy.get_string('looks'));
    } catch {
        // unreadable: nothing to take over
    }
    const migrated = (Array.isArray(looks) ? looks : [])
        .map(look => look && normalizeProfile({
            ...look,
            wallpaper: remap(look.wallpaper),
            wallpaperDark: remap(look.wallpaperDark),
        }))
        .filter(Boolean);

    // Profiles Atelier created on its own are kept; the old ones come first.
    let existing = [];
    try {
        existing = JSON.parse(settings.get_string('profiles'));
    } catch {
        existing = [];
    }
    existing = (Array.isArray(existing) ? existing : []).map(normalizeProfile).filter(Boolean);
    const ids = new Set(migrated.map(p => p.id));
    const profiles = [...migrated, ...existing.filter(p => !ids.has(p.id))];

    settings.delay();
    settings.set_string('profiles', JSON.stringify(profiles));
    const legacyActive = legacy.get_string('active-look');
    if (!settings.get_string('active-profile') && profiles.some(p => p.id === legacyActive))
        settings.set_string('active-profile', legacyActive);
    for (const [from, to] of Object.entries(KEY_MAP)) {
        if (legacy.get_user_value(from) !== null)
            settings.set_value(to, legacy.get_value(from));
    }
    settings.set_boolean(FLAG, true);
    settings.apply();

    background ??= new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    for (const key of ['picture-uri', 'picture-uri-dark']) {
        const uri = background.get_string(key);
        const path = uri ? Gio.File.new_for_uri(uri).get_path() : null;
        if (path && copied.has(path))
            background.set_string(key, Gio.File.new_for_path(copied.get(path)).get_uri());
    }

    for (const path of copied.keys())
        await deleteQuietly(path);
    await deleteQuietly(legacyWallpaperDir());
    await deleteQuietly(GLib.path_get_dirname(legacyWallpaperDir()));
    // Old thumbnails are named by the old paths and can't be reused.
    const thumbs = fn(legacyCacheDir(), 'thumbnails');
    for (const name of await listFiles(thumbs))
        await deleteQuietly(fn(thumbs, name));
    await deleteQuietly(thumbs);
    await deleteQuietly(legacyCacheDir());

    return {migrated: true, profiles: migrated.length, files: copied.size};
}
