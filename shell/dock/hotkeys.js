// The dock's keyboard shortcuts: Super with 1 to 0 opens its apps in order
// as a click does (with Shift as a click with Shift does, with Ctrl in a new
// window), in place of GNOME's own Super+number shortcuts while they are on.
// Pressed, they number the apps on every dock and show the docks for a
// while, as the dock's shortcut (Super+Q) does.
//
// GNOME's shortcuts are given back as GNOME made them, never changed in the
// user's settings. The docks are built anew as their settings change: the
// ones there as a key is pressed are asked.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {activateApp} from './actions.js';
import {Timers} from './timers.js';

const COUNT = 10; // Super+1 to Super+0
const GNOME_COUNT = 9; // GNOME's go to 9
const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
// The dock's shortcuts by their keys, with the modifiers the app is opened
// with.
const KINDS = [
    ['app-hotkey-', 0],
    ['app-shift-hotkey-', Clutter.ModifierType.SHIFT_MASK],
    ['app-ctrl-hotkey-', Clutter.ModifierType.CONTROL_MASK],
];
// GNOME's, with what they do (in Main.wm).
const GNOME = [
    ['switch-to-application-', '_switchToApplication'],
    ['open-new-window-application-', '_openNewApplicationWindow'],
];
const SETTINGS_KEYS = ['hot-keys', 'hotkeys-overlay', 'hotkeys-show-dock'];

export class DockHotkeys {
    /**
     * @param {DockModule} module - for its docks (module.dock is the main one)
     * @param {Gio.Settings} settings - the dock's
     */
    constructor(module, settings) {
        this._module = module;
        this._settings = settings;
        this._appKeys = false;
        this._shortcut = false;
        this._removed = []; // names of GNOME's shortcuts taken away
        this._forced = new Set(); // docks kept shown for the numbers
        this._timers = new Timers();
    }

    /** @returns {boolean} whether the numbers are shown */
    get overlayShown() {
        return this._timers.has('overlay');
    }

    /** Take the shortcuts the settings ask for. */
    enable() {
        this._settings.connectObject(...SETTINGS_KEYS.flatMap(key => [`changed::${key}`, () => this._sync()]), this);
        this._sync();
    }

    _sync() {
        const on = this._settings.get_boolean('hot-keys');
        if (on && !this._appKeys)
            this._takeAppKeys();
        else if (!on && this._appKeys)
            this._giveAppKeysBack();
        const shortcut = on && (this._settings.get_boolean('hotkeys-overlay') ||
            this._settings.get_boolean('hotkeys-show-dock'));
        if (shortcut && !this._shortcut) {
            Main.wm.addKeybinding('shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES,
                () => this.show());
            this._shortcut = true;
        } else if (!shortcut && this._shortcut) {
            Main.wm.removeKeybinding('shortcut');
            this._shortcut = false;
        }
    }

    _takeAppKeys() {
        // GNOME's first (as Main.wm.removeKeybinding does, knowing which
        // were there to give back).
        for (const [prefix] of GNOME) {
            for (let i = 1; i <= GNOME_COUNT; i++) {
                const name = `${prefix}${i}`;
                if (global.display.remove_keybinding(name)) {
                    Main.wm.allowKeybinding(name, Shell.ActionMode.NONE);
                    this._removed.push(name);
                }
            }
        }
        for (const [prefix, modifiers] of KINDS) {
            for (let i = 1; i <= COUNT; i++) {
                Main.wm.addKeybinding(`${prefix}${i}`, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES,
                    () => this.activate(i - 1, modifiers));
            }
        }
        this._appKeys = true;
    }

    _giveAppKeysBack() {
        for (const [prefix] of KINDS) {
            for (let i = 1; i <= COUNT; i++)
                Main.wm.removeKeybinding(`${prefix}${i}`);
        }
        const keybindings = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        for (const name of this._removed) {
            const [, handler] = GNOME.find(([prefix]) => name.startsWith(prefix));
            Main.wm.addKeybinding(name, keybindings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES,
                Main.wm[handler].bind(Main.wm));
        }
        this._removed = [];
        this._appKeys = false;
    }

    /**
     * Open the main dock's app at an index as a click does.
     *
     * @param {number} index - from 0
     * @param {Clutter.ModifierType} [modifiers] - as if held with the click
     */
    activate(index, modifiers = 0) {
        const item = this._module.dock?.orderedItems[index];
        if (item)
            activateApp(item.icon, Clutter.BUTTON_PRIMARY, modifiers, item.icon.ctx);
        this.show();
    }

    /**
     * Number the apps on every dock and show the docks, as the settings ask,
     * for a while (from now on, if they are shown already).
     */
    show() {
        const overlay = this._settings.get_boolean('hotkeys-overlay');
        const showDock = this._settings.get_boolean('hotkeys-show-dock');
        if (!overlay && !showDock)
            return;
        this._hide();
        for (const dock of this._module.docks) {
            if (overlay)
                dock.orderedItems.slice(0, COUNT).forEach((item, i) => addNumber(item.icon, (i + 1) % COUNT));
            if (showDock) {
                dock.force(true);
                this._forced.add(dock);
            }
        }
        this._timers.after('overlay', this._settings.get_double('shortcut-timeout') * 1000, () => this._hide());
    }

    // The numbers away, and the docks free to go.
    _hide() {
        this._timers.clear('overlay');
        for (const dock of this._module.docks)
            dock.orderedItems.forEach(item => removeNumber(item.icon));
        // (Not those built anew meanwhile.)
        for (const dock of this._forced) {
            if (dock.actor)
                dock.force(false);
        }
        this._forced.clear();
    }

    /** Give back every shortcut taken (GNOME's own as well). */
    destroy() {
        this._settings.disconnectObject(this);
        this._timers.destroy();
        this._hide();
        if (this._shortcut)
            Main.wm.removeKeybinding('shortcut');
        this._shortcut = false;
        if (this._appKeys)
            this._giveAppKeysBack();
    }
}

// A number in the corner of an app's icon, as large as the icon allows.
function addNumber(icon, number) {
    removeNumber(icon);
    const container = icon._iconContainer;
    if (!container)
        return;
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const fontSize = Math.round(Math.max(12, 0.3 * container.get_preferred_width(-1)[1]) / scale);
    const size = Math.round(fontSize * 1.4);
    icon._number = new St.Label({
        style_class: 'atelier-dock-number',
        text: `${number}`,
        style: `font-size: ${fontSize}px; min-width: ${size}px; height: ${size}px; border-radius: ${size}px;`,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.START,
        x_expand: true,
        y_expand: true,
    });
    container.add_child(icon._number);
}

function removeNumber(icon) {
    icon._number?.destroy();
    icon._number = null;
}
