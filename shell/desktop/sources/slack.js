// Slack's messages that came since Slack was last looked at: how many – as
// Slack itself counts them, the number it puts on its icon in a dock (the
// Unity launcher API), or else counted from its notifications as they
// reach GNOME (also while Do Not Disturb keeps their banners away) – and
// who wrote, the latest first, from those notifications. A Slack window
// getting the focus means they were seen. What is known lasts over the
// screen being locked (the desktop's widgets stop then), and what came
// meanwhile counts too. Nothing of what the messages say is kept.
//
// With a Slack token in the keyring (Settings → Desktop → Slack), Slack's
// Web API is asked too, every three minutes while the desktop's widgets
// run (never on a locked screen): who wrote the direct messages unread,
// and who mentioned you in a channel – also what came while the computer
// was off, which no notification tells. Only who, how many and when are
// kept, in memory; a message's text is only looked at for a mention.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    SENDERS, SOONEST, addMessage, combineWriters, isSlack, mergeSenders, nameOf, nextDelay,
    pickConversations, senderOf, statusOf, timeOf, unreadOf, writersOf,
} from '../../../lib/slack.js';
import {callSlack, keyring, newSession} from '../../../lib/slackWeb.js';

// Where Slack may be installed: the snap, the flatpak, the .deb.
const APP_IDS = ['slack_slack.desktop', 'com.slack.Slack.desktop', 'slack.desktop'];
const LAUNCHER_ENTRY = 'com.canonical.Unity.LauncherEntry';

// Asking the API, each round at most: so many direct messages looked into
// (conversations.info), and their histories read when that does not say
// who wrote; so many channels looked into for mentions; who wrote named
// (users.info, then remembered). Slack lets an app ask 50 a minute of each.
const DIRECT_LOOKS = 24;
const DIRECT_HISTORIES = 8;
const CHANNEL_LOOKS = 6;
const HISTORY = 20; // messages read of each, the latest
const LISTS = 15 * 60 * 1000; // how long the lists of conversations are kept, ms
const PAGES = 5; // of 200 conversations each
// After an unlock, a resume or Slack's count changing: soon, but not at once.
const SHORTLY = 5; // seconds
const AFTER_RESUME = 15;

// What is known, kept while the extension is on: over the screen locked,
// as the desktop's widgets stop and start again. (In memory only.)
const known = {
    count: 0, // counted from notifications
    badge: null, // Slack's own count, once it has said one
    senders: [],
    handled: 0, // the time of the latest notification counted, ms
    // The API's, at its last answer: {count, senders: [{name, aliases,
    // count, time}], time}, or null; and what was counted from
    // notifications since.
    api: null,
    since: 0,
    // Each conversation unread, as the API said: id → [{user, count, time}].
    found: new Map(),
    // Who is who: user id → {name, aliases}.
    names: new Map(),
};
// The token of what was found (to tell another one), in memory only.
let lastToken = null;

