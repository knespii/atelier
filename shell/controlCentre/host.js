// GNOME's quick settings – Wi-Fi, Bluetooth, sliders, power mode, Caffeine
// and every other tile, with their menus – shown in Atelier's control centre.
// The tiles stay GNOME's (and the extensions'): only the grid that holds
// them moves out of GNOME's menu, so new tiles appear here too. It goes
// back when the control centre is turned off.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';

// The menus of the tiles open in a layer over the grid, right under their
// tile, while the grid makes room for them. Both share the same origin.
const HostLayout = GObject.registerClass(
class AtelierQuickSettingsHostLayout extends Clutter.LayoutManager {
    _init(grid, overlay) {
        super._init();
        this._grid = grid;
        this._overlay = overlay;
    }

    vfunc_get_preferred_width(_container, forHeight) {
        return this._grid.get_preferred_width(forHeight);
    }

    vfunc_get_preferred_height(_container, forWidth) {
        return this._grid.get_preferred_height(forWidth);
    }

    vfunc_allocate(_container, box) {
        const width = box.get_width();
        const [, gridHeight] = this._grid.get_preferred_height(width);
        this._grid.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: gridHeight}));
        const [, overlayHeight] = this._overlay.get_preferred_height(width);
        this._overlay.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: width, y2: overlayHeight}));
    }
});

export class QuickSettingsHost {
    /**
     * @param {object} quickSettings - Main.panel.statusArea.quickSettings
     */
    constructor(quickSettings) {
        this._menu = quickSettings.menu;
        const {_grid: grid, _overlay: overlay} = this._menu;
        this._grid = grid;
        this._overlay = overlay;
        this._gridParent = grid.get_parent();
        this._gridIndex = this._gridParent.get_children().indexOf(grid);
        this._overlayParent = overlay.get_parent();
        this._overlayConstraints = overlay.get_constraints();

        this._menu.close(PopupAnimation.NONE);
        overlay.clear_constraints();
        this._gridParent.remove_child(grid);
        this._overlayParent.remove_child(overlay);

        this.actor = new St.Widget({
            style_class: 'atelier-cc-tiles',
            layout_manager: new HostLayout(grid, overlay),
            x_expand: true,
        });
        this.actor.add_child(grid);
        this.actor.add_child(overlay);
    }

    /** @returns {St.Widget} GNOME's grid of tiles */
    get grid() {
        return this._grid;
    }

    /** Close a tile's menu that is open. */
    closeMenus() {
        this._menu._activeMenu?.close(PopupAnimation.NONE);
    }

    /** Give the grid back to GNOME's menu. */
    release() {
        this.closeMenus();
        this.actor.get_parent()?.remove_child(this.actor);
        this.actor.remove_child(this._grid);
        this.actor.remove_child(this._overlay);
        const index = Math.min(this._gridIndex, this._gridParent.get_n_children());
        this._gridParent.insert_child_at_index(this._grid, index);
        this._overlayParent.add_child(this._overlay);
        this._overlayConstraints.forEach(constraint => this._overlay.add_constraint(constraint));
        this.actor.destroy();
        this.actor = null;
    }
}
