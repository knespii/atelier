// The file manager's windows and the places they show, over its
// org.freedesktop.FileManager1 D-Bus interface: Files lists them in
// OpenWindowsWithLocations, each window by its GTK object path, which
// Mutter knows its windows by too. It says 'changed' when they change;
// without a file manager that has it, it knows of no windows. It never
// starts a file manager itself.

import Gio from 'gi://Gio';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {windowsShowing} from '../../lib/dockLocations.js';

const NAME = 'org.freedesktop.FileManager1';
const PATH = '/org/freedesktop/FileManager1';
const INTERFACE = `<node>
  <interface name="${NAME}">
    <property name="OpenWindowsWithLocations" type="a{sas}" access="read"/>
  </interface>
</node>`;

export class FileManager1 extends EventEmitter {
    constructor() {
        super();
        this._locations = new Map(); // window object path → the places it shows
        this._proxy = null;
        this._cancellable = new Gio.Cancellable();
        const info = Gio.DBusNodeInfo.new_for_xml(INTERFACE).interfaces[0];
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START, info,
            NAME, PATH, NAME, this._cancellable, (_, result) => {
                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Atelier dock: no file manager windows: ${e.message}`);
                    return;
                }
                if (this._cancellable.is_cancelled())
                    return;
                this._proxy = proxy;
                // (Files may start, quit and start again.)
                proxy.connectObject(
                    'g-properties-changed', () => this._update(),
                    'notify::g-name-owner', () => this._update(),
                    this);
                this._update();
            });
    }

    /** @returns {boolean} whether a file manager answers */
    get available() {
        return Boolean(this._proxy?.g_name_owner);
    }

    _update() {
        const value = this._proxy?.g_name_owner
            ? this._proxy.get_cached_property('OpenWindowsWithLocations') : null;
        const locations = new Map(Object.entries(value?.deepUnpack() ?? {}));
        const same = locations.size === this._locations.size &&
            [...locations].every(([path, uris]) => this._locations.get(path)?.join('\n') === uris.join('\n'));
        this._locations = locations;
        if (!same)
            this.emit('changed');
    }

    /**
     * @param {string} uri - of a place
     * @returns {Meta.Window[]} the file manager's windows showing it (or a
     *   folder in it), and their dialogs
     */
    windowsAt(uri) {
        const paths = new Set(windowsShowing(uri, Object.fromEntries(this._locations)));
        if (paths.size === 0)
            return [];
        return global.display.list_all_windows().filter(window => paths.has(this._pathOf(window)));
    }

    /**
     * @param {Meta.Window} window
     * @returns {string[]} the places a file manager window shows (for a
     *   dialog, its window's)
     */
    locationsOf(window) {
        return this._locations.get(this._pathOf(window)) ?? [];
    }

    // The object path of the file manager's window it is (or is a dialog
    // of), or null.
    _pathOf(window) {
        for (let w = window; w && this._locations.size > 0; w = w.get_transient_for()) {
            const path = w.gtk_window_object_path;
            if (path && this._locations.has(path))
                return path;
        }
        return null;
    }

    destroy() {
        this._cancellable.cancel();
        this._proxy?.disconnectObject(this);
        this._proxy = null;
        this._locations.clear();
        this.disconnectAll();
    }
}
