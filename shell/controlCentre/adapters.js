// What the Controls tab shows and does, from GNOME's own state: its
// quick settings' Wi-Fi, Wired, Bluetooth and Airplane Mode toggles (and
// what they know: NetworkManager's networks and wired connections, GNOME Bluetooth's devices, rfkill), its
// volume slider's outputs (Gvc), its system item's battery (UPower) and
// buttons, and the Caffeine extension's toggle – or, without it, Atelier's
// own inhibitor. Each adapter tells of a change ('changed', once for many)
// and has its state as plain values; the tiles (shell/controlCentre/host.js)
// show only that, and act only through it. GNOME's toggles stay where
// GNOME has them, unseen: nothing of them is moved or destroyed.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {shortOutputName} from '../../lib/ccLayout.js';

// How long a connection may take before it is taken to have failed (s).
const CONNECT_TIMEOUT = 30;
// How often what NetworkManager has seen is read again while the Wi-Fi
// card is open (ms): it scans then.
const WIFI_POLL = 1500;

// NetworkManager's device states (NM.DeviceState).
const NM_DISCONNECTED = 30;
const NM_PREPARE = 40;
const NM_ACTIVATED = 100;
const NM_FAILED = 120;
// (NM.ActiveConnectionState.)
const NM_CONNECTION_ACTIVATING = 1;
const NM_CONNECTION_ACTIVATED = 2;

// UPower's (UPower.DeviceState).
const DISCHARGING = 2;
const PENDING_DISCHARGE = 6;
const FULLY_CHARGED = 4;

// The Caffeine chips' durations (s): 30 min, 1 h, until turned off.
export const CAFFEINE_DURATIONS = [1800, 3600, 0];

/** The base: 'changed' told once for all that changes in a frame. */
class Adapter extends Signals.EventEmitter {
    constructor() {
        super();
        this._changedId = 0;
        this._watched = new Set();
        this._ids = new Map();
    }

    // Connect to a GObject's signals, until destroyed.
    _watch(object, ...args) {
        if (!object)
            return;
        // (Not all have connectObject: a D-Bus proxy GNOME made before the
        // shell added it, as in the lock screen's session. Its handlers by
        // their ids, then.)
        if (typeof object.connectObject !== 'function') {
            if (typeof object.connect !== 'function')
                return;
            const ids = this._ids.get(object) ?? [];
            for (let i = 0; i + 1 < args.length; i += 2)
                ids.push(object.connect(args[i], args[i + 1]));
            this._ids.set(object, ids);
            this._watched.add(object);
            return;
        }
        object.connectObject(...args, this);
        // (GNOME's toggle gone – the shell quitting, say: not read again.)
        if (object instanceof Clutter.Actor && !this._watched.has(object)) {
            object.connectObject('destroy', () => {
                for (const key of Object.keys(this)) {
                    if (this[key] === object)
                        this[key] = null;
                }
                this._watched.delete(object);
                this._changed();
            }, this);
        }
        this._watched.add(object);
    }

    _unwatch(object) {
        if (!object || !this._watched.delete(object))
            return;
        try {
            const ids = this._ids.get(object);
            this._ids.delete(object);
            if (ids)
                ids.forEach(id => object.disconnect(id));
            else
                object.disconnectObject(this);
        } catch {
            // (Gone already.)
        }
    }

    _changed() {
        if (this._changedId)
            return;
        this._changedId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._changedId = 0;
            this.emit('changed');
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy() {
        if (this._changedId)
            GLib.source_remove(this._changedId);
        this._changedId = 0;
        for (const object of [...this._watched])
            this._unwatch(object);
        this.disconnectAll?.();
    }
}

// An app's settings panel, as GNOME's menus open them; the control centre
// closes.
function openPanel(desktopId) {
    const app = Shell.AppSystem.get_default().lookup_app(desktopId);
    Main.overview.hide();
    Main.panel.closeQuickSettings();
    app?.activate();
}

// Click a GNOME item as St does.
function click(item) {
    item?.emit('clicked', Clutter.BUTTON_PRIMARY);
}

/**
 * Wi-Fi: GNOME's toggle, its networks as its menu has them.
 *
 * State: available, on, networks [{id, name, icon, secure, connected}].
 */
export class WifiAdapter extends Adapter {
    constructor(quickSettings) {
        super();
        this._toggle = quickSettings._network?._wirelessToggle ?? null;
        this._pollId = 0;
        this._watch(this._toggle,
            'notify::visible', () => this._changed(),
            'notify::checked', () => this._changed(),
            'notify::subtitle', () => this._changed(),
            'notify::icon-name', () => this._changed());
    }

