// The look model and its storage in GSettings.
// Shared by the shell and the preferences: only GLib/Gio may be used here.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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
 * Fields of a look. For every field except id, name, wallpaper and gtk4,
 * null means "leave the current setting alone" when the look is applied.
 */
const DEFAULTS = {
    id: '',
    name: 'Untitled look',
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
    gtk4: false, // also link the GTK theme's gtk-4.0 stylesheet for libadwaita apps
};

const nullableString = v => typeof v === 'string' ? v : null;

/**
 * @param {object} raw - a look as parsed from JSON
 * @returns {object|null} a look with every field present and valid, or null
 */
export function normalizeLook(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id)
        return null;

    const look = {...DEFAULTS};
    look.id = raw.id;
    look.name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : DEFAULTS.name;
    look.wallpaper = nullableString(raw.wallpaper) || null;
    const dark = nullableString(raw.wallpaperDark) || null;
    look.wallpaperDark = look.wallpaper && dark !== look.wallpaper ? dark : null;
    look.pictureOptions = PICTURE_OPTIONS.includes(raw.pictureOptions)
        ? raw.pictureOptions : DEFAULTS.pictureOptions;
    look.colorScheme = COLOR_SCHEMES.includes(raw.colorScheme) ? raw.colorScheme : null;
    look.accentColor = raw.accentColor === AUTO_ACCENT || isAccentColor(raw.accentColor)
        ? raw.accentColor : null;
    for (const key of ['gtkTheme', 'shellTheme', 'iconTheme', 'cursorTheme', 'font'])
        look[key] = nullableString(raw[key]);
    look.gtk4 = raw.gtk4 === true;
    return look;
}

/**
 * The wallpaper GNOME shows for a look.
 *
 * @param {object} look
 * @param {string} colorScheme - the color-scheme in effect once it is applied
 * @returns {string|null}
 */
export function effectiveWallpaper(look, colorScheme) {
    return colorScheme === 'prefer-dark' && look.wallpaperDark ? look.wallpaperDark : look.wallpaper;
}

/** @returns {string} a short random id */
export function newLookId() {
    return GLib.uuid_string_random().slice(0, 8);
}

/**
 * @param {object} look
 * @returns {{label: string, value: string}[]} the non-default parts of a look
 */
export function describeLook(look) {
    const parts = [];
    if (look.gtkTheme !== null)
        parts.push({label: 'GTK', value: look.gtkTheme});
    if (look.shellTheme !== null)
        parts.push({label: 'Shell', value: look.shellTheme || 'Default'});
    if (look.iconTheme !== null)
        parts.push({label: 'Icons', value: look.iconTheme});
    if (look.cursorTheme !== null)
        parts.push({label: 'Cursor', value: look.cursorTheme});
    if (look.font !== null)
        parts.push({label: 'Font', value: look.font});
    if (look.colorScheme !== null) {
        // GNOME Settings writes 'default' for its Light option.
        const value = look.colorScheme === 'prefer-dark' ? 'Dark' : 'Light';
        parts.push({label: 'Style', value});
    }
    if (look.accentColor !== null) {
        const value = look.accentColor === AUTO_ACCENT ? 'Auto' : look.accentColor;
        parts.push({label: 'Accent', value: value[0].toUpperCase() + value.slice(1)});
    }
    return parts;
}

/**
 * Reads and writes the list of looks kept in the extension's settings.
 */
export class LookStore {
    /**
     * @param {Gio.Settings} settings - the extension's settings
     */
    constructor(settings) {
        this._settings = settings;
    }

    /** @returns {object[]} */
    getAll() {
        let parsed;
        try {
            parsed = JSON.parse(this._settings.get_string('looks'));
        } catch {
            return [];
        }
        if (!Array.isArray(parsed))
            return [];

        const seen = new Set();
        return parsed.map(normalizeLook).filter(look => {
            if (!look || seen.has(look.id))
                return false;
            seen.add(look.id);
            return true;
        });
    }

    /**
     * @param {string} id
     * @returns {object|null}
     */
    get(id) {
        return this.getAll().find(look => look.id === id) ?? null;
    }

    /** @param {object[]} looks */
    setAll(looks) {
        this._settings.set_string('looks', JSON.stringify(looks));
    }

    /**
     * @param {object} fields
     * @returns {object} the stored look
     */
    add(fields) {
        return this.addAll([fields])[0];
    }

    /**
     * Add several looks with a single settings write.
     *
     * @param {object[]} list
     * @returns {object[]} the stored looks
     */
    addAll(list) {
        const looks = this.getAll();
        const added = list.map(fields => {
            let id = fields.id || newLookId();
            while (looks.some(l => l.id === id))
                id = newLookId();
            const look = normalizeLook({...DEFAULTS, ...fields, id});
            looks.push(look);
            return look;
        });
        this.setAll(looks);
        return added;
    }

    /**
     * @param {string} id
     * @param {object} changes
     * @returns {object|null} the updated look
     */
    update(id, changes) {
        const looks = this.getAll();
        const index = looks.findIndex(l => l.id === id);
        if (index < 0)
            return null;

        looks[index] = normalizeLook({...looks[index], ...changes, id});
        this.setAll(looks);
        return looks[index];
    }

    /**
     * @param {string} id
     * @returns {object|null} the removed look
     */
    remove(id) {
        const looks = this.getAll();
        const index = looks.findIndex(l => l.id === id);
        if (index < 0)
            return null;

        const [removed] = looks.splice(index, 1);
        this.setAll(looks);
        if (this.activeId === id)
            this.activeId = '';
        return removed;
    }

    /**
     * @param {string} id
     * @param {number} delta - -1 moves the look up, 1 down
     */
    move(id, delta) {
        const looks = this.getAll();
        const from = looks.findIndex(l => l.id === id);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= looks.length)
            return;

        const [look] = looks.splice(from, 1);
        looks.splice(to, 0, look);
        this.setAll(looks);
    }

    get activeId() {
        return this._settings.get_string('active-look');
    }

    set activeId(id) {
        this._settings.set_string('active-look', id);
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
 * @returns {object} look fields (the wallpaper is not imported yet)
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
