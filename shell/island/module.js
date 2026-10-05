// The island feature: the capsule in the middle of the top bar with the
// time, the glance on hover, the power menu, profile toasts, and the switcher
// when it is open. GNOME's clock button makes room for it.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {effectiveWallpaper} from '../../lib/profiles.js';
import {switcherWidth} from '../switcherContent.js';
import {CalendarBridge} from './calendar.js';
import {GlancePage} from './glance.js';
import {IdleView} from './idle.js';
import {MicWatcher, UnseenWatcher} from './indicators.js';
import {Island} from './island.js';
import {SwitcherPage} from './page.js';
import {POWER_ACTIONS, PowerPage} from './power.js';
import {ToastPage} from './toast.js';

export const SLOT_ROLE = 'atelier-island';

const GLANCE_DELAY = 300;
const GLANCE_HIDE_DELAY = 250;
// The active profile is only restored right after start; that's no news.
const QUIET_START = 3000;
// Height of the capsule at rest, logical pixels: the top bar's height minus
// a margin, within these bounds.
const IDLE_MARGIN = 3;
const IDLE_MIN_HEIGHT = 20;
const IDLE_MAX_HEIGHT = 28;

// Keeps the island's place in the center of the top bar.
const IslandSlot = GObject.registerClass(
class AtelierIslandSlot extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Atelier Island', true);
        this.add_style_class_name('atelier-island-slot');
        // The island lies on top and takes the clicks.
        this.reactive = false;
        this.can_focus = false;
        this.track_hover = false;
        this._spacer = new St.Widget({style_class: 'atelier-island-spacer'});
        this.add_child(this._spacer);
    }

    /** @param {number} width */
    setSpace(width) {
        if (this._spacer.width !== width)
            this._spacer.width = width;
    }
});

