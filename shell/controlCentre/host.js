// The control centre's Controls tab, as its Layout & Motion spec has it:
// one row of four columns – Wi-Fi, Bluetooth and Airplane pills; Caffeine
// and Output tiles; brightness and volume as tall capsules; the system tile
// (the battery, screenshot, settings, lock, power) – at 0.4 of the spec's
// pixels (lib/ccLayout.js), each tile placed absolutely in its column. A
// pill's or Output's chevron opens it as a card in place, growing over its
// neighbours as they step back (lib/ccLayout.js tileState(): the UI is a
// function of which card is open); a click outside it or Esc closes it.
// The motion is the spec's (lib/ccMotion.js, run by animator.js), turned
// round from wherever it is.
//
// What it shows and does is GNOME's own, through adapters (adapters.js):
// its toggles stay where GNOME has them, unseen (its menu doesn't open
// while the control centre is there). GNOME's brightness and volume
// sliders are shown as capsules (capsule.js), GNOME's own kept off the
// stage meanwhile and put back when the control centre lets go.

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DURATIONS, OPEN_DELAYS, rowDelays} from '../../lib/ccMotion.js';
import {CARDS, INNER, OPEN, ORDER, SIZE, TILES, fitScale, linkSpeed, restRects, tileState, timeLeft,
    toggleOpen, wiredSubtitle} from '../../lib/ccLayout.js';
import {Animator} from './animator.js';
import {dropPending, makeAdapters} from './adapters.js';
import {LevelCapsule} from './capsule.js';
import {rectIn} from './layout.js';
import {ChipRow, FnLayout, ListRow, RoundToggle, Tile, iconOf, place, pressable, px, scaleOf,
    setIcon} from './tiles.js';

// The tiles' shapes.
const SHAPES = {wifi: 'pill', wired: 'pill', bt: 'pill', airplane: 'pill', caffeine: 'tile', output: 'tile',
    brightness: 'slider', volume: 'slider', system: 'tile'};
// Each tile's header: so high (spec px); a card's list starts under it.
const PILL_HEADER = 112;
const OUTPUT_HEADER = 108;
// Rows a list shows at most (the last, "Other network…", "Pair new
// device…", besides).
const MAX_NETWORKS = 3;
const MAX_DEVICES = 3;
// The wired connections the Wired card lists at most (as devices are: two
// lines each), "Wired Settings…" besides.
const MAX_WIRED = 2;
// The Wi-Fi card's mini pills: so high, so far in from its sides and up
// from its foot (spec px).
const MINI = {height: 60, inset: 16, bottom: 14};
// The output list's rows: each this far below the one before (spec px).
const OUTPUT_STEP = 70;
// Caffeine's chips.
const CAFFEINE_CHIPS = ['30 min', '1 h', 'Until off'];
const CAFFEINE_SUBTITLES = ['Awake for 30 min', 'Awake for 1 h', 'Screen stays awake'];
// How far each moves (spec px): a tile as the panel opens, a list's row,
// the mini pills and chips coming in.
const OPEN_DY = -14;
const ROW_DY = 10;
const FOOT_DY = 12;

const coffeeIcon = () => Gio.FileIcon.new(Gio.File.new_for_uri(
    GLib.Uri.resolve_relative(import.meta.url, '../../icons/coffee-symbolic.svg', GLib.UriFlags.NONE)));