/** Asking Slack failed: how (a status of statusOf's, or 'offline'). */
class SlackError extends Error {
    constructor(status, retryAfter = null) {
        super(status);
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

export class SlackSource extends EventEmitter {
    /**
     * @param {Gio.Settings|null} settings - the desktop's: whether there is
     *   a token, and where how asking went is said
     */
    constructor(settings = null) {
        super();
        this._settings = settings;
        this._app = null;
        // The API: the token (in memory only), the user's id, the lists of
        // conversations, where the turn through them got to.
        this._store = keyring;
        this._session = null;
        this._token = null;
        this._me = null;
        this._lists = {};
        this._offsets = {direct: 0, channels: 0};
        this._timeout = 0;
        this._due = 0;
        this._last = 0;
        this._failures = 0;
        this._busy = false;
        this._status = null;
        this._asked = null;
        this._cancellable = new Gio.Cancellable();
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
        // Woken from sleep: soon, once the network is back.
        this._sleepId = Gio.DBus.system.signal_subscribe('org.freedesktop.login1', 'org.freedesktop.login1.Manager',
            'PrepareForSleep', '/org/freedesktop/login1', null, Gio.DBusSignalFlags.NONE,
            (connection, sender, path, iface, signal, params) => {
                if (!params.deepUnpack()[0])
                    this._soon(AFTER_RESUME);
            });
        Gio.NetworkMonitor.get_default().connectObject('network-changed', (_, available) => {
            if (available && this._status === 'offline')
                this._soon(SHORTLY);
        }, this);
        settings?.connectObject('changed::slack-api', () => this._loadToken(), this);
        this._loadToken();
    }

    /** @returns {number} messages since Slack was last looked at */
    get unread() {
        return known.badge ?? (known.api ? known.api.count + known.since : known.count);
    }

    /** @param {number} count - (for showing it off: as if counted) */
    set unread(count) {
        known.badge = null;
        known.api = null;
        known.count = count;
    }

    /** @returns {object[]} who wrote them: [{name, count, time}], the latest first */
    get senders() {
        // (Those notified are all since the API's answer: it clears them.)
        return known.api ? mergeSenders(known.api.senders, known.senders, 0) : known.senders;
    }

    set senders(senders) {
        known.api = null;
        known.senders = senders;
    }

    /** @returns {boolean} whether Slack's API is asked (a token, and not refused) */
    get api() {
        return Boolean(this._token) && !['invalid', 'missing-scope'].includes(this._status);
    }

    /** @returns {object} what is known, for the tests: nothing a message says */
    get state() {
        return {...known, found: Object.fromEntries(known.found), names: Object.fromEntries(known.names)};
    }

    // The token, from the keyring, once the preferences say one is there.
    async _loadToken() {
        const asked = this._asked = {};
        this._clearTimeout();
        this._token = null;
        this._me = null;
        this._lists = {};
        this._failures = 0;
        this._status = null;
        let token = null;
        if (this._settings?.get_boolean('slack-api')) {
            try {
                token = await this._store.lookup() || null;
            } catch (e) {
                console.warn(`Atelier: the Slack token could not be read from the keyring: ${e.message}`);
            }
            // (The settings changed again meanwhile, or the widgets stopped.)
            if (asked !== this._asked || this._cancellable.is_cancelled())
                return;
        }
        // Another token (or none): what the last one found goes. (The same
        // one, as the widgets start again after the screen was locked: it stays.)
        if (token !== lastToken) {
            lastToken = token;
            known.api = null;
            known.since = 0;
            known.found.clear();
            this.emit('changed');
        }
        this._token = token;
        if (!token) {
            this._setStatus(this._settings?.get_boolean('slack-api') ? 'no-token' : '');
            return;
        }
        this._soon(SHORTLY);
    }

    _setStatus(status) {
        this._status = status;
        if (this._settings && this._settings.get_string('slack-status') !== status)
            this._settings.set_string('slack-status', status);
    }

    // The next round in `seconds`, unless one is due before; never sooner
    // than a minute after the last.
    _soon(seconds) {
        if (!this.api)
            return;
        const wait = Math.max(seconds, SOONEST - (Date.now() - this._last) / 1000);
        if (this._timeout && this._due <= Date.now() + wait * 1000)
            return;
        this._schedule(wait);
    }

    _schedule(seconds) {
        this._clearTimeout();
        this._due = Date.now() + seconds * 1000;
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, Math.max(1, Math.round(seconds)), () => {
            this._timeout = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimeout() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
    }

    /**
     * Ask Slack (the tests put a fake one here).
     *
     * @param {string} method
     * @param {object} params
     * @returns {Promise<object>} {status, retryAfter, body}
     */
    _fetch(method, params) {
        this._session ??= newSession();
        return callSlack(this._session, this._token, method, params, this._cancellable);
    }

    async _call(method, params = {}) {
        let answer;
        try {
            answer = await this._fetch(method, params);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
            throw new SlackError('offline');
        }
        if (answer.status === 429)
            throw new SlackError('rate-limited', answer.retryAfter);
        if (answer.status !== 200 || !answer.body)
            throw new SlackError('error');
        if (!answer.body.ok)
            throw new SlackError(statusOf(answer.body.error), answer.retryAfter);
        return answer.body;
    }

    // A list of conversations, all its pages, kept a while: only their ids
    // and how Slack ranks them.
    async _list(kind) {
        const list = this._lists[kind];
        if (list && Date.now() - list.time < LISTS)
            return list.items;
        const [method, types] = kind === 'direct'
            ? ['conversations.list', 'im,mpim'] : ['users.conversations', 'public_channel,private_channel'];
        const items = [];
        let cursor = '';
        for (let page = 0; page < PAGES; page++) {
            const answer = await this._call(method, {types, exclude_archived: true, limit: 200, ...cursor ? {cursor} : {}});
            for (const channel of answer.channels ?? []) {
                if (channel?.id)
                    items.push({id: channel.id, priority: channel.priority ?? 0});
            }
            cursor = answer.response_metadata?.next_cursor ?? '';
            if (!cursor)
                break;
        }
        this._lists[kind] = {time: Date.now(), items};
        return items;
    }

    async _history(id, oldest) {
        const answer = await this._call('conversations.history', {channel: id, oldest, limit: HISTORY});
        return answer.messages ?? [];
    }

    // The direct messages (and those of a few people together): who wrote
    // those unread.
    async _lookDirect() {
        const list = await this._list('direct');
        const {ids, offset} = pickConversations(list, new Set(known.found.keys()), this._offsets.direct, DIRECT_LOOKS);
        this._offsets.direct = offset;
        let histories = DIRECT_HISTORIES;
        for (const id of ids) {
            const {channel} = await this._call('conversations.info', {channel: id});
            const {unread, writers} = unreadOf(channel, this._me);
            if (!unread) {
                known.found.delete(id);
            } else if (writers) {
                known.found.set(id, writers);
            } else if (histories-- > 0) {
                const found = writersOf(await this._history(id, channel.last_read ?? '0'), this._me);
                if (found.length > 0)
                    known.found.set(id, found);
                else
                    known.found.delete(id);
            }
        }
    }

    // The channels: who mentioned you since you last read them. (Only
    // those whose latest message is newer, and at most a few a round.)
    async _lookChannels() {
        const list = await this._list('channels');
        const {ids, offset} = pickConversations(list, new Set(known.found.keys()), this._offsets.channels, CHANNEL_LOOKS);
        this._offsets.channels = offset;
        for (const id of ids) {
            const {channel} = await this._call('conversations.info', {channel: id});
            if (!channel?.last_read || (channel.latest && timeOf(channel.latest.ts) <= timeOf(channel.last_read))) {
                known.found.delete(id);
                continue;
            }
            const found = writersOf(await this._history(id, channel.last_read), this._me, true);
            if (found.length > 0)
                known.found.set(id, found);
            else
                known.found.delete(id);
        }
    }

    // Who wrote, by name: only those shown (the latest few).
    async _named() {
        const writers = combineWriters(known.found.values());
        const senders = [];
        for (const writer of writers.slice(0, SENDERS)) {
            if (!known.names.has(writer.user)) {
                const {user} = await this._call('users.info', {user: writer.user});
                known.names.set(writer.user, nameOf(user));
            }
            const {name, aliases} = known.names.get(writer.user);
            senders.push({name, aliases, count: writer.count, time: writer.time});
        }
        return {count: writers.reduce((sum, writer) => sum + writer.count, 0), senders};
    }

    /** Ask Slack's API now (if there is a token, and the screen is not locked). */
    async refresh() {
        this._clearTimeout();
        if (!this.api || this._busy || Main.sessionMode.isLocked)
            return;
        this._busy = true;
        this._last = Date.now();
        let status = 'ok', retryAfter = null;
        try {
            if (!this._me)
                this._me = (await this._call('auth.test')).user_id ?? null;
            await this._lookDirect();
            await this._lookChannels();
            const {count, senders} = await this._named();
            // (What the notifications told before, the API knows now.)
            known.api = {count, senders, time: Date.now()};
            known.since = 0;
            known.count = 0;
            known.senders = [];
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!(e instanceof SlackError))
                throw e;
            status = e.status;
            retryAfter = e.retryAfter;
        } finally {
            this._busy = false;
        }
        if (this._cancellable.is_cancelled())
            return;
        this._failures = status === 'ok' ? 0 : this._failures + 1;
        // Once per kind of failure, not at every round while it lasts.
        if (status !== 'ok' && status !== this._status)
            console.warn(`Atelier: Slack could not be asked: ${status}`);
        this._setStatus(status);
        const delay = nextDelay(status, this._failures, retryAfter);
        if (delay !== null)
            this._schedule(delay);
        this.emit('changed');
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
            this._clear();
        // (Who wrote now, or who was read: the API knows.)
        this._soon(SHORTLY);
        this.emit('changed');
    }

    // Nothing unread: neither counted nor found.
    _clear() {
        known.count = 0;
        known.senders = [];
        known.since = 0;
        known.found.clear();
        if (known.api)
            known.api = {...known.api, count: 0, senders: []};
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
        known.since++;
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
        if (this.unread === 0 && this.senders.length === 0 && known.count === 0)
            return;
        // (Slack says its own count again as it marks them read; the API
        // tells, at its next round, what is still unread elsewhere.)
        if (known.badge !== null)
            known.badge = 0;
        this._clear();
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
        this._clearTimeout();
        this._cancellable.cancel();
        this._session?.abort();
        this._token = null;
        this._settings?.disconnectObject(this);
        Gio.NetworkMonitor.get_default().disconnectObject(this);
        Gio.DBus.system.signal_unsubscribe(this._sleepId);
        Gio.DBus.session.signal_unsubscribe(this._badgeId);
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources()) {
            source.disconnectObject(this);
            source.notifications.forEach(notification => notification.disconnectObject(this));
        }
        global.display.disconnectObject(this);
    }
}
