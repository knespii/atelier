// The depth effect on the lock screen (and the editor's mock one): the
// cutout of the wallpaper (lib/depth.js), made in the session, laid exactly
// over the wallpaper as GNOME draws it – over the clocks, under everything
// else. Only a cutout that is there shows: nothing here makes one, nor
// launches anything. It goes as the prompt comes up and the wallpaper blurs,
// and stays off over a clock the subject would cover too much of.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {
    MAX_COVER, MAX_COVER_GLASS, coverage, cutoutOpacity, cutoutPath, lockWallpaper, pictureState, placement, subjectTop,
} from '../../lib/depth.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const SAMPLE_WIDTH = 480; // the cutout's subject, looked at this small, pixels

function pixbufOf(stream, cancellable) {
    return new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.new_from_stream_async(stream, cancellable, (_, res) => {
            try {
                resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function fileInfoOf(path, cancellable) {
    return new Promise((resolve, reject) => {
        GdkPixbuf.Pixbuf.get_file_info_async(path, cancellable, (_, res) => {
            try {
                const [, width, height] = GdkPixbuf.Pixbuf.get_file_info_finish(res);
                resolve([width, height]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export class DepthCutout {
    constructor() {
        this.actor = new St.Widget({style_class: 'atelier-lock-depth', reactive: false, visible: false});
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._cancellable = null;
        this._monitor = null;
        this._picture = null; // [width, height] as GNOME places it
        this._sample = null;
        this._shown = null;
        this._clocks = [];
        this._progress = 0;
        /** Whether the subject would cover a clock too much (and so stays off). */
        this.tooMuch = false;
        /** Called when the cutout comes, goes or moves (the glass clock follows it). */
        this.onChanged = null;
        this.actor.connect('destroy', () => {
            this._cancellable?.cancel();
            this.actor = null;
        });
        this._background.connectObject('changed', () => this._load(), this);
        this._interface.connectObject('changed::color-scheme', () => this._load(), this);
    }

    /** @returns {boolean} whether a cutout is there to show */
    get loaded() {
        return Boolean(this._sample);
    }

    /** @returns {object|null} {x, y, width, height} where it is drawn, on the monitor */
    get shown() {
        return this._shown;
    }

    /** @param {number[]} monitor - [width, height] of the main monitor, pixels */
    setMonitor(monitor) {
        if (this._monitor?.[0] === monitor[0] && this._monitor?.[1] === monitor[1])
            return;
        this._monitor = monitor;
        this._load();
    }

    // The cutout of the wallpaper on screen now, if one was made.
    async _load() {
        this._cancellable?.cancel();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._clear();
        const path = lockWallpaper(this._background, this._interface);
        const picture = path && this._monitor ? pictureState(path) : null;
        const cutout = picture ? cutoutPath(picture, this._monitor) : null;
        if (!cutout || !GLib.file_test(cutout, GLib.FileTest.EXISTS))
            return;
        try {
            const stream = await Gio.File.new_for_path(cutout).read_async(GLib.PRIORITY_LOW, cancellable);
            let pixbuf;
            try {
                pixbuf = await pixbufOf(stream, cancellable);
            } finally {
                stream.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
            }
            const size = await this._pictureSize(pixbuf, path, cancellable);
            if (cancellable.is_cancelled() || !this.actor || !pixbuf.get_has_alpha())
                return;
            this._show(pixbuf, size);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`Atelier: the depth effect's cutout can't be read: ${e.message}`);
        }
    }

    // The wallpaper's own size, as the worker wrote it in the cutout; or
    // read from the wallpaper (turned, if the cutout is).
    async _pictureSize(pixbuf, path, cancellable) {
        const [width, height] = ['width', 'height'].map(side => Number(pixbuf.get_option(`tEXt::atelier-${side}`)));
        if (width > 0 && height > 0)
            return [width, height];
        const [w, h] = await fileInfoOf(path, cancellable);
        const turned = (w > h) !== (pixbuf.get_width() > pixbuf.get_height());
        return turned ? [h, w] : [w, h];
    }

    _show(pixbuf, picture) {
        const [width, height] = [pixbuf.get_width(), pixbuf.get_height()];
        const content = St.ImageContent.new_with_preferred_size(width, height);
        const context = global.stage.context.get_backend().get_cogl_context();
        content.set_bytes(context, pixbuf.read_pixel_bytes(), Cogl.PixelFormat.RGBA_8888,
            width, height, pixbuf.get_rowstride());
        this.actor.set_content(content);
        // (The subject, small, to tell how much of a clock it covers.)
        const scale = Math.min(1, SAMPLE_WIDTH / width);
        const sample = pixbuf.scale_simple(Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale)), GdkPixbuf.InterpType.BILINEAR);
        this._sample = {
            pixels: sample.get_pixels(),
            width: sample.get_width(),
            height: sample.get_height(),
            rowstride: sample.get_rowstride(),
        };
        this._picture = picture;
        this._place();
    }

    _clear() {
        const had = Boolean(this._shown);
        this._sample = null;
        this._picture = null;
        this._shown = null;
        this.actor?.set_content(null);
        this._sync();
        if (had)
            this.onChanged?.();
    }

    _place() {
        const style = this._background.get_string('picture-options');
        this._shown = this._picture && this._monitor ? placement(style, this._monitor, this._picture) : null;
        if (this._shown) {
            const {x, y, width, height} = this._shown;
            this.actor.set_position(x, y);
            this.actor.set_size(width, height);
        }
        this.cover(this._clocks);
        this.onChanged?.();
    }

    /**
     * @param {object} strip - {x, width, from, to} on the monitor (see
     *   lib/depth.js subjectTop())
     * @param {number} [share] - of the strip's width the subject has to
     *   stand across (see there)
     * @returns {number|null} where what stands in front starts in it; null
     *   without a cutout, or nothing there
     */
    subjectTop(strip, share = undefined) {
        return this._shown && this._sample ? subjectTop(this._sample, this._shown, strip, share) : null;
    }

    /**
     * Where the clocks are: the effect is off when the subject would cover
     * too much of one (see MAX_COVER), and without any.
     *
     * @param {object[]} clocks - {x, y, width, height} on the monitor
     */
    cover(clocks) {
        this._clocks = clocks;
        this.tooMuch = Boolean(this._shown) &&
            clocks.some(rect => coverage(this._sample, this._shown, rect) > (rect.glass ? MAX_COVER_GLASS : MAX_COVER));
        this._sync();
    }

    /** @param {number} progress - from the clock (0) to the prompt (1) */
    follow(progress) {
        this._progress = progress;
        this._sync();
    }

    /**
     * Darkened, as what is under it is (in the editor).
     *
     * @param {number} amount - 0 … 1, how much of its light goes
     */
    dim(amount) {
        if (!this.actor)
            return;
        let effect = this.actor.get_effect('dim');
        if (!effect && amount > 0) {
            effect = new Clutter.BrightnessContrastEffect();
            this.actor.add_effect_with_name('dim', effect);
        }
        effect?.set_brightness(-amount);
        if (effect)
            effect.enabled = amount > 0;
    }

    _sync() {
        if (!this.actor)
            return;
        const opacity = Math.round(255 * cutoutOpacity(this._progress));
        this.actor.opacity = opacity;
        this.actor.visible = Boolean(this._shown) && this._clocks.length > 0 && !this.tooMuch && opacity > 0;
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.keepActor] - it goes with what holds it (the
     *   lock screen sliding away once unlocked)
     */
    destroy({keepActor = false} = {}) {
        this._cancellable?.cancel();
        this._cancellable = null;
        this.onChanged = null;
        this._background.disconnectObject(this);
        this._interface.disconnectObject(this);
        if (!keepActor)
            this.actor?.destroy();
    }
}
