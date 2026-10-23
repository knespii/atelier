// The lock screen's own small widgets: the weather and the battery, in a
// line of type as the date line's, in the lock screen's one tone
// (typography.js), on the wallpaper. They only read what GNOME has: the weather as GNOME's calendar
// menu last had it (never asked anew: that would go to the network), the
// battery as GNOME's battery tile has it. Without either, on the lock
// screen they don't show.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {batteryState, shortTemperature} from '../../lib/lockLook.js';
import {whenSystemItem} from '../core/systemItem.js';
import {DesktopWidget, label} from '../desktop/widget.js';

/** @returns {object|null} GNOME's weather client (its calendar menu's) */
const weatherClient = () => Main.panel.statusArea.dateMenu?._weatherItem?._weatherClient ?? null;

// An icon (or a ring) and a value; a quiet caption beside them in a line,
// or under them when small.
function lineOf(box, size, lead) {
    const line = size === 'line';
    const column = new St.BoxLayout({
        style_class: 'atelier-lock-column',
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
        y_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    box.add_child(column);
    const row = new St.BoxLayout({style_class: 'atelier-lock-line', x_expand: true});
    column.add_child(row);
    lead.y_align = Clutter.ActorAlign.CENTER;
    row.add_child(lead);
    const value = label('atelier-lock-value', '', {y_align: Clutter.ActorAlign.CENTER});
    row.add_child(value);
    const caption = label('atelier-widget-caption atelier-lock-quiet', '', {
        x_expand: line,
        y_align: Clutter.ActorAlign.CENTER,
    });
    caption.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    (line ? row : column).add_child(caption);
    return {value, caption};
}

export const LockWeatherWidget = GObject.registerClass(
class AtelierLockWeatherWidget extends DesktopWidget {
    build(box, size) {
        if (this._client === undefined) {
            this._client = weatherClient();
            this._client?.connectObject('changed', () => this._sync(), this);
        }
        this._icon = new St.Icon({style_class: 'atelier-lock-icon'});
        ({value: this._value, caption: this._caption} = lineOf(box, size, this._icon));
        this._sync();
    }

    _sync() {
        if (!this._icon)
            return;
        const client = this._client;
        const info = client?.info;
        const ready = Boolean(client?.available && client.hasLocation && info?.is_valid());
        // (Placed in the editor, it shows all the same.)
        this.visible = ready || !this._context.locked;
        if (!ready) {
            this._icon.icon_name = 'weather-overcast-symbolic';
            this._value.text = '';
            this._caption.text = 'No weather';
            return;
        }
        this._icon.icon_name = info.get_symbolic_icon_name();
        this._value.text = shortTemperature(info.get_temp_summary());
        const sky = [info.get_conditions(), info.get_sky()].find(text => text && text !== '-') ?? '';
        const place = info.get_location_name() ?? '';
        this._caption.text = this.entry.size === 'line' ? [sky, place].filter(Boolean).join(' · ') : sky;
    }

    cleanup() {
        this._client?.disconnectObject(this);
        this._client = null;
        this._icon = null;
    }
});

// The battery's charge: a ring, the track faint; a dot in it while it charges.
const Ring = GObject.registerClass(
class AtelierLockRing extends St.DrawingArea {
    _init() {
        super._init({style_class: 'atelier-lock-ring'});
        this._fraction = 0;
        this._charging = false;
    }

    set(fraction, charging) {
        if (fraction === this._fraction && charging === this._charging)
            return;
        this._fraction = fraction;
        this._charging = charging;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const color = this.get_theme_node().get_foreground_color();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // (As thick as a letter's stroke, for its size.)
        const lineWidth = Math.max(1.5 * scale, Math.min(width, height) * 0.14);
        const radius = Math.min(width, height) / 2 - lineWidth / 2;
        const paint = alpha => cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255,
            color.alpha / 255 * alpha);
        cr.setLineWidth(lineWidth);
        cr.setLineCap(Cairo.LineCap.ROUND);
        paint(0.3);
        cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
        cr.stroke();
        paint(1);
        if (this._fraction > 0) {
            cr.arc(width / 2, height / 2, radius, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * this._fraction);
            cr.stroke();
        }
        if (this._charging) {
            cr.arc(width / 2, height / 2, radius * 0.32, 0, 2 * Math.PI);
            cr.fill();
        }
        cr.$dispose();
    }
});

export const LockBatteryWidget = GObject.registerClass(
class AtelierLockBatteryWidget extends DesktopWidget {
    build(box, size) {
        this._ring = new Ring();
        ({value: this._value, caption: this._caption} = lineOf(box, size, this._ring));
        // (GNOME's battery tile may come a moment later.)
        if (this._stopWaiting === undefined) {
            this._toggle = null;
            this._stopWaiting = whenSystemItem(item => this._follow(item.powerToggle ?? null));
        }
        this._sync();
    }

    _follow(toggle) {
        this._toggle = toggle;
        toggle?.connectObject(
            'notify::visible', () => this._sync(),
            'notify::title', () => this._sync(),
            'notify::gicon', () => this._sync(),
            this);
        this._sync();
    }

    _sync() {
        if (!this._ring)
            return;
        const toggle = this._toggle;
        // (GNOME's tile shows the battery as UPower has it.)
        const proxy = toggle?._proxy;
        const battery = batteryState(toggle ? {
            present: typeof proxy?.IsPresent === 'boolean' ? proxy.IsPresent : toggle.visible,
            percentage: proxy?.Percentage,
            state: proxy?.State,
            title: toggle.title,
        } : null);
        this.visible = battery.shown || !this._context.locked;
        this._ring.set(battery.fraction, battery.charging);
        this._value.text = battery.shown ? battery.text : '';
        this._caption.text = battery.shown ? battery.caption : 'No battery';
    }

    cleanup() {
        this._stopWaiting?.();
        this._stopWaiting = null;
        this._toggle?.disconnectObject(this);
        this._toggle = null;
        this._ring = null;
    }
});
