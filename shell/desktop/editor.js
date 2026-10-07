// Editing the desktop's widgets. The widgets come up over the windows, on a
// dimmed screen with the grid they snap to: drag one to move it, or the
// handle on its corner to stretch it – it takes the size it comes in that
// is nearest (a click on the handle gives it the next one). While dragging,
// a shadow on the grid shows where it lands. Its button removes it. More
// are dragged out of the gallery at the bottom (a click on the clock spills
// its faces over it, to drag out one of them). Done (or Esc) puts them back
// under the windows.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {CLOCK_FACES, KINDS, MARGIN, PITCH, UNIT, cellOrigin, cellsOf, pixelSize} from '../../lib/widgets.js';

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
// The clock's faces spilled over the gallery, each this big.
const SPILL_TIME = 380;
const SPILL_STAGGER = 40;
const SAMPLE = 84;

// Faint squares where widgets can go.
const GridHint = GObject.registerClass(
class AtelierDesktopGrid extends St.DrawingArea {
    _init(grid) {
        super._init({style_class: 'atelier-desktop-grid'});
        this._grid = grid;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const color = this.get_theme_node().get_foreground_color();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
        const [columns, rows] = this._grid;
        const size = UNIT * scale;
        const r = 10 * scale;
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < columns; x++) {
                const [px, py] = cellOrigin(x, y).map(v => v * scale);
                cr.newSubPath();
                cr.arc(px + size - r, py + r, r, -Math.PI / 2, 0);
                cr.arc(px + size - r, py + size - r, r, 0, Math.PI / 2);
                cr.arc(px + r, py + size - r, r, Math.PI / 2, Math.PI);
                cr.arc(px + r, py + r, r, Math.PI, 1.5 * Math.PI);
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
        this._hint = new GridHint(desktop.grid);
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

    _release(widget) {
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
        drag.target = desktop.spotForNew(drag.kind, ((px - area.x) / scale - MARGIN) / PITCH,
            ((py - area.y) / scale - MARGIN) / PITCH);
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

    // The clock's faces, spilled over the gallery from the clock, a little
    // too far and back: each as it looks, to drag out.
    _toggleSpill() {
        if (this._spill) {
            const spill = this._spill;
            this._spill = null;
            spill.ease({scale_x: 0.2, scale_y: 0.2, opacity: 0, duration: SPILL_TIME / 2,
                mode: Clutter.AnimationMode.EASE_IN_QUAD, onStopped: () => spill.destroy()});
            return;
        }
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const spill = new St.BoxLayout({style_class: 'atelier-widget-spill'});
        this._spill = spill;
        CLOCK_FACES.filter(([id]) => id !== 'auto').forEach(([face, name], i) => {
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
            item.ease({opacity: 255, delay: i * SPILL_STAGGER, duration: SPILL_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            spill.add_child(item);
        });
        this.actor.add_child(spill);
        // Over the clock in the gallery, spreading from it.
        const [bx, by] = this._clockButton.get_transformed_position();
        const [, width] = spill.get_preferred_width(-1);
        const [, height] = spill.get_preferred_height(width);
        const monitor = Main.layoutManager.primaryMonitor;
        const x = Math.max(monitor.x + 12 * scale, Math.min(bx + this._clockButton.width / 2 - width / 2,
            monitor.x + monitor.width - width - 12 * scale));
        spill.set_position(Math.round(x), Math.round(by - height - 16 * scale));
        spill.set_pivot_point((bx + this._clockButton.width / 2 - x) / width, 1);
        spill.set({scale_x: 0.15, scale_y: 0.15, opacity: 0});
        spill.ease({scale_x: 1, scale_y: 1, duration: SPILL_TIME, mode: Clutter.AnimationMode.EASE_OUT_BACK});
        // (Not opacity: past its end it would wrap round to nothing.)
        spill.ease({opacity: 255, duration: SPILL_TIME / 2, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
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
        drag.target = this._desktop.spotFor(widget.entry.id, (x / scale - MARGIN) / PITCH, (y / scale - MARGIN) / PITCH);
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
        const [toX, toY] = moved ? cellOrigin(target.x, target.y).map(v => v * scale) : [x, y];
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
        const [px, py] = cellOrigin(x, y);
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
    destroy() {
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
        this._desktop.widgets.forEach(widget => this._release(widget));
        global.display.set_cursor(Meta.Cursor.DEFAULT);
        const layer = this._desktop.layer;
        this.actor.remove_child(layer);
        this._desktop.restoreLayer();
        this.actor.destroy();
        this.actor = null;
    }
}
