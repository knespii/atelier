// The look switcher: a dark panel that drops from the top of the screen with
// a strip of wallpaper thumbnails. It is only for picking a look; looks are
// managed in the extension's preferences.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {describeLook, effectiveWallpaper} from '../lib/looks.js';
import {ensureThumbnail, hasThumbnail, thumbnailPath} from '../lib/thumbnails.js';

// Logical pixels; multiplied by the scale factor where used.
const CARD_WIDTH = 192;
const CARD_HEIGHT = 120;
const CARD_SPACING = 14;
const STRIP_PADDING = 10;
const TOP_MARGIN = 10;
const MIN_PANEL_WIDTH = 640;

const PRELOAD_DELAY = 120;

const OPEN_TIME = 220;
const CLOSE_TIME = 160;
const SCROLL_TIME = 260;
const UNSELECTED_SCALE = 0.92;
const UNSELECTED_OPACITY = 190;

function cssUrl(path) {
    return GLib.filename_to_uri(path, null).replace(/"/g, '%22');
}

const LookCard = GObject.registerClass(
class BgChangerLookCard extends St.Button {
    _init(look) {
        super._init({
            style_class: 'bgc-card',
            track_hover: true,
            can_focus: false,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            accessible_name: look.name,
        });
        this.look = look;

        const content = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.set_child(content);

        this._badge = new St.Bin({
            style_class: 'bgc-badge',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
            visible: false,
            child: new St.Icon({icon_name: 'object-select-symbolic', style_class: 'bgc-badge-icon'}),
        });
        content.add_child(this._badge);

        this._placeholder = new St.Label({
            style_class: 'bgc-placeholder',
            text: look.name.slice(0, 1).toUpperCase(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        content.add_child(this._placeholder);
        content.set_child_below_sibling(this._placeholder, this._badge);

        this.connect('destroy', () => (this._destroyed = true));

        if (look.wallpaper && hasThumbnail(look.wallpaper))
            this._showThumbnail(thumbnailPath(look.wallpaper));
        else if (look.wallpaper)
            this._loadThumbnail(look.wallpaper);
    }

    async _loadThumbnail(wallpaper) {
        try {
            const path = await ensureThumbnail(wallpaper);
            if (!this._destroyed)
                this._showThumbnail(path);
        } catch (e) {
            console.warn(`BG Changer: no thumbnail for ${wallpaper}: ${e.message}`);
        }
    }

    _showThumbnail(path) {
        this._placeholder.hide();
        this.style = `background-image: url("${cssUrl(path)}");`;
    }

    set active(active) {
        this._badge.visible = active;
    }
});

export const LookSwitcher = GObject.registerClass({
    Signals: {
        'activate': {param_types: [GObject.TYPE_STRING]},
    },
}, class BgChangerLookSwitcher extends St.Widget {
    _init() {
        super._init({reactive: true, visible: false});
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        this._looks = [];
        this._cards = [];
        this._activeId = '';
        this._selected = 0;
        this._scrollDelta = 0;
        this._grab = null;
        this._closing = false;
        this._preloadId = 0;
        this._preloaded = null;

        this._panel = new St.BoxLayout({
            style_class: 'bgc-panel',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this.add_child(this._panel);

        this._viewport = new St.Widget({style_class: 'bgc-viewport', clip_to_allocation: true});
        this._panel.add_child(this._viewport);

        this._strip = new St.BoxLayout({style_class: 'bgc-strip'});
        this._viewport.add_child(this._strip);

        this._empty = new St.Label({
            style_class: 'bgc-empty',
            text: 'No looks yet. Add them in the BG Changer settings\n(Extensions → BG Changer → ⚙).',
            visible: false,
        });
        this._panel.add_child(this._empty);

        const footer = new St.BoxLayout({style_class: 'bgc-footer', x_expand: true});
        this._panel.add_child(footer);

        this._dot = new St.Widget({style_class: 'bgc-dot', y_align: Clutter.ActorAlign.CENTER});
        footer.add_child(this._dot);
        this._name = new St.Label({style_class: 'bgc-name', y_align: Clutter.ActorAlign.CENTER});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        footer.add_child(this._name);
        this._chips = new St.BoxLayout({style_class: 'bgc-chips', y_align: Clutter.ActorAlign.CENTER});
        footer.add_child(this._chips);
        this._counter = new St.Label({
            style_class: 'bgc-counter',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        footer.add_child(this._counter);

        Main.layoutManager.uiGroup.add_child(this);
        Main.layoutManager.connectObject(
            'system-modal-opened', () => this.close(),
            'monitors-changed', () => this.close(), this);
        this.connect('destroy', () => this._onDestroy());
    }

    get _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    /**
     * @param {object[]} looks
     * @param {string} activeId
     */
    setLooks(looks, activeId) {
        if (this._destroyed)
            return;
        const selectedId = this._looks[this._selected]?.id ?? activeId;
        this._looks = looks;
        this._activeId = activeId;

        this._strip.destroy_all_children();
        const scale = this._scale;
        this._cards = looks.map((look, index) => {
            const card = new LookCard(look);
            card.set_size(CARD_WIDTH * scale, CARD_HEIGHT * scale);
            card.active = look.id === activeId;
            card.connect('clicked', () => this._activate(index));
            this._strip.add_child(card);
            return card;
        });

        const index = looks.findIndex(look => look.id === selectedId);
        this._selected = Math.max(0, index);

        const empty = looks.length === 0;
        this._viewport.visible = !empty;
        this._empty.visible = empty;
        this._layoutPanel();
        this._select(this._selected, false);
    }

    /** @param {string} activeId */
    setActive(activeId) {
        if (this._destroyed)
            return;
        this._activeId = activeId;
        this._cards.forEach(card => (card.active = card.look.id === activeId));
        this._updateFooter();
    }

    /** @returns {boolean} whether the switcher could take the keyboard */
    open() {
        const grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        if ((grab.get_seat_state() & Clutter.GrabState.KEYBOARD) === 0) {
            Main.popModal(grab);
            this.destroy();
            return false;
        }
        this._grab = grab;

        this.show();
        this._panel.opacity = 0;
        this._panel.translation_y = -16 * this._scale;
        this._panel.ease({
            opacity: 255,
            translation_y: 0,
            duration: OPEN_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        return true;
    }

    close() {
        // Also called when an apply finishes, possibly after disable() destroyed us.
        if (this._closing || this._destroyed)
            return;
        this._closing = true;
        this._popModal();
        this._panel.ease({
            opacity: 0,
            translation_y: -12 * this._scale,
            duration: CLOSE_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    get closing() {
        return this._closing;
    }

    _popModal() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _onDestroy() {
        this._destroyed = true;
        this._popModal();
        Main.layoutManager.disconnectObject(this);
        if (this._preloadId)
            GLib.source_remove(this._preloadId);
        this._preloadId = 0;
        this._preloaded = null;
    }

    /**
     * Decode the selected wallpaper while the user is still choosing, so the
     * transition can start right away; holding the image keeps it cached.
     */
    _schedulePreload() {
        if (this._preloadId)
            GLib.source_remove(this._preloadId);
        this._preloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PRELOAD_DELAY, () => {
            this._preloadId = 0;
            const look = this._looks[this._selected];
            const scheme = look?.colorScheme ??
                new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('color-scheme');
            const wallpaper = look ? effectiveWallpaper(look, scheme) : null;
            if (wallpaper) {
                this._preloaded = Meta.BackgroundImageCache.get_default()
                    .load(Gio.File.new_for_path(wallpaper));
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _layoutPanel() {
        const scale = this._scale;
        const monitor = Main.layoutManager.currentMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);

        const width = Math.round(Math.min(
            workArea.width - 48 * scale,
            Math.max(MIN_PANEL_WIDTH * scale, workArea.width * 0.5)));
        this._panel.width = width;

        const themeNode = this._panel.get_theme_node();
        const innerWidth = width -
            themeNode.get_horizontal_padding() - themeNode.get_border_width(St.Side.LEFT) * 2;
        this._viewport.set_size(innerWidth, (CARD_HEIGHT + STRIP_PADDING * 2) * scale);
        this._strip.y = STRIP_PADDING * scale;

        this._panel.set_position(
            workArea.x + Math.round((workArea.width - width) / 2),
            workArea.y + TOP_MARGIN * scale);
    }

    _select(index, animate = true) {
        if (this._cards.length === 0) {
            this._updateFooter();
            return;
        }
        this._selected = Math.max(0, Math.min(index, this._cards.length - 1));

        const scale = this._scale;
        const step = (CARD_WIDTH + CARD_SPACING) * scale;
        const target = Math.round(this._viewport.width / 2 -
            (this._selected * step + CARD_WIDTH * scale / 2));
        const duration = animate ? SCROLL_TIME : 0;

        this._strip.ease({
            translation_x: target,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this._cards.forEach((card, i) => {
            const selected = i === this._selected;
            if (selected)
                card.add_style_pseudo_class('selected');
            else
                card.remove_style_pseudo_class('selected');
            card.ease({
                scale_x: selected ? 1 : UNSELECTED_SCALE,
                scale_y: selected ? 1 : UNSELECTED_SCALE,
                opacity: selected ? 255 : UNSELECTED_OPACITY,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
        this._updateFooter();
        this._schedulePreload();
    }

    _updateFooter() {
        const look = this._looks[this._selected];
        this._chips.destroy_all_children();
        if (!look) {
            this._name.text = '';
            this._counter.text = '';
            this._dot.opacity = 0;
            return;
        }

        this._name.text = look.name;
        this._dot.opacity = look.id === this._activeId ? 255 : 0;
        this._counter.text = `${this._selected + 1} / ${this._looks.length}`;
        for (const {label, value} of describeLook(look).slice(0, 4)) {
            this._chips.add_child(new St.Label({
                style_class: 'bgc-chip',
                text: `${label}: ${value}`,
            }));
        }
    }

    _activate(index) {
        if (this._closing || !this._looks[index])
            return;
        this._select(index);
        this.emit('activate', this._looks[index].id);
    }

    vfunc_key_press_event(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Left:
        case Clutter.KEY_KP_Left:
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Right:
        case Clutter.KEY_KP_Right:
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Home:
            this._select(0);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_End:
            this._select(this._cards.length - 1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
        case Clutter.KEY_space:
            this._activate(this._selected);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_scroll_event(event) {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.SMOOTH) {
            // Touchpads send many small deltas; move one card per full unit.
            const [dx, dy] = event.get_scroll_delta();
            this._scrollDelta += Math.abs(dx) > Math.abs(dy) ? dx : dy;
            const steps = Math.trunc(this._scrollDelta);
            if (steps !== 0) {
                this._scrollDelta -= steps;
                this._select(this._selected + steps);
            }
        } else if (direction === Clutter.ScrollDirection.UP ||
                   direction === Clutter.ScrollDirection.LEFT) {
            this._select(this._selected - 1);
        } else {
            this._select(this._selected + 1);
        }
        return Clutter.EVENT_STOP;
    }

    _isOutsidePanel(event) {
        const actor = global.stage.get_event_actor(event);
        return !this._panel.contains(actor);
    }

    vfunc_button_press_event(event) {
        if (this._isOutsidePanel(event))
            this.close();
        return Clutter.EVENT_STOP;
    }

    vfunc_touch_event(event) {
        if (event.type() === Clutter.EventType.TOUCH_BEGIN && this._isOutsidePanel(event))
            this.close();
        return Clutter.EVENT_STOP;
    }
});
