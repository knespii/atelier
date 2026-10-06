// The top bar: its look, and Atelier's modules on its right, which show
// their details in the island while the pointer rests on them.
//
// Besides GNOME's bar (black, or glass), the bar has no background of its
// own and one of three shapes: the workspaces, the island and the status
// icons grouped in the middle, spread to the edges of the screen, or all in
// one island. The sides lie on the wallpaper or in capsules like the
// island; the island, the capsules and the one island are black or glass.
// Grouped and as one island, the bar can be compact: just the workspaces,
// the time and the battery.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {EAR_RADIUS, NOTCH_RADIUS, capsuleHeight} from '../core/barMetrics.js';
import {GlassSurface} from '../core/glass.js';
import {ContentPage} from '../island/page.js';
import {CompactBar} from './compact.js';
import {ClaudeIndicator, WeatherIndicator} from './indicators.js';
import {OverviewBackdrop} from './overviewBackdrop.js';

// The order of the modules, left to right, before the status icons.
const MODULES = ['weather', 'claude'];
const PREVIEW_DELAY = 300;
const PREVIEW_HIDE_DELAY = 250;

const CLEAN = 'atelier-bar-clean'; // no background of its own
const CAPSULES = 'atelier-bar-capsules'; // the sides on capsules or in the one island

// Logical pixels.
const EDGE = 4; // between a capsule and the screen's edge
const GAP = 6; // between the island and a grouped side
const ISLAND_PADDING = 6; // of the one island, beyond the icons at its ends

// Something under the bar: a capsule behind one side, the one island
// behind all of it, or GNOME's bar. Glass or black; its shape changes
// every frame the island does, without anything being laid out anew.
class Surface {
    constructor(glass) {
        this._glass = glass;
        this.actor = new GlassSurface({reach: 0.1, solid: !glass});
        if (!glass)
            this.actor.add_style_class_name('atelier-capsule');
        // (Never the target of a drag and drop.)
        Shell.util_set_hidden_from_pick(this.actor, true);
        Main.layoutManager.uiGroup.insert_child_below(this.actor, Main.layoutManager.panelBox);
    }

    get glass() {
        return this._glass;
    }

    hide() {
        this.actor.visible = false;
    }

    /**
     * @param {number[]} rect - [x, y, width, height] in stage coordinates
     * @param {number} radius - of the top corners
     * @param {number} bottomRadius
     * @param {number} ear - radius of a notch's ears, 0 for none
     */
    show([x, y, width, height], radius, bottomRadius, ear) {
        if (!this.actor.visible)
            this.actor.visible = true;
        this.actor.setShape(x, y, width, height, radius, bottomRadius, ear);
    }

    destroy() {
        this.actor.destroy();
        this.actor = null;
    }
}

