// Keeps the GTK user stylesheets (~/.config/gtk-{3,4}.0/gtk.css) in step with
// the palette, the GTK 4 theme chosen by the active profile and the
// light/dark style. GTK reads them when an app starts.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    gtk3ConfigDir, gtk3Stylesheet, gtk4ConfigDir, gtk4Stylesheet, legacyLinks,
    removeLegacyAssetsLink, themeStylesheet, writeStylesheet,
} from '../../lib/gtkCss.js';

export class GtkStyles {
    /**
     * @param {Gio.Settings} settings - Atelier's settings
     */
    constructor(settings) {
        this._settings = settings;
        this._palette = null;
        this._chain = Promise.resolve();
        this._enabled = false;
    }

    enable() {
        this._enabled = true;
        this._paletteSettings = this._settings.get_child('palette');
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._paletteSettings.connectObject('changed::gtk-apps', () => this.update(), this);
        this._settings.connectObject('changed::gtk4-theme', () => this.update(), this);
        // A theme's dark stylesheet is a separate file.
        this._interface.connectObject('changed::color-scheme', () => this.update(), this);
    }

    disable() {
        this._enabled = false;
        this._paletteSettings.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._interface.disconnectObject(this);
        this._paletteSettings = null;
        this._interface = null;
    }

    /** @param {object} palette */
    setPalette(palette) {
        this._palette = palette;
        this.update();
    }

    /**
     * Rewrite the stylesheets. Writes run one after another.
     *
     * @returns {Promise<void>}
     */
    update() {
        const run = this._chain.then(() => this._write());
        this._chain = run.catch(e => console.warn(`Atelier: GTK styles not written: ${e.message}`));
        return this._chain;
    }

    async _write() {
        if (!this._enabled)
            return;
        const dark = this._interface.get_string('color-scheme') === 'prefer-dark';
        const themeCss = themeStylesheet(this._settings.get_string('gtk4-theme'), dark);
        const palette = this._paletteSettings.get_boolean('gtk-apps') ? this._palette : null;
        if (this._paletteSettings.get_boolean('gtk-apps') && !palette)
            return; // wait for the first palette instead of removing the colors

        const legacy = legacyLinks(this._settings);
        const results = [
            await writeStylesheet(`${gtk4ConfigDir()}/gtk.css`, gtk4Stylesheet({themeCss, palette}),
                {legacyTarget: legacy['gtk.css'] ?? null}),
            await writeStylesheet(`${gtk3ConfigDir()}/gtk.css`, gtk3Stylesheet({palette})),
        ];
        if (!this._enabled)
            return;

        if (results[0].ok && (legacy['gtk.css'] || legacy.assets)) {
            await removeLegacyAssetsLink(gtk4ConfigDir(), legacy.assets ?? null);
            this._settings.set_string('gtk4-link', '');
        }

        const problem = results.filter(r => !r.ok).map(r => r.reason).join('\n');
        if (problem !== this._settings.get_string('gtk-css-problem')) {
            this._settings.set_string('gtk-css-problem', problem);
            if (problem)
                Main.notify('Atelier can\'t color GTK apps', problem);
        }
    }
}
