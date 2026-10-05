// GNOME's notification list and calendar, on the control centre's
// Notifications and Calendar tabs instead of in the menu of GNOME's clock
// (whose button the island replaces). They go back when the control centre
// is turned off.

import St from 'gi://St';

import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';

export class DateMenuHost {
    /**
     * @param {object} dateMenu - Main.panel.statusArea.dateMenu
     */
    constructor(dateMenu) {
        this._dateMenu = dateMenu;
        const list = dateMenu._messageList;
        const column = dateMenu._calendar.get_parent();
        this._parent = list.get_parent();
        this._items = [list, column]
            .map(actor => ({actor, index: this._parent.get_children().indexOf(actor)}))
            .sort((a, b) => a.index - b.index);

        dateMenu.menu.close(PopupAnimation.NONE);
        this._items.forEach(({actor}) => this._parent.remove_child(actor));

        this.notifications = new St.Bin({style_class: 'atelier-cc-notifications', child: list, x_expand: true});
        this.calendar = new St.Bin({style_class: 'atelier-cc-calendar', child: column, x_expand: true});
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
        this.notifications.set_child(null);
        this.calendar.set_child(null);
        for (const {actor, index} of this._items)
            this._parent.insert_child_at_index(actor, Math.min(index, this._parent.get_n_children()));
        this.notifications.get_parent()?.remove_child(this.notifications);
        this.calendar.get_parent()?.remove_child(this.calendar);
        this.notifications.destroy();
        this.calendar.destroy();
    }
}
