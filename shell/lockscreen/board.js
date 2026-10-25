// The widgets on the lock screen: clocks, the date, the weather and the
// battery placed anywhere on the main monitor, on the same grid as the
// desktop's widgets, laid out in the lockscreen settings' widgets. Their
// type is in a tone legible on the wallpaper behind them (typography.js),
// in the typeface chosen for them; each part of it as it takes to read
// where it is – nothing where it reads as it is, else heavier, or a soft
// shadow round its letters – and a glass clock's digits are Liquid Glass
// over the wallpaper (glassText.js), washed towards the tone as far as
// they need. On the lock screen they only
// show – a click goes through to GNOME's lock screen, which brings up the
// prompt; in the editor (a mock lock screen in the session, see
// preview.js) they are moved and stretched as on the desktop. When the
// password is asked, they make room for the prompt: the clocks go, the
// other widgets dim. With the depth effect, the wallpaper's subject stands
// over the clocks (depth.js) – but not over the date over a clock – under
// the other widgets, while it leaves each of their digits legible; on the
// lock screen, the clocks and the subject are one picture, which goes as
// the prompt comes up and comes back as one.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {minimumLc} from '../../lib/apca.js';
import {cutoutOpacity} from '../../lib/depth.js';
import {lookOf} from '../../lib/glassLook.js';
import {
    STRETCH, TYPE, glassInk, legibilityPlan, partStyle, regionStats, roleOf, styleWithPlan, widgetStyle,
} from '../../lib/lockLook.js';
import {labelFont} from '../../lib/lockType.js';
import {
    LOCK_CLOCK_FACES, LOCK_KINDS, allowsSize, cellOrigin, findSpot, fitLayout, fits, gridOrigin, gridSize,
    namedSize, nearestSize, nearestSpot, newId, nextSize, parseLayout, pixelSize, placeAt, serializeLayout, sizeOf,
} from '../../lib/widgets.js';
import {holdLabelFont} from '../core/fonts.js';
import {DateWidget} from '../desktop/kinds/time.js';
import {LockClockWidget} from './clock.js';
import {DepthCutout} from './depth.js';
import {GlassBackdrop, GlassVariant} from './liquidGlass.js';
import {LockTypography} from './typography.js';
import {LockBatteryWidget, LockWeatherWidget} from './widgets.js';

