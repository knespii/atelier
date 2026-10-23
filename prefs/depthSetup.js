// The depth effect's rows on the Lock Screen page: the switch, the model to
// use (three sizes of Depth Anything V2), and what it needs, step by step –
// Python's packages (installed by the user: the command to copy), then the
// model (downloaded here, only when the user asks, and checked: its size
// and SHA-256, and that it loads), then ready, with how the cutout of the
// wallpaper is coming on (the shell makes it).

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {MODELS, chosenModel, modelPath, workerPath} from '../lib/depth.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async');
Gio._promisify(Gio.OutputStream.prototype, 'close_async');
Gio._promisify(Gio.File.prototype, 'replace_async');
Gio._promisify(Gio.File.prototype, 'move_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

const CHUNK = 1024 * 1024;
const MB = 1024 * 1024;

/**
 * What the depth effect has of what it needs.
 *
 * @param {string} [model] - the model to try (the one kept, by default)
 * @returns {Promise<{python: boolean, missing: string[], model: string}>}
 *   model: 'ok', 'missing', or why it doesn't load
 */
export async function probe(model) {
    const python = GLib.find_program_in_path('python3');
    if (!python)
        return {python: false, missing: [], model: 'missing'};
    const there = GLib.file_test(model, GLib.FileTest.EXISTS);
    const process = Gio.Subprocess.new([python, workerPath(), '--check', ...there ? ['--model', model] : []],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [stdout] = await process.communicate_utf8_async(null, null);
    let answer = {};
    try {
        answer = JSON.parse(stdout.trim().split('\n').at(-1));
    } catch {
        answer = {missing: [], model: `the check failed (${process.get_exit_status()})`};
    }
    return {python: true, missing: answer.missing ?? [], model: there ? answer.model ?? 'missing' : 'missing'};
}

/**
 * Download a model to a file of its own, checked against its size and
 * SHA-256.
 *
 * @param {object} model - one of MODELS
 * @param {string} target - where it goes (written aside, moved there when whole)
 * @param {object} [options]
 * @param {Function} [options.onProgress] - (bytes, total|0)
 * @param {Gio.Cancellable} [options.cancellable]
 * @param {Function} [options.check] - (path) => Promise<string>, 'ok' when
 *   it loads (see probe())
 */
export async function downloadModel(model, target, {onProgress = () => {}, cancellable = null, check = null} = {}) {
    const session = new Soup.Session({user_agent: 'Atelier (GNOME Shell extension)', timeout: 60});
    const message = Soup.Message.new('GET', model.url);
    const input = await session.send_async(message, GLib.PRIORITY_DEFAULT, cancellable);
    if (message.get_status() !== Soup.Status.OK)
        throw new Error(`the server says ${message.get_status()} ${message.get_reason_phrase() ?? ''}`.trim());
    const total = Math.max(0, message.get_response_headers().get_content_length());
    if (total > 0 && total !== model.bytes)
        throw new Error('the file there is not the model (its size differs)');
    GLib.mkdir_with_parents(GLib.path_get_dirname(target), 0o755);
    const partial = Gio.File.new_for_path(`${target}.partial`);
    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    try {
        const output = await partial.replace_async(null, false, Gio.FileCreateFlags.NONE,
            GLib.PRIORITY_DEFAULT, cancellable);
        let received = 0;
        for (;;) {
            const bytes = await input.read_bytes_async(CHUNK, GLib.PRIORITY_DEFAULT, cancellable);
            const size = bytes.get_size();
            if (size === 0)
                break;
            received += size;
            if (received > model.bytes)
                throw new Error('the file there is bigger than the model');
            checksum.update(bytes.toArray());
            await output.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, cancellable);
            onProgress(received, total);
        }
        await output.close_async(GLib.PRIORITY_DEFAULT, null);
        await input.close_async(GLib.PRIORITY_DEFAULT, null);
        if (received !== model.bytes || checksum.get_string() !== model.sha256)
            throw new Error('what came is not the model (its checksum differs)');
        const loads = check ? await check(partial.get_path()) : 'ok';
        if (loads !== 'ok' && loads !== 'missing')
            throw new Error(`the model ${loads}`);
        await partial.move_async(Gio.File.new_for_path(target), Gio.FileCopyFlags.OVERWRITE,
            GLib.PRIORITY_DEFAULT, null, null);
    } catch (e) {
        await partial.delete_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        throw e;
    }
}

const install = missing => `sudo apt install ${missing.join(' ')}`;

export class DepthSetup {
    /**
     * @param {Adw.PreferencesGroup} group - the rows go in it
     * @param {Gio.Settings} settings - the lockscreen ones
     */
    constructor(group, settings) {
        this._settings = settings;
        /** Stand-ins for tests: what is there, and the download. */
        this.probe = probe;
        this.download = downloadModel;
        this._downloading = null;
        this._serial = 0;
        this.state = null;

        this.switchRow = new Adw.SwitchRow({
            title: 'Depth effect',
            subtitle: 'What stands near in the wallpaper in front of your own clocks, as if they stood behind it',
        });
        settings.bind('depth-effect', this.switchRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(this.switchRow);

        // The model: its size, its licence and about how long it takes.
        this._ids = Object.keys(MODELS);
        this.modelRow = new Adw.ComboRow({
            title: 'Depth Model',
            model: Gtk.StringList.new(this._ids.map(id => MODELS[id].title)),
            selected: this._ids.indexOf(this.model),
        });
        // (Chosen once, it stays chosen: no longer the biggest one there.)
        this.modelRow.connect('notify::selected', () => {
            const id = this._ids[this.modelRow.selected];
            if (id && id !== this.model)
                this._settings.set_string('depth-model', id);
        });
        group.add(this.modelRow);

        this.statusRow = new Adw.ActionRow({title: 'Checking…', subtitle_selectable: true});
        this._icon = new Gtk.Image({icon_name: 'content-loading-symbolic', valign: Gtk.Align.CENTER});
        this.statusRow.add_prefix(this._icon);
        this._progress = new Gtk.ProgressBar({valign: Gtk.Align.CENTER, visible: false, width_request: 120});
        this.downloadButton = new Gtk.Button({label: 'Download Model…', valign: Gtk.Align.CENTER,
            visible: false, css_classes: ['suggested-action']});
        this.downloadButton.connect('clicked', () => this._download());
        this.cancelButton = new Gtk.Button({label: 'Cancel', valign: Gtk.Align.CENTER, visible: false});
        this.cancelButton.connect('clicked', () => this._downloading?.cancel());
        this.computeButton = new Gtk.Button({label: 'Compute Now', valign: Gtk.Align.CENTER, visible: false});
        this.computeButton.connect('clicked', () => settings.set_string('depth-request', GLib.uuid_string_random()));
        this.againButton = new Gtk.Button({label: 'Check Again', valign: Gtk.Align.CENTER, visible: false});
        this.againButton.connect('clicked', () => this.refresh());
        for (const widget of [this._progress, this.cancelButton, this.downloadButton, this.computeButton, this.againButton])
            this.statusRow.add_suffix(widget);
        group.add(this.statusRow);

        // What to install, to copy.
        this.commandRow = new Adw.ActionRow({title: '', visible: false, css_classes: ['monospace']});
        this.copyButton = new Gtk.Button({icon_name: 'edit-copy-symbolic', tooltip_text: 'Copy',
            valign: Gtk.Align.CENTER, css_classes: ['flat']});
        this.copyButton.connect('clicked', () => this.commandRow.get_clipboard().set_content(
            Gdk.ContentProvider.new_for_value(this.commandRow.title)));
        this.commandRow.add_suffix(this.copyButton);
        group.add(this.commandRow);

        this._statusId = settings.connect('changed::depth-status', () => this._sync());
        this._effectId = settings.connect('changed::depth-effect', () => this._sync());
        this._modelId = settings.connect('changed::depth-model', () => this.refresh());
        this.refresh();
    }

    /** @returns {string} the model the effect uses (an id of MODELS) */
    get model() {
        return chosenModel(this._settings.get_string('depth-model'));
    }

    _showModel() {
        const id = this.model;
        const {label, license, time} = MODELS[id];
        if (this.modelRow.selected !== this._ids.indexOf(id))
            this.modelRow.selected = this._ids.indexOf(id);
        const use = license.includes('NC') ? `${license}, for non-commercial use` : license;
        const kept = this.state?.model === 'ok' ? 'downloaded' : 'not downloaded';
        this.modelRow.subtitle = `Depth Anything V2, ${label} (${use}): ${time}; ${kept}`;
        this.modelRow.sensitive = !this._downloading;
        this.downloadButton.label = `Download Model (${label})…`;
    }

    /** @returns {Promise} what is there, looked at again */
    async refresh() {
        const serial = ++this._serial;
        let state;
        try {
            state = await this.probe(modelPath(this.model));
        } catch (e) {
            state = {python: true, missing: [], model: `can't be checked: ${e.message}`};
        }
        if (serial !== this._serial || !this._settings)
            return;
        this.state = state;
        this._sync();
    }

    _show({title, subtitle = '', icon, download = false, compute = false, again = false, command = null}) {
        this.statusRow.title = title;
        this.statusRow.subtitle = subtitle;
        this._icon.icon_name = icon;
        const busy = Boolean(this._downloading);
        this._progress.visible = busy;
        this.cancelButton.visible = busy;
        this.downloadButton.visible = download && !busy;
        this.computeButton.visible = compute;
        this.againButton.visible = again;
        this.commandRow.visible = Boolean(command);
        this.commandRow.title = command ?? '';
    }

    _sync() {
        const state = this.state;
        if (!state)
            return;
        this._showModel();
        if (this._downloading) {
            this._show({title: 'Downloading the model…', subtitle: this._received, icon: 'folder-download-symbolic'});
        } else if (!state.python) {
            this._show({title: 'Python 3 is missing', subtitle: 'The depth effect runs in Python 3: install python3',
                icon: 'dialog-warning-symbolic', again: true, command: install(['python3'])});
        } else if (state.missing.length > 0) {
            this._show({title: 'Python packages are missing',
                subtitle: `It needs ${state.missing.join(', ')}: install them, then check again`,
                icon: 'dialog-warning-symbolic', again: true, command: install(state.missing)});
        } else if (state.model === 'missing') {
            this._show({title: 'The model isn\'t downloaded',
                subtitle: `Depth Anything V2 ${MODELS[this.model].title}, which sees how near each part of the ` +
                    'wallpaper is (from Hugging Face): downloaded only when you ask',
                icon: 'folder-download-symbolic', download: true});
        } else if (state.model !== 'ok') {
            this._show({title: 'The model doesn\'t load', subtitle: state.model,
                icon: 'dialog-warning-symbolic', download: true});
        } else {
            this._showReady();
        }
    }

    _showReady() {
        const on = this._settings.get_boolean('depth-effect');
        const status = this._settings.get_string('depth-status');
        let subtitle = 'Switch it on: the cutout of the wallpaper is made in the background';
        if (on && status === 'working')
            subtitle = 'Making the cutout of this wallpaper…';
        else if (on && status === 'ready')
            subtitle = 'The cutout of this wallpaper is made: lock the screen to see it';
        else if (on && status === 'none')
            subtitle = 'No cutout of a slideshow, or without a wallpaper';
        else if (on && status.startsWith('failed: '))
            subtitle = `The cutout failed: ${status.slice('failed: '.length)}`;
        else if (on)
            subtitle = 'The cutout is made a moment after the wallpaper changes';
        this._show({title: 'Ready', subtitle, icon: 'object-select-symbolic', compute: on});
        this.computeButton.sensitive = status !== 'working';
    }

    async _download() {
        if (this._downloading)
            return;
        this._downloading = new Gio.Cancellable();
        this._received = 'Starting…';
        this._progress.fraction = 0;
        this._sync();
        let failure = null;
        try {
            await this.download(MODELS[this.model], modelPath(this.model), {
                cancellable: this._downloading,
                check: path => this.probe(path).then(state => state.model),
                onProgress: (bytes, total) => {
                    this._progress.fraction = total > 0 ? Math.min(1, bytes / total) : 0;
                    this._received = total > 0
                        ? `${(bytes / MB).toFixed(1)} of ${(total / MB).toFixed(1)} MB`
                        : `${(bytes / MB).toFixed(1)} MB`;
                    if (this._settings)
                        this.statusRow.subtitle = this._received;
                },
            });
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                failure = e.message;
        }
        this._downloading = null;
        if (!this._settings)
            return;
        await this.refresh();
        if (failure && this.state?.model === 'missing') {
            this.statusRow.title = 'The download failed';
            this.statusRow.subtitle = `${failure}. Try again?`;
        }
        if (!failure && this.state?.model === 'ok')
            this._settings.set_string('depth-request', GLib.uuid_string_random());
    }

    disconnectSettings() {
        this._downloading?.cancel();
        Gio.Settings.unbind(this.switchRow, 'active');
        this._settings.disconnect(this._statusId);
        this._settings.disconnect(this._effectId);
        this._settings.disconnect(this._modelId);
        this._settings = null;
    }
}
