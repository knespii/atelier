// What is drawn on an app's icon in the dock: how its windows are marked
// (a style of dots, dashes or a bar, in the app's colour or one of the
// settings'), its count, progress and urgency.
//
// The marks are drawn at the icon's edge towards the dock's edge, in place
// of GNOME's running dot (which stays for the default style), and drawn
// again only when something they show changed: how many windows, the
// focus, the style, the colours, the size. The count sits in the icon's
// top end corner, the progress along its bottom; an urgent app wiggles.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {badgeText, dominantColor, indicatorShapes} from '../../lib/dockIndicators.js';

// The settings the marks are drawn by.
const INDICATOR_KEYS = ['running-indicator-style', 'running-indicator-dominant-color',
    'custom-theme-customize-running-dots', 'custom-theme-running-dots-color',
    'custom-theme-running-dots-border-color', 'custom-theme-running-dots-border-width'];
const WHITE = [255, 255, 255];
const COLOR_ICON_SIZE = 64; // the size an icon is read at for its colour
// An urgent app swings to these angles (degrees), one after the other,
// then rests a while and swings again.
const WIGGLE = [-12, 12, -10, 10, -6, 6, 0];
const WIGGLE_STEP = 70; // milliseconds
const WIGGLE_REST = 1500;

// Each app's colour, read from its icon once: app id → [r, g, b] or null.
const appColors = new Map();
let iconTheme = null;

/**
 * @param {string} hex - '#rrggbb'
 * @returns {number[]} [r, g, b] (white for anything else)
 */
function parseColor(hex) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
    return match ? match.slice(1).map(v => parseInt(v, 16)) : WHITE;
}

// The icon's pixels, at about COLOR_ICON_SIZE.
function iconPixbuf(app) {
    const gicon = app.get_app_info()?.get_icon() ?? app.get_icon?.() ?? null;
    if (gicon instanceof Gio.FileIcon && gicon.get_file().get_path()) {
        return GdkPixbuf.Pixbuf.new_from_file_at_size(gicon.get_file().get_path(),
            COLOR_ICON_SIZE, COLOR_ICON_SIZE);
    }
    if (gicon instanceof Gio.ThemedIcon) {
        iconTheme ??= new St.IconTheme();
        return iconTheme.choose_icon(gicon.get_names(), COLOR_ICON_SIZE, 0)?.load_icon() ?? null;
    }
    if (gicon instanceof Gio.LoadableIcon) {
        const [stream] = gicon.load(COLOR_ICON_SIZE, null);
        return GdkPixbuf.Pixbuf.new_from_stream_at_scale(stream, COLOR_ICON_SIZE, COLOR_ICON_SIZE, true, null);
    }
    return null;
}

/**
 * @param {Shell.App} app
 * @returns {number[]|null} the colour its icon is mostly of, [r, g, b]
 */
function appColor(app) {
    const id = app.get_id();
    if (!appColors.has(id)) {
        let color = null;
        try {
            const pixbuf = iconPixbuf(app);
            if (pixbuf) {
                color = dominantColor(pixbuf.get_pixels(), pixbuf.get_width(), pixbuf.get_height(),
                    pixbuf.get_rowstride(), pixbuf.get_n_channels());
            }
        } catch {
            color = null;
        }
        appColors.set(id, color);
    }
    return appColors.get(id);
}

// A rectangle with round ends, for the progress bar.
function roundedBar(cr, x, y, width, height) {
    const radius = Math.min(height / 2, width / 2);
    cr.newSubPath();
    cr.arc(x + width - radius, y + radius, radius, -Math.PI / 2, Math.PI / 2);
    cr.arc(x + radius, y + radius, radius, Math.PI / 2, 3 * Math.PI / 2);
    cr.closePath();
}

