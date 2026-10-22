// A photo: those picked for it from Atelier's gallery (in its menu, Choose
// Photos…), one after another – each for a while, the next spreading over
// it out of a drop – but only while it can be seen: not under the windows,
// in the overview, on a blank or dimmed screen, nor while the widgets are
// edited or flowing. Its time doesn't run meanwhile (nor does anything
// else of it); back in sight, it goes on. Without a choice, the picture
// chosen in Atelier's settings, or, for a folder, one of its pictures – a
// different one every hour.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {spread} from '../../../lib/liquid.js';
import {cleanSelection, intervalOf, nextIndex, timeLeft} from '../../../lib/photos.js';
import {ensurePictureCopy} from '../../../lib/thumbnails.js';
import {pixelSize} from '../../../lib/widgets.js';
import {LiquidMaskEffect} from '../../core/liquid.js';
import {SteadyTimeline} from '../../core/steadyTimeline.js';
import {DesktopWidget, label, openUri} from '../widget.js';

const PICTURES = /\.(jpe?g|png|webp|gif|svg|tiff?|bmp|jxl|avif|heic)$/i;
const HOUR = 3600;
// How long the next photo takes to spread over the one before, ms.
const SPREAD_TIME = 1100;
// Corners of the card, logical pixels (as in the stylesheet).
const RADIUS = 22;
// Waiting for the next photo to be drawn once (under its mask: nothing of
// it shows) before it spreads, at most this long, ms.
const DECODE_WAIT = 500;

/**
 * @param {string} path - a picture or a folder of them
 * @returns {string|null} the picture to show now
 */
