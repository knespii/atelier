// A short note in the island, e.g. which profile was just switched to.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {isSlideshow} from '../../lib/paths.js';
import {ensureThumbnail, hasThumbnail, thumbnailPath} from '../../lib/thumbnails.js';
import {cssUrl} from '../switcherContent.js';
import {IslandPage} from './page.js';

const TOAST_TIME = 2200;

export const ToastPage = GObject.registerClass(
class AtelierToast extends IslandPage {
    /**
     * @param {object} params
     * @param {string} params.title
     * @param {string} params.subtitle - small line above the title
     * @param {string|null} [params.wallpaper] - shown as a thumbnail
     */
    _init({title, subtitle, wallpaper = null}) {
        super._init({style_class: 'atelier-toast'});

        this._thumb = new St.Bin({
            style_class: 'atelier-toast-thumb',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'preferences-desktop-wallpaper-symbolic'}),
        });
        this.add_child(this._thumb);

        const text = new St.BoxLayout({
            style_class: 'atelier-toast-text',
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        text.add_child(new St.Label({style_class: 'atelier-toast-subtitle', text: subtitle}));
        this._title = new St.Label({style_class: 'atelier-toast-title', text: title});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._title);
        this.add_child(text);

        this.add_child(new St.Icon({
            style_class: 'atelier-toast-check',
            icon_name: 'object-select-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        if (wallpaper && !isSlideshow(wallpaper)) {
            if (hasThumbnail(wallpaper))
                this._showThumbnail(thumbnailPath(wallpaper));
            else
                ensureThumbnail(wallpaper).then(path => this._showThumbnail(path)).catch(() => {});
        }

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOAST_TIME, () => {
            this._timeoutId = 0;
            this.close();
            return GLib.SOURCE_REMOVE;
        });
        this.connect('destroy', () => {
            this._destroyed = true;
            if (this._timeoutId)
                GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        });
    }

    /** @returns {string} */
    get title() {
        return this._title.text;
    }

    _showThumbnail(path) {
        if (this._destroyed)
            return;
        this._thumb.child = null;
        this._thumb.style = `background-image: url("${cssUrl(path)}");`;
    }
});
