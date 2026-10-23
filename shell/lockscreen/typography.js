// The lock screen's type: one tone for all its widgets – picked from the
// parts of the wallpaper behind them together (lib/lockLook.js), unless a
// colour is chosen – what is behind each part, and the typeface chosen for
// them, the clocks' digits in the weight and width set (lib/lockType.js).
// The wallpaper is sampled from its thumbnail (made on the desktop already,
// most likely), anew when it changes; nothing here reads the network or
// starts anything.

import Gio from 'gi://Gio';
import PangoCairo from 'gi://PangoCairo';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {chosenTone, isColor, lockTone, mergeStats, regionIn, regionStats} from '../../lib/lockLook.js';
import {styleFor, typefaceFor} from '../../lib/lockType.js';
import {sampleWallpaper} from '../../lib/thumbnails.js';
import {wallpaperShown} from '../../lib/wallpaperPalette.js';
import {GLASS} from './glass.js';

const SAMPLE = [96, 60]; // pixels, as the thumbnail's 16:10

// The font families there are, listed once (fonts installed meanwhile are
// there next time the shell starts).
let families = null;

function installedFamilies() {
    if (!families) {
        try {
            families = PangoCairo.FontMap.get_default().list_families().map(family => family.get_name());
        } catch (e) {
            console.warn(`Atelier: the fonts there are can't be listed: ${e.message}`);
            families = [];
        }
    }
    return families.length > 0 ? families : null;
}

export class LockTypography extends EventEmitter {
    /**
     * @param {Gio.Settings} settings - the lockscreen ones
     * @param {Gio.Settings|null} palette - Atelier's palette settings (the
     *   palette's hue tints the type)
     */
    constructor(settings, palette) {
        super();
        this._settings = settings;
        this._palette = palette;
        this._sample = null;
        this._serial = 0;
        this._tint = null;
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._background.connectObject(
            'changed::picture-uri', () => this._load(),
            'changed::picture-uri-dark', () => this._load(),
            this);
        this._interface.connectObject('changed::color-scheme', () => this._load(), this);
        settings.connectObject(
            'changed::clock-color', () => this.emit('changed'),
            'changed::clock-font', () => this.emit('changed'),
            'changed::clock-weight', () => this.emit('changed'),
            'changed::clock-width', () => this.emit('changed'),
            this);
        palette?.connectObject('changed::current', () => {
            this._syncTint();
            this.emit('changed');
        }, this);
        this._syncTint();
        this._load();
    }

    /** @returns {object} the typeface chosen, as there is (lib/lockType.js typefaceFor()) */
    get typeface() {
        return typefaceFor(this._settings.get_string('clock-font'), installedFamilies());
    }

    /**
     * @param {string} role - 'glass', 'digits' or 'text' (lib/lockType.js
     *   ROLES; lib/lockLook.js roleOf() tells a part's)
     * @returns {{weight: number, width: number}} how a part of it is set:
     *   the clocks' digits in the weight and width the settings say
     */
    styleFor(role) {
        return styleFor(this.typeface, role, {
            weight: this._settings.get_int('clock-weight'),
            width: this._settings.get_int('clock-width'),
        });
    }

    /** @returns {number} how much of the wallpaper's light is left at most while the prompt is up */
    get dim() {
        return GLASS.brightness;
    }

    /** @returns {object|null} the wallpaper's sample, once it is there */
    get sample() {
        return this._sample;
    }

    /**
     * @param {number[]} rect - [x, y, width, height] on the main monitor, 0 … 1
     * @param {number} aspect - the monitor's width over its height
     * @returns {object|null} what is behind it (lib/lockLook.js
     *   regionStats()); null until the wallpaper is sampled
     */
    statsOf(rect, aspect) {
        const sample = this._sample;
        return sample ? regionStats(sample, regionIn(rect, aspect, sample.width / sample.height)) : null;
    }

    /**
     * @param {object[]} parts - {rect, weight, text} of each widget: rect its
     *   [x, y, width, height] on the main monitor, 0 … 1; weight how much
     *   it counts (the clock more than the small widgets); text the most
     *   demanding type on it (lib/lockLook.js TYPE; none: the date line)
     * @param {number} aspect - the monitor's width over its height
     * @returns {object} the one tone of their type, with what it takes to
     *   read (lib/lockLook.js lockTone(), chosenTone())
     */
    toneFor(parts, aspect) {
        const stats = this._sample ? mergeStats(parts.map(({rect, weight, text}) => ({
            stats: this.statsOf(rect, aspect),
            weight,
            text,
        }))) : null;
        const chosen = this._settings.get_string('clock-color');
        if (isColor(chosen))
            return chosenTone(chosen, stats, {dim: this.dim});
        return lockTone(stats, {tint: this._tint, dim: this.dim});
    }

    // The palette's colour, unless it is to have none.
    _syncTint() {
        try {
            const palette = JSON.parse(this._palette?.get_string('current') ?? '');
            this._tint = palette?.variant !== 'monochrome' && isColor(palette?.source) ? palette.source : null;
        } catch {
            this._tint = null;
        }
    }

    async _load() {
        const serial = ++this._serial;
        const path = wallpaperShown(this._background, this._interface);
        let sample = null;
        if (path) {
            try {
                sample = await sampleWallpaper(path, ...SAMPLE);
            } catch (e) {
                console.warn(`Atelier: no tone from ${path}: ${e.message}`);
            }
        }
        // (Superseded, or gone meanwhile.)
        if (serial !== this._serial)
            return;
        this._sample = sample;
        this.emit('changed');
    }

    destroy() {
        this._serial++;
        this._background.disconnectObject(this);
        this._interface.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._palette?.disconnectObject(this);
    }
}
