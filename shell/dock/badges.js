// What the dock's icons carry besides the app: a count (of the app's
// notifications, or one the app gives over Unity's launcher API), its
// progress, whether it is urgent. One source for all the docks, saying
// 'changed' with the app's id whenever any of it changes for an app.
//
// Apps send their counts as a D-Bus signal, Update(app_uri, properties),
// to whoever listens; an app's entry goes when it leaves the bus. The
// notifications are counted from GNOME's message tray (the island only
// replaces its banners: the notifications stay there), none while Do Not
// Disturb is on. Nothing is listened to while the dock shows no badges.

import Gio from 'gi://Gio';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {NotificationApplicationPolicy} from 'resource:///org/gnome/shell/ui/messageTray.js';

import {Timers} from './timers.js';

const LAUNCHER_ENTRY = 'com.canonical.Unity.LauncherEntry';
const APP_URI = 'application://';

/**
 * @param {string} id - an app's id, with or without ".desktop"
 * @returns {string} the id the dock knows it by ("….desktop")
 */
function desktopId(id) {
    return id.endsWith('.desktop') ? id : `${id}.desktop`;
}

/**
 * @param {MessageTray.Source} source
 * @returns {string|null} the id of the app it is for, if it is for one
 */
function sourceAppId(source) {
    const app = source.app ?? null;
    if (app?.get_id?.())
        return app.get_id();
    const policy = source.policy;
    return policy instanceof NotificationApplicationPolicy && policy.id ? desktopId(policy.id) : null;
}

export class BadgeSource extends EventEmitter {
    /**
     * @param {Gio.Settings} settings - the dock's
     */
    constructor(settings) {
        super();
        this._settings = settings;
        this._timers = new Timers();
        this._destroyed = false;
        this._entries = new Map(); // app id → what it gave over the launcher API (and its sender)
        this._trayCounts = new Map(); // app id → its notifications
        this._sources = new Set(); // the tray's sources watched
        this._updateId = 0;
        this._ownerId = 0;
        this._banners = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._banners.connectObject('changed::show-banners', () => this._countTray(), this);
        settings.connectObject(
            'changed::show-icons-emblems', () => this._sync(),
            'changed::show-icons-notifications-counter', () => this._sync(),
            'changed::application-counter-overrides-notifications', () => this._emitAll(),
            this);
        this._sync();
    }

    /**
     * @param {string} appId
     * @returns {number} the count to show on the app, 0 for none
     */
    countFor(appId) {
        const entry = this._entries.get(appId);
        const own = entry?.countVisible ? Math.max(0, entry.count) : 0;
        if (own > 0 && this._settings.get_boolean('application-counter-overrides-notifications'))
            return own;
        return own + (this._trayCounts.get(appId) ?? 0);
    }

    /**
     * @param {string} appId
     * @returns {number|null} how far along the app is, 0 to 1, or null for nothing to show
     */
    progressFor(appId) {
        const entry = this._entries.get(appId);
        return entry?.progressVisible ? Math.min(Math.max(entry.progress, 0), 1) : null;
    }

    /**
     * @param {string} appId
     * @returns {boolean} whether the app asks for attention
     */
    urgentFor(appId) {
        return this._entries.get(appId)?.urgent ?? false;
    }

    // Listening only for what the dock shows.
    _sync() {
        const emblems = this._settings.get_boolean('show-icons-emblems');
        this._syncLauncherApi(emblems);
        this._syncTray(emblems && this._settings.get_boolean('show-icons-notifications-counter'));
    }

