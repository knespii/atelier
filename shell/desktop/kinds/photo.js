// A photo: the picture chosen in Atelier's settings, or, for a folder, one
// of its pictures – a different one every hour.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {ensurePictureCopy} from '../../../lib/thumbnails.js';
import {pixelSize} from '../../../lib/widgets.js';
import {DesktopWidget, label, openUri} from '../widget.js';

const PICTURES = /\.(jpe?g|png|webp|gif|svg|tiff?|bmp|jxl|avif|heic)$/i;
const HOUR = 3600;

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

export const PhotoWidget = GObject.registerClass(
class AtelierPhotoWidget extends DesktopWidget {
    build(box) {
        if (!this._listening) {
            this._listening = true;
            this._context.settings.connectObject('changed::photo', () => this._sync(), this);
            this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, HOUR, () => {
                this._sync();
                return GLib.SOURCE_CONTINUE;
            });
        }
        this._picture = new St.Widget({style_class: 'atelier-widget-picture', x_expand: true, y_expand: true});
        this._picture.connect('resource-scale-changed', () => this._showPicture());
        box.add_child(this._picture);
        this._message = label('atelier-widget-placeholder', 'Choose a photo or a folder in Atelier\'s settings, under Desktop.', {
            x_expand: true,
            y_expand: true,
        });
        this._message.clutter_text.line_wrap = true;
        box.add_child(this._message);
        this._sync();
    }

    _sync() {
        if (!this._picture)
            return;
        this._path = pictureFor(this._context.settings.get_string('photo'));
        this._picture.visible = Boolean(this._path);
        this._message.visible = !this._path;
        if (this._path)
            this.add_style_pseudo_class('picture');
        else
            this.remove_style_pseudo_class('picture');
        this._showPicture();
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
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor * picture.get_resource_scale();
        const [width, height] = pixelSize(this.entry.size).map(length => Math.ceil(length * scale));
        ensurePictureCopy(path, width, height).then(copy => {
            // (Unless another photo or size came meanwhile.)
            if (picture === this._picture && path === this._path)
                picture.style = `background-image: url("${Gio.File.new_for_path(copy).get_uri()}");`;
        }).catch(e => console.warn(`Atelier: no picture of ${path}: ${e.message}`));
    }

    activate() {
        if (this._path)
            openUri(Gio.File.new_for_path(this._path).get_uri());
        else
            this._context.openSettings('desktop');
    }

    cleanup() {
        this._context.settings.disconnectObject(this);
        if (this._timeout)
            GLib.source_remove(this._timeout);
        this._timeout = 0;
        this._picture = null;
    }
});
