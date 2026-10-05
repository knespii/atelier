// The control centre in the island: tabs for GNOME's quick settings, the
// notification list, the calendar and extension icons.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {IslandPage} from '../island/page.js';

/**
 * @typedef {object} Tab
 * @property {string} id
 * @property {string} label
 * @property {string|Gio.Icon} icon - an icon name or icon
 * @property {Clutter.Actor} actor - the content; it outlives the page
 * @property {Function} [available] - () => boolean, whether the tab shows
 * @property {Function} [onShow] - called when the tab comes up
 */

export const ControlCentrePage = GObject.registerClass(
class AtelierControlCentrePage extends IslandPage {
    /**
     * @param {Tab[]} tabs
     * @param {string} tab - the tab to start with
     */
    _init(tabs, tab) {
        super._init({style_class: 'atelier-cc', orientation: Clutter.Orientation.VERTICAL});
        this._tabs = tabs;

        this._bar = new St.BoxLayout({style_class: 'atelier-cc-tabs', x_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._bar);
        this._buttons = new Map();
        for (const {id, label, icon} of tabs) {
            const box = new St.BoxLayout({style_class: 'atelier-cc-tab-box'});
            box.add_child(new St.Icon({
                style_class: 'atelier-cc-tab-icon',
                ...typeof icon === 'string' ? {icon_name: icon} : {gicon: icon},
            }));
            const text = new St.Label({style_class: 'atelier-cc-tab-label', text: label, y_align: Clutter.ActorAlign.CENTER});
            box.add_child(text);
            const button = new St.Button({style_class: 'atelier-cc-tab', accessible_name: label, can_focus: true, child: box});
            button.label_actor = text;
            button._text = text;
            button.connect('clicked', () => this.setTab(id));
            this._bar.add_child(button);
            this._buttons.set(id, button);
        }

        // The contents stay alive when the page goes; they belong to the module.
        for (const {actor} of tabs) {
            actor.get_parent()?.remove_child(actor);
            this.add_child(actor);
        }
        this.connect('destroy', () => {
            // (Some may be gone already when the control centre is turned off.)
            const children = this.get_children();
            for (const {actor} of tabs) {
                if (children.includes(actor))
                    this.remove_child(actor);
            }
        });

        global.focus_manager.add_group(this);
        this._tab = null;
        this.setTab(this._shows(tab) ? tab : tabs[0].id);
    }

    /** @returns {string} the tab shown */
    get tab() {
        return this._tab;
    }

    /** @param {string} id - a tab's id */
    setTab(id) {
        if (!this._shows(id))
            return;
        const changed = id !== this._tab;
        this._tab = id;
        this.sync();
        if (changed)
            this._tabs.find(tab => tab.id === id).onShow?.();
    }

    /** Update the tabs, e.g. when one has become (un)available. */
    sync() {
        if (!this._shows(this._tab))
            this._tab = this._tabs[0].id;
        for (const tab of this._tabs) {
            const button = this._buttons.get(tab.id);
            const current = tab.id === this._tab;
            button.visible = this._shows(tab.id);
            button._text.visible = current;
            if (current)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
            if (this.get_children().includes(tab.actor))
                tab.actor.visible = current;
        }
        this.resized();
    }

    _shows(id) {
        const tab = this._tabs.find(t => t.id === id);
        return Boolean(tab && (tab.available?.() ?? true));
    }

    // Keys work from here (Tab and arrows move into the controls) without a
    // focus ring on the first one when it was opened with the mouse.
    focus() {
        this.grab_key_focus();
    }

    // As wide as the widest tab, so switching tabs doesn't resize it. (A
    // hidden tab without a sensible width – an extension's odd icon – is
    // left out; the island looks after the one shown.)
    vfunc_get_preferred_width(forHeight) {
        let [min, nat] = super.vfunc_get_preferred_width(forHeight);
        const padding = this.get_theme_node().get_horizontal_padding();
        const children = this.get_children();
        for (const {actor} of this._tabs) {
            if (!children.includes(actor))
                continue;
            const [, width] = actor.get_preferred_width(-1);
            if (!Number.isFinite(width))
                continue;
            min = Math.max(min, width + padding);
            nat = Math.max(nat, width + padding);
        }
        return [min, nat];
    }

    handleKeyPress(event) {
        // Ctrl+Tab goes through the tabs; arrows and Tab move between controls.
        const symbol = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrl && (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab)) {
            const shown = this._tabs.filter(tab => this._shows(tab.id));
            const step = symbol === Clutter.KEY_ISO_Left_Tab ? -1 : 1;
            const index = shown.findIndex(tab => tab.id === this._tab);
            this.setTab(shown[(index + step + shown.length) % shown.length].id);
            return true;
        }
        return global.focus_manager.navigate_from_event(event);
    }
});