    get available() {
        return Boolean(this._toggle?.visible);
    }

    get on() {
        return Boolean(this._toggle?.checked);
    }

    setOn(on) {
        const client = this._toggle?._client;
        if (client && 'wireless_enabled' in client)
            client.wireless_enabled = on;
        else if (this.on !== on)
            click(this._toggle);
    }

    // GNOME's networks, each once (a network seen by two devices too).
    _networks() {
        const found = new Map();
        for (const item of this._toggle?._items?.values() ?? []) {
            for (const network of item._networkItems?.keys() ?? []) {
                if (network.hasAccessPoints && !network.hasAccessPoints())
                    continue;
                const name = network.name;
                if (!name)
                    continue;
                const known = found.get(name);
                if (!known || (network.is_active && !known.is_active))
                    found.set(name, network);
            }
        }
        return [...found.values()].sort((a, b) =>
            (b.is_active - a.is_active) || (a.compare?.(b) ?? 0));
    }

    get networks() {
        return this._networks().map(network => ({
            id: network.name, name: network.name, icon: network.icon_name || 'network-wireless-symbolic',
            secure: Boolean(network.secure), connected: Boolean(network.is_active),
        }));
    }

    /** @returns {string} the network connected, or '' */
    get connectedName() {
        return this.networks.find(n => n.connected)?.name ?? '';
    }

    /**
     * Connect to a network (GNOME's way: its saved connection, or a new one
     * – asking for its password as GNOME does).
     *
     * @param {string} id
     * @returns {Promise<boolean>} whether it connected
     */
    join(id) {
        const network = this._networks().find(n => n.name === id);
        if (!network)
            return Promise.resolve(false);
        const devices = [...this._toggle?._items?.keys() ?? []];
        try {
            network.activate();
        } catch (e) {
            console.warn(`Atelier: Wi-Fi network couldn't be activated: ${e.message}`);
            return Promise.resolve(false);
        }
        return waitFor(() => {
            if (network.is_active && devices.some(d => d.state === NM_ACTIVATED))
                return true;
            const states = devices.map(d => d.state);
            if (!network.is_active && states.every(s => s === NM_FAILED || s === NM_DISCONNECTED) &&
                this._seenBusy)
                return false;
            this._seenBusy ||= states.some(s => s >= NM_PREPARE && s < NM_ACTIVATED);
            return null;
        }, () => (this._seenBusy = false));
    }

    /** While the card is open: GNOME scans, and what it finds shows. */
    watchNetworks(watching) {
        if (watching && !this._pollId) {
            this._toggle?._startScanning?.();
            this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WIFI_POLL, () => {
                this._changed();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!watching && this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
            this._toggle?._stopScanning?.();
        }
    }

    openSettings() {
        openPanel('gnome-wifi-panel.desktop');
    }

    destroy() {
        this.watchNetworks(false);
        super.destroy();
    }
}

/**
 * Wired: GNOME's wired toggle (NMWiredToggle) and its items – a device
 * each, with a cable in (GNOME shows no other), and its connections, as
 * GNOME's wired menu has them. Turned on or off as GNOME's toggle does it;
 * a connection chosen as its menu does.
 *
 * State: available (a cable in), on (a connection up or on its way),
 * connecting, speed (Mb/s, of the device connected; 0 unknown),
 * connections [{id, name, device, speed, active, connecting}].
 */
export class WiredAdapter extends Adapter {
    constructor(quickSettings) {
        super();
        this._toggle = quickSettings._network?._wiredToggle ?? null;
        this._changedItems = () => {
            this._watchItems();
            this._changed();
        };
        this._watch(this._toggle,
            'notify::visible', this._changedItems,
            'notify::checked', this._changedItems,
            'notify::subtitle', this._changedItems,
            'notify::icon-name', this._changedItems);
        this._watchItems();
    }

