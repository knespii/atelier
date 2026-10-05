// The profiles feature: applying profiles, the switcher (profiles and the
// wallpaper folder), its top bar button, shortcuts, requests from the
// preferences, live profiles and the first-run "Original".

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LEGACY_UUID} from '../lib/migrate.js';
import {
    deleteWallpaperIfUnused, importWallpaper, listWallpapers, prettyName, wallpaperFolder,
} from '../lib/paths.js';
import {normalizeProfile, readCurrentAppearance} from '../lib/profiles.js';
import {USER_THEME_UUID, getUserThemeSettings} from '../lib/themes.js';
import {ensureThumbnail, removeThumbnail} from '../lib/thumbnails.js';
import {Applier} from './applier.js';
import {ProfileSync} from './core/profileSync.js';
import {Indicator} from './indicator.js';
import {WallpaperTransition} from './reveal.js';
import {SwitcherPopup} from './switcher.js';
import {SwitcherContent} from './switcherContent.js';

const KEYBINDINGS = [
    'atelier-open-switcher', 'atelier-open-wallpapers', 'atelier-next-profile', 'atelier-previous-profile',
];

export class ProfilesModule {
    /**
     * @param {object} context
     * @param {object} context.extension - the Extension object
     * @param {Gio.Settings} context.settings
     * @param {ProfileStore} context.store
     */
    constructor({extension, settings, store, modules}) {
        this._extension = extension;
        this._settings = settings;
        this._store = store;
        this._modules = modules;
        this._switcher = null;
        this._indicator = null;
        this._originalPending = false;
        // The profile being switched to, until it is applied.
        this._target = null;
    }

    /** @returns {Applier} applies profiles; other modules may use it */
    get applier() {
        return this._applier;
    }

