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
import {capsuleHeight} from '../core/barMetrics.js';
import {GlassSurface} from '../core/glass.js';
import {switcherWidth} from '../switcherContent.js';
import {CalendarBridge} from './calendar.js';
import {GlancePage} from './glance.js';
import {IdleView} from './idle.js';
import {MicWatcher, UnseenWatcher} from './indicators.js';
import {Island, MORPH_TIME} from './island.js';
import {SwitcherPage} from './page.js';
import {POWER_ACTIONS, PowerPage} from './power.js';
import {ToastPage} from './toast.js';

export const SLOT_ROLE = 'atelier-island';

const GLANCE_DELAY = 300;
const GLANCE_HIDE_DELAY = 250;
// How far down the screen the island may grow, for its glass.
const GLASS_REACH = 0.9;

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
     * @param {ModuleManager} context.modules
     */
    constructor({settings, modules}) {
        this._settings = settings;
        this._modules = modules;
        this._timeouts = new Map();
        this._waits = new Map();
        this._laterId = 0;
        this._glanceBlocked = false;
        /** GNOME's SystemActions unless replaced (tests never power off) */
        this.systemActions = null;
    }

    /** @returns {Island|null} */
    get island() {
        return this._island ?? null;
    }

    /** @returns {object|null} GNOME's weather client, as the calendar has it */
    get weather() {
        return this._calendar?.weather ?? null;
    }

    /** @returns {GlancePage} a glance, e.g. for the weather in the bar */
    createGlance() {
        const glance = new GlancePage({events: this._calendar.events, weather: this._calendar.weather});
        glance.connect('power-request', () => this.togglePowerMenu());
        return glance;
    }

    /** @returns {boolean} whether the island is on screen to show pages */
    get available() {
        return Boolean(this._island?.visible && this._slot?.mapped);
    }

    /**
     * @returns {boolean} whether a notification has to wait: a page has the
     *   keyboard (switcher, power menu) or a toast is up
     */
    get occupied() {
        const island = this._island;
        return Boolean(island && (island.busy || island.page instanceof ToastPage));
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
        this._calendar = new CalendarBridge(this._slot, () => this._controlCentre());
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
        Main.wm.addKeybinding('atelier-power-menu', this._islandSettings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this.togglePowerMenu());

        // What it is made of and its shape follow the top bar's look.
        this._barSettings = this._settings.get_child('bar');
        this._barSettings.connectObject(
            'changed::surface', () => this._syncLook(),
            'changed::island-shape', () => this._syncLook(),
            this);
        this._syncLook();

        this._queueLayout();
    }

    disable() {
        Main.wm.removeKeybinding('atelier-power-menu');
        this._barSettings?.disconnectObject(this);
        this._barSettings = null;
        this._glass?.destroy();
        this._glass = null;
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        // Whoever waits for an announcement goes on without it.
        this._waits.forEach((resolve, id) => {
            GLib.source_remove(id);
            resolve(false);
        });
        this._waits.clear();
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;

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

    /**
     * Show a profile's name in the island, e.g. when switching to it. An open
     * switcher turns into the announcement.
     *
     * @param {object} profile
     * @param {object} [options]
     * @param {string} [options.subtitle]
     * @returns {Promise<boolean>} resolves once the announcement is open, or
     *   with false right away when there is none (turned off, other modal page)
     */
    announceProfile(profile, {subtitle = 'Profile'} = {}) {
        const island = this._island;
        if (!island?.visible || !this._slot.mapped || !this._islandSettings.get_boolean('profile-toast'))
            return Promise.resolve(false);
        if (island.busy && !(island.page instanceof SwitcherPage))
            return Promise.resolve(false);

        this._clearTimeout('show-glance');
        const scheme = profile.colorScheme ??
            new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('color-scheme');
        const toast = new ToastPage({
            title: profile.name,
            subtitle,
            wallpaper: effectiveWallpaper(profile, scheme),
        });
        if (!island.open(toast)) {
            toast.destroy();
            return Promise.resolve(false);
        }
        return this._wait(MORPH_TIME);
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
        const glance = this.createGlance();
        if (!island.open(glance))
            glance.destroy();
    }

    _onClicked(button) {
        this._glanceBlocked = true;
        this._clearTimeout('show-glance');
        if (button !== Clutter.BUTTON_PRIMARY)
            return;
        const controlCentre = this._controlCentre();
        if (controlCentre) {
            controlCentre.toggle('controls');
            return;
        }
        // Without the control centre, GNOME's calendar and notifications
        // open under the island.
        if (this._island.page)
            this._island.close();
        this._calendar.toggle();
    }

    /** @returns {ControlCentreModule|null} the control centre, if it opens in the island */
    _controlCentre() {
        const module = this._modules?.get('control-centre');
        return module?.available ? module : null;
    }

    _onPageClosed() {
        // Back at rest under the pointer: the glance may follow.
        if (!this._island.page && this._island.hover)
            this._onHover();
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
        // A notch hangs from the top edge, as tall as the bar.
        const notch = this._barSettings?.get_string('island-shape') === 'notch';
        const height = notch ? panelHeight : capsuleHeight(panelHeight, scale);
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

    _syncLook() {
        const island = this._island;
        const notch = this._barSettings.get_string('island-shape') === 'notch';
        const glass = this._barSettings.get_string('surface') === 'glass';
        if (notch)
            island.add_style_class_name('atelier-island-notch');
        else
            island.remove_style_class_name('atelier-island-notch');

        if (glass && !this._glass) {
            this._glass = new GlassSurface({reach: GLASS_REACH});
            Main.layoutManager.uiGroup.insert_child_below(this._glass, island);
            island.add_style_class_name('atelier-island-glass');
            island.connectObject(
                'notify::x', () => this._syncGlass(),
                'notify::y', () => this._syncGlass(),
                'notify::width', () => this._syncGlass(),
                'notify::height', () => this._syncGlass(),
                'notify::visible', () => this._syncGlass(),
                'notify::opacity', () => this._syncGlass(),
                'style-changed', () => this._syncGlass(),
                this._glass);
        } else if (!glass && this._glass) {
            island.disconnectObject(this._glass);
            island.remove_style_class_name('atelier-island-glass');
            this._glass.destroy();
            this._glass = null;
        }
        this._syncGlass();
        this._queueLayout(true);
    }

    // The glass under the island takes its shape, every frame it changes.
    _syncGlass() {
        const island = this._island;
        const glass = this._glass;
        if (!glass)
            return;
        glass.visible = island.visible && island.opacity > 0;
        const node = island.get_theme_node();
        glass.setShape(island.x, island.y, island.width, island.height,
            node.get_border_radius(St.Corner.TOPLEFT), node.get_border_radius(St.Corner.BOTTOMLEFT));
    }

    _setTimeout(name, delay, callback) {
        this._clearTimeout(name);
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timeouts.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    _wait(delay) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._waits.delete(id);
                resolve(true);
                return GLib.SOURCE_REMOVE;
            });
            this._waits.set(id, resolve);
        });
    }

    _clearTimeout(name) {
        const id = this._timeouts.get(name);
        if (id)
            GLib.source_remove(id);
        this._timeouts.delete(name);
    }
}
