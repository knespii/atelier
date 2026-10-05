// The clock and the date. The clock is digital in the Modern look and has
// hands in the Analogue one.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {DesktopWidget, label, launchApp} from '../widget.js';

/**
 * @param {string} text - the clock as GNOME shows it, e.g. "9∶41 PM"
 * @returns {string[]} [digits, suffix] e.g. ["9∶41", "PM"]
 */
function splitTime(text) {
    const [, digits, suffix] = /^([\d:.∶\s]*\d)\s*(\D*)$/u.exec(text.trim()) ?? [null, text.trim(), ''];
    return [digits, suffix];
}

const format = fmt => GLib.DateTime.new_now_local().format(fmt);

// A clock face with hands, drawn in the colors of its style.
const Face = GObject.registerClass(
class AtelierClockFace extends St.DrawingArea {
    _init() {
        super._init({style_class: 'atelier-widget-face', x_expand: true, y_expand: true});
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const ink = node.get_foreground_color();
        const [, hand] = node.lookup_color('-atelier-hand-color', false);
        const [, face] = node.lookup_color('-atelier-face-color', false);
        const size = Math.min(width, height);
        const r = size / 2 - 1;
        cr.translate(width / 2, height / 2);

        cr.arc(0, 0, r, 0, 2 * Math.PI);
        cr.setSourceRGBA(face.red / 255, face.green / 255, face.blue / 255, face.alpha / 255);
        cr.fill();

        cr.setSourceRGBA(ink.red / 255, ink.green / 255, ink.blue / 255, ink.alpha / 255);
        cr.setLineCap(1); // round
        for (let i = 0; i < 12; i++) {
            const angle = i * Math.PI / 6;
            const long = i % 3 === 0;
            cr.setLineWidth(long ? size * 0.03 : size * 0.015);
            cr.moveTo(Math.sin(angle) * r * (long ? 0.74 : 0.8), -Math.cos(angle) * r * (long ? 0.74 : 0.8));
            cr.lineTo(Math.sin(angle) * r * 0.88, -Math.cos(angle) * r * 0.88);
            cr.stroke();
        }

        const now = GLib.DateTime.new_now_local();
        const minutes = now.get_minute() + now.get_second() / 60;
        const hours = (now.get_hour() % 12) + minutes / 60;
        const handTo = (angle, length, widthFactor) => {
            cr.setLineWidth(size * widthFactor);
            cr.moveTo(-Math.sin(angle) * r * 0.1, Math.cos(angle) * r * 0.1);
            cr.lineTo(Math.sin(angle) * r * length, -Math.cos(angle) * r * length);
            cr.stroke();
        };
        handTo(hours * Math.PI / 6, 0.5, 0.05);
        cr.setSourceRGBA(hand.red / 255, hand.green / 255, hand.blue / 255, hand.alpha / 255);
        handTo(minutes * Math.PI / 30, 0.76, 0.03);
        cr.arc(0, 0, size * 0.04, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    }
});

export const ClockWidget = GObject.registerClass(
class AtelierClockWidget extends DesktopWidget {
    build(box, size) {
        if (!this._clock) {
            this._clock = new GnomeDesktop.WallClock({time_only: true});
            this._clock.connectObject('notify::clock', () => this._sync(), this);
        }
        this._face = null;
        this._time = this._suffix = this._date = null;

        const analogue = this._context.style() === 'analogue';
        const row = new St.BoxLayout({style_class: 'atelier-widget-clock', x_expand: true, y_expand: true});
        box.add_child(row);
        if (analogue) {
            this._face = new Face();
            row.add_child(this._face);
        }
        if (!analogue || size !== 'square') {
            const text = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(text);
            const time = new St.BoxLayout({x_align: analogue ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER});
            text.add_child(time);
            this._time = label('atelier-widget-time');
            this._suffix = label('atelier-widget-time-suffix', '', {y_align: Clutter.ActorAlign.END});
            time.add_child(this._time);
            time.add_child(this._suffix);
            this._date = label('atelier-widget-caption', '', {
                x_align: analogue ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
            });
            text.add_child(this._date);
        }
        this._sync();
    }

    _sync() {
        this._face?.queue_repaint();
        if (!this._time)
            return;
        const [digits, suffix] = splitTime(this._clock.clock);
        this._time.text = digits;
        this._suffix.text = suffix;
        this._suffix.visible = suffix !== '';
        this._date.text = format(this.entry.size === 'square' ? '%a %-d' : '%A, %B %-d');
    }

    activate() {
        launchApp('org.gnome.clocks.desktop');
    }

    cleanup() {
        this._clock?.disconnectObject(this);
        this._clock?.run_dispose();
        this._clock = null;
    }
});

export const DateWidget = GObject.registerClass(
class AtelierDateWidget extends DesktopWidget {
    build(box, size) {
        this._weekday = label('atelier-widget-weekday', '', {x_align: Clutter.ActorAlign.CENTER});
        this._day = label('atelier-widget-day', '', {x_align: Clutter.ActorAlign.CENTER});
        this._month = label('atelier-widget-caption', '', {x_align: Clutter.ActorAlign.CENTER});
        const page = new St.BoxLayout({
            style_class: 'atelier-widget-date',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        page.add_child(this._weekday);
        page.add_child(this._day);
        page.add_child(this._month);
        if (size === 'card') {
            const row = new St.BoxLayout({x_expand: true, y_expand: true});
            row.add_child(page);
            this._left = label('atelier-widget-big-caption', '', {
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._left.clutter_text.line_wrap = true;
            row.add_child(this._left);
            box.add_child(row);
        } else {
            this._left = null;
            box.add_child(page);
        }
        // Midnight comes; the clock says when.
        if (!this._clock) {
            this._clock = new GnomeDesktop.WallClock({time_only: true});
            this._clock.connectObject('notify::clock', () => this._sync(), this);
        }
        this._sync();
    }

    _sync() {
        const now = GLib.DateTime.new_now_local();
        this._weekday.text = now.format('%A').toUpperCase();
        this._day.text = String(now.get_day_of_month());
        this._month.text = now.format('%B %Y');
        if (this._left) {
            const end = GLib.DateTime.new_local(now.get_year(), 12, 31, 0, 0, 0);
            const days = end.get_day_of_year() - now.get_day_of_year();
            this._left.text = `Week ${now.get_week_of_year()}\n${days} days left this year`;
        }
    }

    activate() {
        launchApp('org.gnome.Calendar.desktop');
    }

    cleanup() {
        this._clock?.disconnectObject(this);
        this._clock?.run_dispose();
        this._clock = null;
    }
});
