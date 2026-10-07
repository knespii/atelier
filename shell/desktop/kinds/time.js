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

// A clock face with hands, drawn in the colors of its style: as on paper
// (ticks for the hours), a watch (minutes, and a second hand), numerals, or
// minimal (hands and a dot at twelve).
const Face = GObject.registerClass(
class AtelierClockFace extends St.DrawingArea {
    _init(design) {
        super._init({style_class: 'atelier-widget-face', x_expand: true, y_expand: true});
        this._design = design;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const ink = node.get_foreground_color();
        const [, hand] = node.lookup_color('-atelier-hand-color', false);
        const [, face] = node.lookup_color('-atelier-face-color', false);
        const paint = (color, alpha = 1) =>
            cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255 * alpha);
        const size = Math.min(width, height);
        const r = size / 2 - 1;
        const design = this._design;
        cr.translate(width / 2, height / 2);

        cr.arc(0, 0, r, 0, 2 * Math.PI);
        paint(face);
        cr.fill();

        paint(ink);
        cr.setLineCap(1); // round
        const tick = (angle, from, to, lineWidth) => {
            cr.setLineWidth(lineWidth);
            cr.moveTo(Math.sin(angle) * r * from, -Math.cos(angle) * r * from);
            cr.lineTo(Math.sin(angle) * r * to, -Math.cos(angle) * r * to);
            cr.stroke();
        };
        if (design === 'paper') {
            for (let i = 0; i < 12; i++) {
                const long = i % 3 === 0;
                tick(i * Math.PI / 6, long ? 0.74 : 0.8, 0.88, long ? size * 0.03 : size * 0.015);
            }
        } else if (design === 'watch') {
            for (let i = 0; i < 60; i++) {
                const hour = i % 5 === 0;
                paint(ink, hour ? 1 : 0.5);
                tick(i * Math.PI / 30, hour ? 0.78 : 0.86, 0.92, hour ? size * 0.025 : size * 0.008);
            }
            paint(ink);
        } else if (design === 'numerals') {
            cr.selectFontFace('Cantarell', 0, 1);
            cr.setFontSize(size * 0.13);
            for (let i = 1; i <= 12; i++) {
                const angle = i * Math.PI / 6;
                const text = String(i);
                const extents = cr.textExtents(text);
                cr.moveTo(Math.sin(angle) * r * 0.76 - extents.width / 2 - extents.xBearing,
                    -Math.cos(angle) * r * 0.76 - extents.height / 2 - extents.yBearing);
                cr.showText(text);
            }
        } else {
            cr.arc(0, -r * 0.84, size * 0.025, 0, 2 * Math.PI);
            cr.fill();
        }

        const now = GLib.DateTime.new_now_local();
        const seconds = now.get_second();
        const minutes = now.get_minute() + seconds / 60;
        const hours = (now.get_hour() % 12) + minutes / 60;
        const handTo = (angle, length, widthFactor, tail = 0.1) => {
            cr.setLineWidth(size * widthFactor);
            cr.moveTo(-Math.sin(angle) * r * tail, Math.cos(angle) * r * tail);
            cr.lineTo(Math.sin(angle) * r * length, -Math.cos(angle) * r * length);
            cr.stroke();
        };
        const thick = design === 'minimal' ? 1.5 : 1;
        paint(ink);
        handTo(hours * Math.PI / 6, 0.5, 0.05 * thick, design === 'minimal' ? 0 : 0.1);
        if (design !== 'paper')
            handTo(minutes * Math.PI / 30, 0.76, 0.03 * thick, design === 'minimal' ? 0 : 0.1);
        paint(hand);
        if (design === 'paper')
            handTo(minutes * Math.PI / 30, 0.76, 0.03);
        if (design === 'watch')
            handTo(seconds * Math.PI / 30, 0.86, 0.012, 0.2);
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
        this._stopSeconds();

        // Its face: digital, or with hands (in the Analogue look, as on paper).
        const choice = this.entry.face ?? 'auto';
        const analogue = this._context.style() === 'analogue';
        const design = choice === 'auto' ? (analogue ? 'paper' : 'digital') : choice;
        const hands = design !== 'digital';
        const row = new St.BoxLayout({style_class: 'atelier-widget-clock', x_expand: true, y_expand: true});
        box.add_child(row);
        if (hands) {
            this._face = new Face(design);
            row.add_child(this._face);
            // (A second hand moves every second, while it is shown.)
            if (design === 'watch') {
                this._secondsId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                    if (this._face?.mapped)
                        this._face.queue_repaint();
                    return GLib.SOURCE_CONTINUE;
                });
            }
        }
        if (!hands || size !== 'square') {
            const text = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(text);
            const time = new St.BoxLayout({x_align: hands ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER});
            text.add_child(time);
            this._time = label('atelier-widget-time');
            this._suffix = label('atelier-widget-time-suffix', '', {y_align: Clutter.ActorAlign.END});
            time.add_child(this._time);
            time.add_child(this._suffix);
            this._date = label('atelier-widget-caption', '', {
                x_align: hands ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
            });
            text.add_child(this._date);
        }
        this._sync();
    }

    _stopSeconds() {
        if (this._secondsId)
            GLib.source_remove(this._secondsId);
        this._secondsId = 0;
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
        this._stopSeconds();
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
