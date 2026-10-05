// The glance: what the island shows while the pointer rests on it. A big
// clock, this week, what's left of today's events and the weather, all read
// from GNOME's own calendar and weather sources.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';

import {IslandPage} from './page.js';

const MAX_EVENTS = 3;

const dayStart = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const format = (date, fmt) =>
    GLib.DateTime.new_local(date.getFullYear(), date.getMonth() + 1, date.getDate(), 0, 0, 0).format(fmt);
const shortTime = date => formatTime(date, {timeOnly: true}).trim();

export const GlancePage = GObject.registerClass({
    Signals: {'power-request': {}},
}, class AtelierGlance extends IslandPage {
    /**
     * @param {object} sources
     * @param {object|null} sources.events - GNOME's calendar event source
     * @param {object|null} sources.weather - GNOME's weather client
     */
    _init({events, weather}) {
        super._init({style_class: 'atelier-glance', orientation: Clutter.Orientation.VERTICAL});
        this._events = events;
        this._weather = weather;
        this._day = null;

        const header = new St.BoxLayout({style_class: 'atelier-glance-header'});
        this.add_child(header);
        const clockBox = new St.BoxLayout({
            style_class: 'atelier-glance-clock',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        header.add_child(clockBox);
        this._time = new St.Label({style_class: 'atelier-glance-time'});
        clockBox.add_child(this._time);
        this._date = new St.Label({style_class: 'atelier-glance-date'});
        clockBox.add_child(this._date);

        this._power = new St.Button({
            style_class: 'atelier-glance-power',
            accessible_name: 'Power',
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'system-shutdown-symbolic'}),
        });
        this._power.connect('clicked', () => this.emit('power-request'));
        header.add_child(this._power);

        this._week = new St.BoxLayout({style_class: 'atelier-glance-week', x_expand: true});
        this.add_child(this._week);

        this._eventList = new St.BoxLayout({
            style_class: 'atelier-glance-events',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.add_child(this._eventList);

        this._weatherRow = new St.BoxLayout({style_class: 'atelier-glance-weather', visible: false});
        this._weatherIcon = new St.Icon({style_class: 'atelier-glance-weather-icon', y_align: Clutter.ActorAlign.CENTER});
        this._weatherRow.add_child(this._weatherIcon);
        this._weatherText = new St.Label({
            style_class: 'atelier-glance-weather-text',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._weatherText.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._weatherRow.add_child(this._weatherText);
        this._weatherPlace = new St.Label({style_class: 'atelier-glance-weather-place', y_align: Clutter.ActorAlign.CENTER});
        this._weatherRow.add_child(this._weatherPlace);
        this.add_child(this._weatherRow);

        this._clock = new GnomeDesktop.WallClock({time_only: true});
        this._clock.connectObject('notify::clock', () => this._syncClock(), this);
        events?.connectObject(
            'changed', () => this._syncDay(),
            'notify::has-calendars', () => this._syncDay(),
            this);
        weather?.connectObject('changed', () => this._syncWeather(), this);
        this.connect('destroy', () => {
            this._clock.disconnectObject(this);
            this._clock.run_dispose();
            this._events?.disconnectObject(this);
            this._weather?.disconnectObject(this);
        });

        this._syncClock();
        this._syncWeather();
        weather?.update();
    }

    _syncClock() {
        this._time.text = this._clock.clock.trim();
        const today = dayStart(new Date());
        if (this._day?.getTime() !== today.getTime()) {
            this._day = today;
            this._syncDay();
        }
    }

    _syncDay() {
        const today = this._day;
        this._date.text = format(today, '%A, %B %-d');
        this._syncWeek(today);
        this._syncEvents(today);
    }

    _syncWeek(today) {
        this._week.destroy_all_children();
        const weekStart = Shell.util_get_week_start();
        const first = addDays(today, -((7 + today.getDay() - weekStart) % 7));
        for (let i = 0; i < 7; i++) {
            const day = addDays(first, i);
            const cell = new St.BoxLayout({
                style_class: 'atelier-glance-day',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            if (day.getTime() === today.getTime())
                cell.add_style_pseudo_class('today');
            cell.add_child(new St.Label({
                style_class: 'atelier-glance-day-name',
                text: format(day, '%a'),
                x_align: Clutter.ActorAlign.CENTER,
            }));
            cell.add_child(new St.Label({
                style_class: 'atelier-glance-day-number',
                text: String(day.getDate()),
                x_align: Clutter.ActorAlign.CENTER,
            }));
            const dot = new St.Widget({style_class: 'atelier-glance-day-dot', x_align: Clutter.ActorAlign.CENTER});
            dot.opacity = this._events?.hasCalendars && this._events.hasEvents(day) ? 255 : 0;
            cell.add_child(dot);
            this._week.add_child(cell);
        }
    }

    _syncEvents(today) {
        this._eventList.destroy_all_children();
        const source = this._events;
        this._eventList.visible = Boolean(source?.hasCalendars);
        if (!this._eventList.visible)
            return;

        const tomorrow = addDays(today, 1);
        const now = new Date();
        const all = source.getEvents(today, tomorrow);
        const left = all.filter(event => event.end > now);
        for (const event of left.slice(0, MAX_EVENTS))
            this._eventList.add_child(this._eventRow(event, today, tomorrow));

        if (left.length > MAX_EVENTS) {
            this._eventList.add_child(new St.Label({
                style_class: 'atelier-glance-more',
                text: `+ ${left.length - MAX_EVENTS} more`,
            }));
        } else if (left.length === 0) {
            this._eventList.add_child(new St.Label({
                style_class: 'atelier-glance-placeholder',
                text: all.length > 0 ? 'Nothing else today' : 'No events today',
            }));
        }
    }

    _eventRow(event, today, tomorrow) {
        const row = new St.BoxLayout({style_class: 'atelier-glance-event'});
        row.add_child(new St.Widget({style_class: 'atelier-glance-event-bar', y_expand: true}));
        const summary = new St.Label({
            style_class: 'atelier-glance-event-summary',
            text: event.summary,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(summary);

        let when;
        if (event.date <= today && event.end >= tomorrow)
            when = 'All day';
        else if (event.date < today)
            when = `Until ${shortTime(event.end)}`;
        else
            when = shortTime(event.date);
        row.add_child(new St.Label({
            style_class: 'atelier-glance-event-time',
            text: when,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        return row;
    }

    _syncWeather() {
        const client = this._weather;
        const info = client?.info;
        const usable = client?.available && client.hasLocation && info;
        if (!usable || (!client.loading && !info.is_valid())) {
            this._weatherRow.visible = false;
            return;
        }
        this._weatherRow.visible = true;
        this._weatherPlace.text = info.get_location_name() ?? '';
        if (client.loading && !info.is_valid()) {
            this._weatherIcon.icon_name = 'content-loading-symbolic';
            this._weatherText.text = 'Loading weather…';
            return;
        }
        this._weatherIcon.icon_name = info.get_symbolic_icon_name();
        const sky = [info.get_conditions(), info.get_sky()].find(text => text && text !== '-') ?? '';
        this._weatherText.text = sky ? `${info.get_temp_summary()}  ·  ${sky}` : info.get_temp_summary();
    }

    focus() {
        this._power.grab_key_focus();
    }
});
