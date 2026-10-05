// The palette feature: recomputes the palette whenever the wallpaper, the
// light/dark style or the palette settings change, and hands it to the
// shell styles (and, in later steps, to GTK apps and the terminal).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {paletteForWallpaper, readPaletteOptions} from '../lib/wallpaperPalette.js';
import {ThemeManager} from './core/theme.js';

const OPTION_KEYS = ['source', 'swatch', 'preset', 'variant'];
const RECOMPUTE_DELAY = 150; // ms

export class PaletteModule extends Signals.EventEmitter {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     */
    constructor({settings}) {
        super();
        this._settings = settings;
        this._palette = null;
        this._timeoutId = 0;
        this._serial = 0;
    }

    /** @returns {object|null} the palette in use */
    get palette() {
        return this._palette;
    }

    enable() {
        this._paletteSettings = this._settings.get_child('palette');
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._theme = new ThemeManager();

        this._background.connectObject(
            'changed::picture-uri', () => this._queue(),
            'changed::picture-uri-dark', () => this._queue(),
            this);
        this._interface.connectObject('changed::color-scheme', () => this._queue(), this);
        this._paletteSettings.connectObject('changed', (_, key) => {
            if (OPTION_KEYS.includes(key))
                this._queue();
        }, this);

        // Start from the last palette, so the styles are right immediately.
        try {
            this._palette = JSON.parse(this._paletteSettings.get_string('current'));
            this._theme.update(this._palette).catch(e => console.warn(`Atelier: ${e.message}`));
        } catch {
            this._palette = null;
        }
        this._queue(0);
    }

    disable() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._serial++;

        this._background.disconnectObject(this);
        this._interface.disconnectObject(this);
        this._paletteSettings.disconnectObject(this);
        this._theme.destroy();
        this._theme = null;
        this._background = null;
        this._interface = null;
        this._paletteSettings = null;
    }

    /** @returns {string|null} path of the wallpaper on screen */
    _currentWallpaper() {
        const dark = this._interface.get_string('color-scheme') === 'prefer-dark';
        const uri = (dark && this._background.get_string('picture-uri-dark')) ||
            this._background.get_string('picture-uri');
        return uri ? Gio.File.new_for_uri(uri).get_path() : null;
    }

    _queue(delay = RECOMPUTE_DELAY) {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeoutId = 0;
            this._recompute().catch(e => console.error('Atelier: palette update failed', e));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _recompute() {
        const serial = ++this._serial;
        const palette = await paletteForWallpaper(this._currentWallpaper(),
            readPaletteOptions(this._paletteSettings));
        // Superseded by a newer change, or disabled meanwhile.
        if (serial !== this._serial || !this._theme)
            return;

        this._palette = palette;
        const json = JSON.stringify(palette);
        if (this._paletteSettings.get_string('current') !== json)
            this._paletteSettings.set_string('current', json);
        await this._theme.update(palette);
        if (serial === this._serial)
            this.emit('changed', palette);
    }
}
