// The Show Applications button for the dock: GNOME's (the grid icon, and an
// app dragged onto it is unpinned), the size of the dock's icons, with its
// name beside it as theirs. It opens the app grid, and closes it when it is
// open; it looks pressed while the grid is shown.

import GObject from 'gi://GObject';

import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DockItem} from './icon.js';

const ShowAppsItem = GObject.registerClass(
class AtelierDockShowApps extends Dash.ShowAppsIcon {
    /** @param {Dock} dock - the dock it is in */
    _init(dock) {
        super._init();
        this._dock = dock;
        // (What DockItem's name needs: the dock's settings and edge.)
        this._ctx = {settings: dock.settings, side: dock.side};
        this.add_style_class_name('atelier-dock-show-apps');
        // (Not taking the room left in panel mode: at the edge, it is at
        // the very end.)
        this.x_expand = this.y_expand = false;
        this.icon.setIconSize(dock.iconSize);
        this.toggleButton.connect('notify::hover', () => {
            if (this.toggleButton.hover)
                this.showLabel();
            else
                this.hideLabel();
        });
        this.toggleButton.connect('clicked', () => this._toggle());
        dock.connectObject(
            'placed', () => this.setIconSize(dock.iconSize),
            'redisplayed', () => this.setIconSize(dock.iconSize),
            this);
        Main.overview.dash.showAppsButton.connectObject('notify::checked', () => this._sync(), this);
        Main.overview.connectObject('hidden', () => this._sync(), this);
        this._sync();
        this.show(true);
    }

    /** @param {number} size - of the icon, logical pixels */
    setIconSize(size) {
        this.icon.setIconSize(size);
    }

    // Beside it, away from the dock's edge, as the apps' names.
    showLabel() {
        DockItem.prototype.showLabel.call(this);
    }

    /** @returns {boolean} whether the app grid is shown (or about to be) */
    get gridShown() {
        return Main.overview.visibleTarget && Main.overview.dash.showAppsButton.checked;
    }

    _toggle() {
        this.hideLabel();
        if (this.gridShown)
            Main.overview.hide();
        else
            Main.overview.showApps();
        this._sync();
    }

    _sync() {
        this.toggleButton.checked = this.gridShown;
    }
});

/**
 * @param {Dock} dock - the dock it is for
 * @returns {Clutter.Actor} the button, the dock's to place and destroy
 */
export function createShowAppsItem(dock) {
    return new ShowAppsItem(dock);
}
