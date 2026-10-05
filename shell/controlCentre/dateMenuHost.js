// GNOME's notification list and calendar, on the control centre's
// Notifications and Calendar tabs instead of in the menu of GNOME's clock
// (whose button the island replaces). On the Calendar tab the month sits
// on the left, under today's date, with the events, world clocks and
// weather next to it. Everything goes back when the control centre is
// turned off.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';

export class DateMenuHost {
    /**
     * @param {object} dateMenu - Main.panel.statusArea.dateMenu
     */
    constructor(dateMenu) {
        this._dateMenu = dateMenu;
        dateMenu.menu.close(PopupAnimation.NONE);

        const list = dateMenu._messageList;
        this._listParent = list.get_parent();
        this._listIndex = this._listParent.get_children().indexOf(list);
        this._listParent.remove_child(list);
        this.notifications = new St.Bin({style_class: 'atelier-cc-notifications', child: list, x_expand: true});

        // The column's children, in their order: today and the month go
        // left, the rest (events, clocks, weather) right.
        this._column = dateMenu._calendar.get_parent();
        this._columnChildren = this._column.get_children();
        const month = new St.BoxLayout({
            style_class: 'atelier-cc-calendar-month',
            orientation: Clutter.Orientation.VERTICAL,
        });
        const side = new St.BoxLayout({
            style_class: 'atelier-cc-calendar-side',
            orientation: Clutter.Orientation.VERTICAL,
        });
        for (const actor of this._columnChildren) {
            this._column.remove_child(actor);
            (actor === dateMenu._date || actor === dateMenu._calendar ? month : side).add_child(actor);
        }
        this.calendar = new St.BoxLayout({style_class: 'atelier-cc-calendar', x_align: Clutter.ActorAlign.CENTER});
        this.calendar.add_child(month);
        this.calendar.add_child(side);

        // The days spread evenly over the month's box, so the grid sits in
        // its middle.
        const grid = dateMenu._calendar.layout_manager;
        this._homogeneous = grid.column_homogeneous;
        grid.column_homogeneous = true;
    }

    /** Start at today, as GNOME's menu does when it opens. */
    showToday() {
        const now = new Date();
        this._dateMenu._calendar.setDate(now);
        this._dateMenu._date?.setDate(now);
        this._dateMenu._eventsItem?.setDate(now);
    }

    /** Give the list and the calendar back to GNOME's menu. */
    release() {
        this._dateMenu._calendar.layout_manager.column_homogeneous = this._homogeneous;
        this.notifications.set_child(null);
        const list = this._dateMenu._messageList;
        this._listParent.insert_child_at_index(list, Math.min(this._listIndex, this._listParent.get_n_children()));
        for (const actor of this._columnChildren) {
            actor.get_parent()?.remove_child(actor);
            this._column.add_child(actor);
        }
        for (const actor of [this.notifications, this.calendar]) {
            actor.get_parent()?.remove_child(actor);
            actor.destroy();
        }
    }
}
