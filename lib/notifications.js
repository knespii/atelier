// Per-app rules for notifications in the island: which buttons they get and
// which apps are muted. Shared by the shell and the preferences: only
// GLib/Gio may be used here.

import GLib from 'gi://GLib';

/** What buttons a notification gets, per app. */
export const BUTTON_MODES = [
    ['app', 'From the app'],
    ['none', 'None'],
    ['reply-mute', 'Reply and Mute'],
];

/** How long a mute lasts, in seconds; 0 means until it is lifted. */
export const MUTE_DURATIONS = [
    [3600, '1 hour'],
    [8 * 3600, '8 hours'],
    [0, 'Until unmuted'],
];

/**
 * The key GNOME uses for an app in its notification settings
 * (org.gnome.desktop.notifications application-children).
 *
 * @param {string} id - an app id, e.g. "org.gnome.Nautilus" or "org.gnome.Nautilus.desktop"
 * @returns {string} e.g. "org-gnome-nautilus"
 */
export function canonicalAppId(id) {
    return id.replace(/\.desktop$/, '').toLowerCase()
        .replace(/[^a-z0-9-]/g, '-').replace(/--+/g, '-');
}

function readObject(settings, key) {
    try {
        const value = JSON.parse(settings.get_string(key));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

/**
 * @param {Gio.Settings} settings - the notifications settings
 * @param {string} appId - canonical app id
 * @returns {string} one of the BUTTON_MODES ids
 */
export function buttonMode(settings, appId) {
    const mode = readObject(settings, 'app-buttons')[appId];
    return BUTTON_MODES.some(([id]) => id === mode) ? mode : 'app';
}

/**
 * @param {Gio.Settings} settings
 * @param {string} appId - canonical app id
 * @param {string} mode - one of the BUTTON_MODES ids
 */
export function setButtonMode(settings, appId, mode) {
    const modes = readObject(settings, 'app-buttons');
    if (mode === 'app')
        delete modes[appId];
    else
        modes[appId] = mode;
    settings.set_string('app-buttons', JSON.stringify(modes));
}

const now = () => Math.floor(GLib.get_real_time() / GLib.USEC_PER_SEC);

/**
 * @param {Gio.Settings} settings
 * @returns {Map<string, number>} muted apps → end of the mute (unix seconds, 0 = until lifted)
 */
export function activeMutes(settings) {
    const time = now();
    return new Map(Object.entries(readObject(settings, 'muted'))
        .filter(([, until]) => Number.isInteger(until) && (until === 0 || until > time)));
}

/**
 * @param {Gio.Settings} settings
 * @param {string} appId - canonical app id
 * @returns {boolean}
 */
export function isMuted(settings, appId) {
    return activeMutes(settings).has(appId);
}

/**
 * Mute an app; mutes that have run out are dropped on the way.
 *
 * @param {Gio.Settings} settings
 * @param {string} appId - canonical app id
 * @param {number} duration - seconds; 0 until lifted
 */
export function muteApp(settings, appId, duration) {
    const mutes = Object.fromEntries(activeMutes(settings));
    mutes[appId] = duration > 0 ? now() + duration : 0;
    settings.set_string('muted', JSON.stringify(mutes));
}

/**
 * @param {Gio.Settings} settings
 * @param {string} appId - canonical app id
 */
export function unmuteApp(settings, appId) {
    const mutes = Object.fromEntries(activeMutes(settings));
    delete mutes[appId];
    settings.set_string('muted', JSON.stringify(mutes));
}
