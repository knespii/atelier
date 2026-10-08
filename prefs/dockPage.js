// "Dock" section: Atelier's dock at an edge of the screen – on or off, where
// and how big, how it hides, what clicks do, its marks and extra icons, its
// look (each in prefs/dock/*.js). It stays off while Dash to Dock is on;
// this page says so (turning Dash to Dock off is the user's call, in the
// Extensions app), and can bring Dash to Dock's settings over.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import * as appearance from './dock/appearance.js';
import * as behaviour from './dock/behaviour.js';
import {DockBinder} from './dock/common.js';
import * as hiding from './dock/hiding.js';
import * as importer from './dock/import.js';
import * as indicators from './dock/indicators.js';
import * as launchers from './dock/launchers.js';
import * as position from './dock/position.js';

const DASH_TO_DOCK = 'dash-to-dock@micxgx.gmail.com';
// The sections after the status, in order.
const SECTIONS = [position, hiding, behaviour, indicators, launchers, appearance];

export const DockPage = GObject.registerClass(
class AtelierDockPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Dock', name: 'dock'});
        this.rows = new Map(); // key → its row
        this._dock = settings.get_child('dock');
        this._binder = new DockBinder(this);
        this._shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
        const ctx = {settings: this._dock, binder: this._binder};

        const status = new Adw.PreferencesGroup({
            title: 'Dock',
            description: 'The pinned apps and those with windows on the workspace, at an edge of the screen.',
        });
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
        this._binder.connect(this._shell, 'changed::enabled-extensions', syncBlocked);
        this._binder.connect(this._shell, 'changed::disable-user-extensions', syncBlocked);
        this._binder.bindSwitch(status, this._dock, 'enabled', 'Atelier\'s dock');
        const importRow = importer.build(this, ctx);
        if (importRow)
            status.add(importRow);

        // The rest greys out while the dock is off.
        for (const section of SECTIONS) {
            for (const group of [section.build(this, ctx)].flat().filter(Boolean)) {
                this._binder.bindSensitive(group, this._dock, 'enabled');
                this.add(group);
            }
        }
    }

    disconnectSettings() {
        this._binder.disconnectSettings();
    }
});
