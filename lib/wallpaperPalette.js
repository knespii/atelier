// The palette for a wallpaper, honouring the palette settings.
// Shared by the shell and the preferences.

import Gio from 'gi://Gio';

import {PRESETS, buildPalette, extractSwatches, pickSource} from './palette.js';
import {sampleWallpaper} from './thumbnails.js';

const FALLBACK = PRESETS.slate.color;

/**
 * @param {Gio.Settings} paletteSettings - Atelier's palette settings
 * @returns {{source: string, swatch: number, preset: string, variant: string}}
 */
export function readPaletteOptions(paletteSettings) {
    return {
        source: paletteSettings.get_string('source'),
        swatch: paletteSettings.get_int('swatch'),
        preset: paletteSettings.get_string('preset'),
        variant: paletteSettings.get_string('variant'),
    };
}

/**
 * @param {Gio.Settings} background - org.gnome.desktop.background
 * @param {Gio.Settings} desktopInterface - org.gnome.desktop.interface
 * @returns {string|null} path of the wallpaper on screen (the dark one in
 *   the dark style), as GNOME shows it on the desktop and the lock screen
 */
export function wallpaperShown(background, desktopInterface) {
    const dark = desktopInterface.get_string('color-scheme') === 'prefer-dark';
    const uri = (dark && background.get_string('picture-uri-dark')) || background.get_string('picture-uri');
    return uri ? Gio.File.new_for_uri(uri).get_path() : null;
}

/**
 * Build the palette for a wallpaper.
 *
 * @param {string|null} wallpaper - path of the wallpaper, if any
 * @param {object} options - see readPaletteOptions()
 * @returns {Promise<object>} the palette (see buildPalette())
 */
export async function paletteForWallpaper(wallpaper, options) {
    const {source = 'wallpaper', swatch = 0, preset = 'ochre', variant = 'vibrant'} = options;

    let swatches = [];
    if (wallpaper) {
        try {
            const sample = await sampleWallpaper(wallpaper);
            swatches = extractSwatches(sample.pixels, sample);
        } catch (e) {
            console.warn(`Atelier: no colors from ${wallpaper}: ${e.message}`);
        }
    }

    let color;
    if (source === 'preset')
        color = (PRESETS[preset] ?? PRESETS.ochre).color;
    else if (source === 'swatch' && swatches[swatch])
        color = swatches[swatch].hex;
    else if (swatches.length > 0)
        color = swatches[pickSource(swatches)].hex;
    else
        color = FALLBACK;

    return buildPalette({source: color, variant, swatches: swatches.map(s => s.hex)});
}
