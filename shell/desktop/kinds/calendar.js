// The calendar: this month with today and the days that have events, then
// what's left of today and the open Google Tasks, which can be ticked off
// right here. As a card: the days around today and the next few things.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DesktopWidget, label, launchApp} from '../widget.js';

const dayStart = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const addDays = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const format = (date, fmt) =>
    GLib.DateTime.new_local(date.getFullYear(), date.getMonth() + 1, date.getDate(), 0, 0, 0).format(fmt);
const shortTime = date => formatTime(date, {timeOnly: true}).trim();

export const CalendarWidget = GObject.registerClass(
class AtelierCalendarWidget extends DesktopWidget {
    build(box, size) {
        if (!this._clock) {
            // GNOME's calendar knows the events; the clock says when the day
            // changes.
            this._events = Main.panel.statusArea.dateMenu?._eventSource ?? null;
            this._events?.connectObject('changed', () => this._sync(), this);
            this._context.sources.tasks.connectObject('changed', () => this._sync(), this);
            this._clock = new GnomeDesktop.WallClock({time_only: true});
            this._clock.connectObject('notify::clock', () => this._sync(), this);
        }
        if (size === 'large') {
            const header = new St.BoxLayout({style_class: 'atelier-widget-header'});
            this._month = label('atelier-widget-title', '', {x_expand: true});
            this._year = label('atelier-widget-caption', '', {y_align: Clutter.ActorAlign.CENTER});
            header.add_child(this._month);
            header.add_child(this._year);
            box.add_child(header);
            this._grid = new St.Widget({
                style_class: 'atelier-widget-month',
                layout_manager: new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true}),
                x_expand: true,
            });
            box.add_child(this._grid);
            this._week = null;
        } else {
            this._month = this._year = this._grid = null;
            this._week = new St.BoxLayout({style_class: 'atelier-widget-week', x_expand: true});
            box.add_child(this._week);
        }
        this._agenda = new St.BoxLayout({
            style_class: 'atelier-widget-agenda',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        box.add_child(this._agenda);
        this._day = null;
        this._sync();
    }

    _sync() {
        if (!this._agenda)
            return;
        const today = dayStart(new Date());
        if (this._day?.getTime() !== today.getTime()) {
            this._day = today;
            // This month's events (the card shows a few days beyond it).
            const first = new Date(today.getFullYear(), today.getMonth(), 1);
            this._events?.requestRange(addDays(first, -7), addDays(new Date(today.getFullYear(), today.getMonth() + 1, 1), 7));
        }
        if (this._grid)
            this._syncMonth(today);
        else
            this._syncWeek(today);
        this._syncAgenda(today);
    }

    _hasEvents(day) {
        return Boolean(this._events?.hasCalendars && this._events.hasEvents(day));
    }

    _cell(day, today, other = false) {
        const cell = new St.BoxLayout({
            style_class: 'atelier-widget-cell',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });
        if (day.getTime() === today.getTime())
            cell.add_style_pseudo_class('today');
        if (other)
            cell.add_style_pseudo_class('other-month');
        cell.add_child(label('atelier-widget-cell-number', String(day.getDate()), {x_align: Clutter.ActorAlign.CENTER}));
        const dot = new St.Widget({style_class: 'atelier-widget-cell-dot', x_align: Clutter.ActorAlign.CENTER});
        dot.opacity = this._hasEvents(day) ? 255 : 0;
        cell.add_child(dot);
        return cell;
    }

    _syncMonth(today) {
        this._month.text = format(today, '%B');
        this._year.text = String(today.getFullYear());
        this._grid.destroy_all_children();
        const layout = this._grid.layout_manager;
        const weekStart = Shell.util_get_week_start();
        const first = new Date(today.getFullYear(), today.getMonth(), 1);
        const start = addDays(first, -((7 + first.getDay() - weekStart) % 7));
        for (let i = 0; i < 7; i++) {
            const name = format(addDays(start, i), '%a');
            layout.attach(label('atelier-widget-weekday-initial', name.charAt(0).toUpperCase(),
                {x_align: Clutter.ActorAlign.CENTER}), i, 0, 1, 1);
        }
        // Six weeks, or five when the month fits.
        const weeks = addDays(start, 35) <= new Date(today.getFullYear(), today.getMonth() + 1, 0) ? 6 : 5;
        for (let i = 0; i < weeks * 7; i++) {
            const day = addDays(start, i);
            layout.attach(this._cell(day, today, day.getMonth() !== today.getMonth()), i % 7, 1 + Math.floor(i / 7), 1, 1);
        }
    }

    _syncWeek(today) {
        this._week.destroy_all_children();
        for (let offset = -1; offset <= 5; offset++) {
            const day = addDays(today, offset);
            const column = new St.BoxLayout({
                style_class: 'atelier-widget-week-day',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            const name = format(day, '%a');
            column.add_child(label('atelier-widget-weekday-initial',
                offset === 0 ? name.toUpperCase() : name.charAt(0).toUpperCase(), {x_align: Clutter.ActorAlign.CENTER}));
            column.add_child(this._cell(day, today));
            if (offset === 0)
                column.add_style_pseudo_class('today');
            this._week.add_child(column);
        }
    }

    _syncAgenda(today) {
        this._agenda.destroy_all_children();
        const tasks = this._context.sources.tasks;
        const room = this.entry.size === 'large' ? 4 : 3;
        const now = new Date();
        const tomorrow = addDays(today, 1);
        const events = this._events?.hasCalendars
            ? this._events.getEvents(today, tomorrow).filter(event => event.end > now)
            : [];
        const items = [
            ...events.map(event => ({event})),
            ...tasks.tasks.map(task => ({task})),
        ].slice(0, room);
        for (const item of items)
            this._agenda.add_child(item.event ? this._eventRow(item.event, today, tomorrow) : this._taskRow(item.task));
        if (items.length === 0) {
            this._agenda.add_child(label('atelier-widget-placeholder',
                tasks.state === 'no-account' ? 'Nothing else today' : 'Nothing else today, nothing to do'));
        }
        if (tasks.state === 'no-account' && this.entry.size === 'large') {
            const hint = new St.Button({
                style_class: 'atelier-widget-hint',
                label: 'Add Google in Online Accounts for your tasks',
                x_align: Clutter.ActorAlign.START,
            });
            hint.connect('clicked', () => launchApp('gnome-online-accounts-panel.desktop'));
            this._agenda.add_child(hint);
        }
    }

    _eventRow(event, today, tomorrow) {
        const row = new St.BoxLayout({style_class: 'atelier-widget-agenda-row'});
        row.add_child(new St.Widget({style_class: 'atelier-widget-event-bar', y_expand: true}));
        const summary = label('atelier-widget-agenda-text', event.summary, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(summary);
        let when;
        if (event.date <= today && event.end >= tomorrow)
            when = 'All day';
        else if (event.date < today)
            when = `Until ${shortTime(event.end)}`;
        else
            when = shortTime(event.date);
        row.add_child(label('atelier-widget-agenda-time', when, {y_align: Clutter.ActorAlign.CENTER}));
        return row;
    }

    _taskRow(task) {
        const row = new St.BoxLayout({style_class: 'atelier-widget-agenda-row'});
        const check = new St.Button({
            style_class: 'atelier-widget-check',
            accessible_name: `Done: ${task.title}`,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'object-select-symbolic'}),
        });
        check.connect('clicked', () => this._context.sources.tasks.complete(task));
        row.add_child(check);
        const title = label('atelier-widget-agenda-text', task.title, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(title);
        if (task.due) {
            // Due dates are days (stored at midnight UTC).
            const due = new Date(task.due.getUTCFullYear(), task.due.getUTCMonth(), task.due.getUTCDate());
            row.add_child(label('atelier-widget-agenda-time', format(due, '%b %-d'), {y_align: Clutter.ActorAlign.CENTER}));
        }
        return row;
    }

    activate() {
        launchApp('org.gnome.Calendar.desktop');
    }

    cleanup() {
        this._events?.disconnectObject(this);
        this._context.sources.tasks.disconnectObject(this);
        this._clock?.disconnectObject(this);
        this._clock?.run_dispose();
        this._clock = null;
        this._agenda = null;
    }
});
