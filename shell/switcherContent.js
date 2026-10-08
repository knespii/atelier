// The switcher's content: tabs (profiles / wallpaper folder), a strip of
// thumbnails and a footer. It doesn't place or grab anything itself; a host
// shows it, either the island or, without it, a popup (switcher.js).
//
// From one tab to the other (Tab, or a click), the highlight pours over to
// the other tab, and the cards go off to the side as the other tab's come
// in from the other, one after another from the one picked out.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {pour} from '../lib/liquid.js';
import {describeProfile, effectiveWallpaper} from '../lib/profiles.js';
import {isSlideshow, prettyName} from '../lib/paths.js';
import {ensureThumbnail, hasThumbnail, thumbnailPath} from '../lib/thumbnails.js';
import {LiquidPaint} from './core/liquid.js';

export const MODES = ['profiles', 'wallpapers'];

/** Id of the card at the end of the Profiles tab that saves a new profile. */
export const NEW_PROFILE = 'atelier-new-profile';

// Logical pixels; multiplied by the scale factor where used.
const CARD_WIDTH = 192;
const CARD_HEIGHT = 120;
const CARD_SPACING = 14;
const STRIP_PADDING = 10;

const PRELOAD_DELAY = 120;
const SCROLL_TIME = 260;
const UNSELECTED_SCALE = 0.92;
const UNSELECTED_OPACITY = 190;
// From one tab to the other, milliseconds: the highlight pouring over, the
// cards going and coming (each a little after the one before it).
const POUR_TIME = 420;
const CARDS_OUT_TIME = 220;
const CARDS_IN_TIME = 340;
const CARDS_IN_DELAY = 90;
const CARDS_STAGGER = 35;
// Logical pixels: how far the cards go and come from, how near the
// highlight melts. Its colour, as the stylesheet has a tab checked.
const CARDS_SHIFT = 90;
const POUR_BLEND = 10;
const TAB_COLOR = [1, 1, 1, 0.14];

/**
 * @param {string} path
 * @returns {string} the path as a URL usable inside url("…") in St CSS
 */
