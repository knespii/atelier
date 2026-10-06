// GNOME's notification list and calendar, on the control centre's
// Notifications and Calendar tabs instead of in the menu of GNOME's clock
// (whose button the island replaces). On the Calendar tab the month sits
// on the left, under today's date, with the day's events beside it (the
// world clocks and the weather stay out). Everything goes back when the
// control centre is turned off.

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

        // Today and the month on the left…
        const month = new St.BoxLayout({
            style_class: 'atelier-cc-calendar-month',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._moved = [];
        for (const actor of [dateMenu._date, dateMenu._calendar].filter(Boolean))
            this._move(actor, month);
        // …the day's events on the right, as tall as the month (scrolled
        // when there are more).
        const events = new St.BoxLayout({style_class: 'atelier-cc-calendar-events', orientation: Clutter.Orientation.VERTICAL});
        if (dateMenu._eventsItem)
            this._move(dateMenu._eventsItem, events);
        const side = new St.ScrollView({
            style_class: 'atelier-cc-calendar-side',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: events,
        });
        side.add_constraint(new Clutter.BindConstraint({source: month, coordinate: Clutter.BindCoordinate.HEIGHT}));
        this.calendar = new St.BoxLayout({style_class: 'atelier-cc-calendar', x_align: Clutter.ActorAlign.CENTER});
        this.calendar.add_child(month);
        this.calendar.add_child(side);

        // The days spread evenly over the month's box, so the grid sits in
        // its middle.
        const grid = dateMenu._calendar.layout_manager;
        this._homogeneous = grid.column_homogeneous;
        grid.column_homogeneous = true;
    }

    // Take an actor out of GNOME's menu, remembering where it was.
    _move(actor, to) {
        const parent = actor.get_parent();
        this._moved.push({actor, parent, index: parent.get_children().indexOf(actor)});
        parent.remove_child(actor);
        to.add_child(actor);
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
        // In the order they were taken, so each gets its old place back.
        for (const {actor, parent, index} of this._moved.reverse()) {
            actor.get_parent()?.remove_child(actor);
            parent.insert_child_at_index(actor, Math.min(index, parent.get_n_children()));
        }
        this._moved = [];
        for (const actor of [this.notifications, this.calendar]) {
            actor.get_parent()?.remove_child(actor);
            actor.destroy();
        }
    }
}
