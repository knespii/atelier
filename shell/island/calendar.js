// The island takes the place of GNOME's clock button. The button is hidden,
// but its calendar and notification list stay in use: on the control
// centre's tabs, or without it in GNOME's menu under the island. The glance
// reads the clock's calendar events and weather.

import St from 'gi://St';

import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class CalendarBridge {
    /**
     * @param {Clutter.Actor} anchor - the menu opens under it
     * @param {Function} controlCentre - () => the control centre, if it opens in the island
     */
    constructor(anchor, controlCentre) {
        this._anchor = anchor;
        this._controlCentre = controlCentre;
        this._dateMenu = null;
        this._injections = new InjectionManager();
    }

    /** @returns {object|null} the calendar's event source */
    get events() {
        return this._dateMenu?._eventSource ?? null;
    }

    /** @returns {object|null} the weather client of the calendar menu */
    get weather() {
        return this._dateMenu?._weatherItem?._weatherClient ?? null;
    }

    /** @returns {boolean} whether the calendar menu is open */
    get isOpen() {
        return this._dateMenu?.menu.isOpen ?? false;
    }

    enable() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu)
            return;
        this._dateMenu = dateMenu;
        this._sourceActor = dateMenu.menu.sourceActor;
        dateMenu.menu.sourceActor = this._anchor;
        dateMenu.container.hide();
        // The panel shows its items again whenever the session mode changes,
        // and other extensions (Just Perfection) may show the clock too.
        dateMenu.container.connectObject('notify::visible', () => {
            if (dateMenu.container.visible)
                dateMenu.container.hide();
        }, this);

        // Super+V and others go through these; the panel's own versions
        // refuse to open a menu whose button is hidden.
        this._injections.overrideMethod(Main.panel, 'toggleCalendar', () => () => this.toggle());
        this._injections.overrideMethod(Main.panel, 'closeCalendar', () => () => this.close());
    }

    disable() {
        this._injections.clear();
        const dateMenu = this._dateMenu;
        this._dateMenu = null;
        if (!dateMenu)
            return;
        dateMenu.container.disconnectObject(this);
        dateMenu.menu.close();
        dateMenu.menu.sourceActor = this._sourceActor;
        const layout = Main.sessionMode.panel;
        if ([layout.left, layout.center, layout.right].some(items => items.includes('dateMenu')))
            dateMenu.container.show();
    }

    toggle() {
        const controlCentre = this._controlCentre();
        if (controlCentre) {
            controlCentre.toggle('notifications');
            return;
        }
        const menu = this._dateMenu?.menu;
        if (!menu || !this._anchor.mapped)
            return;
        menu.toggle();
        if (menu.isOpen)
            menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    close() {
        this._controlCentre()?.close();
        this._dateMenu?.menu.close();
    }
}
