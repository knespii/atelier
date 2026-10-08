// The dock in the overview, in place of GNOME's dash (show-in-overview):
// the dash is hidden and takes no room, and the overview keeps clear of
// the main dock on its side – on the monitor the overview's controls are
// on (the main one), only.

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MARGINS = {TOP: 'margin_top', RIGHT: 'margin_right', BOTTOM: 'margin_bottom', LEFT: 'margin_left'};

export class OverviewDash {
    /** @param {Gio.Settings} settings - the dock's */
    constructor(settings) {
        this._settings = settings;
        this._injections = new InjectionManager();
        this._dash = null;
        this._dock = null;
        settings.connectObject('changed::show-in-overview', () => this._sync(), this);
    }

    /** @param {Dock|null} dock - the main dock, or none */
    attach(dock) {
        this._dock?.disconnectObject(this);
        this._dock = dock;
        dock?.connectObject('placed', () => this._syncRoom(), this);
        this._sync();
    }

    get _controls() {
        return Main.overview._overview?._controls ?? null;
    }

    _sync() {
        const wanted = Boolean(this._dock) && this._settings.get_boolean('show-in-overview');
        if (wanted && !this._dash)
            this._hideDash();
        else if (!wanted && this._dash)
            this._restoreDash();
        this._syncRoom();
    }

    // GNOME's dash out of sight, taking no room (the controls ask it how
    // tall it is).
    _hideDash() {
        const dash = Main.overview.dash;
        if (!dash || Main.overview.isDummy)
            return;
        this._dash = dash;
        dash.hide();
        dash.connectObject('notify::visible', () => dash.visible && dash.hide(), this);
        this._injections.overrideMethod(dash, 'get_preferred_height', () => function () {
            return [0, 0];
        });
        dash.queue_relayout();
    }

    _restoreDash() {
        const dash = this._dash;
        this._dash = null;
        this._injections.clear();
        dash.disconnectObject(this);
        dash.show();
        dash.queue_relayout();
    }

    // The overview clear of the main dock: room on its side, as wide as
    // the dock and its gap.
    _syncRoom() {
        const controls = this._controls;
        if (!controls)
            return;
        const room = {TOP: 0, RIGHT: 0, BOTTOM: 0, LEFT: 0};
        const dock = this._dock;
        const rect = dock?.staticRect;
        if (this._dash && rect && dock.monitorIndex === Main.layoutManager.primaryIndex) {
            const monitor = dock.monitor;
            room[dock.side] = Math.ceil({
                TOP: rect.y + rect.height - monitor.y - Main.layoutManager.panelBox.height,
                RIGHT: monitor.x + monitor.width - rect.x,
                BOTTOM: monitor.y + monitor.height - rect.y,
                LEFT: rect.x + rect.width - monitor.x,
            }[dock.side]) + dock.margin;
        }
        for (const [side, property] of Object.entries(MARGINS)) {
            if (controls[property] !== room[side])
                controls[property] = room[side];
        }
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._dock?.disconnectObject(this);
        this._dock = null;
        if (this._dash)
            this._restoreDash();
        this._syncRoom();
    }
}
