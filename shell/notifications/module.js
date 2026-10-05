// Notifications in the island. GNOME's message tray keeps deciding what is
// shown and when (Do Not Disturb, per-app settings, the queue, critical
// notifications, the user being away); only the banner itself is replaced
// by a page in the island. Notifications stay in GNOME's list. When the
// island can't show one (turned off, or hidden next to a fullscreen window),
// GNOME's own banner does.

import GLib from 'gi://GLib';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {NotificationDestroyedReason, State} from 'resource:///org/gnome/shell/ui/messageTray.js';

import {buttonMode, canonicalAppId, isMuted, muteApp} from '../../lib/notifications.js';
import {MORPH_TIME} from '../island/island.js';
import {NotificationPage} from './page.js';

// As in the message tray: a user idle for longer is away, and the banner
// waits for them.
const IDLE_TIME = 1000;
// While the pointer rests on a notification it stays; once it leaves,
// the notification goes after this long.
const HOVER_TIMEOUT = 10 * 60 * 1000;
const LEAVE_TIMEOUT = 1500;

export class NotificationsModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     * @param {ModuleManager} context.modules
     */
    constructor({settings, modules}) {
        this._settings = settings;
        this._modules = modules;
        this._injections = new InjectionManager();
        this._page = null; // the island page of the notification shown, if the island shows it
        this._serial = 0;
        this._timeouts = new Set();
    }

    enable() {
        this._notifications = this._settings.get_child('notifications');
        const tray = Main.messageTray;
        const bridge = this;
        // `this` inside the overrides is the tray.
        this._injections.overrideMethod(tray, '_showNotification', original => function () {
            return bridge._show(this, original);
        });
        this._injections.overrideMethod(tray, '_updateShowingNotification', original => function () {
            return bridge._page ? bridge._present(this) : original.call(this);
        });
        this._injections.overrideMethod(tray, '_hideNotification', original => function (animate) {
            return bridge._page ? bridge._hide(this) : original.call(this, animate);
        });
        // Only the banner expands or takes focus; the island has none.
        for (const name of ['_expandBanner', '_ensureBannerFocused']) {
            this._injections.overrideMethod(tray, name, original => function (...args) {
                return bridge._page ? undefined : original.call(this, ...args);
            });
        }
    }

    disable() {
        const tray = Main.messageTray;
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        this._island()?.island.disconnectObject(this);
        // The tray must not be left waiting for an island page.
        const page = this._page;
        if (page) {
            this._finish(tray, false);
            this._island()?.island.close(page);
        }
        this._injections.clear();
        this._notifications = null;
        tray._updateState();
    }

    /** @returns {IslandModule|null} */
    _island() {
        return this._modules?.get('island') ?? null;
    }

    _appId(notification) {
        const id = notification.source?.policy?.id;
        return id ? canonicalAppId(id) : null;
    }

    _show(tray, original) {
        // Muted apps: their notifications go to the list without a banner.
        let skipped = false;
        while (tray._notificationQueue.length > 0 &&
               isMuted(this._notifications, this._appId(tray._notificationQueue[0]) ?? '')) {
            tray._notificationQueue.shift();
            skipped = true;
        }
        if (skipped)
            tray.emit('queue-changed');
        if (tray._notificationQueue.length === 0)
            return;

        const islandModule = this._island();
        if (!islandModule?.available)
            return original.call(tray);
        if (islandModule.occupied) {
            // The switcher or a menu has the keyboard, or a toast is up: the
            // notification waits in the queue until the island is free.
            this._retryWhenFree(tray, islandModule);
            return;
        }

        const notification = tray._notificationQueue.shift();
        tray._notification = notification;
        tray.emit('queue-changed');

        // What the tray's own banner does on showing, minus the banner.
        tray._userActiveWhileNotificationShown = tray.idleMonitor.get_idletime() <= IDLE_TIME;
        if (!tray._userActiveWhileNotificationShown)
            tray.idleMonitor.add_user_active_watch(tray._onIdleMonitorBecameActive.bind(tray));
        const [x, y] = global.get_pointer();
        tray._showNotificationMouseX = x;
        tray._showNotificationMouseY = y;
        tray._lastSeenMouseX = x;
        tray._lastSeenMouseY = y;
        tray._resetNotificationLeftTimeout();

        const page = new NotificationPage(notification, buttonMode(this._notifications, this._appId(notification) ?? ''));
        page.connect('activate', () => this._activate(tray, notification));
        page.connect('dismiss', () => notification.destroy(NotificationDestroyedReason.DISMISSED));
        page.connect('action', (_, index) => {
            notification.actions[index]?.activate();
            this._expire(tray, notification);
        });
        page.connect('mute', (_, seconds) => {
            muteApp(this._notifications, this._appId(notification), seconds);
            this._expire(tray, notification);
        });
        page.connect('notify::hover', () => {
            if (tray._notification === notification && tray._notificationState === State.SHOWN)
                tray._updateNotificationTimeout(page.hover ? HOVER_TIMEOUT : LEAVE_TIMEOUT);
        });
        page.connect('destroy', () => {
            if (this._page === page)
                this._finish(tray, true);
        });
        this._page = page;
        this._island().island.open(page);
        this._present(tray);
        return undefined;
    }

    /**
     * The notification shows (again, when it was updated): mark it seen, play
     * its sound and start the time until it goes.
     *
     * @param {MessageTray} tray
     */
    _present(tray) {
        const notification = tray._notification;
        notification.acknowledged = true;
        notification.playSound();
        tray._notificationState = State.SHOWING;
        const serial = ++this._serial;
        // An updated notification may have grown; the island follows. (If
        // another page took its place, the page is gone and so is this.)
        const island = this._island()?.island;
        if (island?.page === this._page)
            this._page.resized();
        // Shown once the island has grown into it, like the banner after
        // sliding in; then the usual time until it goes.
        this._after(MORPH_TIME, () => {
            if (serial !== this._serial || tray._notification !== notification)
                return;
            tray._notificationState = State.SHOWN;
            tray._showNotificationCompleted();
            tray._updateState();
        });
    }

    _hide(tray) {
        tray._resetNotificationLeftTimeout();
        tray._notificationState = State.HIDING;
        const serial = ++this._serial;
        const island = this._island()?.island;
        const shown = island?.page === this._page;
        if (shown)
            island.close(this._page);
        this._after(shown ? MORPH_TIME : 0, () => {
            if (serial === this._serial)
                this._finish(tray, true);
        });
    }

    /**
     * What the tray does once its banner is gone.
     *
     * @param {MessageTray} tray
     * @param {boolean} update - let the tray go on (show the next one)
     */
    _finish(tray, update) {
        this._serial++;
        this._page = null;
        const notification = tray._notification;
        tray._notification = null;
        tray._notificationState = State.HIDDEN;
        tray._updateNotificationTimeout(0);
        if (!tray._notificationRemoved && notification?.isTransient)
            notification.destroy(NotificationDestroyedReason.EXPIRED);
        tray._pointerInNotification = false;
        tray._notificationRemoved = false;
        if (update)
            tray._updateState();
    }

    _activate(tray, notification) {
        Main.overview.hide();
        Main.panel.closeCalendar();
        notification.activate();
        this._expire(tray, notification);
    }

    /** Let the notification go without removing it from the list. */
    _expire(tray, notification) {
        if (tray._notification === notification && this._page)
            tray._expireNotification();
    }

    _retryWhenFree(tray, islandModule) {
        const island = islandModule.island;
        island.connectObject('page-closed', () => {
            if (islandModule.occupied)
                return;
            island.disconnectObject(this);
            tray._updateState();
        }, this);
    }

    _after(delay, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }
}
