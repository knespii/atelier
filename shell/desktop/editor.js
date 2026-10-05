// Editing the desktop's widgets. The widgets come up over the windows, on a
// dimmed screen with the grid they snap to: drag one to move it, its
// buttons resize or remove it, and the gallery at the bottom adds more.
// Done (or Esc) puts them back under the windows.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {KINDS, UNIT, cellAt, cellOrigin} from '../../lib/widgets.js';

const SNAP_TIME = 160;

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

export class DesktopEditor {
    /**
     * @param {DesktopModule} desktop
     */
    constructor(desktop) {
        this._desktop = desktop;
        this._drag = null;
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
            const button = new St.Button({style_class: 'atelier-widget-gallery-button', can_focus: true, child: box});
            button.connect('clicked', () => {
                if (!desktop.addWidget(kind))
                    this._shake(button);
            });
            this._gallery.add_child(button);
        }
        const done = new St.Button({style_class: 'atelier-widget-gallery-done', label: 'Done', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER});
        done.connect('clicked', () => desktop.stopEditing());
        this._gallery.add_child(done);
        this.actor.add_child(this._gallery);
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
     * Give a widget its buttons and make it draggable.
     *
     * @param {DesktopWidget} widget
     */
    adopt(widget) {
        widget.editing = true;
        const controls = new St.BoxLayout({style_class: 'atelier-widget-controls'});
        controls.inCorner = true;
        for (const [icon, name, action] of [
            ['view-fullscreen-symbolic', 'Change size', () => this._desktop.resizeWidget(widget.entry.id)],
            ['window-close-symbolic', 'Remove', () => this._desktop.removeWidget(widget.entry.id)],
        ]) {
            const button = new St.Button({
                style_class: 'atelier-widget-control',
                accessible_name: name,
                child: new St.Icon({icon_name: icon}),
            });
            button.connect('clicked', action);
            controls.add_child(button);
        }
        widget.add_child(controls);
        widget._editControls = controls;
        widget.connectObject('button-press-event', (_, event) => this._onPress(widget, event), this);
    }

    _release(widget) {
        widget.editing = false;
        widget._editControls?.destroy();
        widget._editControls = null;
        widget.disconnectObject(this);
    }

    _onPress(widget, event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._drag)
            return Clutter.EVENT_PROPAGATE;
        // (The buttons in its corner have their own clicks.)
        if (widget._editControls?.contains(global.stage.get_event_actor(event)))
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this._drag = {widget, dx: x - widget.x, dy: y - widget.y, x: widget.x, y: widget.y};
        widget.add_style_pseudo_class('dragged');
        this._desktop.layer.set_child_above_sibling(widget, null);
        this._dragGrab = global.stage.grab(this.actor);
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const {widget, dx, dy} = this._drag;
        widget.set_position(Math.round(x - dx), Math.round(y - dy));
        this._desktop.syncGlass();
        return Clutter.EVENT_STOP;
    }

    _onRelease(event) {
        if (!this._drag || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const {widget, x, y} = this._drag;
        this._drag = null;
        this._dragGrab?.dismiss();
        this._dragGrab = null;
        widget.remove_style_pseudo_class('dragged');
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Where it was dropped, snapped to the grid – unless it doesn't fit.
        const [cellX, cellY] = cellAt(widget.x / scale, widget.y / scale);
        const moved = this._desktop.moveWidget(widget.entry.id, cellX, cellY);
        const [toX, toY] = moved ? cellOrigin(widget.entry.x, widget.entry.y).map(v => v * scale) : [x, y];
        widget.ease({
            x: toX,
            y: toY,
            duration: SNAP_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this._desktop.syncGlass(),
        });
        if (!moved)
            this._shake(widget);
        return Clutter.EVENT_STOP;
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
        this._dragGrab?.dismiss();
        this._dragGrab = null;
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._desktop.widgets.forEach(widget => this._release(widget));
        const layer = this._desktop.layer;
        this.actor.remove_child(layer);
        this._desktop.restoreLayer();
        this.actor.destroy();
        this.actor = null;
    }
}
