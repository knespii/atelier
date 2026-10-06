// Claude Code's usage, kept fresh by the worker (lib/claudeUsageWorker.js)
// in a process of its own while something on screen shows it: once a
// minute, every 20 seconds while a session runs. Read once at the start
// (whether there is any history decides what shows it) and again whenever
// something showing it comes up; without any history, now and then.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

const IDLE_INTERVAL = 60;
const BUSY_INTERVAL = 20;
const ABSENT_INTERVAL = 600;

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
        this._stopped = false;
        this._watchers = new Set();
    }

    /** @returns {object|null} the latest summary (see lib/claudeUsage.js summarize()) */
    get summary() {
        return this._summary;
    }

    /**
     * Keep the numbers fresh while an actor shows them: they are read again
     * as it comes up, and from then on as long as it (or another) is on
     * screen.
     *
     * @param {Clutter.Actor} actor
     */
    watch(actor) {
        if (this._watchers.has(actor))
            return;
        this._watchers.add(actor);
        actor.connectObject(
            'notify::mapped', () => {
                // (Unless a read is under way or coming already.)
                if (actor.mapped && !this._timeoutId)
                    this.refresh();
            },
            'destroy', () => this._watchers.delete(actor),
            this);
        if (actor.mapped && !this._timeoutId)
            this.refresh();
    }

    start() {
        if (!this._gjs)
            return;
        this._run();
    }

    stop() {
        this._stopped = true;
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._watchers.forEach(actor => actor.disconnectObject(this));
        this._watchers.clear();
    }

    /** Read again now, e.g. when the island shows the numbers. */
    refresh() {
        if (this._cancellable || !this._gjs || this._stopped)
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
        const interval = this._nextInterval();
        if (interval === null)
            return;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, interval, () => {
            this._timeoutId = 0;
            this._run();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * @returns {number|null} seconds until the next read; none while nothing
     *   on screen shows the numbers (one coming up reads them)
     */
    _nextInterval() {
        if ([...this._watchers].some(actor => actor.mapped))
            return this._summary?.sessions?.active > 0 ? BUSY_INTERVAL : IDLE_INTERVAL;
        // Without any history, what would show it stays hidden: look again
        // now and then, for when Claude Code comes.
        return this._summary?.found === false ? ABSENT_INTERVAL : null;
    }
}
