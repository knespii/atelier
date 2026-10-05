// Modules on the right of the top bar. They only show something; resting
// the pointer on one shows its details in the island.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {formatTokens} from '../../lib/claudeUsage.js';

const ModuleButton = GObject.registerClass(
class AtelierBarModule extends PanelMenu.Button {
    _init(name) {
        super._init(0.5, name, true);
        this.add_style_class_name('atelier-bar-module');
        this.can_focus = false;
        this._box = new St.BoxLayout({style_class: 'atelier-bar-module-box'});
        this.add_child(this._box);
    }
});

/** Claude Code: how far the 5-hour block is (a ring) and its output. */
export const ClaudeIndicator = GObject.registerClass(
class AtelierClaudeIndicator extends ModuleButton {
    /**
     * @param {ClaudeModule} claude
     */
    _init(claude) {
        super._init('Claude Code usage');
        this._usage = claude.usage;
        this._fraction = 0;
        this._ring = new St.DrawingArea({style_class: 'atelier-bar-ring', y_align: Clutter.ActorAlign.CENTER});
        this._ring.connect('repaint', area => this._paintRing(area));
        this._box.add_child(this._ring);
        this._label = new St.Label({style_class: 'atelier-bar-module-label', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._label);
        this._usage.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const summary = this._usage.summary;
        this.visible = Boolean(summary?.found);
        const block = summary?.block;
        this._fraction = block ? Math.min(1, Math.max(0, (Date.now() - block.start) / (block.end - block.start))) : 0;
        this._label.text = block ? formatTokens(block.totals.output) : '';
        this._label.visible = Boolean(block);
        if ((summary?.sessions?.working ?? 0) > 0)
            this.add_style_pseudo_class('working');
        else
            this.remove_style_pseudo_class('working');
        this._ring.queue_repaint();
    }

    _paintRing(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const node = area.get_theme_node();
        const color = node.get_foreground_color();
        const [hasAccent, accent] = node.lookup_color('-atelier-ring-color', false);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const lineWidth = 2.2 * scale;
        const radius = Math.min(width, height) / 2 - lineWidth / 2;
        const set = (c, alpha) => cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, alpha);

        cr.setLineWidth(lineWidth);
        cr.setLineCap(Cairo.LineCap.ROUND);
        set(color, 0.3);
        cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
        cr.stroke();
        if (this._fraction > 0) {
            set(hasAccent ? accent : color, 1);
            cr.arc(width / 2, height / 2, radius, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * this._fraction);
            cr.stroke();
        }
        cr.$dispose();
    }
});

/** The weather: an icon and the temperature. */
export const WeatherIndicator = GObject.registerClass(
class AtelierWeatherIndicator extends ModuleButton {
    /**
     * @param {object} weather - GNOME's weather client
     */
    _init(weather) {
        super._init('Weather');
        this._weather = weather;
        this._icon = new St.Icon({style_class: 'system-status-icon', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._icon);
        this._label = new St.Label({style_class: 'atelier-bar-module-label', y_align: Clutter.ActorAlign.CENTER});
        this._box.add_child(this._label);
        weather.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const client = this._weather;
        const info = client?.info;
        const ready = client?.available && client.hasLocation && info?.is_valid();
        this.visible = Boolean(ready);
        if (!ready)
            return;
        this._icon.icon_name = info.get_symbolic_icon_name();
        // "14 °C" → "14°"
        this._label.text = info.get_temp_summary().replace(/\s*°\s*[CF]?$/, '°');
    }
});

/**
 * The battery, as GNOME's status icons show it, for a compact bar that has
 * only this one.
 */
export const BatteryIndicator = GObject.registerClass(
class AtelierBatteryIndicator extends PanelMenu.Button {
    /**
     * @param {QuickToggle} powerToggle - GNOME's battery tile, whose icon and
     *   percentage this shows
     */
    _init(powerToggle) {
        super._init(0.5, 'Battery', true);
        this.add_style_class_name('atelier-bar-battery');
        // Like the status icons: it only shows; the island opens the rest.
        this.reactive = false;
        this.can_focus = false;
        this.track_hover = false;
        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        this.add_child(box);
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        box.add_child(this._icon);
        this._label = new St.Label({y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._label);

        this._toggle = powerToggle;
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        powerToggle.connectObject(
            'notify::visible', () => this._sync(),
            'notify::gicon', () => this._sync(),
            'notify::fallback-icon-name', () => this._sync(),
            'notify::title', () => this._sync(),
            this);
        this._interface.connectObject('changed::show-battery-percentage', () => this._sync(), this);
        this._sync();
    }

    _sync() {
        const toggle = this._toggle;
        // (Without a battery, there is nothing to show.)
        this.visible = toggle.visible;
        this._icon.set({gicon: toggle.gicon, fallback_icon_name: toggle.fallback_icon_name});
        this._label.text = toggle.title ?? '';
        this._label.visible = this._interface.get_boolean('show-battery-percentage');
    }
});