export class IconDecorations {
    /**
     * @param {DockIcon} icon
     * @param {object} ctx - the icon's: {dock, settings, services, side}
     */
    constructor(icon, ctx) {
        this._icon = icon;
        this._ctx = ctx;
        this._appId = icon.app.get_id();
        this._state = null; // what the marks were last drawn for
        this._urgent = false;
        const container = icon._iconContainer;

        this._area = new St.DrawingArea({
            style_class: 'atelier-dock-indicator',
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this._area.connect('repaint', area => this._drawMarks(area));
        // A little off the icon, towards the edge, as the stylesheet says.
        this._area.connect('style-changed', area => {
            const node = area.get_theme_node();
            area.translationX = node.get_length('offset-x');
            area.translationY = node.get_length('offset-y');
        });
        container.add_child(this._area);

        this._progress = new St.DrawingArea({
            style_class: 'atelier-dock-progress',
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this._progress.connect('repaint', area => this._drawProgress(area));
        container.add_child(this._progress);

        this._badge = new St.Label({style_class: 'atelier-dock-badge', visible: false});
        this._badgeBin = new St.Bin({
            child: this._badge,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.START,
        });
        container.add_child(this._badgeBin);

        const {settings, services} = ctx;
        settings.connectObject(
            ...INDICATOR_KEYS.flatMap(key => [`changed::${key}`, () => this._syncMarks()]),
            'changed::show-icons-emblems', () => this._syncBadges(),
            'changed::dance-urgent-applications', () => this._syncUrgent(),
            this);
        // The focus moving between apps.
        services.windows.connectObject('changed', () => this.sync(), this);
        services.badges.connectObject('changed', (_, appId) => {
            if (appId === this._appId) {
                this._syncBadges();
                this._syncUrgent();
            }
        }, this);
    }

    /** @returns {string} 'atelier.DockIndicator' nick in use */
    get style() {
        return this._ctx.settings.get_string('running-indicator-style');
    }

    /** Draw it again: the app's windows, focus or badges changed. */
    sync() {
        if (!this._icon)
            return;
        this._syncMarks();
        this._syncBadges();
        this._syncUrgent();
    }

    // The marks, and GNOME's dot for the default style.
    _syncMarks() {
        if (!this._icon)
            return;
        const windows = this._icon.windows;
        const style = this.style;
        const custom = this._ctx.settings.get_boolean('custom-theme-customize-running-dots');
        this._icon._dot.visible = style === 'DEFAULT' && windows.length > 0;
        const shown = style !== 'DEFAULT' && windows.length > 0;
        this._area.visible = shown;
        if (!shown) {
            this._state = null;
            return;
        }
        const focus = global.display.focus_window;
        const state = {
            style,
            n: windows.length,
            focused: windows.some(window => window === focus),
            body: this._bodyColor(custom),
            border: custom ? parseColor(this._ctx.settings.get_string('custom-theme-running-dots-border-color')) : null,
            borderWidth: custom ? this._ctx.settings.get_int('custom-theme-running-dots-border-width') : 0,
        };
        if (JSON.stringify(state) === JSON.stringify(this._state))
            return;
        this._state = state;
        this._area.queue_repaint();
    }

    // The app's own colour, if asked for (and it has one), else the
    // settings', else white.
    _bodyColor(custom) {
        const settings = this._ctx.settings;
        const own = settings.get_boolean('running-indicator-dominant-color') ? appColor(this._icon.app) : null;
        if (own)
            return own;
        return custom ? parseColor(settings.get_string('custom-theme-running-dots-color')) : WHITE;
    }

    _drawMarks(area) {
        const state = this._state;
        if (!state)
            return;
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const borderWidth = state.borderWidth * scale;
        const shapes = indicatorShapes(state.style, state.n, width, height, this._ctx.side, state.focused, borderWidth);
        const [r, g, b] = state.body.map(v => v / 255);
        for (const shape of shapes) {
            cr.newPath();
            if (shape.kind === 'circle')
                cr.arc(shape.x + shape.radius, shape.y + shape.radius, shape.radius, 0, 2 * Math.PI);
            else
                cr.rectangle(shape.x, shape.y, shape.width, shape.height);
            if (borderWidth > 0 && state.border) {
                cr.setLineWidth(borderWidth);
                cr.setSourceRGBA(...state.border.map(v => v / 255), 1);
                cr.strokePreserve();
            }
            cr.setSourceRGBA(r * shape.shade, g * shape.shade, b * shape.shade, 1);
            cr.fill();
        }
        cr.$dispose();
    }

    // The count in the corner and the progress, while the dock shows them.
    _syncBadges() {
        if (!this._icon)
            return;
        const badges = this._ctx.services.badges;
        const emblems = this._ctx.settings.get_boolean('show-icons-emblems');
        const text = emblems ? badgeText(badges.countFor(this._appId)) : '';
        this._badge.text = text;
        this._badge.visible = text !== '';
        if (text) {
            const size = this._icon.icon.iconSize || 48;
            this._badge.set_style(`font-size: ${Math.max(8, Math.round(size * 0.22))}px;`);
        }
        const progress = emblems ? badges.progressFor(this._appId) : null;
        if (progress === null) {
            this._progress.visible = false;
            this._progressValue = null;
        } else if (progress !== this._progressValue || !this._progress.visible) {
            this._progressValue = progress;
            this._progress.visible = true;
            this._progress.queue_repaint();
        }
    }

    // A bar along the bottom of the icon, filled as far as the app is
    // along (from the right, right to left).
    _drawProgress(area) {
        if (this._progressValue === null || this._progressValue === undefined)
            return;
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const barHeight = Math.max(4 * scale, Math.round(height * 0.1));
        const x = Math.round(width * 0.12);
        const barWidth = width - 2 * x;
        const y = Math.round(height * 0.86 - barHeight);
        roundedBar(cr, x, y, barWidth, barHeight);
        cr.setSourceRGBA(0, 0, 0, 0.6);
        cr.fill();
        const inset = scale;
        const full = (barWidth - 2 * inset) * this._progressValue;
        if (full > 0) {
            const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
            roundedBar(cr, rtl ? x + barWidth - inset - full : x + inset, y + inset, full, barHeight - 2 * inset);
            cr.setSourceRGBA(1, 1, 1, 0.95);
            cr.fill();
        }
        cr.$dispose();
    }

    // Wiggling while any of the app's windows (or the app itself) asks
    // for attention.
    _syncUrgent() {
        if (!this._icon)
            return;
        const urgent = this._ctx.settings.get_boolean('dance-urgent-applications') &&
            (this._icon.windows.some(window => window.urgent || window.demands_attention) ||
             this._ctx.services.badges.urgentFor(this._appId));
        if (urgent === this._urgent)
            return;
        this._urgent = urgent;
        if (urgent)
            this._wiggle(0);
        else
            this._stopWiggle();
    }

    /** @returns {boolean} whether the icon wiggles */
    get wiggling() {
        return this._urgent;
    }

    // Each swing waits on a timer, not on the end of its easing: GNOME's
    // ease() can't find the transition of a property with two
    // underscores (rotation_angle_z) and says it ended at once.
    _wiggle(step) {
        const timers = this._ctx.dock.timers;
        if (!this._icon || !this._urgent || timers.stopped)
            return;
        const target = this._icon.icon;
        target.set_pivot_point(0.5, 0.5);
        target.ease({
            rotation_angle_z: WIGGLE[step],
            duration: WIGGLE_STEP,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
        });
        const last = step === WIGGLE.length - 1;
        timers.after(this._wiggleTimer, WIGGLE_STEP + (last ? WIGGLE_REST : 0),
            () => this._wiggle(last ? 0 : step + 1));
    }

    get _wiggleTimer() {
        return `wiggle-${this._appId}`;
    }

    _stopWiggle() {
        this._ctx.dock.timers.clear(this._wiggleTimer);
        const target = this._icon?.icon;
        if (target) {
            target.remove_transition('rotation-angle-z');
            target.rotation_angle_z = 0;
        }
    }

    destroy() {
        if (!this._icon)
            return;
        this._urgent = false;
        this._stopWiggle();
        const {settings, services} = this._ctx;
        settings.disconnectObject(this);
        services.windows.disconnectObject(this);
        services.badges.disconnectObject(this);
        this._icon = null;
    }
}
