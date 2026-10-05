// BG Changer: save looks (wallpaper + themes) and switch between them.

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LookStore, readCurrentAppearance} from './lib/looks.js';
import {importWallpaper} from './lib/paths.js';
import {USER_THEME_UUID, getUserThemeSettings} from './lib/themes.js';
import {ensureThumbnail} from './lib/thumbnails.js';
import {Applier} from './shell/applier.js';
import {Indicator} from './shell/indicator.js';
import {WallpaperTransition} from './shell/reveal.js';
import {LookSwitcher} from './shell/switcher.js';

const KEYBINDINGS = ['bgc-open-switcher', 'bgc-next-look', 'bgc-previous-look'];

export default class BgChangerExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._store = new LookStore(this._settings);
        this._applier = new Applier(this._settings);
        this._applier.transition = new WallpaperTransition(this._settings);
        this._switcher = null;
        this._indicator = null;

        this._settings.connectObject(
            'changed::show-indicator', () => this._syncIndicator(),
            'changed::apply-request', () => this._onApplyRequest(),
            'changed::looks', () => this._switcher?.setLooks(this._store.getAll(), this._store.activeId),
            'changed::active-look', () => this._switcher?.setActive(this._store.activeId),
            this);
        this._syncIndicator();

        const flags = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
        const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        // POPUP lets the shortcut close the switcher it opened.
        Main.wm.addKeybinding('bgc-open-switcher', this._settings, flags,
            modes | Shell.ActionMode.POPUP, () => this.toggleSwitcher());
        Main.wm.addKeybinding('bgc-next-look', this._settings, flags, modes, () => this._step(1));
        Main.wm.addKeybinding('bgc-previous-look', this._settings, flags, modes, () => this._step(-1));

        if (!this._settings.get_boolean('first-run-done')) {
            this._createOriginalLook().catch(e =>
                console.error('BG Changer: could not save the original look', e));
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
        this._settings = null;
        this._store = null;
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

        const switcher = new LookSwitcher();
        switcher.setLooks(this._store.getAll(), this._store.activeId);
        switcher.connect('activate', (_, id) => this._applyFromSwitcher(switcher, id));
        switcher.connect('destroy', () => {
            if (this._switcher === switcher)
                this._switcher = null;
        });
        this._switcher = switcher;
        switcher.open();
    }

    _applyFromSwitcher(switcher, id) {
        const look = this._store.get(id);
        if (!look)
            return;
        switcher.setActive(id);
        // Keep the panel up while the new wallpaper is revealed, like a
        // dynamic island, and close it once the look is in place.
        this._applier.apply(look, {onWritten: () => switcher.close()})
            .finally(() => switcher.close());
    }

    _step(delta) {
        const looks = this._store.getAll();
        if (looks.length === 0)
            return;
        // While a look is still being applied, step from it rather than from
        // the active one, so quick presses don't apply the same look twice.
        const from = this._applier.targetId ?? this._store.activeId;
        const current = looks.findIndex(look => look.id === from);
        const index = current < 0
            ? (delta > 0 ? 0 : looks.length - 1)
            : (current + delta + looks.length) % looks.length;
        this._applier.apply(looks[index]);
    }

    _onApplyRequest() {
        let request;
        try {
            request = JSON.parse(this._settings.get_string('apply-request'));
        } catch {
            return;
        }
        const look = request?.id ? this._store.get(request.id) : null;
        if (look)
            this._applier.apply(look);
    }

    _syncIndicator() {
        const show = this._settings.get_boolean('show-indicator');
        if (show && !this._indicator) {
            this._indicator = new Indicator(this.path);
            this._indicator.connect('activate', () => this.toggleSwitcher());
            Main.panel.addToStatusArea(this.uuid, this._indicator);
        } else if (!show && this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }

    /**
     * Save the setup the user had before installing the extension, so there
     * is always a way back.
     */
    async _createOriginalLook() {
        this._settings.set_boolean('first-run-done', true);

        const userThemesActive =
            Main.extensionManager.lookup(USER_THEME_UUID)?.state === ExtensionState.ACTIVE;
        const current = readCurrentAppearance(userThemesActive ? getUserThemeSettings() : null);

        const copy = path => importWallpaper(path).catch(e => {
            console.warn(`BG Changer: could not copy ${path}: ${e.message}`);
            return null;
        });
        const wallpaper = current.wallpaper ? await copy(current.wallpaper) : null;
        const wallpaperDark = wallpaper && current.wallpaperDark ? await copy(current.wallpaperDark) : null;
        if (!this._store)
            return; // disabled meanwhile

        const look = this._store.add({...current, wallpaper, wallpaperDark, name: 'Original'});
        this._store.activeId = look.id;
        if (wallpaper)
            ensureThumbnail(wallpaper).catch(() => {});
    }
}
