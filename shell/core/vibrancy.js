// Vibrancy in the shell (lib/vibrancy.js): Atelier's surfaces of glass –
// the island, the bar's sides, the docks, the widgets' cards – say where
// they rest and what lies over their glass, and their type and icons get
// the colours that read there, each surface in a class of its own, from
// one stylesheet; and their glass the extra shade the type needs to read,
// which each surface's owner puts on its glass (eased there, on the GPU).
// Surfaces that are one glass – the bar's one island and the island at
// rest in it – take one polarity and one shade, the most either needs.
//
// What is behind a surface is the wallpaper as GNOME draws it on its
// monitor: sampled small once for each wallpaper (in GdkPixbuf's worker
// threads) and blurred as the glass blurs it, then made into the glass of
// the variant chosen, in GNOME's style, as a part as large as the surface
// (lib/glassLook.js; none for 'off': solid surfaces keep their colours).
// All of it is worked out anew a moment after the
// wallpaper, the palette, the variant, the monitors, the theme or a
// surface's place change – never while something moves: a surface says
// where it rests, not where it is on its way. Nothing is read back from
// the screen: live glass over windows (the island open) takes them to be
// the palette's surface in the style apps are in (windowSurface()).

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {placement} from '../../lib/depth.js';
import {frost, parseColor} from '../../lib/glassBackdrop.js';
import {NO_SHADE, lookOf, resolveVariant, smallness} from '../../lib/glassLook.js';
import {regionStats} from '../../lib/lockLook.js';
import {rgbToHex} from '../../lib/palette.js';
import {sampleWallpaper} from '../../lib/thumbnails.js';
import {
    backdropOf, pictureRegion, polarityOf, readingNeed, scopeOf, shadeNeeded, shadeOf, steadied, surfaceRules,
    vibrancyStylesheet, withBackground,
} from '../../lib/vibrancy.js';
import {wallpaperShown} from '../../lib/wallpaperPalette.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

// The wallpaper's sample: so many pixels along its longer side (a 1080p
// monitor's 3 to one): glass blurs it little now, and what is behind type
// is about as detailed as its own lines.
const SAMPLE_SIDE = 640;
// The samples blurred for the glass kept at most (one for each blur and
// monitor's size in use: a few).
const BLURRED_KEPT = 4;
// A moment after a change, so that a burst of them is one.
const DELAY = 200;

// The stylesheet kept loaded while the screen is locked (as the palette's:
// unloading it there and loading it again on unlock would restyle the
// whole shell twice for nothing – the classes it is in are gone meanwhile).
let kept = null;

/** Unload the stylesheet kept over a lock, if any (Atelier turned off). */
export function releaseKeptVibrancy() {
    if (!kept)
        return;
    St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(kept);
    kept.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    kept = null;
}

/**
 * What lies over a surface's glass, as its actors are styled: each one's
 * background colour (a card's, a dock's wash) – over its own shadow, where
 * the background lets that show through (St draws it under a see-through
 * card's background) – the most transparent first.
 *
 * @param {...St.Widget|null} actors
 * @returns {object[]} {color, alpha} of each that has one, the lowest first
 */
export function layersOf(...actors) {
    const layers = [];
    for (const actor of actors) {
        if (!actor?.get_stage?.())
            continue;
        const node = actor.get_theme_node();
        const {red, green, blue, alpha} = node.get_background_color();
        const shadow = alpha < 255 ? node.get_box_shadow() : null;
        if (shadow && !shadow.inset && shadow.color.alpha > 0) {
            const {red: r, green: g, blue: b, alpha: a} = shadow.color;
            layers.push({color: rgbToHex([r, g, b]), alpha: a / 255});
        }
        if (alpha > 0)
            layers.push({color: rgbToHex([red, green, blue]), alpha: alpha / 255});
    }
    return layers;
}

/**
 * @param {St.Widget|null} glass - a surface of Atelier's glass (shell/core/glass.js)
 * @returns {object[]} its tint over the blurred wallpaper, as styled, if it has one
 */
export function glassLayers(glass) {
    const tints = glass?.get_children?.().filter(child => child.visible && child.has_style_class_name?.('atelier-glass-tint'));
    return layersOf(...tints ?? []);
}

/**
 * @param {Clutter.Actor|null} glass - a surface of glass (shell/core/glass.js,
 *   shell/desktop/glass.js)
 * @returns {number} how bright its blur leaves the wallpaper (GNOME's blur
 *   dims what it blurs when asked to): its first blur's, a few actors deep;
 *   1 for none
 */
