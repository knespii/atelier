// "Dock" section: Atelier's dock at the bottom of the screen – on or off,
// out of the way of windows, how big. It stays off while Dash to Dock is
// on; this page says so (turning Dash to Dock off is the user's call, in
// the Extensions app).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

const DASH_TO_DOCK = 'dash-to-dock@micxgx.gmail.com';

export const DockPage = GObject.registerClass(
class AtelierDockPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Dock', name: 'dock'});
        this._bound = [];
        this._dock = settings.get_child('dock');
        this._shell = new Gio.Settings({schema_id: 'org.gnome.shell'});

        const status = new Adw.PreferencesGroup();
        this.add(status);
        this._blocked = new Adw.ActionRow({
            title: 'Dash to Dock is on',
            subtitle: 'Atelier\'s dock starts by itself once Dash to Dock is turned off in the Extensions app.',
            css_classes: ['warning'],
        });
        this._blocked.add_prefix(new Gtk.Image({icon_name: 'dialog-information-symbolic'}));
        status.add(this._blocked);
        const syncBlocked = () => {
            this._blocked.visible = this._shell.get_strv('enabled-extensions').includes(DASH_TO_DOCK) &&
                !this._shell.get_boolean('disable-user-extensions');
        };
        syncBlocked();
        this._shellIds = [
            this._shell.connect('changed::enabled-extensions', syncBlocked),
            this._shell.connect('changed::disable-user-extensions', syncBlocked),
        ];

        const dock = new Adw.PreferencesGroup({
            title: 'Dock',
            description: 'The pinned apps and those with windows on the workspace, at the bottom of the screen. ' +
                'Dynamic Music Pill sits at its end when it is set to go into the dock.',
        });
        this.add(dock);
        this._enabled = this._switch(dock, 'enabled', 'Atelier\'s dock', '');
        this._intellihide = this._switch(dock, 'intellihide', 'Out of the way of windows',
            'It moves away when a window of the focused app covers it; the bottom edge brings it back');
        this._size = new Adw.SpinRow({
            title: 'Icon size',
            subtitle: 'In pixels',
            adjustment: new Gtk.Adjustment({lower: 32, upper: 64, step_increment: 4, page_increment: 8}),
        });
        this._dock.bind('icon-size', this._size, 'value', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push(this._size, 'value');
        dock.add(this._size);
        for (const row of [this._intellihide, this._size]) {
            this._dock.bind('enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            this._bound.push(row, 'sensitive');
        }
    }

    _switch(group, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        this._dock.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push(row, 'active');
        group.add(row);
        return row;
    }

    disconnectSettings() {
        this._shellIds.forEach(id => this._shell.disconnect(id));
        this._shellIds = [];
        for (let i = 0; i < this._bound.length; i += 2)
            Gio.Settings.unbind(this._bound[i], this._bound[i + 1]);
        this._bound = [];
    }
});
