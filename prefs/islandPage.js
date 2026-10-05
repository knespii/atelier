// "Island" section: the capsule in the middle of the top bar.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import {ShortcutRow} from './shortcutRow.js';

export const IslandPage = GObject.registerClass(
class AtelierIslandPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Island', name: 'island'});
        this._island = settings.get_child('island');
        this._bound = [];

        const group = new Adw.PreferencesGroup({
            title: 'Island',
            description: 'A black capsule in the middle of the top bar, in place of GNOME\'s clock. ' +
                'It shows the switcher, the power menu and notifications, and opens the control ' +
                'centre when clicked.',
        });
        this.add(group);

        this._enabled = this._switch(group, 'enabled', 'Show the island');
        const options = [
            this._switch(group, 'show-date', 'Show the date', 'Next to the time'),
            this._switch(group, 'glance-on-hover', 'Glance on hover',
                'A big clock, this week, what\'s left of today and the weather'),
            this._switch(group, 'profile-toast', 'Profile toast',
                'Briefly show the profile\'s name after switching'),
        ];

        const shortcuts = new Adw.PreferencesGroup({title: 'Shortcuts'});
        this.add(shortcuts);
        this._shortcutRow = new ShortcutRow({
            settings: this._island,
            key: 'atelier-power-menu',
            title: 'Open the power menu',
        });
        shortcuts.add(this._shortcutRow);

        for (const row of [...options, this._shortcutRow]) {
            this._island.bind('enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            this._bound.push([row, 'sensitive']);
        }
    }

    _switch(group, key, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        this._island.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push([row, 'active']);
        group.add(row);
        return row;
    }

    disconnectSettings() {
        this._bound.forEach(([row, property]) => Gio.Settings.unbind(row, property));
        this._bound = [];
        this._shortcutRow.disconnectSettings();
    }
});