    enable() {
        this._applier = new Applier(this._settings);
        this._applier.transition = new WallpaperTransition(this._settings);
        this._sync = new ProfileSync({
            settings: this._settings,
            store: this._store,
            isBusy: () => this._applier?.busy ?? false,
        });
        this._sync.enable();

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
                modes | Shell.ActionMode.POPUP, () => this.toggleSwitcher('profiles'));
            Main.wm.addKeybinding('atelier-open-wallpapers', this._settings, flags,
                modes | Shell.ActionMode.POPUP, () => this.toggleSwitcher('wallpapers'));
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
        this._target = null;
        this._sync.disable();
        this._sync = null;
        this._applier.destroy();
        this._applier = null;
        this._settings.disconnectObject(this);
    }

    /**
     * Open the switcher on a tab, switch tabs, or close it when it already
     * shows that tab.
     *
     * @param {string} mode - 'profiles' or 'wallpapers'
     */
    toggleSwitcher(mode = 'profiles') {
        if (this._switcher) {
            if (this._switcher.mode === mode)
                this._switcher.close();
            else
                this._switcher.setMode(mode);
            return;
        }
        // Don't stack on top of another popup (e.g. an open menu).
        if (Main.actionMode === Shell.ActionMode.POPUP)
            return;
        if (Main.overview.visible)
            Main.overview.hide();

        const switcher = new SwitcherContent(mode);
        switcher.setProfiles(this._store.getAll(), this._store.activeId);
        switcher.connect('activate', (_, tab, id) => {
            if (tab === 'profiles')
                this._applyFromSwitcher(switcher, id);
            else
                this._applyWallpaper(switcher, id);
        });
        switcher.connect('mode-changed', (_, tab) => {
            if (tab === 'wallpapers' && !switcher.wallpapersLoaded)
                this._loadWallpapers(switcher);
        });
        switcher.connect('destroy', () => {
            if (this._switcher === switcher)
                this._switcher = null;
        });
        this._switcher = switcher;
        if (mode === 'wallpapers')
            this._loadWallpapers(switcher);

        // The island shows the switcher in itself; without it, a popup does.
        const island = this._modules?.get('island');
        if (!island?.showSwitcher(switcher))
            new SwitcherPopup(switcher).open();
    }

    async _loadWallpapers(switcher) {
        const folder = wallpaperFolder(this._settings);
        // The default folder is created, so there's an obvious place for pictures.
        const paths = await listWallpapers(folder, {create: !this._settings.get_string('wallpaper-folder')})
            .catch(() => []);
        const uri = new Gio.Settings({schema_id: 'org.gnome.desktop.background'}).get_string('picture-uri');
        switcher.setWallpapers(paths, uri ? Gio.File.new_for_uri(uri).get_path() : null, folder);
    }

    _applyFromSwitcher(switcher, id) {
        const profile = this._store.get(id);
        if (!profile)
            return;
        switcher.setActive(id);
        this._switchTo(profile, switcher).catch(e => console.error('Atelier: switching failed', e));
    }

    /**
     * Switch to a profile. The island announces it first (the switcher, if
     * open, turns into the announcement) and the heavy part – wallpaper,
     * themes, colors – starts once that has opened, so it opens right away
     * and smoothly. Without the island, the switcher stays up while the new
     * wallpaper is revealed and closes once the profile is in place.
     *
     * @param {object} profile
     * @param {SwitcherContent} [switcher]
     */
    async _switchTo(profile, switcher = null) {
        this._target = profile.id;
        const island = this._modules?.get('island');
        const announced = island ? await island.announceProfile(profile) : false;
        // A newer switch took over meanwhile, or Atelier was turned off.
        if (this._target !== profile.id || !this._applier)
            return;

        const close = () => switcher?.close();
        try {
            await this._applier.apply(profile, announced ? {} : {onWritten: close});
        } finally {
            close();
            if (this._target === profile.id)
                this._target = null;
        }
    }

    /**
     * Show a picture of the wallpaper folder and keep it in the active profile.
     *
     * @param {Switcher} switcher
     * @param {string} path
     */
    async _applyWallpaper(switcher, path) {
        switcher.setActive(path);
        let copy;
        try {
            // The profile keeps its own copy, like any wallpaper it stores.
            copy = await importWallpaper(path);
        } catch (e) {
            Main.notifyError('Atelier', `Could not use ${prettyName(path)}: ${e.message}`);
            switcher.close();
            return;
        }
        if (!this._applier)
            return;

        const active = this._store.get(this._store.activeId);
        const options = active?.pictureOptions ??
            new Gio.Settings({schema_id: 'org.gnome.desktop.background'}).get_string('picture-options');
        const wallpaperOnly = normalizeProfile({
            id: 'atelier-wallpaper', name: prettyName(path), wallpaper: copy, pictureOptions: options,
        });
        if (active)
            this._store.update(active.id, {wallpaper: copy, wallpaperDark: null});

        await this._applier.apply(wallpaperOnly, {onWritten: () => switcher.close(), keepActive: true})
            .finally(() => switcher.close());

        // Once the desktop shows the new picture, drop copies nobody uses.
        const profiles = this._store?.getAll() ?? [];
        for (const old of [active?.wallpaper, active?.wallpaperDark]) {
            if (old && old !== copy && await deleteWallpaperIfUnused(old, profiles))
                removeThumbnail(old);
        }
        ensureThumbnail(copy).catch(() => {});
    }

    _step(delta) {
        const profiles = this._store.getAll();
        if (profiles.length === 0)
            return;
        // While a profile is still on its way, step from it rather than from
        // the active one, so quick presses move one profile each.
        const from = this._target ?? this._applier.targetId ?? this._store.activeId;
        const current = profiles.findIndex(profile => profile.id === from);
        const index = current < 0
            ? (delta > 0 ? 0 : profiles.length - 1)
            : (current + delta + profiles.length) % profiles.length;
        this._switchTo(profiles[index]).catch(e => console.error('Atelier: switching failed', e));
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
            this._switchTo(profile).catch(e => console.error('Atelier: switching failed', e));
    }

    _syncIndicator() {
        const show = this._settings.get_boolean('show-indicator');
        if (show && !this._indicator) {
            this._indicator = new Indicator(this._extension.path);
            this._indicator.connect('activate', () => this.toggleSwitcher('profiles'));
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
