// One set of window signals for all the docks: windows coming and going,
// moving, stacking, focus, the workspace. It says 'stacking-changed' at
// once when the apps with windows may have changed (the docks lay out
// their rows before the next frame), and 'changed' a moment after
// anything about the windows changed, however often it did in between
// (the docks check whether windows cover them).

import Shell from 'gi://Shell';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {Timers} from './timers.js';

const DEBOUNCE = 100; // milliseconds

export class WindowWatcher extends EventEmitter {
    constructor() {
        super();
        this._timers = new Timers();
        this._actors = new Set();

        const stacking = () => {
            this.emit('stacking-changed');
            this.queueChanged();
        };
        global.workspace_manager.connectObject('active-workspace-changed', stacking, this);
        global.display.connectObject(
            'restacked', stacking,
            'window-entered-monitor', stacking,
            'window-left-monitor', stacking,
            'window-demands-attention', stacking,
            'window-marked-urgent', stacking,
            'window-created', (_, window) => this._watch(window),
            'notify::focus-window', () => this.queueChanged(),
            this);
        Shell.WindowTracker.get_default().connectObject('notify::focus-app', () => this.queueChanged(), this);
        global.get_window_actors().forEach(actor => this._watch(actor.meta_window));
    }

    /** Say 'changed' in a moment (once, however often this is called until then). */
    queueChanged() {
        this._timers.after('changed', DEBOUNCE, () => this.emit('changed'));
    }

    _watch(window) {
        // (A new window gets its actor a moment later.)
        this._timers.idle(`watch-${window.get_stable_sequence()}`, () => {
            const actor = window.get_compositor_private();
            if (actor && !this._actors.has(actor)) {
                this._actors.add(actor);
                actor.connectObject(
                    'notify::allocation', () => this.queueChanged(),
                    'destroy', () => this._actors.delete(actor),
                    this);
            }
        });
        this.queueChanged();
    }

    destroy() {
        this._timers.destroy();
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        this._actors.forEach(actor => actor.disconnectObject(this));
        this._actors.clear();
        this.disconnectAll();
    }
}
