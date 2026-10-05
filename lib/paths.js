// Locations used by the extension and importing wallpapers into its library.
// Shared by the shell and the preferences: only GLib/Gio may be used here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'copy_async');
Gio._promisify(Gio.File.prototype, 'move_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

const APP_DIR = 'atelier';

const EXTENSION_FOR_TYPE = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/jxl': 'jxl',
    'image/avif': 'avif',
    'image/heif': 'heif',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
};

/** @returns {string} directory holding the copied wallpapers */
export function wallpaperDir() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), APP_DIR, 'wallpapers']);
}

/** @returns {string} directory holding generated thumbnails */
export function thumbnailDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), APP_DIR, 'thumbnails']);
}

/**
 * @param {Gio.Settings} [settings] - Atelier's settings
 * @returns {string} the folder the Wallpapers tab shows
 */
export function wallpaperFolder(settings = null) {
    const chosen = settings?.get_string('wallpaper-folder');
    if (chosen)
        return chosen;
    const pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Pictures']);
    return GLib.build_filenamev([pictures, 'Wallpapers']);
}

/**
 * Images in a folder (not recursive), sorted by name.
 *
 * @param {string} folder
 * @param {object} [options]
 * @param {boolean} [options.create] - create the folder when it is missing
 * @returns {Promise<string[]>} paths
 */
export async function listWallpapers(folder, {create = false} = {}) {
    if (create)
        GLib.mkdir_with_parents(folder, 0o755);
    let enumerator;
    try {
        enumerator = await Gio.File.new_for_path(folder).enumerate_children_async(
            'standard::name,standard::type,standard::content-type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null);
    } catch {
        return [];
    }
    const paths = [];
    for (;;) {
        const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
        if (infos.length === 0)
            break;
        for (const info of infos) {
            const type = Gio.content_type_get_mime_type(info.get_content_type() ?? '') ?? '';
            if (info.get_file_type() === Gio.FileType.REGULAR && type.startsWith('image/'))
                paths.push(GLib.build_filenamev([folder, info.get_name()]));
        }
    }
    return paths.sort((a, b) => a.localeCompare(b, undefined, {numeric: true, sensitivity: 'base'}));
}

/**
 * @param {string} path
 * @returns {boolean} whether the file lives in the extension's wallpaper library
 */
export function isInLibrary(path) {
    return path.startsWith(`${wallpaperDir()}/`);
}

/**
 * @param {string} path
 * @returns {boolean} whether the file is a GNOME XML slideshow
 */
export function isSlideshow(path) {
    return path.toLowerCase().endsWith('.xml');
}

/**
 * Turn a file name like "sunflower_hill-bicycle.jpg" into "Sunflower Hill Bicycle".
 *
 * @param {string} path
 * @returns {string}
 */
export function prettyName(path) {
    let base = GLib.path_get_basename(path);
    base = base.replace(/\.[^.]+$/, '');
    base = base.replace(/^[0-9a-f]{8}-/, ''); // our library prefix
    const words = base.split(/[\s_\-.]+/).filter(Boolean);
    if (words.length === 0)
        return 'Wallpaper';
    return words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function slug(text) {
    return text.toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'wallpaper';
}

/**
 * Copy a wallpaper into the library so a profile keeps working when the
 * original file is moved or overwritten (the wallpaper portal, for example,
 * always writes to ~/.config/background). Files already in the library and
 * XML slideshows (which reference other files) are used in place.
 *
 * @param {string} sourcePath
 * @param {Gio.Cancellable} [cancellable]
 * @returns {Promise<string>} path of the file to store in the profile
 */
export async function importWallpaper(sourcePath, cancellable = null) {
    if (isInLibrary(sourcePath) || isSlideshow(sourcePath))
        return sourcePath;

    const source = Gio.File.new_for_path(sourcePath);
    const info = await source.query_info_async('standard::content-type',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
    const type = Gio.content_type_get_mime_type(info.get_content_type()) ?? '';
    if (!type.startsWith('image/'))
        throw new Error(`${sourcePath} is not an image (${type || 'unknown type'})`);

    const ext = EXTENSION_FOR_TYPE[type] ??
        GLib.path_get_basename(sourcePath).match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ??
        'img';
    const name = slug(prettyName(sourcePath));
    const id = GLib.uuid_string_random().slice(0, 8);

    GLib.mkdir_with_parents(wallpaperDir(), 0o755);
    const target = Gio.File.new_for_path(
        GLib.build_filenamev([wallpaperDir(), `${id}-${name}.${ext}`]));
    // Copy under a temporary name and rename when complete, so nothing
    // (a thumbnailer, the shell) ever reads a half-written picture.
    const partial = Gio.File.new_for_path(
        GLib.build_filenamev([wallpaperDir(), `.${id}-${name}.${ext}.partial`]));
    try {
        await source.copy_async(partial, Gio.FileCopyFlags.OVERWRITE,
            GLib.PRIORITY_DEFAULT, cancellable, null);
        await partial.move_async(target, Gio.FileCopyFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable, null);
    } catch (e) {
        partial.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        throw e;
    }
    return target.get_path();
}

/**
 * @param {string} path
 * @returns {boolean} whether the desktop (and so the lock screen) shows the file
 */
function isDesktopBackground(path) {
    const schema = Gio.SettingsSchemaSource.get_default()
        ?.lookup('org.gnome.desktop.background', true);
    if (!schema)
        return false;
    const settings = new Gio.Settings({settings_schema: schema});
    const uri = Gio.File.new_for_path(path).get_uri();
    return ['picture-uri', 'picture-uri-dark'].some(key => settings.get_string(key) === uri);
}

/**
 * Delete a library wallpaper unless a profile or the desktop still uses it.
 * Files outside the library are never touched.
 *
 * @param {string} path
 * @param {object[]} remainingProfiles
 * @returns {Promise<boolean>} whether the file was deleted
 */
export async function deleteWallpaperIfUnused(path, remainingProfiles) {
    if (!path || !isInLibrary(path))
        return false;
    if (remainingProfiles.some(profile => profile.wallpaper === path || profile.wallpaperDark === path))
        return false;
    // Deleting the profile that is on screen must not leave the desktop blank.
    if (isDesktopBackground(path))
        return false;

    try {
        await Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw e;
    }
    return true;
}
