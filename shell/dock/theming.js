// The look of a dock beyond the stylesheet: how see-through its background
// is (as the stylesheet has it, fixed, or more opaque while a window is
// near), its own colour, a compact dock, square corners (always, in panel
// mode). The background is an inline style on the dock's shape
// (lib/dockTheme.js); a change of it eases, as the stylesheet says.
//
// Over glass the opacity is shared: the glass itself fades below 40 %,
// a wash of the colour comes in above (lib/seeThrough.js).
//
// Whether a window is near is looked at under DYNAMIC, and over glass,
// which is live near windows (shell/dock/dock.js). In the overview none is,
// as Dash to Dock has it: the dock is over the overview's wallpaper there.

import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DEFAULT_COLOR, backgroundCss, dynamicAlpha, dynamicAlphas, parseColor, windowNear} from '../../lib/dockTheme.js';
import {rgbToHex} from '../../lib/palette.js';
import {glassShare} from '../../lib/seeThrough.js';

// How close a window counts as near the dock, logical pixels.
const REACH = 8;

// Settings the look is put on again for.
const KEYS = ['transparency-mode', 'background-opacity', 'customize-alphas', 'min-alpha', 'max-alpha',
    'custom-background-color', 'background-color', 'custom-theme-shrink', 'force-straight-corner'];

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
        this._style = null; // the inline style put on last
        this.near = false; // a window is near (only looked at under DYNAMIC and over glass)

        settings.connectObject(...KEYS.flatMap(key => [`changed::${key}`, () => this.sync()]), this);
        // (Only DYNAMIC and glass look at the windows.)
        dock.services.windows.connectObject('changed', () => {
            if (this._watchesWindows)
                this.sync();
        }, this);
        Main.overview.connectObject(
            'showing', () => this._watchesWindows && this.sync(),
            'hidden', () => this._watchesWindows && this.sync(),
            this);
        // The classes are on before the dock is first measured.
        this._syncClasses();
    }

    get _mode() {
        return this._settings.get_string('transparency-mode');
    }

    // Whether windows near it matter: under DYNAMIC (more opaque near them)
    // and over glass (live near them).
    get _watchesWindows() {
        return this._mode === 'DYNAMIC' || this._glass;
    }

    /** Put the look on the dock again (after it is placed, say). */
    sync() {
        const container = this._dock.container;
        if (!container)
            return;
        if (this._syncClasses()) {
            // Its padding and corners changed: measured and placed again,
            // the glass with its new corners.
            this._dock.queuePlace();
            this._dock.syncGlass();
        }
        const settings = this._settings;
        const mode = this._mode;
        const near = this._watchesWindows && !Main.overview.visible && this._windowNear();
        if (near !== this.near) {
            this.near = near;
            this._dock.syncNear?.();
        }
        const alpha = this._alphaFor(this.near);
        const opacity = settings.get_double('background-opacity');
        // (As the profile has it, the glass is all there.)
        const custom = mode === 'FIXED' || mode === 'DYNAMIC';
        this._dock.glassOpacity = custom && this._glass ? glassShare(mode === 'FIXED' ? opacity : alpha).glass : 1;
        const style = backgroundCss({
            mode,
            opacity,
            alpha,
            color: settings.get_boolean('custom-background-color') ? settings.get_string('background-color') : null,
            glass: this._glass,
        });
        // (Near windows and away it eases quicker: the class first, so
        // the change has its duration.)
        if (mode === 'DYNAMIC')
            container.add_style_class_name('atelier-dock-dynamic');
        else
            container.remove_style_class_name('atelier-dock-dynamic');
        if (style === this._style)
            return;
        this._style = style;
        container.set_style(style || null);
        this._dock.updateVibrancy?.();
    }

    // How opaque DYNAMIC has the background, near windows or away from them
    // (0 in the other modes).
    _alphaFor(near) {
        if (this._mode !== 'DYNAMIC')
            return 0;
        const {min, max} = dynamicAlphas({
            customize: this._settings.get_boolean('customize-alphas'),
            min: this._settings.get_double('min-alpha'),
            max: this._settings.get_double('max-alpha'),
        });
        return dynamicAlpha(near, min, max);
    }

    /**
     * What lies over the dock's glass and how much of the glass shows, as
     * sync() has them – near windows or away from them (for the type on
     * it: shell/core/vibrancy.js).
     *
     * @param {boolean} [near] - a window near it (DYNAMIC); as it is now if
     *   not said
     * @returns {{layers: object[], strength: number}} the wash ({color,
     *   alpha}, none in DEFAULT) and the glass's share, 0 … 1
     */
    washOf(near = this.near) {
        const mode = this._mode;
        if (mode !== 'FIXED' && mode !== 'DYNAMIC')
            return {layers: [], strength: 1};
        const wanted = mode === 'FIXED' ? this._settings.get_double('background-opacity') : this._alphaFor(near);
        const share = this._glass ? glassShare(wanted) : {glass: 1, tint: wanted};
        const chosen = this._settings.get_boolean('custom-background-color')
            ? this._settings.get_string('background-color') : null;
        const color = rgbToHex(parseColor(chosen) ?? parseColor(DEFAULT_COLOR));
        return {layers: share.tint > 0 ? [{color, alpha: share.tint}] : [], strength: share.glass};
    }

    // Compact, square corners (panel mode has them anyway). Says whether
    // anything changed.
    _syncClasses() {
        const container = this._dock.container;
        const wanted = {
            'atelier-dock-shrink': this._settings.get_boolean('custom-theme-shrink'),
            'atelier-dock-straight': this._settings.get_boolean('force-straight-corner') ||
                this._settings.get_boolean('extend-height'),
        };
        let changed = false;
        for (const [name, on] of Object.entries(wanted)) {
            if (container.has_style_class_name(name) === on)
                continue;
            changed = true;
            if (on)
                container.add_style_class_name(name);
            else
                container.remove_style_class_name(name);
        }
        return changed;
    }

    // A window on the dock's monitor and workspace, showing, over the dock
    // (where it is when shown) or close to it.
    _windowNear() {
        const dock = this._dock;
        const workspace = global.workspace_manager.get_active_workspace();
        const frames = workspace.list_windows()
            .filter(window => window.get_monitor() === dock.monitorIndex &&
                window.showing_on_its_workspace() && !window.minimized &&
                window.get_window_type() !== Meta.WindowType.DESKTOP && !window.skip_taskbar)
            .map(window => window.get_frame_rect());
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return windowNear(dock.staticRect, frames, REACH * scale);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._dock.services.windows.disconnectObject(this);
        Main.overview.disconnectObject(this);
    }
}
