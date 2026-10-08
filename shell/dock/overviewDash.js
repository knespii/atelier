// The dock in the overview, in place of GNOME's dash (show-in-overview):
// the dash is hidden, and the overview keeps clear of the main dock (on
// the monitor the overview's controls are on, the main one). As Dash to
// Dock does it: only the overview's own states make room – the desktop
// (HIDDEN) keeps the whole work area, so as the overview opens and closes
// the workspace grows into all of it, with no strip left over by the dock.
// A dock at the bottom stands in for the dash's height (GNOME makes room
// for that); on any other side, the workspaces and the app grid are moved
// clear of it.

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

export class OverviewDash {
    /** @param {Gio.Settings} settings - the dock's */
    constructor(settings) {
        this._settings = settings;
        this._injections = new InjectionManager();
        this._dash = null;
        this._dock = null;
        // The room the overview leaves the dock: {side, size}, size 0 for none.
        this._room = {side: 'BOTTOM', size: 0};
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
            this._takeOver();
        else if (!wanted && this._dash)
            this._giveBack();
        this._syncRoom();
    }

    _takeOver() {
        const dash = Main.overview.dash;
        const controls = this._controls;
        if (!dash || !controls || Main.overview.isDummy)
            return;
        this._dash = dash;
        dash.hide();
        dash.connectObject('notify::visible', () => dash.visible && dash.hide(), this);
        const room = this._room;
        // At the bottom, the dock is as tall as the dash GNOME makes room
        // for; elsewhere the dash takes none.
        this._injections.overrideMethod(dash, 'get_preferred_height', () => function () {
            const size = room.side === 'BOTTOM' ? room.size : 0;
            return [size, size];
        });
        // (Hidden, it is neither sized nor placed.)
        this._injections.overrideMethod(dash, 'setMaxSize', () => function () {});
        this._injections.overrideMethod(dash, 'allocate', () => function () {});
        const layout = Object.getPrototypeOf(controls.layout_manager);
        const clear = (box, state) => {
            if (state === ControlsState.HIDDEN || room.side === 'BOTTOM' || room.size === 0)
                return box;
            if (room.side === 'TOP') {
                box.set_origin(box.x1, box.y1 + room.size);
                box.set_size(box.get_width(), Math.max(0, box.get_height() - room.size));
            } else {
                const x = room.side === 'LEFT' ? box.x1 + room.size : box.x1;
                box.set_origin(x, box.y1);
                box.set_size(Math.max(0, box.get_width() - room.size), box.get_height());
            }
            return box;
        };
        this._injections.overrideMethod(layout, '_computeWorkspacesBoxForState', original =>
            function (state, ...args) {
                return clear(original.call(this, state, ...args), state);
            });
        this._injections.overrideMethod(layout, '_getAppDisplayBoxForState', original =>
            function (state, ...args) {
                const box = original.call(this, state, ...args);
                return state === ControlsState.APP_GRID ? clear(box, state) : box;
            });
        controls.queue_relayout();
    }

    _giveBack() {
        const dash = this._dash;
        this._dash = null;
        this._injections.clear();
        dash.disconnectObject(this);
        dash.show();
        dash.queue_relayout();
        this._controls?.queue_relayout();
    }

    // As far as the main dock reaches into its monitor from its edge, and
    // its gap again.
    _syncRoom() {
        const dock = this._dock;
        const rect = dock?.staticRect;
        let size = 0;
        if (this._dash && rect && dock.monitorIndex === Main.layoutManager.primaryIndex) {
            const monitor = dock.monitor;
            size = Math.ceil({
                TOP: rect.y + rect.height - monitor.y - Main.layoutManager.panelBox.height,
                RIGHT: monitor.x + monitor.width - rect.x,
                BOTTOM: monitor.y + monitor.height - rect.y,
                LEFT: rect.x + rect.width - monitor.x,
            }[dock.side] + dock.margin);
        }
        const side = dock?.side ?? 'BOTTOM';
        if (this._room.size === size && this._room.side === side)
            return;
        this._room.side = side;
        this._room.size = size;
        this._dash?.queue_relayout();
        this._controls?.queue_relayout();
    }

    /** @returns {object} {side, size}: the room the overview leaves the dock */
    get room() {
        return {...this._room};
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._dock?.disconnectObject(this);
        this._dock = null;
        if (this._dash)
            this._giveBack();
    }
}
