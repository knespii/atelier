// The top bar: its look – GNOME's, clear (the workspaces, the island and
// the status icons on the wallpaper) or grouped (the sides in capsules like
// the island, black or glass) – and Atelier's modules on its right, which
// show their details in the island while the pointer rests on them.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {capsuleHeight} from '../core/barMetrics.js';
import {GlassSurface} from '../core/glass.js';
import {ContentPage} from '../island/page.js';
import {ClaudeIndicator, WeatherIndicator} from './indicators.js';
import {OverviewBackdrop} from './overviewBackdrop.js';

// The order of the modules, left to right, before the status icons.
const MODULES = ['weather', 'claude'];
const PREVIEW_DELAY = 300;
const PREVIEW_HIDE_DELAY = 250;

const CLEAN = 'atelier-bar-clean';
const GROUPED = 'atelier-bar-grouped';
// Room between a capsule and the screen's edge, logical pixels.
const EDGE = 4;

// A capsule behind one side of the bar.
class Capsule {
    constructor(box, glass) {
        this._box = box;
        if (glass) {
            this.actor = new GlassSurface({reach: 0.1});
        } else {
            this.actor = new St.Widget({style_class: 'atelier-capsule', reactive: false});
        }
        this._glass = glass;
        Main.layoutManager.uiGroup.insert_child_below(this.actor, Main.layoutManager.panelBox);
    }

    get glass() {
        return this._glass;
    }

    /** Wrap the side's items, as tall as the island at rest. */
    update() {
        const box = this._box;
        const panel = Main.panel;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const shown = box.get_children().some(child => child.visible && child.width > 0);
        this.actor.visible = shown && Main.layoutManager.panelBox.visible && panel.visible;
        if (!this.actor.visible)
            return;
        const [boxX] = box.get_transformed_position();
        const [, panelY] = panel.get_transformed_position();
        const height = capsuleHeight(panel.height, scale);
        const edge = EDGE * scale;
        const monitor = Main.layoutManager.primaryMonitor;
        const x = Math.max(boxX, monitor.x + edge);
        const right = Math.min(boxX + box.width, monitor.x + monitor.width - edge);
        const y = Math.round(panelY + (panel.height - height) / 2);
        if (this._glass) {
            this.actor.setShape(x, y, right - x, height, height / 2);
        } else {
            this.actor.set_position(x, y);
            this.actor.set_size(right - x, height);
        }
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
        this._backdrop = null;
        this._capsules = [];
        this._laterId = 0;
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
            'changed::surface', () => this._sync(),
            this);
        for (const box of [Main.panel._leftBox, Main.panel._rightBox])
            box.connectObject('notify::allocation', () => this._queueUpdate(), this);
        Main.layoutManager.panelBox.connectObject(
            'notify::allocation', () => this._queueUpdate(),
            'notify::visible', () => this._queueUpdate(),
            this);
        this._sync();

        this._barSettings.connectObject('changed::modules', () => this._syncModules(), this);
        // The modules show what other features know.
        this._modules.connectObject(
            'started', (_, id) => ['claude', 'island'].includes(id) && this._syncModules(),
            'stopped', (_, id) => ['claude', 'island'].includes(id) && this._syncModules(true),
            this);
        this._syncModules();
    }

    disable() {
        this._modules.disconnectObject(this);
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        this._closePreview();
        this._indicators.forEach(indicator => indicator.destroy());
        this._indicators.clear();
        this._barSettings?.disconnectObject(this);
        this._barSettings = null;
        Main.panel._leftBox.disconnectObject(this);
        Main.panel._rightBox.disconnectObject(this);
        Main.layoutManager.panelBox.disconnectObject(this);
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
        Main.panel.remove_style_class_name(CLEAN);
        Main.panel.remove_style_class_name(GROUPED);
        this._backdrop?.destroy();
        this._backdrop = null;
        this._capsules.forEach(capsule => capsule.destroy());
        this._capsules = [];
    }

    _sync() {
        const style = this._barSettings.get_string('style');
        const clear = style !== 'gnome';
        const grouped = style === 'grouped';
        const glass = this._barSettings.get_string('surface') === 'glass';

        // Without a background of its own, the bar shows the overview's
        // background too: the blurred wallpaper rather than GNOME's grey.
        if (clear) {
            Main.panel.add_style_class_name(CLEAN);
            this._backdrop ??= new OverviewBackdrop();
        } else {
            Main.panel.remove_style_class_name(CLEAN);
            this._backdrop?.destroy();
            this._backdrop = null;
        }

        if (grouped)
            Main.panel.add_style_class_name(GROUPED);
        else
            Main.panel.remove_style_class_name(GROUPED);
        if (!grouped || this._capsules.some(capsule => capsule.glass !== glass)) {
            this._capsules.forEach(capsule => capsule.destroy());
            this._capsules = [];
        }
        if (grouped && this._capsules.length === 0)
            this._capsules = [Main.panel._leftBox, Main.panel._rightBox].map(box => new Capsule(box, glass));
        this._queueUpdate();
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
                this._preview = {page, indicator, island};
                island.connectObject('notify::hover', () => this._maybeClosePreview(), this);
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
        preview.island.disconnectObject(this);
        if (close && preview.island.page === preview.page)
            preview.island.close(preview.page);
    }

    _after(name, delay, callback) {
        this._clear(name);
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

    _queueUpdate() {
        if (this._laterId || this._capsules.length === 0)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._capsules.forEach(capsule => capsule.update());
            return GLib.SOURCE_REMOVE;
        });
    }
}