export const QuickSettingsHost = GObject.registerClass(
class AtelierQuickSettingsHost extends GObject.Object {
    /**
     * @param {object} quickSettings - Main.panel.statusArea.quickSettings
     */
    _init(quickSettings) {
        super._init();
        this._quickSettings = quickSettings;
        this._open = null;
        // Wired in Wi-Fi's place (Ethernet connected); kept there, turned
        // off from it, until the panel opens again.
        this._wired = false;
        this._wiredKept = false;
        this._connecting = null;
        this._busyDevice = null;
        this._serial = 0;
        this._sliders = new Map();

        this.actor = new St.BoxLayout({
            style_class: 'atelier-cc-tiles atelier-cc-mac',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.grid = new St.Widget({
            style_class: 'atelier-cc-grid',
            layout_manager: new FnLayout((container, box) => this._allocateGrid(box), () => this._gridSize()),
            x_align: Clutter.ActorAlign.CENTER,
            reactive: false,
        });
        this.actor.add_child(this.grid);
        this.animator = new Animator(this.grid);
        this.grid.connect('destroy', () => this.animator.destroy());

        // A click anywhere round an open card (over the whole panel, under
        // the card) closes it.
        this._closeArea = new Clutter.Actor({reactive: true, visible: false});
        this._closeArea.connect('button-press-event', () => {
            this.setOpen(null);
            return Clutter.EVENT_STOP;
        });
        this._closeArea.connect('touch-event', (_, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN)
                this.setOpen(null);
            return Clutter.EVENT_STOP;
        });

        this._tiles = new Map();
        this._build();
        this.grid.add_child(this._closeArea);

        this._adapters = {};
        try {
            this.setAdapters(makeAdapters(quickSettings));
        } catch (e) {
            // (Nothing left behind half made.)
            this.actor.destroy();
            throw e;
        }
        this._applyState({instant: true});

        // (Fitted again to a monitor of another width.)
        Main.layoutManager.connectObject('monitors-changed', () => this.grid.queue_relayout(), this);
    }

    // ---- Building ----

    _build() {
        const a = this.animator;
        // The pills.
        for (const [id, title, icon] of [['wifi', 'Wi-Fi', 'network-wireless-signal-excellent-symbolic'],
            ['wired', 'Wired', 'network-wired-symbolic'], ['bt', 'Bluetooth', 'bluetooth-active-symbolic'], ['airplane', 'Airplane Mode', 'airplane-mode-symbolic']]) {
            const card = id in CARDS;
            const tile = new Tile(id, {shape: 'pill', card});
            const header = new St.BoxLayout({style_class: 'atelier-cc-pill-header', x_expand: true});
            tile.toggle = new RoundToggle(icon, title, a);
            tile.toggle.connect('clicked', () => this._toggleRadio(id));
            header.add_child(tile.toggle);
            const text = new St.BoxLayout({x_expand: true, style_class: 'atelier-cc-pill-text'});
            const lines = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER});
            tile.title = new St.Label({style_class: 'atelier-cc-title', text: title});
            tile.subtitle = new St.Label({style_class: 'atelier-cc-subtitle', text: ''});
            lines.add_child(tile.title);
            lines.add_child(tile.subtitle);
            text.add_child(lines);
            tile.addFocusables(tile.toggle);
            if (card) {
                tile.chevron = iconOf('go-next-symbolic', 'atelier-cc-chevron');
                tile.chevron.y_align = Clutter.ActorAlign.CENTER;
                tile.chevron.set_pivot_point(0.5, 0.5);
                text.add_child(tile.chevron);
                tile.opener = pressable(new St.Button({style_class: 'atelier-cc-opener', child: text, x_expand: true,
                    can_focus: true, accessible_name: title, label_actor: tile.title}), a);
                tile.opener.connect('clicked', () => this.setOpen(toggleOpen(this._open, id)));
                header.add_child(tile.opener);
                tile.addFocusables(tile.opener);
            } else {
                header.add_child(text);
            }
            tile.header = tile.addPart(header, w => [0, 0, w, px(PILL_HEADER)]);
            if (card)
                this._buildList(tile, id);
            this._add(tile);
        }

        // Caffeine.
        {
            const tile = new Tile('caffeine', {shape: 'tile'});
            const header = new St.BoxLayout({style_class: 'atelier-cc-tile-header', x_expand: true});
            tile.toggle = new RoundToggle(coffeeIcon(), 'Caffeine', a);
            tile.toggle.connect('clicked', () => this._adapters.caffeine.setOn(!this._adapters.caffeine.on));
            header.add_child(tile.toggle);
            const lines = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER});
            tile.title = new St.Label({style_class: 'atelier-cc-title', text: 'Caffeine'});
            tile.subtitle = new St.Label({style_class: 'atelier-cc-subtitle'});
            lines.add_child(tile.title);
            lines.add_child(tile.subtitle);
            header.add_child(lines);
            tile.header = tile.addPart(header, w => [0, 0, w, px(OUTPUT_HEADER)]);
            tile.chips = new ChipRow(a, index => this._adapters.caffeine.choose(index));
            tile.chips.setLabels(CAFFEINE_CHIPS);
            tile.addPart(tile.chips, chipsPlace);
            tile.addFocusables(tile.toggle, ...tile.chips.chips);
            this._add(tile);
        }

        // Output.
        {
            const tile = new Tile('output', {shape: 'tile', card: true});
            const header = new St.BoxLayout({style_class: 'atelier-cc-tile-header', x_expand: true});
            const circle = new St.Bin({style_class: 'atelier-cc-round atelier-cc-round-big atelier-cc-round-static',
                y_align: Clutter.ActorAlign.CENTER});
            tile.icon = iconOf('audio-headphones-symbolic', 'atelier-cc-round-icon atelier-cc-round-icon-big');
            circle.set_child(tile.icon);
            header.add_child(circle);
            const lines = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER});
            tile.title = new St.Label({style_class: 'atelier-cc-title', text: 'Output'});
            tile.subtitle = new St.Label({style_class: 'atelier-cc-subtitle'});
            lines.add_child(tile.title);
            lines.add_child(tile.subtitle);
            header.add_child(lines);
            tile.chevron = iconOf('go-next-symbolic', 'atelier-cc-chevron');
            tile.chevron.y_align = Clutter.ActorAlign.CENTER;
            tile.chevron.set_pivot_point(0.5, 0.5);
            header.add_child(tile.chevron);
            tile.opener = pressable(new St.Button({style_class: 'atelier-cc-opener atelier-cc-opener-tile',
                child: header, can_focus: true, accessible_name: 'Output', label_actor: tile.title}), a);
            tile.opener.connect('clicked', () => this.setOpen(toggleOpen(this._open, 'out')));
            tile.header = tile.addPart(tile.opener, w => [0, 0, w, px(OUTPUT_HEADER)]);
            tile.chips = new ChipRow(a, index => this._chooseOutputChip(index));
            tile.addPart(tile.chips, chipsPlace);
            tile.addFocusables(tile.opener, ...tile.chips.chips);
            this._buildList(tile, 'out');
            this._add(tile);
        }

        // Brightness and volume: their slots (the capsules come in them).
        for (const id of ['brightness', 'volume']) {
            const tile = new Tile(id, {shape: 'slider'});
            tile.slot = tile.addPart(new St.Bin({style_class: 'atelier-cc-slider-slot', x_expand: true, y_expand: true}));
            this._add(tile);
        }

        // The system tile.
        {
            const tile = new Tile('system', {shape: 'tile'});
            const box = new St.BoxLayout({style_class: 'atelier-cc-system', orientation: Clutter.Orientation.VERTICAL,
                x_expand: true, y_expand: true});
            const label = new St.BoxLayout({style_class: 'atelier-cc-battery-label'});
            tile.batteryIcon = iconOf('battery-level-90-symbolic', 'atelier-cc-battery-icon');
            tile.batteryIcon.y_align = Clutter.ActorAlign.CENTER;
            tile.batteryTitle = new St.Label({style_class: 'atelier-cc-battery-title', text: 'Battery',
                y_align: Clutter.ActorAlign.CENTER});
            label.add_child(tile.batteryIcon);
            label.add_child(tile.batteryTitle);
            box.add_child(label);
            tile.percent = new St.Label({style_class: 'atelier-cc-battery-percent', text: ''});
            box.add_child(tile.percent);
            tile.timeLeft = new St.Label({style_class: 'atelier-cc-battery-time', text: ''});
            box.add_child(tile.timeLeft);
            tile.bar = new St.Widget({style_class: 'atelier-cc-battery-bar', x_expand: true,
                layout_manager: new FnLayout((container, b) => {
                    const fill = container.get_first_child();
                    place(fill, 0, 0, b.get_width() * (container._fraction ?? 0), b.get_height());
                })});
            tile.bar._fraction = 0;
            tile.bar.add_child(new St.Widget({style_class: 'atelier-cc-battery-fill'}));
            box.add_child(tile.bar);
            box.add_child(new St.Widget({y_expand: true}));
            const buttons = new St.BoxLayout({style_class: 'atelier-cc-system-buttons', x_expand: true});
            tile.buttons = {};
            const names = [['screenshot', 'screenshooter-symbolic', 'Take Screenshot'],
                ['settings', 'applications-system-symbolic', 'Settings'],
                ['lock', 'system-lock-screen-symbolic', 'Lock Screen'],
                ['power', 'system-shutdown-symbolic', 'Power Off Menu']];
            names.forEach(([name, icon, accessible], i) => {
                if (i > 0)
                    buttons.add_child(new St.Widget({x_expand: true}));
                const button = pressable(new St.Button({
                    style_class: `atelier-cc-system-button atelier-cc-system-${name}`,
                    child: iconOf(icon, 'atelier-cc-system-icon'), can_focus: true, accessible_name: accessible,
                    y_align: Clutter.ActorAlign.CENTER,
                }), a);
                button.connect('clicked', () => this._adapters.system.activate(name));
                buttons.add_child(button);
                tile.buttons[name] = button;
                tile.addFocusables(button);
            });
            box.add_child(buttons);
            tile.addPart(box);
            this._add(tile);
        }
    }

    // A card's list (and, Wi-Fi's, its mini pills): placed for the card
    // open, shown only while it is.
    _buildList(tile, key) {
        const a = this.animator;
        const open = OPEN[key];
        const top = key === 'out' ? OUTPUT_HEADER : PILL_HEADER;
        const minis = key === 'wifi' || key === 'wired';
        const bottom = minis ? MINI.height + MINI.bottom + 8 : 14;
        const list = new St.BoxLayout({style_class: `atelier-cc-list atelier-cc-list-${key}`,
            orientation: Clutter.Orientation.VERTICAL, x_expand: true, visible: false});
        tile.rows = new Map();
        tile.placeholder = new St.Label({style_class: 'atelier-cc-list-placeholder', visible: false});
        tile.placeholder.clutter_text.line_wrap = true;
        if (key === 'out') {
            // The outputs: a highlight under the one chosen, sliding to
            // another; its check with it. (All of them: scrolled when more
            // than fit.)
            tile.rowsBox = new St.Widget({style_class: 'atelier-cc-output-rows', x_expand: true,
                layout_manager: new FnLayout((container, b) => this._allocateOutputRows(tile, b),
                    () => [0, px(OUTPUT_STEP) * Math.max(1, tile.rows.size) - px(OUTPUT_STEP - 64)])});
            tile.selection = new St.Widget({style_class: 'atelier-cc-output-pill',
                layout_manager: new Clutter.BinLayout(), opacity: 0});
            tile.selection.add_child(new St.Icon({style_class: 'atelier-cc-row-check', icon_name: 'object-select-symbolic',
                x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER, x_expand: true}));
            tile.rowsBox.add_child(tile.selection);
            const scroll = new St.ScrollView({style_class: 'atelier-cc-list-scroll', x_expand: true, y_expand: true,
                hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true});
            const scrolled = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
            scrolled.add_child(tile.rowsBox);
            if ('child' in scroll)
                scroll.child = scrolled;
            else
                scroll.add_actor(scrolled);
            list.add_child(scroll);
        } else {
            tile.rowsBox = new St.BoxLayout({style_class: 'atelier-cc-rows', orientation: Clutter.Orientation.VERTICAL,
                x_expand: true});
            list.add_child(tile.rowsBox);
        }
        list.add_child(tile.placeholder);
        tile.list = tile.addPart(list, () => [0, px(top), px(open.width), px(open.height - top - bottom)]);
        if (minis) {
            // Bluetooth and Airplane Mode, small, at its foot.
            const foot = new St.BoxLayout({style_class: 'atelier-cc-minis', x_expand: true, visible: false});
            tile.minis = {};
            for (const [id, title, icon] of [['bt', 'Bluetooth', 'bluetooth-active-symbolic'],
                ['airplane', 'Airplane', 'airplane-mode-symbolic']]) {
                const mini = new St.BoxLayout({style_class: 'atelier-cc-mini', x_expand: true});
                const toggle = new RoundToggle(icon, title, a, 'small');
                toggle.connect('clicked', () => this._toggleRadio(id));
                mini.add_child(toggle);
                const lines = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER});
                const label = new St.Label({style_class: 'atelier-cc-mini-title', text: title});
                const subtitle = new St.Label({style_class: 'atelier-cc-mini-subtitle'});
                lines.add_child(label);
                lines.add_child(subtitle);
                mini.add_child(lines);
                foot.add_child(mini);
                tile.minis[id] = {toggle, subtitle};
                tile.addFocusables(toggle);
            }
            tile.foot = tile.addPart(foot, () => [px(MINI.inset), px(open.height - MINI.bottom - MINI.height),
                px(open.width - 2 * MINI.inset), px(MINI.height)]);
        }
    }

    _add(tile) {
        tile._rect = {...TILES[tile.tileId]};
        tile.set_pivot_point(0.5, 0.5);
        this._tiles.set(tile.tileId, tile);
        this.grid.add_child(tile);
    }

    // ---- Adapters ----

    /**
     * Show and act through these adapters (adapters.js; the tests' fakes),
     * in place of those it has.
     *
     * @param {object} adapters - {wifi, wired, bt, airplane, output, caffeine, system}, some
     */
    setAdapters(adapters) {
        for (const [name, adapter] of Object.entries(adapters)) {
            const old = this._adapters[name];
            if (old === adapter)
                continue;
            if (old?._ccChangedId)
                old.disconnect(old._ccChangedId);
            if (old && old !== adapter && !old._keep)
                old.destroy?.();
            this._adapters[name] = adapter;
            adapter._ccChangedId = adapter.connect('changed', () => this._render());
        }
        this._render({instant: true});
    }

    /** @returns {object} the adapters it shows */
    get adapters() {
        return this._adapters;
    }

    // ---- The sliders ----

    /**
     * Show GNOME's slider (its brightness, its volume) as a capsule in its
     * slot, GNOME's own kept off the stage meanwhile.
     *
     * @param {string} id - 'brightness' or 'volume'
     * @param {QuickSettings.QuickSlider|null} item
     */
    takeSlider(id, item) {
        const tile = this._tiles.get(id);
        this._dropSlider(id);
        if (!item?.slider)
            return;
        // (Made once its slot is on the stage: a capsule measures itself as
        // it is made.)
        if (!this.grid.get_stage()) {
            this._pendingSliders ??= new Map();
            this._pendingSliders.set(id, item);
            this.grid.connectObject('stage-views-changed', () => {
                if (!this.grid.get_stage())
                    return;
                this.grid.disconnectObject(this);
                const pending = this._pendingSliders;
                this._pendingSliders = null;
                for (const [key, slider] of pending)
                    this.takeSlider(key, slider);
            }, this);
            return;
        }
        const parent = item.get_parent();
        let span = 1;
        try {
            span = parent?.layout_manager?.get_child_meta(parent, item)?.column_span ?? 1;
        } catch {
            span = 1;
        }
        const entry = {item, parent, index: parent?.get_children().indexOf(item) ?? -1, span};
        parent?.remove_child(item);
        // (No chevron of its own: the Output tile has the outputs.)
        entry.capsule = new LevelCapsule(item, id, {menu: false});
        // (Its chevron, a right click, the Menu key: the Output card.)
        entry.capsule.openMenu = () => this.setOpen('out');
        tile.slot.set_child(entry.capsule);
        const sync = () => {
            // (Without one – no backlight, no sound – its place stays, faint.)
            // (Its slot faint, not the capsule: its own opacity is its own.)
            entry.capsule.reactive = item.visible;
            tile.slot.opacity = item.visible ? 255 : 90;
        };
        sync();
        item.connectObject('notify::visible', sync, 'destroy', () => this._dropSlider(id, false), this);
        tile.addFocusables(entry.capsule);
        this._sliders.set(id, entry);
    }

    _dropSlider(id, putBack = true) {
        const entry = this._sliders.get(id);
        if (!entry)
            return;
        this._sliders.delete(id);
        const tile = this._tiles.get(id);
        tile.focusables = tile.focusables.filter(f => f !== entry.capsule);
        const {item, parent, index, span} = entry;
        item.disconnectObject(this);
        tile.slot.opacity = 255;
        tile.slot.set_child(null);
        entry.capsule.destroy();
        if (!putBack || !parent || item.get_parent())
            return;
        // (Shown or not as GNOME has it now.)
        const visible = item.visible;
        const children = parent.get_children();
        if (index >= 0 && index < children.length)
            parent.insert_child_below(item, children[index]);
        else
            parent.add_child(item);
        // (Clutter shows one hidden as it is added.)
        item.visible = visible;
        if (span > 1)
            parent.layout_manager?.child_set_property?.(parent, item, 'column-span', span);
    }

    /**
     * @param {string} id - 'brightness' or 'volume'
     * @returns {LevelCapsule|null}
     */
    capsule(id) {
        return this._sliders.get(id)?.capsule ?? null;
    }

    // ---- State ----

    /** @returns {string|null} the card open: 'wifi', 'wired', 'bt', 'out' or null */
    get open() {
        return this._open;
    }

    /**
     * @param {string} id - lib/ccLayout.js TILES
     * @returns {Tile|null}
     */
    tile(id) {
        return this._tiles.get(id) ?? null;
    }

    /**
     * Open a card (or none: null), the spec's way.
     *
     * @param {string|null} key - 'wifi', 'wired', 'bt', 'out' or null
     * @param {object} [options]
     * @param {boolean} [options.instant]
     */
    setOpen(key, {instant = false} = {}) {
        if (key !== null && !(key in OPEN))
            return;
        // (Not the card of the pill away.)
        if (key === (this._wired ? 'wifi' : 'wired'))
            key = null;
        if (key === this._open && !instant)
            return;
        const was = this._open;
        this._open = key;
        this._adapters.wifi?.watchNetworks?.(key === 'wifi');
        this._applyState({instant, was});
        if (key === null && was && !instant) {
            // (Esc, and the close area: the keyboard back on its chevron.)
            const opener = this._tiles.get(CARDS[was])?.opener;
            if (opener && global.stage.key_focus && this.grid.contains(global.stage.key_focus))
                opener.grab_key_focus();
        }
    }

    // Every tile as the state has it (lib/ccLayout.js tileState()).
    _applyState({instant = false, was = null} = {}) {
        const a = this.animator;
        const open = this._open;
        const k = px(1);
        for (const id of ORDER) {
            const tile = this._tiles.get(id);
            const state = tileState(id, open, {wired: this._wired});
            const rect = tile._rect;
            if (['x', 'y', 'width', 'height'].some(name => rect[name] !== state[name]) ||
                a.targetOf(rect, 'width') !== undefined) {
                a.ease(rect, {x: state.x, y: state.y, width: state.width, height: state.height},
                    {curve: 'morph', duration: DURATIONS.morph, instant,
                        onUpdate: () => this._moved()});
            }
            // Stepped back (hidden or dimmed) or not: its pivot set as it
            // goes there, kept as it comes back.
            if (state.scale !== 1)
                tile.set_pivot_point(state.pivotX, state.pivotY);
            const dimmed = state.opacity > 0 && state.opacity < 1;
            // (The pill away – Wi-Fi's or Wired's, in one place – gone
            // once it has faded: not taking the other's clicks.)
            const away = id === (this._wired ? 'wifi' : 'wired');
            if (!away)
                tile.show();
            a.ease(tile, {opacity: Math.round(state.opacity * 255)},
                {curve: 'fade', duration: dimmed ? DURATIONS.dimFade : DURATIONS.hideFade, instant,
                    onDone: away ? finished => finished && this._wired === (id === 'wifi') && tile.hide() : null});
            a.ease(tile, {translation_y: state.dy * k, scale: state.scale},
                {curve: 'morph', duration: dimmed ? DURATIONS.dimMove : DURATIONS.hideMove, instant});
            tile.setInert(state.inert);
            if (tile.raised) {
                a.ease(tile.raised, {opacity: state.raised ? 255 : 0},
                    {curve: 'fade', duration: DURATIONS.raisedBg, instant});
                a.ease(tile.glass, {opacity: state.raised ? 0 : 255},
                    {curve: 'fade', duration: DURATIONS.raisedBg, instant});
                a.ease(tile.chevron, {rotation_angle_z: state.chevron},
                    {curve: 'spring', duration: DURATIONS.chevron, instant});
                if (state.raised)
                    tile.opener.add_accessible_state(Atk.StateType.EXPANDED);
                else
                    tile.opener.remove_accessible_state(Atk.StateType.EXPANDED);
            }
        }
        // The card opening: on top, the close area under it. (No shadow
        // under it: a soft one, moved with it, cost each frame twice what
        // the rest of it does.)
        const cardId = open ? CARDS[open] : null;
        const card = cardId ? this._tiles.get(cardId) : null;
        const closing = was ? this._tiles.get(CARDS[was]) : null;
        if (card) {
            this.grid.set_child_above_sibling(card, null);
            this.grid.set_child_below_sibling(this._closeArea, card);
            this._closeArea.show();
            this._showList(card, open, instant);
        } else {
            this._closeArea.hide();
        }
        if (closing && closing !== card) {
            // (Its list goes at once; it shrinks back over the others.)
            this._hideList(closing, was, instant);
            if (!card)
                this.grid.set_child_above_sibling(closing, null);
        }
    }

    // A card's rect moved this frame: laid out anew.
    _moved() {
        this.grid.queue_relayout();
    }

    // A card's list (its rows coming in one after another) and what goes
    // while it is open.
    _showList(tile, key, instant) {
        tile.list.show();
        this._renderList(tile, key, {instant: true});
        const rows = this._listRows(tile);
        const delays = key === 'out' ? rowDelays(rows.length, {first: 80, lastApart: false}) : rowDelays(rows.length);
        rows.forEach((row, i) => {
            this.animator.ease(row, {opacity: 255, translation_y: 0, scale: 1},
                {curve: 'enter', duration: DURATIONS.row, delay: delays[i], instant,
                    from: {opacity: 0, translation_y: px(ROW_DY), scale: 0.97}});
        });
        if (tile.foot) {
            tile.foot.show();
            this.animator.ease(tile.foot, {opacity: 255, translation_y: 0},
                {curve: 'enter', duration: DURATIONS.miniPills, delay: 280, instant,
                    from: {opacity: 0, translation_y: px(FOOT_DY)}});
        }
        if (tile.chips) {
            this.animator.stop(tile.chips);
            tile.chips.hide();
        }
    }

    _hideList(tile, key, instant) {
        for (const row of this._listRows(tile))
            this.animator.stop(row);
        tile.list.hide();
        if (tile.foot) {
            this.animator.stop(tile.foot);
            tile.foot.hide();
        }
        if (tile.chips) {
            tile.chips.show();
            this.animator.ease(tile.chips, {opacity: 255, translation_y: 0},
                {curve: 'enter', duration: DURATIONS.chipsBack, instant,
                    from: {opacity: 0, translation_y: px(FOOT_DY)}});
        }
    }

    _listRows(tile) {
        return [...tile.rowsBox.get_children()].filter(c => c instanceof ListRow && c.visible);
    }

    // ---- What it shows ----

    _render({instant = false} = {}) {
        const {wifi, wired, bt, airplane, output, caffeine, system} = this._adapters;
        if (!wifi || !bt || !airplane || !output || !caffeine || !system)
            return;
        const animate = !instant;
        // Wired in Wi-Fi's place, or Wi-Fi back: one crossfaded to the
        // other, stepping back as a card's neighbours do.
        if (!wired?.available || wired.on)
            this._wiredKept = false;
        const showWired = Boolean(wired?.available && (wired.on || wired.connecting || this._wiredKept));
        if (showWired !== this._wired) {
            this._wired = showWired;
            const was = this._open;
            if (was === 'wifi' || was === 'wired') {
                this._open = null;
                this._adapters.wifi?.watchNetworks?.(false);
            }
            this._applyState({instant, was: this._open === null ? was : null});
        }
        if (wired) {
            const wiredTile = this._tiles.get('wired');
            wiredTile.toggle.setOn(wired.on, animate);
            wiredTile.subtitle.text = wiredSubtitle(wired);
            wiredTile.toggle.reactive = wired.available;
        }
        // The pills.
        const wifiTile = this._tiles.get('wifi');
        const network = wifi.networks.find(n => n.connected);
        wifiTile.toggle.setOn(wifi.on, animate);
        wifiTile.subtitle.text = this._connecting !== null ? 'Connecting…'
            : !wifi.available ? 'Unavailable'
                : !wifi.on ? 'Off'
                    : network ? `${network.name}${network.secure ? ' · secured' : ''}` : 'Not connected';
        wifiTile.toggle.reactive = wifi.available;
        const btTile = this._tiles.get('bt');
        btTile.toggle.setOn(bt.on, animate);
        btTile.subtitle.text = this._busyDevice !== null ? 'Connecting…'
            : !bt.available ? 'Unavailable' : !bt.on ? 'Off' : bt.connectedName || 'On';
        btTile.toggle.reactive = bt.available;
        const airTile = this._tiles.get('airplane');
        airTile.toggle.setOn(airplane.on, animate);
        airTile.subtitle.text = !airplane.available ? 'Unavailable' : airplane.on ? 'On' : 'Off';
        airTile.toggle.reactive = airplane.available;
        for (const [id, adapter] of [['bt', bt], ['airplane', airplane]]) {
            for (const pill of ['wifi', 'wired']) {
                const mini = this._tiles.get(pill).minis[id];
                mini.toggle.setOn(adapter.on, animate);
                mini.toggle.reactive = adapter.available;
                mini.subtitle.text = this._tiles.get(id).subtitle.text;
            }
        }

        // Caffeine.
        const caffeineTile = this._tiles.get('caffeine');
        caffeineTile.toggle.setOn(caffeine.on, animate);
        const choice = caffeine.choice;
        caffeineTile.subtitle.text = caffeine.on ? CAFFEINE_SUBTITLES[choice ?? 2] : 'Off';
        caffeineTile.chips.select(choice ?? -1, {shown: caffeine.on, animate});

        // Output: up to three outputs on its chips, the one chosen.
        const outputTile = this._tiles.get('output');
        const devices = output.devices;
        const active = devices.find(d => d.id === output.activeId) ?? null;
        outputTile.subtitle.text = active?.name ?? (devices.length ? '' : 'No output');
        setIcon(outputTile.icon, active?.icon ?? 'audio-speakers-symbolic');
        const chips = devices.slice(0, 3);
        outputTile.chips.setLabels(chips.map(d => d.short));
        outputTile.chips.select(chips.findIndex(d => d === active), {animate});

        // The system tile.
        const systemTile = this._tiles.get('system');
        const battery = system.battery;
        systemTile.batteryTitle.text = battery.present ? 'Battery' : 'Power';
        setIcon(systemTile.batteryIcon, battery.present
            ? `battery-level-${Math.min(100, Math.round(battery.percent / 10) * 10)}${battery.discharging ? '' : '-charging'}-symbolic`
            : 'ac-adapter-symbolic');
        systemTile.percent.text = battery.present ? `${battery.percent} %` : 'AC';
        const left = battery.present ? timeLeft(battery) : '';
        systemTile.timeLeft.text = battery.present ? left || (battery.charged ? 'Fully charged' : 'Charging')
            : 'No battery';
        systemTile.bar.visible = battery.present;
        systemTile.bar._fraction = battery.percent / 100;
        systemTile.bar.queue_relayout();
        for (const [name, button] of Object.entries(systemTile.buttons)) {
            button.reactive = system.shows(name);
            button.opacity = system.shows(name) ? 255 : 90;
        }

        // The card open: its list as it is now.
        if (this._open) {
            const card = this._tiles.get(CARDS[this._open]);
            this._renderList(card, this._open, {instant});
        }
    }

    // A card's rows, kept by what each is (each updated in place: its
    // highlight fades as it is connected or connecting).
    _renderList(tile, key, {instant = false} = {}) {
        const animate = !instant;
        let rows = [];
        let placeholder = '';
        if (key === 'wifi') {
            const wifi = this._adapters.wifi;
            if (!wifi.on || !wifi.available) {
                placeholder = wifi.available ? 'Wi-Fi is off. Turn it on to see networks.' : 'No Wi-Fi adapter.';
            } else {
                rows = wifi.networks.slice(0, MAX_NETWORKS).map(n => {
                    const connecting = this._connecting === n.id;
                    return {id: `net:${n.id}`, kind: 'network', icon: n.icon, title: n.name,
                        note: connecting ? 'Connecting…' : n.connected && this._connecting === null ? 'Connected' : '',
                        check: n.connected && this._connecting === null, spinning: connecting,
                        lit: connecting || (n.connected && this._connecting === null),
                        activate: () => this._connectNetwork(n.id)};
                });
                rows.push({id: 'other', kind: 'action', icon: 'list-add-symbolic', title: 'Other network…',
                    activate: () => wifi.openSettings()});
            }
        } else if (key === 'wired') {
            const wired = this._adapters.wired;
            if (!wired?.available) {
                placeholder = 'No cable connected.';
            } else {
                rows = wired.connections.slice(0, MAX_WIRED).map(c => {
                    const fast = c.active ? linkSpeed(c.speed) : '';
                    return {id: `wire:${c.id}`, kind: 'device', icon: 'network-wired-symbolic', title: c.name,
                        subtitle: c.connecting ? 'Connecting…' : c.active ? ['Connected', fast].filter(Boolean).join(' · ')
                            : c.device,
                        check: c.active, spinning: c.connecting, lit: c.active || c.connecting,
                        activate: () => wired.activate(c.id)};
                });
            }
            rows.push({id: 'wired-settings', kind: 'action', icon: 'preferences-system-symbolic', title: 'Wired Settings…',
                activate: () => wired?.openSettings()});
        } else if (key === 'bt') {
            const bt = this._adapters.bt;
            if (!bt.on || !bt.available) {
                placeholder = bt.available ? 'Bluetooth is off. Turn it on to see devices.' : 'No Bluetooth adapter.';
            } else {
                rows = bt.devices.slice(0, MAX_DEVICES).map(d => {
                    const busy = this._busyDevice === d.id;
                    const connected = d.connected && !busy;
                    return {id: `dev:${d.id}`, kind: 'device', icon: d.icon, title: d.name,
                        subtitle: busy ? 'Connecting…' : connected
                            ? `Connected${d.battery !== null ? ` · ${d.battery} %` : ''}` : 'Paired',
                        check: connected, spinning: busy, lit: busy || connected,
                        activate: () => this._connectDevice(d.id)};
                });
                rows.push({id: 'pair', kind: 'action', icon: 'list-add-symbolic', title: 'Pair new device…',
                    activate: () => bt.openSettings()});
            }
        } else {
            const output = this._adapters.output;
            rows = output.devices.map(d => ({id: `out:${d.id}`, kind: 'output', icon: d.icon, title: d.name,
                subtitle: d.detail ?? '', activate: () => output.select(d.id)}));
            if (!rows.length)
                placeholder = 'No sound output.';
        }
        tile.placeholder.text = placeholder;
        tile.placeholder.visible = placeholder !== '';
        const keep = new Set(rows.map(r => r.id));
        for (const [id, row] of tile.rows) {
            if (!keep.has(id)) {
                this.animator.stop(row);
                row.destroy();
                tile.rows.delete(id);
            }
        }
        rows.forEach((spec, i) => {
            let row = tile.rows.get(spec.id);
            if (!row) {
                row = new ListRow(spec.kind, this.animator);
                row.connect('clicked', () => row._activate?.());
                tile.rows.set(spec.id, row);
                tile.rowsBox.add_child(row);
                tile.addFocusables(row);
                row.connect('destroy', () => (tile.focusables = tile.focusables.filter(f => f !== row)));
            }
            row._activate = spec.activate;
            row.update(spec, animate);
            tile.rowsBox.set_child_at_index(row, key === 'out' ? i + 1 : i);
        });
        if (key === 'out') {
            const index = this._adapters.output.devices.findIndex(d => d.id === this._adapters.output.activeId);
            tile._selected = index;
            const to = Math.max(0, index) * px(OUTPUT_STEP);
            this.animator.ease(tile.selection, {translation_y: to},
                {curve: 'slide', duration: DURATIONS.select, instant: instant || tile.selection.opacity === 0});
            this.animator.ease(tile.selection, {opacity: index >= 0 ? 255 : 0},
                {curve: 'fade', duration: DURATIONS.selectColour, instant});
            tile.rowsBox.queue_relayout();
        }
    }

    _allocateOutputRows(tile, box) {
        const width = box.get_width();
        const step = px(OUTPUT_STEP);
        const height = px(64);
        place(tile.selection, 0, 0, width, height);
        let i = 0;
        for (const row of tile.rowsBox.get_children()) {
            if (row === tile.selection || !row.visible)
                continue;
            place(row, 0, i * step, width, height);
            i++;
        }
    }

    _chooseOutputChip(index) {
        const device = this._adapters.output.devices[index];
        if (device)
            this._adapters.output.select(device.id);
    }

    // The radios, the spec's way: Airplane on turns Wi-Fi and Bluetooth off
    // (GNOME's rfkill does); Wi-Fi or Bluetooth on turns Airplane off.
    _toggleRadio(id) {
        const {wifi, wired, bt, airplane} = this._adapters;
        if (id === 'wired') {
            // (Not a radio: Airplane Mode leaves it be. Turned off here, it
            // stays in Wi-Fi's place to turn on again.)
            if (wired?.on)
                this._wiredKept = true;
            wired?.setOn(!wired.on);
            return;
        }
        if (id === 'airplane') {
            airplane.setOn(!airplane.on);
            return;
        }
        const adapter = id === 'wifi' ? wifi : bt;
        const on = !adapter.on;
        if (on && airplane.on)
            airplane.setOn(false);
        adapter.setOn(on);
    }

    async _connectNetwork(id) {
        if (this._connecting !== null)
            return;
        const network = this._adapters.wifi.networks.find(n => n.id === id);
        if (!network || network.connected)
            return;
        this._connecting = id;
        const serial = this._serial;
        this._render();
        await this._adapters.wifi.join(id);
        if (serial !== this._serial)
            return;
        this._connecting = null;
        this._render();
    }

    async _connectDevice(id) {
        if (this._busyDevice !== null)
            return;
        const device = this._adapters.bt.devices.find(d => d.id === id);
        if (!device || device.connected)
            return;
        this._busyDevice = id;
        const serial = this._serial;
        this._render();
        await this._adapters.bt.join(id);
        if (serial !== this._serial)
            return;
        this._busyDevice = null;
        this._render();
    }

    // ---- The panel ----

    /**
     * The panel opening: every tile comes in from a little above, small and
     * clear, one after another (the spec's delays).
     */
    playOpen() {
        this._wiredKept = false;
        this._render({instant: true});
        this.setOpen(null, {instant: true});
        const k = px(1);
        for (const id of ORDER) {
            const tile = this._tiles.get(id);
            // (Not the pill away: Wi-Fi's or Wired's.)
            if (tileState(id, null, {wired: this._wired}).opacity === 0)
                continue;
            tile.set_pivot_point(0.5, 0.5);
            this.animator.ease(tile, {opacity: 255, translation_y: 0, scale: 1},
                {curve: 'open', duration: DURATIONS.open, delay: OPEN_DELAYS[id],
                    from: {opacity: 0, translation_y: OPEN_DY * k, scale: 0.94}});
        }
    }

    /** Back at rest, at once: no card open, nothing moving. */
    rest() {
        this.setOpen(null, {instant: true});
        this.animator.finish();
    }

    /**
     * Esc closes a card open (the keyboard back on its chevron).
     *
     * @param {Clutter.Event} event
     * @returns {boolean} whether it did
     */
    handleKeyPress(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape && this._open) {
            this.setOpen(null);
            return true;
        }
        return false;
    }

    // ---- Layout ----

    // The panel's inner area at Atelier's size – and smaller where the
    // monitor is too narrow for it (the grid scaled down as one).
    _fit() {
        const monitor = Main.layoutManager.primaryMonitor;
        const scale = scaleOf();
        // (The panel's padding and the island's margins round it.)
        const room = monitor ? monitor.width / scale - 2 * 24 * SIZE : 0;
        return fitScale(room);
    }

    _gridSize() {
        const fit = this._fit();
        return [px(INNER.width) * fit, px(INNER.height) * fit];
    }

    _allocateGrid(box) {
        const fit = this._fit();
        if (Math.abs(this.grid.scale_x - fit) > 1e-3) {
            this.grid.set_pivot_point(0, 0);
            this.grid.set_scale(fit, fit);
        }
        const k = px(1);
        for (const child of this.grid) {
            if (child instanceof Tile) {
                const r = child._rect;
                place(child, Math.round(r.x * k), Math.round(r.y * k), Math.round(r.width * k),
                    Math.round(r.height * k));
            }
        }
        place(this._closeArea, 0, 0, px(INNER.width), px(INNER.height));
    }

    /**
     * The tiles where they rest, in an ancestor (the page), each with its
     * actor and radius – for the tests and the page's modules (their type
     * keeps to the spec's: not turned light or dark for what is behind
     * them, shell/controlCentre/ink.js).
     *
     * @param {Clutter.Actor} ancestor
     * @returns {{id: string, x: number, y: number, width: number, height: number, radius: number,
     *   actor: Clutter.Actor, ink: boolean}[]}
     */
    moduleRects(ancestor) {
        const grid = rectIn(this.grid, ancestor);
        if (!this.actor?.visible || !grid)
            return [];
        const fit = this.grid.scale_x;
        const k = px(1) * fit;
        return restRects(this._wired).map(r => ({
            id: r.id, x: grid.x + r.x * k, y: grid.y + r.y * k, width: r.width * k, height: r.height * k,
            radius: r.radius * k, actor: this._tiles.get(r.id), ink: false,
        }));
    }

    /** Give GNOME's sliders back and let go of everything. */
    release() {
        this._serial++;
        dropPending();
        Main.layoutManager.disconnectObject(this);
        this.grid.disconnectObject(this);
        this._pendingSliders = null;
        for (const id of [...this._sliders.keys()])
            this._dropSlider(id);
        for (const adapter of Object.values(this._adapters)) {
            if (adapter._ccChangedId)
                adapter.disconnect(adapter._ccChangedId);
            adapter._ccChangedId = 0;
            adapter.destroy?.();
        }
        this._adapters = {};
        this.animator.finish();
        this.actor.get_parent()?.remove_child(this.actor);
        this.actor.destroy();
        this.actor = null;
    }
});

// The chips' row at the foot of a tile.
function chipsPlace(width, height) {
    return [px(24), height - px(24) - px(44), width - 2 * px(24), px(44)];
}
