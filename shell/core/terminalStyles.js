// Keeps Atelier's GNOME Terminal profile in step with the palette and the
// light/dark style while "Color GNOME Terminal" is on. Open terminals that
// use the profile change colors immediately.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {applyTerminalColors, restoreTerminal, terminalColors} from '../../lib/terminal.js';

export class TerminalStyles {
    /**
     * @param {Gio.Settings} settings - Atelier's settings
     */
    constructor(settings) {
        this._settings = settings;
        this._palette = null;
        this._reported = false;
    }

    enable() {
        this._paletteSettings = this._settings.get_child('palette');
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._paletteSettings.connectObject('changed::terminal', () => {
            if (this._paletteSettings.get_boolean('terminal'))
                this._sync();
            else
                restoreTerminal(this._paletteSettings);
        }, this);
        this._interface.connectObject('changed::color-scheme', () => this._sync(), this);
    }

    disable() {
        // The profile stays as it is: being disabled (e.g. while the screen
        // is locked) is not the same as switching terminal colors off.
        this._paletteSettings.disconnectObject(this);
        this._interface.disconnectObject(this);
        this._paletteSettings = null;
        this._interface = null;
    }

    /** @param {object} palette */
    setPalette(palette) {
        this._palette = palette;
        this._sync();
    }

    _sync() {
        if (!this._palette || !this._paletteSettings?.get_boolean('terminal'))
            return;
        const dark = this._interface.get_string('color-scheme') === 'prefer-dark';
        try {
            const result = applyTerminalColors(this._paletteSettings, terminalColors(this._palette, dark));
            if (!result.ok && !this._reported) {
                this._reported = true;
                Main.notify('Atelier can\'t color the terminal', result.reason);
            }
        } catch (e) {
            console.warn(`Atelier: terminal colors not applied: ${e.message}`);
        }
    }
}