export class BarModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     * @param {ModuleManager} context.modules
     */
    constructor({settings, modules}) {
        this._settings = settings;
        this._modules = modules;
        this._look = null;
        this._backdrop = null;
        this._compact = null;
        this._surfaces = [];
        this._island = null;
        this._overview = null;
        this._laterId = 0;
        this._stopped = false;
        this._indicators = new Map();
        this._preview = null;
        this._timeouts = new Map();
    }

    /** @returns {Map<string, PanelMenu.Button>} the modules shown, by id */
    get indicators() {
        return this._indicators;
    }

    enable() {
        this._barSettings = this._settings.get_child('bar');
        this._barSettings.connectObject(
            'changed::style', () => this._sync(),
            'changed::sides', () => this._sync(),
            'changed::surface', () => this._sync(),
            'changed::island-shape', () => this._sync(),
            'changed::compact', () => this._sync(),
            this);
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox])
            box.connectObject('notify::allocation', () => this._queuePlace(), this);
        Main.layoutManager.panelBox.connectObject(
            'notify::allocation', () => this._queuePlace(),
            'notify::visible', () => this._queuePlace(),
            this);
        this._followIsland();
        this._sync();

        this._barSettings.connectObject('changed::modules', () => this._syncModules(), this);
        // The modules show what other features know; the sides follow the
        // island.
        this._modules.connectObject(
            'started', (_, id) => this._onModule(id, true),
            'stopped', (_, id) => this._onModule(id, false),
            this);
        this._syncModules();
        Main.layoutManager.uiGroup.connectObject('destroy', () => this._stop(), this);
    }

    disable() {
        this._modules.disconnectObject(this);
        this._island?.setMinPageWidth(0);
        this._island?.disconnectObject(this);
        this._island = null;
        this._overview?.disconnectObject(this);
        this._overview = null;
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        this._closePreview();
        this._indicators.forEach(indicator => indicator.destroy());
        this._indicators.clear();
        this._barSettings?.disconnectObject(this);
        this._barSettings = null;
        for (const box of [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]) {
            box.disconnectObject(this);
            box.translation_x = 0;
        }
        Main.layoutManager.panelBox.disconnectObject(this);
        Main.layoutManager.uiGroup.disconnectObject(this);
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        Main.panel.remove_style_class_name(CLEAN);
        Main.panel.remove_style_class_name(CAPSULES);
        this._compact?.destroy();
        this._compact = null;
        this._backdrop?.destroy();
        this._backdrop = null;
        this._surfaces.forEach(surface => surface.destroy());
        this._surfaces = [];
        this._look = null;
    }

    _onModule(id, started) {
        if (id === 'island')
            this._followIsland();
        if (id === 'claude' || id === 'island')
            this._syncModules(!started);
    }

    _sync() {
        const bar = this._barSettings;
        const style = bar.get_string('style');
        const notch = bar.get_string('island-shape') === 'notch';
        const glass = bar.get_string('surface') === 'glass';
        // GNOME's bar keeps its shape, made of glass when the rest is.
        const glassBar = style === 'gnome' && glass;
        const capsules = style !== 'gnome' && bar.get_string('sides') === 'capsules';
        const compact = bar.get_boolean('compact') && (style === 'grouped' || style === 'island');
        // The island's ears, beside it on the bar (the one island has its own).
        this._look = {style, notch, glassBar, ear: notch && style !== 'island' ? EAR_RADIUS : 0};

        if (style !== 'gnome' || glassBar)
            Main.panel.add_style_class_name(CLEAN);
        else
            Main.panel.remove_style_class_name(CLEAN);
        if (style === 'island' || capsules || glassBar)
            Main.panel.add_style_class_name(CAPSULES);
        else
            Main.panel.remove_style_class_name(CAPSULES);
        // Without a background of its own, the bar shows the overview's
        // background too: the blurred wallpaper rather than GNOME's grey.
        if (style !== 'gnome') {
            this._backdrop ??= new OverviewBackdrop();
        } else {
            this._backdrop?.destroy();
            this._backdrop = null;
        }
        if (compact && !this._compact) {
            this._compact = new CompactBar();
        } else if (!compact && this._compact) {
            this._compact.destroy();
            this._compact = null;
        }

        // One island, GNOME's bar of glass, or a capsule for each side.
        const count = style === 'island' || glassBar ? 1 : capsules ? 2 : 0;
        if (this._surfaces.length !== count || this._surfaces.some(surface => surface.glass !== glass)) {
            this._surfaces.forEach(surface => surface.destroy());
            this._surfaces = Array.from({length: count}, () => new Surface(glass));
        }
        if (style !== 'island')
            this._island?.setMinPageWidth(0);
        this._followOverview(glassBar);
        this._place();
    }

    // Like GNOME's bar, the bar of glass gives way to the overview.
    _followOverview(follow) {
        this._overview?.disconnectObject(this);
        this._overview = follow ? Main.overview._overview?.controls?._stateAdjustment ?? null : null;
        this._overview?.connectObject('notify::value', () => this._updateSurfaces(), this);
    }

    // The sides of a grouped bar and the one island follow the island as it
    // grows and shrinks, every frame.
    _followIsland() {
        this._island?.disconnectObject(this);
        this._island = this._modules.get('island')?.island ?? null;
        this._island?.connectObject(
            'notify::x', () => this._place(),
            'notify::width', () => this._place(),
            'notify::visible', () => this._place(),
            'destroy', () => (this._island = null),
            this);
        this._queuePlace();
    }

    /**
     * @param {boolean} [rest] - where the island is at rest, not as it is now
     * @returns {number[]} what grouped sides surround, [start, end] in the bar
     */
    _middle(rest = false) {
        const island = this._island;
        if (island?.visible && island.width > 0) {
            const [panelX] = Main.panel.get_transformed_position();
            const [x, width] = (rest ? island.restBounds() : null) ?? [island.x, island.width];
            return [x - panelX, x - panelX + width];
        }
        const center = Main.panel._centerBox;
        return [center.x, center.x + center.width];
    }

    // Grouped and in one island, the sides move next to the island; spread,
    // they stay at the edges where GNOME puts them.
    _place() {
        if (!this._look)
            return;
        const panel = Main.panel;
        // Placed once the bar is laid out anew, e.g. after a style change.
        // (Hidden, it waits until it shows again.)
        if (!panel.has_allocation()) {
            if (panel.mapped)
                this._queuePlace();
            return;
        }
        const {style, ear} = this._look;
        const left = panel._leftBox;
        const right = panel._rightBox;
        const together = (style === 'grouped' || style === 'island') &&
            panel.get_text_direction() !== Clutter.TextDirection.RTL;
        if (together) {
            const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
            // Grouped, the sides make way as the island grows; in one
            // island, the island grows over them.
            const [start, end] = this._middle(style === 'island');
            const gap = style === 'island' ? 0 : (GAP + ear) * scale;
            const edge = EDGE * scale;
            const leftX = Math.max(edge, start - gap - left.width);
            const rightX = Math.min(panel.width - edge - right.width, end + gap);
            left.translation_x = Math.round(leftX - left.x);
            right.translation_x = Math.round(rightX - right.x);
        } else {
            left.translation_x = 0;
            right.translation_x = 0;
        }
        this._updateSurfaces();
    }

    _updateSurfaces() {
        if (this._surfaces.length === 0)
            return;
        const panel = Main.panel;
        if (!Main.layoutManager.panelBox.visible || !panel.visible) {
            this._surfaces.forEach(surface => surface.hide());
            return;
        }
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [panelX, panelY] = panel.get_transformed_position();
        const monitor = Main.layoutManager.primaryMonitor;
        const [minX, maxX] = [monitor.x + EDGE * scale, monitor.x + monitor.width - EDGE * scale];
        // As tall as the island at rest, and at its height (floating).
        const rest = this._look.notch ? null : this._island?.restRect();
        const height = rest?.[3] ?? capsuleHeight(panel.height, scale);
        const y = rest?.[1] ?? Math.round(panelY + (panel.height - height) / 2);
        // [start, end] of a side's icons on the stage, if it shows any
        const extent = box => {
            if (!box.get_children().some(child => child.visible && child.width > 0))
                return null;
            const [x] = box.get_transformed_position();
            return [x, x + box.width];
        };

        if (this._look.glassBar) {
            const progress = Math.min(1, Math.max(0, this._overview?.value ?? 0));
            this._surfaces[0].show([panelX, panelY, panel.width, panel.height], 0, 0, 0);
            this._surfaces[0].actor.opacity = Math.round(255 * (1 - progress));
            return;
        }

        if (this._look.style === 'island') {
            // Even around the island at rest, however long each side is.
            const [start, end] = this._middle(true).map(x => panelX + x);
            const sides = [panel._leftBox, panel._rightBox].map(box => (extent(box) ? box.width : 0));
            const reach = Math.max(...sides) + ISLAND_PADDING * scale;
            let x1 = Math.max(minX, start - reach);
            let x2 = Math.min(maxX, end + reach);
            // The island's pages take its whole width; one that grows past
            // it takes it along.
            this._island?.setMinPageWidth(x2 - x1);
            const island = this._island;
            if (island?.visible && island.width > 0) {
                x1 = Math.min(x1, island.x);
                x2 = Math.max(x2, island.x + island.width);
            }
            // As the island: hanging from the top edge, or floating in the bar.
            if (this._look.notch)
                this._surfaces[0].show([x1, panelY, x2 - x1, panel.height], 0, NOTCH_RADIUS * scale, EAR_RADIUS * scale);
            else
                this._surfaces[0].show([x1, y, x2 - x1, height], height / 2, height / 2, 0);
            return;
        }

        [panel._leftBox, panel._rightBox].forEach((box, i) => {
            const range = extent(box);
            if (!range) {
                this._surfaces[i].hide();
                return;
            }
            const x1 = Math.max(minX, range[0]);
            const x2 = Math.min(maxX, range[1]);
            this._surfaces[i].show([x1, y, x2 - x1, height], height / 2, height / 2, 0);
        });
    }

    _queuePlace() {
        if (this._laterId || this._stopped)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._place();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * @param {boolean} [rebuild] - a feature they show stopped: make them anew
     */
    _syncModules(rebuild = false) {
        if (rebuild) {
            this._closePreview();
            this._indicators.forEach(indicator => indicator.destroy());
            this._indicators.clear();
        }
        const wanted = this._barSettings.get_strv('modules');
        const claude = this._modules.get('claude');
        const island = this._modules.get('island');
        const create = {
            claude: () => (claude?.usage ? new ClaudeIndicator(claude) : null),
            weather: () => (island?.weather ? new WeatherIndicator(island.weather) : null),
        };
        for (const id of MODULES) {
            const indicator = this._indicators.get(id);
            if (!wanted.includes(id) && indicator) {
                if (this._preview?.indicator === indicator)
                    this._closePreview();
                indicator.destroy();
                this._indicators.delete(id);
            } else if (wanted.includes(id) && !indicator) {
                const created = create[id]();
                if (!created)
                    continue;
                // Keep the order of MODULES, all before the status icons.
                const position = MODULES.slice(0, MODULES.indexOf(id)).filter(i => this._indicators.has(i)).length;
                Main.panel.addToStatusArea(`atelier-${id}`, created, position, 'right');
                created.connectObject('notify::hover', () => this._onModuleHover(id, created), this);
                this._indicators.set(id, created);
            }
        }
    }

    // Resting on a module shows its details in the island; they go once the
    // pointer has left both.
    _onModuleHover(id, indicator) {
        const islandModule = this._modules.get('island');
        if (!islandModule?.available)
            return;
        if (indicator.hover) {
            this._clear('hide-preview');
            this._after('show-preview', PREVIEW_DELAY, () => {
                const island = islandModule.island;
                if (!indicator.hover || island.page)
                    return;
                const page = id === 'claude'
                    ? new ContentPage(this._modules.get('claude').createView())
                    : islandModule.createGlance();
                if (!island.open(page)) {
                    page.destroy();
                    return;
                }
                const preview = {page, indicator, island};
                this._preview = preview;
                // (Its own connection: the bar follows the island too.)
                island.connectObject('notify::hover', () => this._maybeClosePreview(), preview);
            });
        } else {
            this._clear('show-preview');
            this._maybeClosePreview();
        }
    }

    _maybeClosePreview() {
        if (!this._preview)
            return;
        this._after('hide-preview', PREVIEW_HIDE_DELAY, () => {
            const preview = this._preview;
            if (!preview)
                return;
            if (preview.island.page !== preview.page)
                this._closePreview(false);
            else if (!preview.indicator.hover && !preview.island.hover)
                this._closePreview();
        });
    }

    /**
     * @param {boolean} [close] - close the page if the island still shows it
     */
    _closePreview(close = true) {
        const preview = this._preview;
        this._preview = null;
        if (!preview)
            return;
        preview.island.disconnectObject(preview);
        if (close && preview.island.page === preview.page)
            preview.island.close(preview.page);
    }

    _after(name, delay, callback) {
        this._clear(name);
        if (this._stopped)
            return;
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeouts.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _clear(name) {
        const id = this._timeouts.get(name);
        if (id)
            GLib.source_remove(id);
        this._timeouts.delete(name);
    }

    // When the shell quits, GNOME takes its UI down with uiGroup while JS
    // still runs, then turns the main loop a while longer: nothing that
    // waits may place the sides or show a preview then.
    _stop() {
        this._stopped = true;
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
    }
}
