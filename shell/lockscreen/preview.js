// Editing the lock screen's widgets, in the session: the real lock screen
// can't be edited (it is locked). The preferences ask for it (lockscreen's
// edit-request); the screen then shows a mock lock screen – the wallpaper
// blurred as GNOME blurs it and GNOME's clock where it sits (when it
// shows) – and the desktop's editor over the lock screen's widgets. Done
// (or Escape) and it goes.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DesktopEditor} from '../desktop/editor.js';
import {LockBoard} from './board.js';

// As GNOME's lock screen (ui/unlockDialog.js).
const BLUR_BRIGHTNESS = 0.65;
const BLUR_RADIUS = 90;
const FADE_TIME = 300;

class LockPreview {
    /**
     * @param {Gio.Settings} settings - Atelier's
     * @param {Function} onClosed - called once it is gone
     */
    constructor(settings, onClosed) {
        this._onClosed = onClosed;
        const lockSettings = settings.get_child('lockscreen');
        const monitor = Main.layoutManager.primaryMonitor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        this.actor = new St.Widget({
            style_class: 'atelier-lock-preview',
            reactive: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            opacity: 0,
        });
        Main.layoutManager.addTopChrome(this.actor);
        const background = new Clutter.Actor({width: monitor.width, height: monitor.height});
        this.actor.add_child(background);
        this._background = new Background.BackgroundManager({
            container: background,
            monitorIndex: Main.layoutManager.primaryIndex,
            controlPosition: false,
        });
        this._background.backgroundActor.add_effect(new Shell.BlurEffect({
            brightness: BLUR_BRIGHTNESS,
            radius: BLUR_RADIUS * scale,
            mode: Shell.BlurMode.ACTOR,
        }));

        // GNOME's clock, where GNOME puts it (a third of the way down).
        if (lockSettings.get_boolean('gnome-clock')) {
            const clock = new St.BoxLayout({style_class: 'unlock-dialog-clock', orientation: Clutter.Orientation.VERTICAL});
            const wallClock = new GnomeDesktop.WallClock({time_only: true});
            clock.add_child(new St.Label({style_class: 'unlock-dialog-clock-time', text: wallClock.clock,
                x_align: Clutter.ActorAlign.CENTER}));
            clock.add_child(new St.Label({style_class: 'unlock-dialog-clock-date',
                text: GLib.DateTime.new_now_local().format('%A %B %-d'), x_align: Clutter.ActorAlign.CENTER}));
            wallClock.run_dispose();
            this.actor.add_child(clock);
            clock.connect('notify::width', () => clock.set_position(
                Math.round((monitor.width - clock.width) / 2), Math.round(monitor.height / 3)));
        }

        this._board = new LockBoard(lockSettings, {interactive: true});
        this._board.setHome(this.actor);

        this.actor.ease({opacity: 255, duration: FADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._editor = new DesktopEditor(this._board);
        this._board.editor = this._editor;
        this._board.onStopEditing = () => this.close();
    }

    close() {
        if (!this._editor)
            return;
        const editor = this._editor;
        this._editor = null;
        this._board.editor = null;
        editor.close();
        this.actor.ease({
            opacity: 0,
            duration: FADE_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    destroy() {
        if (!this.actor)
            return;
        this._editor?.destroy();
        this._editor = null;
        this._board.destroy();
        this._background.destroy();
        this.actor.destroy();
        this.actor = null;
        this._onClosed();
    }
}

/** A module of the session: opens the preview when the preferences ask. */
export class LockPreviewModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     */
    constructor({settings}) {
        this._settings = settings;
        this.preview = null;
    }

    enable() {
        this._lockSettings = this._settings.get_child('lockscreen');
        this._lockSettings.connectObject('changed::edit-request', () => this.open(), this);
    }

    /** Edit the lock screen's widgets. */
    open() {
        if (this.preview || !Main.layoutManager.primaryMonitor)
            return;
        Main.overview.hide();
        this.preview = new LockPreview(this._settings, () => (this.preview = null));
    }

    disable() {
        this._lockSettings?.disconnectObject(this);
        this._lockSettings = null;
        this.preview?.destroy();
        this.preview = null;
    }
}
