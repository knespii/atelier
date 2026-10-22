// "Other Extensions" section: the settings of other extensions that
// Atelier can keep out of its way, for those installed. Each is kept only
// once it is switched on here, by Atelier in the shell, and put back once
// it is switched off; extensions are never turned on or off.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {RULES, isInstalled, parseState, readKey, settingsFor} from '../lib/otherExtensions.js';

const ACTIVE = 1; // an extension's state, as the shell has it

export const OtherExtensionsPage = GObject.registerClass(
class AtelierOtherExtensionsPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Other Extensions', name: 'other-extensions'});
        this._settings = settings;
        this._ids = [];
        this._others = []; // [Gio.Settings, handler id] of other extensions
        this._rows = new Map(); // rule id → {rule, row, settings}
        this._groups = new Map(); // uuid → Adw.PreferencesGroup
        this._busSubscription = 0;
        this._syncing = false;

        const installed = RULES.filter(rule => isInstalled(rule.uuid));
        const intro = new Adw.PreferencesGroup({
            description: 'Some extensions draw over what Atelier draws, or take over the same part of GNOME. ' +
                'Atelier can keep one setting of each out of its way: only the one named, and only once you ' +
                'switch it on. Switched off, the setting is put back as it was. If you change it in that ' +
                'extension yourself, it is yours again. Atelier never turns an extension on or off.',
        });
        this.add(intro);
        if (installed.length === 0) {
            intro.title = 'Nothing in the Way';
            intro.description = 'None of the extensions known to get in Atelier\'s way is installed: ' +
                RULES.map(rule => rule.extension).filter((name, i, all) => all.indexOf(name) === i).join(', ') + '.';
            return;
        }
        const recommended = new Gtk.Button({label: 'Keep the Recommended', valign: Gtk.Align.CENTER});
        recommended.connect('clicked', () => {
            const kept = new Set(this._settings.get_strv('other-extensions-kept'));
            installed.filter(rule => rule.notice).forEach(rule => kept.add(rule.id));
            this._settings.set_strv('other-extensions-kept', [...kept]);
        });
        intro.header_suffix = recommended;

        for (const rule of installed) {
            let group = this._groups.get(rule.uuid);
            if (!group) {
                group = new Adw.PreferencesGroup({title: rule.extension});
                this._groups.set(rule.uuid, group);
                this.add(group);
            }
            const row = new Adw.SwitchRow({title: rule.title, subtitle_lines: 0});
            row.connect('notify::active', () => {
                if (!this._syncing)
                    this._setKept(rule.id, row.active);
            });
            group.add(row);
            const others = settingsFor(rule);
            if (others)
                this._others.push([others, others.connect(`changed::${rule.key}`, () => this._sync())]);
            this._rows.set(rule.id, {rule, row, settings: others});
        }
        this._ids.push(
            settings.connect('changed::other-extensions-kept', () => this._sync()),
            settings.connect('changed::other-extensions-state', () => this._sync()));
        this._sync();
        this._watchStates();
    }

    disconnectSettings() {
        this._ids.forEach(id => this._settings.disconnect(id));
        this._ids = [];
        this._others.forEach(([others, id]) => others.disconnect(id));
        this._others = [];
        if (this._busSubscription)
            Gio.DBus.session.signal_unsubscribe(this._busSubscription);
        this._busSubscription = 0;
    }

    _setKept(id, kept) {
        const ids = this._settings.get_strv('other-extensions-kept').filter(other => other !== id);
        this._settings.set_strv('other-extensions-kept', kept ? [...ids, id] : ids);
    }

    // Each row: whether it is kept, and what the setting is now.
    _sync() {
        const kept = this._settings.get_strv('other-extensions-kept');
        const state = parseState(this._settings.get_string('other-extensions-state'));
        this._syncing = true;
        for (const {rule, row, settings} of this._rows.values()) {
            row.active = kept.includes(rule.id);
            const now = settings ? rule.label(readKey(settings, rule.key)) : null;
            const keeps = rule.kind === 'keep'
                ? `Atelier keeps it ${rule.label(rule.value)}`
                : 'Atelier changes it only when it is in the way';
            const lines = [
                state[rule.id]?.overridden && !row.active
                    ? `You changed it in ${rule.extension} yourself, so Atelier stopped keeping it.` : null,
                rule.why,
                `${now === null ? '' : `Now: ${now}. `}${keeps}. You give up: ${rule.loses}`,
            ];
            row.subtitle = GLib.markup_escape_text(lines.filter(Boolean).join('\n'), -1);
        }
        this._syncing = false;
    }

    // Whether each extension runs, asked of the shell as the Extensions app
    // asks it, and told again as that changes.
    _watchStates() {
        const bus = Gio.DBus.session;
        const show = (uuid, state) => {
            const group = this._groups.get(uuid);
            if (group) {
                group.description = state === ACTIVE ? ''
                    : 'Off now: what you switch on here is kept once it is on again.';
            }
        };
        this._busSubscription = bus.signal_subscribe('org.gnome.Shell', 'org.gnome.Shell.Extensions',
            'ExtensionStateChanged', '/org/gnome/Shell', null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [uuid, info] = params.recursiveUnpack();
                show(uuid, info.state);
            });
        for (const uuid of this._groups.keys()) {
            bus.call('org.gnome.Shell', '/org/gnome/Shell', 'org.gnome.Shell.Extensions', 'GetExtensionInfo',
                new GLib.Variant('(s)', [uuid]), new GLib.VariantType('(a{sv})'),
                Gio.DBusCallFlags.NONE, -1, null, (_conn, result) => {
                    let info = {};
                    try {
                        [info] = bus.call_finish(result).recursiveUnpack();
                    } catch {
                        // (No shell to ask: nothing to say.)
                    }
                    if (this._busSubscription)
                        show(uuid, info.state);
                });
        }
    }
});
