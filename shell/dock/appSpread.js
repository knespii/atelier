// An app's windows spread out, alone, in the overview: what a click on an
// app with several windows can do. While it lasts, the overview's
// workspaces and their thumbnails take only the app's windows, and typing
// doesn't start a search; it ends as the overview goes. (GNOME builds the
// workspaces of the overview anew each time it opens.)

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SearchController from 'resource:///org/gnome/shell/ui/searchController.js';
import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

export class AppSpread {
    constructor() {
        this._app = null;
        this._windows = [];
        this._injections = new InjectionManager();
    }

    /** @returns {boolean} whether the shell lets it */
    get supported() {
        return !Main.overview.isDummy &&
            typeof Workspace.Workspace?.prototype._isOverviewWindow === 'function' &&
            typeof WorkspaceThumbnail.WorkspaceThumbnail?.prototype._isOverviewWindow === 'function';
    }

    /** @returns {Shell.App|null} the app whose windows are spread out */
    get app() {
        return this._app;
    }

    /**
     * Spread the app's windows out, or put them back when they are.
     *
     * @param {Shell.App} app
     * @returns {boolean} whether it did
     */
    toggle(app) {
        if (!this.supported)
            return false;
        const spread = this._app;
        if (spread) {
            // (Put back as the overview goes.)
            Main.overview.hide();
            this._restore();
            if (spread === app)
                return true;
        }
        if (Main.overview.visible) {
            // Spread out once the overview as it is has gone (it builds its
            // workspaces only as it opens).
            Main.overview.hide();
            Main.overview.connectObject('hidden', () => {
                Main.overview.disconnectObject(this);
                this._spread(app);
            }, this);
        } else {
            this._spread(app);
        }
        return true;
    }

    _spread(app) {
        this._app = app;
        this._windows = app.get_windows();
        const windows = () => this._windows;
        this._injections.overrideMethod(Workspace.Workspace.prototype, '_isOverviewWindow',
            original => function (window) {
                return original.call(this, window) && windows().includes(window);
            });
        this._injections.overrideMethod(WorkspaceThumbnail.WorkspaceThumbnail.prototype, '_isOverviewWindow',
            original => function (actor) {
                return original.call(this, actor) && windows().includes(actor.get_meta_window());
            });
        if (typeof SearchController.SearchController?.prototype._shouldTriggerSearch === 'function')
            this._injections.overrideMethod(SearchController.SearchController.prototype, '_shouldTriggerSearch', () => () => false);
        const entry = Main.overview.searchEntry;
        if (entry) {
            entry.opacity = 0;
            entry.reactive = false;
        }
        Main.overview.connectObject('hidden', () => this._restore(), this);
        // Down to one window, that one is brought up.
        app.connectObject('windows-changed', () => {
            this._windows = app.get_windows();
            if (this._windows.length === 1)
                Main.activateWindow(this._windows[0]);
            else if (this._windows.length === 0)
                Main.overview.hide();
        }, this);
        Main.overview.show();
    }

    _restore() {
        if (!this._app)
            return;
        this._injections.clear();
        Main.overview.disconnectObject(this);
        this._app.disconnectObject(this);
        const entry = Main.overview.searchEntry;
        if (entry) {
            entry.opacity = 255;
            entry.reactive = true;
        }
        this._app = null;
        this._windows = [];
    }

    destroy() {
        Main.overview.disconnectObject(this);
        if (this._app && Main.overview.visible)
            Main.overview.hide();
        this._restore();
    }
}
