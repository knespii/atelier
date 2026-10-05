// The control centre: GNOME's quick settings open in the island instead of
// GNOME's own menu – from the status icons in the top bar or Super+S – and
// extension icons move from the bar into it. Without the island, GNOME's
// menu opens as usual.

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {QuickSettingsHost} from './host.js';
import {ControlCentrePage} from './page.js';
import {ExtensionTray} from './tray.js';

export class ControlCentreModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     * @param {ModuleManager} context.modules
     */
    constructor({settings, modules}) {
        this._settings = settings;
        this._modules = modules;
        this._injections = new InjectionManager();
        this._host = null;
        this._tray = null;
        this._page = null;
    }

    /** @returns {ControlCentrePage|null} the control centre, while it is open */
    get page() {
        return this._page;
    }

    /** @returns {ExtensionTray|null} */
    get tray() {
        return this._tray;
    }

    enable() {
        this._ccSettings = this._settings.get_child('control-centre');
        const quickSettings = Main.panel.statusArea.quickSettings;
        if (!quickSettings?.menu?._grid)
            throw new Error('GNOME\'s quick settings were not found');
        this._quickSettings = quickSettings;
        this._ensureHost();

        const menu = quickSettings.menu;
        this._injections.overrideMethod(menu, 'open', original => (...args) => {
            if (this._islandModule()?.available) {
                this._ensureHost();
                this.open();
            } else {
                // GNOME's menu, with its tiles back in it.
                this._releaseHost();
                original.call(menu, ...args);
            }
        });
        this._injections.overrideMethod(menu, 'close', original => (...args) => {
            this.close();
            original.call(menu, ...args);
        });
        this._injections.overrideMethod(menu, 'toggle', original => (...args) => {
            if (this._page)
                this.close();
            else if (menu.isOpen)
                original.call(menu, ...args);
            else
                menu.open();
        });

        this._ccSettings.connectObject('changed::extensions', () => this._syncTray(), this);
        this._syncTray();
    }

    disable() {
        this._ccSettings?.disconnectObject(this);
        this._injections.clear();
        this.close();
        this._releaseHost();
        this._tray?.restore();
        this._tray?.destroy();
        this._tray = null;
        this._quickSettings?.remove_style_pseudo_class('checked');
        this._quickSettings = null;
    }

    /** Open the control centre in the island. */
    open() {
        const island = this._islandModule()?.island;
        if (!island || this._page)
            return;
        const page = new ControlCentrePage({host: this._host, tray: this._tray});
        page.connect('destroy', () => {
            if (this._page !== page)
                return;
            this._page = null;
            this._host?.closeMenus();
            this._quickSettings?.remove_style_pseudo_class('checked');
        });
        if (!island.open(page, {modal: true})) {
            page.destroy();
            return;
        }
        this._page = page;
        this._quickSettings.add_style_pseudo_class('checked');
    }

    close() {
        const page = this._page;
        if (!page)
            return;
        this._page = null;
        this._host?.closeMenus();
        this._quickSettings?.remove_style_pseudo_class('checked');
        this._islandModule()?.island?.close(page);
    }

    _islandModule() {
        return this._modules?.get('island') ?? null;
    }

    _ensureHost() {
        this._host ??= new QuickSettingsHost(this._quickSettings);
    }

    _releaseHost() {
        this.close();
        this._host?.release();
        this._host = null;
    }

    _syncTray() {
        const wanted = this._ccSettings.get_boolean('extensions');
        if (wanted && !this._tray) {
            this._tray = new ExtensionTray();
        } else if (!wanted && this._tray) {
            // An open control centre loses its Extensions tab.
            this.close();
            this._tray.restore();
            this._tray.destroy();
            this._tray = null;
        }
    }
}
