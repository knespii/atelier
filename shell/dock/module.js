// The dock feature: a dock on the chosen monitor (on every monitor, if
// asked), and what all of them share – one set of window signals, the
// badges, the places, the app spread, the shortcuts, Dynamic Music Pill's
// handle. It stays off while Dash to Dock is on (the two would fight over
// the edge of the screen and over Dynamic Music Pill) and starts by itself
// once Dash to Dock is turned off.

import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {pickMonitors} from '../../lib/dockGeometry.js';
import {AppSpread} from './appSpread.js';
import {BadgeSource} from './badges.js';
import {Dock} from './dock.js';
import {DockHotkeys} from './hotkeys.js';
import {Locations} from './locations.js';
import {MusicPill} from './musicPill.js';
import {OverviewDash} from './overviewDash.js';
import {WindowWatcher} from './windowWatcher.js';

const DASH_TO_DOCK = 'dash-to-dock@micxgx.gmail.com';
// Dash to Dock counts as on while it runs or is about to.
const RUNNING = [ExtensionState.ACTIVE, ExtensionState.ACTIVATING, ExtensionState.DEACTIVATING];

// Settings the docks are built anew for; the others are applied as they
// change, by whoever has them.
export const REBUILD_KEYS = ['dock-position', 'multi-monitor', 'preferred-monitor-by-connector', 'dock-fixed',
    'extend-height', 'icon-size-fixed', 'autohide-in-fullscreen', 'icon-size'];

export class DockModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     */
    constructor({settings}) {
        this._settings = settings;
        this.docks = [];
        this.services = null;
    }

    /** @returns {Dock|null} the main dock, on the chosen monitor */
    get dock() {
        return this.docks[0] ?? null;
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
        this._dockSettings.connectObject(
            ...REBUILD_KEYS.flatMap(key => [`changed::${key}`, () => this._queueRebuild()]), this);
        this._barSettings.connectObject('changed::surface', () => this._queueRebuild(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._queueRebuild(), this);
        this._sync();
    }

    disable() {
        this._cancelRebuild();
        Main.extensionManager.disconnectObject(this);
        this._dockSettings?.disconnectObject(this);
        this._barSettings?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._destroyDocks();
        this._destroyServices();
    }

    _sync() {
        if (this.blocked && this.docks.length > 0) {
            this._destroyDocks();
            this._destroyServices();
        } else if (!this.blocked && this.docks.length === 0) {
            this._createDocks();
        }
    }

    _rebuild() {
        this._cancelRebuild();
        this._destroyDocks();
        this._sync();
    }

    // Built anew once for all that changed together (an import changes
    // many settings at once), before the next frame.
    _queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._rebuildId = 0;
            this._rebuild();
            return false;
        });
    }

    _cancelRebuild() {
        if (this._rebuildId)
            global.compositor.get_laters().remove(this._rebuildId);
        this._rebuildId = 0;
    }

    // The monitor chosen by its connector, or the main one.
    _mainMonitor() {
        const connector = this._dockSettings.get_string('preferred-monitor-by-connector');
        if (connector !== 'primary') {
            const index = global.backend.get_monitor_manager().get_monitor_for_connector(connector);
            if (index >= 0 && index < Main.layoutManager.monitors.length)
                return index;
        }
        return Main.layoutManager.primaryIndex;
    }

    _createServices() {
        const settings = this._dockSettings;
        this.services = {
            windows: new WindowWatcher(),
            badges: new BadgeSource(settings),
            locations: new Locations(settings),
            spread: new AppSpread(),
            musicPill: new MusicPill(),
            overview: new OverviewDash(settings),
        };
        this.services.hotkeys = new DockHotkeys(this, settings);
        this.services.hotkeys.enable();
    }

    _destroyServices() {
        if (!this.services)
            return;
        const {hotkeys, musicPill, spread, locations, badges, windows, overview} = this.services;
        for (const service of [overview, hotkeys, musicPill, spread, locations, badges, windows])
            service.destroy();
        this.services = null;
    }

    _createDocks() {
        if (!this.services)
            this._createServices();
        const glass = this._barSettings.get_string('surface') === 'glass';
        const monitors = pickMonitors({
            mainIndex: this._mainMonitor(),
            multi: this._dockSettings.get_boolean('multi-monitor'),
            count: Main.layoutManager.monitors.length,
        });
        this.docks = monitors.map((monitorIndex, i) => new Dock({
            settings: this._dockSettings,
            glass,
            monitorIndex,
            main: i === 0,
            services: this.services,
        }));
        this.services.overview.attach(this.dock);
    }

    _destroyDocks() {
        // (The main one gives Dynamic Music Pill back as it goes.)
        this.services?.overview.attach(null);
        this.docks.forEach(dock => dock.destroy());
        this.docks = [];
    }
}
