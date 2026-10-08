// The look of a dock beyond the stylesheet: how see-through its background
// is (as the stylesheet has it, fixed, or more opaque while a window is
// near), its own colour, a compact dock, square corners (always, in panel
// mode). The background is an inline style on the dock's shape
// (lib/dockTheme.js); a change of it eases, as the stylesheet says.
//
// Over glass the opacity is shared: the glass itself fades below 40 %,
// a wash of the colour comes in above (lib/seeThrough.js).

import Meta from 'gi://Meta';
import St from 'gi://St';

import {backgroundCss, dynamicAlpha, dynamicAlphas, windowNear} from '../../lib/dockTheme.js';
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
        this.near = false; // a window is near (only looked at under DYNAMIC)

        settings.connectObject(...KEYS.flatMap(key => [`changed::${key}`, () => this.sync()]), this);
        // (Only DYNAMIC looks at the windows.)
        dock.services.windows.connectObject('changed', () => {
            if (this._mode === 'DYNAMIC')
                this.sync();
        }, this);
        // The classes are on before the dock is first measured.
        this._syncClasses();
    }

    get _mode() {
        return this._settings.get_string('transparency-mode');
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
        let alpha = 0;
        if (mode === 'DYNAMIC') {
            this.near = this._windowNear();
            const {min, max} = dynamicAlphas({
                customize: settings.get_boolean('customize-alphas'),
                min: settings.get_double('min-alpha'),
                max: settings.get_double('max-alpha'),
            });
            alpha = dynamicAlpha(this.near, min, max);
        } else {
            this.near = false;
        }
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
    }
}
