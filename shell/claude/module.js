// Claude Code's usage on this computer: read in the background, shown in the
// top bar, the island and the control centre.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ClaudeUsage} from './usage.js';
import {ClaudeView} from './view.js';

export class ClaudeModule {
    /**
     * @param {object} context
     * @param {object} context.extension
     */
    constructor({extension}) {
        this._path = extension.path;
        this.usage = null;
        this.view = null;
    }

    /** @returns {Gio.Icon} */
    get icon() {
        return Gio.icon_new_for_string(GLib.build_filenamev([this._path, 'icons', 'sparkle-symbolic.svg']));
    }

    /** @returns {boolean} whether there is Claude Code history to show */
    get hasData() {
        return Boolean(this.usage?.summary?.found);
    }

    enable() {
        this.usage = new ClaudeUsage(this._path);
        // The control centre's Claude tab; it outlives the control centre.
        this.view = new ClaudeView(this.usage);
        this.usage.start();
    }

    disable() {
        this.usage?.stop();
        this.view?.destroy();
        this.view = null;
        this.usage = null;
    }

    /** @returns {ClaudeView} a view of its own, e.g. for a preview in the island */
    createView() {
        return new ClaudeView(this.usage);
    }
}
