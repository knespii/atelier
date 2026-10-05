// Preferences window: manage looks and settings.

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {LooksPage} from './prefs/looksPage.js';
import {installCss} from './prefs/widgets.js';

export default class BgChangerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        installCss(window);
        window.set_default_size(760, 860);

        const looks = new LooksPage(settings);
        window.add(looks);

        window.connect('close-request', () => {
            looks.disconnectSettings();
            return false;
        });
    }
}
