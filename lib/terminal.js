// GNOME Terminal colors from the palette. Atelier manages one profile,
// "Atelier", which starts as a copy of the user's default profile (font,
// scrollback…) and only differs in its colors. While coloring is on it is
// the default profile; switching it off brings the previous default back
// and removes Atelier's profile.
// Shared by the shell, the preferences and the tests: only GLib/Gio here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const LIST_SCHEMA = 'org.gnome.Terminal.ProfilesList';
const PROFILE_SCHEMA = 'org.gnome.Terminal.Legacy.Profile';
const profilePath = uuid => `/org/gnome/terminal/legacy/profiles:/:${uuid}/`;

const lookup = id => Gio.SettingsSchemaSource.get_default()?.lookup(id, true) ?? null;

/** @returns {boolean} whether GNOME Terminal's settings are installed */
export function isTerminalAvailable() {
    return lookup(LIST_SCHEMA) !== null && lookup(PROFILE_SCHEMA) !== null;
}

function profileSettings(uuid) {
    return new Gio.Settings({settings_schema: lookup(PROFILE_SCHEMA), path: profilePath(uuid)});
}

/**
 * @param {object} palette
 * @param {boolean} dark - match the dark style
 * @returns {object} colors for a terminal profile
 */
export function terminalColors(palette, dark) {
    const s = dark ? palette.dark : palette.light;
    return {
        background: s.surface,
        foreground: s.onSurface,
        palette: palette.terminal[dark ? 'dark' : 'light'],
        cursorBackground: s.primary,
        cursorForeground: s.onPrimary,
        highlightBackground: s.primaryContainer,
        highlightForeground: s.onPrimaryContainer,
    };
}

/**
 * Create or update Atelier's terminal profile and make it the default.
 *
 * @param {Gio.Settings} paletteSettings - Atelier's palette settings
 * @param {object} colors - see terminalColors()
 * @returns {{ok: boolean, created?: boolean, reason?: string}}
 */
export function applyTerminalColors(paletteSettings, colors) {
    if (!isTerminalAvailable())
        return {ok: false, reason: 'GNOME Terminal is not installed'};

    const list = new Gio.Settings({schema_id: LIST_SCHEMA});
    const profiles = list.get_strv('list');
    let uuid = paletteSettings.get_string('terminal-profile');
    let created = false;
    if (!uuid || !profiles.includes(uuid)) {
        uuid = GLib.uuid_string_random();
        created = true;
    }

    const profile = profileSettings(uuid);
    profile.delay();
    if (created) {
        // Start from the current default, so only the colors change.
        const base = profileSettings(list.get_string('default'));
        for (const key of base.settings_schema.list_keys()) {
            const value = base.get_user_value(key);
            if (value !== null)
                profile.set_value(key, value);
        }
    }
    profile.set_string('visible-name', 'Atelier');
    profile.set_boolean('use-theme-colors', false);
    profile.set_string('background-color', colors.background);
    profile.set_string('foreground-color', colors.foreground);
    profile.set_strv('palette', colors.palette);
    profile.set_boolean('bold-color-same-as-fg', true);
    profile.set_boolean('cursor-colors-set', true);
    profile.set_string('cursor-background-color', colors.cursorBackground);
    profile.set_string('cursor-foreground-color', colors.cursorForeground);
    profile.set_boolean('highlight-colors-set', true);
    profile.set_string('highlight-background-color', colors.highlightBackground);
    profile.set_string('highlight-foreground-color', colors.highlightForeground);
    profile.apply();

    if (created) {
        list.set_strv('list', [...profiles, uuid]);
        paletteSettings.set_string('terminal-profile', uuid);
    }
    const current = list.get_string('default');
    if (current !== uuid) {
        paletteSettings.set_string('terminal-previous-default', current);
        list.set_string('default', uuid);
    }
    return {ok: true, created};
}

/**
 * Bring back the previous default profile and remove Atelier's.
 *
 * @param {Gio.Settings} paletteSettings
 * @returns {boolean} whether anything was restored
 */
export function restoreTerminal(paletteSettings) {
    const uuid = paletteSettings.get_string('terminal-profile');
    if (!uuid || !isTerminalAvailable())
        return false;

    const list = new Gio.Settings({schema_id: LIST_SCHEMA});
    const others = list.get_strv('list').filter(p => p !== uuid);
    if (list.get_string('default') === uuid) {
        const previous = paletteSettings.get_string('terminal-previous-default');
        list.set_string('default', others.includes(previous) ? previous : others[0] ?? '');
    }
    list.set_strv('list', others);

    const profile = profileSettings(uuid);
    for (const key of profile.settings_schema.list_keys())
        profile.reset(key);

    paletteSettings.set_string('terminal-profile', '');
    paletteSettings.set_string('terminal-previous-default', '');
    return true;
}
