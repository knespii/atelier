// What the island shows next to the time: whether an app is recording from
// the microphone, and unseen notifications or Do Not Disturb (the dot that
// GNOME shows next to its clock, which the island replaces).

import Gio from 'gi://Gio';
import Gvc from 'gi://Gvc';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

// They list recording streams only to show input levels.
const NOT_RECORDING = ['org.gnome.VolumeControl', 'org.PulseAudio.pavucontrol'];

/** Emits 'changed' when an app starts or stops recording. */
export class MicWatcher extends EventEmitter {
    /**
     * @param {Gvc.MixerControl} [control] - the shell's mixer, shared with GNOME
     */
    constructor(control = Volume.getMixerControl()) {
        super();
        this._control = control;
        this._active = false;
        control.connectObject(
            'state-changed', () => this._update(),
            'default-source-changed', () => this._update(),
            'stream-added', () => this._update(),
            'stream-removed', () => this._update(),
            this);
        this._update();
    }

    /** @returns {boolean} whether the microphone is in use */
    get active() {
        return this._active;
    }

    _isRecording() {
        // The same test GNOME uses for its microphone indicator.
        if (this._control.get_state() !== Gvc.MixerControlState.READY || !this._control.get_default_source())
            return false;
        return this._control.get_source_outputs()
            .some(output => !NOT_RECORDING.includes(output.get_application_id()));
    }

    _update() {
        const active = this._isRecording();
        if (active === this._active)
            return;
        this._active = active;
        this.emit('changed');
    }

    destroy() {
        // The mixer belongs to the shell; it stays open.
        this._control.disconnectObject(this);
    }
}

/** Emits 'changed' when the count of unseen notifications or DND changes. */
export class UnseenWatcher extends EventEmitter {
    constructor() {
        super();
        this._unseen = 0;
        this._dnd = false;
        this._sources = new Set();
        this._settings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._settings.connectObject('changed::show-banners', () => this._update(), this);
        Main.messageTray.connectObject(
            'source-added', (_, source) => this._addSource(source),
            'source-removed', (_, source) => this._removeSource(source),
            'queue-changed', () => this._update(),
            this);
        Main.messageTray.getSources().forEach(source => this._addSource(source));
        this._update();
    }

    /** @returns {number} notifications not seen yet */
    get unseen() {
        return this._unseen;
    }

    /** @returns {boolean} whether Do Not Disturb is on */
    get doNotDisturb() {
        return this._dnd;
    }

    _addSource(source) {
        this._sources.add(source);
        source.connectObject('notify::count', () => this._update(), this);
        this._update();
    }

    _removeSource(source) {
        this._sources.delete(source);
        source.disconnectObject(this);
        this._update();
    }

    _update() {
        let unseen = 0;
        this._sources.forEach(source => (unseen += source.unseenCount));
        // Banners still waiting in the queue haven't had a chance to be seen.
        unseen = Math.max(0, unseen - Main.messageTray.queueCount);
        const dnd = !this._settings.get_boolean('show-banners');
        if (unseen === this._unseen && dnd === this._dnd)
            return;
        this._unseen = unseen;
        this._dnd = dnd;
        this.emit('changed');
    }

    destroy() {
        this._sources.forEach(source => source.disconnectObject(this));
        this._sources.clear();
        Main.messageTray.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._settings = null;
    }
}