    // Each device's item and the device: their connections, states, speeds.
    _watchItems() {
        for (const item of this._toggle?._items?.values() ?? []) {
            if (!this._watched.has(item)) {
                this._watch(item,
                    'notify::visible', this._changedItems,
                    'notify::is-active', this._changedItems,
                    'notify::name', this._changedItems,
                    'notify::icon-name', this._changedItems);
            }
            const device = item._device;
            if (device && !this._watched.has(device)) {
                this._watch(device,
                    'notify::speed', () => this._changed(),
                    'notify::state', this._changedItems,
                    'notify::available-connections', this._changedItems);
            }
        }
    }

    // GNOME's items shown: a cable in.
    _items() {
        if (!this._toggle?.visible)
            return [];
        return [...this._toggle._items?.values() ?? []].filter(item => item.visible);
    }

    get available() {
        return this._items().length > 0;
    }

    get on() {
        return this.available && Boolean(this._toggle?.checked);
    }

    get connecting() {
        return this._items().some(item => item.state === NM_CONNECTION_ACTIVATING);
    }

    get speed() {
        const item = this._items().find(i => i.state === NM_CONNECTION_ACTIVATED);
        return item?._device?.speed ?? 0;
    }

    get connections() {
        const connections = [];
        for (const item of this._items()) {
            const device = item.name || '';
            const speed = item._device?.speed ?? 0;
            const entries = [...item._connectionItems?.entries() ?? []];
            if (!entries.length) {
                // (None saved: GNOME's "Connect", which makes one.)
                connections.push({id: `device:${device}`, name: device || 'Wired', device: '', speed,
                    active: false, connecting: false, _activate: () => item.activate()});
                continue;
            }
            for (const [connection, connectionItem] of entries) {
                const state = connectionItem.state;
                connections.push({
                    id: connection.get_uuid?.() ?? connection.get_id(), name: connection.get_id() || device,
                    device, speed,
                    active: state === NM_CONNECTION_ACTIVATED, connecting: state === NM_CONNECTION_ACTIVATING,
                    _activate: () => item.activateConnection(connection),
                });
            }
        }
        return connections;
    }

    /** Turn the wired connection on or off: GNOME's toggle clicked. */
    setOn(on) {
        if (this.on !== on)
            click(this._toggle);
    }

    /**
     * Bring a connection up (one up already stays so).
     *
     * @param {string} id
     */
    activate(id) {
        const connection = this.connections.find(c => c.id === id);
        if (connection && !connection.active && !connection.connecting)
            connection._activate();
    }

    openSettings() {
        openPanel('gnome-network-panel.desktop');
    }
}

// Resolves once check() says true or false (null: not yet), or false after
// a while.
function waitFor(check, done = null) {
    return new Promise(resolve => {
        const start = GLib.get_monotonic_time();
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            let result = null;
            try {
                result = check();
            } catch {
                result = false;
            }
            if (result === null && GLib.get_monotonic_time() - start > CONNECT_TIMEOUT * 1e6)
                result = false;
            if (result === null)
                return GLib.SOURCE_CONTINUE;
            waitFor.pending.delete(id);
            done?.();
            resolve(result);
            return GLib.SOURCE_REMOVE;
        });
        // (Not kept past a shell quitting.)
        waitFor.pending.add(id);
    });
}
waitFor.pending = new Set();

/**
 * Bluetooth: GNOME's toggle and its client's paired devices.
 *
 * State: available, on, devices [{id, name, icon, connected, battery}].
 */
export class BluetoothAdapter extends Adapter {
    constructor(quickSettings) {
        super();
        this._toggle = quickSettings._bluetooth?.quickSettingsItems?.[0] ?? null;
        this._client = this._toggle?._client ?? null;
        this._watch(this._toggle,
            'notify::visible', () => this._changed(),
            'notify::checked', () => this._changed(),
            'notify::subtitle', () => this._changed());
        this._watch(this._client,
            'devices-changed', () => this._changed(),
            'notify::active', () => this._changed());
    }

