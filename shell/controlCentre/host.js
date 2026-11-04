// GNOME's quick settings – Wi-Fi, Bluetooth, sliders, power mode, Caffeine
// and every other tile, with their menus – shown in Atelier's control centre
// as macOS lays out its Control Center: rounded modules in a grid two
// panes wide (shell/controlCentre/layout.js, lib/controlGrid.js). The tiles
// stay GNOME's (and the extensions'): each moves out of GNOME's grid into a
// module, new ones too (an extension's go where there is room), and a
// tile's menu opens as a page of its own in place of the modules. It all
// goes back when the control centre is turned off.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {ControlModule, moduleGrid, rectIn} from './layout.js';

// The modules in their order (lib/controlGrid.js packs them so): the first
// pane like the left of macOS's Control Center, the second its sliders and
// the system buttons; extensions' tiles where there is room.
const MODULES = [
    ['connectivity', {cols: 2, pane: 0, rowPerSlot: true}],
    ['media', {cols: 2, rows: 2, pane: 0, always: true}],
    ['dark', {cols: 1, pane: 0}],
    ['night', {cols: 1, pane: 0}],
    ['focus', {cols: 2, pane: 0}],
    ['power-mode', {cols: 1, pane: 0}],
    ['display', {cols: 4, pane: 1, title: 'Display', horizontal: true}],
    ['sound', {cols: 4, pane: 1, title: 'Sound'}],
    ['system', {cols: 4, pane: 1}],
];
const ORDER = MODULES.map(([id]) => id);
// (Then the extensions' and unknown tiles, in modules of their own.)

// GNOME's tiles by their class (as GNOME names them), for when they are not
// found through GNOME's indicators.
const BY_CLASS = {
    NMWirelessToggle: ['connectivity', 'row', 0],
    BluetoothToggle: ['connectivity', 'row', 1],
    NMWiredToggle: ['connectivity', 'row', 2],
    RfkillToggle: ['connectivity', 'row', 3],
    NMBluetoothToggle: ['connectivity', 'row', 4],
    NMModemToggle: ['connectivity', 'row', 5],
    NMVpnToggle: ['connectivity', 'row', 6],
    DarkModeToggle: ['dark', 'square', 0],
    NightLightToggle: ['night', 'square', 0],
    DoNotDisturbToggle: ['focus', 'row', 0],
    PowerProfilesToggle: ['power-mode', 'square', 0],
    BrightnessItem: ['display', 'slider', 0],
    KeyboardBrightnessToggle: ['display', 'compact', 1],
    OutputStreamSlider: ['sound', 'slider', 0],
    InputStreamSlider: ['sound', 'slider', 1],
    SystemItem: ['system', 'system', 0],
    BackgroundAppsToggle: ['footer', 'wide', 0],
};
// (And by their icon, the last resort.)
const BY_ICON = {
    'dark-mode-symbolic': ['dark', 'square', 0],
    'night-light-symbolic': ['night', 'square', 0],
};

const DND_SCHEMA = 'org.gnome.desktop.notifications';

// The page of an open menu: as wide as a pane of modules.
const DetailLayout = GObject.registerClass(
class AtelierControlDetailLayout extends Clutter.LayoutManager {
    // The open menus' (one, but while one closes as another opens) height:
    // their content's, at once, not the height GNOME eases them through
    // under a tile.
    _heightOf(container, width) {
        let height = 0;
        for (const child of container) {
            const menu = child._delegate;
            if (!child.visible || !menu?.isOpen)
                continue;
            const content = menu.box ?? child;
            height = Math.max(height, content.get_preferred_height(width)[1]);
        }
        return height;
    }

    vfunc_get_preferred_width(container, forHeight) {
        let [min, nat] = [0, 0];
        for (const child of container) {
            if (!child.visible || !child._delegate?.isOpen)
                continue;
            const [cMin, cNat] = child.get_preferred_width(forHeight);
            min = Math.max(min, cMin);
            nat = Math.max(nat, cNat);
        }
        return [min, nat];
    }

    vfunc_get_preferred_height(container, forWidth) {
        const height = this._heightOf(container, forWidth);
        return [height, height];
    }

    vfunc_allocate(container, box) {
        const width = box.get_width();
        const height = Math.max(box.get_height(), this._heightOf(container, width));
        for (const child of container) {
            if (child.visible)
                child.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: height}));
        }
    }
});

