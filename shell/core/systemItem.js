// GNOME's system item in the quick settings (the battery tile, the power
// button…) is made a moment after the bar: once the quick settings have
// loaded their network and Bluetooth parts. Atelier, enabled as the session
// starts, may come before it.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Call back with GNOME's system item: at once if it is there, or as soon
 * as it is.
 *
 * @param {Function} callback - given the system item
 * @returns {Function} stops waiting for it (does nothing once called back)
 */
export function whenSystemItem(callback) {
    const quickSettings = Main.panel.statusArea.quickSettings;
    const item = () => quickSettings?._system?._systemItem ?? null;
    if (item()) {
        callback(item());
        return () => {};
    }
    // (The quick settings put their indicators in the bar as they make them.)
    const box = quickSettings?._indicators;
    if (!box)
        return () => {};
    let id = box.connect('child-added', () => {
        if (!item())
            return;
        box.disconnect(id);
        id = 0;
        callback(item());
    });
    return () => {
        if (id)
            box.disconnect(id);
        id = 0;
    };
}
