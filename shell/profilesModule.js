// The profiles feature: applying profiles, the switcher (profiles and the
// wallpaper folder), its top bar button, shortcuts, requests from the
// preferences, saving the current setup and the first-run "Original".
// Profiles stay as they were saved: a wallpaper picked for now, or anything
// changed in GNOME Settings, leaves them alone.

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LEGACY_UUID} from '../lib/migrate.js';
import {
    deleteWallpaperIfUnused, importWallpaper, listWallpapers, prettyName, wallpaperFolder,
} from '../lib/paths.js';
import {giveWidgets, normalizeProfile, readCurrentAppearance} from '../lib/profiles.js';
import {USER_THEME_UUID, getUserThemeSettings} from '../lib/themes.js';
import {ensureThumbnail} from '../lib/thumbnails.js';
import {readPaletteOptions} from '../lib/wallpaperPalette.js';
import {readWidgets} from '../lib/widgets.js';
import {Applier} from './applier.js';
import {Indicator} from './indicator.js';
import {ProfileSheet} from './profileSheet.js';
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
        this._saving = false;
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
        // Each profile keeps its widgets: those from before get a copy of
        // the ones on the desktop now.
        giveWidgets(this._store, this._settings.get_child('desktop'));

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
        switcher.connect('create', () => this._saveFromSwitcher(switcher));
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
     * Show a picture of the wallpaper folder for now. Profiles keep their own
     * wallpapers; switching to one brings its wallpaper back.
     *
     * @param {SwitcherContent} switcher
     * @param {string} path
     */
    async _applyWallpaper(switcher, path) {
        switcher.setActive(path);
        const options = this._store.get(this._store.activeId)?.pictureOptions ??
            new Gio.Settings({schema_id: 'org.gnome.desktop.background'}).get_string('picture-options');
        const wallpaperOnly = normalizeProfile({
            id: 'atelier-wallpaper', name: prettyName(path), wallpaper: path, pictureOptions: options,
        });
        await this._applier.apply(wallpaperOnly, {onWritten: () => switcher.close(), keepActive: true})
            .finally(() => switcher.close());
    }

    /**
     * A new profile of what the desktop shows now. The island drips a sheet
     * to name it and give it a style, and it is saved from there; without
     * the island, it is saved as it is.
     *
     * @param {SwitcherContent} switcher
     */
    async _saveFromSwitcher(switcher) {
        if (this._saving)
            return;
        this._saving = true;
        try {
            const draft = await this._captureCurrentSetup();
            if (!draft)
                return;
            const island = this._modules?.get('island');
            const form = new ProfileSheet(normalizeProfile({id: 'atelier-draft', ...draft}));
            // (The switcher goes back into the island as the drop forms.)
            switcher.close();
            const sheet = island?.openSheet(form);
            if (sheet) {
                this._fillIn(sheet, form, draft, island);
                return;
            }
            form.destroy();
            const profile = this._store.add(draft);
            this._store.activeId = profile.id;
            if (profile.wallpaper)
                ensureThumbnail(profile.wallpaper).catch(() => {});
            if (!(island && await island.announceProfile(profile, {subtitle: 'New profile'})))
                switcher.close();
        } catch (e) {
            Main.notifyError('Atelier', `Could not save the profile: ${e.message}`);
            switcher.close();
        } finally {
            this._saving = false;
        }
    }

    /**
     * The sheet for a new profile: saved with its name and style, or not.
     *
     * @param {LiquidSheet} sheet
     * @param {ProfileSheet} form
     * @param {object} draft - the profile as taken from the desktop
     * @param {IslandModule} island
     */
    _fillIn(sheet, form, draft, island) {
        let done = false;
        const finish = async ({save, more = false}) => {
            if (done)
                return;
            done = true;
            const fields = form.fields;
            const profile = save ? this._store.add({...draft, ...fields}) : null;
            if (profile) {
                this._store.activeId = profile.id;
                if (profile.wallpaper)
                    ensureThumbnail(profile.wallpaper).catch(() => {});
            }
            await sheet.close();
            if (!profile) {
                // Its copies of the wallpapers go, unless a profile has them.
                for (const path of [draft.wallpaper, draft.wallpaperDark].filter(Boolean))
                    await deleteWallpaperIfUnused(path, this._store.getAll()).catch(() => {});
                return;
            }
            if (more)
                this._extension.openPreferences();
            await island.announceProfile(profile, {subtitle: 'New profile'});
            // A style other than the desktop's, now.
            if (this._applier && (fields.colorScheme !== draft.colorScheme || fields.accentColor !== draft.accentColor))
                await this._applier.apply(profile, {animate: false});
        };
        const run = options => finish(options).catch(e => Main.notifyError('Atelier', `Could not save the profile: ${e.message}`));
        form.connect('save', () => run({save: true}));
        form.connect('more', () => run({save: true, more: true}));
        form.connect('cancel', () => run({save: false}));
        sheet.connect('dismissed', () => run({save: false}));
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
        const profile = await this._saveCurrentSetup('Original');
        if (!profile)
            return;
        this._store.activeId = profile.id;
        // Only now: an interrupted first run is retried on the next enable.
        this._settings.set_boolean('first-run-done', true);
    }

    /**
     * Save what the desktop shows now as a profile.
     *
     * @param {string} [name] - by default one made from the wallpaper
     * @returns {Promise<object|null>} the profile; null if Atelier was turned off meanwhile
     */
    async _saveCurrentSetup(name = null) {
        const fields = await this._captureCurrentSetup();
        if (!fields)
            return null;
        const profile = this._store.add({...fields, name: name ?? fields.name});
        if (profile.wallpaper)
            ensureThumbnail(profile.wallpaper).catch(() => {});
        return profile;
    }

    /**
     * What the desktop shows now, as the fields of a profile. Its wallpapers
     * are copied into the library, so it keeps working when the pictures
     * move.
     *
     * @returns {Promise<object|null>} the fields, named after the wallpaper;
     *   null if Atelier was turned off meanwhile
     */
    async _captureCurrentSetup() {
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
            // Turned off meanwhile: drop new copies (files profiles use stay).
            const profiles = this._store.getAll();
            for (const path of [wallpaper, wallpaperDark].filter(Boolean))
                await deleteWallpaperIfUnused(path, profiles).catch(() => {});
            return null;
        }

        return {
            ...current,
            wallpaper,
            wallpaperDark,
            palette: readPaletteOptions(this._settings.get_child('palette')),
            widgets: readWidgets(this._settings.get_child('desktop')),
            name: this._nameFor(current.wallpaper),
        };
    }

    /**
     * @param {string|null} wallpaper
     * @returns {string} a profile name not used yet, after the wallpaper if it has a useful name
     */
    _nameFor(wallpaper) {
        let base = wallpaper ? prettyName(wallpaper) : 'Profile';
        // Camera file names ("DJI 20261001…") and the wallpaper portal's
        // ~/.config/background say nothing.
        if (/\d{5,}/.test(base) || wallpaper?.endsWith('/.config/background'))
            base = 'Profile';
        const names = new Set(this._store.getAll().map(profile => profile.name));
        let name = base;
        for (let i = 2; names.has(name); i++)
            name = `${base} ${i}`;
        return name;
    }
}