    get available() {
        return Boolean(this._toggle?.visible);
    }

    get on() {
        return Boolean(this._client?.active ?? this._toggle?.checked);
    }

    setOn(on) {
        if (this.on === on)
            return;
        if (this._client?.toggleActive)
            this._client.toggleActive();
        else
            click(this._toggle);
    }

    _devices() {
        const devices = [...this._client?.getDevices?.() ?? []];
        return devices.sort((a, b) => (b.connected - a.connected) || a.alias.localeCompare(b.alias));
    }

    get devices() {
        return this._devices().map(device => {
            // (A battery GNOME Bluetooth knows of: its type other than none.)
            const battery = device.battery_type ? Math.round(device.battery_percentage ?? 0) : null;
            return {
                id: device.get_object_path?.() ?? device.alias, name: device.alias || device.name || '',
                icon: device.icon || 'bluetooth-active-symbolic', connected: Boolean(device.connected),
                battery: Number.isFinite(battery) && battery > 0 ? battery : null,
            };
        });
    }

    /** @returns {string} the device connected (the first), or '' */
    get connectedName() {
        return this.devices.find(d => d.connected)?.name ?? '';
    }

    /**
     * @param {string} id
     * @returns {Promise<boolean>} whether it connected
     */
    async join(id) {
        const device = this._devices().find(d => (d.get_object_path?.() ?? d.alias) === id);
        if (!device || !this._client?.toggleDevice)
            return false;
        if (device.connected)
            return true;
        try {
            await this._client.toggleDevice(device);
        } catch {
            return false;
        }
        return Boolean(device.connected);
    }

    openSettings() {
        openPanel('gnome-bluetooth-panel.desktop');
    }
}

/**
 * Airplane mode: GNOME's toggle (rfkill).
 *
 * State: available, on.
 */
export class AirplaneAdapter extends Adapter {
    constructor(quickSettings) {
        super();
        this._toggle = quickSettings._rfkill?.quickSettingsItems?.[0] ?? null;
        this._watch(this._toggle,
            'notify::visible', () => this._changed(),
            'notify::checked', () => this._changed());
    }

    get available() {
        return Boolean(this._toggle?.visible);
    }

    get on() {
        return Boolean(this._toggle?.checked);
    }

    setOn(on) {
        if (this.on === on)
            return;
        const manager = this._toggle?._manager;
        if (manager)
            manager.airplaneMode = on;
        else
            click(this._toggle);
    }
}

/**
 * The sound's outputs: GNOME's volume slider's (Gvc).
 *
 * State: available, devices [{id, name, short, icon (a Gio.Icon or name)}], activeId.
 */
export class OutputAdapter extends Adapter {
    constructor(quickSettings) {
        super();
        this._slider = quickSettings._volumeOutput?._output ?? null;
        this._control = this._slider?._control ?? null;
        this._watch(this._control,
            'output-added', () => this._changed(),
            'output-removed', () => this._changed(),
            'active-output-update', () => this._changed(),
            'default-sink-changed', () => this._changed());
        this._watch(this._slider, 'notify::visible', () => this._changed());
    }

    get available() {
        return Boolean(this._slider?.visible) && this.devices.length > 0;
    }

    get devices() {
        const control = this._control;
        if (!control)
            return [];
        return [...this._slider._deviceItems?.keys() ?? []].map(id => {
            const device = control.lookup_output_id(id);
            if (!device)
                return null;
            const description = device.description ?? '';
            const origin = device.origin ?? '';
            const icon = device.get_gicon?.() ?? null;
            const iconName = device.get_icon_name?.() ?? '';
            return {
                id, name: description || origin || 'Output', detail: origin,
                short: shortOutputName({description, origin, icon: iconName}),
                icon: icon ?? (iconName || 'audio-speakers-symbolic'),
            };
        }).filter(Boolean);
    }

    get activeId() {
        const control = this._control;
        const sink = control?.get_default_sink?.();
        if (!sink)
            return null;
        return control.lookup_device_from_stream(sink)?.get_id() ?? null;
    }

    select(id) {
        const device = this._control?.lookup_output_id(id);
        if (device)
            this._control.change_output(device);
    }

