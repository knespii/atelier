// The profiles feature: applying profiles, the switcher, its top bar button,
// shortcuts, requests from the preferences and the first-run "Original".

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LEGACY_UUID} from '../lib/migrate.js';
import {deleteWallpaperIfUnused, importWallpaper} from '../lib/paths.js';
import {readCurrentAppearance} from '../lib/profiles.js';
import {USER_THEME_UUID, getUserThemeSettings} from '../lib/themes.js';
import {ensureThumbnail} from '../lib/thumbnails.js';
import {Applier} from './applier.js';
import {Indicator} from './indicator.js';
import {WallpaperTransition} from './reveal.js';
import {ProfileSwitcher} from './switcher.js';

const KEYBINDINGS = ['atelier-open-switcher', 'atelier-next-profile', 'atelier-previous-profile'];

export class ProfilesModule {
    /**
     * @param {object} context
     * @param {object} context.extension - the Extension object
     * @param {Gio.Settings} context.settings
     * @param {ProfileStore} context.store
     */
    constructor({extension, settings, store}) {
        this._extension = extension;
        this._settings = settings;
        this._store = store;
        this._switcher = null;
        this._indicator = null;
        this._originalPending = false;
    }

    /** @returns {Applier} applies profiles; other modules may use it */
    get applier() {
        return this._applier;
    }

    enable() {
        this._applier = new Applier(this._settings);
        this._applier.transition = new WallpaperTransition(this._settings);

        this._settings.connectObject(
            'changed::show-indicator', () => this._syncIndicator(),
            'changed::apply-request', () => this._onApplyRequest(),
            'changed::profiles', () => this._switcher?.setProfiles(this._store.getAll(), this._store.activeId),
            'changed::active-profile', () => this._switcher?.setActive(this._store.activeId),
            this);
        this._syncIndicator();

        // Both extensions would grab the same keys while BG Changer still runs.
        if (Main.extensionManager.lookup(LEGACY_UUID)?.state === ExtensionState.ACTIVE) {
            Main.notify('Atelier has taken over BG Changer',
                'Your profiles are in Atelier now. Disable BG Changer in Extensions, then log out and back in for the shortcuts to work.');
        } else {
            const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
            const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
            // POPUP lets the shortcut close the switcher it opened.
            Main.wm.addKeybinding('atelier-open-switcher', this._settings, flags,
                modes | Shell.ActionMode.POPUP, () => this.toggleSwitcher());
            Main.wm.addKeybinding('atelier-next-profile', this._settings, flags, modes, () => this._step(1));
            Main.wm.addKeybinding('atelier-previous-profile', this._settings, flags, modes, () => this._step(-1));
        }

        if (!this._settings.get_boolean('first-run-done') && !this._originalPending) {
            this._originalPending = true;
            this._createOriginalProfile()
                .catch(e => console.error('Atelier: could not save the original profile', e))
                .finally(() => (this._originalPending = false));
        }
    }

    disable() {
        for (const name of KEYBINDINGS)
            Main.wm.removeKeybinding(name);

        this._switcher?.destroy();
        this._switcher = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._applier.destroy();
        this._applier = null;
        this._settings.disconnectObject(this);
    }

    toggleSwitcher() {
        if (this._switcher) {
            this._switcher.close();
            return;
        }
        // Don't stack on top of another popup (e.g. an open menu).
        if (Main.actionMode === Shell.ActionMode.POPUP)
            return;
        if (Main.overview.visible)
            Main.overview.hide();

        const switcher = new ProfileSwitcher();
        switcher.setProfiles(this._store.getAll(), this._store.activeId);
        switcher.connect('activate', (_, id) => this._applyFromSwitcher(switcher, id));
        switcher.connect('destroy', () => {
            if (this._switcher === switcher)
                this._switcher = null;
        });
        this._switcher = switcher;
        switcher.open();
    }

    _applyFromSwitcher(switcher, id) {
        const profile = this._store.get(id);
        if (!profile)
            return;
        switcher.setActive(id);
        // Keep the panel up while the new wallpaper is revealed, like a
        // dynamic island, and close it once the profile is in place.
        this._applier.apply(profile, {onWritten: () => switcher.close()})
            .finally(() => switcher.close());
    }

    _step(delta) {
        const profiles = this._store.getAll();
        if (profiles.length === 0)
            return;
        // While a profile is still being applied, step from it rather than from
        // the active one, so quick presses don't apply the same profile twice.
        const from = this._applier.targetId ?? this._store.activeId;
        const current = profiles.findIndex(profile => profile.id === from);
        const index = current < 0
            ? (delta > 0 ? 0 : profiles.length - 1)
            : (current + delta + profiles.length) % profiles.length;
        this._applier.apply(profiles[index]);
    }

    _onApplyRequest() {
        let request;
        try {
            request = JSON.parse(this._settings.get_string('apply-request'));
        } catch {
            return;
        }
        const profile = request?.id ? this._store.get(request.id) : null;
        if (profile)
            this._applier.apply(profile);
    }

    _syncIndicator() {
        const show = this._settings.get_boolean('show-indicator');
        if (show && !this._indicator) {
            this._indicator = new Indicator(this._extension.path);
            this._indicator.connect('activate', () => this.toggleSwitcher());
            Main.panel.addToStatusArea(this._extension.uuid, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    /**
     * Save the setup the user had before installing the extension, so there
     * is always a way back.
     */
    async _createOriginalProfile() {
        const userThemesActive =
            Main.extensionManager.lookup(USER_THEME_UUID)?.state === ExtensionState.ACTIVE;
        const current = readCurrentAppearance(userThemesActive ? getUserThemeSettings() : null);

        const copy = path => importWallpaper(path).catch(e => {
            console.warn(`Atelier: could not copy ${path}: ${e.message}`);
            return null;
        });
        const wallpaper = current.wallpaper ? await copy(current.wallpaper) : null;
        const wallpaperDark = wallpaper && current.wallpaperDark ? await copy(current.wallpaperDark) : null;

        if (!this._applier) {
            // Disabled meanwhile: drop the copies, the next enable starts over.
            for (const path of [wallpaper, wallpaperDark].filter(Boolean))
                await deleteWallpaperIfUnused(path, []).catch(() => {});
            return;
        }

        const profile = this._store.add({...current, wallpaper, wallpaperDark, name: 'Original'});
        this._store.activeId = profile.id;
        // Only now: an interrupted first run is retried on the next enable.
        this._settings.set_boolean('first-run-done', true);
        if (wallpaper)
            ensureThumbnail(wallpaper).catch(() => {});
    }
}
