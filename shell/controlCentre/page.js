// The control centre in the island: GNOME's quick settings on the Controls
// tab, extension icons on the Extensions tab.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {IslandPage} from '../island/page.js';

export const TABS = [['controls', 'Controls'], ['extensions', 'Extensions']];

export const ControlCentrePage = GObject.registerClass(
class AtelierControlCentrePage extends IslandPage {
    /**
     * @param {object} params
     * @param {QuickSettingsHost} params.host - GNOME's tiles
     * @param {ExtensionTray|null} params.tray - extension icons, if moved here
     */
    _init({host, tray}) {
        super._init({style_class: 'atelier-cc', orientation: Clutter.Orientation.VERTICAL});
        this._host = host;
        this._tiles = host.actor;
        this._tray = tray;

        this._tabs = new St.BoxLayout({style_class: 'atelier-tabs', x_align: Clutter.ActorAlign.CENTER});
        this._tabButtons = new Map();
        for (const [id, label] of TABS) {
            const button = new St.Button({style_class: 'atelier-tab', label, can_focus: true});
            button.connect('clicked', () => this.setTab(id));
            this._tabs.add_child(button);
            this._tabButtons.set(id, button);
        }
        this.add_child(this._tabs);

        // Both stay alive when the page goes; they move back to the module.
        for (const actor of [host.actor, tray].filter(Boolean)) {
            actor.get_parent()?.remove_child(actor);
            this.add_child(actor);
        }
        tray?.connectObject('changed', () => this._syncTabs(), this);
        this.connect('destroy', () => {
            // (Either may be gone already when Atelier is turned off.)
            const children = this.get_children();
            for (const actor of [this._tiles, tray].filter(Boolean)) {
                if (children.includes(actor))
                    this.remove_child(actor);
            }
        });

        global.focus_manager.add_group(this);
        this._tab = 'controls';
        this._syncTabs();
    }

    /** @returns {string} the tab shown */
    get tab() {
        return this._tab;
    }

    /** @param {string} id - one of TABS */
    setTab(id) {
        if (!this._hasTab(id) || id === this._tab)
            return;
        this._tab = id;
        this._host.closeMenus();
        this._syncTabs();
        this.focus();
    }

    _hasTab(id) {
        return id === 'controls' || (id === 'extensions' && this._tray?.tiles.length > 0);
    }

    _syncTabs() {
        if (!this._hasTab(this._tab))
            this._tab = 'controls';
        const extensions = this._hasTab('extensions');
        // One tab is no choice: no tabs then.
        this._tabs.visible = extensions;
        for (const [id, button] of this._tabButtons) {
            if (id === this._tab)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
        if (this._hasTiles())
            this._tiles.visible = this._tab === 'controls';
        if (this._tray)
            this._tray.visible = this._tab === 'extensions';
        this.resized();
    }

    // Keys work from here (Tab and arrows move into the controls) without a
    // focus ring on the first one when it was opened with the mouse.
    focus() {
        this.grab_key_focus();
    }

    // As wide as the tiles on both tabs, so switching tabs doesn't resize it.
    vfunc_get_preferred_width(forHeight) {
        const [min, nat] = super.vfunc_get_preferred_width(forHeight);
        if (!this._hasTiles())
            return [min, nat];
        const padding = this.get_theme_node().get_horizontal_padding();
        const [, tiles] = this._tiles.get_preferred_width(-1);
        return [Math.max(min, tiles + padding), Math.max(nat, tiles + padding)];
    }

    // The tiles go back to GNOME when the control centre is turned off,
    // possibly while this page is still fading out.
    _hasTiles() {
        return this._host.actor === this._tiles;
    }

    handleKeyPress(event) {
        // Ctrl+Tab switches tabs; arrows and Tab move between controls.
        const symbol = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrl && (symbol === Clutter.KEY_Tab || symbol === Clutter.KEY_ISO_Left_Tab)) {
            this.setTab(this._tab === 'controls' ? 'extensions' : 'controls');
            return true;
        }
        return global.focus_manager.navigate_from_event(event);
    }
});
