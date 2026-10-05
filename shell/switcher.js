// The switcher: a dark panel that drops from the top of the screen with a
// strip of thumbnails, either of the profiles or of the pictures in the
// wallpaper folder. It is only for picking; profiles are managed in the
// extension's preferences.

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

import {describeProfile, effectiveWallpaper} from '../lib/profiles.js';
import {isSlideshow, prettyName} from '../lib/paths.js';
import {ensureThumbnail, hasThumbnail, thumbnailPath} from '../lib/thumbnails.js';

export const MODES = ['profiles', 'wallpapers'];

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

const home = path => path.replace(GLib.get_home_dir(), '~');

const Card = GObject.registerClass(
class AtelierCard extends St.Button {
    /**
     * @param {{id: string, name: string, wallpaper: string|null}} item
     */
    _init(item) {
        super._init({
            style_class: 'atelier-card',
            track_hover: true,
            can_focus: false,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            accessible_name: item.name,
        });
        this.item = item;

        const content = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.set_child(content);

        this._badge = new St.Bin({
            style_class: 'atelier-badge',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_expand: true,
            visible: false,
            child: new St.Icon({icon_name: 'object-select-symbolic', style_class: 'atelier-badge-icon'}),
        });
        content.add_child(this._badge);

        this._placeholder = new St.Label({
            style_class: 'atelier-placeholder',
            text: item.name.slice(0, 1).toUpperCase(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        content.add_child(this._placeholder);
        content.set_child_below_sibling(this._placeholder, this._badge);

        this.connect('destroy', () => (this._destroyed = true));

        if (item.wallpaper && hasThumbnail(item.wallpaper))
            this._showThumbnail(thumbnailPath(item.wallpaper));
        else if (item.wallpaper)
            this._loadThumbnail(item.wallpaper);
    }

    async _loadThumbnail(wallpaper) {
        try {
            const path = await ensureThumbnail(wallpaper);
            if (!this._destroyed)
                this._showThumbnail(path);
        } catch (e) {
            console.warn(`Atelier: no thumbnail for ${wallpaper}: ${e.message}`);
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

export const Switcher = GObject.registerClass({
    Signals: {
        'activate': {param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]},
        'mode-changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class AtelierSwitcher extends St.Widget {
    /**
     * @param {string} mode - one of MODES
     */
    _init(mode = 'profiles') {
        super._init({reactive: true, visible: false});
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));

        this._mode = MODES.includes(mode) ? mode : 'profiles';
        this._data = {
            profiles: {items: [], activeId: '', profiles: []},
            wallpapers: {items: [], activeId: '', folder: '', loaded: false},
        };
        this._items = [];
        this._cards = [];
        this._selected = 0;
        this._scrollDelta = 0;
        this._grab = null;
        this._closing = false;
        this._preloadId = 0;
        this._preloaded = null;

        this._panel = new St.BoxLayout({
            style_class: 'atelier-panel',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this.add_child(this._panel);

        const tabs = new St.BoxLayout({style_class: 'atelier-tabs', x_align: Clutter.ActorAlign.CENTER});
        this._tabs = {};
        for (const [key, label] of [['profiles', 'Profiles'], ['wallpapers', 'Wallpapers']]) {
            const tab = new St.Button({style_class: 'atelier-tab', label, can_focus: false});
            tab.connect('clicked', () => this.setMode(key));
            tabs.add_child(tab);
            this._tabs[key] = tab;
        }
        this._panel.add_child(tabs);

        this._viewport = new St.Widget({style_class: 'atelier-viewport', clip_to_allocation: true});
        this._panel.add_child(this._viewport);

        this._strip = new St.BoxLayout({style_class: 'atelier-strip'});
        this._viewport.add_child(this._strip);

        this._empty = new St.Label({style_class: 'atelier-empty', visible: false});
        this._empty.clutter_text.line_wrap = true;
        this._panel.add_child(this._empty);

        const footer = new St.BoxLayout({style_class: 'atelier-footer', x_expand: true});
        this._panel.add_child(footer);

        this._dot = new St.Widget({style_class: 'atelier-dot', y_align: Clutter.ActorAlign.CENTER});
        footer.add_child(this._dot);
        this._name = new St.Label({style_class: 'atelier-name', y_align: Clutter.ActorAlign.CENTER});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        footer.add_child(this._name);
        this._chips = new St.BoxLayout({style_class: 'atelier-chips', y_align: Clutter.ActorAlign.CENTER});
        footer.add_child(this._chips);
        this._counter = new St.Label({
            style_class: 'atelier-counter',
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
        this._syncTabs();
    }

    get _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    /** @returns {string} the visible tab */
    get mode() {
        return this._mode;
    }

    /** @returns {boolean} whether the wallpaper folder was listed */
    get wallpapersLoaded() {
        return this._data.wallpapers.loaded;
    }

    /**
     * @param {object[]} profiles
     * @param {string} activeId
     */
    setProfiles(profiles, activeId) {
        if (this._destroyed)
            return;
        this._data.profiles = {
            profiles,
            activeId,
            items: profiles.map(p => ({id: p.id, name: p.name, wallpaper: p.wallpaper, profile: p})),
        };
        if (this._mode === 'profiles')
            this._rebuild();
    }

    /**
     * @param {string[]} paths - pictures of the wallpaper folder
     * @param {string|null} current - the wallpaper on screen
     * @param {string} folder
     */
    setWallpapers(paths, current, folder) {
        if (this._destroyed)
            return;
        this._data.wallpapers = {
            folder,
            loaded: true,
            activeId: current ?? '',
            items: paths.map(path => ({id: path, name: prettyName(path), wallpaper: path})),
        };
        if (this._mode === 'wallpapers')
            this._rebuild();
    }

    /** @param {string} mode */
    setMode(mode) {
        if (this._destroyed || !MODES.includes(mode) || mode === this._mode)
            return;
        this._mode = mode;
        this._syncTabs();
        this._rebuild();
        this.emit('mode-changed', mode);
    }

    /** @param {string} activeId */
    setActive(activeId) {
        if (this._destroyed)
            return;
        this._data[this._mode].activeId = activeId;
        this._cards.forEach(card => (card.active = card.item.id === activeId));
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

    _syncTabs() {
        for (const [key, tab] of Object.entries(this._tabs)) {
            if (key === this._mode)
                tab.add_style_pseudo_class('checked');
            else
                tab.remove_style_pseudo_class('checked');
        }
    }

    _rebuild() {
        const data = this._data[this._mode];
        const selectedId = this._items[this._selected]?.id;
        this._items = data.items;

        this._strip.destroy_all_children();
        const scale = this._scale;
        this._cards = this._items.map((item, index) => {
            const card = new Card(item);
            card.set_size(CARD_WIDTH * scale, CARD_HEIGHT * scale);
            card.active = item.id === data.activeId;
            card.connect('clicked', () => this._activate(index));
            this._strip.add_child(card);
            return card;
        });

        let index = this._items.findIndex(item => item.id === selectedId);
        if (index < 0)
            index = this._items.findIndex(item => item.id === data.activeId);
        this._selected = Math.max(0, index);

        const empty = this._items.length === 0;
        this._viewport.visible = !empty;
        this._empty.visible = empty;
        if (this._mode === 'profiles') {
            this._empty.text = 'No profiles yet. Add them in the Atelier settings\n(Extensions → Atelier → ⚙).';
        } else {
            this._empty.text = data.loaded
                ? `No pictures in ${home(data.folder)}.\nPut some there, or choose another folder in Atelier's settings.`
                : 'Looking for pictures…';
        }
        this._layoutPanel();
        this._select(this._selected, false);
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
            const item = this._items[this._selected];
            let wallpaper = item?.wallpaper ?? null;
            if (item?.profile) {
                const scheme = item.profile.colorScheme ??
                    new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('color-scheme');
                wallpaper = effectiveWallpaper(item.profile, scheme);
            }
            // Slideshows are XML, not images; GNOME loads them itself.
            if (wallpaper && !isSlideshow(wallpaper)) {
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
        const item = this._items[this._selected];
        this._chips.destroy_all_children();
        if (!item) {
            this._name.text = '';
            this._counter.text = '';
            this._dot.opacity = 0;
            return;
        }

        this._name.text = item.name;
        this._dot.opacity = item.id === this._data[this._mode].activeId ? 255 : 0;
        this._counter.text = `${this._selected + 1} / ${this._items.length}`;
        const parts = item.profile ? describeProfile(item.profile).slice(0, 4) : [];
        for (const {label, value} of parts) {
            this._chips.add_child(new St.Label({
                style_class: 'atelier-chip',
                text: `${label}: ${value}`,
            }));
        }
    }

    _activate(index) {
        if (this._closing || !this._items[index])
            return;
        this._select(index);
        this.emit('activate', this._mode, this._items[index].id);
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
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab:
            this.setMode(this._mode === 'profiles' ? 'wallpapers' : 'profiles');
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
