// The file manager's windows and the places they show, over its
// org.freedesktop.FileManager1 D-Bus interface (Files has it). It says
// 'changed' when they change; without a file manager that has it, it knows
// of no windows.
//
// (For now it asks nothing.)

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

export class FileManager1 extends EventEmitter {
    /** @returns {boolean} whether a file manager answers */
    get available() {
        return false;
    }

    /**
     * @param {string} _uri - of a place
     * @returns {Meta.Window[]} the file manager's windows showing it
     */
    windowsAt(_uri) {
        return [];
    }

    /**
     * @param {Meta.Window} _window
     * @returns {string[]} the places a file manager window shows
     */
    locationsOf(_window) {
        return [];
    }

    destroy() {
        this.disconnectAll();
    }
}