    openSettings() {
        openPanel('gnome-sound-panel.desktop');
    }
}

/**
 * Caffeine: the Caffeine extension's toggle where it is there (its timer
 * too), else Atelier's own – the session kept from going idle and
 * suspending, through GNOME's session manager – never both at once.
 *
 * State: on, choice (0, 1, 2: 30 min, 1 h, until off; null: another).
 */
export class CaffeineAdapter extends Adapter {
    constructor(quickSettings) {
        super();
        this._grid = quickSettings.menu?._grid ?? null;
        this._toggle = null;
        this._own = {on: false, choice: 2, cookie: null, timeoutId: 0, serial: 0};
        this._watch(this._grid,
            'child-added', () => this._find(),
            'child-removed', () => this._find());
        this._find();
    }

    /** @returns {boolean} whether the Caffeine extension's toggle is the one driven */
    get external() {
        return this._toggle !== null;
    }

    // The extension's toggle (CaffeineToggle), come or gone.
    _find() {
        const toggle = this._grid?.get_children().find(child =>
            child.constructor?.name === 'CaffeineToggle' ||
            (typeof child._checkTimer === 'function' && child._timerItems instanceof Map)) ?? null;
        if (toggle === this._toggle)
            return;
        this._unwatch(this._toggle);
        this._unwatch(this._toggle?._settings);
        this._toggle = toggle;
        if (toggle) {
            // (Never both: Atelier's own lets go.)
            this._setOwn(false);
            this._watch(toggle,
                'notify::checked', () => this._changed(),
                'notify::visible', () => this._changed(),
                'destroy', () => {
                    if (this._toggle === toggle) {
                        this._unwatch(toggle);
                        this._unwatch(toggle._settings);
                        this._toggle = null;
                        this._changed();
                    }
                });
            this._watch(toggle._settings, 'changed::countdown-timer', () => this._changed());
        }
        this._changed();
    }

    get on() {
        return this._toggle ? Boolean(this._toggle.checked) : this._own.on;
    }

    get choice() {
        if (!this._toggle)
            return this._own.choice;
        let seconds = 0;
        try {
            seconds = this._toggle._settings?.get_int('countdown-timer') ?? 0;
        } catch {
            seconds = 0;
        }
        const index = CAFFEINE_DURATIONS.indexOf(seconds);
        return index < 0 ? null : index;
    }

    setOn(on) {
        if (this._toggle) {
            if (Boolean(this._toggle.checked) !== on)
                click(this._toggle);
        } else {
            this._setOwn(on);
        }
        this._changed();
    }

    /**
     * Keep awake for a chip's duration (and turn it on).
     *
     * @param {number} index - 0, 1, 2
     */
    choose(index) {
        const seconds = CAFFEINE_DURATIONS[index];
        if (this._toggle) {
            if (typeof this._toggle._checkTimer === 'function')
                this._toggle._checkTimer(seconds);
            else
                this.setOn(true);
        } else {
            this._own.choice = index;
            this._setOwn(true);
        }
        this._changed();
    }

    // Atelier's own: an inhibitor of idling and suspending, its timer.
    _setOwn(on) {
        const own = this._own;
        if (own.timeoutId)
            GLib.source_remove(own.timeoutId);
        own.timeoutId = 0;
        const serial = ++own.serial;
        if (on) {
            const seconds = CAFFEINE_DURATIONS[own.choice] ?? 0;
            if (seconds > 0) {
                own.timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                    own.timeoutId = 0;
                    this._setOwn(false);
                    this._changed();
                    return GLib.SOURCE_REMOVE;
                });
            }
            if (own.cookie === null && !own.asking) {
                own.asking = true;
                // (Idle 8, suspend 4.)
                Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
                    'org.gnome.SessionManager', 'Inhibit',
                    new GLib.Variant('(susu)', ['atelier', 0, 'Keeping the screen awake (Atelier)', 12]),
                    new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
                        own.asking = false;
                        let cookie = null;
                        try {
                            [cookie] = bus.call_finish(result).deepUnpack();
                        } catch (e) {
                            console.warn(`Atelier: the session couldn't be kept awake: ${e.message}`);
                        }
                        // (Turned off, or destroyed, meanwhile.)
                        if (cookie !== null && (!own.on || own.destroyed))
                            uninhibit(cookie);
                        else
                            own.cookie = cookie;
                        if (cookie === null && own.on && serial === own.serial) {
                            own.on = false;
                            this._changed();
                        }
                    });
            }
        } else if (own.cookie !== null) {
            uninhibit(own.cookie);
            own.cookie = null;
        }
        own.on = on;
    }

    destroy() {
        this._own.destroyed = true;
        this._setOwn(false);
        super.destroy();
    }
}

