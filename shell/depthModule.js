// The depth effect's cutouts (lib/depth.js), made in the session while the
// effect is on: of the wallpaper the lock screen shows, whenever it changes
// (a profile applied, the style turned dark), for the main monitor, and
// again when the preferences ask or another model is chosen. The worker
// (lib/depthWorker.py) runs in a process of its own at the lowest priority,
// one at a time, a moment after the change; a cutout made already is used
// as it is. It stops with the session's modules as the screen locks: the
// lock screen only shows a cutout that is there.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {chosenModel, cutoutPath, depthDir, lockWallpaper, modelPath, pictureState, workerPath} from '../lib/depth.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

const DELAY = 3000; // after a change, before the worker starts, ms
const KEPT = 12; // cutouts kept, the newest

export class DepthModule {
    /**
     * @param {object} context
     * @param {Gio.Settings} context.settings
     */
    constructor({settings}) {
        this._settings = settings;
        this._worker = workerPath();
        this._timeoutId = 0;
        this._process = null;
        this._again = false;
        this._anew = false;
    }

    enable() {
        this._lockSettings = this._settings.get_child('lockscreen');
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._background.connectObject(
            'changed::picture-uri', () => this._queue(),
            'changed::picture-uri-dark', () => this._queue(),
            'changed::picture-options', () => this._queue(),
            this);
        this._interface.connectObject('changed::color-scheme', () => this._queue(), this);
        this._lockSettings.connectObject(
            'changed::enabled', () => this._queue(),
            'changed::depth-request', () => this._queue(0, true),
            // (Cutouts of other wallpapers stay as the model before made
            // them, till they are made anew.)
            'changed::depth-model', () => this._queue(0, true),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._queue(), this);
        this._queue();
    }

    disable() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        // (Locked, nothing goes on making one.)
        this._process?.force_exit();
        this._process = null;
        this._background.disconnectObject(this);
        this._interface.disconnectObject(this);
        this._lockSettings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        this._background = null;
        this._interface = null;
        this._lockSettings = null;
    }

    _queue(delay = DELAY, anew = false) {
        this._anew ||= anew;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, delay, () => {
            this._timeoutId = 0;
            this._make().catch(e => console.error('Atelier: making the depth effect\'s cutout failed', e));
            return GLib.SOURCE_REMOVE;
        });
    }

    _setStatus(status) {
        if (this._lockSettings && this._lockSettings.get_string('depth-status') !== status)
            this._lockSettings.set_string('depth-status', status);
    }

    async _make() {
        // (One at a time: the newest change once this one is done.)
        if (this._process) {
            this._again = true;
            return;
        }
        if (!this._lockSettings.get_boolean('enabled'))
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        const path = lockWallpaper(this._background, this._interface);
        const picture = path ? pictureState(path) : null;
        if (!picture || !monitor) {
            this._setStatus('none');
            return;
        }
        const size = [monitor.width, monitor.height];
        const target = cutoutPath(picture, size);
        const anew = this._anew;
        this._anew = false;
        if (!anew && GLib.file_test(target, GLib.FileTest.EXISTS)) {
            this._setStatus('ready');
            return;
        }
        const python = GLib.find_program_in_path('python3');
        const model = modelPath(chosenModel(this._lockSettings.get_string('depth-model')));
        // (The preferences say what is missing.)
        if (!python || !GLib.file_test(model, GLib.FileTest.EXISTS)) {
            this._setStatus('');
            return;
        }
        this._setStatus('working');
        let answer = null;
        const process = Gio.Subprocess.new([python, this._worker, '--model', model, '--input', path,
            '--output', target, '--width', `${size[0]}`, '--height', `${size[1]}`],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        this._process = process;
        try {
            const [stdout] = await process.communicate_utf8_async(null, null);
            answer = JSON.parse(stdout.trim().split('\n').at(-1) || '{}');
        } catch (e) {
            answer = {ok: false, error: e.message};
        }
        // (Stopped meanwhile: the screen locked, Atelier turned off.)
        if (this._process !== process)
            return;
        this._process = null;
        if (answer?.ok) {
            this._setStatus('ready');
            this._prune(target).catch(e => console.warn(`Atelier: old cutouts stay: ${e.message}`));
        } else {
            const why = answer?.error ?? `the worker stopped (${process.get_exit_status()})`;
            console.warn(`Atelier: no cutout of ${path} for the depth effect: ${why}`);
            this._setStatus(`failed: ${why}`);
        }
        if (this._again) {
            this._again = false;
            this._queue(0);
        }
    }

    // The newest few cutouts kept (for the wallpapers switched between),
    // the one just made among them.
    async _prune(keep) {
        const dir = Gio.File.new_for_path(depthDir());
        const enumerator = await dir.enumerate_children_async('standard::name,time::modified',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null);
        const cutouts = [];
        for (;;) {
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_LOW, null);
            if (infos.length === 0)
                break;
            cutouts.push(...infos.filter(info => info.get_name().endsWith('.png')));
        }
        const time = info => info.get_attribute_uint64('time::modified');
        cutouts.sort((a, b) => time(b) - time(a));
        for (const info of cutouts.slice(KEPT)) {
            const file = dir.get_child(info.get_name());
            if (file.get_path() !== keep)
                await file.delete_async(GLib.PRIORITY_LOW, null).catch(() => {});
        }
    }
}
