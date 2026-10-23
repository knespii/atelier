// The widgets on the lock screen: clocks, the date, the weather and the
// battery placed anywhere on the main monitor, on the same grid as the
// desktop's widgets, laid out in the lockscreen settings' widgets. Their
// type is in a tone legible on the wallpaper behind them (typography.js),
// in the typeface chosen for them; each part of it as it takes to read
// where it is – nothing where it reads as it is, else heavier, or a soft
// shadow round its letters. On the lock screen they only show – a click
// goes through to GNOME's lock screen, which brings up the prompt; in the
// editor (a mock lock screen in the session, see preview.js) they are
// moved and stretched as on the desktop. When the password is asked, they
// make room for the prompt. With the depth effect, the wallpaper's subject
// stands over the clocks (depth.js), under the other widgets.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {minimumLc} from '../../lib/apca.js';
import {
    TYPE, legibilityPlan, partStyle, roleOf, styleWithPlan, widgetStyle,
} from '../../lib/lockLook.js';
import {labelFont} from '../../lib/lockType.js';
import {
    LOCK_CLOCK_FACES, LOCK_KINDS, cellOrigin, findSpot, fitLayout, fits, gridOrigin, gridSize,
    nearestSize, nearestSpot, newId, nextSize, parseLayout, pixelSize, placeAt, serializeLayout,
} from '../../lib/widgets.js';
import {holdLabelFont} from '../core/fonts.js';
import {DateWidget} from '../desktop/kinds/time.js';
import {LockClockWidget} from './clock.js';
import {DepthCutout} from './depth.js';
import {LockTypography} from './typography.js';
import {LockBatteryWidget, LockWeatherWidget} from './widgets.js';

const WIDGETS = {clock: LockClockWidget, date: DateWidget, weather: LockWeatherWidget, battery: LockBatteryWidget};
const DIMMED = 0.25; // what is left of the widgets while the prompt is up
const SMALLEST = 0.35; // how small a clock gets to go up over the popup
const SHIFT_TIME = 250; // moving on when the popup changes size
const MOVED = ['translation_x', 'translation_y', 'scale_x', 'scale_y'];
// How much of a glass clock's width the subject has to stand across, for
// its digits to end there.
const ACROSS = 0.97;
const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

/**
 * @param {St.Label} label - on the stage
 * @returns {number} how big its type is in CSS pixels, as APCA's sizes
 *   are (points × 4/3): its size as St sets it, at Clutter's resolution
 *   (the text scaled as the user has it), in logical pixels
 */
function cssPixels(label) {
    const font = label.get_theme_node().get_font();
    const size = font.get_size() / Pango.SCALE;
    if (font.get_size_is_absolute())
        return size / scaleFactor();
    const context = label.clutter_text.get_pango_context();
    const resolution = [PangoCairo.context_get_resolution(context), context.get_font_map().get_resolution?.()]
        .find(dpi => dpi > 0) ?? 96;
    return size * resolution / 72 / scaleFactor();
}

export class LockBoard {
    /**
     * @param {Gio.Settings} settings - the lockscreen ones
     * @param {object} [options]
     * @param {boolean} [options.interactive] - the widgets take clicks (in the editor)
     * @param {Gio.Settings} [options.palette] - Atelier's palette settings
     */
    constructor(settings, {interactive = false, palette = null} = {}) {
        this._settings = settings;
        this._interactive = interactive;
        /** The kinds there are here, with their sizes (the editor's catalog). */
        this.catalog = LOCK_KINDS;
        /** The clock's faces on offer here: the glass one too. */
        this.clockFaces = LOCK_CLOCK_FACES;
        this.kinds = new Map(Object.entries(WIDGETS));
        this._widgets = new Map();
        this._layout = [];
        this._saving = false;
        this._gone = false;
        this._look = null;
        this._depth = null;
        this._depthLater = 0;
        this._progress = 0;
        this._toneNow = null;
        this._typography = new LockTypography(settings, palette);
        this._typography.connectObject('changed', () => this._tone(), this);
        this.layer = new St.Widget({reactive: false});
        // (On the lock screen, it goes with the lock screen's dialog.)
        this.layer.connect('destroy', () => {
            this._widgets.clear();
            this._gone = true;
            this._cancelDepthLater();
        });
        // (Each label's size is known once it is styled, on the stage.)
        this.layer.connect('notify::mapped', () => this.layer.mapped && this._tone());
        // What the widgets read: nothing here opens an app or the network.
        this._context = {
            style: () => (this._look === 'analogue' ? 'analogue' : 'modern'),
            sources: {},
            claude: () => null,
            openSettings: () => {},
            locked: !interactive,
            // (A glass clock measured anew: the subject under it looked for again.)
            depthChanged: () => this._queueDepth(),
        };
        settings.connectObject(
            'changed::widgets', () => !this._saving && this._load(),
            'changed::style', () => this._syncLook(),
            'changed::depth-effect', () => this._syncDepth(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._syncArea();
            this._place();
        }, this);
        this._syncArea();
        this._syncDepth();
        this._syncLook();
    }

