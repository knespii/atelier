// A widget on the desktop: a card of one of the sizes, in the desktop's
// look, holding what its kind shows. Kinds fill it in build(), again
// whenever its size changes, and may do something when clicked.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {KINDS, SIZES, namedSize, pixelSize} from '../../lib/widgets.js';

// What the card holds fills it; while editing, its buttons sit in the top
// right corner and the handle to stretch it on the bottom right one, a
// little past the card. (Clutter's BinLayout would center them.)
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
            if (!child.corner) {
                child.allocate(box);
                continue;
            }
            const [, width] = child.get_preferred_width(-1);
            const [, height] = child.get_preferred_height(width);
            if (child.corner === 'bottom-right') {
                const x = container.width - width + child.overhang * scale;
                const y = container.height - height + child.overhang * scale;
                child.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + width, y2: y + height}));
                continue;
            }
            const inset = 8 * scale;
            const x = container.width - width - inset;
            child.allocate(new Clutter.ActorBox({x1: x, y1: inset, x2: x + width, y2: inset + height}));
        }
    }
});

export const DesktopWidget = GObject.registerClass({
    Properties: {
        // Its corner dragged in the editor (and easing to the size it takes
        // once let go of): what it shows is cut off at its edges, and what
        // is drawn of it may be drawn quickly meanwhile.
        'stretching': GObject.ParamSpec.boolean('stretching', null, null, GObject.ParamFlags.READWRITE, false),
    },
    Signals: {
        'menu-request': {},
        // (Filled anew: for a size, say.)
        'filled': {},
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
        this._stretching = false;
        this.connect('destroy', () => this.cleanup());
        this.resize(entry.size);
    }

    /** @param {string} size - square, card, large or wide (or one of its own, "9x11") */
    resize(size) {
        this.fill(size);
        this.fit();
    }

    /**
     * Lay out what it shows for a size. The card keeps the size it has
     * until fit() (while it is being stretched, say). Of a size of its own,
     * it is styled as the size it goes by: of its kind's, the nearest to it
     * (in the context's catalog, the lock screen's say).
     *
     * @param {string} size
     */
    fill(size) {
        // (Styled anew – once – only when it goes by another size.)
        const named = namedSize(size, (this._context.catalog ?? KINDS)[this.entry.kind]?.sizes);
        const sized = new Set(Object.keys(SIZES).map(name => `atelier-widget-${name}`));
        const classes = (this.get_style_class_name() ?? '').split(' ').filter(name => name && !sized.has(name));
        const style = [...classes, `atelier-widget-${named}`].join(' ');
        if (style !== this.get_style_class_name())
            this.set_style_class_name(style);
        this.entry = {...this.entry, size};
        if (this._content && this.fitContent(size)) {
            this.emit('filled');
            return;
        }
        this._content?.destroy();
        this._content = new St.BoxLayout({
            style_class: 'atelier-widget-content',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: this._stretching,
        });
        // (Under the buttons and the handle in its corners.)
        this.insert_child_at_index(this._content, 0);
        this.build(this._content, size);
        this.emit('filled');
    }

    /** The card as big as its size. */
    fit() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [width, height] = pixelSize(this.entry.size);
        this.set_size(width * scale, height * scale);
    }

    /** @returns {boolean} whether it is being stretched */
    get stretching() {
        return this._stretching ?? false;
    }

    /** @param {boolean} stretching - what it shows is cut off at its edges */
    set stretching(stretching) {
        stretching = Boolean(stretching);
        if (stretching === this.stretching)
            return;
        this._stretching = stretching;
        if (this._content)
            this._content.clip_to_allocation = stretching;
        this.notify('stretching');
    }

    /**
     * Fill the card; called again with a fresh box when the size changes.
     *
     * @param {St.BoxLayout} _box
     * @param {string} _size
     */
    build(_box, _size) {}

    /**
     * Before it is filled anew for another size: whether what it shows
     * serves as it is, told of the size (a kind's face that lays itself out
     * for any size).
     *
     * @param {string} _size
     * @returns {boolean} false: built anew
     */
    fitContent(_size) {
        return false;
    }

    /** What a click does (open the app that has more, say). */
    activate() {}

    /** Let go of what it listens to; it is being destroyed. */
    cleanup() {}

    vfunc_button_press_event(event) {
        // (A click is a press and a release on it: not the release of a
        // drag let go of when editing stopped, say.)
        this._pressed = event.get_button() === Clutter.BUTTON_PRIMARY && !this.editing;
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this.emit('menu-request');
            return Clutter.EVENT_STOP;
        }
        const pressed = this._pressed;
        this._pressed = false;
        if (button === Clutter.BUTTON_PRIMARY && !this.editing && pressed) {
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
        const app = GioUnix.DesktopAppInfo.new(id);
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
