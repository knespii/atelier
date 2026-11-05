// The control centre's modules – rounded cards holding GNOME's tiles – and
// the grid that places them (lib/controlGrid.js packs it).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {CELL, GAP, gridSize, packModules, rectsOf, rowsFor} from '../../lib/controlGrid.js';

const scaleOf = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

const sizeOf = () => {
    const scale = scaleOf();
    return {cell: CELL * scale, gap: GAP * scale};
};

/**
 * Move an actor to another parent as it is: Clutter would show one hidden
 * (GNOME's Wi-Fi tile without Wi-Fi, say) as it is added.
 *
 * @param {Clutter.Actor} actor
 * @param {Function} add - adds it to its new parent
 */
export function moveTo(actor, add) {
    // (One never added anywhere yet is shown as it is added, as it should.)
    const parent = actor.get_parent();
    const visible = actor.visible;
    parent?.remove_child(actor);
    add();
    if (parent && actor.visible !== visible)
        actor.visible = visible;
}

/**
 * A module: a card of the grid, so many cells wide and at least so many
 * tall (more when what it holds needs it). It holds slots, each with one
 * tile (GNOME's, or an extension's), and shows while one of them does.
 */
export const ControlModule = GObject.registerClass(
class AtelierControlModule extends St.BoxLayout {
    /**
     * @param {string} id
     * @param {object} spec
     * @param {number} spec.cols
     * @param {number} [spec.rows] - at least
     * @param {number|string} [spec.pane] - 0, 1 or 'any'
     * @param {string} [spec.title] - a heading over its tiles
     * @param {boolean} [spec.horizontal] - its tiles side by side
     * @param {boolean} [spec.always] - shown with nothing in it
     * @param {boolean} [spec.rowPerSlot] - a row of cells for each tile shown
     * @param {boolean} [spec.fixed] - exactly so many rows (its tiles fit
     *   at their least height)
     */
    _init(id, {cols, rows = 1, pane = 'any', title = null, horizontal = false, always = false, rowPerSlot = false,
        fixed = false}) {
        super._init({
            style_class: `atelier-cc-module atelier-cc-module-${id}`,
            orientation: Clutter.Orientation.VERTICAL,
            visible: always,
        });
        this.moduleId = id;
        this.cols = cols;
        this._minRows = rows;
        this._rowPerSlot = rowPerSlot;
        this.fixedRows = fixed;
        this.pane = pane;
        this._always = always;
        if (title) {
            this.add_child(new St.Label({style_class: 'atelier-cc-module-title', text: title}));
        }
        this.body = new St.BoxLayout({
            style_class: 'atelier-cc-module-body',
            orientation: horizontal ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this.body);
        this._slots = [];
    }

    /**
     * Hold a tile, among the others by rank.
     *
     * @param {Clutter.Actor} item
     * @param {string} kind - 'row', 'square', 'slider', 'capsule', 'compact', 'wide', 'media'
     * @param {number} rank
     * @returns {St.Bin} its slot
     */
    addSlot(item, kind, rank = 0) {
        const slot = new St.Bin({
            style_class: `atelier-cc-slot atelier-cc-${kind}`,
            x_expand: kind !== 'compact',
            y_expand: ['row', 'square', 'media', 'wide', 'system', 'capsule'].includes(kind),
        });
        slot._rank = rank;
        moveTo(item, () => slot.set_child(item));
        const index = this._slots.findIndex(other => other._rank > rank);
        if (index < 0) {
            this._slots.push(slot);
            this.body.add_child(slot);
        } else {
            this.body.insert_child_below(slot, this._slots[index]);
            this._slots.splice(index, 0, slot);
        }
        this.sync();
        return slot;
    }

    /**
     * Let go of a tile (it is not destroyed).
     *
     * @param {St.Bin} slot
     */
    removeSlot(slot) {
        const item = slot.get_child();
        if (item)
            slot.set_child(null);
        this._slots = this._slots.filter(s => s !== slot);
        slot.destroy();
        this.sync();
    }

    /** @returns {number} the rows of cells it takes at least */
    get minRows() {
        return this._rowPerSlot ? Math.max(1, this._slots.filter(s => s.visible).length) : this._minRows;
    }

    /** @returns {St.Bin[]} */
    get slots() {
        return this._slots;
    }

    /** Show the slots whose tiles show, and the module with one. */
    sync() {
        for (const slot of this._slots)
            slot.visible = Boolean(slot.get_child()?.visible);
        this.visible = this._always || this._slots.some(slot => slot.visible);
    }
});

/**
 * Places its modules (ControlModule children) as lib/controlGrid.js packs
 * them: in order, each where it first fits.
 */
const ModuleGridLayout = GObject.registerClass(
class AtelierModuleGridLayout extends Clutter.LayoutManager {
    _pack(container) {
        const size = sizeOf();
        const modules = container.get_children().filter(c => c.visible && c instanceof ControlModule);
        const requests = modules.map(module => {
            const width = module.cols * (size.cell + size.gap) - size.gap;
            const [, height] = module.get_preferred_height(width);
            const rows = module.fixedRows ? module.minRows : rowsFor(height, module.minRows, size);
            return {id: module, cols: module.cols, rows, pane: module.pane};
        });
        return {...packModules(requests), size};
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        const [width] = gridSize(1, sizeOf());
        return [width, width];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        const {rows, size} = this._pack(container);
        const [, height] = gridSize(rows, size);
        return [height, height];
    }

    vfunc_allocate(container, box) {
        const {placements, size} = this._pack(container);
        const [width] = gridSize(1, size);
        // (Centred when it is given more room: the island wider.)
        const x0 = box.x1 + Math.max(0, Math.floor((box.get_width() - width) / 2));
        for (const rect of rectsOf(placements, size)) {
            rect.id.allocate(new Clutter.ActorBox({
                x1: x0 + rect.x,
                y1: box.y1 + rect.y,
                x2: x0 + rect.x + rect.width,
                y2: box.y1 + rect.y + rect.height,
            }));
        }
    }
});

/** @returns {St.Widget} a grid for ControlModules */
export function moduleGrid() {
    return new St.Widget({
        style_class: 'atelier-cc-modules',
        layout_manager: new ModuleGridLayout(),
        x_expand: true,
    });
}

/**
 * Where an actor is in another (an ancestor), and its corners' radius.
 *
 * @param {Clutter.Actor} actor
 * @param {Clutter.Actor} ancestor
 * @returns {{x: number, y: number, width: number, height: number, radius: number}|null}
 */
export function rectIn(actor, ancestor) {
    if (!actor?.visible || !ancestor?.contains(actor))
        return null;
    const box = actor.get_allocation_box();
    let x = 0;
    let y = 0;
    for (let a = actor; a && a !== ancestor; a = a.get_parent()) {
        const b = a.get_allocation_box();
        x += b.x1 + a.translation_x;
        y += b.y1 + a.translation_y;
    }
    let radius = 0;
    try {
        if (actor instanceof St.Widget && actor.get_stage())
            radius = actor.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
    } catch {
        radius = 0;
    }
    return {x, y, width: box.get_width(), height: box.get_height(), radius};
}