function uninhibit(cookie) {
    Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
        'org.gnome.SessionManager', 'Uninhibit', new GLib.Variant('(u)', [cookie]), null,
        Gio.DBusCallFlags.NONE, -1, null, null);
}

/**
 * The battery (GNOME's system item's, UPower's display device) and the
 * system buttons (GNOME's: screenshot, settings, lock, power off).
 *
 * State: battery {present, percent, seconds, discharging, charged}; buttons
 * {screenshot, settings, lock, power: {visible}}.
 */
export class SystemAdapter extends Adapter {
    constructor(quickSettings) {
        super();
        this._item = quickSettings._system?._systemItem ?? null;
        this._power = this._item?._powerToggle ?? this._item?.powerToggle ?? null;
        this._watch(this._power, 'notify::visible', () => this._changed(), 'notify::title', () => this._changed());
        this._watch(this._power?._proxy, 'g-properties-changed', () => this._changed());
        this._buttons = this._findButtons();
        for (const button of Object.values(this._buttons))
            this._watch(button, 'notify::visible', () => this._changed());
    }

    _findButtons() {
        const children = this._item?.child?.get_children?.() ?? [];
        const byClass = name => children.find(c => c.constructor?.name === name);
        const byIcon = name => children.find(c => c.icon_name === name || c.child?.icon_name === name);
        return {
            screenshot: byClass('ScreenshotItem') ?? byIcon('screenshooter-symbolic') ?? null,
            settings: byClass('SettingsItem') ?? children.find(c => c._settingsApp) ?? null,
            lock: byClass('LockItem') ?? byIcon('system-lock-screen-symbolic') ?? null,
            power: byClass('ShutdownItem') ?? byIcon('system-shutdown-symbolic') ?? null,
        };
    }

    get battery() {
        const proxy = this._power?._proxy;
        const present = Boolean(proxy?.IsPresent);
        if (!present)
            return {present: false, percent: 0, seconds: 0, discharging: false, charged: false};
        const state = proxy.State;
        return {
            present, percent: Math.round(proxy.Percentage ?? 0), seconds: proxy.TimeToEmpty ?? 0,
            discharging: state === DISCHARGING || state === PENDING_DISCHARGE,
            charged: state === FULLY_CHARGED,
        };
    }

    /**
     * @param {string} name - 'screenshot', 'settings', 'lock', 'power'
     * @returns {boolean} whether GNOME shows it (it can do it)
     */
    shows(name) {
        const button = this._buttons[name];
        return Boolean(button) && button.visible;
    }

    /** @param {string} name - 'screenshot', 'settings', 'lock', 'power' */
    activate(name) {
        click(this._buttons[name]);
    }
}

/**
 * All of them, for the GNOME quick settings given.
 *
 * @param {object} quickSettings - Main.panel.statusArea.quickSettings
 * @returns {object} {wifi, bt, airplane, output, caffeine, system}
 */
export function makeAdapters(quickSettings) {
    return {
        wifi: new WifiAdapter(quickSettings),
        wired: new WiredAdapter(quickSettings),
        bt: new BluetoothAdapter(quickSettings),
        airplane: new AirplaneAdapter(quickSettings),
        output: new OutputAdapter(quickSettings),
        caffeine: new CaffeineAdapter(quickSettings),
        system: new SystemAdapter(quickSettings),
    };
}

/** Stop waiting for connections (the control centre let go). */
export function dropPending() {
    for (const id of waitFor.pending)
        GLib.source_remove(id);
    waitFor.pending.clear();
}