export function blurOf(glass) {
    let level = glass ? [glass] : [];
    for (let depth = 0; depth < 4 && level.length > 0; depth++) {
        for (const actor of level) {
            const blur = actor.get_effects().find(effect => effect instanceof Shell.BlurEffect);
            if (blur)
                return blur.brightness;
        }
        level = level.flatMap(actor => actor.get_children());
    }
    return 1;
}

// A picture decoded small, its longer side so long, turned as its camera
// says. (In GdkPixbuf's threads.)
async function decode(path, side) {
    const stream = await Gio.File.new_for_path(path).read_async(GLib.PRIORITY_LOW, null);
    try {
        const pixbuf = await new Promise((resolve, reject) => {
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, side, side, true, null, (_, res) => {
                try {
                    resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        return pixbuf.apply_embedded_orientation() ?? pixbuf;
    } finally {
        stream.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
    }
}

function fileSize(path) {
    return new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.get_file_info_async(path, null, (_, res) => {
            try {
                const [, width, height] = GdkPixbuf.Pixbuf.get_file_info_finish(res);
                resolve([width, height]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * A wallpaper's sample: all of the picture, small (not cut to a shape),
 * with its own size, so that it can be placed on a monitor as GNOME
 * places it.
 *
 * @param {string} path
 * @returns {Promise<object>} {pixels, channels, rowstride, width, height,
 *   picture: [width, height] as GNOME draws it}
 */
async function samplePicture(path) {
    // (A slideshow: its first picture's thumbnail, cut to 16:10 – near
    // enough for what is behind a surface.)
    if (path.toLowerCase().endsWith('.xml')) {
        const sample = await sampleWallpaper(path, SAMPLE_SIDE, Math.round(SAMPLE_SIDE / 1.6));
        return {...sample, picture: [sample.width, sample.height]};
    }
    const [stored, pixbuf] = await Promise.all([fileSize(path), decode(path, SAMPLE_SIDE)]);
    const [width, height] = [pixbuf.get_width(), pixbuf.get_height()];
    // (Turned by its camera: its stored sides the other way round.)
    const turned = width !== height && (width > height) !== (stored[0] > stored[1]);
    return {
        pixels: pixbuf.get_pixels(),
        channels: pixbuf.get_n_channels(),
        rowstride: pixbuf.get_rowstride(),
        width,
        height,
        picture: turned ? [stored[1], stored[0]] : stored,
    };
}

// One stylesheet, loaded in place of the one before (a new file each
// time: St keeps stylesheets by file).
class Stylesheet {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'atelier']);
        // (Kept over a lock: this one's now, replaced as any.)
        this._file = kept;
        kept = null;
        this._serial = 0;
        this._destroyed = false;
    }

    /** @returns {string|null} the name of the file loaded */
    get name() {
        return this._file?.get_basename() ?? null;
    }

    /** @param {string} css - '' for none */
    async set(css) {
        const serial = ++this._serial;
        if (!css) {
            this._unload();
            return;
        }
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, css, -1).slice(0, 12);
        const name = `vibrancy-${hash}.css`;
        if (this._file?.get_basename() === name)
            return;
        GLib.mkdir_with_parents(this._dir, 0o755);
        const file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, name]));
        await file.replace_contents_bytes_async(new GLib.Bytes(new TextEncoder().encode(css)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        if (serial !== this._serial || this._destroyed) {
            if (file.get_basename() !== this._file?.get_basename())
                file.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
            return;
        }
        this._unload();
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(file);
        this._file = file;
    }

    /** @param {boolean} [keep] - it stays loaded, for the next one (the screen locked) */
    destroy(keep = false) {
        this._destroyed = true;
        this._serial++;
        if (keep && this._file) {
            releaseKeptVibrancy();
            kept = this._file;
            this._file = null;
            return;
        }
        this._unload();
    }

    _unload() {
        if (!this._file)
            return;
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._file);
        this._file.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        this._file = null;
    }
}

// A surface whose type follows what is behind its glass.
class VibrantSurface {
    constructor(vibrancy, {
        id, inks, roots, rect = () => null, behind = null, blur = () => 1, tint = () => [], strength = () => 1,
        layers = () => [], oneWith = () => null, shaded = () => {},
    }) {
        this._vibrancy = vibrancy;
        this.id = id;
        this.inks = inks;
        this.roots = roots;
        this.rect = rect;
        this.behind = behind;
        this.blur = blur;
        this.tint = tint;
        this.strength = strength;
        this.layers = layers;
        this.oneWith = oneWith;
        this.shaded = shaded;
        /** the class its type's colours are in */
        this.scope = scopeOf(id);
        /** 'light' or 'dark' type, as last worked out (null: as set) */
        this.polarity = null;
        /** what its glass comes out as, shaded, as last worked out (lib/vibrancy.js backdropOf()) */
        this.backdrop = null;
        /** the extra shade its glass is to have, {dim, veil}, as last worked out */
        this.shade = NO_SHADE;
    }

    /** It rests elsewhere now, or what lies over its glass changed. */
    update() {
        this._vibrancy?.queue();
    }

    destroy() {
        this._vibrancy?.remove(this);
        this._vibrancy = null;
    }
}

export class VibrancyModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings - Atelier's
     * @param {ModuleManager} context.modules
     */
    constructor({settings, modules}) {
        this._settings = settings;
        this._modules = modules;
        this._surfaces = new Map();
        this._sample = null;
        // The sample blurred, by its sigma and size.
        this._blurred = new Map();
        this._serial = 0;
        this._timeoutId = 0;
    }

    enable() {
        this._stylesheet = new Stylesheet();
        this._paletteSettings = this._settings.get_child('palette');
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        // (GNOME's high contrast turns the glass off; where it can be told.)
        const a11y = Gio.SettingsSchemaSource.get_default().lookup('org.gnome.desktop.a11y.interface', true);
        this._a11y = a11y?.has_key('high-contrast')
            ? new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'}) : null;
        this._background.connectObject('changed', (_, key) => {
            if (['picture-uri', 'picture-uri-dark', 'picture-options'].includes(key))
                this._load();
            else
                this.queue();
        }, this);
        this._interface.connectObject('changed::color-scheme', () => this._load(), this);
        this._a11y?.connectObject('changed::high-contrast', () => this.queue(), this);
        this._settings.connectObject('changed::glass-variant', () => this.queue(), this);
        this._paletteSettings.connectObject('changed::current', () => this.queue(), this);
        // (The palette follows the wallpaper's file too: one set anew in
        // the same place.)
        this._followPalette();
        this._modules.connectObject('started', (_, id) => id === 'palette' && this._followPalette(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this.queue(), this);
        // (What lies over the glass is as styled: anew with the theme – this
        // stylesheet's own loading too, which changes nothing then.)
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'changed', () => this.queue(),
            'notify::scale-factor', () => this.queue(),
            this);
        this._load();
    }

    disable() {
        this._serial++;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._background.disconnectObject(this);
        this._interface.disconnectObject(this);
        this._a11y?.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._paletteSettings.disconnectObject(this);
        this._palette?.disconnectObject(this);
        this._palette = null;
        this._modules.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        for (const surface of this._surfaces.values())
            surface._vibrancy = null;
        this._surfaces.clear();
        // (Locked, it stays loaded, to be taken over on unlock.)
        this._stylesheet.destroy(Main.sessionMode.isLocked);
        this._stylesheet = null;
        this._sample = null;
        this._blurred.clear();
    }

    /**
     * A surface of glass whose type and icons are to follow what is behind
     * it. (One of the same id takes its place.)
     *
     * @param {object} params
     * @param {string} params.id - its own name: its class is
     *   lib/vibrancy.js scopeOf() it
     * @param {string} params.inks - its type, which of lib/vibrancy.js INKS
     * @param {string[]} params.roots - selectors of the actors the class is
     *   put on
     * @param {Function} params.rect - () => where it rests on the stage,
     *   {x, y, width, height}; null: nowhere now
     * @param {Function} [params.behind] - () => the colour behind it,
     *   '#rrggbb', instead of the wallpaper where it rests
     * @param {Function} [params.blur] - () => how bright its blur leaves the
     *   wallpaper (blurOf())
     * @param {Function} [params.tint] - () => what is in its glass, under
     *   the material, [{color, alpha}] (glassLayers())
     * @param {Function} [params.strength] - () => how much of its glass
     *   shows, 0 … 1 (fading, it lets the wallpaper through)
     * @param {Function} [params.layers] - () => what lies over its glass,
     *   as tint (layersOf(): a card's colour, a wash)
     * @param {Function} [params.oneWith] - () => the id of the surface its
     *   glass is one with (the island at rest in the bar's one island), or
     *   null: one polarity for both, and one shade, the most either needs
     * @param {Function} [params.shaded] - () => …, once it is worked out
     *   anew: its shade (surface.shade) is to go on its glass
     * @returns {VibrantSurface} with its class (scope), its type's polarity
     *   and its glass's shade as last worked out, update() and destroy()
     */
    surface(params) {
        this._surfaces.get(params.id)?.destroy();
        const surface = new VibrantSurface(this, params);
        this._surfaces.set(params.id, surface);
        this.queue();
        return surface;
    }

    /** @param {VibrantSurface} surface - gone */
    remove(surface) {
        if (this._surfaces.get(surface.id) !== surface)
            return;
        this._surfaces.delete(surface.id);
        this.queue();
    }

    /**
     * @param {string} id
     * @returns {VibrantSurface|null} the surface of that id
     */
    surfaceOf(id) {
        return this._surfaces.get(id) ?? null;
    }

    /** @returns {string|null} the stylesheet loaded (its file's name), for the tests */
    get stylesheet() {
        return this._stylesheet?.name ?? null;
    }

    /** Worked out anew in a moment (once for a burst of calls). */
    queue() {
        if (this._timeoutId || !this._stylesheet)
            return;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DELAY, () => {
            this._timeoutId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _followPalette() {
        this._palette?.disconnectObject(this);
        this._palette = this._modules.get('palette');
        this._palette?.connectObject('changed', () => this._load(), this);
    }

    // The wallpaper's sample anew (or none: no picture, or one that can't
    // be read).
    async _load() {
        const serial = ++this._serial;
        const style = this._background.get_string('picture-options');
        const path = style === 'none' ? null : wallpaperShown(this._background, this._interface);
        let sample = null;
        if (path) {
            try {
                sample = await samplePicture(path);
            } catch (e) {
                console.warn(`Atelier: what is behind the glass can't be told from ${path}: ${e.message}`);
            }
        }
        // (Superseded, or gone meanwhile.)
        if (serial !== this._serial || !this._stylesheet)
            return;
        this._sample = sample;
        this._blurred.clear();
        this.queue();
    }

    // The sample blurred as the glass blurs the wallpaper on a monitor –
    // the look's blur, as the GPU's shader has it (none for clear glass) –
    // kept for its sigma and size.
    _blurredFor(shown, look) {
        const sample = this._sample;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const sigma = Math.round((look?.blur ?? 0) * scale * sample.width / shown.width * 4) / 4;
        const key = `${sigma} ${sample.width}x${sample.height}`;
        let image = this._blurred.get(key);
        if (!image) {
            const pixels = sigma > 0 ? frost(sample.pixels, sample, {sigma, saturation: 1, lift: 0}) : null;
            image = pixels
                ? {pixels, channels: 3, rowstride: sample.width * 3, width: sample.width, height: sample.height}
                : sample;
            if (this._blurred.size >= BLURRED_KEPT)
                this._blurred.delete(this._blurred.keys().next().value);
            this._blurred.set(key, image);
        }
        return image;
    }

    // What is behind a rectangle of a monitor: the wallpaper there, as
    // blurred as the glass has it, and the background's colour where the
    // picture doesn't reach.
    _statsOf(rect, monitor, look) {
        const background = rgbToHex(parseColor(this._background.get_string('primary-color')));
        const sample = this._sample;
        if (!sample)
            return withBackground(null, 0, background);
        const size = [monitor.width, monitor.height];
        // (Tiled and spanned, as if zoomed: near enough.)
        const style = this._background.get_string('picture-options');
        const shown = placement(style, size, sample.picture) ?? placement('zoom', size, sample.picture);
        const on = pictureRegion(rect, shown);
        const stats = on ? regionStats(this._blurredFor(shown, look), on.region) : null;
        return withBackground(stats, on?.cover ?? 0, background);
    }

    // What is behind a surface: a colour it is given, or the wallpaper
    // where it rests; null: nowhere now.
    _behind(surface, look) {
        if (surface.behind) {
            const color = surface.behind();
            return color ? withBackground(null, 0, color) : null;
        }
        const rect = surface.rect();
        const monitor = rect?.width > 0 && rect.height > 0 ? this._monitorAt(rect) : null;
        if (!monitor)
            return null;
        return this._statsOf([rect.x - monitor.x, rect.y - monitor.y, rect.width, rect.height], monitor, look);
    }

    /**
     * What a window most likely is behind glass: the palette's surface, of
     * the style apps are in (Atelier tints libadwaita's surfaces with the
     * palette, lib/gtkCss.js) – light unless dark is preferred.
     *
     * @returns {string|null} '#rrggbb'
     */
    windowSurface() {
        const scheme = this._interface?.get_string('color-scheme') === 'prefer-dark' ? 'dark' : 'light';
        return this._currentPalette()?.[scheme]?.surface ?? (scheme === 'dark' ? '#242424' : '#fafafa');
    }

    _monitorAt({x, y, width, height}) {
        const [cx, cy] = [x + width / 2, y + height / 2];
        return Main.layoutManager.monitors.find(m => cx >= m.x && cx < m.x + m.width && cy >= m.y && cy < m.y + m.height) ??
            Main.layoutManager.primaryMonitor ?? null;
    }

    _currentPalette() {
        try {
            return JSON.parse(this._paletteSettings.get_string('current'));
        } catch {
            return null;
        }
    }

    // Every surface's type and its glass's shade worked out: the colours
    // into the stylesheet, the shades to the surfaces' owners.
    _sync() {
        if (!this._stylesheet)
            return;
        const variant = resolveVariant(this._settings.get_string('glass-variant'),
            {highContrast: this._a11y?.get_boolean('high-contrast') ?? false});
        const look = lookOf(variant);
        const palette = this._currentPalette();
        // (The polarity GNOME's style implies: light type in its dark style.)
        const light = this._interface.get_string('color-scheme') !== 'prefer-dark';
        const prefer = light ? 'dark' : 'light';
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // What each surface's type needs of its glass, by the glass as it
        // is (never as shaded: its shade isn't read back), those that are
        // one glass together.
        const glasses = new Map();
        for (const surface of this._surfaces.values()) {
            const was = surface.polarity;
            surface.polarity = null;
            surface.backdrop = null;
            surface.shade = NO_SHADE;
            // (Solid surfaces: their colours as set.)
            if (!look)
                continue;
            let stats = null;
            try {
                stats = this._behind(surface, look);
            } catch (e) {
                console.warn(`Atelier: what is behind the ${surface.id} can't be told: ${e.message}`);
            }
            if (!stats)
                continue;
            // (Its glass's face: a small control's, as large as it rests.)
            const rect = surface.rect();
            const small = rect?.width > 0 && rect.height > 0 ? smallness(Math.min(rect.width, rect.height) / scale) : 0;
            const options = {
                light, small, blur: surface.blur(), tint: surface.tint(), strength: surface.strength(),
                layers: surface.layers(),
            };
            const need = readingNeed(surface.inks, palette);
            const needed = Object.fromEntries(['light', 'dark'].map(polarity =>
                [polarity, shadeNeeded(stats, look, polarity, need, options)]));
            const glass = surface.oneWith() ?? surface.id;
            glasses.set(glass, [...glasses.get(glass) ?? [], {surface, stats, options, needed, was}]);
        }
        const rules = [];
        for (const parts of glasses.values()) {
            const needed = Object.fromEntries(['light', 'dark'].map(polarity =>
                [polarity, Math.max(...parts.map(part => part.needed[polarity]))]));
            // (As dark or light as it was where either would do about as
            // well, and the glass steadied: a stylesheet made anew
            // restyles the whole shell.)
            const polarity = polarityOf(needed, {prefer, was: parts.find(part => part.was)?.was ?? null});
            const shade = shadeOf(polarity, needed);
            for (const {surface, stats, options} of parts) {
                const backdrop = steadied(backdropOf(stats, look, {...options, shade}));
                rules.push(...surfaceRules({
                    roots: surface.roots, scope: surface.scope, inks: surface.inks, backdrop, polarity,
                }, palette));
                surface.backdrop = backdrop;
                surface.polarity = polarity;
                surface.shade = shade;
            }
        }
        this._stylesheet.set(vibrancyStylesheet(rules))
            .catch(e => console.warn(`Atelier: the colours of the type on glass are not loaded: ${e.message}`));
        // (Once all are worked out: a glass shaded as another's reads its.)
        for (const surface of [...this._surfaces.values()]) {
            try {
                surface.shaded();
            } catch (e) {
                console.error(`Atelier: the ${surface.id}'s glass isn't shaded`, e);
            }
        }
    }
}
