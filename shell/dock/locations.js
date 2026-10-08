// Places in the dock besides apps: the trash and drives. Each is an icon of
// its own (a made-up Shell.App), and file manager windows showing it go
// with it rather than with the file manager. One for all the docks; it says
// 'changed' when the places to show change.
//
// (For now it shows none.)

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

export class Locations extends EventEmitter {
    /**
     * @param {Gio.Settings} settings - the dock's
     */
    constructor(settings) {
        super();
        this._settings = settings;
    }

    /** @returns {Shell.App[]} the places to show, in their order */
    apps() {
        return [];
    }

    /**
     * The dock's item for a place.
     *
     * @param {Shell.App} _app - one of apps(), or any other app
     * @param {number} _iconSize
     * @param {object} _ctx - the icon's context: {dock, settings, services, side}
     * @returns {DockItem|null} the item, or null for an app that isn't a place
     */
    createItem(_app, _iconSize, _ctx) {
        return null;
    }

    /**
     * @param {Shell.App} _app
     * @returns {Meta.Window[]|null} the windows of a place, or null for an
     *   app that isn't one
     */
    windowsFor(_app) {
        return null;
    }

    /**
     * @param {Meta.Window} _window
     * @returns {boolean} whether the window goes with a place (and not with
     *   the file manager)
     */
    owns(_window) {
        return false;
    }

    destroy() {
        this.disconnectAll();
    }
}
