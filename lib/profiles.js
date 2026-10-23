// The profile model and its storage in GSettings.
// Shared by the shell and the preferences: only GLib/Gio may be used here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    LOCK_CLOCK_FACES, LOCK_KINDS, SIZES, normalizeWidgets, parseLayout, readWidgets, serializeLayout,
} from './widgets.js';

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
    lockscreen: null, // the lock screen, see normalizeLockscreen()
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

// The lock screen a profile keeps, as an iPhone keeps each of its lock
// screens (a "poster", tied to a Focus): of the lockscreen settings, its
// widgets and how they look. Whether Atelier is on the lock screen at all,
// its island and password field, the depth effect's models, and the
// requests and statuses hold for every profile.
// [the profile's field, the settings' key, the key's type]
const POSTER = [
    ['widgets', 'widgets', 's'],
    ['style', 'style', 's'],
    ['clockColor', 'clock-color', 's'],
    ['clockFont', 'clock-font', 's'],
    ['clockWeight', 'clock-weight', 'i'],
    ['clockWidth', 'clock-width', 'i'],
    ['gnomeClock', 'gnome-clock', 'b'],
    ['depthEffect', 'depth-effect', 'b'],
];

/** The lockscreen settings' keys each profile has its own of. */
export const POSTER_KEYS = POSTER.map(([, key]) => key);

/** The lock screen's looks and fonts, as its settings have them. */
export const LOCK_STYLES = ['bare', 'modern', 'analogue'];
export const LOCK_FONTS = ['inter', 'flex', 'default', 'rounded', 'serif', 'thin', 'heavy'];

// (As a profile's description says them.)
const LOCK_FONT_NAMES = {
    inter: 'Inter', flex: 'Roboto Flex', default: 'Default font', rounded: 'Rounded', serif: 'Serif',
    thin: 'Thin', heavy: 'Heavy',
};

// (A colour as the lockscreen settings keep one; anything else is "auto".)
const isColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

// (As JSON with the keys of each object in order: the same layout is the
// same text, whatever order its widgets' keys were written in.)
const canonical = value => JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : Number(a > b))))
    : v));

/**
 * @param {object|null} raw - a lock screen as a profile keeps it
 * @returns {object|null} {widgets, style, clockColor, clockFont, clockWeight,
 *   clockWidth, gnomeClock, depthEffect}, every one there and valid: widgets
 *   the layout as parseLayout() makes it (given as that, or as the JSON the
 *   settings keep); null without a layout
 */
