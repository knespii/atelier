// Vibrancy in the shell (lib/vibrancy.js): Atelier's surfaces of glass –
// the island, the bar's sides, the docks, the widgets' cards – say where
// they rest and what lies over their glass, and their type and icons get
// the colours that read there, each surface in a class of its own, from
// one stylesheet. (Their glass is as it is – darkened as the glass-dim
// setting has all of it – whatever is behind.) Surfaces that are one glass
// – the bar's one island and the island at rest in it – take one polarity.
//
// What is behind a surface is the wallpaper as GNOME draws it on its
// monitor: sampled small once for each wallpaper (in GdkPixbuf's worker
// threads) and blurred as the glass blurs it, then made into the glass of
// the variant chosen, in GNOME's style, as a part as large as the surface
// and darkened as the glass-dim setting has it (lib/glassLook.js; none for
// 'off': solid surfaces keep their colours).
// All of it is worked out anew a moment after the
// wallpaper, the palette, the variant, the monitors, the theme or a
// surface's place change – never while something moves: a surface says
// where it rests, not where it is on its way. Live glass over windows (the
// island open) takes them to be the palette's surface in the style apps
// are in (windowSurface()) – or, for the control centre, what is on the
// screen under it as it opens: a picture of that part of the screen, taken
// once, small (sampleStage()), blurred as its glass blurs it. A surface
// that is frosted (lib/glassLook.js FROST) is blurred that much more. Where
// a surface's type turns light or dark while it shows, it can fade out
// first and back in after (its veil): no jump from one to the other.