export function cssUrl(path) {
    return GLib.filename_to_uri(path, null).replace(/"/g, '%22');
}

const home = path => path.replace(GLib.get_home_dir(), '~');

/**
 * @param {number} workAreaWidth
 * @param {number} scale
 * @returns {number} the width the switcher looks best at
 */
export function switcherWidth(workAreaWidth, scale) {
    return Math.round(Math.min(workAreaWidth - 48 * scale, Math.max(640 * scale, workAreaWidth * 0.5)));
}

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

        if (item.id === NEW_PROFILE) {
            this.add_style_class_name('atelier-card-new');
            this._placeholder.hide();
            content.add_child(new St.Icon({
                style_class: 'atelier-card-new-icon',
                icon_name: 'list-add-symbolic',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                y_expand: true,
            }));
        } else if (item.wallpaper && hasThumbnail(item.wallpaper))
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

export const SwitcherContent = GObject.registerClass({
    Signals: {
        'activate': {param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING]},
        'create': {},
        'mode-changed': {param_types: [GObject.TYPE_STRING]},
        'close-request': {},
    },
}, class AtelierSwitcherContent extends St.BoxLayout {
    /**
     * @param {string} mode - one of MODES
     */
    _init(mode = 'profiles') {
        super._init({
            style_class: 'atelier-switcher',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });

        this._mode = MODES.includes(mode) ? mode : 'profiles';
        this._data = {
            profiles: {items: [], activeId: ''},
            wallpapers: {items: [], activeId: '', folder: '', loaded: false},
        };
        this._items = [];
        this._cards = [];
        this._selected = 0;
        this._scrollDelta = 0;
        this._closing = false;
        this._preloadId = 0;
        this._preloaded = null;
        // Known once a host sets the width; measuring before that would
        // need the styles of a widget that isn't on the stage yet.
        this._viewportWidth = 0;

        // (The tabs over their highlight, as it pours from one to the other.)
        const tabsArea = new St.Widget({layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        this._pour = new LiquidPaint({visible: false, x_expand: true, y_expand: true});
        this._pour.setColors(TAB_COLOR);
        tabsArea.add_child(this._pour);
        const tabs = new St.BoxLayout({style_class: 'atelier-tabs'});
        tabsArea.add_child(tabs);
        this._tabs = {};
        for (const [key, label] of [['profiles', 'Profiles'], ['wallpapers', 'Wallpapers']]) {
            const tab = new St.Button({style_class: 'atelier-tab', label, can_focus: false});
            tab.connect('clicked', () => this.setMode(key));
            tabs.add_child(tab);
            this._tabs[key] = tab;
        }
        this.add_child(tabsArea);
        this._transition = null;

        this._viewport = new St.Widget({style_class: 'atelier-viewport', clip_to_allocation: true});
        this.add_child(this._viewport);

        this._strip = new St.BoxLayout({style_class: 'atelier-strip'});
        this._viewport.add_child(this._strip);

        this._empty = new St.Label({style_class: 'atelier-empty', visible: false});
        this._empty.clutter_text.line_wrap = true;
        this.add_child(this._empty);

        const footer = new St.BoxLayout({style_class: 'atelier-footer', x_expand: true});
        this.add_child(footer);

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

    /** @returns {boolean} whether the switcher is on its way out */
    get closing() {
        return this._closing;
    }

    /** Ask the host to close the switcher. */
    close() {
        if (this._closing || this._destroyed)
            return;
        this._closing = true;
        this.emit('close-request');
    }

    /**
     * Set the outer width; the strip uses all of it minus padding.
     *
     * @param {number} width
     */
    setWidth(width) {
        this.width = width;
        const scale = this._scale;
        const node = this.get_theme_node();
        this._viewportWidth = width - node.get_horizontal_padding();
        this._viewport.set_size(this._viewportWidth, (CARD_HEIGHT + STRIP_PADDING * 2) * scale);
        this._strip.y = STRIP_PADDING * scale;
        this._select(this._selected, false);
    }

    /**
     * @param {object[]} profiles
     * @param {string} activeId
     */
    setProfiles(profiles, activeId) {
        if (this._destroyed)
            return;
        this._data.profiles = {
            activeId,
            items: [
                ...profiles.map(p => ({id: p.id, name: p.name, wallpaper: p.wallpaper, profile: p})),
                {id: NEW_PROFILE, name: 'New profile', wallpaper: null},
            ],
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
        const from = this._mode;
        this._finishTransition();
        // (The cards of the tab left, going off to its side.)
        const leaving = this._cards.length > 0 && this.mapped ? this._strip : null;
        if (leaving) {
            this._strip = new St.BoxLayout({style_class: 'atelier-strip', y: leaving.y});
            this._viewport.add_child(this._strip);
            this._cards = [];
        }
        this._mode = mode;
        this._syncTabs();
        this._rebuild();
        if (leaving)
            this._crossOver(from, mode, leaving);
        this.emit('mode-changed', mode);
    }

    // From one tab to another: the highlight pours over, the cards left go
    // off to the side away from the tab now chosen, its own coming in from
    // that side, the one picked out first.
    _crossOver(from, to, leaving) {
        const scale = this._scale;
        const animate = St.Settings.get().enable_animations;
        const toward = MODES.indexOf(to) > MODES.indexOf(from) ? 1 : -1;
        const shift = CARDS_SHIFT * scale * toward;
        const time = ms => (animate ? adjustAnimationTime(ms) : 0);
        const done = () => {
            leaving.destroy();
            this._pour.hide();
            Object.values(this._tabs).forEach(tab => (tab.style = null));
        };
        leaving.ease({
            translation_x: leaving.translation_x - shift,
            opacity: 0,
            duration: time(CARDS_OUT_TIME),
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
        });
        this._cards.forEach((card, i) => {
            const opacity = card.opacity;
            card.translation_x = shift;
            card.opacity = 0;
            card.ease({
                translation_x: 0,
                opacity,
                // (Once those left have mostly gone.)
                delay: time(CARDS_IN_DELAY + CARDS_STAGGER * Math.min(Math.abs(i - this._selected), 6)),
                duration: time(CARDS_IN_TIME),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        });
        // The highlight, by itself while it pours (the tabs see through).
        const rect = tab => [tab.x, tab.y, tab.width, tab.height];
        const [a, b] = [rect(this._tabs[from]), rect(this._tabs[to])];
        const look = {radius: Math.min(a[3], b[3]) / 2, blend: POUR_BLEND * scale};
        Object.values(this._tabs).forEach(tab => (tab.style = 'background-color: transparent;'));
        this._pour.show();
        const timeline = new Clutter.Timeline({actor: this, duration: Math.max(1, time(POUR_TIME))});
        timeline.connect('new-frame', () => this._pour.setShapes(pour(a, b, timeline.get_progress(), look)));
        timeline.connect('completed', () => {
            this._transition = null;
            done();
        });
        this._transition = {timeline, done};
        this._pour.setShapes(pour(a, b, 0, look));
        timeline.start();
    }

    // What is still going from one tab to another, done at once.
    _finishTransition() {
        const transition = this._transition;
        this._transition = null;
        if (!transition)
            return;
        transition.timeline.stop();
        transition.done();
        this._cards.forEach(card => {
            card.remove_transition('translation-x');
            card.translation_x = 0;
        });
        this._select(this._selected, false);
    }

    /** @param {string} activeId */
    setActive(activeId) {
        if (this._destroyed)
            return;
        this._data[this._mode].activeId = activeId;
        this._cards.forEach(card => (card.active = card.item.id === activeId));
        this._updateFooter();
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

        // The Profiles tab always has its "new profile" card.
        const empty = this._items.length === 0;
        this._viewport.visible = !empty;
        this._empty.visible = empty;
        this._empty.text = data.loaded
            ? `No pictures in ${home(data.folder)}.\nPut some there, or choose another folder in Atelier's settings.`
            : 'Looking for pictures…';
        this._select(this._selected, false);
    }

    _onDestroy() {
        this._destroyed = true;
        this._transition?.timeline.stop();
        this._transition = null;
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

    _select(index, animate = true) {
        if (this._cards.length === 0) {
            this._updateFooter();
            return;
        }
        this._selected = Math.max(0, Math.min(index, this._cards.length - 1));

        const scale = this._scale;
        const step = (CARD_WIDTH + CARD_SPACING) * scale;
        const target = Math.round(this._viewportWidth / 2 -
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
        if (item.id === NEW_PROFILE) {
            this._counter.text = '';
            this._chips.add_child(new St.Label({
                style_class: 'atelier-chip',
                text: 'Saves the wallpaper, style and themes you have now',
            }));
            return;
        }
        const count = this._items.filter(i => i.id !== NEW_PROFILE).length;
        this._counter.text = `${this._selected + 1} / ${count}`;
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
        if (this._items[index].id === NEW_PROFILE)
            this.emit('create');
        else
            this.emit('activate', this._mode, this._items[index].id);
    }

    /**
     * @param {Clutter.Event} event
     * @returns {boolean} whether the key was handled
     */
    handleKeyPress(event) {
        switch (event.get_key_symbol()) {
        case Clutter.KEY_Left:
        case Clutter.KEY_KP_Left:
            this._select(this._selected - 1);
            return true;
        case Clutter.KEY_Right:
        case Clutter.KEY_KP_Right:
            this._select(this._selected + 1);
            return true;
        case Clutter.KEY_Home:
            this._select(0);
            return true;
        case Clutter.KEY_End:
            this._select(this._cards.length - 1);
            return true;
        case Clutter.KEY_Tab:
        case Clutter.KEY_ISO_Left_Tab:
            this.setMode(this._mode === 'profiles' ? 'wallpapers' : 'profiles');
            return true;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
        case Clutter.KEY_space:
            this._activate(this._selected);
            return true;
        case Clutter.KEY_Escape:
            this.close();
            return true;
        }
        return false;
    }

    /**
     * @param {Clutter.Event} event
     * @returns {boolean} whether the scroll was handled
     */
    handleScroll(event) {
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
        return true;
    }
});
