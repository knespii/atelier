// The profile model and its storage in GSettings.
// Shared by the shell and the preferences: only GLib/Gio may be used here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {normalizeWidgets, readWidgets} from './widgets.js';

export const PICTURE_OPTIONS = [
    'zoom', 'centered', 'scaled', 'stretched', 'wallpaper', 'spanned', 'none',
];

export const COLOR_SCHEMES = ['default', 'prefer-dark', 'prefer-light'];

// Values accepted by org.gnome.desktop.interface accent-color (GNOME 47+),
// with the colors GNOME uses for them.
export const ACCENT_COLORS = {
    blue: '#3584e4',
    teal: '#2190a4',
    green: '#3a944a',
    yellow: '#c88800',
    orange: '#ed5b00',
    red: '#e62d42',
    pink: '#d56199',
    purple: '#9141ac',
    slate: '#6f8396',
};

export const AUTO_ACCENT = 'auto';

/**
 * @param {*} value
 * @returns {boolean} whether value is one of GNOME's accent colors
 */
export function isAccentColor(value) {
    return typeof value === 'string' && Object.hasOwn(ACCENT_COLORS, value);
}

/**
 * Fields of a profile. For every field except id, name, wallpaper and gtk4,
 * null means "leave the current setting alone" when the profile is applied.
 */
const DEFAULTS = {
    id: '',
    name: 'Untitled profile',
    wallpaper: null,
    wallpaperDark: null, // optional variant GNOME shows with the dark style
    pictureOptions: 'zoom',
    colorScheme: null,
    accentColor: null,
    gtkTheme: null,
    shellTheme: null, // '' selects the default shell theme
    iconTheme: null,
    cursorTheme: null,
    font: null,
    gtk4: false, // also import the GTK theme's gtk-4.0 stylesheet for libadwaita apps
    palette: null, // palette options, see normalizePaletteOptions()
    widgets: null, // the desktop's widgets, see normalizeWidgets()
};

const nullableString = v => typeof v === 'string' ? v : null;

const PALETTE_SOURCES = ['wallpaper', 'swatch', 'preset'];
const PALETTE_VARIANTS = ['vibrant', 'muted', 'monochrome'];

/**
 * @param {object|null} raw
 * @returns {{source: string, swatch: number, preset: string, variant: string}|null}
 */
export function normalizePaletteOptions(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    return {
        source: PALETTE_SOURCES.includes(raw.source) ? raw.source : 'wallpaper',
        swatch: Number.isInteger(raw.swatch) ? Math.min(7, Math.max(0, raw.swatch)) : 0,
        preset: typeof raw.preset === 'string' && raw.preset ? raw.preset : 'ochre',
        variant: PALETTE_VARIANTS.includes(raw.variant) ? raw.variant : 'vibrant',
    };
}

/**
 * @param {object} raw - a profile as parsed from JSON
 * @returns {object|null} a profile with every field present and valid, or null
 */
export function normalizeProfile(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id)
        return null;

    const profile = {...DEFAULTS};
    profile.id = raw.id;
    profile.name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : DEFAULTS.name;
    profile.wallpaper = nullableString(raw.wallpaper) || null;
    const dark = nullableString(raw.wallpaperDark) || null;
    profile.wallpaperDark = profile.wallpaper && dark !== profile.wallpaper ? dark : null;
    profile.pictureOptions = PICTURE_OPTIONS.includes(raw.pictureOptions)
        ? raw.pictureOptions : DEFAULTS.pictureOptions;
    profile.colorScheme = COLOR_SCHEMES.includes(raw.colorScheme) ? raw.colorScheme : null;
    profile.accentColor = raw.accentColor === AUTO_ACCENT || isAccentColor(raw.accentColor)
        ? raw.accentColor : null;
    for (const key of ['gtkTheme', 'shellTheme', 'iconTheme', 'cursorTheme', 'font'])
        profile[key] = nullableString(raw[key]);
    profile.gtk4 = raw.gtk4 === true;
    profile.palette = normalizePaletteOptions(raw.palette);
    profile.widgets = normalizeWidgets(raw.widgets);
    return profile;
}

/**
 * The wallpaper GNOME shows for a profile.
 *
 * @param {object} profile
 * @param {string} colorScheme - the color-scheme in effect once it is applied
 * @returns {string|null}
 */
export function effectiveWallpaper(profile, colorScheme) {
    return colorScheme === 'prefer-dark' && profile.wallpaperDark ? profile.wallpaperDark : profile.wallpaper;
}

/** @returns {string} a short random id */
export function newProfileId() {
    return GLib.uuid_string_random().slice(0, 8);
}

/**
 * @param {object} profile
 * @returns {{label: string, value: string}[]} the non-default parts of a profile
 */
export function describeProfile(profile) {
    const parts = [];
    if (profile.gtkTheme !== null)
        parts.push({label: 'GTK', value: profile.gtkTheme});
    if (profile.shellTheme !== null)
        parts.push({label: 'Shell', value: profile.shellTheme || 'Default'});
    if (profile.iconTheme !== null)
        parts.push({label: 'Icons', value: profile.iconTheme});
    if (profile.cursorTheme !== null)
        parts.push({label: 'Cursor', value: profile.cursorTheme});
    if (profile.font !== null)
        parts.push({label: 'Font', value: profile.font});
    if (profile.colorScheme !== null) {
        // GNOME Settings writes 'default' for its Light option.
        const value = profile.colorScheme === 'prefer-dark' ? 'Dark' : 'Light';
        parts.push({label: 'Style', value});
    }
    if (profile.accentColor !== null) {
        const value = profile.accentColor === AUTO_ACCENT ? 'Auto' : profile.accentColor;
        parts.push({label: 'Accent', value: value[0].toUpperCase() + value.slice(1)});
    }
    if (profile.palette) {
        const {source, preset, swatch, variant} = profile.palette;
        let value = 'Wallpaper';
        if (source === 'preset')
            value = preset[0].toUpperCase() + preset.slice(1);
        else if (source === 'swatch')
            value = `Swatch ${swatch + 1}`;
        if (variant !== 'vibrant')
            value += `, ${variant}`;
        parts.push({label: 'Palette', value});
    }
    if (profile.widgets) {
        const count = profile.widgets.layout.length;
        parts.push({label: 'Widgets', value: count === 1 ? '1 widget' : `${count} widgets`});
    }
    return parts;
}