export const QuickSettingsHost = GObject.registerClass({
    Signals: {
        // A menu's page opened or closed (in place of the modules).
        'detail-changed': {},
    },
}, class AtelierQuickSettingsHost extends GObject.Object {
    /**
     * @param {object} quickSettings - Main.panel.statusArea.quickSettings
     */
    _init(quickSettings) {
        super._init();
        this._quickSettings = quickSettings;
        this._menu = quickSettings.menu;
        const {_grid: grid, _overlay: overlay} = this._menu;
        this._grid = grid;
        this._overlay = overlay;
        this._placeholder = grid.layout_manager?._overlay ?? null;
        this._injections = new InjectionManager();
        this._laterId = 0;
        this._pending = new Set();
        this._siblings = new Map();
        // Each tile taken: {slot, module, span, tweaks}.
        this._items = new Map();
        this._extras = new Map();
        this._detailItem = null;
        this._mediaActor = null;

        this._menu.close(PopupAnimation.NONE);

        this.actor = new St.BoxLayout({
            style_class: 'atelier-cc-tiles atelier-cc-mac',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._modulesBox = new St.BoxLayout({
            style_class: 'atelier-cc-modules-box',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.actor.add_child(this._modulesBox);
        this._gridActor = moduleGrid();
        this._modulesBox.add_child(this._gridActor);
        this._modules = new Map();
        for (const [id, spec] of MODULES) {
            const module = new ControlModule(id, spec);
            this._modules.set(id, module);
            this._gridActor.add_child(module);
        }
        // Background Apps, under the grid when there are any.
        this._footer = new ControlModule('footer', {cols: 4});
        this._footer.x_align = Clutter.ActorAlign.CENTER;
        this._modulesBox.add_child(this._footer);
        this._modules.set('footer', this._footer);
        this._setMediaPlaceholder();

        // The menus: their layer from GNOME's menu, as the page of the one
        // open. (Not under their tiles any more: each in place of the
        // modules.)
        this._detail = new St.Bin({style_class: 'atelier-cc-detail', visible: false, x_expand: true});
        this.actor.add_child(this._detail);
        this._overlayParent = overlay.get_parent();
        this._overlayConstraints = overlay.get_constraints();
        overlay.clear_constraints();
        this._overlayParent.remove_child(overlay);
        this._overlayLayout = overlay.layout_manager;
        overlay.layout_manager = new DetailLayout();
        this._detail.set_child(overlay);
        this._menuConstraints = new Map();
        for (const child of overlay.get_children())
            this._adoptMenuActor(child);
        overlay.connectObject(
            'child-added', (_, child) => this._adoptMenuActor(child),
            'child-removed', (_, child) => this._releaseMenuActor(child),
            this);

        this._header = this._makeHeader();

        // Do Not Disturb as a tile, when GNOME has none (before GNOME 49).
        this._dnd = null;
        if (!grid.get_children().some(child => child.constructor.name === 'DoNotDisturbToggle'))
            this._addDndToggle();

        // GNOME's tiles, in its order (to put them back so), and those that
        // come later, from extensions. (An extension's is put before
        // Background Apps', which is in a module now: before nothing, here.)
        this._order = grid.get_children();
        const host = this;
        this._injections.overrideMethod(this._menu, 'insertItemBefore', original => function (item, sibling, ...rest) {
            if (sibling && sibling.get_parent() !== this._grid) {
                host._siblings.set(item, sibling);
                sibling = null;
            }
            return original.call(this, item, sibling, ...rest);
        });
        grid.connectObject('child-added', (_, child) => this._queueAdopt(child), this);
        for (const child of grid.get_children())
            this._adopt(child);
    }

    _makeHeader() {
        const header = new St.BoxLayout({style_class: 'atelier-cc-detail-header', x_expand: true});
        const back = new St.Button({
            style_class: 'atelier-cc-detail-back',
            accessible_name: 'Back',
            can_focus: true,
            child: new St.Icon({icon_name: 'go-previous-symbolic'}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        back.connect('clicked', () => this.closeMenus(PopupAnimation.FULL));
        header.add_child(back);
        this._headerTitle = new St.Label({
            style_class: 'atelier-cc-detail-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._headerTitle);
        this._switch = new PopupMenu.Switch(false);
        this._switch.reactive = false;
        this._switchButton = new St.Button({
            style_class: 'atelier-cc-detail-switch',
            can_focus: true,
            child: this._switch,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._switchButton.connect('clicked', () => {
            const item = this._detailItem;
            if (item)
                activate(item);
        });
        header.add_child(this._switchButton);
        // (Gone with a menu destroyed while open: made anew for the next.)
        header.connect('destroy', () => {
            if (this._header === header)
                this._header = null;
        });
        return header;
    }

    _addDndToggle() {
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup(DND_SCHEMA, true);
        if (!schema)
            return;
        const settings = new Gio.Settings({schema_id: DND_SCHEMA});
        const toggle = new QuickSettings.QuickToggle({
            title: 'Do Not Disturb',
            iconName: 'notifications-disabled-symbolic',
            toggleMode: true,
        });
        toggle.add_style_class_name('atelier-cc-dnd');
        const sync = () => {
            toggle.checked = !settings.get_boolean('show-banners');
            toggle.subtitle = toggle.checked ? 'On' : null;
        };
        sync();
        settings.connectObject('changed::show-banners', sync, toggle);
        toggle.connect('notify::checked', () => {
            if (settings.get_boolean('show-banners') === toggle.checked)
                settings.set_boolean('show-banners', !toggle.checked);
        });
        this._dnd = {toggle, settings};
        this._place(toggle, ['focus', 'row', 0]);
    }

    // What a tile is, where it goes: [module, kind, rank].
    _classify(item) {
        const qs = this._quickSettings;
        const of = indicator => indicator?.quickSettingsItems?.includes(item) ?? false;
        const name = item.constructor?.name ?? '';
        if (of(qs._network) || of(qs._bluetooth) || of(qs._rfkill))
            return BY_CLASS[name] ?? ['connectivity', 'row', 7];
        if (of(qs._darkMode))
            return BY_CLASS.DarkModeToggle;
        if (of(qs._nightLight))
            return BY_CLASS.NightLightToggle;
        if (of(qs._powerProfiles))
            return BY_CLASS.PowerProfilesToggle;
        if (of(qs._brightness))
            return BY_CLASS.BrightnessItem;
        if (of(qs._backlight))
            return BY_CLASS.KeyboardBrightnessToggle;
        if (item === qs._volumeOutput?._output)
            return BY_CLASS.OutputStreamSlider;
        if (item === qs._volumeInput?._input)
            return BY_CLASS.InputStreamSlider;
        if (item === qs._system?._systemItem)
            return BY_CLASS.SystemItem;
        if (of(qs._backgroundApps))
            return BY_CLASS.BackgroundAppsToggle;
        if (BY_CLASS[name])
            return BY_CLASS[name];
        if (BY_ICON[item.icon_name])
            return BY_ICON[item.icon_name];
        return null;
    }

    _queueAdopt(child) {
        this._pending.add(child);
        if (this._laterId)
            return;
        // (Once GNOME has set its column span: right after adding it.)
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            const pending = [...this._pending];
            this._pending.clear();
            for (const child of pending) {
                if (child.get_parent() === this._grid)
                    this._adopt(child, true);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _adopt(child, late = false) {
        if (child === this._placeholder || this._items.has(child) || !(child instanceof St.Widget))
            return;
        if (late) {
            // Where GNOME (or the extension) put it among its tiles.
            const before = this._siblings.get(child) ?? child.get_next_sibling();
            this._siblings.delete(child);
            const index = before ? this._order.indexOf(before) : -1;
            if (index < 0)
                this._order.push(child);
            else
                this._order.splice(index, 0, child);
        }
        let span = 1;
        try {
            span = this._grid.layout_manager.get_child_meta(this._grid, child)?.column_span ?? 1;
        } catch {
            span = 1;
        }
        let place = this._classify(child);
        if (!place) {
            // An extension's (or one Atelier doesn't know): a square of its
            // own, or a pane wide when it is a slider or GNOME's grid gave it
            // its whole width.
            const wide = child instanceof QuickSettings.QuickSlider || span > 1 ||
                !(child instanceof QuickSettings.QuickToggle || child instanceof QuickSettings.QuickMenuToggle);
            const id = `extra-${this._extras.size}-${GLib.uuid_string_random().slice(0, 4)}`;
            const module = new ControlModule(id, {cols: wide ? 4 : 1});
            module.add_style_class_name(wide ? 'atelier-cc-module-extra-wide' : 'atelier-cc-module-extra');
            this._extras.set(child, module);
            this._gridActor.add_child(module);
            this._modules.set(id, module);
            place = [id, wide ? 'wide' : 'square', 0];
        }
        this._place(child, place, span);
    }

    _place(item, [id, kind, rank], span = 1) {
        const module = this._modules.get(id);
        const tweaks = [];
        const tweak = (actor, props) => {
            if (!actor)
                return;
            for (const [prop, value] of Object.entries(props)) {
                tweaks.push([actor, prop, actor[prop]]);
                actor[prop] = value;
            }
        };
        // GNOME's toggle as a round icon with its name beside it (in a
        // square, only the icon): its box as tall as it needs, centred, so
        // the icon's circle stays round.
        const inner = item._title ? item : item._box?.get_first_child?.();
        if (inner?._box && (item instanceof QuickSettings.QuickToggle || item instanceof QuickSettings.QuickMenuToggle)) {
            tweak(inner._box, {y_align: Clutter.ActorAlign.CENTER});
            if (kind === 'square' || kind === 'compact') {
                tweak(inner._title?.get_parent(), {visible: false});
                tweak(item._box, {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            }
        }
        // (The system buttons and a wide tile in the middle of theirs, as
        // tall as they need: the buttons round.)
        if (kind === 'system' || kind === 'wide')
            tweak(item, {y_align: Clutter.ActorAlign.CENTER});
        const slot = module.addSlot(item, kind, rank);
        item.connectObject(
            'notify::visible', () => module.sync(),
            'destroy', () => this._forget(item),
            this);
        if (item.menu && item.menu !== this._menu) {
            item.menu.connectObject('open-state-changed', (menu, open) => {
                if (open)
                    this._openDetail(item);
                else
                    this._closeDetail(item);
            }, this);
        }
        this._items.set(item, {slot, module, span, tweaks});
    }

    // A tile destroyed (its extension turned off, say) while here.
    _forget(item) {
        const entry = this._items.get(item);
        if (!entry)
            return;
        this._items.delete(item);
        this._order = this._order.filter(a => a !== item);
        if (this._detailItem === item)
            this._closeDetail(item);
        entry.module.removeSlot(entry.slot);
        const extra = this._extras.get(item);
        if (extra) {
            this._extras.delete(item);
            this._modules.delete(extra.moduleId);
            extra.destroy();
        }
    }

    _adoptMenuActor(child) {
        // (Not under its tile any more.)
        const constraints = child.get_constraints().filter(c => c.enabled);
        constraints.forEach(c => (c.enabled = false));
        this._menuConstraints.set(child, constraints);
    }

    _releaseMenuActor(child) {
        const constraints = this._menuConstraints.get(child);
        this._menuConstraints.delete(child);
        constraints?.forEach(c => (c.enabled = true));
    }

    // A tile's menu opened: its page in place of the modules, with a
    // header – back, its name, its switch – in the menu (whose grab takes
    // the clicks in it, and closes it on any other).
    _openDetail(item) {
        if (this._detailItem && this._detailItem !== item)
            this._closeDetail(this._detailItem);
        const menu = item.menu;
        this._detailItem = item;
        this._header ??= this._makeHeader();
        this._headerTitle.text = menu._headerTitle?.text || item.title || item.accessible_name || '';
        const switchable = item instanceof QuickSettings.QuickMenuToggle ||
            (item instanceof QuickSettings.QuickToggle && item.toggle_mode);
        this._switchButton.visible = switchable;
        this._switchBinding = switchable
            ? item.bind_property('checked', this._switch, 'state', GObject.BindingFlags.SYNC_CREATE) : null;
        this._switchButton.accessible_name = this._headerTitle.text;
        this._header.get_parent()?.remove_child(this._header);
        menu.box.insert_child_at_index(this._header, 0);
        const gnomeHeader = menu._header;
        if (gnomeHeader) {
            this._gnomeHeader = {actor: gnomeHeader, visible: gnomeHeader.visible};
            gnomeHeader.visible = false;
            gnomeHeader.connectObject('notify::visible', () => {
                if (gnomeHeader.visible) {
                    this._gnomeHeader.visible = true;
                    gnomeHeader.visible = false;
                }
            }, this);
        }
        menu.box.add_style_class_name('atelier-cc-detail-menu');
        this._modulesBox.hide();
        this._detail.show();
        this.emit('detail-changed');
    }

    _closeDetail(item) {
        if (this._detailItem !== item)
            return;
        this._detailItem = null;
        this._switchBinding?.unbind();
        this._switchBinding = null;
        const menu = item.menu;
        this._header?.get_parent()?.remove_child(this._header);
        if (this._gnomeHeader) {
            const {actor, visible} = this._gnomeHeader;
            this._gnomeHeader = null;
            actor.disconnectObject(this);
            actor.visible = visible;
        }
        menu?.box?.remove_style_class_name('atelier-cc-detail-menu');
        this._detail.hide();
        this._modulesBox.show();
        this.emit('detail-changed');
    }

    /** @returns {boolean} whether a menu's page shows (and not the modules) */
    get detailOpen() {
        return this._detailItem !== null;
    }

    /** @returns {Clutter.Actor|null} the tile whose menu's page shows */
    get detailItem() {
        return this._detailItem;
    }

    /** @returns {St.Widget} the grid of modules */
    get grid() {
        return this._gridActor;
    }

    /** @returns {St.Widget} the page of a menu */
    get detail() {
        return this._detail;
    }

    /** @returns {St.BoxLayout} the open page's header (back, name, switch) */
    get header() {
        return this._header;
    }

    /**
     * @param {string} id - a module's ('connectivity', 'media', 'sound'…)
     * @returns {ControlModule|null}
     */
    module(id) {
        return this._modules.get(id) ?? null;
    }

    /**
     * @param {Clutter.Actor} item - a tile
     * @returns {ControlModule|null} the module it is in
     */
    moduleOf(item) {
        return this._items.get(item)?.module ?? null;
    }

    /**
     * The modules shown, where they are in an ancestor (the page), each
     * with its actor: one, the open menu's page, while that shows.
     *
     * @param {Clutter.Actor} ancestor
     * @returns {{id: string, x: number, y: number, width: number, height: number, radius: number, actor: Clutter.Actor}[]}
     */
    moduleRects(ancestor) {
        if (!this.actor.visible)
            return [];
        const shown = this._detailItem
            ? [['detail', this._detail]]
            : [...this._gridActor.get_children(), this._footer]
                .filter(m => m instanceof ControlModule && m.visible)
                .map(m => [m.moduleId, m]);
        return shown.map(([id, actor]) => {
            const rect = rectIn(actor, ancestor);
            return rect ? {id, ...rect, actor} : null;
        }).filter(Boolean);
    }

    /**
     * Put an actor in the Now Playing module (or, null, its placeholder
     * back). The actor stays its owner's: taken out, not destroyed, when
     * the control centre lets go.
     *
     * @param {Clutter.Actor|null} actor
     */
    setMediaModule(actor) {
        const media = this._modules.get('media');
        for (const slot of [...media.slots]) {
            const child = slot.get_child();
            media.removeSlot(slot);
            if (child && child === this._placeholderActor)
                child.destroy();
        }
        this._placeholderActor = null;
        this._mediaActor = actor;
        if (actor)
            media.addSlot(actor, 'media');
        else
            this._setMediaPlaceholder();
    }

    _setMediaPlaceholder() {
        const box = new St.BoxLayout({
            style_class: 'atelier-cc-media-placeholder',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(new St.Widget({style_class: 'atelier-cc-media-art', x_align: Clutter.ActorAlign.START}));
        box.add_child(new St.Label({style_class: 'atelier-cc-media-title', text: 'Not Playing', y_expand: true,
            y_align: Clutter.ActorAlign.END}));
        this._placeholderActor = box;
        this._modules.get('media').addSlot(box, 'media');
    }

    /**
     * Close a tile's menu that is open (its page goes).
     *
     * @param {number} [animate] - a PopupAnimation
     */
    closeMenus(animate = PopupAnimation.NONE) {
        const open = this._detailItem?.menu ?? this._menu._activeMenu;
        open?.close(animate);
        this._menu._activeMenu?.close(animate);
    }

    /** Give the tiles and the menus' layer back to GNOME's menu. */
    release() {
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        this._pending.clear();
        this.closeMenus();
        if (this._detailItem)
            this._closeDetail(this._detailItem);
        this._injections.clear();
        this._grid.disconnectObject(this);
        this._overlay.disconnectObject(this);
        this.actor.get_parent()?.remove_child(this.actor);

        // The tiles: out of their modules, as they were, back in GNOME's
        // grid in GNOME's order, with their column spans.
        const layout = this._grid.layout_manager;
        const shown = new Map();
        for (const [item, {slot, module, tweaks}] of this._items) {
            shown.set(item, item.visible);
            item.disconnectObject(this);
            item.menu?.disconnectObject?.(this);
            module.removeSlot(slot);
            for (const [actor, prop, value] of tweaks.reverse())
                actor[prop] = value;
        }
        if (this._dnd) {
            this._dnd.settings.disconnectObject(this._dnd.toggle);
            this._items.delete(this._dnd.toggle);
            this._dnd.toggle.destroy();
            this._dnd = null;
        }
        for (const item of this._order) {
            if (this._items.has(item) && !item.get_parent()) {
                this._grid.add_child(item);
                // (Clutter shows one hidden as it is added.)
                item.visible = shown.get(item);
            }
        }
        this._order.filter(a => a.get_parent() === this._grid)
            .forEach((a, i) => this._grid.set_child_at_index(a, i));
        for (const [item, {span}] of this._items) {
            if (item.get_parent() === this._grid && span > 1)
                layout.child_set_property(this._grid, item, 'column-span', span);
        }
        this._items.clear();
        this._extras.clear();
        // (The media module's actor is its owner's.)
        if (this._mediaActor)
            this._modules.get('media').slots.forEach(slot => slot.set_child(null));
        this._mediaActor = null;

        // The menus' layer.
        this._header?.get_parent()?.remove_child(this._header);
        this._header?.destroy();
        this._header = null;
        this._detail.set_child(null);
        for (const child of this._overlay.get_children())
            this._releaseMenuActor(child);
        this._menuConstraints.clear();
        this._overlay.layout_manager = this._overlayLayout;
        this._overlayParent.add_child(this._overlay);
        this._overlayConstraints.forEach(constraint => this._overlay.add_constraint(constraint));

        this.actor.destroy();
        this.actor = null;
    }
});

// Click a tile as St would: a toggle's state flips, then it is clicked.
function activate(item) {
    if (item.toggle_mode)
        item.checked = !item.checked;
    item.emit('clicked', Clutter.BUTTON_PRIMARY);
}
