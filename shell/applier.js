// Applies a profile: wallpaper, interface settings, shell theme and the GTK 4
// theme for libadwaita apps.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {hasGtk4Support} from '../lib/gtkCss.js';
import {AUTO_ACCENT, ProfileStore, effectiveWallpaper, isAccentColor} from '../lib/profiles.js';
import {USER_THEME_UUID, getUserThemeSettings, locateTheme} from '../lib/themes.js';
import {paletteForWallpaper, readPaletteOptions} from '../lib/wallpaperPalette.js';
import {serializeLayout} from '../lib/widgets.js';

const THEME_FIELDS = [
    // [kind for locateTheme, profile field, org.gnome.desktop.interface key, label]
    ['gtk', 'gtkTheme', 'gtk-theme', 'GTK theme'],
    ['icons', 'iconTheme', 'icon-theme', 'Icon theme'],
    ['cursors', 'cursorTheme', 'cursor-theme', 'Cursor theme'],
];

function setIfChanged(settings, key, value) {
    if (settings.get_string(key) !== value)
        settings.set_string(key, value);
}

export class Applier {
    /**
     * @param {Gio.Settings} settings - the extension's settings
     */
    constructor(settings) {
        this._settings = settings;
        this._store = new ProfileStore(settings);
        this._next = null;
        this._running = null;
        this._targetId = null;
        this._destroyed = false;

        /** Optional wallpaper transition, see reveal.js */
        this.transition = null;
        /** Called right before a profile's settings are written (by other modules) */
        this.beforeWrite = new Set();
    }

    destroy() {
        this._destroyed = true;
        this._next = null;
        this.transition?.abort();
        this.transition = null;
    }

    /** @returns {boolean} whether a profile is being applied right now */
    get busy() {
        return this._running !== null;
    }

    /** @returns {string|null} the newest profile requested while busy */
    get targetId() {
        return this._targetId;
    }

    /**
     * Apply a profile. While one is being applied, only the newest request is
     * kept and runs afterwards, so mashing the shortcut can't pile up work.
     *
     * @param {object} profile
     * @param {object} [options]
     * @param {boolean} [options.animate] - play the wallpaper transition
     * @param {Function} [options.onWritten] - called once the settings are
     *   written (after the transition, before GNOME finished updating)
     * @param {boolean} [options.keepActive] - don't make it the active profile
     *   (used to show just a wallpaper)
     * @returns {Promise<void>} resolves when no request is left
     */
    apply(profile, {animate = true, onWritten = null, keepActive = false} = {}) {
        this._next = {profile, animate, onWritten, keepActive};
        this._targetId = profile.id;
        this._running ??= this._drain().finally(() => {
            this._running = null;
            this._targetId = null;
        });
        return this._running;
    }

    async _drain() {
        while (this._next && !this._destroyed) {
            const {profile, animate, onWritten, keepActive} = this._next;
            this._next = null;
            try {
                await this._applyOne(profile, animate, onWritten, keepActive);
            } catch (e) {
                console.error(`Atelier: applying “${profile.name}” failed`, e);
                Main.notifyError('Atelier', `Could not apply “${profile.name}”: ${e.message}`);
            }
        }
    }

    async _applyOne(profile, animate, onWritten, keepActive) {
        const problems = [];
        const plan = await this._resolve(profile, problems);
        if (this._destroyed)
            return;

        // Play the transition with the old settings still in place, then
        // switch everything at once while the new wallpaper is on screen.
        let finishTransition = null;
        if (plan.background && animate && this.transition)
            finishTransition = await this.transition.reveal(plan.background.shown, plan.background.options);

        let notes = [];
        try {
            if (this._destroyed)
                return;
            for (const callback of this.beforeWrite) {
                try {
                    callback();
                } catch (e) {
                    console.error('Atelier: before applying a profile', e);
                }
            }
            this._write(plan);
            if (!keepActive)
                this._store.activeId = profile.id;
            onWritten?.();
            notes = this._syncGtk4(profile, plan, problems);
        } finally {
            // Whatever failed, the overlay must not stay over the desktop.
            await finishTransition?.();
        }

        if (problems.length > 0)
            Main.notify(`Atelier: “${profile.name}” was applied partially`, problems.join('\n'));
        else if (notes.length > 0)
            Main.notify(`Atelier: “${profile.name}” applied`, notes.join('\n'));
    }

