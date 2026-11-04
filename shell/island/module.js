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

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {fullRect, morphRects} from '../../lib/moduleMorph.js';
import {effectiveWallpaper} from '../../lib/profiles.js';
import {COME_OUT_TIME, EAR_RADIUS, capsuleHeight} from '../core/barMetrics.js';
import {NotchEars} from '../core/ears.js';
import {GlassSurface} from '../core/glass.js';
import {GlassLook} from '../core/glassMaterial.js';
import {layersOf} from '../core/vibrancy.js';
import {switcherWidth} from '../switcherContent.js';
import {CalendarBridge} from './calendar.js';
import {GlancePage} from './glance.js';
import {IdleView} from './idle.js';
import {MicWatcher, UnseenWatcher} from './indicators.js';
import {Island, MORPH_TIME} from './island.js';
import {SwitcherPage} from './page.js';
import {POWER_ACTIONS, PowerPage} from './power.js';
import {LiquidSheet} from './sheet.js';
import {ToastPage} from './toast.js';

export const SLOT_ROLE = 'atelier-island';

const GLANCE_DELAY = 300;
const GLANCE_HIDE_DELAY = 250;
// How far down the screen the island may grow, for its glass.
const GLASS_REACH = 0.9;
// What a page open in the island covers, about (the glance), logical
// pixels: where its type has to read.
const PAGE_REGION = [400, 300];
// The corners of a module of the control centre that has none of its own
// (another tab's content), logical pixels: as its modules'.
const MODULE_RADIUS = 22;

