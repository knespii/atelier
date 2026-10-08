// The look of a dock beyond the stylesheet: how see-through its background
// is (fixed, or more opaque near windows), its own colour, a compact dock,
// square corners.
//
// (For now the stylesheet's look, as it is.)

export class DockTheming {
    /**
     * @param {Dock} dock
     * @param {Gio.Settings} settings - the dock's
     * @param {object} options
     * @param {boolean} options.glass - the dock is of glass
     */
    constructor(dock, settings, {glass}) {
        this._dock = dock;
        this._settings = settings;
        this._glass = glass;
    }

    /** Put the look on the dock again (after it is placed, say). */
    sync() {
    }

    destroy() {
    }
}