    async _resolve(profile, problems) {
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const plan = {
            background: null, iface: {}, shellTheme: null, gtkThemeDir: null,
            palette: profile.palette, widgets: profile.widgets,
        };
        const scheme = profile.colorScheme ?? iface.get_string('color-scheme');

        if (profile.wallpaper) {
            const file = Gio.File.new_for_path(profile.wallpaper);
            let darkFile = profile.wallpaperDark ? Gio.File.new_for_path(profile.wallpaperDark) : null;
            if (darkFile && !darkFile.query_exists(null)) {
                problems.push(`Dark wallpaper not found: ${profile.wallpaperDark}`);
                darkFile = null;
            }
            if (file.query_exists(null)) {
                const shown = effectiveWallpaper(
                    {wallpaper: profile.wallpaper, wallpaperDark: darkFile?.get_path() ?? null}, scheme);
                plan.background = {
                    file,
                    darkFile,
                    shown: Gio.File.new_for_path(shown),
                    options: profile.pictureOptions,
                };
            } else {
                problems.push(`Wallpaper not found: ${profile.wallpaper}`);
            }
        }

        if (profile.colorScheme !== null)
            plan.iface['color-scheme'] = profile.colorScheme;

        if (profile.accentColor !== null && iface.settings_schema.has_key('accent-color')) {
            let accent = profile.accentColor;
            if (accent === AUTO_ACCENT) {
                // The same palette the shell will compute once the wallpaper is set.
                const shown = plan.background?.shown.get_path();
                accent = shown
                    ? (await paletteForWallpaper(shown,
                        profile.palette ?? readPaletteOptions(this._settings.get_child('palette')))).accent
                    : null;
            }
            if (isAccentColor(accent))
                plan.iface['accent-color'] = accent;
        }

        for (const [kind, field, key, label] of THEME_FIELDS) {
            if (profile[field] === null)
                continue;
            const dir = await locateTheme(kind, profile[field]);
            if (dir === null) {
                problems.push(`${label} “${profile[field]}” is not installed`);
                continue;
            }
            plan.iface[key] = profile[field];
            if (kind === 'gtk')
                plan.gtkThemeDir = dir;
        }

        if (profile.font !== null)
            plan.iface['font-name'] = profile.font;

        if (profile.shellTheme !== null) {
            const userThemes = Main.extensionManager.lookup(USER_THEME_UUID);
            if (userThemes?.state !== ExtensionState.ACTIVE) {
                // Without User Themes the default shell theme is in effect anyway.
                if (profile.shellTheme !== '')
                    problems.push('Shell theme skipped: the User Themes extension is not enabled');
            } else if (await locateTheme('shell', profile.shellTheme) === null)
                problems.push(`Shell theme “${profile.shellTheme}” is not installed`);
            else
                plan.shellTheme = profile.shellTheme;
        }

        return plan;
    }

    _write(plan) {
        // Palette options first, so the palette computed for the new
        // wallpaper already uses them.
        if (plan.palette) {
            const palette = this._settings.get_child('palette');
            palette.delay();
            setIfChanged(palette, 'source', plan.palette.source);
            if (palette.get_int('swatch') !== plan.palette.swatch)
                palette.set_int('swatch', plan.palette.swatch);
            setIfChanged(palette, 'preset', plan.palette.preset);
            setIfChanged(palette, 'variant', plan.palette.variant);
            palette.apply();
        }

        // Background keys and color-scheme each make the shell reload the
        // wallpaper; writing them in one go lets it coalesce the reloads.
        if (plan.background) {
            const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
            const {file, darkFile} = plan.background;
            background.delay();
            setIfChanged(background, 'picture-uri', file.get_uri());
            setIfChanged(background, 'picture-uri-dark', (darkFile ?? file).get_uri());
            setIfChanged(background, 'picture-options', plan.background.options);
            background.apply();
        }

        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        iface.delay();
        for (const [key, value] of Object.entries(plan.iface))
            setIfChanged(iface, key, value);
        iface.apply();

        if (plan.shellTheme !== null) {
            const userTheme = getUserThemeSettings();
            if (userTheme)
                setIfChanged(userTheme, 'name', plan.shellTheme);
        }

        // The profile's widgets on the desktop.
        if (plan.widgets) {
            const desktop = this._settings.get_child('desktop');
            setIfChanged(desktop, 'widgets', serializeLayout(plan.widgets.layout));
            setIfChanged(desktop, 'style', plan.widgets.style);
            if (desktop.get_boolean('glass') !== plan.widgets.glass)
                desktop.set_boolean('glass', plan.widgets.glass);
        }
    }

    /**
     * Choose the GTK 4 theme imported for libadwaita apps; the palette module
     * writes the stylesheet.
     *
     * @returns {string[]} notes for the user
     */
    _syncGtk4(profile, plan, problems) {
        // A profile that leaves the GTK theme alone leaves GTK 4 apps alone too.
        if (profile.gtkTheme === null || !plan.iface['gtk-theme'])
            return [];

        let theme = '';
        if (profile.gtk4) {
            if (hasGtk4Support(plan.gtkThemeDir))
                theme = plan.gtkThemeDir;
            else
                problems.push(`GTK 4 apps were not themed: “${profile.gtkTheme}” has no GTK 4 version`);
        }
        if (this._settings.get_string('gtk4-theme') === theme)
            return [];
        this._settings.set_string('gtk4-theme', theme);
        return [theme
            ? 'Restart open apps to see the GTK 4 theme.'
            : 'Restart open apps to bring back their default GTK 4 look.'];
    }
}
