// The control centre: the island opens it (and Super+S, Super+V for the
// notifications); the status icons in the top bar only show the state. It
// holds GNOME's quick settings, GNOME's notification list and calendar,
// and the icons extensions put into the bar. Without the island, GNOME's
// menus work as usual.

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DateMenuHost} from './dateMenuHost.js';
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
        this._quickSettingsHost = null;
        this._dateMenuHost = null;
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

    /** @returns {boolean} whether it opens in the island (or GNOME's menus do) */
    get available() {
        return Boolean(this._quickSettingsHost && this._islandModule()?.available);
    }

    enable() {
        this._ccSettings = this._settings.get_child('control-centre');
        const quickSettings = Main.panel.statusArea.quickSettings;
        if (!quickSettings?.menu?._grid)
            throw new Error('GNOME\'s quick settings were not found');
        this._quickSettings = quickSettings;
        this._dateMenu = Main.panel.statusArea.dateMenu ?? null;

        // The status icons only show the state; the island opens the
        // control centre. (Without it, clicking them opens GNOME's menu.)
        this._sensitivity = {canFocus: quickSettings.can_focus, trackHover: quickSettings.track_hover};
        const menu = quickSettings.menu;
        this._injections.overrideMethod(menu, 'toggle', original => (...args) => {
            if (!this._quickSettingsHost)
                original.call(menu, ...args);
        });
        this._injections.overrideMethod(menu, 'open', original => (...args) => {
            if (this._quickSettingsHost)
                this.open('controls');
            else
                original.call(menu, ...args);
        });
        this._injections.overrideMethod(menu, 'close', original => (...args) => {
            this.close();
            original.call(menu, ...args);
        });
        this._injections.overrideMethod(Main.panel, 'toggleQuickSettings', original => () => {
            if (this.available)
                this.toggle('controls');
            else
                original.call(Main.panel);
        });
        this._injections.overrideMethod(Main.panel, 'closeQuickSettings', original => () => {
            this.close();
            original.call(Main.panel);
        });

        this._modules.connectObject(
            'started', (_, id) => id === 'island' && this._adopt(),
            'stopped', (_, id) => id === 'island' && this._release(),
            this);
        this._ccSettings.connectObject('changed::extensions', () => this._syncTray(), this);
        if (this._islandModule())
            this._adopt();
    }

    disable() {
        this._modules.disconnectObject(this);
        this._ccSettings?.disconnectObject(this);
        this._injections.clear();
        this._release();
        this._quickSettings = null;
        this._dateMenu = null;
    }

    /**
     * Open the control centre on a tab, switch to the tab, or close it when
     * it shows that tab already.
     *
     * @param {string} tab - 'controls', 'notifications', 'calendar' or 'extensions'
     */
    toggle(tab = 'controls') {
        if (this._page?.tab === tab)
            this.close();
        else if (this._page)
            this._page.setTab(tab);
        else
            this.open(tab);
    }

    /** @param {string} tab */
    open(tab = 'controls') {
        const island = this._islandModule()?.island;
        if (!island || !this.available)
            return;
        if (this._page) {
            this._page.setTab(tab);
            return;
        }
        const page = new ControlCentrePage(this._tabs(), tab);
        page.connect('destroy', () => {
            if (this._page !== page)
                return;
            this._page = null;
            this._quickSettingsHost?.closeMenus();
        });
        if (!island.open(page, {modal: true})) {
            page.destroy();
            return;
        }
        this._page = page;
    }

    close() {
        const page = this._page;
        if (!page)
            return;
        this._page = null;
        this._quickSettingsHost?.closeMenus();
        this._islandModule()?.island?.close(page);
    }

    _tabs() {
        const tabs = [{
            id: 'controls', label: 'Controls', icon: 'preferences-system-symbolic',
            actor: this._quickSettingsHost.actor,
            onShow: () => this._quickSettingsHost?.closeMenus(),
        }];
        if (this._dateMenuHost) {
            tabs.push({
                id: 'notifications', label: 'Notifications', icon: 'preferences-system-notifications-symbolic',
                actor: this._dateMenuHost.notifications,
            }, {
                id: 'calendar', label: 'Calendar', icon: 'x-office-calendar-symbolic',
                actor: this._dateMenuHost.calendar,
                onShow: () => this._dateMenuHost?.showToday(),
            });
        }
        if (this._tray) {
            tabs.push({
                id: 'extensions', label: 'Extensions', icon: 'application-x-addon-symbolic',
                actor: this._tray,
                available: () => this._tray?.tiles.length > 0,
            });
        }
        return tabs;
    }

    _islandModule() {
        return this._modules?.get('island') ?? null;
    }

    // Take GNOME's tiles, list and calendar into the control centre.
    _adopt() {
        if (this._quickSettingsHost)
            return;
        this._quickSettingsHost = new QuickSettingsHost(this._quickSettings);
        if (this._dateMenu?._messageList && this._dateMenu._calendar)
            this._dateMenuHost = new DateMenuHost(this._dateMenu);
        this._quickSettings.can_focus = false;
        this._quickSettings.track_hover = false;
        this._syncTray();
    }

    // Give everything back to GNOME.
    _release() {
        this.close();
        this._quickSettingsHost?.release();
        this._quickSettingsHost = null;
        this._dateMenuHost?.release();
        this._dateMenuHost = null;
        this._tray?.restore();
        this._tray?.destroy();
        this._tray = null;
        if (this._quickSettings && this._sensitivity) {
            this._quickSettings.can_focus = this._sensitivity.canFocus;
            this._quickSettings.track_hover = this._sensitivity.trackHover;
        }
    }

    _syncTray() {
        const wanted = Boolean(this._quickSettingsHost) && this._ccSettings.get_boolean('extensions');
        if (wanted && !this._tray) {
            this._tray = new ExtensionTray();
            this._tray.connectObject('changed', () => this._page?.sync(), this);
        } else if (!wanted && this._tray) {
            // An open control centre would lose its Extensions tab under it.
            this.close();
            this._tray.restore();
            this._tray.destroy();
            this._tray = null;
        }
    }
}
