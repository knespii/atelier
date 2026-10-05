// Atelier: profiles, palette and a desktop built around them.
// This file only takes over BG Changer's data and starts the modules.

import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LEGACY_SCHEMA, migrateFromBgChanger} from './lib/migrate.js';
import {ProfileStore} from './lib/profiles.js';
import {ModuleManager} from './shell/core/moduleManager.js';
import {BarModule} from './shell/bar/module.js';
import {ClaudeModule} from './shell/claude/module.js';
import {ControlCentreModule} from './shell/controlCentre/module.js';
import {DesktopModule} from './shell/desktop/module.js';
import {IslandModule} from './shell/island/module.js';
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
                if (this.modules === modules)
                    modules.enable();
            });
    }

    disable() {
        this.modules.disable();
        this.modules = null;
        this._settings = null;
    }

    _legacySettings() {
        const source = Gio.SettingsSchemaSource.new_from_directory(
            this.dir.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(LEGACY_SCHEMA, false);
        return schema ? new Gio.Settings({settings_schema: schema}) : null;
    }
}