// Whether a window shows anywhere in a rectangle of the stage (on the
// workspace shown).
export function windowsUnder({x, y, width, height}) {
    const workspace = global.workspace_manager.get_active_workspace();
    return global.get_window_actors().some(actor => {
        const window = actor.meta_window;
        if (!window || window.minimized || !window.showing_on_its_workspace() ||
            !window.located_on_workspace(workspace) || window.get_window_type() === Meta.WindowType.DESKTOP)
            return false;
        const frame = window.get_frame_rect();
        return frame.x < x + width && frame.x + frame.width > x && frame.y < y + height && frame.y + frame.height > y;
    });
}

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
        this._stopped = false;
        this._tucked = false;
        this._glanceBlocked = false;
        this._ear = 0;
        this._sheet = null;
        this._liquid = null;
        this._partner = null;
        this._vibrant = null;
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
        return new GlancePage({events: this._calendar.events, weather: this._calendar.weather});
    }

    /** @returns {boolean} whether the island is of glass (its type follows what is behind it) */
    get glassy() {
        return Boolean(this._glass);
    }

    /** @returns {boolean} whether the island is on screen to show pages */
    get available() {
        // (Not once the shell has taken its UI down as it quits.)
        return Boolean(!this._stopped && this._island?.visible && this._slot?.mapped);
    }

    /**
     * @returns {boolean} whether a notification has to wait: a page has the
     *   keyboard (switcher, power menu) or a toast is up
     */
    get occupied() {
        const island = this._stopped ? null : this._island;
        return Boolean(island && (island.busy || island.page instanceof ToastPage));
    }

    /**
     * Hidden (laid out all the same) until it comes out: while the lock
     * screen's padlock goes back up.
     */
    tuckAway() {
        if (!this._island)
            return;
        this._tucked = true;
        this._island.tucked = true;
        this._island.opacity = 0;
    }

    /** Out of the top edge (once the lock screen's padlock has gone). */
    comeOut() {
        const island = this._island;
        // (Not once the shell has taken its UI down as it quits.)
        if (!island || !this._tucked || this._stopped)
            return;
        this._tucked = false;
        island.tucked = false;
        island.translation_y = -Math.ceil(island.y + island.height);
        island.ease({
            translation_y: 0,
            opacity: 255,
            duration: COME_OUT_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
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
            'page-opened', () => this._raise(),
            'idle-resized', () => this._queueLayout(),
            this);
        this._slot.connectObject('notify::allocation', () => this._queueLayout(), this);
        Main.layoutManager.panelBox.connectObject('notify::allocation', () => this._queueLayout(), this);
        // (Its glass is of the wallpaper in the overview.)
        Main.overview.connectObject(
            'showing', () => this._syncShape(),
            'hidden', () => this._syncShape(),
            this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'changed', () => this._queueLayout(true),
            'notify::scale-factor', () => this._queueLayout(true),
            this);
        Main.wm.addKeybinding('atelier-power-menu', this._islandSettings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this.togglePowerMenu());

        // What it is made of and its shape follow the top bar's look (and
        // the glass's variant: off, it is black); its glass and the ears of
        // a notch follow it every frame it changes.
        this._barSettings = this._settings.get_child('bar');
        this._barSettings.connectObject(
            'changed::surface', () => this._syncLook(),
            'changed::island-shape', () => this._syncLook(),
            'changed::style', () => this._syncLook(),
            'changed::compact', () => this._syncLook(),
            this);
        this._glassLook = new GlassLook(this._settings);
        this._glassLook.connectObject('changed', () => this._syncLook(), this);
        this._island.connectObject(
            'notify::x', () => this._syncShape(),
            'notify::y', () => this._syncShape(),
            'notify::translation-y', () => this._syncShape(),
            'notify::width', () => this._syncShape(),
            'notify::height', () => this._syncShape(),
            'notify::visible', () => this._syncShape(),
            'notify::opacity', () => this._syncShape(),
            'style-changed', () => this._syncShape(),
            'page-opened', () => this._followModules(),
            'page-closed', () => this._followModules(),
            this);
        this._syncLook();

        Main.layoutManager.uiGroup.connectObject('destroy', () => this._stop(), this);
        this._queueLayout();
    }

    disable() {
        Main.wm.removeKeybinding('atelier-power-menu');
        this._barSettings?.disconnectObject(this);
        this._barSettings = null;
        this._glassLook?.disconnectObject(this);
        this._glassLook?.destroy();
        this._glassLook = null;
        this._dropVibrancy();
        this._sheet?.destroy();
        this._sheet = null;
        this._liquid?.destroy();
        this._liquid = null;
        this._glass?.destroy();
        this._glass = null;
        this._ears?.destroy();
        this._ears = null;
        this._dropMorph();
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
        Main.overview.disconnectObject(this);
        Main.layoutManager.uiGroup.disconnectObject(this);
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

    /**
     * Open a sheet that drips from the island and spreads into a panel of
     * the island's glass (or black), with a form on it.
     *
     * @param {St.Widget} form
     * @returns {LiquidSheet|null} the sheet (close() takes it back into the
     *   island); null when there is no island to drip from
     */
    openSheet(form) {
        const island = this._island;
        if (this._sheet || !island?.visible || !this._slot.mapped)
            return null;
        // The drop is of the island's stuff, and the island is drawn along
        // with it, so they flow into each other.
        const glass = this._glassy();
        // (The same glass as all of it.)
        this._liquid = new GlassSurface({solid: !glass, look: this._glassLook.look, light: this._glassLook.light,
            yields: true});
        this._liquid.setPartner(this._partner);
        Main.layoutManager.uiGroup.insert_child_below(this._liquid, island);
        const sheet = new LiquidSheet(island, this._liquid, form);
        Main.layoutManager.uiGroup.insert_child_above(sheet, this._liquid);
        this._sheet = sheet;
        sheet.connect('closed', () => this._dropSheet());
        this._clearTimeout('show-glance');
        this._syncShape();
        sheet.open();
        return sheet;
    }

    _dropSheet() {
        this._sheet?.destroy();
        this._sheet = null;
        this._liquid?.destroy();
        this._liquid = null;
        if (this._island)
            this._syncShape();
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

    // Opening, over all other chrome, with what is drawn along with it (its
    // glass, ears, a sheet's liquid) in the same order: chrome another
    // extension added later (Tiling Shell's layout editor over the whole
    // screen, say) would cover what opens.
    _raise() {
        const group = Main.layoutManager.uiGroup;
        const top = global.top_window_group;
        if (top?.get_parent() !== group)
            return;
        const children = group.get_children();
        const ours = [this._glass, this._liquid, this._sheet, ...this._ears?.actors ?? [], this._island]
            .filter(actor => actor?.get_parent() === group)
            .sort((a, b) => children.indexOf(a) - children.indexOf(b));
        // (Already there, right under the top windows: left as it is –
        // restacked, all of it is drawn again, a frame of its own.)
        const at = children.indexOf(top);
        if (ours.every((actor, i) => children[at - ours.length + i] === actor))
            return;
        ours.forEach(actor => group.set_child_below_sibling(actor, top));
    }

    /**
     * Close the open page at once, unseen: something is about to take a
     * picture of the screen (Color Picker, to pick from). It is back at
     * rest a moment later.
     */
    closeUnseen() {
        const island = this._island;
        if (!island?.page)
            return;
        island.remove_transition('opacity');
        island.opacity = 0;
        this._syncShape();
        island.close();
        this._setTimeout('unseen', MORPH_TIME, () => {
            island.opacity = 255;
            this._syncShape();
        });
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
        if (this._laterId || this._stopped)
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
        // (Where it rests may have moved: its type follows.)
        this._vibrant?.all.forEach(surface => surface.update());
    }

    // Of glass, as the top bar has it – unless the glass is off.
    _glassy() {
        return this._barSettings.get_string('surface') === 'glass' && this._glassLook.glass;
    }

    /**
     * The shape of the glass the island lies in, which its own glass is one
     * with (the bar's one island), as GlassSurface.setPartner() takes it.
     *
     * @param {number[]|null} shape - on the stage, null for none
     */
    setGlassPartner(shape) {
        if (JSON.stringify(shape) === JSON.stringify(this._partner))
            return;
        // (One glass with it or not: its type with it or not.)
        const joined = Boolean(shape) !== Boolean(this._partner);
        this._partner = shape;
        this._glass?.setPartner(shape);
        this._liquid?.setPartner(shape);
        if (joined)
            this._vibrant?.rest.update();
    }

    /**
     * @returns {number[]|null} the island's shape on the stage, as its glass
     *   has it ([x, y, width, height, radius, bottomRadius, ear]); null
     *   while it isn't shown
     */
    get glassShape() {
        const island = this._island;
        if (this._stopped || !island?.visible || island.opacity === 0)
            return null;
        // (Open as the control centre, the first of its modules: the tabs.)
        if (this._glass && this._moduleShape)
            return this._moduleShape;
        return this._islandShape();
    }

    // The island's shape on the stage as it is now: [x, y, width, height,
    // radius, bottomRadius, ear].
    _islandShape() {
        const island = this._island;
        const ear = this._ear * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const node = island.get_theme_node();
        // (Moved by its translation as it comes out.)
        return [island.x, island.y + island.translation_y, island.width, island.height,
            node.get_border_radius(St.Corner.TOPLEFT), node.get_border_radius(St.Corner.BOTTOMLEFT), ear];
    }

    _syncLook() {
        const island = this._island;
        const notch = this._barSettings.get_string('island-shape') === 'notch';
        const glass = this._glassy();
        const style = this._barSettings.get_string('style');
        // A notch curves into the top edge – unless it is part of one island
        // with the whole bar, whose shape has the ears then.
        this._ear = notch && style !== 'island' ? EAR_RADIUS : 0;
        // A compact bar has just the time in the middle.
        this._idle.setCompact(this._barSettings.get_boolean('compact') && ['grouped', 'island'].includes(style));
        if (notch)
            island.add_style_class_name('atelier-island-notch');
        else
            island.remove_style_class_name('atelier-island-notch');

        if (glass && !this._glass) {
            this._glass = new GlassSurface({reach: GLASS_REACH, look: this._glassLook.look, light: this._glassLook.light,
                yields: true});
            this._glass.setPartner(this._partner);
            Main.layoutManager.uiGroup.insert_child_below(this._glass, island);
            island.add_style_class_name('atelier-island-glass');
        } else if (!glass && this._glass) {
            island.remove_style_class_name('atelier-island-glass');
            this._glass.destroy();
            this._glass = null;
        }
        // (Regular or clear, light or smoky.)
        this._glass?.setLook(this._glassLook.look, this._glassLook.light);
        if (glass)
            this._liquid?.setLook(this._glassLook.look, this._glassLook.light);
        this._syncVibrancy();
        // Black ears; glass draws its own.
        const ears = this._ear > 0 && !glass;
        if (ears && !this._ears) {
            this._ears = new NotchEars(island);
        } else if (!ears && this._ears) {
            this._ears.destroy();
            this._ears = null;
        }
        this._syncShape();
        this._queueLayout(true);
    }

    // The glass under the island and the ears take its shape, and so does
    // the liquid of a sheet dripping from it.
    _syncShape() {
        const island = this._island;
        if (this._stopped || (!this._glass && !this._ears && !this._liquid))
            return;
        const shown = island.visible && island.opacity > 0;
        const shape = this._islandShape();
        const [, y, , , , , ear] = shape;
        // Grown out over the windows, its glass is live: of them too, not
        // just of the wallpaper (which the overview shows, though).
        const live = !Main.overview.visible;
        if (this._glass) {
            // (Under a sheet, its liquid is the island's glass too.)
            this._glass.visible = shown && !this._liquid;
            // Open as the control centre, a piece of glass for each of its
            // modules, nothing between them.
            const modules = this._liquid ? null : this._syncModules(shape);
            this._moduleShape = modules?.[0].slice(0, 7) ?? null;
            if (modules) {
                this._glass.setModules(modules.slice(1).map(([x, y, w, h, radius, , , small]) =>
                    [x, y, w, h, radius, small]), modules[0][7]);
                this._glass.setShape(...modules[0].slice(0, 7));
            } else {
                this._glass.setModules(null);
                this._glass.setShape(...shape);
            }
            this._glass.setLive(live && island.has_style_pseudo_class('expanded'));
            // Under GNOME's controls (the control centre, a tile's menu open
            // in it), frosted: the windows' type behind them is a soft wash
            // there, no second line of type under theirs – the same glass,
            // darkened as every other (lib/glassLook.js FROST).
            this._glass.setFrost(island.page?.has_style_class_name('atelier-cc') ?? false);
        }
        if (this._liquid) {
            this._liquid.visible = shown;
            this._liquid.setShape(...shape);
            this._liquid.setLive(live);
        }
        if (this._ears) {
            this._ears.show(shown, island.opacity);
            this._ears.setShape(island.x, y, island.width, ear);
        }
    }

    // The control centre's page opened, or it closed: its modules followed
    // as they move, come and go. (They say so as the page is laid out:
    // their glass follows before the next frame is drawn, not then.)
    _followModules() {
        const page = this._island?.page;
        const cc = page && typeof page.moduleRects === 'function' ? page : null;
        if (cc !== this._modulesPage) {
            this._modulesPage?.disconnectObject(this);
            this._modulesPage = cc;
            cc?.connectObject('modules-changed', () => this._queueModules(), 'destroy', () => {
                if (this._modulesPage === cc)
                    this._modulesPage = null;
            }, this);
        }
        this._syncShape();
    }

    _queueModules() {
        if (this._modulesLater || this._stopped)
            return;
        this._modulesLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._modulesLater = 0;
            if (!this._stopped && this._island)
                this._syncShape();
            return GLib.SOURCE_REMOVE;
        });
    }

    _dropMorph() {
        if (this._modulesLater)
            global.compositor.get_laters().remove(this._modulesLater);
        this._modulesLater = 0;
        this._modulesPage?.disconnectObject(this);
        this._modulesPage = null;
        this._morph?.timeline.stop();
        this._morph = null;
        this._moduleShape = null;
    }

    // Where the control centre's modules are on the stage, as rects
    // (lib/moduleMorph.js), and a key of where they are in the page (the
    // same as the island moves); null while it isn't open, no rects while
    // they aren't laid out yet.
    _moduleTargets() {
        const page = this._island.page;
        if (!page || page !== this._modulesPage)
            return null;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const box = page.get_allocation_box();
        const x = this._island.x + box.x1 + page.translation_x;
        const y = this._island.y + this._island.translation_y + box.y1 + page.translation_y;
        const shown = page.moduleRects().filter(r => r.width > 0 && r.height > 0);
        const rects = shown.map(r => fullRect({id: r.id, x: x + r.x, y: y + r.y, width: r.width, height: r.height,
            radius: r.radius > 0 ? r.radius : MODULE_RADIUS * scale}));
        // (Others in the page, not the page elsewhere: as the island moves,
        // they go with it.)
        const key = shown.map(r => [r.id, r.x, r.y, r.width, r.height, r.radius].map(v =>
            (typeof v === 'number' ? Math.round(v * 100) : v)).join(' ')).join(';');
        return {rects, key};
    }

    /**
     * The island's glass while it is (or was, a moment ago) the control
     * centre: each module a piece of its own, from the capsule as it
     * opens, back into it as it closes, from one set to the other as a
     * detail's page opens and closes, or another tab shows – eased as the
     * island grows and shrinks (MORPH_TIME, easeOutExpo).
     *
     * @param {number[]} shape - the island's own, as _islandShape() has it
     * @returns {number[][]|null} what to draw, [x, y, width, height, radius,
     *   bottomRadius, ear, small] each, the first with the ears (its shape,
     *   the others its modules); null for the island's shape only
     */
    _syncModules(shape) {
        // (The capsule a small control: its lighter face.)
        const rectOf = ([x, y, width, height, radius, bottomRadius, ear], id = 'island') =>
            fullRect({id, x, y, width, height, radius, bottomRadius, ear, small: 1});
        const open = this._moduleTargets();
        let targets = open?.rects;
        let key = open?.key;
        const morph = this._morph;
        if (!targets) {
            if (!morph) {
                // (At rest: the capsule's corners, for its way back to it.)
                if (!this._island.has_style_pseudo_class('expanded'))
                    this._restShape = shape;
                return null;
            }
            // Closed: back into the capsule (or into another page's shape).
            const rest = this._island.restRect();
            const [, , , , radius, bottomRadius, ear] = this._restShape ?? shape;
            targets = [this._island.page || !rest ? rectOf(shape)
                : rectOf([rest[0], rest[1] + this._island.translation_y, rest[2], rest[3], radius, bottomRadius, ear])];
            key = 'closed';
        } else if (targets.length === 0) {
            // (Not laid out yet: as it was until they are.)
            targets = morph?.to ?? [rectOf(shape)];
            key = morph?.key ?? 'unplaced';
        }
        if (!morph || key !== morph.key) {
            const from = morph?.shown ?? [rectOf(shape)];
            morph?.timeline.stop();
            const duration = adjustAnimationTime(MORPH_TIME);
            const timeline = new Clutter.Timeline({actor: this._island, duration: Math.max(1, duration),
                progress_mode: Clutter.AnimationMode.EASE_OUT_EXPO});
            const next = {from, to: targets, key, shown: from, timeline, closing: !open, done: duration <= 0};
            timeline.connect('new-frame', () => this._syncShape());
            // (Its time back at 0 once it is over.)
            timeline.connect('completed', () => {
                next.done = true;
                this._syncShape();
            });
            this._morph = next;
            if (!next.done)
                timeline.start();
        }
        const current = this._morph;
        current.to = targets;
        const t = current.done ? 1 : current.timeline.get_progress();
        current.shown = morphRects(current.from, current.to, t);
        if (t >= 1 && current.closing) {
            this._morph = null;
            return null;
        }
        if (current.shown.length === 0)
            return null;
        return current.shown.map(r => [r.x, r.y, r.width, r.height, r.radius, r.bottomRadius, r.ear, r.small]);
    }

    // Of glass, its type and icons follow what is behind the glass
    // (shell/core/vibrancy.js): at rest, the wallpaper round its place in
    // the bar; open, the wallpaper under the page – or windows: its glass
    // is live then, and what they show isn't read back from the screen;
    // they are taken to be the palette's surface, in the style apps are in.
    // (The control centre's modules each follow what is behind them:
    // shell/controlCentre/ink.js. A sheet's form is styled for a dark
    // surface only: its light type stays as it is.)
    _syncVibrancy() {
        const vibrancy = this._glass ? this._modules?.get('vibrancy') : null;
        if (!vibrancy) {
            this._dropVibrancy();
            return;
        }
        if (this._vibrant) {
            this._vibrant.all.forEach(surface => surface.update());
            return;
        }
        const glass = {
            roots: ['.atelier-island'],
            layers: () => layersOf(this._island),
        };
        const rest = () => {
            const rect = this._island?.restRect();
            return rect ? {x: rect[0], y: rect[1], width: rect[2], height: rect[3]} : null;
        };
        const surfaces = {
            // (At rest in the bar's one island, one glass with it.)
            rest: vibrancy.surface({...glass, id: 'island', inks: 'island', rect: rest,
                oneWith: () => (this._partner ? 'bar' : null)}),
            open: vibrancy.surface({...glass, id: 'island-pages', inks: 'pages', rect: () => this._pageRegion()}),
            windows: vibrancy.surface({...glass, id: 'island-windows', inks: 'pages',
                behind: () => vibrancy.windowSurface()}),
        };
        this._vibrant = {...surfaces, all: Object.values(surfaces)};
        this._island.add_style_class_name(this._vibrant.rest.scope);
        // Opened, as what is behind the page has it (not every frame it grows).
        this._island.connectObject('page-opened', () => this._syncPageInk(), this._vibrant);
        Main.overview.connectObject(
            'showing', () => this._syncPageInk(),
            'hidden', () => this._syncPageInk(),
            this._vibrant);
        this._syncPageInk();
    }

    // Where a page opens, about: under the island at rest, as wide and as
    // tall as the glance.
    _pageRegion() {
        const rect = this._island?.restRect();
        if (!rect)
            return null;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [width, height] = PAGE_REGION.map(v => v * scale);
        return {x: Math.round(rect[0] + rect[2] / 2 - width / 2), y: rect[1], width, height};
    }

    // The page open is over windows (live glass) or over the wallpaper:
    // its type as it reads on either. (The overview's glass is of the
    // wallpaper.)
    _syncPageInk() {
        const island = this._island;
        const vibrant = this._vibrant;
        // (Not once the shell has taken its UI down as it quits.)
        if (!vibrant || !island || this._stopped)
            return;
        const page = island.page;
        let overWindows = false;
        if (page && !Main.overview.visible) {
            const [, width] = page.get_preferred_width(-1);
            const [, height] = page.get_preferred_height(width);
            const rect = island.restRect();
            overWindows = rect !== null && Number.isFinite(width + height) && windowsUnder({
                x: rect[0] + rect[2] / 2 - width / 2, y: rect[1], width, height,
            });
        }
        const [on, off] = overWindows ? [vibrant.windows, vibrant.open] : [vibrant.open, vibrant.windows];
        island.remove_style_class_name(off.scope);
        island.add_style_class_name(on.scope);
    }

    _dropVibrancy() {
        const vibrant = this._vibrant;
        if (!vibrant)
            return;
        this._vibrant = null;
        this._island?.disconnectObject(vibrant);
        Main.overview.disconnectObject(vibrant);
        for (const surface of vibrant.all) {
            this._island?.remove_style_class_name(surface.scope);
            surface.destroy();
        }
    }

    _setTimeout(name, delay, callback) {
        this._clearTimeout(name);
        if (this._stopped)
            return;
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

    // When the shell quits, GNOME takes its UI down with uiGroup while JS
    // still runs, then turns the main loop a while longer: what waits for a
    // frame or a timeout would touch actors that are gone (and GJS says so
    // in the journal). The waits for announcements touch nothing; they run
    // out as usual.
    _stop() {
        this._stopped = true;
        this._dropMorph();
        this._timeouts.forEach(id => GLib.source_remove(id));
        this._timeouts.clear();
        if (this._laterId)
            global.compositor.get_laters().remove(this._laterId);
        this._laterId = 0;
    }
}
