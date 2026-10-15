// "Lock Screen" section: what Atelier shows over GNOME's lock screen. The
// widgets are placed on a mock lock screen the shell shows when asked
// (the real one can't be edited: it is locked).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

const LOOKS = [['bare', 'Bare'], ['modern', 'Modern'], ['analogue', 'Analogue']];

export const LockScreenPage = GObject.registerClass(
class AtelierLockScreenPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Lock Screen', name: 'lock-screen'});
        this._lock = settings.get_child('lockscreen');
        this._bound = [];

        const group = new Adw.PreferencesGroup({
            title: 'Lock Screen',
            description: 'Atelier\'s things over GNOME\'s lock screen. GNOME still checks the password ' +
                '(and a fingerprint or a face, when they are set up); Atelier only follows it.',
        });
        this.add(group);
        this._switch(group, 'enabled', 'Atelier on the lock screen');
        const island = this._switch(group, 'island', 'Island with a padlock',
            'Turns while GNOME checks, shakes on a failure, opens in a green ring');

        const widgets = new Adw.PreferencesGroup({
            title: 'Widgets',
            description: 'Clocks and the date, anywhere on the main monitor.',
        });
        this.add(widgets);
        const edit = new Adw.ActionRow({
            title: 'Place the widgets',
            subtitle: 'On a mock lock screen, as on the desktop',
        });
        const button = new Gtk.Button({label: 'Edit Lock Screen…', valign: Gtk.Align.CENTER});
        button.connect('clicked', () => this._lock.set_string('edit-request', GLib.uuid_string_random()));
        edit.add_suffix(button);
        edit.activatable_widget = button;
        widgets.add(edit);

        const look = new Adw.ComboRow({
            title: 'Look',
            subtitle: 'Bare: just what they show, on the wallpaper',
            model: Gtk.StringList.new(LOOKS.map(([, name]) => name)),
        });
        const syncLook = () => {
            const index = LOOKS.findIndex(([id]) => id === this._lock.get_string('style'));
            if (look.selected !== Math.max(0, index))
                look.selected = Math.max(0, index);
        };
        syncLook();
        look.connect('notify::selected', () => this._lock.set_string('style', LOOKS[look.selected][0]));
        this._styleId = this._lock.connect('changed::style', syncLook);
        widgets.add(look);
        const clock = this._switch(widgets, 'gnome-clock', 'GNOME\'s clock',
            'Off when your own clocks take its place');

        for (const row of [island, edit, look, clock]) {
            this._lock.bind('enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            this._bound.push([row, 'sensitive']);
        }
    }

    _switch(group, key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        this._lock.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push([row, 'active']);
        group.add(row);
        return row;
    }

    disconnectSettings() {
        this._bound.forEach(([row, property]) => Gio.Settings.unbind(row, property));
        this._bound = [];
        if (this._styleId)
            this._lock.disconnect(this._styleId);
        this._styleId = 0;
    }
});
