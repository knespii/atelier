// The dock feature. It stays off while Dash to Dock is on (the two would
// fight over the bottom of the screen and over Dynamic Music Pill) and
// starts by itself once Dash to Dock is turned off.

import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Dock} from './dock.js';

const DASH_TO_DOCK = 'dash-to-dock@micxgx.gmail.com';
// Dash to Dock counts as on while it runs or is about to.
const RUNNING = [ExtensionState.ACTIVE, ExtensionState.ACTIVATING, ExtensionState.DEACTIVATING];

export class DockModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     */
    constructor({settings}) {
        this._settings = settings;
        this.dock = null;
    }

    /** @returns {boolean} whether Dash to Dock keeps it off */
    get blocked() {
        return RUNNING.includes(Main.extensionManager.lookup(DASH_TO_DOCK)?.state);
    }

    enable() {
        this._dockSettings = this._settings.get_child('dock');
        this._barSettings = this._settings.get_child('bar');
        Main.extensionManager.connectObject('extension-state-changed', (_, extension) => {
            if (extension.uuid === DASH_TO_DOCK)
                this._sync();
        }, this);
        this._dockSettings.connectObject('changed::icon-size', () => this._rebuild(), this);
        this._barSettings.connectObject('changed::surface', () => this._rebuild(), this);
        this._sync();
    }

    disable() {
        Main.extensionManager.disconnectObject(this);
        this._dockSettings?.disconnectObject(this);
        this._barSettings?.disconnectObject(this);
        this.dock?.destroy();
        this.dock = null;
    }

    _sync() {
        if (this.blocked && this.dock) {
            this.dock.destroy();
            this.dock = null;
        } else if (!this.blocked && !this.dock) {
            this.dock = new Dock({settings: this._dockSettings, glass: this._barSettings.get_string('surface') === 'glass'});
        }
    }

    _rebuild() {
        this.dock?.destroy();
        this.dock = null;
        this._sync();
    }
}
