// Editing the desktop's widgets. The widgets come up over the windows, on a
// dimmed screen with the grid they snap to: drag one to move it, or the
// handle on its corner to stretch it – it takes the size it comes in that
// is nearest (a click on the handle gives it the next one). While dragging,
// a shadow on the grid shows where it lands. Its button removes it. More
// are dragged out of the gallery at the bottom (a click on the clock lets
// its faces flow out of it, to drag out one of them). Done (or Esc) puts them back
// under the windows.
//
// Coming up, the screen dims, the grid's cells swell out of drops from the
// middle outwards and the gallery spreads out of its own; going, all of it
// draws back the same way.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {gather, overflow, spread} from '../../lib/liquid.js';
import {CLOCK_FACES, KINDS, UNIT, cellOrigin, cellsAt, cellsOf, pixelSize} from '../../lib/widgets.js';
import {LiquidPaint} from '../core/liquid.js';

const SNAP_TIME = 160;
const GHOST_TIME = 120;
// A press that moves less than this (logical pixels) is a click.
const CLICK_DISTANCE = 4;
// Stretched past the sizes it comes in, a widget gives a little only.
const GIVE = 0.2;
const MAX_GIVE = 24;
// Logical pixels: the cards' corners (as in the stylesheet), how far the
// handle reaches past them, and how far out its arc runs.
const RADIUS = 22;
const OVERHANG = 8;
const ARC_GAP = 4;
// Out of the gallery: a widget drips out (from this much of its size), and
// one let go of nowhere goes back.
const DRIP_SCALE = 0.5;
const DRIP_TIME = 260;
// The clock's faces flowing out of the gallery (and back), each this big
// once there. Logical pixels: the drop the gallery swells into, and how
// near the liquid melts.
const SPILL_TIME = 680;
const SPILL_BACK_TIME = 460;
const SPILL_STAGGER = 40;
const SPILL_FACES_TIME = 160;
const SAMPLE = 84;
const SPILL_DROP = 16;
const SPILL_BLEND = 20;
// Coming up and going, milliseconds; of that, how much the cells farthest
// from the middle wait behind those in it.
const APPEAR_TIME = 560;
const VANISH_TIME = 380;
const RIPPLE = 0.45;
// Logical pixels: the gallery's corners (as in the stylesheet).
const GALLERY_RADIUS = 28;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.min(1, Math.max(0, t));
const easeOut = t => 1 - (1 - t) ** 3;

// Faint squares where widgets can go.
const GridHint = GObject.registerClass(
class AtelierDesktopGrid extends St.DrawingArea {
    _init(grid, origin) {
        super._init({style_class: 'atelier-desktop-grid'});
        this._grid = grid;
        this._origin = origin;
        this._progress = 1;
    }

    /** How far the cells have come, 0 (none) to 1 (all), the middle first. */
    set progress(value) {
        this._progress = value;
        this.queue_repaint();
    }

    get progress() {
        return this._progress;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const color = this.get_theme_node().get_foreground_color();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
        const [columns, rows] = this._grid;
        const size = UNIT * scale;
        const [width, height] = this.get_surface_size();
        const far = Math.hypot(width, height) / 2 || 1;
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < columns; x++) {
                const [px, py] = cellOrigin(x, y, this._origin).map(v => v * scale);
                const [cx, cy] = [px + size / 2, py + size / 2];
                // A drop first, swelling into its cell; the farther from
                // the middle, the later.
                const delay = RIPPLE * Math.hypot(cx - width / 2, cy - height / 2) / far;
                const grown = easeOut(clamp01((this._progress - delay) / (1 - RIPPLE)));
                if (grown <= 0)
                    continue;
                const half = size / 2 * lerp(0.2, 1, grown);
                const r = Math.min(half, lerp(half, 8 * scale, grown ** 2));
                cr.newSubPath();
                cr.arc(cx + half - r, cy - half + r, r, -Math.PI / 2, 0);
                cr.arc(cx + half - r, cy + half - r, r, 0, Math.PI / 2);
                cr.arc(cx - half + r, cy + half - r, r, Math.PI / 2, Math.PI);
                cr.arc(cx - half + r, cy - half + r, r, Math.PI, 1.5 * Math.PI);
                cr.closePath();
            }
        }
        cr.fill();
        cr.$dispose();
    }
});

