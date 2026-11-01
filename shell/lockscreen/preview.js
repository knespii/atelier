// Editing the lock screen's widgets, in the session: the real lock screen
// can't be edited (it is locked). The preferences ask for it (lockscreen's
// edit-request); the screen then shows a mock lock screen – the wallpaper,
// sharp as the lock screen shows it until the password is asked, and
// GNOME's clock where it sits (when it shows) – and the desktop's editor
// over the lock screen's widgets (with the depth effect, the wallpaper's
// subject over the clocks as there, dimmed with the wallpaper under it).
// With a cutout there, a button in the corner shows the depth mask: what
// stands in front tinted, the rest dimmed, over everything while the
// widgets are still moved under it – the cutout already loaded, in one
// colour (depth.js maskActor()). Done (or Escape) and it goes.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {DesktopEditor} from '../desktop/editor.js';
import {LockBoard} from './board.js';
import {MASK_DIM} from './depth.js';
import {GlassLook} from '../core/glassMaterial.js';
import {GlassWarmUp} from './clock.js';
import {warmUpLockGlass} from './popupGlass.js';

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

        this._board = new LockBoard(lockSettings,
            {interactive: true, palette: settings.get_child('palette'), atelier: settings});
        this._board.setHome(this.actor);

        this.actor.ease({opacity: 255, duration: FADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this._editor = new DesktopEditor(this._board);
        this._board.editor = this._editor;
        this._board.onStopEditing = () => this.close();
        // What the depth effect is doing, while it is on: being made, or
        // off where the clocks are (and why), at the top of the screen.
        this._note = new St.Label({style_class: 'atelier-lock-depth-note', visible: false});
        this._editor.actor.add_child(this._note);
        this._note.connect('notify::width', () => this._note.set_position(
            Math.round(monitor.x + (monitor.width - this._note.width) / 2),
            Math.round(monitor.y + 24 * St.ThemeContext.get_for_stage(global.stage).scale_factor)));
        const showNote = note => {
            this._note.text = note;
            this._note.visible = Boolean(note);
        };
        this._board.onDepthNote = note => this._note && showNote(note);
        showNote(this._board.depthNote);

        // The depth mask, to look at: shown while the button is down.
        this._monitor = monitor;
        this._mask = null;
        this.maskButton = new St.Button({
            style_class: 'atelier-lock-depth-mask-button', label: 'Show the Depth Mask',
            toggle_mode: true, can_focus: true, visible: false,
        });
        this.maskButton.connect('notify::checked', () => this._syncMask());
        this._editor.actor.add_child(this.maskButton);
        this.maskButton.connect('notify::width', () => this.maskButton.set_position(
            Math.round(monitor.x + monitor.width - this.maskButton.width - 24 * this._scale),
            Math.round(monitor.y + 24 * this._scale)));
        this._board.onDepthChanged = () => this._syncMask();
        this._syncMask();
    }

    get _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    /** @returns {Clutter.Actor|null} the depth mask while it shows: the screen dimmed, the cutout tinted over it */
    get mask() {
        return this._mask;
    }

    // The button while there is a cutout; the mask while it is down, laid
    // anew as the cutout comes, goes or moves (another wallpaper, its own
    // place on the monitor).
    _syncMask() {
        if (!this._editor)
            return;
        const depth = this._board.depth;
        this.maskButton.visible = Boolean(depth?.loaded);
        if (!this.maskButton.visible && this.maskButton.checked) {
            this.maskButton.checked = false;
            return;
        }
        this.maskButton.label = this.maskButton.checked ? 'Hide the Depth Mask' : 'Show the Depth Mask';
        this._mask?.destroy();
        this._mask = null;
        const tinted = this.maskButton.checked ? depth?.maskActor() : null;
        if (!tinted)
            return;
        const {x, y, width, height} = this._monitor;
        this._mask = new St.Widget({style_class: 'atelier-lock-depth-mask', x, y, width, height,
            clip_to_allocation: true, reactive: false});
        this._mask.add_child(new St.Widget({width, height, reactive: false,
            style: `background-color: rgba(0, 0, 0, ${MASK_DIM});`}));
        this._mask.add_child(tinted);
        // (Over the widgets, which are still moved under it; under the
        // gallery, the note and the button.)
        this._editor.actor.insert_child_above(this._mask, this._board.layer);
    }

    /** @returns {string} the note on the depth effect shown ('' for none) */
    get depthNote() {
        return this._note?.visible ? this._note.text : '';
    }

    close() {
        if (!this._editor)
            return;
        this._mask?.destroy();
        this._mask = null;
        this._board.onDepthChanged = null;
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
        this._board.editor = null;
        this._board.onDepthNote = null;
        this._board.onDepthChanged = null;
        this._mask?.destroy();
        this._mask = null;
        this._note = null;
        this._editor?.destroy();
        this._editor = null;
        this._board.destroy();
        this._background.destroy();
        this.actor.destroy();
        this.actor = null;
        this._onClosed();
    }
}

/**
 * A module of the session: opens the preview when the preferences ask, and
 * readies what the lock screen's glass clocks take to draw while the
 * session is idle (clock.js GlassWarmUp).
 */
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
        this._warmUp = new GlassWarmUp(this._lockSettings, this._settings);
        // (The island's glass and the popup's, drawn once ahead of the lock
        // screen: see warmUpLockGlass().)
        if (this._lockSettings.get_boolean('enabled') && this._lockSettings.get_boolean('island')) {
            const glassLook = new GlassLook(this._settings);
            warmUpLockGlass(glassLook.look, glassLook.light);
            glassLook.destroy();
        }
    }

    /** Edit the lock screen's widgets. */
    open() {
        if (this.preview || !Main.layoutManager.primaryMonitor)
            return;
        Main.overview.hide();
        this.preview = new LockPreview(this._settings, () => (this.preview = null));
    }

    disable() {
        this._warmUp?.destroy();
        this._warmUp = null;
        this._lockSettings?.disconnectObject(this);
        this._lockSettings = null;
        this.preview?.destroy();
        this.preview = null;
    }
}
