// Windows as liquid (lib/windowLiquid.js): a window opened from the dock
// comes out of its app's icon – a drop swells there, lets go, flies to the
// window and spreads into it; opened otherwise (the overview's search, the
// app grid, another app), it spreads out of a drop in its middle; closing,
// it draws into its middle and is gone. Dialogs and other windows keep
// GNOME's own animations.
//
// GNOME's window manager animates a window when it says it should
// (_shouldAnimateActor): for the windows taken over here it says no, so
// GNOME shows (or removes) them at once, and the liquid does the rest –
// seen through a mask on a window that opens, and on a picture of one that
// closes (taken just before it goes).

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    dropFromDock, windowClosing, windowFromDock, windowFromMiddle,
} from '../../lib/windowLiquid.js';
import {takeLaunch} from '../core/launchOrigins.js';
import {LiquidMaskEffect, LiquidPaint} from '../core/liquid.js';

// Milliseconds: out of the dock, out of the middle, closing.
const FROM_DOCK_TIME = 720;
const FROM_MIDDLE_TIME = 380;
const CLOSING_TIME = 300;
// Logical pixels: the drop, how near the liquid melts, a window's corners.
const DROP = 14;
const BLEND = 16;
const RADIUS = 12;
// The drop's look: the dock's dark, a soft shadow under it.
const DROP_COLOR = [18 / 255, 18 / 255, 22 / 255, 0.92];
const DROP_SHADOW = [0, 0, 0, 0.3];
const DROP_SHADOW_SHAPE = [0, 6, 16];
// Waiting for the overview to go before a window opens, at most, ms.
const OVERVIEW_WAIT = 1500;

const rectOf = r => ({x: r.x, y: r.y, width: r.width, height: r.height});

export class WindowAnimationsModule {
    constructor() {
        this._running = new Set(); // what plays: {stop()}
    }

    enable() {
        this._injections = new InjectionManager();
        const module = this;
        // The windows taken over: GNOME shows or removes them at once.
        this._injections.overrideMethod(Main.wm, '_shouldAnimateActor', original => function (actor, types) {
            const animate = original.call(this, actor, types);
            return module._takeOver(actor, animate) ? false : animate;
        });
        global.display.connectObject('window-created', (_, window) => this._watch(window, true), this);
        global.window_manager.connectObject('map', (_, actor) => this._onMapped(actor), this);
        for (const actor of global.get_window_actors())
            this._watch(actor.meta_window, false);
    }

    disable() {
        this._injections?.clear();
        this._injections = null;
        global.display.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        for (const actor of global.get_window_actors())
            actor.meta_window?.disconnectObject(this);
        [...this._running].forEach(animation => animation.stop());
        this._running.clear();
    }

