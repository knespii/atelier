// The dock's keyboard shortcuts: Super with 1 to 0 opens its apps in order
// (in place of GNOME's own shortcuts while it is on), and a shortcut shows
// the dock for a while.
//
// (For now there are none.)

export class DockHotkeys {
    /**
     * @param {DockModule} module - for its docks (module.dock is the main one)
     * @param {Gio.Settings} settings - the dock's
     */
    constructor(module, settings) {
        this._module = module;
        this._settings = settings;
    }

    /** Take the shortcuts the settings ask for. */
    enable() {
    }

    /** Give back every shortcut taken (GNOME's own as well). */
    destroy() {
    }
}
