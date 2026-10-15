// The widgets on the lock screen: clocks (and the date) placed anywhere on
// the main monitor, on the same grid as the desktop's widgets, laid out in
// the lockscreen settings' widgets. On the lock screen they only show – a
// click goes through to GNOME's lock screen, which brings up the prompt;
// in the editor (a mock lock screen in the session, see preview.js) they
// are moved and stretched as on the desktop. When the password is asked,
// they make room for the prompt.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    LOCK_KINDS, cellOrigin, findSpot, fitLayout, fits, gridOrigin, gridSize,
    nearestSize, nearestSpot, newId, nextSize, parseLayout, placeAt, serializeLayout,
} from '../../lib/widgets.js';
import {ClockWidget, DateWidget} from '../desktop/kinds/time.js';

const WIDGETS = {clock: ClockWidget, date: DateWidget};
const DIMMED = 0.25; // what is left of the widgets while the prompt is up
const SMALLEST = 0.35; // how small a clock gets to go up over the popup
const SHIFT_TIME = 250; // moving on when the popup changes size
const MOVED = ['translation_x', 'translation_y', 'scale_x', 'scale_y'];

export class LockBoard {
    /**
     * @param {Gio.Settings} settings - the lockscreen ones
     * @param {object} [options]
     * @param {boolean} [options.interactive] - the widgets take clicks (in the editor)
     */
    constructor(settings, {interactive = false} = {}) {
        this._settings = settings;
        this._interactive = interactive;
        /** The kinds there are here, with their sizes (the editor's catalog). */
        this.catalog = LOCK_KINDS;
        this.kinds = new Map(Object.entries(WIDGETS));
        this._widgets = new Map();
        this._layout = [];
        this._saving = false;
        this._gone = false;
        this._look = null;
        this.layer = new St.Widget({reactive: false});
        // (On the lock screen, it goes with the lock screen's dialog.)
        this.layer.connect('destroy', () => {
            this._widgets.clear();
            this._gone = true;
        });
        // What the widgets read: nothing here opens an app or the network.
        this._context = {
            style: () => (this._look === 'analogue' ? 'analogue' : 'modern'),
            sources: {},
            claude: () => null,
            openSettings: () => {},
            locked: !interactive,
        };
        settings.connectObject(
            'changed::widgets', () => !this._saving && this._load(),
            'changed::style', () => this._syncLook(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._syncArea();
            this._place();
        }, this);
        this._syncArea();
        this._syncLook();
    }

    /** @returns {DesktopWidget[]} */
    get widgets() {
        return [...this._widgets.values()];
    }

    /** @returns {object} {x, y, width, height}: the main monitor, in pixels */
    get area() {
        return this._area;
    }

    /** @returns {number[]} [columns, rows] */
    get grid() {
        return this._grid;
    }

    /** @returns {number[]} [x, y] of the first cell in the area, logical pixels */
    get origin() {
        return this._origin;
    }

    /** @returns {null} (no Claude Code widget here) */
    get claudeIcon() {
        return null;
    }

