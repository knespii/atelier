// The power menu: five tiles. Lock and Suspend act at once; Log Out,
// Restart and Power Off go through GNOME's usual confirmation dialog.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {IslandPage} from './page.js';

/**
 * Ask GNOME's session manager to log out, with its confirmation dialog.
 * SystemActions only offers this when there is more than one user, but the
 * session can always be ended.
 */
function logOut() {
    Main.overview.hide();
    Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
        'org.gnome.SessionManager', 'Logout', new GLib.Variant('(u)', [0]), null,
        Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
            try {
                connection.call_finish(result);
            } catch (e) {
                console.error('Atelier: could not log out', e);
            }
        });
}

function logOutAllowed() {
    return !new Gio.Settings({schema_id: 'org.gnome.desktop.lockdown'}).get_boolean('disable-log-out');
}

export const POWER_ACTIONS = [
    {
        id: 'lock', label: 'Lock', icon: 'system-lock-screen-symbolic',
        available: actions => actions.canLockScreen,
        run: actions => actions.activateLockScreen(),
    },
    {
        id: 'suspend', label: 'Suspend', icon: 'weather-clear-night-symbolic',
        available: actions => actions.canSuspend,
        run: actions => actions.activateSuspend(),
    },
    {
        id: 'logout', label: 'Log Out', icon: 'system-log-out-symbolic',
        available: actions => actions.canLogout || logOutAllowed(),
        run: actions => (actions.canLogout ? actions.activateLogout() : logOut()),
    },
    {
        id: 'restart', label: 'Restart', icon: 'system-reboot-symbolic',
        available: actions => actions.canRestart,
        run: actions => actions.activateRestart(),
    },
    {
        id: 'power-off', label: 'Power Off', icon: 'system-shutdown-symbolic',
        available: actions => actions.canPowerOff,
        run: actions => actions.activatePowerOff(),
    },
];

export const PowerPage = GObject.registerClass({
    Signals: {'activate': {param_types: [GObject.TYPE_STRING]}},
}, class AtelierPowerPage extends IslandPage {
    /**
     * @param {object} actions - GNOME's SystemActions (or a stand-in in tests)
     */
    _init(actions) {
        super._init({style_class: 'atelier-power', orientation: Clutter.Orientation.VERTICAL});

        this.add_child(new St.Label({style_class: 'atelier-power-title', text: 'Power'}));
        this._tiles = new St.BoxLayout({style_class: 'atelier-power-tiles'});
        this.add_child(this._tiles);

        this._buttons = new Map();
        for (const action of POWER_ACTIONS) {
            const available = Boolean(action.available(actions));
            const box = new St.BoxLayout({
                style_class: 'atelier-power-tile-box',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(new St.Icon({
                style_class: 'atelier-power-icon',
                icon_name: action.icon,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            box.add_child(new St.Label({
                style_class: 'atelier-power-label',
                text: action.label,
                x_align: Clutter.ActorAlign.CENTER,
            }));
            const button = new St.Button({
                style_class: 'atelier-power-tile',
                accessible_name: action.label,
                can_focus: available,
                reactive: available,
                child: box,
            });
            if (!available)
                button.add_style_pseudo_class('insensitive');
            button.connect('clicked', () => this.emit('activate', action.id));
            this._tiles.add_child(button);
            this._buttons.set(action.id, button);
        }
    }

    focus() {
        const first = [...this._buttons.values()].find(button => button.can_focus);
        (first ?? this).grab_key_focus();
    }

    handleKeyPress(event) {
        const symbol = event.get_key_symbol();
        const direction = {
            [Clutter.KEY_Left]: St.DirectionType.LEFT,
            [Clutter.KEY_Right]: St.DirectionType.RIGHT,
            [Clutter.KEY_Up]: St.DirectionType.LEFT,
            [Clutter.KEY_Down]: St.DirectionType.RIGHT,
        }[symbol];
        if (direction === undefined)
            return false;
        const focused = global.stage.get_key_focus();
        if (!this._tiles.contains(focused))
            this.focus();
        else
            this._tiles.navigate_focus(focused, direction, false);
        return true;
    }
});
