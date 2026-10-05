// Claude Code's usage, kept fresh by the worker (lib/claudeUsageWorker.js)
// in a process of its own: once a minute, every 20 seconds while a session
// runs.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const IDLE_INTERVAL = 60;
const BUSY_INTERVAL = 20;

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

export class ClaudeUsage extends EventEmitter {
    /**
     * @param {string} extensionPath
     */
    constructor(extensionPath) {
        super();
        this._worker = GLib.build_filenamev([extensionPath, 'lib', 'claudeUsageWorker.js']);
        this._gjs = GLib.find_program_in_path('gjs');
        this._summary = null;
        this._timeoutId = 0;
        this._cancellable = null;
    }

    /** @returns {object|null} the latest summary (see lib/claudeUsage.js summarize()) */
    get summary() {
        return this._summary;
    }

    start() {
        if (!this._gjs)
            return;
        this._run();
    }

    stop() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    /** Read again now, e.g. when the island shows the numbers. */
    refresh() {
        if (this._cancellable || !this._gjs)
            return;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._run();
    }

    async _run() {
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        try {
            const process = Gio.Subprocess.new([this._gjs, '-m', this._worker],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            cancellable.connect(() => process.force_exit());
            const [stdout, stderr] = await process.communicate_utf8_async(null, cancellable);
            if (process.get_successful()) {
                this._summary = JSON.parse(stdout);
                this.emit('changed');
            } else {
                console.warn(`Atelier: Claude usage worker failed: ${stderr.trim()}`);
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`Atelier: could not read Claude's usage: ${e.message}`);
        }
        if (cancellable.is_cancelled() || this._cancellable !== cancellable)
            return;
        this._cancellable = null;
        const interval = this._summary?.sessions?.active > 0 ? BUSY_INTERVAL : IDLE_INTERVAL;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, interval, () => {
            this._timeoutId = 0;
            this._run();
            return GLib.SOURCE_REMOVE;
        });
    }
}
