// "Dock" section: Atelier's dock at an edge of the screen – on or off, where
// and how big, how it hides, what clicks do, its marks and extra icons, its
// look (each in prefs/dock/*.js). It stays off while Dash to Dock (or
// Ubuntu Dock, Ubuntu's fork of it) is on; this page says which (turning it
// off is the user's call, in the Extensions app), and can bring Dash to
// Dock's settings over.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {OTHER_DOCKS, otherDockOn} from '../lib/dockImport.js';

import * as appearance from './dock/appearance.js';
import * as behaviour from './dock/behaviour.js';
import {DockBinder} from './dock/common.js';
import * as hiding from './dock/hiding.js';
import * as importer from './dock/import.js';
import * as indicators from './dock/indicators.js';
import * as launchers from './dock/launchers.js';
import * as position from './dock/position.js';

// The shell's extensions service, which says what is on: also what its
// session's mode brings (Ubuntu's brings Ubuntu Dock, not in the settings).
const EXTENSIONS = ['org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions', 'org.gnome.Shell.Extensions'];
// An extension counts as on while it runs or is about to (ExtensionState's
// ACTIVE, DEACTIVATING, ACTIVATING), as for the shell's dock.
const RUNNING = [1, 7, 8];
// The sections after the status, in order.
const SECTIONS = [position, hiding, behaviour, indicators, launchers, appearance];

export const DockPage = GObject.registerClass(
class AtelierDockPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Dock', name: 'dock'});
        this.rows = new Map(); // key → its row
        this._dock = settings.get_child('dock');
        this._binder = new DockBinder(this);
        this._shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const ctx = {settings: this._dock, binder: this._binder};

        const status = new Adw.PreferencesGroup({
            title: 'Dock',
            description: 'The pinned apps and those with windows on the workspace, at an edge of the screen.',
        });
        this.add(status);
        this._blocked = new Adw.ActionRow({css_classes: ['warning'], visible: false});
        this._blocked.add_prefix(new Gtk.Image({icon_name: 'dialog-information-symbolic'}));
        status.add(this._blocked);
        this._cancellable = new Gio.Cancellable();
        this.syncBlocked();
        for (const key of ['enabled-extensions', 'disabled-extensions', 'disable-user-extensions'])
            this._binder.connect(this._shell, `changed::${key}`, () => this.syncBlocked());
        this._stateChangedId = Gio.DBus.session.signal_subscribe(EXTENSIONS[0], EXTENSIONS[2],
            'ExtensionStateChanged', EXTENSIONS[1], null, Gio.DBusSignalFlags.NONE, (...args) => {
                const [uuid] = args[5].deepUnpack();
                if (OTHER_DOCKS.some(other => other.uuid === uuid))
                    this.syncBlocked();
            });
        this._binder.bindSwitch(status, this._dock, 'enabled', 'Atelier\'s dock');
        const importRow = importer.build(this, ctx);
        if (importRow)
            status.add(importRow);

        // The rest greys out while the dock is off.
        for (const section of SECTIONS) {
            for (const group of [section.build(this, ctx)].flat().filter(Boolean)) {
                this._binder.bindSensitive(group, this._dock, 'enabled');
                this.add(group);
            }
        }
    }

    /**
     * The other docks, as the shell says (replaced in the checks).
     *
     * @returns {Promise<Map|null>} uuid → whether it is on, or null when
     *   the shell can't be asked (the settings say then)
     */
    async askShell() {
        const ask = uuid => new Promise((resolve, reject) => {
            Gio.DBus.session.call(...EXTENSIONS, 'GetExtensionInfo', new GLib.Variant('(s)', [uuid]),
                new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, 2000, this._cancellable,
                (connection, result) => {
                    try {
                        resolve(connection.call_finish(result).deepUnpack()[0]);
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        try {
            const infos = await Promise.all(OTHER_DOCKS.map(other => ask(other.uuid)));
            // (One not installed comes back empty: off.)
            return new Map(OTHER_DOCKS.map((other, i) =>
                [other.uuid, RUNNING.includes(infos[i].state?.deepUnpack())]));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.debug(`Atelier: the shell can't say which extensions are on: ${e.message}`);
            return null;
        }
    }

    /**
     * Say which other dock keeps Atelier's off, if one does.
     *
     * @returns {Promise} once it says so
     */
    async syncBlocked() {
        const said = await this.askShell();
        if (this._cancellable.is_cancelled())
            return;
        const other = otherDockOn({
            running: uuid => said?.get(uuid),
            enabled: this._shell.get_strv('enabled-extensions'),
            disabled: this._shell.get_strv('disabled-extensions'),
            userOff: this._shell.get_boolean('disable-user-extensions'),
        });
        this._blocked.visible = other !== null;
        if (other) {
            this._blocked.title = `${other.name} is on`;
            this._blocked.subtitle = `Atelier's dock starts by itself once ${other.name} is turned off in the Extensions app.`;
        }
    }

    disconnectSettings() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._stateChangedId);
        this._binder.disconnectSettings();
    }
});
