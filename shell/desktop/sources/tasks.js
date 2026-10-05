// Google Tasks of the Google account in GNOME's Online Accounts. Online
// Accounts hands out an access token, which stays in memory for the
// requests; the tasks are fetched every ten minutes and can be marked done.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Goa from 'gi://Goa';
import Soup from 'gi://Soup?version=3.0';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {COMPLETE, listsUrl, parseLists, parseTasks, taskUrl, tasksUrl} from '../../../lib/googleTasks.js';

Gio._promisify(Goa.Client, 'new');
Gio._promisify(Goa.OAuth2BasedProxy.prototype, 'call_get_access_token');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const REFRESH = 600; // seconds

export class TasksSource extends EventEmitter {
    constructor() {
        super();
        this._session = new Soup.Session({timeout: 20, user_agent: 'Atelier (GNOME Shell extension)'});
        this._cancellable = new Gio.Cancellable();
        this._timeout = 0;
        this._client = null;
        /** 'loading', 'no-account', 'ready' or 'error' */
        this.state = 'loading';
        /** the open tasks of the first list: [{id, title, due}] */
        this.tasks = [];
        this._list = null;
        this._start();
    }

    async _start() {
        try {
            this._client = await Goa.Client.new(this._cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._set('no-account');
            return;
        }
        this._client.connectObject(
            'account-added', () => this.refresh(),
            'account-removed', () => this.refresh(),
            'account-changed', () => this.refresh(),
            this);
        this.refresh();
    }

    /** @returns {object|null} the Google account's object, if there is one */
    _account() {
        for (const object of this._client?.get_accounts() ?? []) {
            const account = object.get_account();
            if (account?.provider_type === 'google' && object.get_oauth2_based() && !account.attention_needed)
                return object;
        }
        return null;
    }

    _set(state) {
        this.state = state;
        this.emit('changed');
    }

    async _token(object) {
        const [, token] = await object.get_oauth2_based().call_get_access_token(this._cancellable);
        return token;
    }

    async _request(method, url, token, body = null) {
        const message = Soup.Message.new(method, url);
        message.get_request_headers().append('Authorization', `Bearer ${token}`);
        if (body)
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(body)));
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_LOW, this._cancellable);
        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${message.get_status()}`);
        return new TextDecoder().decode(bytes.get_data());
    }

    /** Fetch the tasks now. */
    async refresh() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REFRESH, () => {
            this._timeout = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
        const object = this._account();
        if (!object) {
            this.tasks = [];
            this._set('no-account');
            return;
        }
        try {
            const token = await this._token(object);
            const [list] = parseLists(await this._request('GET', listsUrl(), token));
            this._list = list?.id ?? null;
            this.tasks = list ? parseTasks(await this._request('GET', tasksUrl(list.id), token)) : [];
            this._set('ready');
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            console.warn(`Atelier: Google Tasks could not be read: ${e.message}`);
            this._set('error');
        }
    }

    /**
     * Mark a task done; it goes from the list at once.
     *
     * @param {object} task - one of this.tasks
     */
    async complete(task) {
        this.tasks = this.tasks.filter(t => t.id !== task.id);
        this.emit('changed');
        const object = this._account();
        try {
            if (!object || !this._list)
                throw new Error('no account');
            await this._request('PATCH', taskUrl(this._list, task.id), await this._token(object), COMPLETE);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            console.warn(`Atelier: a task could not be marked done: ${e.message}`);
            this.refresh();
        }
    }

    destroy() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
        this._cancellable.cancel();
        this._client?.disconnectObject(this);
        this._client = null;
        this._session.abort();
    }
}
