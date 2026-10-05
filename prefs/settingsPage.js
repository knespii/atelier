// "Settings" page: switcher options, transition, theme check and reset.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {gtk3ConfigDir, gtk4ConfigDir, legacyLinks, writeStylesheet} from '../lib/gtkCss.js';
import {findThemeArchives, getUserThemeSettings, isUserThemeEnabled, scanThemes} from '../lib/themes.js';
import {ShortcutRow} from './shortcutRow.js';
import {toast} from './widgets.js';

Gio._promisify(Adw.AlertDialog.prototype, 'choose', 'choose_finish');

const TRANSITIONS = [['circle', 'Circle reveal'], ['fade', 'Fade']];

const RESET_KEYS = ['gtk-theme', 'icon-theme', 'cursor-theme', 'font-name', 'color-scheme', 'accent-color'];

const home = path => path.replace(GLib.get_home_dir(), '~');

export const SettingsPage = GObject.registerClass(
class AtelierSettingsPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
            name: 'settings',
        });
        this._settings = settings;
        this._settingsIds = [];

        this.add(this._buildSwitcherGroup());
        this.add(this._buildTransitionGroup());

        this._healthGroup = new Adw.PreferencesGroup({
            title: 'Theme Check',
            description: 'Problems with installed themes that can break the desktop.',
        });
        this.add(this._healthGroup);
        this._checkThemes().catch(e => console.error('Atelier: theme check failed', e));

        this.add(this._buildResetGroup());
    }

    disconnectSettings() {
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._settingsIds = [];
        this._shortcutRows.forEach(row => row.disconnectSettings());
    }

    _buildSwitcherGroup() {
        const group = new Adw.PreferencesGroup({title: 'Switcher'});

        const indicator = new Adw.SwitchRow({title: 'Show button in the top bar'});
        this._settings.bind('show-indicator', indicator, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(indicator);

        this._shortcutRows = [
            ['atelier-open-switcher', 'Open the switcher'],
            ['atelier-next-profile', 'Apply the next profile'],
            ['atelier-previous-profile', 'Apply the previous profile'],
        ].map(([key, title]) => new ShortcutRow({settings: this._settings, key, title}));
        this._shortcutRows.forEach(row => group.add(row));
        return group;
    }

    _buildTransitionGroup() {
        const group = new Adw.PreferencesGroup({title: 'Wallpaper Transition'});

        const kind = new Adw.ComboRow({
            title: 'Animation',
            model: Gtk.StringList.new(TRANSITIONS.map(([, label]) => label)),
        });
        group.add(kind);

        const duration = new Adw.SpinRow({
            title: 'Circle duration',
            subtitle: 'In milliseconds',
            adjustment: new Gtk.Adjustment({
                lower: 200,
                upper: 3000,
                step_increment: 100,
                page_increment: 500,
            }),
        });
        group.add(duration);

        const sync = () => {
            const transition = this._settings.get_string('transition');
            kind.selected = Math.max(0, TRANSITIONS.findIndex(([value]) => value === transition));
            duration.value = this._settings.get_uint('transition-duration');
            duration.sensitive = transition === 'circle';
        };
        sync();
        kind.connect('notify::selected', () =>
            this._settings.set_string('transition', TRANSITIONS[kind.selected][0]));
        duration.connect('notify::value', () =>
            this._settings.set_uint('transition-duration', Math.round(duration.value)));
        this._settingsIds.push(
            this._settings.connect('changed::transition', sync),
            this._settings.connect('changed::transition-duration', sync));
        return group;
    }

    async _checkThemes() {
        const [themes, archives] = await Promise.all([scanThemes(), findThemeArchives()]);
        const issues = [];

        if (!isUserThemeEnabled()) {
            issues.push({
                title: 'User Themes is not enabled',
                subtitle: 'Profiles can’t change the shell theme until the User Themes extension is on.',
            });
        }
        for (const theme of themes.shell.filter(t => t.compat === 'outdated')) {
            issues.push({
                title: `“${theme.name}” is an outdated shell theme`,
                subtitle: 'It was made for GNOME 42 or older. As shell theme on GNOME 48 it breaks ' +
                    'the top bar menus, quick settings and notifications. Its GTK part can still be used.',
            });
        }
        for (const archive of archives) {
            issues.push({
                title: `${home(archive)} is an archive`,
                subtitle: 'Extract it and remove the archive, or move it elsewhere. While it is there, ' +
                    'the User Themes settings fail to list the installed themes.',
            });
        }

        if (issues.length === 0) {
            const row = new Adw.ActionRow({title: 'No problems found'});
            row.add_prefix(new Gtk.Image({icon_name: 'object-select-symbolic', css_classes: ['success']}));
            this._healthGroup.add(row);
            return;
        }
        for (const {title, subtitle} of issues) {
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(title, -1),
                subtitle: GLib.markup_escape_text(subtitle, -1),
            });
            row.add_prefix(new Gtk.Image({icon_name: 'dialog-warning-symbolic', css_classes: ['warning']}));
            this._healthGroup.add(row);
        }
    }

    _buildResetGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Reset',
            description: 'If a theme broke your desktop: go back to the GNOME defaults for themes, ' +
                'icons, cursor, font, style and accent color. The wallpaper stays.',
        });
        const row = new Adw.ButtonRow({
            title: 'Reset Appearance to GNOME Defaults',
            css_classes: ['destructive-action'],
        });
        row.connect('activated', () => this._reset().catch(e => toast(this, e.message)));
        group.add(row);
        return group;
    }

    async _reset() {
        const dialog = new Adw.AlertDialog({
            heading: 'Reset appearance?',
            body: 'GTK theme, shell theme, icons, cursor, font, light/dark style and accent color ' +
                'go back to the GNOME defaults, and GTK apps stop using Atelier\'s colors. ' +
                'Your profiles are kept.',
            close_response: 'cancel',
            default_response: 'cancel',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('reset', 'Reset');
        dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        if (await dialog.choose(this, null) !== 'reset')
            return;

        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        for (const key of RESET_KEYS.filter(k => iface.settings_schema.has_key(k)))
            iface.reset(key);
        getUserThemeSettings()?.reset('name');
        // GTK apps lose Atelier's theme and colors; only Atelier's own files go.
        this._settings.set_string('gtk4-theme', '');
        this._settings.get_child('palette').set_boolean('gtk-apps', false);
        const legacy = legacyLinks(this._settings);
        const results = await Promise.all([
            writeStylesheet(`${gtk4ConfigDir()}/gtk.css`, null, {legacyTarget: legacy['gtk.css'] ?? null}),
            writeStylesheet(`${gtk3ConfigDir()}/gtk.css`, null),
        ]);
        this._settings.set_string('active-profile', '');
        toast(this, results.some(r => r.changed)
            ? 'Appearance reset. Restart open apps to drop Atelier\'s GTK styles.'
            : 'Appearance reset to the GNOME defaults');
    }
});