import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {placement} from '../../lib/depth.js';
import {frost, parseColor} from '../../lib/glassBackdrop.js';
import {FROST, dimmedLook, lookOf, resolveVariant, smallness} from '../../lib/glassLook.js';
import {regionStats} from '../../lib/lockLook.js';
import {rgbToHex} from '../../lib/palette.js';
import {sampleWallpaper} from '../../lib/thumbnails.js';
import {
    backdropOf, pictureRegion, polarityOf, readingNeed, scopeOf, shortfallOf, steadied, surfaceRules,
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
// A picture of the screen behind a surface (sampleStage()): so many
// logical pixels to one of its pixels – it is blurred much more than that.
const STAGE_SAMPLE = 4;

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

/**
 * A picture of a part of the screen as it is drawn now (GNOME's screenshot
 * of it, made small as it is decoded – in threads, but the drawing): what
 * live glass shows there, before anything of the glass's own is over it.
 *
 * @param {object} rect - {x, y, width, height} on the stage
 * @returns {Promise<object|null>} {pixels, channels, rowstride, width,
 *   height, density: its pixels to a pixel of the stage, rect: the part of
 *   the stage it is of, {x, y, width, height}}; null: nothing there
 */
export async function sampleStage({x, y, width, height}) {
    const [x1, y1] = [Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y))];
    const x2 = Math.min(global.stage.width, Math.ceil(x + width));
    const y2 = Math.min(global.stage.height, Math.ceil(y + height));
    if (x2 - x1 < 2 || y2 - y1 < 2)
        return null;
    const stream = Gio.MemoryOutputStream.new_resizable();
    await new Promise((resolve, reject) => {
        new Shell.Screenshot().screenshot_area(x1, y1, x2 - x1, y2 - y1, stream, (shot, res) => {
            try {
                shot.screenshot_area_finish(res);
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });
    stream.close(null);
    const input = Gio.MemoryInputStream.new_from_bytes(stream.steal_as_bytes());
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const side = Math.max(8, Math.ceil(Math.max(x2 - x1, y2 - y1) / (STAGE_SAMPLE * scale)));
    const pixbuf = await new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(input, side, side, true, null, (_, res) => {
            try {
                resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
    return {
        pixels: pixbuf.get_pixels(),
        channels: pixbuf.get_n_channels(),
        rowstride: pixbuf.get_rowstride(),
        width: pixbuf.get_width(),
        height: pixbuf.get_height(),
        density: pixbuf.get_width() / (x2 - x1),
        rect: {x: x1, y: y1, width: x2 - x1, height: y2 - y1},
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
        id, inks, roots, rect = () => null, behind = null, picture = () => null, region = () => null,
        frosted = () => false, small = null, strength = () => 1, layers = () => [], oneWith = () => null,
        worked = null, veil = null,
    }) {
        this._vibrancy = vibrancy;
        this.id = id;
        this.inks = inks;
        this.roots = roots;
        this.rect = rect;
        this.behind = behind;
        this.picture = picture;
        this.region = region;
        this.small = small;
        this.frosted = frosted;
        this.veil = veil;
        this.strength = strength;
        this.layers = layers;
        this.oneWith = oneWith;
        this.worked = worked;
        /** the class its type's colours are in */
        this.scope = scopeOf(id);
        /** 'light' or 'dark' type, as last worked out (null: as set) */
        this.polarity = null;
        /** what its glass comes out as, as last worked out (lib/vibrancy.js backdropOf()) */
        this.backdrop = null;
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

// How much the glass blurs what is behind it, sigma in logical pixels: its
// look's, and its frost's on top (blurs one after the other add up so).
function blurOf(look, frosted) {
    const blur = look?.blur ?? 0;
    return frosted && look ? Math.hypot(blur, FROST.sigma) : blur;
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
        // The sample blurred, by its sigma and size; a picture of the
        // screen, by its sigma.
        this._blurred = new Map();
        this._blurredPictures = new WeakMap();
        this._serial = 0;
        this._applied = 0;
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
        this._settings.connectObject(
            'changed::glass-variant', () => this.queue(),
            'changed::glass-dim', () => this.queue(),
            this);
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
     *   '#rrggbb', instead of the wallpaper where it rests (null: the
     *   wallpaper, where it has a rect)
     * @param {Function} [params.picture] - () => what is behind it, a
     *   picture of the screen there (sampleStage()), instead of either;
     *   null: none (yet), the colour or the wallpaper then
     * @param {Function} [params.region] - () => the part of the picture
     *   behind it, [x, y, width, height] 0 … 1 (null: all of it); the
     *   picture is blurred whole, what is round it blurred in as the
     *   glass blurs it
     * @param {Function} [params.small] - () => how much a small control its
     *   glass is (lib/glassLook.js smallness()), where its rect doesn't say
     *   (a strip of type on a larger glass)
     * @param {Function} [params.frosted] - () => its glass is frosted
     *   (lib/glassLook.js FROST): what is behind blurred that much more
     * @param {Function} [params.strength] - () => how much of its glass
     *   shows, 0 … 1 (fading, it lets the wallpaper through)
     * @param {Function} [params.layers] - () => what lies over its glass,
     *   [{color, alpha}] (layersOf(): a card's colour, a wash)
     * @param {Function} [params.oneWith] - () => the id of the surface its
     *   glass is one with (the island at rest in the bar's one island), or
     *   null: one polarity for both, the one that reads on both best
     * @param {Function} [params.worked] - () => called once its type is
     *   worked out anew (the palette, GNOME's style… changed): what
     *   follows them besides its type follows too
     * @param {object} [params.veil] - while its type turns light or dark:
     *   hide() fades what shows it out (a promise, kept once it has, at
     *   once where nothing shows), show() back in once it has turned
     * @returns {VibrantSurface} with its class (scope) and its type's
     *   polarity as last worked out, update() and destroy()
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

    /** Worked out anew now (what is behind a surface has just been seen). */
    refresh() {
        if (!this._stylesheet)
            return;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._sync();
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
    _blurredFor(shown, look, frosted = false) {
        const sample = this._sample;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const sigma = Math.round(blurOf(look, frosted) * scale * sample.width / shown.width * 4) / 4;
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
    _statsOf(rect, monitor, look, frosted = false) {
        const background = rgbToHex(parseColor(this._background.get_string('primary-color')));
        const sample = this._sample;
        if (!sample)
            return withBackground(null, 0, background);
        const size = [monitor.width, monitor.height];
        // (Tiled and spanned, as if zoomed: near enough.)
        const style = this._background.get_string('picture-options');
        const shown = placement(style, size, sample.picture) ?? placement('zoom', size, sample.picture);
        const on = pictureRegion(rect, shown);
        const stats = on ? regionStats(this._blurredFor(shown, look, frosted), on.region) : null;
        return withBackground(stats, on?.cover ?? 0, background);
    }

    // What is behind a surface: a picture of the screen there, a colour it
    // is given, or the wallpaper where it rests; null: nowhere now.
    _behind(surface, look) {
        const picture = surface.picture();
        if (picture) {
            return regionStats(this._blurredPicture(picture, look, surface.frosted()),
                surface.region() ?? [0, 0, 1, 1]);
        }
        const color = surface.behind?.();
        if (color)
            return withBackground(null, 0, color);
        const rect = surface.rect();
        const monitor = rect?.width > 0 && rect.height > 0 ? this._monitorAt(rect) : null;
        if (!monitor)
            return null;
        return this._statsOf([rect.x - monitor.x, rect.y - monitor.y, rect.width, rect.height], monitor, look,
            surface.frosted());
    }

    // A picture of the screen blurred as the glass blurs it (and its frost),
    // kept with it for each blur.
    _blurredPicture(picture, look, frosted) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const sigma = Math.round(blurOf(look, frosted) * scale * picture.density * 4) / 4;
        let kept = this._blurredPictures.get(picture);
        if (!kept) {
            kept = new Map();
            this._blurredPictures.set(picture, kept);
        }
        let image = kept.get(sigma);
        if (!image) {
            const pixels = sigma > 0 ? frost(picture.pixels, picture, {sigma, saturation: 1, lift: 0}) : null;
            image = pixels
                ? {pixels, channels: 3, rowstride: picture.width * 3, width: picture.width, height: picture.height}
                : picture;
            kept.set(sigma, image);
        }
        return image;
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

    // The stylesheet loaded; what shows type that turns light or dark faded
    // out first, and back in after.
    async _apply(css, veils) {
        const stylesheet = this._stylesheet;
        const serial = ++this._applied;
        try {
            await Promise.all(veils.map(veil => veil.hide()));
        } finally {
            try {
                // (Not once another has come meanwhile.)
                if (this._stylesheet === stylesheet && serial === this._applied)
                    await stylesheet.set(css);
            } finally {
                veils.forEach(veil => veil.show());
            }
        }
    }

    // Every surface's type worked out: the colours into the stylesheet.
    _sync() {
        if (!this._stylesheet)
            return;
        const variant = resolveVariant(this._settings.get_string('glass-variant'),
            {highContrast: this._a11y?.get_boolean('high-contrast') ?? false});
        const look = dimmedLook(lookOf(variant), this._settings.get_double('glass-dim'));
        const palette = this._currentPalette();
        // (The polarity GNOME's style implies: light type in its dark style.)
        const light = this._interface.get_string('color-scheme') !== 'prefer-dark';
        const prefer = light ? 'dark' : 'light';
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // What each surface's glass comes out as, and how far type of
        // either polarity falls short of reading there, those that are one
        // glass together.
        const glasses = new Map();
        for (const surface of this._surfaces.values()) {
            const was = surface.polarity;
            surface.polarity = null;
            surface.backdrop = null;
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
            let small = rect?.width > 0 && rect.height > 0 ? smallness(Math.min(rect.width, rect.height) / scale) : 0;
            small = surface.small?.() ?? small;
            const backdrop = steadied(backdropOf(stats, look, {
                light, small, strength: surface.strength(), layers: surface.layers(),
            }));
            const need = readingNeed(surface.inks, palette);
            const short = Object.fromEntries(['light', 'dark'].map(polarity =>
                [polarity, shortfallOf(backdrop, polarity, need)]));
            const glass = surface.oneWith() ?? surface.id;
            glasses.set(glass, [...glasses.get(glass) ?? [], {surface, backdrop, short, was}]);
        }
        const rules = [];
        const turning = [];
        for (const parts of glasses.values()) {
            const short = Object.fromEntries(['light', 'dark'].map(polarity =>
                [polarity, Math.max(...parts.map(part => part.short[polarity]))]));
            // (As dark or light as it was where either would do about as
            // well, and the glass steadied: a stylesheet made anew
            // restyles the whole shell.)
            const polarity = polarityOf(short, {prefer, was: parts.find(part => part.was)?.was ?? null});
            for (const {surface, backdrop, was} of parts) {
                rules.push(...surfaceRules({
                    roots: surface.roots, scope: surface.scope, inks: surface.inks, backdrop, polarity,
                }, palette));
                surface.backdrop = backdrop;
                surface.polarity = polarity;
                if (surface.veil && was && was !== polarity)
                    turning.push(surface.veil);
            }
        }
        this._apply(vibrancyStylesheet(rules), turning)
            .catch(e => console.warn(`Atelier: the colours of the type on glass are not loaded: ${e.message}`));
        for (const surface of [...this._surfaces.values()]) {
            try {
                surface.worked?.();
            } catch (e) {
                console.warn(`Atelier: the ${surface.id} doesn't follow its type: ${e.message}`);
            }
        }
    }
}