function pictureFor(path) {
    if (!path)
        return null;
    const file = Gio.File.new_for_path(path);
    let type;
    try {
        type = file.query_file_type(Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return null;
    }
    if (type === Gio.FileType.REGULAR)
        return path;
    if (type !== Gio.FileType.DIRECTORY)
        return null;
    const names = [];
    try {
        const children = file.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        for (let info; (info = children.next_file(null));) {
            if (info.get_file_type() === Gio.FileType.REGULAR && PICTURES.test(info.get_name()))
                names.push(info.get_name());
        }
    } catch {
        return null;
    }
    if (names.length === 0)
        return null;
    names.sort();
    return GLib.build_filenamev([path, names[Math.floor(Date.now() / 1000 / HOUR) % names.length]]);
}

const pictureStyle = path => `background-image: url("${Gio.File.new_for_path(path).get_uri()}");`;

export const PhotoWidget = GObject.registerClass(
class AtelierPhotoWidget extends DesktopWidget {
    build(box) {
        if (!this._listening) {
            this._listening = true;
            // The photo it shows, and how long it has been in sight.
            this._current = null;
            this._seen = 0;
            this._since = 0;
            this._turnId = 0;
            this._spreading = null;
            this._context.settings.connectObject('changed::photo', () => this._sync(), this);
            this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, HOUR, () => {
                if (this._chosen().length === 0)
                    this._sync();
                return GLib.SOURCE_CONTINUE;
            });
            this._galleryId = this._context.gallery?.connect(() => this._sync()) ?? 0;
            this._context.sight?.connectObject('changed', () => this._syncTurns(), this);
            this.connect('notify::mapped', () => this._syncTurns());
        }
        // (Built anew: a photo spreading is there at once. What showed it
        // is gone already.)
        this._picture = this._incoming = null;
        this._stopSpreading();
        // The photo, and the next one over it as it spreads.
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._picture = new St.Widget({style_class: 'atelier-widget-picture', x_expand: true, y_expand: true});
        this._picture.connect('resource-scale-changed', () => this._showPicture());
        stack.add_child(this._picture);
        this._incoming = new St.Widget({style_class: 'atelier-widget-picture', x_expand: true, y_expand: true, visible: false});
        this._mask = new LiquidMaskEffect();
        this._mask.enabled = false;
        this._incoming.add_effect(this._mask);
        stack.add_child(this._incoming);
        box.add_child(stack);
        this._stack = stack;
        this._message = label('atelier-widget-placeholder', 'Click to choose its photos.', {
            x_expand: true,
            y_expand: true,
        });
        this._message.clutter_text.line_wrap = true;
        box.add_child(this._message);
        this._sync();
    }

    /** @param {boolean} editing - being edited, it doesn't take turns */
    set editing(editing) {
        this._editing = editing;
        this._syncTurns();
    }

    get editing() {
        return this._editing ?? false;
    }

    /** @param {boolean} melted - flowing as liquid, it doesn't take turns */
    set melted(melted) {
        this._melted = melted;
        this._syncTurns();
    }

    get melted() {
        return this._melted ?? false;
    }

    /** @returns {string[]} the photos picked for it that the gallery has */
    _chosen() {
        const gallery = this._context.gallery;
        return gallery ? cleanSelection(this.entry.photos, gallery.ids()) : [];
    }

    _sync() {
        if (!this._picture)
            return;
        const chosen = this._chosen();
        if (chosen.length > 0) {
            // (The one it showed, as long as it is still picked.)
            if (!chosen.includes(this._current)) {
                this._current = chosen[0];
                this._seen = 0;
            }
            this._path = this._context.gallery.path(this._current);
        } else {
            this._current = null;
            this._path = pictureFor(this._context.settings.get_string('photo'));
        }
        this._stack.visible = Boolean(this._path);
        this._message.visible = !this._path;
        if (this._path)
            this.add_style_pseudo_class('picture');
        else
            this.remove_style_pseudo_class('picture');
        this._showPicture();
        this._syncTurns();
    }

    /** @returns {number[]} [width, height]: pixels of its copies */
    _copySize() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor * this._picture.get_resource_scale();
        return pixelSize(this.entry.size).map(length => Math.ceil(length * scale));
    }

    // A copy as big as the card is on screen, made aside: the photo itself
    // may be many times larger, and St would decode it whole on the main
    // thread and keep it for the rest of the session.
    _showPicture() {
        const picture = this._picture;
        const path = this._path;
        if (!picture)
            return;
        if (!path) {
            picture.style = '';
            return;
        }
        ensurePictureCopy(path, ...this._copySize()).then(copy => {
            // (Unless another photo or size came meanwhile.)
            if (picture === this._picture && path === this._path && !this._spreading)
                picture.style = pictureStyle(copy);
        }).catch(e => console.warn(`Atelier: no picture of ${path}: ${e.message}`));
    }

    /** @returns {boolean} whether it can be seen now */
    _inSight() {
        const sight = this._context.sight;
        return Boolean(sight) && this.mapped && this._stack?.mapped && !this.editing && !this.melted &&
            sight.desktopShown && !sight.covered(this);
    }

    // Its time runs only while it is in sight (and has photos to take
    // turns with); the windows are watched meanwhile, and while it waits
    // for them to leave some of it to see.
    _syncTurns() {
        const sight = this._context.sight;
        const turning = this._chosen().length > 1 && Boolean(this._picture);
        sight?.watchWindows(this, turning);
        const seen = turning && !this._spreading && this._inSight();
        if (seen && !this._turnId) {
            this._since = GLib.get_monotonic_time();
            const left = timeLeft(intervalOf(this.entry) * 1000, this._seen);
            this._turnId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(left), () => {
                this._turnId = 0;
                this._turn();
                return GLib.SOURCE_REMOVE;
            });
        } else if (!seen && this._turnId) {
            this._pause();
        }
        if (!turning)
            this._seen = 0;
    }

    _pause() {
        GLib.source_remove(this._turnId);
        this._turnId = 0;
        this._seen += (GLib.get_monotonic_time() - this._since) / 1000;
    }

    // The next photo: its copy made (aside), it spreads over this one.
    _turn() {
        this._seen = 0;
        // (Out of sight since, unnoticed: its full time once it is back.)
        if (!this._inSight()) {
            this._syncTurns();
            return;
        }
        const chosen = this._chosen();
        const next = chosen[nextIndex(chosen, this._current)];
        const path = this._context.gallery.path(next);
        const picture = this._picture;
        this._spreading = {path};
        ensurePictureCopy(path, ...this._copySize()).then(copy => {
            if (picture !== this._picture || this._spreading?.path !== path)
                return;
            this._current = next;
            this._path = path;
            this._spreadIn(copy);
            // (The one after it is made aside now, for its turn.)
            const after = chosen[nextIndex(chosen, next)];
            if (after && after !== next)
                ensurePictureCopy(this._context.gallery.path(after), ...this._copySize()).catch(() => {});
        }).catch(e => {
            console.warn(`Atelier: no picture of ${path}: ${e.message}`);
            if (picture === this._picture && this._spreading?.path === path) {
                this._spreading = null;
                this._current = next;
                this._syncTurns();
            }
        });
    }

    // The next photo spreads out of a drop in the middle, over the one
    // before. It is drawn once first, with nothing of it showing: St reads
    // the picture as it is first drawn, which then doesn't hold up the
    // spreading. (Out of sight by now, or without animations, it is there at once.)
    _spreadIn(copy) {
        const style = pictureStyle(copy);
        const duration = adjustAnimationTime(SPREAD_TIME);
        if (duration <= 0 || !this._inSight()) {
            this._picture.style = style;
            this._spreadDone();
            return;
        }
        const incoming = this._incoming;
        const mask = this._mask;
        mask.setShapes({});
        mask.enabled = true;
        incoming.style = style;
        incoming.show();
        const spreading = this._spreading;
        const start = () => {
            if (spreading !== this._spreading || spreading.timeline)
                return;
            global.stage.disconnect(spreading.paintId);
            GLib.source_remove(spreading.waitId);
            spreading.paintId = spreading.waitId = 0;
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            spreading.timeline = new SteadyTimeline(incoming, duration, {
                onFrame: t => mask.setShapes(spread([0, 0, incoming.width, incoming.height], t, {radius: RADIUS * scale})),
                onCompleted: () => {
                    this._picture.style = style;
                    this._stopSpreading();
                    this._spreadDone();
                },
            });
            spreading.timeline.start();
        };
        spreading.paintId = global.stage.connect('after-paint', start);
        spreading.waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DECODE_WAIT, () => {
            spreading.waitId = 0;
            start();
            return GLib.SOURCE_REMOVE;
        });
    }

    _spreadDone() {
        this._spreading = null;
        this._seen = 0;
        this._syncTurns();
    }

    // The next photo, if one is spreading, gone; the one under it stays.
    _stopSpreading() {
        const spreading = this._spreading;
        this._spreading = null;
        if (!spreading)
            return;
        spreading.timeline?.stop();
        if (spreading.paintId)
            global.stage.disconnect(spreading.paintId);
        if (spreading.waitId)
            GLib.source_remove(spreading.waitId);
        if (this._incoming) {
            this._incoming.hide();
            this._incoming.style = '';
            this._mask.enabled = false;
        }
    }

    activate() {
        if (this._path)
            openUri(Gio.File.new_for_path(this._path).get_uri());
        else if (this._context.choosePhotos)
            this._context.choosePhotos(this.entry.id);
        else
            this._context.openSettings('desktop');
    }

    cleanup() {
        this._stopSpreading();
        if (this._turnId)
            GLib.source_remove(this._turnId);
        this._turnId = 0;
        this._context.sight?.watchWindows(this, false);
        this._context.sight?.disconnectObject(this);
        if (this._galleryId)
            this._context.gallery.disconnect(this._galleryId);
        this._galleryId = 0;
        this._context.settings.disconnectObject(this);
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
        this._picture = null;
        this._incoming = null;
    }
});
