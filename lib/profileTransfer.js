// A profile as a folder to take elsewhere: profile.json with the profile,
// and copies of its wallpapers next to it. Exported from and imported into
// the preferences.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {normalizeProfile} from './profiles.js';

Gio._promisify(Gio.File.prototype, 'copy_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

export const PROFILE_FILE = 'profile.json';
const FORMAT = 'atelier-profile';

/**
 * @param {string} name
 * @returns {string} a folder name for it
 */
export function folderName(name) {
    const safe = name.replace(/[/\\:*?"<>|\0]/g, '').replace(/\s+/g, ' ').trim();
    return `${safe || 'Profile'} (Atelier)`;
}

/**
 * Write a profile into a new folder inside a folder.
 *
 * @param {object} profile
 * @param {string} parent - where the profile's folder goes
 * @returns {Promise<string>} the profile's folder
 */
export async function exportProfile(profile, parent) {
    let dir = GLib.build_filenamev([parent, folderName(profile.name)]);
    for (let n = 2; GLib.file_test(dir, GLib.FileTest.EXISTS); n++)
        dir = GLib.build_filenamev([parent, `${folderName(profile.name)} ${n}`]);
    GLib.mkdir_with_parents(dir, 0o755);

    const data = {...normalizeProfile(profile), format: FORMAT};
    delete data.id;
    for (const key of ['wallpaper', 'wallpaperDark']) {
        const path = profile[key];
        if (!path || !GLib.file_test(path, GLib.FileTest.IS_REGULAR)) {
            data[key] = null;
            continue;
        }
        const name = `${key === 'wallpaper' ? 'wallpaper' : 'wallpaper-dark'}${/\.[A-Za-z0-9]+$/.exec(path)?.[0] ?? ''}`;
        await Gio.File.new_for_path(path).copy_async(Gio.File.new_for_path(GLib.build_filenamev([dir, name])),
            Gio.FileCopyFlags.NONE, GLib.PRIORITY_DEFAULT, null, null);
        data[key] = name;
    }
    await Gio.File.new_for_path(GLib.build_filenamev([dir, PROFILE_FILE])).replace_contents_async(
        new TextEncoder().encode(JSON.stringify(data, null, 2)), null, false, Gio.FileCreateFlags.NONE, null);
    return dir;
}

/**
 * Read an exported profile.
 *
 * @param {string} dir - the profile's folder (or its profile.json)
 * @returns {Promise<object>} the profile without an id; its wallpapers are
 *   full paths of the files in the folder
 */
export async function readExportedProfile(dir) {
    if (dir.endsWith(`/${PROFILE_FILE}`))
        dir = GLib.path_get_dirname(dir);
    const file = Gio.File.new_for_path(GLib.build_filenamev([dir, PROFILE_FILE]));
    let data;
    try {
        const [contents] = await file.load_contents_async(null);
        data = JSON.parse(new TextDecoder().decode(contents));
    } catch {
        throw new Error('This folder has no Atelier profile in it');
    }
    if (data?.format !== FORMAT)
        throw new Error('This isn\'t an exported Atelier profile');
    const resolve = name => {
        if (typeof name !== 'string' || !name || name.includes('/'))
            return null;
        const path = GLib.build_filenamev([dir, name]);
        return GLib.file_test(path, GLib.FileTest.IS_REGULAR) ? path : null;
    };
    const profile = normalizeProfile({...data, id: 'imported', wallpaper: resolve(data.wallpaper),
        wallpaperDark: resolve(data.wallpaperDark)});
    delete profile.id;
    return profile;
}