    // The whole main monitor: the lock screen has no panels to keep clear of.
    _syncArea() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._area = {x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height};
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._grid = gridSize(monitor.width / scale, monitor.height / scale);
        this._origin = gridOrigin(monitor.width / scale, monitor.height / scale);
        this.layer.set_size(monitor.width, monitor.height);
    }

    // Bare (just the clocks' faces on the wallpaper), or cards as on the
    // desktop. The widgets are built anew: a clock's face may follow it.
    _syncLook() {
        const look = this._settings.get_string('style');
        if (look === this._look)
            return;
        this._look = look;
        const cards = look === 'modern' || look === 'analogue';
        this.layer.set_style_class_name(
            `atelier-desktop atelier-lock-widgets ${cards ? `atelier-desktop-${look}` : 'atelier-lock-bare'}`);
        this._load();
    }

    _load() {
        this._widgets.forEach(widget => widget.destroy());
        this._widgets.clear();
        this._layout = parseLayout(this._settings.get_string('widgets'), LOCK_KINDS);
        for (const entry of this._layout)
            this._createWidget(entry);
        this._place();
    }

    _createWidget(entry) {
        const Kind = this.kinds.get(entry.kind);
        if (!Kind)
            return null;
        const widget = new Kind(entry, this._context);
        // (On the lock screen a click goes through to GNOME's.)
        widget.reactive = this._interactive;
        this.layer.add_child(widget);
        this._widgets.set(entry.id, widget);
        this._editor?.adopt(widget);
        return widget;
    }

    /**
     * Make room for the prompt in the middle, as it comes up: the widgets
     * dim. Over them, with the lock screen's own popup, a clock of hours
     * over minutes stays bright, its minutes go beside its hours as on a
     * digital clock, and it goes up over the popup if it is still in its
     * way (smaller, if it has to be, to fit under the island).
     *
     * @param {number} progress - from the clock (0) to the prompt (1)
     * @param {number[]|null} popup - [x, y, width, height] in the layer;
     *   null for GNOME's own prompt
     * @param {number} top - how high a clock may go, in the layer
     * @param {number} gap - kept between the clock and the popup, pixels
     * @param {boolean} [animate] - eased, for a change of the popup (not
     *   following the progress)
     */
    makeRoom(progress, popup, top, gap, animate = false) {
        const dim = Math.round(255 * (1 - (1 - DIMMED) * progress));
        this.layer.opacity = popup ? 255 : dim;
        for (const widget of this.widgets) {
            widget.setInline?.(popup ? progress : 0);
            const room = popup ? this._roomFor(widget, popup, top, gap) : null;
            widget.opacity = !popup || room ? 255 : dim;
            this._shift(widget, room, progress, animate);
        }
    }

    // Where a stacked clock goes, for the popup (its minutes beside its
    // hours by then): as it is if it is out of its way, otherwise over it,
    // in the middle. Null for anything else.
    _roomFor(widget, [x, y, width, height], top, gap) {
        const clock = widget.stacked;
        if (!clock)
            return null;
        // (Where it is laid out, however it is moved now.)
        const own = widget.get_allocation_box();
        let [left, upper] = [0, 0];
        for (let actor = clock; actor && actor !== widget; actor = actor.get_parent()) {
            const box = actor.get_allocation_box();
            left += box.x1;
            upper += box.y1;
        }
        const [w, h] = [clock.width, widget.stackedHeight(1)];
        const bottom = y - gap;
        const [cx, cy] = [own.x1 + left + w / 2, own.y1 + upper + h / 2];
        const inTheWay = cx - w / 2 < x + width && cx + w / 2 > x && cy + h / 2 > bottom && cy - h / 2 < y + height;
        if (!inTheWay || own.get_width() <= 0 || own.get_height() <= 0)
            return {dx: 0, dy: 0, scale: 1};
        const scale = Math.max(SMALLEST, Math.min(1, (bottom - top) / h));
        return {
            dx: x + width / 2 - cx,
            dy: bottom - h * scale / 2 - cy,
            scale,
            pivot: [(left + w / 2) / own.get_width(), (upper + h / 2) / own.get_height()],
        };
    }

    _shift(widget, room, progress, animate) {
        const {dx = 0, dy = 0, scale = 1, pivot} = room ?? {};
        if (pivot)
            widget.set_pivot_point(...pivot);
        const s = 1 + (scale - 1) * progress;
        const values = {translation_x: dx * progress, translation_y: dy * progress, scale_x: s, scale_y: s};
        if (animate) {
            widget.ease({...values, duration: SHIFT_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            MOVED.forEach(name => widget.remove_transition(name));
            widget.set(values);
        }
    }

    // Each widget at its cells, as far as the screen allows (only shown:
    // the layout stays as it was placed until it is edited).
    _place() {
        if (!this._grid)
            return;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        for (const entry of fitLayout(this._layout, this._grid)) {
            const widget = this._widgets.get(entry.id);
            if (!widget)
                continue;
            widget.entry = {...widget.entry, x: entry.x, y: entry.y};
            const [x, y] = cellOrigin(entry.x, entry.y, this._origin).map(v => v * scale);
            widget.set_position(x, y);
        }
    }

    _save() {
        this._saving = true;
        this._settings.set_string('widgets', serializeLayout(this._layout));
        this._saving = false;
    }

    // A widget placed (or given a size) on the screen there is now.
    _keep({id, kind, size, x, y}) {
        const stored = this._layout.find(e => e.id === id);
        const kept = placeAt({...stored ?? {id, kind}, size}, x, y, this._grid);
        this._layout = stored ? this._layout.map(e => (e === stored ? kept : e)) : [...this._layout, kept];
        this._save();
    }

    // The layout as shown, for editing it.
    _shownLayout() {
        const unknown = this._layout.filter(entry => !this._widgets.has(entry.id));
        return [...unknown, ...this.widgets.map(widget => ({
            ...this._layout.find(e => e.id === widget.entry.id),
            x: widget.entry.x, y: widget.entry.y, size: widget.entry.size,
        }))];
    }

    // What the editor (shell/desktop/editor.js) asks of a board, as the
    // desktop has it.

    /** @param {DesktopEditor|null} editor - while it edits this board */
    set editor(editor) {
        this._editor = editor;
    }

    restoreLayer() {
        this._home?.add_child(this.layer);
        this.layer.set_position(0, 0);
    }

    /**
     * Where the layer goes back when the editor is done with it.
     *
     * @param {Clutter.Actor} home
     */
    setHome(home) {
        this._home = home;
        this.layer.get_parent()?.remove_child(this.layer);
        home.add_child(this.layer);
    }

    stopEditing() {
        this.onStopEditing?.();
    }

    addWidget(kind, options = {}, at = null) {
        if (!LOCK_KINDS[kind] || !this.kinds.has(kind))
            return null;
        const layout = this._shownLayout();
        const entry = {id: newId(layout, kind), kind, size: LOCK_KINDS[kind].sizes[0], ...options};
        const spot = at && fits(layout, {...entry, ...at}, this._grid) ? at : findSpot(layout, entry, this._grid);
        if (!spot)
            return null;
        this._keep({...entry, ...spot});
        if (Object.keys(options).length > 0) {
            this._layout = this._layout.map(e => (e.id === entry.id ? {...e, ...options} : e));
            this._save();
        }
        const widget = this._createWidget({...entry, ...spot});
        this._place();
        return widget;
    }

    makeWidget(kind, options = {}) {
        const Kind = this.kinds.get(kind);
        if (!Kind)
            return null;
        const look = new St.Widget({style_class: this.layer.get_style_class_name()});
        const widget = new Kind({id: `new-${kind}`, kind, size: LOCK_KINDS[kind].sizes[0], x: 0, y: 0, ...options},
            this._context);
        widget.reactive = false;
        look.add_child(widget);
        look.widget = widget;
        return look;
    }

    spotForNew(kind, fx, fy) {
        if (!LOCK_KINDS[kind])
            return null;
        const layout = this._shownLayout();
        const entry = {id: '', kind, size: LOCK_KINDS[kind].sizes[0]};
        const spot = nearestSpot(layout, entry, this._grid, fx, fy);
        return Number.isInteger(spot.x) && fits(layout, {...entry, ...spot}, this._grid) ? spot : null;
    }

    removeWidget(id) {
        const widget = this._widgets.get(id);
        if (!widget)
            return;
        this._layout = this._layout.filter(entry => entry.id !== id);
        this._widgets.delete(id);
        widget.destroy();
        this._save();
    }

    resizeWidget(id) {
        const widget = this._widgets.get(id);
        if (!widget)
            return false;
        const layout = this._shownLayout();
        const entry = layout.find(e => e.id === id);
        const sizes = LOCK_KINDS[entry.kind].sizes;
        for (let size = nextSize(entry.kind, entry.size, LOCK_KINDS), n = 1; n < sizes.length;
            size = nextSize(entry.kind, size, LOCK_KINDS), n++) {
            let resized = {...entry, size};
            if (!fits(layout, resized, this._grid)) {
                const spot = findSpot(layout, resized, this._grid);
                if (!spot)
                    continue;
                resized = {...resized, ...spot};
            }
            this._keep(resized);
            widget.resize(size);
            this._place();
            return true;
        }
        return false;
    }

    setWidgetOption(id, key, value) {
        const widget = this._widgets.get(id);
        if (!widget)
            return;
        this._layout = this._layout.map(entry => (entry.id === id ? {...entry, [key]: value} : entry));
        widget.entry = {...widget.entry, [key]: value};
        this._save();
        widget.resize(widget.entry.size);
    }

    setWidgetSize(id, size) {
        const widget = this._widgets.get(id);
        const layout = this._shownLayout();
        const entry = layout.find(e => e.id === id);
        if (!widget || !entry || !LOCK_KINDS[entry.kind]?.sizes.includes(size) ||
            !fits(layout, {...entry, size}, this._grid))
            return false;
        this._keep({...entry, size});
        if (widget.entry.size !== size)
            widget.fill(size);
        widget.fit();
        this._place();
        return true;
    }

    spotFor(id, fx, fy) {
        const layout = this._shownLayout();
        return nearestSpot(layout, layout.find(e => e.id === id), this._grid, fx, fy);
    }

    sizeFor(id, fw, fh) {
        const layout = this._shownLayout();
        return nearestSize(layout, layout.find(e => e.id === id), this._grid, fw, fh, LOCK_KINDS);
    }

    moveWidget(id, x, y) {
        const layout = this._shownLayout();
        const entry = layout.find(e => e.id === id);
        if (!entry || !fits(layout, {...entry, x, y}, this._grid))
            return false;
        this._keep({...entry, x, y});
        const widget = this._widgets.get(id);
        widget.entry = {...widget.entry, x, y};
        return true;
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.keepLayer] - the widgets go with what holds
     *   them (the lock screen sliding away once unlocked)
     */
    destroy({keepLayer = false} = {}) {
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        if (!this._gone && !keepLayer)
            this.layer.destroy();
    }
}