// The handle on a widget's bottom right corner: an arc around it, just
// outside the card.
const ResizeHandle = GObject.registerClass(
class AtelierWidgetHandle extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'atelier-widget-handle',
            reactive: true,
            track_hover: true,
            accessible_name: 'Change size',
        });
        this.corner = 'bottom-right';
        this.overhang = OVERHANG;
        this.connect('notify::hover', () => this.queue_repaint());
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const color = this.get_theme_node().get_foreground_color();
        // Around the center of the card's rounded corner.
        const cx = width - (OVERHANG + RADIUS) * scale;
        const cy = height - (OVERHANG + RADIUS) * scale;
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.arc(cx, cy, (RADIUS + ARC_GAP) * scale, 0.06 * Math.PI, 0.44 * Math.PI);
        // A dark edge under it, for light cards and wallpapers.
        cr.setSourceRGBA(0, 0, 0, 0.3);
        cr.setLineWidth((this.hover ? 8 : 7) * scale);
        cr.strokePreserve();
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
        cr.setLineWidth((this.hover ? 5.5 : 4.5) * scale);
        cr.stroke();
        cr.$dispose();
    }
});

export class DesktopEditor {
    /**
     * @param {DesktopModule} desktop
     */
    constructor(desktop) {
        this._desktop = desktop;
        this._drag = null;
        this._ghostShown = false;
        this._ghostKey = null;
        this._cursor = null;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const area = desktop.area;

        this.actor = new St.Widget({
            style_class: 'atelier-desktop-editor',
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        Main.layoutManager.addTopChrome(this.actor);
        // The screen dimmed (by itself: it fades in and out).
        this._dim = new St.Widget({style_class: 'atelier-desktop-editor-dim',
            width: global.stage.width, height: global.stage.height});
        this.actor.add_child(this._dim);
        this._hint = new GridHint(desktop.grid, desktop.origin);
        this._hint.set_position(area.x, area.y);
        this._hint.set_size(area.width, area.height);
        this.actor.add_child(this._hint);
        // Where the widget being dragged lands.
        this._ghost = new St.Widget({style_class: 'atelier-widget-ghost', visible: false});
        this.actor.add_child(this._ghost);

        // The widgets, over everything for now.
        const layer = desktop.layer;
        layer.get_parent()?.remove_child(layer);
        this.actor.add_child(layer);
        layer.set_position(area.x, area.y);

        this._gallery = new St.BoxLayout({style_class: 'atelier-widget-gallery'});
        for (const [kind, {name, icon}] of Object.entries(KINDS).filter(([k]) => desktop.kinds.has(k))) {
            const box = new St.BoxLayout({style_class: 'atelier-widget-gallery-item', orientation: Clutter.Orientation.VERTICAL});
            box.add_child(new St.Icon({
                style_class: 'atelier-widget-gallery-icon',
                ...kind === 'claude' ? {gicon: desktop.claudeIcon} : {icon_name: icon},
                x_align: Clutter.ActorAlign.CENTER,
            }));
            box.add_child(new St.Label({text: name, x_align: Clutter.ActorAlign.CENTER}));
            // (Not a button: a button keeps the pointer to itself until
            // let go of, and this is dragged.)
            const button = new St.Bin({style_class: 'atelier-widget-gallery-button', reactive: true,
                track_hover: true, accessible_name: name, child: box});
            // Dragged out, not clicked in.
            button.connect('button-press-event', (_, event) => this._onGalleryPress(kind, {}, button, event));
            this._gallery.add_child(button);
            if (kind === 'clock')
                this._clockButton = button;
        }
        const done = new St.Button({style_class: 'atelier-widget-gallery-done', label: 'Done', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER});
        done.connect('clicked', () => desktop.stopEditing());
        this._gallery.add_child(done);
        this.actor.add_child(this._gallery);
        this._spill = null;
        const monitor = Main.layoutManager.primaryMonitor;
        this._gallery.connect('notify::width', () => {
            this._gallery.set_position(
                Math.round(monitor.x + (monitor.width - this._gallery.width) / 2),
                Math.round(monitor.y + monitor.height - this._gallery.height - 24 * scale));
        });

        desktop.widgets.forEach(widget => this.adopt(widget));
        this.actor.connect('key-press-event', (_, event) => {
            const key = event.get_key_symbol();
            if (key === Clutter.KEY_Escape || key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
                desktop.stopEditing();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('motion-event', (_, event) => this._onMotion(event));
        this.actor.connect('button-release-event', (_, event) => this._onRelease(event));

        this._grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});
        done.grab_key_focus();
        this._appear();
    }

    // Plays over a duration: step(t) every frame, then done(). (At once
    // without animations.)
    _play(duration, step, done) {
        this._transition?.stop();
        if (!St.Settings.get().enable_animations) {
            step(1);
            done();
            return;
        }
        const timeline = new Clutter.Timeline({actor: this.actor, duration: adjustAnimationTime(duration)});
        let over = false;
        const finish = () => {
            if (over)
                return;
            over = true;
            this._transition = null;
            done();
        };
        timeline.connect('new-frame', () => step(timeline.get_progress()));
        timeline.connect('completed', () => {
            step(1);
            finish();
        });
        this._transition = {stop: () => {
            timeline.stop();
            step(1);
            finish();
        }};
        step(0);
        timeline.start();
    }

    // The gallery's liquid, under it while it is away: over the dim.
    _galleryLiquid() {
        const paint = new LiquidPaint({width: global.stage.width, height: global.stage.height});
        this.actor.insert_child_below(paint, this._gallery);
        paint.setLook(this._gallery);
        return paint;
    }

    _galleryRect() {
        const [x, y] = this._gallery.get_transformed_position();
        return [x, y, this._gallery.width, this._gallery.height];
    }

    // Coming up: the dim fading in, the cells swelling out of drops from
    // the middle outwards, the gallery spreading out of a drop in its
    // middle (what is on it showing once it is there).
    _appear() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let paint = null;
        this._gallery.opacity = 0;
        this._play(APPEAR_TIME, t => {
            this._dim.opacity = Math.round(255 * easeOut(clamp01(t / 0.6)));
            this._hint.progress = t;
            if (this._gallery.width > 0 && t < 1) {
                paint ??= this._galleryLiquid();
                paint.setShapes(spread(this._galleryRect(), clamp01(t / 0.8), {radius: GALLERY_RADIUS * scale}));
            }
            this._gallery.opacity = Math.round(255 * clamp01((t - 0.7) / 0.3));
        }, () => {
            paint?.destroy();
            this._gallery.opacity = 255;
        });
    }

    /**
     * Going: the widgets go back under the windows at once; the rest draws
     * back – the gallery into a drop, the cells into drops, outside in –
     * and is gone.
     */
    close() {
        this._release();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this.actor.reactive = false;
        const rect = this._galleryRect();
        const paint = this._gallery.width > 0 && this._gallery.mapped ? this._galleryLiquid() : null;
        this._gallery.hide();
        const dim = this._dim.opacity;
        const grid = this._hint.progress;
        this._play(VANISH_TIME, t => {
            this._dim.opacity = Math.round(dim * (1 - easeOut(t)));
            this._hint.progress = grid * (1 - t);
            paint?.setShapes(gather(rect, clamp01(t / 0.8), {radius: GALLERY_RADIUS * scale}));
        }, () => this._destroyActor());
    }

    /**
     * Give a widget its button and handle, and make it draggable.
     *
     * @param {DesktopWidget} widget
     */
    adopt(widget) {
        widget.editing = true;
        const controls = new St.BoxLayout({style_class: 'atelier-widget-controls'});
        controls.corner = 'top-right';
        const remove = new St.Button({
            style_class: 'atelier-widget-control',
            accessible_name: 'Remove',
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
        });
        remove.connect('clicked', () => this._desktop.removeWidget(widget.entry.id));
        controls.add_child(remove);
        widget.add_child(controls);
        widget._editControls = controls;
        if (KINDS[widget.entry.kind]?.sizes.length > 1) {
            widget._editHandle = new ResizeHandle();
            widget._editHandle.connect('notify::hover', () => this._syncCursor());
            widget.add_child(widget._editHandle);
        }
        widget.connectObject(
            'button-press-event', (_, event) => this._onPress(widget, event),
            'notify::hover', () => this._syncCursor(),
            this);
    }

    _releaseWidget(widget) {
        widget.editing = false;
        widget._editControls?.destroy();
        widget._editControls = null;
        widget._editHandle?.destroy();
        widget._editHandle = null;
        widget.disconnectObject(this);
    }

    _onPress(widget, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._drag)
            return Clutter.EVENT_PROPAGATE;
        // (The button in its corner has its own clicks.)
        const source = global.stage.get_event_actor(event);
        if (widget._editControls?.contains(source))
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        // (Still going to where it was let go of before: from where it is.)
        widget.remove_all_transitions();
        widget.translation_x = 0;
        this._drag = {
            stretch: Boolean(widget._editHandle?.contains(source)),
            widget,
            pointer: [x, y],
            moved: false,
            // as it was
            x: widget.x,
            y: widget.y,
            width: widget.width,
            height: widget.height,
            size: widget.entry.size,
            above: widget.get_next_sibling(),
            // where it lands: {x, y} in cells, or a size
            target: null,
        };
        widget.add_style_pseudo_class('dragged');
        widget.stretching = this._drag.stretch;
        this._desktop.layer.set_child_above_sibling(widget, null);
        this._dragGrab = global.stage.grab(this.actor);
        this._syncCursor();
        return Clutter.EVENT_STOP;
    }

    // Pressed in the gallery: dragged, a widget drips out of it; clicked,
    // the clock spills its faces (the others give a little shake: drag me).
    _onGalleryPress(kind, options, source, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._drag)
            return Clutter.EVENT_STOP;
        const [x, y] = event.get_coords();
        this._drag = {fresh: true, kind, options, source, pointer: [x, y], moved: false, preview: null, target: null};
        this._dragGrab = global.stage.grab(this.actor);
        return Clutter.EVENT_STOP;
    }

