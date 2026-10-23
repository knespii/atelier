// Atelier: profiles, palette and a desktop built around them.
// This file only takes over BG Changer's data and starts the modules.
//
// Atelier stays enabled on the lock screen (session mode unlock-dialog)
// for its island with the padlock. Everything else stops while the screen
// is locked, as it did when GNOME turned Atelier off for the lock screen,
// and starts again once it is unlocked; only shell/lockscreen runs then,
// and it neither launches anything nor takes the keyboard.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LEGACY_SCHEMA, migrateFromBgChanger} from './lib/migrate.js';
import {ProfileStore} from './lib/profiles.js';
import {ModuleManager} from './shell/core/moduleManager.js';
import {releaseKeptStyles} from './shell/core/theme.js';
import {BarModule} from './shell/bar/module.js';
import {ClaudeModule} from './shell/claude/module.js';
import {ControlCentreModule} from './shell/controlCentre/module.js';
import {DepthModule} from './shell/depthModule.js';
import {DesktopModule} from './shell/desktop/module.js';
import {DockModule} from './shell/dock/module.js';
import {IslandModule} from './shell/island/module.js';
import {LockModule} from './shell/lockscreen/module.js';
import {LockPreviewModule} from './shell/lockscreen/preview.js';
import {WindowAnimationsModule} from './shell/windows/module.js';
import {NotesModule} from './shell/notes/module.js';
import {NotificationsModule} from './shell/notifications/module.js';
import {OtherExtensionsModule} from './shell/otherExtensions.js';
import {PaletteModule} from './shell/paletteModule.js';
import {ProfilesModule} from './shell/profilesModule.js';

export default class AtelierExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        const context = {
            extension: this,
            settings: this._settings,
            store: new ProfileStore(this._settings),
        };
        this.modules = new ModuleManager(context);
        context.modules = this.modules;
        this.modules.register('palette', ctx => new PaletteModule(ctx));
        this.modules.register('profiles', ctx => new ProfilesModule(ctx));
        this.modules.register('island', ctx => new IslandModule(ctx),
            {settings: this._settings.get_child('island'), key: 'enabled'});
        this.modules.register('notifications', ctx => new NotificationsModule(ctx),
            {settings: this._settings.get_child('notifications'), key: 'enabled'});
        this.modules.register('claude', ctx => new ClaudeModule(ctx));
        this.modules.register('control-centre', ctx => new ControlCentreModule(ctx),
            {settings: this._settings.get_child('control-centre'), key: 'enabled'});
        this.modules.register('bar', ctx => new BarModule(ctx));
        this.modules.register('desktop', ctx => new DesktopModule(ctx),
            {settings: this._settings.get_child('desktop'), key: 'enabled'});
        this.modules.register('notes', ctx => new NotesModule(ctx),
            {settings: this._settings.get_child('notes'), key: 'enabled'});
        this.modules.register('dock', ctx => new DockModule(ctx),
            {settings: this._settings.get_child('dock'), key: 'enabled'});
        this.modules.register('windows', ctx => new WindowAnimationsModule(ctx),
            {settings: this._settings.get_child('windows'), key: 'enabled'});
        // (Placing the lock screen's widgets happens in the session.)
        this.modules.register('lockscreen-editor', ctx => new LockPreviewModule(ctx));
        // (And the cutouts of the wallpaper for its depth effect, made then.)
        this.modules.register('depth', ctx => new DepthModule(ctx),
            {settings: this._settings.get_child('lockscreen'), key: 'depth-effect'});
        // (Other extensions' settings kept out of Atelier's way, as asked.)
        this.modules.register('other-extensions', ctx => new OtherExtensionsModule(ctx));

        // What runs while the screen is locked.
        this.lockModules = new ModuleManager(context);
        this.lockModules.register('lockscreen', ctx => new LockModule(ctx),
            {settings: this._settings.get_child('lockscreen'), key: 'enabled'});
        this._afterglow = null;
        this._unlockLater = 0;
        this._ready = false;
        Main.sessionMode.connectObject('updated', () => this._syncSession(), this);

        // BG Changer's data has to be taken over before anything reads the
        // profiles, otherwise the first run would save a second "Original".
        const modules = this.modules;
        migrateFromBgChanger(this._settings, this._legacySettings())
            .then(result => {
                if (result.migrated)
                    console.log(`Atelier: took over ${result.profiles} profiles from BG Changer`);
            })
            .catch(e => console.error('Atelier: taking over BG Changer data failed', e))
            .finally(() => {
                if (this.modules !== modules)
                    return;
                this._ready = true;
                this._syncSession();
            });
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        this._cancelUnlockLater();
        this.lockModules.disable();
        this._afterglow?.destroy();
        this._afterglow = null;
        this.modules.disable();
        releaseKeptStyles();
        this.modules = null;
        this.lockModules = null;
        this._settings = null;
    }

    // Locked, the session's modules stop at once (their keybindings and
    // everything they show over the lock screen with them) and the lock
    // screen's start; unlocked, the other way round.
    _syncSession() {
        if (!this._ready)
            return;
        const modules = this.modules;
        if (Main.sessionMode.isLocked) {
            this._cancelUnlockLater();
            modules.disable();
            this.lockModules.enable();
            return;
        }
        if (!this.lockModules.enabled) {
            modules.enable();
            return;
        }
        // Just unlocked: the padlock plays on over the island built anew,
        // which waits until GNOME has let go of the lock screen – and comes
        // out of the top edge once the padlock has gone back up.
        this._afterglow?.destroy();
        this._afterglow = null;
        // (Gone at once, without the padlock out.)
        let afterglow = null;
        afterglow = this.lockModules.get('lockscreen')?.handOver(() => {
            if (this._afterglow === afterglow)
                this._afterglow = null;
            this.modules?.get('island')?.comeOut();
        }) ?? null;
        this._afterglow = afterglow?.actor ? afterglow : null;
        this.lockModules.disable();
        // All of it at once, before the first frame after the unlock (in
        // turn, plain GNOME showed for a moment) – but after GNOME has
        // turned its other extensions on again, in this same turn of the
        // main loop: each of their stylesheets (and a shell theme) restyles
        // everything there is, and Atelier built before them was restyled
        // with every one.
        this._unlockLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._unlockLater = 0;
            if (this.modules !== modules || Main.sessionMode.isLocked)
                return GLib.SOURCE_REMOVE;
            modules.enable();
            if (this._afterglow)
                modules.get('island')?.tuckAway();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelUnlockLater() {
        if (this._unlockLater)
            global.compositor.get_laters().remove(this._unlockLater);
        this._unlockLater = 0;
    }

    _legacySettings() {
        const source = Gio.SettingsSchemaSource.new_from_directory(
            this.dir.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(LEGACY_SCHEMA, false);
        return schema ? new Gio.Settings({settings_schema: schema}) : null;
    }
}
