// Live profiles: changes made while a profile is active (another wallpaper,
// light/dark, themes, palette options) are saved into that profile, whether
// they come from Atelier or from GNOME Settings.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {deleteWallpaperIfUnused, importWallpaper} from '../../lib/paths.js';
import {profileChanges, readCurrentAppearance} from '../../lib/profiles.js';
import {USER_THEME_UUID, getUserThemeSettings} from '../../lib/themes.js';
import {ensureThumbnail, removeThumbnail} from '../../lib/thumbnails.js';
import {readPaletteOptions} from '../../lib/wallpaperPalette.js';

const SYNC_DELAY = 1000; // ms; several settings usually change together

const WATCHED = {
    'org.gnome.desktop.background': ['picture-uri', 'picture-uri-dark', 'picture-options'],
    'org.gnome.desktop.interface': [
        'color-scheme', 'accent-color', 'gtk-theme', 'icon-theme', 'cursor-theme', 'font-name',
    ],
};

export class ProfileSync {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings - Atelier's settings
     * @param {ProfileStore} params.store
     * @param {Function} params.isBusy - whether a profile is being applied
     */
    constructor({settings, store, isBusy}) {
        this._settings = settings;
        this._store = store;
        this._isBusy = isBusy;
        this._timeoutId = 0;
        this._watched = [];
        this._enabled = false;
    }

    enable() {
        this._enabled = true;
        for (const [schema, keys] of Object.entries(WATCHED)) {
            const settings = new Gio.Settings({schema_id: schema});
            for (const key of keys) {
                if (settings.settings_schema.has_key(key))
                    settings.connectObject(`changed::${key}`, () => this._queue(), this);
            }
            this._watched.push(settings);
        }
        const userTheme = getUserThemeSettings();
        if (userTheme) {
            userTheme.connectObject('changed::name', () => this._queue(), this);
            this._watched.push(userTheme);
        }
        this._paletteSettings = this._settings.get_child('palette');
        this._paletteSettings.connectObject('changed', (_, key) => {
            if (['source', 'swatch', 'preset', 'variant'].includes(key))
                this._queue();
        }, this);
        this._watched.push(this._paletteSettings);
    }

    disable() {
        this._enabled = false;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._watched.forEach(settings => settings.disconnectObject(this));
        this._watched = [];
        this._paletteSettings = null;
    }

    _queue() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SYNC_DELAY, () => {
            this._timeoutId = 0;
            this._sync().catch(e => console.warn(`Atelier: profile not updated: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _sync() {
        // Settings written while applying a profile are the profile's own.
        if (this._isBusy()) {
            this._queue();
            return;
        }
        const profile = this._store.get(this._store.activeId);
        if (!profile)
            return;

        const userThemesActive =
            Main.extensionManager.lookup(USER_THEME_UUID)?.state === ExtensionState.ACTIVE;
        const current = readCurrentAppearance(userThemesActive ? getUserThemeSettings() : null);
        const changes = profileChanges(profile, current, readPaletteOptions(this._paletteSettings));
        if (Object.keys(changes).length === 0)
            return;

        // A wallpaper set from elsewhere may be overwritten later (the
        // wallpaper portal reuses one file), so the profile keeps a copy.
        if ('wallpaper' in changes) {
            changes.wallpaper = await importWallpaper(changes.wallpaper);
            if (changes.wallpaperDark)
                changes.wallpaperDark = await importWallpaper(changes.wallpaperDark);
        }
        if (!this._enabled || this._store.activeId !== profile.id || this._isBusy())
            return;

        this._store.update(profile.id, changes);
        if ('wallpaper' in changes) {
            ensureThumbnail(changes.wallpaper).catch(() => {});
            const profiles = this._store.getAll();
            for (const old of [profile.wallpaper, profile.wallpaperDark]) {
                if (old && old !== changes.wallpaper && old !== changes.wallpaperDark &&
                    await deleteWallpaperIfUnused(old, profiles))
                    removeThumbnail(old);
            }
        }
    }
}
