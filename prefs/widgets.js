// Small helpers shared by the preference pages.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ACCENT_COLORS} from '../lib/profiles.js';
import {ensureThumbnail, hasThumbnail, thumbnailPath} from '../lib/thumbnails.js';

Gio._promisify(Gtk.FileDialog.prototype, 'open', 'open_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'open_multiple', 'open_multiple_finish');

const swatchCss = Object.entries(ACCENT_COLORS)
    .map(([name, color]) => `.atelier-swatch.${name} { background: ${color}; }`)
    .join('\n');

const CSS = `
.atelier-thumb { border-radius: 8px; background-color: alpha(currentColor, 0.08); }
.atelier-preview { border-radius: 14px; background-color: alpha(currentColor, 0.08); }
.atelier-swatch {
  min-width: 32px; min-height: 32px; padding: 0;
  border-radius: 999px; color: white;
  box-shadow: inset 0 0 0 1px alpha(black, 0.12);
}
.atelier-swatch.neutral { background: alpha(currentColor, 0.1); color: inherit; }
.atelier-swatch:checked { outline: 2px solid @accent_color; outline-offset: 2px; }
.atelier-swatch image { -gtk-icon-size: 14px; }
${swatchCss}
`;

/**
 * Load the extension's CSS while the window is open.
 *
 * @param {Gtk.Window} window
 */
export function installCss(window) {
    const provider = new Gtk.CssProvider();
    provider.load_from_string(CSS);
    const display = Gdk.Display.get_default();
    Gtk.StyleContext.add_provider_for_display(display, provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    window.connect('close-request', () => {
        Gtk.StyleContext.remove_provider_for_display(display, provider);
        return false;
    });
}

/**
 * A rounded wallpaper thumbnail of a fixed width (16:10).
 *
 * @param {string|null} wallpaper
 * @param {number} width
 * @param {string} [cssClass]
 * @returns {{widget: Gtk.Widget, setWallpaper: Function}}
 */
export function createThumbnail(wallpaper, width, cssClass = 'atelier-thumb') {
    const picture = new Gtk.Picture({
        content_fit: Gtk.ContentFit.COVER,
        can_shrink: true,
        width_request: width,
        height_request: Math.round(width / 1.6),
        overflow: Gtk.Overflow.HIDDEN,
        css_classes: [cssClass],
    });
    // Gtk.Picture asks for the image's natural size; the clamp keeps it small.
    const widget = new Adw.Clamp({
        maximum_size: width,
        tightening_threshold: width,
        valign: Gtk.Align.CENTER,
        child: picture,
    });

    let current = null;
    const setWallpaper = path => {
        current = path;
        if (!path) {
            picture.set_paintable(null);
            return;
        }
        if (hasThumbnail(path)) {
            picture.set_filename(thumbnailPath(path));
            return;
        }
        picture.set_paintable(null);
        ensureThumbnail(path)
            .then(thumb => {
                if (current === path)
                    picture.set_filename(thumb);
            })
            .catch(e => console.warn(`Atelier: no thumbnail for ${path}: ${e.message}`));
    };
    setWallpaper(wallpaper);
    return {widget, setWallpaper};
}

/**
 * Ask the shell to apply a profile (with its transition).
 *
 * @param {Gio.Settings} settings
 * @param {string} id
 */
export function requestApply(settings, id) {
    settings.set_string('apply-request', JSON.stringify({id, nonce: GLib.uuid_string_random()}));
}

/**
 * @param {Gtk.Widget} widget - any widget inside the preferences window
 * @param {string} title
 */
export function toast(widget, title) {
    const window = widget.get_root();
    // Titles carry profile names and error messages: no markup.
    window?.add_toast?.(new Adw.Toast({title, timeout: 3, use_markup: false}));
}

/**
 * Show an image file chooser.
 *
 * @param {Gtk.Widget} parent
 * @param {boolean} multiple
 * @returns {Promise<string[]>} the chosen paths (empty when cancelled)
 */
export async function chooseImages(parent, multiple) {
    const filter = new Gtk.FileFilter({name: 'Images'});
    filter.add_mime_type('image/*');
    filter.add_suffix('xml');
    const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
    filters.append(filter);

    const dialog = new Gtk.FileDialog({
        title: multiple ? 'Add wallpapers' : 'Choose a wallpaper',
        filters,
        default_filter: filter,
        initial_folder: Gio.File.new_for_path(
            GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? GLib.get_home_dir()),
    });
    const root = parent.get_root();
    try {
        if (multiple) {
            const files = await dialog.open_multiple(root, null);
            const paths = [];
            for (let i = 0; i < files.get_n_items(); i++)
                paths.push(files.get_item(i).get_path());
            return paths.filter(Boolean);
        }
        const file = await dialog.open(root, null);
        return file?.get_path() ? [file.get_path()] : [];
    } catch (e) {
        if (e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) ||
            e.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED))
            return [];
        throw e;
    }
}
