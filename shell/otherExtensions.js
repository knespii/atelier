// Other extensions out of Atelier's way (lib/otherExtensions.js): each
// setting of theirs the user has asked Atelier to keep is kept as it is
// asked for and whenever it changes then, and put back once it no longer
// is asked for. A kept setting the user changes again themselves is
// theirs: Atelier stops keeping it. Once for each collision that matters,
// a notification says where to ask.

import GLib from 'gi://GLib';

import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {RULES, collides, keep, parseState, readKey, release, settingsFor, writeKey} from '../lib/otherExtensions.js';

// Seconds after Atelier starts before it looks for collisions to tell of
// (the session settles first), and after another extension changes.
const NOTICE_DELAY = 8;
const CHANGE_DELAY = 2;

export class OtherExtensionsModule {
    /**
     * @param {object} context
     * @param {object} context.extension - the Extension object
     * @param {Gio.Settings} context.settings
     */
    constructor({extension, settings}) {
        this._extension = extension;
        this._settings = settings;
        this._watched = new Map(); // rule id → the other extension's Gio.Settings
        this._writing = false;
        this._noticeId = 0;
    }

    enable() {
        this._settings.connectObject('changed::other-extensions-kept', () => this._sync(), this);
        // (Installed or turned on later: kept then, or told of.)
        Main.extensionManager.connectObject('extension-state-changed', () => {
            this._sync();
            this._queueNotice(CHANGE_DELAY);
        }, this);
        this._sync();
        this._queueNotice(NOTICE_DELAY);
    }

    disable() {
        this._settings.disconnectObject(this);
        Main.extensionManager.disconnectObject(this);
        this._watched.forEach(settings => settings.disconnectObject(this));
        this._watched.clear();
        if (this._noticeId)
            GLib.source_remove(this._noticeId);
        this._noticeId = 0;
    }

    _state() {
        return parseState(this._settings.get_string('other-extensions-state'));
    }

    // Each rule asked for watched and kept; one no longer asked for let go.
    _sync() {
        const kept = new Set(this._settings.get_strv('other-extensions-kept'));
        const state = this._state();
        const before = JSON.stringify(state);
        const dropped = [];
        for (const rule of RULES) {
            let settings = this._watched.get(rule.id);
            if (kept.has(rule.id)) {
                settings ??= this._watch(rule);
                if (settings && this._apply(rule, settings, state))
                    dropped.push(rule.id);
                continue;
            }
            if (settings) {
                settings.disconnectObject(this);
                this._watched.delete(rule.id);
            }
            // (One the user took back stays marked so, for the preferences.)
            if (!state[rule.id] || state[rule.id].overridden)
                continue;
            settings ??= settingsFor(rule);
            const back = settings ? release(state[rule.id], readKey(settings, rule.key)) : undefined;
            if (back !== undefined)
                this._write(settings, rule.key, back);
            delete state[rule.id];
        }
        this._save(state, before, dropped);
    }

    _watch(rule) {
        const settings = settingsFor(rule);
        if (!settings)
            return null;
        settings.connectObject(`changed::${rule.key}`, () => this._onChanged(rule), this);
        this._watched.set(rule.id, settings);
        return settings;
    }

    // The key changed: still as Atelier keeps it, or the user's now.
    _onChanged(rule) {
        const settings = this._watched.get(rule.id);
        if (this._writing || !settings)
            return;
        const state = this._state();
        const before = JSON.stringify(state);
        const dropped = this._apply(rule, settings, state) ? [rule.id] : [];
        this._save(state, before, dropped);
    }

    /**
     * @returns {boolean} whether the user has taken the setting back
     */
    _apply(rule, settings, state) {
        const {write, entry, overridden} = keep(rule, readKey(settings, rule.key), state[rule.id] ?? null);
        if (overridden) {
            state[rule.id] = {overridden: true};
            return true;
        }
        state[rule.id] = entry;
        if (write !== undefined)
            this._write(settings, rule.key, write);
        return false;
    }

    _write(settings, key, value) {
        this._writing = true;
        try {
            writeKey(settings, key, value);
        } finally {
            this._writing = false;
        }
    }

    // (What the user took back is no longer asked for: after the state, as
    // that change comes back here.)
    _save(state, before, dropped) {
        if (JSON.stringify(state) !== before)
            this._settings.set_string('other-extensions-state', JSON.stringify(state));
        if (dropped.length) {
            this._settings.set_strv('other-extensions-kept',
                this._settings.get_strv('other-extensions-kept').filter(id => !dropped.includes(id)));
        }
    }

    _queueNotice(seconds) {
        if (this._noticeId)
            GLib.source_remove(this._noticeId);
        this._noticeId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._noticeId = 0;
            this._notice();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Once for each collision that matters, of an extension that is on: a
    // notification of what goes wrong, and where Atelier can keep it out of
    // the way.
    _notice() {
        const kept = this._settings.get_strv('other-extensions-kept');
        const noticed = this._settings.get_strv('other-extensions-noticed');
        const due = RULES.filter(rule => rule.notice && !kept.includes(rule.id) && !noticed.includes(rule.id) &&
            Main.extensionManager.lookup(rule.uuid)?.state === ExtensionState.ACTIVE)
            .filter(rule => {
                const settings = settingsFor(rule);
                return settings && collides(rule, readKey(settings, rule.key));
            });
        if (due.length === 0)
            return;
        this._settings.set_strv('other-extensions-noticed', [...noticed, ...due.map(rule => rule.id)]);
        const names = [...new Set(due.map(rule => rule.extension))];
        const source = new MessageTray.Source({title: 'Atelier', iconName: 'application-x-addon-symbolic'});
        Main.messageTray.add(source);
        const notification = new MessageTray.Notification({
            source,
            title: `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} in Atelier's way`,
            body: `${due.map(rule => rule.why).join(' ')} Atelier can keep that out of its way: in its settings, ` +
                'under Other Extensions.',
        });
        notification.connect('activated', () => this._openSettings());
        notification.addAction('Open Settings', () => this._openSettings());
        source.addNotification(notification);
    }

    _openSettings() {
        this._settings.set_string('prefs-section', 'other-extensions');
        this._extension.openPreferences();
    }
}