/**
 * Keep the desktop's widgets as they are now in the profile in use (they
 * were edited).
 *
 * @param {ProfileStore} store
 * @param {Gio.Settings} desktopSettings
 */
export function keepWidgets(store, desktopSettings) {
    const id = store.activeId;
    if (id && store.get(id))
        store.update(id, {widgets: readWidgets(desktopSettings)});
}

/**
 * Reads and writes the list of profiles kept in the extension's settings.
 */
export class ProfileStore {
    /**
     * @param {Gio.Settings} settings - the extension's settings
     */
    constructor(settings) {
        this._settings = settings;
    }

    /** @returns {Gio.Settings} the extension's settings */
    get settings() {
        return this._settings;
    }

    /** @returns {object[]} */
    getAll() {
        let parsed;
        try {
            parsed = JSON.parse(this._settings.get_string('profiles'));
        } catch {
            return [];
        }
        if (!Array.isArray(parsed))
            return [];

        const seen = new Set();
        return parsed.map(normalizeProfile).filter(profile => {
            if (!profile || seen.has(profile.id))
                return false;
            seen.add(profile.id);
            return true;
        });
    }

    /**
     * @param {string} id
     * @returns {object|null}
     */
    get(id) {
        return this.getAll().find(profile => profile.id === id) ?? null;
    }

    /** @param {object[]} profiles */
    setAll(profiles) {
        this._settings.set_string('profiles', JSON.stringify(profiles));
    }

    /**
     * @param {object} fields
     * @returns {object} the stored profile
     */
    add(fields) {
        return this.addAll([fields])[0];
    }

    /**
     * Add several profiles with a single settings write.
     *
     * @param {object[]} list
     * @returns {object[]} the stored profiles
     */
    addAll(list) {
        const profiles = this.getAll();
        const added = list.map(fields => {
            let id = fields.id || newProfileId();
            while (profiles.some(l => l.id === id))
                id = newProfileId();
            const profile = normalizeProfile({...DEFAULTS, ...fields, id});
            profiles.push(profile);
            return profile;
        });
        this.setAll(profiles);
        return added;
    }

    /**
     * @param {string} id
     * @param {object} changes
     * @returns {object|null} the updated profile
     */
    update(id, changes) {
        const profiles = this.getAll();
        const index = profiles.findIndex(l => l.id === id);
        if (index < 0)
            return null;

        profiles[index] = normalizeProfile({...profiles[index], ...changes, id});
        this.setAll(profiles);
        return profiles[index];
    }

    /**
     * @param {string} id
     * @returns {object|null} the removed profile
     */
    remove(id) {
        const profiles = this.getAll();
        const index = profiles.findIndex(l => l.id === id);
        if (index < 0)
            return null;

        const [removed] = profiles.splice(index, 1);
        this.setAll(profiles);
        if (this.activeId === id)
            this.activeId = '';
        return removed;
    }

    /**
     * @param {string} id
     * @param {number} delta - -1 moves the profile up, 1 down
     */
    move(id, delta) {
        const profiles = this.getAll();
        const from = profiles.findIndex(l => l.id === id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= profiles.length)
            return;

        const [profile] = profiles.splice(from, 1);
        profiles.splice(to, 0, profile);
        this.setAll(profiles);
    }

    get activeId() {
        return this._settings.get_string('active-profile');
    }

    set activeId(id) {
        this._settings.set_string('active-profile', id);
    }
}

/**
 * @param {string} schemaId
 * @returns {Gio.Settings|null} settings for the schema, or null if it isn't installed
 */
export function settingsIfInstalled(schemaId) {
    const schema = Gio.SettingsSchemaSource.get_default()?.lookup(schemaId, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

/**
 * Snapshot the appearance settings that are active right now.
 *
 * @param {Gio.Settings|null} userThemeSettings - settings of the User Themes
 *   extension, or null when it isn't available
 * @returns {object} profile fields (the wallpaper is not imported yet)
 */
export function readCurrentAppearance(userThemeSettings) {
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

    const toPath = uri => uri ? Gio.File.new_for_uri(uri).get_path() : null;
    const light = toPath(background.get_string('picture-uri'));
    const dark = toPath(background.get_string('picture-uri-dark'));

    const accentColor = iface.settings_schema.has_key('accent-color')
        ? iface.get_string('accent-color') : null;

    return {
        wallpaper: light ?? dark,
        wallpaperDark: light && dark !== light ? dark : null,
        pictureOptions: background.get_string('picture-options'),
        colorScheme: iface.get_string('color-scheme'),
        accentColor,
        gtkTheme: iface.get_string('gtk-theme'),
        shellTheme: userThemeSettings ? userThemeSettings.get_string('name') : null,
        iconTheme: iface.get_string('icon-theme'),
        cursorTheme: iface.get_string('cursor-theme'),
        font: iface.get_string('font-name'),
        gtk4: false,
    };
}
