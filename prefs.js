// Atelier's settings: a sidebar of sections, opened from the gear in the
// Extensions app.

import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {AtelierView} from './prefs/app.js';
import {AppearancePage} from './prefs/appearancePage.js';
import {IslandPage} from './prefs/islandPage.js';
import {ProfilesPage} from './prefs/profilesPage.js';
import {SettingsPage} from './prefs/settingsPage.js';
import {WallpapersPage} from './prefs/wallpapersPage.js';
import {installCss} from './prefs/widgets.js';

export default class AtelierPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        installCss(window);
        window.set_default_size(980, 780);
        window.search_enabled = false;

        const view = new AtelierView([
            {
                id: 'island', title: 'Island', icon: 'preferences-system-time-symbolic', group: 'THE SHELL',
                keywords: ['clock', 'time', 'date', 'glance', 'calendar', 'weather', 'power', 'microphone',
                    'toast', 'top bar', 'panel'],
                create: () => new IslandPage(settings),
            },
            {
                id: 'profiles', title: 'Profiles', icon: 'view-grid-symbolic', group: 'THE DESK',
                keywords: ['look', 'theme', 'icons', 'cursor', 'font', 'accent', 'new', 'switch'],
                create: () => new ProfilesPage(settings),
            },
            {
                id: 'wallpapers', title: 'Wallpapers', icon: 'image-x-generic-symbolic', group: 'THE DESK',
                keywords: ['folder', 'pictures', 'background'],
                create: () => new WallpapersPage(settings),
            },
            {
                id: 'appearance', title: 'Appearance', icon: 'applications-graphics-symbolic', group: 'THE DESK',
                keywords: ['palette', 'colors', 'colours', 'gtk', 'terminal', 'variant', 'preset', 'swatch'],
                create: () => new AppearancePage(settings),
            },
            {
                id: 'system', title: 'System', icon: 'preferences-system-symbolic', group: 'THE SESSION',
                keywords: ['shortcut', 'keyboard', 'transition', 'animation', 'reset', 'top bar', 'about'],
                create: () => new SettingsPage(settings),
            },
        ]);

        // The Extensions app expects at least one page; Atelier lays out its own.
        window.add(new Adw.PreferencesPage());
        window.set_content(view);
        window.add_toast = toast => view.toastOverlay.add_toast(toast);
        window.atelierView = view;

        window.connect('close-request', () => {
            view.disconnectPages();
            return false;
        });
    }
}