    _moveFresh(drag, x, y) {
        const desktop = this._desktop;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (!drag.preview) {
            drag.preview = desktop.makeWidget(drag.kind, drag.options);
            if (!drag.preview)
                return;
            this.actor.add_child(drag.preview);
            const card = drag.preview.widget;
            card.set_pivot_point(0.5, 0.5);
            card.set({scale_x: DRIP_SCALE, scale_y: DRIP_SCALE, opacity: 0});
            card.ease({scale_x: 1, scale_y: 1, duration: DRIP_TIME, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            // (Not opacity: past its end it would wrap round to nothing.)
            card.ease({opacity: 255, duration: DRIP_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            card.add_style_pseudo_class('dragged');
        }
        const card = drag.preview.widget;
        const [px, py] = [Math.round(x - card.width / 2), Math.round(y - card.height / 2)];
        drag.preview.set_position(px, py);
        const area = desktop.area;
        drag.target = desktop.spotForNew(drag.kind, ...cellsAt((px - area.x) / scale, (py - area.y) / scale, desktop.origin));
        // (Over the gallery: going back there.)
        const [, galleryY] = this._gallery.get_transformed_position();
        if (y > galleryY - 8 * scale)
            drag.target = null;
        if (drag.target)
            this._showGhost({...drag.target, size: card.entry.size});
        else
            this._hideGhost();
    }

    // Let go of: where the shadow is, the widget lands there; nowhere, back
    // into the gallery. Clicked: the clock's faces, or a shake.
    _dropFresh(drag) {
        this._drag = null;
        this._dragGrab?.dismiss();
        this._dragGrab = null;
        this._hideGhost();
        this._syncCursor();
        const {preview, target, source} = drag;
        if (!drag.moved || !preview) {
            if (drag.kind === 'clock' && source === this._clockButton)
                this._toggleSpill();
            else if (!drag.moved)
                this._shake(source);
            preview?.destroy();
            return;
        }
        const [px, py] = preview.get_transformed_position();
        const widget = target ? this._desktop.addWidget(drag.kind, drag.options, target) : null;
        if (widget) {
            const area = this._desktop.area;
            const [toX, toY] = [widget.x, widget.y];
            widget.set_position(px - area.x, py - area.y);
            widget.ease({x: toX, y: toY, duration: SNAP_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            preview.destroy();
            return;
        }
        // Back where it came from, and gone.
        const [sx, sy] = source.get_transformed_position();
        const card = preview.widget;
        card.ease({scale_x: DRIP_SCALE, scale_y: DRIP_SCALE, opacity: 0, duration: DRIP_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD});
        preview.ease({
            x: Math.round(sx + source.width / 2 - card.width / 2),
            y: Math.round(sy + source.height / 2 - card.height / 2),
            duration: DRIP_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => preview.destroy(),
        });
        // (No room for it anywhere: say so.)
        if (!this._desktop.spotForNew(drag.kind, 0, 0))
            this._shake(source);
    }

    // The clock's faces, out of the gallery: it swells at the clock into a
    // drop, which rises on a neck, lets go and spreads into a panel above
    // it, where the faces come up – each as it looks, to drag out. Clicked
    // again, they go, and the panel flows back into the gallery.
    _toggleSpill() {
        if (this._spill) {
            this._flowSpill(this._spill, false);
            this._spillBack = this._spill;
            this._spill = null;
            return;
        }
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const panel = new St.BoxLayout({style_class: 'atelier-widget-spill'});
        CLOCK_FACES.filter(([id]) => id !== 'auto').forEach(([face, name]) => {
            const item = new St.BoxLayout({style_class: 'atelier-widget-spill-item', orientation: Clutter.Orientation.VERTICAL,
                reactive: true, track_hover: true, accessible_name: name});
            const sample = this._desktop.makeWidget('clock', {face});
            const holder = new St.Widget({width: SAMPLE * scale, height: SAMPLE * scale, x_align: Clutter.ActorAlign.CENTER});
            const [w] = pixelSize('square');
            sample.widget.set_scale(SAMPLE / w, SAMPLE / w);
            holder.add_child(sample);
            item.add_child(holder);
            item.add_child(new St.Label({text: name, x_align: Clutter.ActorAlign.CENTER}));
            item.connect('button-press-event', (_, event) => this._onGalleryPress('clock', {face}, item, event));
            item.opacity = 0;
            panel.add_child(item);
        });
        this.actor.add_child(panel);
        // Above the clock in the gallery, on the screen.
        const [bx, by] = this._clockButton.get_transformed_position();
        const [, width] = panel.get_preferred_width(-1);
        const [, height] = panel.get_preferred_height(width);
        const monitor = Main.layoutManager.primaryMonitor;
        const originX = bx + this._clockButton.width / 2;
        const x = Math.max(monitor.x + 12 * scale, Math.min(originX - width / 2, monitor.x + monitor.width - width - 12 * scale));
        const y = by - height - 26 * scale;
        panel.set_position(Math.round(x), Math.round(y));
        // The liquid, under the gallery, of its look.
        const liquid = new LiquidPaint();
        this.actor.insert_child_below(liquid, this._gallery);
        liquid.set_position(monitor.x, monitor.y);
        liquid.set_size(monitor.width, monitor.height);
        liquid.setLook(this._gallery);
        // (Where it is: it isn't laid out yet.)
        const rect = [Math.round(x), Math.round(y), Math.ceil(width), Math.ceil(height)];
        this._spill = {panel, liquid, rect, originX, progress: 0, timeline: null};
        this._flowSpill(this._spill, true);
    }

    // The liquid on its way out of the gallery (or back into it), from
    // where it is.
    _flowSpill(spill, out) {
        const {panel, liquid} = spill;
        spill.timeline?.stop();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [mx, my] = liquid.get_position();
        const rect = actor => {
            const [ax, ay] = actor.get_transformed_position();
            return [ax - mx, ay - my, actor.width, actor.height];
        };
        const radius = actor => actor.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
        const bar = rect(this._gallery);
        const shape = [[spill.rect[0] - mx, spill.rect[1] - my, spill.rect[2], spill.rect[3]], radius(panel)];
        const look = {drop: SPILL_DROP * scale, blend: SPILL_BLEND * scale};
        const frame = t => {
            spill.progress = t;
            liquid.setShapes(overflow(bar, radius(this._gallery), ...shape, spill.originX - mx, t, look),
                [...bar, radius(this._gallery)]);
        };
        const faces = panel.get_children();
        faces.forEach(face => face.remove_transition('opacity'));
        // The faces come up once it has spread – and go before it flows back.
        if (out) {
            faces.forEach((face, i) => face.ease({opacity: 255, delay: SPILL_TIME * 0.7 + i * SPILL_STAGGER,
                duration: SPILL_FACES_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD}));
        } else {
            panel.reactive = false;
            faces.forEach(face => {
                face.reactive = false;
                face.ease({opacity: 0, duration: SPILL_FACES_TIME / 2, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            });
        }
        const length = out ? SPILL_TIME : SPILL_BACK_TIME;
        const from = spill.progress;
        const timeline = new Clutter.Timeline({
            actor: liquid,
            duration: Math.max(1, adjustAnimationTime(length * (out ? 1 - from : from))),
            delay: out ? 0 : adjustAnimationTime(SPILL_FACES_TIME / 2),
        });
        spill.timeline = timeline;
        timeline.connect('new-frame', () => {
            const t = timeline.get_progress();
            frame(out ? from + (1 - from) * t : from * (1 - t));
        });
        timeline.connect('completed', () => {
            spill.timeline = null;
            frame(out ? 1 : 0);
            if (!out) {
                panel.destroy();
                liquid.destroy();
            }
        });
        frame(from);
        timeline.start();
    }

    _onMotion(event) {
        const drag = this._drag;
        if (!drag)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const [dx, dy] = [x - drag.pointer[0], y - drag.pointer[1]];
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (!drag.moved && Math.hypot(dx, dy) < CLICK_DISTANCE * scale)
            return Clutter.EVENT_STOP;
        drag.moved = true;
        if (drag.fresh) {
            this._moveFresh(drag, x, y);
            this._syncCursor();
        } else if (drag.stretch)
            this._stretch(drag, dx, dy);
        else
            this._move(drag, dx, dy);
        return Clutter.EVENT_STOP;
    }

    // With the pointer, and the shadow on the free cells nearest to it.
    _move(drag, dx, dy) {
        const {widget} = drag;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [x, y] = [Math.round(drag.x + dx), Math.round(drag.y + dy)];
        widget.set_position(x, y);
        drag.target = this._desktop.spotFor(widget.entry.id, ...cellsAt(x / scale, y / scale, this._desktop.origin));
        this._showGhost({...widget.entry, ...drag.target});
    }

    // Its corner with the pointer, within the sizes it comes in (and a
    // little past them); it shows what it would at the size nearest to
    // that, which the shadow has.
    _stretch(drag, dx, dy) {
        const {widget} = drag;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const sizes = KINDS[widget.entry.kind].sizes.map(size => pixelSize(size).map(v => v * scale));
        const give = (value, axis) => {
            const min = Math.min(...sizes.map(size => size[axis]));
            const max = Math.max(...sizes.map(size => size[axis]));
            if (value < min)
                return min - Math.min((min - value) * GIVE, MAX_GIVE * scale);
            if (value > max)
                return max + Math.min((value - max) * GIVE, MAX_GIVE * scale);
            return value;
        };
        const [width, height] = [give(drag.width + dx, 0), give(drag.height + dy, 1)];
        widget.set_size(Math.round(width), Math.round(height));
        drag.target = this._desktop.sizeFor(widget.entry.id, cellsOf(width / scale), cellsOf(height / scale));
        if (drag.target !== widget.entry.size)
            widget.fill(drag.target);
        this._showGhost(widget.entry);
    }

    _onRelease(event) {
        if (!this._drag || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const drag = this._drag;
        if (drag.fresh) {
            this._dropFresh(drag);
            return Clutter.EVENT_STOP;
        }
        this._endDrag();
        if (drag.stretch)
            this._settle(drag);
        else
            this._land(drag);
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        const {widget, above} = this._drag;
        this._drag = null;
        this._dragGrab?.dismiss();
        this._dragGrab = null;
        widget.remove_style_pseudo_class('dragged');
        // Back among the others as it was (under the notes on the desktop, say).
        if (above?.get_parent() === widget.get_parent())
            widget.get_parent().set_child_below_sibling(widget, above);
        this._hideGhost();
        this._syncCursor();
    }

    // Moved: where the shadow was.
    _land({widget, target, x, y}) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const moved = target && this._desktop.moveWidget(widget.entry.id, target.x, target.y);
        const [toX, toY] = moved ? cellOrigin(target.x, target.y, this._desktop.origin).map(v => v * scale) : [x, y];
        widget.ease({x: toX, y: toY, duration: SNAP_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Stretched: from where it was let go to the shadow's size. Clicked:
    // the next size.
    _settle({widget, target, size, moved}) {
        const id = widget.entry.id;
        if (!moved) {
            widget.stretching = false;
            if (!this._desktop.resizeWidget(id))
                this._shake(widget);
            return;
        }
        const [fromWidth, fromHeight] = [widget.width, widget.height];
        if (!this._desktop.setWidgetSize(id, target ?? size))
            widget.resize(size);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [width, height] = pixelSize(widget.entry.size).map(v => v * scale);
        widget.set_size(fromWidth, fromHeight);
        widget.ease({
            width,
            height,
            duration: SNAP_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => (widget.stretching = false),
        });
    }

    // The shadow on the grid where the widget being dragged lands, as it is
    // there: {x, y, size}.
    _showGhost({x, y, size}) {
        const key = `${x} ${y} ${size}`;
        if (key === this._ghostKey)
            return;
        this._ghostKey = key;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const area = this._desktop.area;
        const [px, py] = cellOrigin(x, y, this._desktop.origin);
        const [width, height] = pixelSize(size);
        const rect = {x: area.x + px * scale, y: area.y + py * scale, width: width * scale, height: height * scale};
        if (this._ghostShown) {
            this._ghost.ease({...rect, duration: GHOST_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return;
        }
        this._ghostShown = true;
        // Under the widgets, a shadow where a moved one lands; over them,
        // the outline of the size a stretched one takes (were it smaller,
        // it would be hidden under the card).
        const outline = Boolean(this._drag?.stretch);
        this.actor.set_child_above_sibling(this._ghost, outline ? this._desktop.layer : this._hint);
        if (outline)
            this._ghost.add_style_pseudo_class('outline');
        else
            this._ghost.remove_style_pseudo_class('outline');
        this._ghost.remove_all_transitions();
        this._ghost.set({...rect, opacity: 0, visible: true});
        this._ghost.ease({opacity: 255, duration: GHOST_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    _hideGhost() {
        this._ghostKey = null;
        if (!this._ghostShown)
            return;
        this._ghostShown = false;
        this._ghost.ease({
            opacity: 0,
            duration: GHOST_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._ghost.hide(),
        });
    }

    // A hand over a widget, closed while dragging it; arrows on the handle.
    _syncCursor() {
        const widgets = [...this._desktop.widgets.values()];
        let cursor = Meta.Cursor.DEFAULT;
        if (this._drag?.fresh)
            cursor = this._drag.moved ? Meta.Cursor.GRABBING : Meta.Cursor.DEFAULT;
        else if (this._drag)
            cursor = this._drag.stretch ? Meta.Cursor.SE_RESIZE : Meta.Cursor.GRABBING;
        else if (widgets.some(widget => widget._editHandle?.hover))
            cursor = Meta.Cursor.SE_RESIZE;
        else if (widgets.some(widget => widget.hover && !widget._editControls?.get_children().some(b => b.hover)))
            cursor = Meta.Cursor.GRAB;
        if (cursor !== this._cursor) {
            this._cursor = cursor;
            global.display.set_cursor(cursor);
        }
    }

    // No: a little shake.
    _shake(actor) {
        actor.remove_transition('translation-x');
        actor.translation_x = 0;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        actor.ease({
            translation_x: 6 * scale,
            duration: 50,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            repeat_count: 3,
            auto_reverse: true,
            onStopped: () => (actor.translation_x = 0),
        });
    }

    /** Put the widgets back under the windows. */
    /** Gone at once. */
    destroy() {
        this._release();
        this._transition?.stop();
        this._destroyActor();
    }

    // The widgets back under the windows, the grab let go of.
    _release() {
        if (this._released)
            return;
        this._released = true;
        this._spill?.timeline?.stop();
        this._spillBack?.timeline?.stop();
        // Out of the gallery mid-way: never mind.
        if (this._drag?.fresh) {
            this._drag.preview?.destroy();
            this._drag = null;
            this._dragGrab?.dismiss();
            this._dragGrab = null;
        }
        // Let go of mid-way: as it was.
        if (this._drag) {
            const {widget, stretch, x, y, size} = this._drag;
            this._endDrag();
            widget.remove_all_transitions();
            if (stretch) {
                widget.stretching = false;
                widget.resize(size);
            }
            widget.set_position(x, y);
        }
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._desktop.widgets.forEach(widget => this._releaseWidget(widget));
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        const layer = this._desktop.layer;
        this.actor.remove_child(layer);
        this._desktop.restoreLayer();
    }

    _destroyActor() {
        this.actor?.destroy();
        this.actor = null;
    }
}
