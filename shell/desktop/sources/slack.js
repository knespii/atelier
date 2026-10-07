// Slack's messages that came since Slack was last looked at, counted from
// its notifications as they reach GNOME (also while Do Not Disturb keeps
// their banners away): how many, and who wrote, the latest first. A Slack
// window getting the focus means they were seen. Nothing is asked of Slack
// itself, and nothing of what the messages say is kept.

import Shell from 'gi://Shell';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {addMessage, isSlack, senderOf} from '../../../lib/slack.js';

// Where Slack may be installed: the snap, the flatpak, the .deb.
const APP_IDS = ['slack_slack.desktop', 'com.slack.Slack.desktop', 'slack.desktop'];

export class SlackSource extends EventEmitter {
    constructor() {
        super();
        /** messages since Slack was last looked at */
        this.unread = 0;
        /** who wrote them: [{name, count, time}], the latest first */
        this.senders = [];
        this._app = null;
        // A notification's headline and text as last counted: one an app
        // updates with a new message counts again. (In memory only.)
        this._counted = new WeakMap();
        Main.messageTray.connectObject('source-added', (_, source) => this._watch(source), this);
        // (Those there already came before: not counted, only watched.)
        for (const source of Main.messageTray.getSources())
            this._watch(source, true);
        global.display.connectObject('notify::focus-window', () => this._checkFocus(), this);
    }

    _watch(source, old = false) {
        if (!isSlack(source.app?.get_id?.() ?? source.policy?.id ?? null, source.title))
            return;
        this._app = source.app ?? this._app;
        source.connectObject(
            'notification-added', (_, notification) => this._track(notification),
            'destroy', () => source.disconnectObject(this),
            this);
        if (old)
            source.notifications.forEach(notification => this._track(notification, true));
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

    _count(notification) {
        // (Read in Slack as it came.)
        if (this.slackFocused())
            return;
        this.unread++;
        this.senders = addMessage(this.senders, senderOf(notification.title, notification.body), Date.now());
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
        if (this.unread === 0 && this.senders.length === 0)
            return;
        this.unread = 0;
        this.senders = [];
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
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources()) {
            source.disconnectObject(this);
            source.notifications.forEach(notification => notification.disconnectObject(this));
        }
        global.display.disconnectObject(this);
    }
}
