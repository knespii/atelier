// "Notifications" section: notifications in the island, Do Not Disturb,
// muted apps and the buttons each app's notifications get.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {
    BUTTON_MODES, activeMutes, buttonMode, canonicalAppId, setButtonMode, unmuteApp,
} from '../lib/notifications.js';

/**
 * The apps GNOME has seen sending notifications, with names and icons.
 *
 * @param {Gio.Settings} gnome - org.gnome.desktop.notifications
 * @returns {{id: string, name: string, icon: Gio.Icon|null}[]} sorted by name
 */
function notifyingApps(gnome) {
    const infos = new Map();
    for (const info of Gio.AppInfo.get_all()) {
        const id = info.get_id();
        if (id)
            infos.set(canonicalAppId(id), info);
    }
    return gnome.get_strv('application-children').map(id => {
        const info = infos.get(id);
        return {id, name: info?.get_display_name() ?? id, icon: info?.get_icon() ?? null};
    }).sort((a, b) => a.name.localeCompare(b.name));
}

function muteEnd(until) {
    if (until === 0)
        return 'Until you unmute it';
    const end = GLib.DateTime.new_from_unix_local(until);
    const twelveHours = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'})
        .get_string('clock-format') === '12h';
    const time = end.format(twelveHours ? '%l:%M %p' : '%H:%M').trim();
    const today = GLib.DateTime.new_now_local();
    const sameDay = end.get_year() === today.get_year() && end.get_day_of_year() === today.get_day_of_year();
    return sameDay ? `Until ${time}` : `Until ${end.format('%a')} ${time}`;
}

function appIcon(icon) {
    return new Gtk.Image({
        gicon: icon ?? Gio.ThemedIcon.new('application-x-executable-symbolic'),
        pixel_size: 28,
    });
}

export const NotificationsPage = GObject.registerClass(
class AtelierNotificationsPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Notifications', name: 'notifications'});
        this._settings = settings.get_child('notifications');
        this._gnome = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._mutedRows = [];
        this._appRows = [];

        const group = new Adw.PreferencesGroup({
            title: 'Notifications',
            description: 'Banners appear in the island instead of under the top bar. ' +
                'Either way they stay in the notification list.',
        });
        this.add(group);
        this._enabled = new Adw.SwitchRow({title: 'Show notifications in the island'});
        this._settings.bind('enabled', this._enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(this._enabled);

        this._dnd = new Adw.SwitchRow({
            title: 'Do Not Disturb',
            subtitle: 'No banners; notifications only go to the list',
        });
        this._dnd.connect('notify::active', () => {
            if (this._gnome.get_boolean('show-banners') === this._dnd.active)
                this._gnome.set_boolean('show-banners', !this._dnd.active);
        });
        group.add(this._dnd);

        this._mutedGroup = new Adw.PreferencesGroup({
            title: 'Muted',
            description: 'Notifications of muted apps go to the list without a banner. ' +
                'Mute an app with the Mute button of its notification.',
        });
        this.add(this._mutedGroup);

        this._appsGroup = new Adw.PreferencesGroup({
            title: 'Buttons per App',
            description: 'Which buttons an app\'s notifications get in the island. ' +
                'Apps appear here once they have sent a notification.',
        });
        this.add(this._appsGroup);

        this._settingsIds = [
            this._settings.connect('changed::muted', () => this._syncMuted()),
            this._settings.connect('changed::app-buttons', () => this._syncModes()),
        ];
        this._gnomeIds = [
            this._gnome.connect('changed::show-banners', () => this._syncDnd()),
            this._gnome.connect('changed::application-children', () => this._buildApps()),
        ];
        this._syncDnd();
        this._buildApps();
    }

    disconnectSettings() {
        Gio.Settings.unbind(this._enabled, 'active');
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._gnomeIds.forEach(id => this._gnome.disconnect(id));
        this._settingsIds = [];
        this._gnomeIds = [];
    }

    _syncDnd() {
        this._dnd.active = !this._gnome.get_boolean('show-banners');
    }

    _buildApps() {
        this._apps = notifyingApps(this._gnome);
        this._appRows.forEach(row => this._appsGroup.remove(row));
        this._appRows = this._apps.map(app => {
            const row = new Adw.ComboRow({
                title: GLib.markup_escape_text(app.name, -1),
                model: Gtk.StringList.new(BUTTON_MODES.map(([, label]) => label)),
            });
            row.add_prefix(appIcon(app.icon));
            row.appId = app.id;
            row.connect('notify::selected', () => {
                const [mode] = BUTTON_MODES[row.selected] ?? ['app'];
                if (buttonMode(this._settings, app.id) !== mode)
                    setButtonMode(this._settings, app.id, mode);
            });
            this._appsGroup.add(row);
            return row;
        });
        if (this._apps.length === 0) {
            const row = new Adw.ActionRow({title: 'No app has sent a notification yet'});
            this._appsGroup.add(row);
            this._appRows.push(row);
        }
        this._syncModes();
        this._syncMuted();
    }

    _syncModes() {
        for (const row of this._appRows.filter(r => r.appId)) {
            const index = BUTTON_MODES.findIndex(([mode]) => mode === buttonMode(this._settings, row.appId));
            if (row.selected !== index)
                row.selected = index;
        }
    }

    _syncMuted() {
        this._mutedRows.forEach(row => this._mutedGroup.remove(row));
        const names = new Map((this._apps ?? []).map(app => [app.id, app]));
        this._mutedRows = [...activeMutes(this._settings)].map(([id, until]) => {
            const app = names.get(id);
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(app?.name ?? id, -1),
                subtitle: muteEnd(until),
            });
            row.add_prefix(appIcon(app?.icon ?? null));
            const button = new Gtk.Button({label: 'Unmute', valign: Gtk.Align.CENTER});
            button.connect('clicked', () => unmuteApp(this._settings, id));
            row.add_suffix(button);
            row.appId = id;
            this._mutedGroup.add(row);
            return row;
        });
        if (this._mutedRows.length === 0) {
            const row = new Adw.ActionRow({title: 'No muted apps'});
            this._mutedGroup.add(row);
            this._mutedRows.push(row);
        }
    }
});
