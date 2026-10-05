// The top bar's look: without a background, the bar is just the workspaces
// on the left, the island in the middle and the status icons on the right.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PanelBackdrop} from './backdrop.js';

const CLEAN = 'atelier-bar-clean';

export class BarModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     */
    constructor({settings}) {
        this._settings = settings;
        this._backdrop = null;
    }

    enable() {
        this._barSettings = this._settings.get_child('bar');
        this._barSettings.connectObject('changed::transparent', () => this._sync(), this);
        this._sync();
    }

    disable() {
        this._barSettings?.disconnectObject(this);
        this._barSettings = null;
        Main.panel.remove_style_class_name(CLEAN);
        this._backdrop?.destroy();
        this._backdrop = null;
    }

    _sync() {
        const clean = this._barSettings.get_boolean('transparent');
        if (clean) {
            Main.panel.add_style_class_name(CLEAN);
            this._backdrop ??= new PanelBackdrop();
        } else {
            Main.panel.remove_style_class_name(CLEAN);
            this._backdrop?.destroy();
            this._backdrop = null;
        }
    }
}
