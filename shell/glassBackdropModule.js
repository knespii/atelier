// The glass clock's frosted wallpaper (shell/lockscreen/liquidGlass.js),
// made in the session ahead of the lock screen: of the wallpaper the lock
// screen shows, for the main monitor at its scale, a moment after either
// changes (a profile applied, the style turned dark, a monitor plugged in)
// while a glass clock is on the lock screen. Made once for each: one made
// already is used as it is. It stops with the session's modules as the
// screen locks; the lock screen finds the backdrop made (or makes it then,
// in the background, never holding anything up).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LOCK_KINDS, parseLayout} from '../lib/widgets.js';
import {prepareLockBackdrop} from './lockscreen/liquidGlass.js';

const DELAY = 1000; // after a change, before it is made, ms

export class GlassBackdropModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings - Atelier's
     */
    constructor({settings}) {
        this._settings = settings;
        this._timeoutId = 0;
    }

    enable() {
        this._lockSettings = this._settings.get_child('lockscreen');
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        // (Any of the background's keys: the picture, how it is placed, the
        // colours round it.)
        this._background.connectObject('changed', () => this._queue(), this);
        this._interface.connectObject('changed::color-scheme', () => this._queue(), this);
        this._lockSettings.connectObject('changed::widgets', () => this._queue(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._queue(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor', () => this._queue(), this);
        this._queue();
    }

    disable() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._background.disconnectObject(this);
        this._interface.disconnectObject(this);
        this._lockSettings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this._background = null;
        this._interface = null;
        this._lockSettings = null;
    }

    _queue() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, DELAY, () => {
            this._timeoutId = 0;
            this._prepare();
            return GLib.SOURCE_REMOVE;
        });
    }

    // (Only for a lock screen with a glass clock on it.)
    _prepare() {
        const monitor = Main.layoutManager.primaryMonitor;
        const layout = parseLayout(this._lockSettings.get_string('widgets'), LOCK_KINDS);
        if (!monitor || !layout.some(entry => entry.kind === 'clock' && entry.face === 'glass'))
            return;
        prepareLockBackdrop({
            background: this._background,
            iface: this._interface,
            monitor: [monitor.width, monitor.height],
            scale: St.ThemeContext.get_for_stage(global.stage).scale_factor,
        }).catch(e => console.warn(`Atelier: the glass clock's backdrop isn't made ahead: ${e.message}`));
    }
}
