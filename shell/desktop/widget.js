// A widget on the desktop: a card of one of the sizes, in the desktop's
// look, holding what its kind shows. Kinds fill it in build(), again
// whenever its size changes, and may do something when clicked.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {pixelSize} from '../../lib/widgets.js';

// What the card holds fills it; its corner buttons (while editing) sit in
// the top right corner. (Clutter's BinLayout would center them.)
const CardLayout = GObject.registerClass(
class AtelierWidgetCardLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        return [0, 0];
    }

    vfunc_allocate(container, box) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        for (const child of container.get_children()) {
            if (!child.inCorner) {
                child.allocate(box);
                continue;
            }
            const [, width] = child.get_preferred_width(-1);
            const [, height] = child.get_preferred_height(width);
            const inset = 8 * scale;
            const x = container.width - width - inset;
            child.allocate(new Clutter.ActorBox({x1: x, y1: inset, x2: x + width, y2: inset + height}));
        }
    }
});

export const DesktopWidget = GObject.registerClass({
    Signals: {
        'menu-request': {},
    },
}, class AtelierDesktopWidget extends St.Widget {
    /**
     * @param {object} entry - its place in the layout: {id, kind, size, x, y}
     * @param {object} context - what kinds read from: {settings, sources}
     */
    _init(entry, context) {
        super._init({
            style_class: `atelier-widget atelier-widget-${entry.kind}`,
            reactive: true,
            track_hover: true,
            layout_manager: new CardLayout(),
        });
        this.entry = entry;
        this._context = context;
        this._content = null;
        this.connect('destroy', () => this.cleanup());
        this.resize(entry.size);
    }

    /** @param {string} size - square, card, large or wide */
    resize(size) {
        for (const name of ['square', 'card', 'large', 'wide'])
            this.remove_style_class_name(`atelier-widget-${name}`);
        this.add_style_class_name(`atelier-widget-${size}`);
        this.entry = {...this.entry, size};
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [width, height] = pixelSize(size);
        this.set_size(width * scale, height * scale);
        this._content?.destroy();
        this._content = new St.BoxLayout({
            style_class: 'atelier-widget-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._content);
        this.build(this._content, size);
    }

    /**
     * Fill the card; called again with a fresh box when the size changes.
     *
     * @param {St.BoxLayout} _box
     * @param {string} _size
     */
    build(_box, _size) {}

    /** What a click does (open the app that has more, say). */
    activate() {}

    /** Let go of what it listens to; it is being destroyed. */
    cleanup() {}

    vfunc_button_release_event(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this.emit('menu-request');
            return Clutter.EVENT_STOP;
        }
        if (button === Clutter.BUTTON_PRIMARY && !this.editing) {
            this.activate();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
});

/**
 * @param {string} styleClass
 * @param {string} [text]
 * @param {object} [params]
 * @returns {St.Label}
 */
export function label(styleClass, text = '', params = {}) {
    return new St.Label({style_class: styleClass, text, ...params});
}

/**
 * Open an app by its desktop file id, if it is installed.
 *
 * @param {string[]} ids - the first one installed is opened
 * @returns {boolean} whether one was
 */
export function launchApp(...ids) {
    for (const id of ids) {
        const app = Gio.DesktopAppInfo.new(id);
        if (app) {
            app.launch([], global.create_app_launch_context(0, -1));
            return true;
        }
    }
    return false;
}

/** @param {string} uri - opened with its default app */
export function openUri(uri) {
    Gio.AppInfo.launch_default_for_uri_async(uri, global.create_app_launch_context(0, -1), null, null);
}
