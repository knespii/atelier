// The lock screen's type: the tone of each widget – picked from the part
// of the wallpaper behind it (lib/lockLook.js), unless a colour is chosen –
// and the font chosen for them. The wallpaper is sampled from its
// thumbnail (made on the desktop already, most likely), anew when it
// changes; nothing here reads the network or starts anything.

import Gio from 'gi://Gio';
import PangoCairo from 'gi://PangoCairo';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {
    chosenTone, fontFor, isColor, partStyle, pickTone, regionIn, regionStats, widgetStyle,
} from '../../lib/lockLook.js';
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
            this);
        palette?.connectObject('changed::current', () => {
            this._syncTint();
            this.emit('changed');
        }, this);
        this._syncTint();
        this._load();
    }

    /** @returns {object} the font chosen, as there is (lib/lockLook.js fontFor()) */
    get font() {
        return fontFor(this._settings.get_string('clock-font'), installedFamilies());
    }

    /** @returns {object|null} the wallpaper's sample, once it is there */
    get sample() {
        return this._sample;
    }

    /**
     * @param {number[]} rect - [x, y, width, height] of a widget on the
     *   main monitor, 0 … 1
     * @param {number} aspect - the monitor's width over its height
     * @returns {object} the tone of its type (lib/lockLook.js pickTone())
     */
    toneFor(rect, aspect) {
        const chosen = this._settings.get_string('clock-color');
        if (isColor(chosen))
            return chosenTone(chosen);
        const sample = this._sample;
        const stats = sample ? regionStats(sample, regionIn(rect, aspect, sample.width / sample.height)) : null;
        return pickTone(stats, {tint: this._tint, dim: GLASS.brightness});
    }

    /**
     * @param {number[]} rect - as for toneFor()
     * @param {number} aspect
     * @param {boolean} toned - on the wallpaper (on a card, the card's colours)
     * @returns {{widget: string, part: Function}} the inline style of the
     *   widget, and of a part of it (given its style classes)
     */
    styleOf(rect, aspect, toned) {
        const tone = toned ? this.toneFor(rect, aspect) : null;
        const font = this.font;
        return {
            widget: widgetStyle(tone, font),
            part: classes => partStyle(classes, tone, font),
        };
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
