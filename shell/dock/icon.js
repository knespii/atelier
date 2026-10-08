// An app in the dock: GNOME's dash icon (its menu, its running dot, drag
// and drop), opening and switching windows the dock's way (see actions.js)
// – only the windows that count for the dock (see windows.js) mark it as
// running. Its dot and its menu face away from the dock's edge, and so does
// its name while the pointer rests on it.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';

import {labelPosition} from '../../lib/dockGeometry.js';
import {activateApp, scrollApp, windowsOf} from './actions.js';
import {IconDecorations} from './indicators.js';

const LABEL_SHOW_TIME = 150; // milliseconds, as in GNOME's dash

// Where the running dot sits, by the dock's edge: at that edge of the icon.
const DOT_ALIGN = {
    BOTTOM: [Clutter.ActorAlign.CENTER, Clutter.ActorAlign.END],
    TOP: [Clutter.ActorAlign.CENTER, Clutter.ActorAlign.START],
    LEFT: [Clutter.ActorAlign.START, Clutter.ActorAlign.CENTER],
    RIGHT: [Clutter.ActorAlign.END, Clutter.ActorAlign.CENTER],
};

export const DockIcon = GObject.registerClass(
class AtelierDockIcon extends Dash.DashIcon {
    /**
     * @param {Shell.App} app
     * @param {number} iconSize
     * @param {object} ctx - {dock, settings, services, side}: the dock it is
     *   in, the dock's settings, the services all docks share and the edge
     */
    _init(app, iconSize, ctx) {
        super._init(app);
        this._ctx = ctx;
        this._iconSize = iconSize;
        this._cycle = null;
        this.icon.setIconSize(iconSize);
        [this._dot.x_align, this._dot.y_align] = DOT_ALIGN[ctx.side] ?? DOT_ALIGN.BOTTOM;
        this._decorations = new IconDecorations(this, ctx);
        this._updateRunningStyle();
    }

    /** @returns {object} {dock, settings, services, side} */
    get ctx() {
        return this._ctx;
    }

    /** @returns {Meta.Window[]} the app's windows that count for the dock */
    get windows() {
        return this._ctx ? windowsOf(this._ctx, this.app) : [];
    }

    /** @param {number} size - of the icon, logical pixels */
    setIconSize(size) {
        if (size === this._iconSize)
            return;
        this._iconSize = size;
        this.icon.setIconSize(size);
    }

    // Running here means windows that count for the dock. (GNOME's icon
    // asks before the dock's context is there.)
    _updateRunningStyle() {
        if (!this._dot || !this._ctx)
            return;
        if (this.windows.length > 0)
            this._dot.show();
        else
            this._dot.hide();
        this._decorations?.sync();
    }

    // The dot a little off its edge of the icon, as the stylesheet says.
    _updateDotStyle() {
        const themeNode = this._dot.get_theme_node();
        this._dot.translationX = themeNode.get_length('offset-x');
        this._dot.translationY = themeNode.get_length('offset-y');
    }

    activate(button) {
        const event = Clutter.get_current_event();
        const modifiers = event ? event.get_state() : 0;
        activateApp(this, button, modifiers, this._ctx);
    }

    vfunc_scroll_event(event) {
        return scrollApp(this, event, this._ctx);
    }

    // The menu opens away from the dock's edge, its arrow towards it.
    popupMenu() {
        AppDisplay.AppIcon.prototype.popupMenu.call(this, St.Side[this._ctx.side] ?? St.Side.BOTTOM);
    }

    getDragActor() {
        return this.app.create_icon_texture(this._iconSize);
    }

    _onDestroy() {
        this._decorations?.destroy();
        this._decorations = null;
        // (GNOME's app icon keeps its menu.)
        this._menu?.destroy();
        this._menu = null;
        super._onDestroy();
    }
});

// The item holding an icon in the dock's row, with the app's name beside it
// (above it, in a dock at the bottom) while the pointer rests on it.
export const DockItem = GObject.registerClass({
    Signals: {'menu-state-changed': {param_types: [GObject.TYPE_BOOLEAN]}},
}, class AtelierDockItem extends Dash.DashItemContainer {
    /**
     * @param {Shell.App} app
     * @param {number} iconSize
     * @param {object} ctx - {dock, settings, services, side}
     * @param {DockIcon} [icon] - the icon, when it is another kind of icon
     */
    _init(app, iconSize, ctx, icon = null) {
        super._init();
        this.app = app;
        this._ctx = ctx;
        icon ??= new DockIcon(app, iconSize, ctx);
        this.setChild(icon);
        this.setLabelText(app.get_name());
        icon.connect('notify::hover', () => {
            if (icon.hover && icon.shouldShowTooltip())
                this.showLabel();
            else
                this.hideLabel();
        });
        icon.connect('menu-state-changed', (_, opened) => {
            if (opened)
                this.hideLabel();
            this.emit('menu-state-changed', opened);
        });
    }

    get icon() {
        return this.child;
    }

    /** @param {number} size - of the icon, logical pixels */
    setIconSize(size) {
        this.icon.setIconSize(size);
    }

    showLabel() {
        if (this._ctx.settings.get_boolean('hide-tooltip'))
            return;
        // Above it, as in GNOME's dash.
        if (this._ctx.side === 'BOTTOM') {
            super.showLabel();
            return;
        }
        if (!this._labelText)
            return;
        this.label.set_text(this._labelText);
        this.label.opacity = 0;
        this.label.show();
        const [x, y] = this.get_transformed_position();
        const [width, height] = this.get_transformed_size();
        const offset = this.label.get_theme_node().get_length('-y-offset');
        const position = labelPosition(this._ctx.side, {x, y, width, height},
            {width: this.label.width, height: this.label.height}, offset,
            {width: global.stage.width, height: global.stage.height});
        this.label.set_position(position.x, position.y);
        this.label.ease({
            opacity: 255,
            duration: LABEL_SHOW_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }
});
