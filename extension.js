// Atelier: profiles, palette and a desktop built around them.
// This file only takes over BG Changer's data and starts the modules.
//
// Atelier stays enabled on the lock screen (session mode unlock-dialog)
// for its island with the padlock. Everything else stops while the screen
// is locked, as it did when GNOME turned Atelier off for the lock screen,
// and starts again once it is unlocked; only shell/lockscreen runs then,
// and it neither launches anything nor takes the keyboard.

import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LEGACY_SCHEMA, migrateFromBgChanger} from './lib/migrate.js';
import {ProfileStore} from './lib/profiles.js';
import {ModuleManager} from './shell/core/moduleManager.js';
import {BarModule} from './shell/bar/module.js';
import {ClaudeModule} from './shell/claude/module.js';
import {ControlCentreModule} from './shell/controlCentre/module.js';
import {DesktopModule} from './shell/desktop/module.js';
import {DockModule} from './shell/dock/module.js';
import {IslandModule} from './shell/island/module.js';
import {LockModule} from './shell/lockscreen/module.js';
import {WindowAnimationsModule} from './shell/windows/module.js';
import {NotesModule} from './shell/notes/module.js';
import {NotificationsModule} from './shell/notifications/module.js';
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

        // What runs while the screen is locked.
        this.lockModules = new ModuleManager(context);
        this.lockModules.register('lockscreen', ctx => new LockModule(ctx),
            {settings: this._settings.get_child('lockscreen'), key: 'enabled'});
        this._afterglow = null;
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
        this.lockModules.disable();
        this._afterglow?.destroy();
        this._afterglow = null;
        this.modules.disable();
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
            modules.disable();
            this.lockModules.enable();
            return;
        }
        if (!this.lockModules.enabled) {
            modules.enable();
            return;
        }
        // Just unlocked: the padlock plays on over the island built anew,
        // which waits until GNOME has let go of the lock screen.
        this._afterglow?.destroy();
        this._afterglow = this.lockModules.get('lockscreen')?.handOver() ?? null;
        this.lockModules.disable();
        Promise.resolve().then(() => {
            if (this.modules === modules && !Main.sessionMode.isLocked)
                modules.enable();
        });
    }

    _legacySettings() {
        const source = Gio.SettingsSchemaSource.new_from_directory(
            this.dir.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(LEGACY_SCHEMA, false);
        return schema ? new Gio.Settings({settings_schema: schema}) : null;
    }
}
