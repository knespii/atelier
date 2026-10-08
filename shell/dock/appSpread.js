// An app's windows spread out, alone, in the overview: what a click on an
// app with several windows can do.
//
// (For now it can't.)

export class AppSpread {
    /** @returns {boolean} whether the shell lets it */
    get supported() {
        return false;
    }

    /**
     * Spread the app's windows out, or put them back when they are.
     *
     * @param {Shell.App} _app
     * @returns {boolean} whether it did
     */
    toggle(_app) {
        return false;
    }

    destroy() {
    }
}