    _syncLauncherApi(on) {
        if (on && !this._updateId) {
            const bus = Gio.DBus.session;
            this._updateId = bus.signal_subscribe(null, LAUNCHER_ENTRY, 'Update', null, null,
                Gio.DBusSignalFlags.NONE, (connection, sender, path, iface, signal, params) =>
                    this._onUpdate(sender, params));
            this._ownerId = bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
                'NameOwnerChanged', '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
                (connection, sender, path, iface, signal, params) => this._onOwnerChanged(params));
        } else if (!on && this._updateId) {
            this._unsubscribe();
            const ids = [...this._entries.keys()];
            this._entries.clear();
            ids.forEach(id => this.emit('changed', id));
        }
    }

    _unsubscribe() {
        const bus = Gio.DBus.session;
        if (this._updateId)
            bus.signal_unsubscribe(this._updateId);
        if (this._ownerId)
            bus.signal_unsubscribe(this._ownerId);
        this._updateId = this._ownerId = 0;
    }

    _onUpdate(sender, params) {
        if (this._destroyed || this._timers.stopped)
            return;
        let uri, properties;
        try {
            [uri, properties] = params.deepUnpack();
        } catch {
            return;
        }
        if (typeof uri !== 'string' || !uri)
            return;
        const appId = desktopId(uri.startsWith(APP_URI) ? uri.slice(APP_URI.length) : uri);
        const entry = this._entries.get(appId) ??
            {count: 0, countVisible: false, progress: 0, progressVisible: false, urgent: false};
        entry.sender = sender;
        const read = (key, field, type) => {
            const value = properties[key]?.unpack?.();
            if (typeof value === type)
                entry[field] = value;
        };
        read('count', 'count', 'number');
        read('count-visible', 'countVisible', 'boolean');
        read('progress', 'progress', 'number');
        read('progress-visible', 'progressVisible', 'boolean');
        read('urgent', 'urgent', 'boolean');
        this._entries.set(appId, entry);
        this.emit('changed', appId);
    }

    // An app gone from the bus takes its counts along.
    _onOwnerChanged(params) {
        if (this._destroyed || this._timers.stopped)
            return;
        const [name, , owner] = params.deepUnpack();
        if (owner)
            return;
        for (const [appId, entry] of [...this._entries]) {
            if (entry.sender === name) {
                this._entries.delete(appId);
                this.emit('changed', appId);
            }
        }
    }

    _syncTray(on) {
        const tray = Main.messageTray;
        if (on && !this._trayOn) {
            this._trayOn = true;
            tray.connectObject(
                'source-added', (_, source) => {
                    this._watch(source);
                    this._countTray();
                },
                'source-removed', (_, source) => {
                    this._unwatch(source);
                    this._countTray();
                },
                this);
            tray.getSources().forEach(source => this._watch(source));
        } else if (!on && this._trayOn) {
            this._trayOn = false;
            tray.disconnectObject(this);
            [...this._sources].forEach(source => this._unwatch(source));
        }
        this._countTray();
    }

    _watch(source) {
        if (this._sources.has(source))
            return;
        this._sources.add(source);
        source.connectObject(
            'notification-added', () => this._countTray(),
            'notification-removed', () => this._countTray(),
            this);
    }

    _unwatch(source) {
        this._sources.delete(source);
        source.disconnectObject(this);
    }

    // The tray's notifications, by app (none while Do Not Disturb is on),
    // and 'changed' for each app whose count is not what it was.
    _countTray() {
        if (this._destroyed)
            return;
        const counts = new Map();
        if (this._trayOn && this._banners.get_boolean('show-banners')) {
            for (const source of this._sources) {
                const appId = sourceAppId(source);
                if (appId && source.notifications?.length)
                    counts.set(appId, (counts.get(appId) ?? 0) + source.notifications.length);
            }
        }
        const changed = new Set([...counts.keys(), ...this._trayCounts.keys()]
            .filter(id => counts.get(id) !== this._trayCounts.get(id)));
        this._trayCounts = counts;
        changed.forEach(id => this.emit('changed', id));
    }

    _emitAll() {
        new Set([...this._entries.keys(), ...this._trayCounts.keys()]).forEach(id => this.emit('changed', id));
    }

    destroy() {
        this._destroyed = true;
        this._unsubscribe();
        this._timers.destroy();
        Main.messageTray.disconnectObject(this);
        [...this._sources].forEach(source => this._unwatch(source));
        this._trayOn = false;
        this._settings.disconnectObject(this);
        this._banners.disconnectObject(this);
        this._entries.clear();
        this._trayCounts.clear();
        this.disconnectAll();
    }
}
