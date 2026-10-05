// GitHub contributions of the user named in the settings, from GitHub's
// public page: fetched once an hour and kept in ~/.cache/atelier, so the
// widget has something to show right away.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {contributionsUrl, parseContributions, validUser} from '../../../lib/github.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const REFRESH = 3600; // seconds

export class GithubSource extends EventEmitter {
    /**
     * @param {Gio.Settings} settings - the desktop's
     */
    constructor(settings) {
        super();
        this._settings = settings;
        this._session = new Soup.Session({timeout: 20, user_agent: 'Atelier (GNOME Shell extension)'});
        this._timeout = 0;
        this._cancellable = null;
        /** {user, total, days, fetched} or null */
        this.data = null;
        /** why the last fetch failed, or null */
        this.error = null;
        settings.connectObject('changed::github-user', () => this._restart(), this);
        this._restart();
    }

    /** @returns {string} the user whose contributions these are, or '' */
    get user() {
        const user = this._settings.get_string('github-user').trim();
        return validUser(user) ? user : '';
    }

    /** Fetch now. */
    refresh() {
        if (!this.user)
            return;
        this._clearTimeout();
        this._fetch();
    }

    _restart() {
        this._clearTimeout();
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        this.data = null;
        this.error = null;
        const user = this.user;
        if (user) {
            const cached = this._readCache();
            if (cached?.user === user)
                this.data = cached;
            const age = this.data ? (Date.now() - this.data.fetched) / 1000 : Infinity;
            this._schedule(age >= REFRESH ? 0 : REFRESH - age);
        }
        this.emit('changed');
    }

    _schedule(seconds) {
        this._clearTimeout();
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, Math.max(1, Math.round(seconds)), () => {
            this._timeout = 0;
            this._fetch();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimeout() {
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
    }

    async _fetch() {
        const user = this.user;
        const cancellable = this._cancellable;
        try {
            const message = Soup.Message.new('GET', contributionsUrl(user));
            const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_LOW, cancellable);
            if (message.get_status() !== Soup.Status.OK)
                throw new Error(message.get_status() === Soup.Status.NOT_FOUND ? 'No such user' : `HTTP ${message.get_status()}`);
            this.apply(user, new TextDecoder().decode(bytes.get_data()));
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this.error = e.message;
            this.emit('changed');
        }
        if (!cancellable.is_cancelled())
            this._schedule(REFRESH);
    }

    /**
     * Take in a contributions page.
     *
     * @param {string} user
     * @param {string} html
     */
    apply(user, html) {
        const parsed = parseContributions(html);
        if (!parsed) {
            this.error = 'GitHub showed no contributions';
        } else {
            this.data = {user, ...parsed, fetched: Date.now()};
            this.error = null;
            this._writeCache();
        }
        this.emit('changed');
    }

    _cacheFile() {
        return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_cache_dir(), 'atelier', 'github.json']));
    }

    _readCache() {
        try {
            const [, contents] = this._cacheFile().load_contents(null);
            const data = JSON.parse(new TextDecoder().decode(contents));
            return Array.isArray(data?.days) && typeof data.fetched === 'number' ? data : null;
        } catch {
            return null;
        }
    }

    _writeCache() {
        try {
            const file = this._cacheFile();
            file.get_parent().make_directory_with_parents(null);
        } catch {
            // it exists
        }
        try {
            this._cacheFile().replace_contents(new TextEncoder().encode(JSON.stringify(this.data)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`Atelier: could not keep the GitHub contributions: ${e.message}`);
        }
    }

    destroy() {
        this._clearTimeout();
        this._cancellable?.cancel();
        this._settings.disconnectObject(this);
        this._session.abort();
    }
}
