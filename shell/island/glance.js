// The glance: what the island shows while the pointer rests on it. A big
// clock next to the days around today, then what's left of today's events
// and the weather, all read from GNOME's own calendar and weather sources.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';

import {IslandPage} from './page.js';

const MAX_EVENTS = 3;
// Days shown before and after today.
const DAYS_AROUND = 2;

const dayStart = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const format = (date, fmt) =>
    GLib.DateTime.new_local(date.getFullYear(), date.getMonth() + 1, date.getDate(), 0, 0, 0).format(fmt);
const shortTime = date => formatTime(date, {timeOnly: true}).trim();

export const GlancePage = GObject.registerClass(
class AtelierGlance extends IslandPage {
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
        // The digits big; AM or PM, if the clock has them, small after them.
        const clock = new St.BoxLayout({style_class: 'atelier-glance-clock', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(clock);
        this._time = new St.Label({style_class: 'atelier-glance-time'});
        this._suffix = new St.Label({style_class: 'atelier-glance-suffix', y_align: Clutter.ActorAlign.END});
        for (const label of [this._time, this._suffix]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            clock.add_child(label);
        }
        this._week = new St.BoxLayout({
            style_class: 'atelier-glance-week',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._week);

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
        const text = this._clock.clock.trim();
        const [, digits, suffix] = /^([\d:.\u2236\s]*\d)\s*(\D*)$/u.exec(text) ?? [null, text, ''];
        this._time.text = digits;
        this._suffix.text = suffix;
        this._suffix.visible = suffix !== '';
        const today = dayStart(new Date());
        if (this._day?.getTime() !== today.getTime()) {
            this._day = today;
            this._syncDay();
        }
    }

    _syncDay() {
        const today = this._day;
        this._syncWeek(today);
        this._syncEvents(today);
        this.resized();
    }

    // Today in the middle, named in full (MON); the others by their initial.
    _syncWeek(today) {
        this._week.destroy_all_children();
        for (let offset = -DAYS_AROUND; offset <= DAYS_AROUND; offset++) {
            const day = addDays(today, offset);
            const cell = new St.BoxLayout({
                style_class: 'atelier-glance-day',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            if (offset === 0)
                cell.add_style_pseudo_class('today');
            const name = format(day, '%a');
            cell.add_child(new St.Label({
                style_class: 'atelier-glance-day-name',
                text: offset === 0 ? name.toUpperCase() : name.charAt(0).toUpperCase(),
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
        const wasVisible = this._weatherRow.visible;
        this._updateWeather();
        if (this._weatherRow.visible !== wasVisible)
            this.resized();
    }

    _updateWeather() {
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

});
