// "Top Bar" section: the bar's look, the island's and the control centre.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

const STYLES = [
    ['gnome', 'GNOME', 'GNOME\'s black bar'],
    ['clear', 'Clear', 'No background: the workspaces, the island and the status icons on the wallpaper'],
    ['grouped', 'Grouped', 'The sides in capsules like the island'],
];
const SURFACES = [['classic', 'Black'], ['glass', 'Glass']];
const SHAPES = [['floating', 'Floating'], ['notch', 'Notch']];

export const BarPage = GObject.registerClass(
class AtelierBarPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Top Bar', name: 'top-bar'});
        this._ids = [];
        this._bound = [];
        this._bar = settings.get_child('bar');
        const controlCentre = settings.get_child('control-centre');

        const look = new Adw.PreferencesGroup({title: 'Top Bar'});
        this.add(look);
        this._style = this._choice(look, 'style', STYLES, 'Style');
        this._surface = this._choice(look, 'surface', SURFACES, 'Island and capsules',
            'Black, or glass: the blurred wallpaper');
        this._shape = this._choice(look, 'island-shape', SHAPES, 'Island',
            'A capsule in the bar, or a notch hanging from the top edge');

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

    _choice(group, key, choices, title, subtitle = '') {
        const row = new Adw.ComboRow({
            title,
            subtitle,
            model: Gtk.StringList.new(choices.map(([, label]) => label)),
        });
        const sync = () => {
            const index = choices.findIndex(([value]) => value === this._bar.get_string(key));
            if (row.selected !== index)
                row.selected = Math.max(0, index);
            if (choices[0].length > 2)
                row.subtitle = choices[row.selected][2];
        };
        sync();
        row.connect('notify::selected', () => {
            const [value] = choices[row.selected] ?? choices[0];
            if (this._bar.get_string(key) !== value)
                this._bar.set_string(key, value);
            sync();
        });
        this._ids.push(this._bar.connect(`changed::${key}`, sync));
        group.add(row);
        return row;
    }

    _switch(group, settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push(row, 'active');
        group.add(row);
        return row;
    }

    disconnectSettings() {
        this._ids.forEach(id => this._bar.disconnect(id));
        this._ids = [];
        for (let i = 0; i < this._bound.length; i += 2)
            Gio.Settings.unbind(this._bound[i], this._bound[i + 1]);
        this._bound = [];
    }
});