    // A window of the kind taken over: opening (as it comes) and closing
    // (a picture of it taken just before).
    _watch(window, opening) {
        if (!window || window.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        if (opening)
            window._atelierOpening = true;
        window.connectObject('unmanaging', () => this._onClosing(window), this);
    }

    // Says whether the liquid animates this window (GNOME then doesn't).
    _takeOver(actor, animate) {
        const window = actor.meta_window;
        if (!window || window.get_window_type() !== Meta.WindowType.NORMAL)
            return false;
        if (window._atelierOpening) {
            window._atelierOpening = false;
            actor._atelierOpen = animate;
            return animate;
        }
        if (window._atelierClosing) {
            // (Not to be animated after all: the picture goes too.)
            if (!animate)
                window._atelierClosing.stop();
            return animate;
        }
        return false;
    }

    _onMapped(actor) {
        if (!actor._atelierOpen)
            return;
        actor._atelierOpen = false;
        const window = actor.meta_window;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const launch = takeLaunch(app?.get_id() ?? null);
        this._open(actor, launch);
    }

    // Plays a timeline over a duration, frame by frame: step(t), then done().
    _play(actor, duration, step, done) {
        const timeline = new Clutter.Timeline({actor, duration: Math.max(1, adjustAnimationTime(duration))});
        const animation = {
            stop: () => {
                if (!this._running.delete(animation))
                    return;
                timeline.stop();
                done();
            },
        };
        timeline.connect('new-frame', () => step(timeline.get_progress()));
        timeline.connect('completed', () => animation.stop());
        this._running.add(animation);
        step(0);
        timeline.start();
        return animation;
    }

    // Out of the dock's icon (launch: {rect, side}), or out of the middle.
    _open(actor, launch) {
        const window = actor.meta_window;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const mask = new LiquidMaskEffect();
        actor.add_effect_with_name('atelier-window-liquid', mask);
        let overlay = null;
        if (launch) {
            overlay = new LiquidPaint();
            overlay.setColors(DROP_COLOR, DROP_SHADOW, DROP_SHADOW_SHAPE);
            overlay.set_size(global.stage.width, global.stage.height);
            Main.layoutManager.uiGroup.insert_child_above(overlay, global.window_group);
        }
        const frame = () => rectOf(window.get_frame_rect());
        const bounds = () => ({x: actor.x, y: actor.y, width: actor.width, height: actor.height});
        const look = {drop: DROP * scale, blend: BLEND * scale, radius: RADIUS * scale};
        const step = t => {
            if (launch) {
                const params = {icon: launch.rect, side: launch.side, frame: frame(), actor: bounds(), ...look};
                overlay.setShapes(dropFromDock(params, t));
                mask.setShapes(windowFromDock(params, t));
            } else {
                mask.setShapes(windowFromMiddle(frame(), bounds(), look.radius, t));
            }
        };
        let animation = null;
        const done = () => {
            actor.disconnectObject(this);
            Main.overview.disconnectObject(this);
            if (actor.get_effect('atelier-window-liquid'))
                actor.remove_effect(mask);
            overlay?.destroy();
            overlay = null;
        };
        // Gone before it is done: so is the rest.
        actor.connectObject('destroy', () => animation?.stop(), this);
        const start = () => {
            animation = this._play(actor, launch ? FROM_DOCK_TIME : FROM_MIDDLE_TIME, step, done);
        };
        // (Out of sight until the overview has gone, as GNOME has it.)
        if (Main.overview.visible) {
            mask.setShapes({});
            const pending = {stop: () => {
                this._running.delete(pending);
                done();
            }};
            this._running.add(pending);
            const go = () => {
                if (!this._running.delete(pending))
                    return;
                Main.overview.disconnectObject(this);
                start();
            };
            Main.overview.connectObject('hidden', go, this);
            actor.connectObject('destroy', () => pending.stop(), this);
            setTimeout(go, OVERVIEW_WAIT);
            return;
        }
        start();
    }

    // A picture of the window as it was, drawing into its middle.
    _onClosing(window) {
        window.disconnectObject(this);
        const actor = window.get_compositor_private();
        if (!actor || !actor.visible || window.minimized || !St.Settings.get().enable_animations ||
            Main.overview.visible || !window.showing_on_its_workspace())
            return;
        let content;
        try {
            content = actor.paint_to_content(null);
        } catch {
            return;
        }
        if (!content)
            return;
        const buffer = window.get_buffer_rect();
        const picture = new Clutter.Actor({content, x: buffer.x, y: buffer.y, width: buffer.width, height: buffer.height});
        Shell.util_set_hidden_from_pick(picture, true);
        global.window_group.insert_child_above(picture, actor);
        const mask = new LiquidMaskEffect();
        picture.add_effect_with_name('atelier-window-liquid', mask);
        const frame = window.get_frame_rect();
        const local = {x: frame.x - buffer.x, y: frame.y - buffer.y, width: frame.width, height: frame.height};
        const radius = RADIUS * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        window._atelierClosing = this._play(picture, CLOSING_TIME,
            t => mask.setShapes(windowClosing(local, radius, t)),
            () => picture.destroy());
    }
}