const WIDGETS = {clock: LockClockWidget, date: DateWidget, weather: LockWeatherWidget, battery: LockBatteryWidget};
const DIMMED = 0.25; // what is left of the widgets but the clocks while the prompt is up
const SMALLEST = 0.35; // how small a clock gets to go up over the popup
const SHIFT_TIME = 250; // moving on when the popup changes size
const MOVED = ['translation_x', 'translation_y', 'scale_x', 'scale_y'];
// A clock's date line, kept in front of the subject: this much round it
// too (logical pixels), besides its shadow's reach.
const IN_FRONT_PAD = 2;

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
     * @param {Gio.Settings} [options.atelier] - Atelier's own (the glass
     *   variant the glass clocks are drawn in; regular glass without)
     * @param {boolean} [options.ownPopup] - the lock screen's own popup asks
     *   for the password (a clock of hours over minutes stays, over it)
     */
    constructor(settings, {interactive = false, palette = null, atelier = null, ownPopup = false} = {}) {
        this._settings = settings;
        this._interactive = interactive;
        this._ownPopup = ownPopup;
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
        this._toneNow = null;
        this._typography = new LockTypography(settings, palette);
        this._typography.connectObject('changed', () => this._tone(), this);
        // The glass clocks' glass, as Atelier's glass looks (none, solid
        // digits, with GNOME's high contrast on), and the wallpaper as it
        // blurs it, small, to weigh what their digits take to read: made in
        // the session ahead of time (clock.js GlassWarmUp), or here, in the
        // background, when it isn't there yet.
        this._glassVariant = new GlassVariant(atelier, variant => {
            this._backdrop.setVariant(variant);
            this._queueGlass();
        });
        this._backdrop = new GlassBackdrop({make: true, variant: this._glassVariant.variant});
        this._backdrop.onChanged = () => this._queueGlass();
        this._glassLater = 0;
        this.layer = new St.Widget({reactive: false});
        // (On the lock screen, it goes with the lock screen's dialog.)
        this.layer.connect('destroy', () => {
            this._widgets.clear();
            this._gone = true;
            this._cancelLaters();
        });
        // (Each label's size is known once it is styled, on the stage.)
        this.layer.connect('notify::mapped', () => this.layer.mapped && this._tone());
        // On the lock screen, the clocks and the subject in front of them
        // (the depth effect's cutout) in a group of their own, the other
        // widgets over it: as the prompt comes up, the group goes as one
        // picture – drawn offscreen while it fades, so that no clock shows
        // through what stands in front of it (makeRoom()). (A clock of hours
        // over minutes that stays, over the popup, is under it.)
        this._clockGroup = null;
        if (!interactive) {
            this._clockGroup = new St.Widget({
                reactive: false,
                offscreen_redirect: Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY,
            });
            this._clockGroup.add_constraint(new Clutter.BindConstraint({
                source: this.layer, coordinate: Clutter.BindCoordinate.SIZE,
            }));
            this.layer.add_child(this._clockGroup);
        }
        // What the widgets read: nothing here opens an app or the network.
        this._context = {
            catalog: LOCK_KINDS,
            style: () => (this._look === 'analogue' ? 'analogue' : 'modern'),
            sources: {},
            claude: () => null,
            openSettings: () => {},
            locked: !interactive,
            // (A glass clock measured anew: how much of it the subject
            // covers looked at again, and what its digits take to read there
            // – once it rests, if it is being stretched.)
            depthChanged: widget => {
                if (widget?.stretching)
                    return;
                this._queueDepth();
                this._queueGlass();
            },
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
        this._backdrop.setMonitor([monitor.width, monitor.height], scale);
    }

    _syncDepth() {
        const wanted = this._settings.get_boolean('depth-effect');
        if (wanted === Boolean(this._depth))
            return;
        if (wanted) {
            this._depth = new DepthCutout();
            this._depth.onChanged = () => this._queueDepth();
            (this._clockGroup ?? this.layer).add_child(this._depth.actor);
            this._syncDepthDim();
            if (this._area)
                this._depth.setMonitor([this._area.width, this._area.height]);
        } else {
            this._depth.destroy();
            this._depth = null;
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

    // A glass clock measured anew, or another backdrop: what its digits
    // take to read where they are, once laid out.
    _queueGlass() {
        if (this._glassLater || this._gone)
            return;
        this._glassLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._glassLater = 0;
            this.widgets.forEach(widget => this._planGlass(widget));
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelLaters() {
        const laters = global.compositor.get_laters();
        for (const later of [this._depthLater, this._glassLater].filter(Boolean))
            laters.remove(later);
        this._depthLater = this._glassLater = 0;
    }

    _syncDepthCover() {
        const depth = this._depth;
        if (!depth?.actor || this._gone)
            return;
        const clocks = [];
        const inFront = [];
        for (const widget of this.widgets) {
            const parent = widget.get_parent();
            // (One being dragged in the editor is over everything until it lands.)
            if (!parent || (parent !== this.layer && parent !== this._clockGroup) ||
                widget.has_style_pseudo_class('dragged'))
                continue;
            // (Under or over the cutout beside it; on the lock screen, what
            // is out of the group of the clocks, under or over that group.)
            const subject = depth.actor.get_parent() === parent ? depth.actor : this._clockGroup;
            // (In the editor, one pointed at is in front, to be moved; and
            // one easing to the size it was stretched to, till it rests.)
            if (widget.entry.kind === 'clock' && !(this._interactive && (widget.hover || widget.stretching))) {
                parent.set_child_below_sibling(widget, subject);
                // (A glass clock's digits as they read where they are now.)
                this._planGlass(widget);
                clocks.push(this._legible(widget, widget.get_allocation_box()));
                // The date over it in front of the subject, as on an iPhone:
                // the clock goes behind it, the date never does.
                const line = this._dateLineOf(widget);
                if (line)
                    inFront.push({actor: line, pad: IN_FRONT_PAD * scaleFactor() + this._reachOf(line)});
            } else {
                parent.set_child_above_sibling(widget, subject);
            }
        }
        depth.cover(clocks);
        depth.keepInFront(inFront);
    }

    // A clock's date line, which stays in front of the subject: a glass
    // face's, or a stacked clock's.
    _dateLineOf(widget) {
        return widget.glass?.dateLine ?? widget.dateLine ?? null;
    }

    // How far round a label its planned shadow reaches, pixels.
    _reachOf(label) {
        const shadow = label._atelierPlan?.shadow;
        return shadow ? (shadow.blur + Math.abs(shadow.y)) * scaleFactor() : 0;
    }

    // What of a clock has to stay legible, on the monitor (lib/depth.js
    // legibility()): each of its digits' ink – a glass face's as it draws
    // them, down to the bottom of its box, their feet free to stand behind
    // the subject (STRETCH.overlap), its digits' box the clock as a whole;
    // another face's as its labels lay them out (no colon, no AM or PM), a
    // face with hands as a whole.
    _legible(widget, box) {
        const glass = widget.glass;
        if (glass) {
            const {x, y} = this._rectIn(glass, widget, box);
            const at = rect => ({x: x + rect.x, y: y + rect.y, width: rect.width, height: rect.height});
            const digits = glass.digitsRect;
            // (Each digit's, once the face measures them; till then all of them as one.)
            const glyphs = glass.glyphBoxes ?? (digits ? [digits] : []);
            return {glyphs: glyphs.map(at), box: digits ? at(digits) : null, overlap: STRETCH.overlap, glass: true};
        }
        const glyphs = (widget.timeLabels ?? []).flatMap(label => this._digitBoxes(label, widget, box));
        if (widget.dial)
            glyphs.push(this._rectIn(widget.dial, widget, box));
        if (glyphs.length > 0)
            return {glyphs};
        // (Nothing laid out yet: the clock as a whole.)
        return {glyphs: [], box: {x: box.x1, y: box.y1, width: box.get_width(), height: box.get_height()}};
    }

    // The ink of each digit of a label where it is laid out, as Pango lays
    // the label out.
    _digitBoxes(label, widget, box) {
        const text = label.clutter_text;
        if (!label.visible || !text.text)
            return [];
        const layout = text.get_layout();
        const {x, y} = this._rectIn(text, widget, box);
        const [dx, dy] = text.get_layout_offsets();
        // (Pango counts in UTF-8's bytes; the digits are ASCII's.)
        const bytes = new TextEncoder().encode(layout.get_text());
        const boxes = [];
        const iter = layout.get_iter();
        do {
            const byte = bytes[iter.get_index()];
            const [ink] = iter.get_cluster_extents();
            if (byte >= 0x30 && byte <= 0x39 && ink.width > 0 && ink.height > 0) {
                boxes.push({
                    x: x + dx + ink.x / Pango.SCALE,
                    y: y + dy + ink.y / Pango.SCALE,
                    width: ink.width / Pango.SCALE,
                    height: ink.height / Pango.SCALE,
                });
            }
        } while (iter.next_cluster());
        return boxes;
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
        this._house(widget);
        // (Stretched in the editor, it shows its size as it goes, no more:
        // how it reads there, and how much the subject covers of it, are
        // looked at once it rests.)
        widget.connect('notify::allocation', () => !widget.stretching && this._queueDepth());
        widget.connect('notify::stretching', () => {
            this._queueDepth();
            if (!widget.stretching)
                this._queueGlass();
        });
        if (this._interactive)
            widget.connect('notify::hover', () => this._queueDepth());
        this._widgets.set(entry.id, widget);
        this._queueDepth();
        this._editor?.adopt(widget);
        return widget;
    }

    // A widget on the layer: on the lock screen, a clock in the group of
    // the clocks, under the subject – but a clock of hours over minutes
    // that stays over the popup, under the group –, anything else over it.
    _house(widget) {
        const group = this._clockGroup;
        if (!group || widget.entry.kind !== 'clock')
            this.layer.add_child(widget);
        else if (this._ownPopup && widget.stacked)
            this.layer.insert_child_below(widget, group);
        else
            group.insert_child_below(widget, this._depth?.actor ?? null);
    }

    /**
     * Make room for the prompt in the middle, as it comes up: the clocks go
     * – with the subject in front of them, as one picture, gone once the
     * prompt is a third of the way up and the wallpaper blurs (lib/depth.js
     * cutoutOpacity()), back as one as it goes – and the other widgets dim.
     * With the lock screen's own popup, a clock of hours over minutes stays
     * instead, its minutes go beside its hours as on a digital clock, and it
     * goes up over the popup if it is still in its way (smaller, if it has
     * to be, to fit under the island).
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
        const shown = Math.round(255 * cutoutOpacity(progress));
        const group = this._clockGroup;
        if (group) {
            group.opacity = shown;
            // (Nothing of it drawn while the prompt is up.)
            group.visible = shown > 0;
        }
        const dim = Math.round(255 * (1 - (1 - DIMMED) * progress));
        for (const widget of this.widgets) {
            widget.setInline?.(popup ? progress : 0);
            const room = popup ? this._roomFor(widget, popup, top, gap) : null;
            // (A clock out of the group – one that stays over the popup,
            // when GNOME's prompt asks after all – goes on its own.)
            if (room || widget.get_parent() === group)
                widget.opacity = 255;
            else
                widget.opacity = widget.entry.kind === 'clock' ? shown : dim;
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

    // Where a widget goes for the room made, as far as the progress has it:
    // eased there (for a change of the popup), or set – unless it is there
    // already, as it mostly is: a clock set where it is is drawn anew all
    // the same, and with it, as it fades, all of the group of the clocks,
    // offscreen, a frame at a time.
    _shift(widget, room, progress, animate) {
        const {dx = 0, dy = 0, scale = 1, pivot} = room ?? {};
        if (pivot)
            widget.set_pivot_point(...pivot);
        const s = 1 + (scale - 1) * progress;
        const values = {translation_x: dx * progress, translation_y: dy * progress, scale_x: s, scale_y: s};
        if (MOVED.every(name => widget[name] === values[name] && !widget.get_transition(name)))
            return;
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
    // its letters (not on the editor's buttons); and a glass clock's digits
    // as their glass takes it. A widget moved or filled anew may change the
    // tone of all of them.
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
            this._planGlass(widget);
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

    // The part of the main monitor an actor of a widget is laid out on:
    // [x, y, width, height], 0 … 1.
    _monitorRect({x, y, width, height}) {
        const {width: mw, height: mh} = this._area;
        return [x / mw, y / mh, width / mw, height / mh];
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
    // style classes – but the editor's buttons in its corners, and a glass
    // face, which sets its own type (it is given its plan: _planGlass()).
    _partsOf(widget) {
        const parts = [];
        const own = widget.glass ?? null;
        const todo = widget.get_children().filter(child => !child.corner);
        while (todo.length > 0) {
            const actor = todo.pop();
            if (actor === own)
                continue;
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

    // A glass clock: its digits in the typeface chosen, at the weight and
    // width set; the wallpaper behind it, as its glass blurs it; and what
    // its digits and its date line take to read where they are – its
    // digits measured as their glass comes out over the wallpaper
    // (lib/lockLook.js glassInk()), their glass at rest to start with. The
    // face applies it (shell/lockscreen/clock.js), nothing when it is told
    // what it has.
    _planGlass(widget) {
        const glass = widget.glass;
        // (Being stretched: once it rests.)
        if (!glass || this._gone || widget.stretching)
            return;
        const backdrop = this._backdrop.current;
        if (glass.backdrop !== backdrop)
            glass.backdrop = backdrop;
        glass.setVariant(this._glassVariant.variant);
        const typography = this._typography;
        glass.setType({typeface: typography.typeface, style: typography.styleFor('glass')});
        const tone = this._toneNow;
        const plan = tone ? {
            digits: this._digitsPlan(widget, tone),
            date: this._datePlan(widget, tone),
            tone: {color: tone.color, dark: tone.dark},
        } : null;
        // (How far round it the date line's shadow reaches, in front of the subject.)
        glass.dateLine._atelierPlan = plan?.date ?? null;
        glass.setPlan(plan);
    }

    // What a glass clock's digits take to read: on the wallpaper behind
    // them (where they stand), their glass as it comes out there; null
    // until they are measured.
    _digitsPlan(widget, tone) {
        const glass = widget.glass;
        const metrics = glass.digitsMetrics;
        const digits = glass.digitsRect;
        if (!metrics || !digits || !widget.get_parent())
            return null;
        const {x, y} = this._rectIn(glass, widget, widget.get_allocation_box());
        const onMonitor = {x: x + digits.x, y: y + digits.y, width: digits.width, height: digits.height};
        const typography = this._typography;
        return legibilityPlan({
            size: metrics.size,
            weight: metrics.weight,
            tone,
            stats: typography.statsOf(this._monitorRect(onMonitor), this._area.width / this._area.height),
            glass: metrics.tintAlpha,
            ink: glassInk(tone, this._frostedBehind(onMonitor), lookOf(this._glassVariant.variant)),
            dim: typography.dim,
        });
    }

    // What a glass clock's date line takes to read, on the wallpaper
    // behind it (where the face puts it).
    _datePlan(widget, tone) {
        const glass = widget.glass;
        const type = this._typeOf(glass.dateLine);
        if (!type || !widget.get_parent())
            return null;
        const {x, y} = this._rectIn(glass, widget, widget.get_allocation_box());
        const line = glass.dateRect;
        const rect = this._monitorRect({x: x + line.x, y: y + line.y, width: line.width, height: line.height});
        return legibilityPlan({...type, tone, stats: this._typography.statsOf(rect, this._area.width / this._area.height),
            dim: this._typography.dim});
    }

    // The frosted wallpaper behind a part of the monitor (pixels): what is
    // there of it (lib/lockLook.js regionStats()); null without a backdrop.
    _frostedBehind({x, y, width, height}) {
        const backdrop = this._backdrop.current;
        if (!backdrop?.sample || !(width > 0 && height > 0))
            return null;
        const {monitor: [mw, mh], factor: [fx, fy], shift: [sx, sy]} = backdrop;
        // (Where the backdrop has it: its picture lies that much off.)
        return regionStats(backdrop.sample, [(x + sx / fx) / mw, (y + sy / fy) / mh, width / mw, height / mh]);
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
        // (From a size of its own, any of them: the first first.)
        const tries = sizes.includes(entry.size) ? sizes.length - 1 : sizes.length;
        for (let size = nextSize(entry.kind, entry.size, LOCK_KINDS), n = 0; n < tries;
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
        // A size of its own only as long as it may have it (a clock given
        // another face than glass): else the nearest of its kind's.
        const entry = this._shownLayout().find(e => e.id === id);
        if (allowsSize(entry, entry.size, LOCK_KINDS)) {
            this._save();
        } else {
            const named = this._namedFor(entry);
            this._keep({...entry, ...named});
            widget.entry = {...widget.entry, ...named};
        }
        widget.resize(widget.entry.size);
        this._place();
    }

    // Of the sizes its kind comes in, the one nearest to a widget's own
    // that fits where it is; or else the one nearest to it, where there is
    // room for it (wherever it is shown, if nowhere).
    _namedFor(entry) {
        const layout = this._shownLayout();
        const size = nearestSize(layout, entry, this._grid, ...sizeOf(entry.size), LOCK_KINDS);
        if (size !== entry.size)
            return {size};
        const named = namedSize(entry.size, LOCK_KINDS[entry.kind].sizes);
        return {size: named, ...findSpot(layout, {...entry, size: named}, this._grid)};
    }

    setWidgetSize(id, size) {
        const widget = this._widgets.get(id);
        const layout = this._shownLayout();
        const entry = layout.find(e => e.id === id);
        if (!widget || !entry || !allowsSize(entry, size, LOCK_KINDS) || !fits(layout, {...entry, size}, this._grid))
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
        this._cancelLaters();
        // (Its last backdrop stays drawn on the clocks sliding away.)
        this._backdrop.destroy();
        this._glassVariant.destroy();
        // (Kept with the layer, the cutout slides away with the lock screen.)
        this._depth?.destroy({keepActor: keepLayer});
        this._depth = null;
        if (!this._gone && !keepLayer)
            this.layer.destroy();
    }
}