    /** @returns {DepthCutout|null} the wallpaper's subject over the clocks, with the depth effect */
    get depth() {
        return this._depth;
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
        const scale = scaleFactor();
        this._grid = gridSize(monitor.width / scale, monitor.height / scale);
        this._origin = gridOrigin(monitor.width / scale, monitor.height / scale);
        this.layer.set_size(monitor.width, monitor.height);
        this._depth?.setMonitor([monitor.width, monitor.height]);
    }

    _syncDepth() {
        const wanted = this._settings.get_boolean('depth-effect');
        if (wanted === Boolean(this._depth))
            return;
        if (wanted) {
            this._depth = new DepthCutout();
            this._depth.onChanged = () => this._queueDepth();
            this.layer.add_child(this._depth.actor);
            this._depth.follow(this._progress);
            this._syncDepthDim();
            if (this._area)
                this._depth.setMonitor([this._area.width, this._area.height]);
        } else {
            this._depth.destroy();
            this._depth = null;
            // (Nothing in front of the glass clocks any more: as tall as they get.)
            this.widgets.forEach(widget => widget.glass?.setSubject(null));
        }
        this._queueDepth();
    }

    // Once the widgets are laid out anew (moved, given a size, a face): the
    // clocks under the subject, the others over it, and whether it covers
    // a clock too much.
    _queueDepth() {
        if (this._depthLater || !this._depth || this._gone)
            return;
        this._depthLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._depthLater = 0;
            this._syncDepthCover();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelDepthLater() {
        if (this._depthLater)
            global.compositor.get_laters().remove(this._depthLater);
        this._depthLater = 0;
    }

    _syncDepthCover() {
        const depth = this._depth;
        if (!depth?.actor || this._gone)
            return;
        const clocks = [];
        for (const widget of this.widgets) {
            // (One being dragged in the editor is over everything until it lands.)
            if (widget.get_parent() !== this.layer || widget.has_style_pseudo_class('dragged'))
                continue;
            // (In the editor, one pointed at is in front, to be moved.)
            if (widget.entry.kind === 'clock' && !(this._interactive && widget.hover)) {
                this.layer.set_child_below_sibling(widget, depth.actor);
                const box = widget.get_allocation_box();
                // (Stacked, each of its lines: the subject over most of the
                // minutes would hide them, however little of the box it covers.)
                const lines = widget.stackedLines?.map(line => this._rectIn(line, widget, box)) ?? [];
                const glass = this._followSubject(widget, box);
                if (glass)
                    clocks.push(glass);
                else if (lines.length > 0)
                    clocks.push(...lines);
                else
                    clocks.push({x: box.x1, y: box.y1, width: box.get_width(), height: box.get_height()});
            } else {
                this.layer.set_child_above_sibling(widget, depth.actor);
            }
        }
        depth.cover(clocks);
    }

    // Where a part of a widget is in the layer, as it is laid out.
    _rectIn(actor, widget, box) {
        let [x, y] = [box.x1, box.y1];
        for (let part = actor; part && part !== widget; part = part.get_parent()) {
            const own = part.get_allocation_box();
            x += own.x1;
            y += own.y1;
        }
        const own = actor.get_allocation_box();
        return {x, y, width: own.get_width(), height: own.get_height()};
    }

    // A glass clock's digits stretch down to where the subject stands
    // right across them (a hill sloping under them: its lowest point there),
    // so that it hides the feet of every digit – not a straight edge above
    // the ground where it is lower; what it covers of them counts then.
    _followSubject(widget, box) {
        const glass = widget.glass;
        const strip = glass?.strip;
        if (!strip)
            return null;
        const {x, y} = this._rectIn(glass, widget, box);
        const span = {x: x + strip.x, width: strip.width, from: y + strip.top, to: y + strip.bottom};
        const top = this._depth.subjectTop(span, ACROSS) ?? this._depth.subjectTop(span);
        glass.setSubject(top === null ? null : top - y);
        const digits = glass.digitsRect;
        return digits ? {...digits, x: x + digits.x, y: y + digits.y, glass: true} : null;
    }

    /** @returns {LockTypography} the widgets' type */
    get typography() {
        return this._typography;
    }

    // Bare (just the clocks' faces on the wallpaper), or cards as on the
    // desktop. The widgets are built anew: a clock's face may follow it.
    _syncLook() {
        const look = this._settings.get_string('style');
        if (look === this._look)
            return;
        this._look = look;
        const cards = look === 'modern' || look === 'analogue';
        this._bare = !cards;
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
        widget.connectObject('filled', () => this._tone(), this);
        this.layer.add_child(widget);
        widget.connect('notify::allocation', () => this._queueDepth());
        if (this._interactive)
            widget.connect('notify::hover', () => this._queueDepth());
        this._widgets.set(entry.id, widget);
        this._queueDepth();
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
        this._progress = progress;
        this._depth?.follow(progress);
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
        this._tone();
    }

    // The widgets' type in one tone, legible on the wallpaper behind all of
    // them (the clocks counting most, each widget with the type on it that
    // needs most; on cards, the cards' colours), in the typeface chosen.
    // Then each part of each as it takes to read on the wallpaper behind
    // that widget (lib/lockLook.js legibilityPlan()): nothing where it reads
    // as it is – no shadow at all – else heavier, then a soft shadow round
    // its letters (not on the editor's buttons). A widget moved or filled
    // anew may change the tone of all of them.
    _tone() {
        if (!this._grid || this._gone)
            return;
        const typography = this._typography;
        const typeface = typography.typeface;
        const aspect = this._area.width / this._area.height;
        const shown = this.widgets.map(widget => ({widget, rect: this._cellRect(widget), type: this._typeOn(widget)}));
        const tone = this._bare ? typography.toneFor(shown.map(({widget, rect, type}) => ({
            rect,
            weight: widget.entry.kind === 'clock' ? 3 : 1,
            text: type,
        })), aspect) : null;
        this._toneNow = tone;
        for (const {widget, rect} of shown) {
            widget.style = widgetStyle(tone, typeface) || null;
            const stats = tone ? typography.statsOf(rect, aspect) : null;
            for (const part of this._partsOf(widget))
                this._setPart(part, {typeface, tone, stats});
        }
    }

    // Where a widget is placed on the main monitor: [x, y, width, height],
    // 0 … 1 (as placed: the editor moves it there).
    _cellRect(widget) {
        const scale = scaleFactor();
        const [width, height] = [this._area.width / scale, this._area.height / scale];
        const [x, y] = cellOrigin(widget.entry.x, widget.entry.y, this._origin);
        const [w, h] = pixelSize(widget.entry.size);
        return [x / width, y / height, w / width, h / height];
    }

    // The type on a widget that needs most to read (APCA's font lookup):
    // its labels' that show, as they are set; none known (not styled yet,
    // off the stage): the date line's.
    _typeOn(widget) {
        let most = null;
        for (const label of this._labelsOf(widget)) {
            const type = this._typeOf(label);
            if (type && (!most || minimumLc(type.size, type.weight) > minimumLc(most.size, most.weight)))
                most = type;
        }
        return most ?? TYPE.line;
    }

    // The labels of a widget that show, its glass face's date line among
    // them (not the editor's buttons in its corners).
    _labelsOf(widget) {
        const labels = [];
        const todo = widget.get_children().filter(child => !child.corner);
        while (todo.length > 0) {
            const actor = todo.pop();
            if (!actor.visible)
                continue;
            todo.push(...actor.get_children());
            if (actor instanceof St.Label && actor.text)
                labels.push(actor);
        }
        return labels;
    }

    // A label's type as it is set: its size (CSS pixels) and its weight
    // (as its role has it); null while it isn't styled (off the stage).
    _typeOf(label) {
        if (!label.get_stage())
            return null;
        const style = this._typography.styleFor(roleOf(label.get_style_class_name()?.split(' ') ?? []));
        return {size: cssPixels(label), weight: style.weight};
    }

    // The parts of a widget styled here – each St.Widget in it, with its
    // style classes – but the editor's buttons in its corners.
    _partsOf(widget) {
        const parts = [];
        const todo = widget.get_children().filter(child => !child.corner);
        while (todo.length > 0) {
            const actor = todo.pop();
            todo.push(...actor.get_children());
            if (actor instanceof St.Widget)
                parts.push({actor, classes: actor.get_style_class_name()?.split(' ') ?? []});
        }
        return parts;
    }

    // A part as it is set (lib/lockType.js styleFor() of its role) and as
    // it takes to read where it is: a label held in its typeface (St can't
    // set a variable font's axes from CSS: shell/core/fonts.js), heavier
    // where planned, its shadow only where planned. (A width the typeface
    // has no axis for stays a label's own: St lays a label out at its
    // font's width; only the glass face draws its digits narrower.)
    _setPart({actor, classes}, {typeface, tone, stats}) {
        const role = roleOf(classes);
        let style = this._typography.styleFor(role);
        let plan = null;
        if (actor instanceof St.Label) {
            const type = this._typeOf(actor);
            plan = tone && type ? legibilityPlan({...type, tone, stats, dim: this._typography.dim}) : null;
            style = styleWithPlan(typeface, style, plan);
            this._holdFont(actor, typeface, style);
        } else if (role === 'text') {
            // (A box, an icon or a drawing: its labels have their own weight.)
            style = null;
        }
        actor._atelierPlan = plan;
        const css = partStyle(classes, tone, style, plan);
        // (Left as it is, unless it was styled before.)
        if (css || actor._atelierToned)
            actor.style = css || null;
        actor._atelierToned = Boolean(css);
    }

    // A label kept in a typeface and a style: anew only when they change
    // (St keeps it in them as it restyles it, shell/core/fonts.js).
    _holdFont(label, typeface, style) {
        const key = JSON.stringify([typeface.id, typeface.family, style]);
        if (label._atelierFont === key)
            return;
        label._atelierFont = key;
        holdLabelFont(label, size => labelFont(typeface, style, size));
    }

    /** @returns {object|null} the one tone of the widgets' type (lib/lockLook.js lockTone()); null on cards */
    get tone() {
        return this._toneNow ?? null;
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
        this._editor?.dim.disconnectObject(this);
        this._editor = editor;
        // (The subject dimmed with the wallpaper under it, as the editor dims it.)
        editor?.dim.connectObject('notify::opacity', () => this._syncDepthDim(), this);
        this._syncDepthDim();
    }

    _syncDepthDim() {
        const dim = this._editor?.dim;
        const shade = dim?.mapped ? dim.get_theme_node().get_background_color().alpha / 255 : 0;
        this._depth?.dim(shade * (dim?.opacity ?? 0) / 255);
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
        // (A new clock has the glass face, unless it is given another.)
        if (kind === 'clock' && !options.face)
            options = {...options, face: 'glass'};
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
        if (kind === 'clock' && !options.face)
            options = {...options, face: 'glass'};
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
        this._queueDepth();
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
        // (Over another part of the wallpaper.)
        this._tone();
        return true;
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.keepLayer] - the widgets go with what holds
     *   them (the lock screen sliding away once unlocked)
     */
    destroy({keepLayer = false} = {}) {
        this._typography.disconnectObject(this);
        this._typography.destroy();
        this._settings.disconnectObject(this);
        this._editor?.dim.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._cancelDepthLater();
        // (Kept with the layer, the cutout slides away with the lock screen.)
        this._depth?.destroy({keepActor: keepLayer});
        this._depth = null;
        if (!this._gone && !keepLayer)
            this.layer.destroy();
    }
}
