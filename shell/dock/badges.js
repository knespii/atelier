// What the dock's icons carry besides the app: a count (of the app's
// notifications, or one the app gives over Unity's launcher API), its
// progress, whether it is urgent. One source for all the docks, saying
// 'changed' with the app's id whenever any of it changes for an app.
//
// (For now it knows of nothing: no counts, no progress.)

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

export class BadgeSource extends EventEmitter {
    /**
     * @param {Gio.Settings} settings - the dock's
     */
    constructor(settings) {
        super();
        this._settings = settings;
    }

    /**
     * @param {string} _appId
     * @returns {number} the count to show on the app, 0 for none
     */
    countFor(_appId) {
        return 0;
    }

    /**
     * @param {string} _appId
     * @returns {number|null} how far along the app is, 0 to 1, or null for nothing to show
     */
    progressFor(_appId) {
        return null;
    }

    /**
     * @param {string} _appId
     * @returns {boolean} whether the app asks for attention
     */
    urgentFor(_appId) {
        return false;
    }

    destroy() {
        this.disconnectAll();
    }
}