export class IslandModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     * @param {ProfileStore} context.store
     */
    constructor({settings, store}) {
        this._settings = settings;
        this._store = store;
        this._timeouts = new Map();
        this._laterId = 0;
        this._pendingToast = null;
        this._glanceBlocked = false;
        /** GNOME's SystemActions unless replaced (tests never power off) */
        this.systemActions = null;
    }

    /** @returns {Island|null} */
    get island() {
        return this._island ?? null;
    }

    enable() {
        this._islandSettings = this._settings.get_child('island');
        this._mic = new MicWatcher();
        this._unseen = new UnseenWatcher();
        this._idle = new IdleView({settings: this._islandSettings, mic: this._mic, unseen: this._unseen});
        this._island = new Island(this._idle);
        Main.layoutManager.addChrome(this._island, {trackFullscreen: true});

        this._slot = new IslandSlot();
        Main.panel.addToStatusArea(SLOT_ROLE, this._slot, 0, 'center');
        this._calendar = new CalendarBridge(this._slot);
        this._calendar.enable();

        this._island.connectObject(
            'notify::hover', () => this._onHover(),
            'clicked', (_, button) => this._onClicked(button),
            'page-closed', () => this._onPageClosed(),
            'idle-resized', () => this._queueLayout(),
            this);
        this._slot.connectObject('notify::allocation', () => this._queueLayout(), this);
        Main.layoutManager.panelBox.connectObject('notify::allocation', () => this._queueLayout(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'changed', () => this._queueLayout(true),
            'notify::scale-factor', () => this._queueLayout(true),
            this);
        this._settings.connectObject('changed::active-profile', () => this._onProfileChanged(), this);

        Main.wm.addKeybinding('atelier-power-menu', this._islandSettings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this.togglePowerMenu());

        this._startedAt = GLib.get_monotonic_time();
        this._queueLayout();
    }

    disable() {
        Main.wm.removeKeybinding('atelier-power-menu');
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;

        this._settings.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        Main.layoutManager.panelBox.disconnectObject(this);
        this._calendar?.disable();
        this._calendar = null;
        // The page shown, the idle view and their connections go with it.
        this._island?.destroy();
        this._island = null;
        this._idle = null;
        this._slot?.destroy();
        this._slot = null;
        this._mic?.destroy();
        this._mic = null;
        this._unseen?.destroy();
        this._unseen = null;
        this._pendingToast = null;
    }

    /**
     * Show the switcher in the island.
     *
     * @param {SwitcherContent} content
     * @returns {boolean} false when the island can't show it (then a popup does)
     */
    showSwitcher(content) {
        const island = this._island;
        if (!island?.visible || !this._slot.mapped || island.busy)
            return false;

        const page = new SwitcherPage(content);
        island.adopt(page);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        page.setWidth(switcherWidth(workArea.width, scale));
        if (!island.open(page, {modal: true})) {
            page.release();
            page.destroy();
            return false;
        }
        return true;
    }

    /** Open the power menu, or close it when it's open. */
    togglePowerMenu() {
        const island = this._island;
        if (!island)
            return;
        if (island.page instanceof PowerPage) {
            island.close();
            return;
        }
        // Not over another menu or modal page, and not without the island.
        if (island.busy || Main.actionMode === Shell.ActionMode.POPUP || !island.visible || !this._slot.mapped)
            return;

        const actions = this.systemActions ?? SystemActions.getDefault();
        actions.forceUpdate();
        const page = new PowerPage(actions);
        page.connect('activate', (_, id) => this._runPowerAction(actions, id));
        if (!island.open(page, {modal: true}))
            page.destroy();
    }

    _runPowerAction(actions, id) {
        const action = POWER_ACTIONS.find(a => a.id === id);
        this._island.close();
        // Once the island has let go of the keyboard: the lock screen or the
        // session's confirmation dialog take it next.
        this._setTimeout('power-action', 0, () => {
            try {
                action.run(actions);
            } catch (e) {
                Main.notifyError('Atelier', `${action.label} failed: ${e.message}`);
            }
        });
    }

    _onHover() {
        const island = this._island;
        if (island.hover) {
            this._clearTimeout('hide-glance');
            const wanted = this._islandSettings.get_boolean('glance-on-hover');
            if (wanted && !this._glanceBlocked && !island.page && !this._calendar.isOpen)
                this._setTimeout('show-glance', GLANCE_DELAY, () => this._showGlance());
        } else {
            // After a click, the glance waits until the pointer has left once.
            this._glanceBlocked = false;
            this._clearTimeout('show-glance');
            if (island.page instanceof GlancePage) {
                this._setTimeout('hide-glance', GLANCE_HIDE_DELAY, () => {
                    if (island.page instanceof GlancePage && !island.hover)
                        island.close();
                });
            }
        }
    }

    _showGlance() {
        const island = this._island;
        if (island.page || !island.hover || this._calendar.isOpen)
            return;
        const glance = new GlancePage({events: this._calendar.events, weather: this._calendar.weather});
        glance.connect('power-request', () => this.togglePowerMenu());
        island.open(glance);
    }

    _onClicked(button) {
        this._glanceBlocked = true;
        this._clearTimeout('show-glance');
        if (button !== Clutter.BUTTON_PRIMARY)
            return;
        if (this._island.page)
            this._island.close();
        // Until the control centre arrives, GNOME's calendar and
        // notifications open under the island.
        this._calendar.toggle();
    }

    _onPageClosed() {
        const island = this._island;
        if (island.page)
            return; // another page took its place
        if (this._pendingToast) {
            const profile = this._store.get(this._pendingToast);
            this._pendingToast = null;
            if (profile) {
                this._showToast(profile);
                return;
            }
        }
        if (island.hover)
            this._onHover();
    }

    _onProfileChanged() {
        if (!this._islandSettings.get_boolean('profile-toast'))
            return;
        if (GLib.get_monotonic_time() - this._startedAt < QUIET_START * 1000)
            return;
        const profile = this._store.get(this._store.activeId);
        if (!profile)
            return;
        // The switcher (or another modal page) finishes first.
        if (this._island.busy)
            this._pendingToast = profile.id;
        else
            this._showToast(profile);
    }

    _showToast(profile) {
        this._clearTimeout('show-glance');
        const scheme = profile.colorScheme ??
            new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('color-scheme');
        this._island.open(new ToastPage({
            title: profile.name,
            subtitle: 'Profile',
            wallpaper: effectiveWallpaper(profile, scheme),
        }));
    }

    /**
     * Lay the island out once the top bar is allocated.
     *
     * @param {boolean} [restyled] - styles changed: re-measure the shown page
     */
    _queueLayout(restyled = false) {
        this._restyled ||= restyled;
        if (this._laterId)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._layout();
            return GLib.SOURCE_REMOVE;
        });
    }

    _layout() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const panelHeight = Main.panel.height;
        const height = Math.round(Math.max(IDLE_MIN_HEIGHT * scale,
            Math.min(IDLE_MAX_HEIGHT * scale, panelHeight - 2 * IDLE_MARGIN * scale)));
        const restyled = this._restyled || this._idle.height !== height;
        this._restyled = false;
        this._idle.height = height;

        const [width] = this._island.idleSize();
        this._slot.setSpace(width);
        if (!this._slot.has_allocation())
            return;

        const [x] = this._slot.get_transformed_position();
        const [slotWidth] = this._slot.get_transformed_size();
        const [, panelY] = Main.panel.get_transformed_position();
        this._island.setAnchor(Math.round(x + slotWidth / 2), Math.round(panelY + (panelHeight - height) / 2));
        if (restyled)
            this._island.relayout();
    }

    _setTimeout(name, delay, callback) {
        this._clearTimeout(name);
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeouts.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _clearTimeout(name) {
        const id = this._timeouts.get(name);
        if (id)
            GLib.source_remove(id);
        this._timeouts.delete(name);
    }
}
