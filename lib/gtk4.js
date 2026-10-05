// Theming GTK 4 / libadwaita apps.
// libadwaita ignores the gtk-theme setting; the only way to restyle those apps
// is a user stylesheet in ~/.config/gtk-4.0/gtk.css, which GTK reads when an
// app starts. We symlink the theme's stylesheet (and its assets) there, and
// only ever remove links we created ourselves.
// Shared by the shell and the preferences: only GLib/Gio may be used here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'make_symbolic_link_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

const MANAGED = ['gtk.css', 'assets'];

const fn = (...parts) => GLib.build_filenamev(parts);

/** @returns {string} ~/.config/gtk-4.0 */
export function gtk4ConfigDir() {
    return fn(GLib.get_user_config_dir(), 'gtk-4.0');
}

function readState(settings) {
    try {
        const state = JSON.parse(settings.get_string('gtk4-link') || '{}');
        if (state?.links && typeof state.links === 'object')
            return state;
    } catch {
        // fall through
    }
    return {links: {}};
}

async function inspect(path) {
    try {
        const info = await Gio.File.new_for_path(path).query_info_async(
            'standard::is-symlink,standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, null);
        const isSymlink = info.get_is_symlink();
        return {exists: true, isSymlink, target: isSymlink ? info.get_symlink_target() : null};
    } catch {
        return {exists: false, isSymlink: false, target: null};
    }
}

// A link is ours only while it still points where we pointed it; anything
// else in ~/.config/gtk-4.0 was put there by the user or a theme installer.
const isOurs = (info, state, name) =>
    info.isSymlink && info.target !== null && state.links[name] === info.target;

const exists = path => GLib.file_test(path, GLib.FileTest.EXISTS);

/**
 * @param {string} themeDir
 * @returns {boolean} whether the theme ships a GTK 4 stylesheet
 */
export function hasGtk4Support(themeDir) {
    return Boolean(themeDir) && exists(fn(themeDir, 'gtk-4.0', 'gtk.css'));
}

/**
 * @param {Gio.Settings} settings - the extension's settings
 * @returns {string|null} the theme directory currently linked, if any
 */
export function linkedGtk4Theme(settings) {
    const state = readState(settings);
    return Object.keys(state.links).length > 0 ? state.theme ?? null : null;
}

/**
 * Link a theme's GTK 4 stylesheet into ~/.config/gtk-4.0.
 *
 * GTK 4 only loads gtk.css from there (gtk-dark.css is never read), so for a
 * dark look gtk.css points at the theme's dark stylesheet.
 *
 * @param {Gio.Settings} settings - the extension's settings
 * @param {string} themeDir - the theme directory
 * @param {boolean} dark - use the dark variant if the theme has one
 * @param {string} [configDir] - override for tests
 * @returns {Promise<{ok: boolean, changed: boolean, reason?: string}>}
 */
export async function linkGtk4Theme(settings, themeDir, dark, configDir = gtk4ConfigDir()) {
    const source = fn(themeDir, 'gtk-4.0');
    const stylesheet = dark && exists(fn(source, 'gtk-dark.css'))
        ? fn(source, 'gtk-dark.css') : fn(source, 'gtk.css');
    if (!exists(stylesheet))
        return {ok: false, changed: false, reason: 'the theme has no GTK 4 stylesheet'};

    const wanted = {'gtk.css': stylesheet};
    if (exists(fn(source, 'assets')))
        wanted.assets = fn(source, 'assets');

    const state = readState(settings);
    const current = {};
    for (const name of MANAGED) {
        const path = fn(configDir, name);
        const info = await inspect(path);
        if (info.exists && !isOurs(info, state, name)) {
            return {
                ok: false,
                changed: false,
                reason: `${path} already exists and was not created by BG Changer`,
            };
        }
        current[name] = info.exists ? info.target : null;
    }

    if (MANAGED.every(name => current[name] === (wanted[name] ?? null)))
        return {ok: true, changed: false};

    // Record each link as soon as it exists, so a failure halfway leaves
    // nothing behind that we would later mistake for a user file.
    const links = {...state.links};
    const save = () => settings.set_string('gtk4-link', JSON.stringify({theme: themeDir, links}));
    GLib.mkdir_with_parents(configDir, 0o700);
    for (const name of MANAGED) {
        const file = Gio.File.new_for_path(fn(configDir, name));
        if (current[name]) {
            await file.delete_async(GLib.PRIORITY_DEFAULT, null);
            delete links[name];
            save();
        }
        if (wanted[name]) {
            await file.make_symbolic_link_async(wanted[name], GLib.PRIORITY_DEFAULT, null);
            links[name] = wanted[name];
            save();
        }
    }
    return {ok: true, changed: true};
}

/**
 * Remove the links made by linkGtk4Theme(). Links or files the user put in
 * their place are kept.
 *
 * @param {Gio.Settings} settings - the extension's settings
 * @param {string} [configDir] - override for tests
 * @returns {Promise<boolean>} whether anything was removed
 */
export async function unlinkGtk4Theme(settings, configDir = gtk4ConfigDir()) {
    const state = readState(settings);
    let removed = false;
    for (const name of MANAGED.filter(n => state.links[n])) {
        const path = fn(configDir, name);
        if (isOurs(await inspect(path), state, name)) {
            await Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_DEFAULT, null);
            removed = true;
        }
    }
    if (Object.keys(state.links).length > 0 || state.theme)
        settings.set_string('gtk4-link', '');
    return removed;
}
