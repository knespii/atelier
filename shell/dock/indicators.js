// What is drawn on an app's icon in the dock: how its windows are marked
// (a style of dots, dashes or a bar, in the app's colour or one of the
// settings'), its count, progress and urgency.
//
// (For now GNOME's own running dot, as it is.)

export class IconDecorations {
    /**
     * @param {DockIcon} icon
     * @param {object} ctx - the icon's: {dock, settings, services, side}
     */
    constructor(icon, ctx) {
        this._icon = icon;
        this._ctx = ctx;
    }

    /** Draw it again: the app's windows, focus or badges changed. */
    sync() {
    }

    destroy() {
    }
}
