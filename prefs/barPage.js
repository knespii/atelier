// "Top Bar" section: the bar's look and the control centre.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

export const BarPage = GObject.registerClass(
class AtelierBarPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Top Bar', name: 'top-bar'});
        this._bound = [];
        const bar = settings.get_child('bar');
        const controlCentre = settings.get_child('control-centre');

        const look = new Adw.PreferencesGroup({title: 'Top Bar'});
        this.add(look);
        this._transparent = this._switch(look, bar, 'transparent', 'No background',
            'Just the workspaces, the island and the status icons on the wallpaper. ' +
            'Blur my Shell, if it blurs the bar, still draws its own background.');

        const centre = new Adw.PreferencesGroup({
            title: 'Control Centre',
            description: 'GNOME\'s quick settings – Wi-Fi, Bluetooth, sound, brightness, power mode and the ' +
                'tiles of extensions such as Caffeine – with the notifications and the calendar on further ' +
                'tabs, in the island. The status icons in the bar only show the state.',
        });
        this.add(centre);
        this._controlCentre = this._switch(centre, controlCentre, 'enabled', 'Open the control centre in the island',
            'Click the island, or Super+S; Super+V for the notifications');
        this._extensions = this._switch(centre, controlCentre, 'extensions', 'Extension icons in the control centre',
            'On its Extensions tab instead of the top bar');
        controlCentre.bind('enabled', this._extensions, 'sensitive', Gio.SettingsBindFlags.GET);
        this._bound.push(this._extensions, 'sensitive');
    }

    _switch(group, settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push(row, 'active');
        group.add(row);
        return row;
    }

    disconnectSettings() {
        for (let i = 0; i < this._bound.length; i += 2)
            Gio.Settings.unbind(this._bound[i], this._bound[i + 1]);
        this._bound = [];
    }
});
