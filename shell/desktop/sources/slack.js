// Slack's messages that came since Slack was last looked at: how many – as
// Slack itself counts them, the number it puts on its icon in a dock (the
// Unity launcher API), or else counted from its notifications as they
// reach GNOME (also while Do Not Disturb keeps their banners away) – and
// who wrote, the latest first, from those notifications. A Slack window
// getting the focus means they were seen. What is known lasts over the
// screen being locked (the desktop's widgets stop then), and what came
// meanwhile counts too. Nothing is asked of Slack itself, and nothing of
// what the messages say is kept.

import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {addMessage, isSlack, senderOf} from '../../../lib/slack.js';

// Where Slack may be installed: the snap, the flatpak, the .deb.
const APP_IDS = ['slack_slack.desktop', 'com.slack.Slack.desktop', 'slack.desktop'];
const LAUNCHER_ENTRY = 'com.canonical.Unity.LauncherEntry';

// What is known, kept while the extension is on: over the screen locked,
// as the desktop's widgets stop and start again. (In memory only.)
const known = {
    count: 0, // counted from notifications
    badge: null, // Slack's own count, once it has said one
    senders: [],
    handled: 0, // the time of the latest notification counted, ms
};

export class SlackSource extends EventEmitter {
    constructor() {
        super();
        this._app = null;
        // A notification's headline and text as last counted: one an app
        // updates with a new message counts again. (In memory only.)
        this._counted = new WeakMap();
        Main.messageTray.connectObject('source-added', (_, source) => this._watch(source), this);
        // (Those there already came before: not counted, only watched.)
        for (const source of Main.messageTray.getSources())
            this._watch(source, true);
        global.display.connectObject('notify::focus-window', () => this._checkFocus(), this);
        this._badgeId = Gio.DBus.session.signal_subscribe(null, LAUNCHER_ENTRY, 'Update', null, null,
            Gio.DBusSignalFlags.NONE, (connection, sender, path, iface, signal, params) => this._onBadge(params));
    }

    /** @returns {number} messages since Slack was last looked at */
    get unread() {
        return known.badge ?? known.count;
    }

    /** @param {number} count - (for showing it off: as if counted) */
    set unread(count) {
        known.badge = null;
        known.count = count;
    }

    /** @returns {object[]} who wrote them: [{name, count, time}], the latest first */
    get senders() {
        return known.senders;
    }

    set senders(senders) {
        known.senders = senders;
    }

    // The number Slack puts on its icon: what it counts as unread, read on
    // another device or not. Nothing left: all of it seen.
    _onBadge(params) {
        let uri, properties;
        try {
            [uri, properties] = params.deepUnpack();
        } catch {
            return;
        }
        if (typeof uri !== 'string' || !isSlack(uri, null))
            return;
        const count = properties.count?.unpack?.();
        const visible = properties['count-visible']?.unpack?.();
        if (typeof count !== 'number' && typeof visible !== 'boolean')
            return;
        const badge = visible === false ? 0 : Math.max(0, count ?? known.badge ?? 0);
        if (badge === known.badge)
            return;
        known.badge = badge;
        if (badge === 0)
            known.senders = [];
        this.emit('changed');
    }

    _watch(source, old = false) {
        if (!isSlack(source.app?.get_id?.() ?? source.policy?.id ?? null, source.title))
            return;
        this._app = source.app ?? this._app;
        source.connectObject(
            'notification-added', (_, notification) => this._track(notification),
            'destroy', () => source.disconnectObject(this),
            this);
        // (Those there already: only what came while nothing counted – the
        // screen locked – counts now.)
        if (old)
            source.notifications.forEach(notification => this._track(notification, !this._newer(notification)));
    }

    _track(notification, old = false) {
        const said = () => `${notification.title ?? ''}\n${notification.body ?? ''}`;
        this._counted.set(notification, said());
        // GNOME updates the time of a notification an app replaces.
        notification.connectObject(
            'notify::datetime', () => {
                if (said() === this._counted.get(notification))
                    return;
                this._counted.set(notification, said());
                this._count(notification);
            },
            'destroy', () => notification.disconnectObject(this),
            this);
        if (!old)
            this._count(notification);
    }

    _newer(notification) {
        const time = notification.datetime?.to_unix?.() ?? 0;
        return time * 1000 > known.handled;
    }

    _count(notification) {
        const time = (notification.datetime?.to_unix?.() ?? 0) * 1000 || Date.now();
        known.handled = Math.max(known.handled, time);
        // (Read in Slack as it came.)
        if (this.slackFocused())
            return;
        known.count++;
        known.senders = addMessage(known.senders, senderOf(notification.title, notification.body), time);
        this.emit('changed');
    }

    /** @returns {boolean} whether a window of Slack has the focus */
    slackFocused() {
        const window = global.display.focus_window;
        const app = window ? Shell.WindowTracker.get_default().get_window_app(window) : null;
        return Boolean(app) && isSlack(app.get_id(), app.get_name());
    }

    _checkFocus() {
        if (this.slackFocused())
            this.markSeen();
    }

    /** Slack was looked at: nothing unread. */
    markSeen() {
        known.handled = Math.max(known.handled, Date.now());
        if (this.unread === 0 && known.senders.length === 0 && known.count === 0)
            return;
        known.count = 0;
        // (Slack says its own count again as it marks them read.)
        if (known.badge !== null)
            known.badge = 0;
        known.senders = [];
        this.emit('changed');
    }

    /** @returns {Shell.App|null} Slack, as installed */
    get app() {
        if (this._app)
            return this._app;
        const apps = Shell.AppSystem.get_default();
        for (const id of APP_IDS) {
            const app = apps.lookup_app(id);
            if (app)
                return app;
        }
        return null;
    }

    /** Bring Slack up (open it, if it isn't). */
    open() {
        this.app?.activate();
    }

    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._badgeId);
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources()) {
            source.disconnectObject(this);
            source.notifications.forEach(notification => notification.disconnectObject(this));
        }
        global.display.disconnectObject(this);
    }
}