export function normalizeLockscreen(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    let json = null;
    if (typeof raw.widgets === 'string')
        json = raw.widgets;
    else if (Array.isArray(raw.widgets))
        json = JSON.stringify(raw.widgets);
    if (json === null)
        return null;
    const whole = (value, most) => (Number.isInteger(value) ? Math.min(most, Math.max(0, value)) : 0);
    return {
        widgets: parseLayout(json, LOCK_KINDS),
        style: LOCK_STYLES.includes(raw.style) ? raw.style : 'bare',
        clockColor: isColor(raw.clockColor) ? raw.clockColor : 'auto',
        clockFont: LOCK_FONTS.includes(raw.clockFont) ? raw.clockFont : 'inter',
        clockWeight: whole(raw.clockWeight, 1000),
        clockWidth: whole(raw.clockWidth, 200),
        gnomeClock: raw.gnomeClock !== false,
        depthEffect: raw.depthEffect === true,
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
    profile.lockscreen = normalizeLockscreen(raw.lockscreen);
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
    const lockscreen = profile.lockscreen && describeLockscreen(profile.lockscreen);
    if (lockscreen)
        parts.push({label: 'Lock screen', value: lockscreen});
    return parts;
}

/**
 * @param {object} lockscreen - as a profile keeps it
 * @returns {string|null} its biggest clock and its font in brief, e.g.
 *   "Glass clock, Inter"; null for GNOME's lock screen as it is
 */
function describeLockscreen({widgets, clockFont, clockWeight, gnomeClock, depthEffect}) {
    if (widgets.length === 0)
        return gnomeClock ? null : 'No clock';
    const cells = ({size}) => SIZES[size][0] * SIZES[size][1];
    const [clock] = widgets.filter(entry => entry.kind === 'clock').sort((a, b) => cells(b) - cells(a));
    let first = widgets.length === 1 ? '1 widget' : `${widgets.length} widgets`;
    if (clock) {
        const face = LOCK_CLOCK_FACES.find(([id]) => id === clock.face && id !== 'auto')?.[1];
        first = face ? `${face} clock` : 'Clock';
    }
    const font = LOCK_FONT_NAMES[clockFont];
    return [first, clockWeight > 0 ? `${font} ${clockWeight}` : font, depthEffect && 'depth effect']
        .filter(Boolean).join(', ');
}

/**
 * Give every profile that has no widgets yet (from before profiles kept
 * them, or imported) its own copy of the widgets on the desktop now, so
 * each goes its own way from here.
 *
 * @param {ProfileStore} store
 * @param {Gio.Settings} desktopSettings
 * @returns {number} how many profiles got them
 */
export function giveWidgets(store, desktopSettings) {
    const profiles = store.getAll();
    const without = profiles.filter(profile => !profile.widgets);
    if (without.length > 0) {
        const widgets = readWidgets(desktopSettings);
        store.setAll(profiles.map(profile => (profile.widgets ? profile : {...profile, widgets})));
    }
    return without.length;
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
 * The lock screen as a profile keeps it.
 *
 * @param {Gio.Settings} settings - the lockscreen ones
 * @returns {object} see normalizeLockscreen()
 */
export function readLockscreen(settings) {
    return normalizeLockscreen(Object.fromEntries(
        POSTER.map(([field, key]) => [field, settings.get_value(key).unpack()])));
}

/**
 * Show a profile's lock screen: what differs of it is written into the
 * lockscreen settings, so that neither dconf nor what follows these keys
 * (the lock screen's board, the depth module) has anything to do for the
 * rest.
 *
 * @param {Gio.Settings} settings - the lockscreen ones
 * @param {object} lockscreen - as a profile keeps it
 * @returns {string[]} the keys written
 */
export function writeLockscreen(settings, lockscreen) {
    const poster = normalizeLockscreen(lockscreen);
    if (!poster)
        return [];
    const written = [];
    for (const [field, key, type] of POSTER) {
        let value = poster[field];
        if (field === 'widgets') {
            if (canonical(parseLayout(settings.get_string(key), LOCK_KINDS)) === canonical(value))
                continue;
            value = serializeLayout(value);
        } else if (settings.get_value(key).unpack() === value) {
            continue;
        }
        settings.set_value(key, new GLib.Variant(type, value));
        written.push(key);
    }
    return written;
}

/**
 * Give every profile that has no lock screen yet (from before profiles kept
 * one, or imported) its own copy of the lock screen there is now, so each
 * goes its own way from here.
 *
 * @param {ProfileStore} store
 * @param {Gio.Settings} lockSettings
 * @returns {number} how many profiles got it
 */
export function giveLockscreen(store, lockSettings) {
    const profiles = store.getAll();
    const without = profiles.filter(profile => !profile.lockscreen);
    if (without.length > 0) {
        const lockscreen = readLockscreen(lockSettings);
        store.setAll(profiles.map(profile => (profile.lockscreen ? profile : {...profile, lockscreen})));
    }
    return without.length;
}

/**
 * Keep the lock screen as it is now in the profile in use (it was edited).
 *
 * @param {ProfileStore} store
 * @param {Gio.Settings} lockSettings
 * @returns {boolean} whether the profile changed (it may have it already)
 */
export function keepLockscreen(store, lockSettings) {
    const profile = store.get(store.activeId);
    if (!profile)
        return false;
    const lockscreen = readLockscreen(lockSettings);
    if (canonical(lockscreen) === canonical(profile.lockscreen))
        return false;
    store.update(profile.id, {lockscreen});
    return true;
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
