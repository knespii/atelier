// Preferences window: manage profiles and settings.

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ProfilesPage} from './prefs/profilesPage.js';
import {SettingsPage} from './prefs/settingsPage.js';
import {installCss} from './prefs/widgets.js';

export default class AtelierPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        installCss(window);
        window.set_default_size(760, 860);

        const profiles = new ProfilesPage(settings);
        const preferences = new SettingsPage(settings);
        window.add(profiles);
        window.add(preferences);

        window.connect('close-request', () => {
            profiles.disconnectSettings();
            preferences.disconnectSettings();
            return false;
        });
    }
}
