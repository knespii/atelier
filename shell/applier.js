// Applies a look: wallpaper, interface settings, shell theme and GTK 4 links.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {linkGtk4Theme, unlinkGtk4Theme} from '../lib/gtk4.js';
import {ACCENT_COLORS, AUTO_ACCENT, LookStore} from '../lib/looks.js';
import {USER_THEME_UUID, getUserThemeSettings, locateTheme} from '../lib/themes.js';
import {accentForWallpaper} from '../lib/thumbnails.js';

const THEME_FIELDS = [
    // [kind for locateTheme, look field, org.gnome.desktop.interface key, label]
    ['gtk', 'gtkTheme', 'gtk-theme', 'GTK theme'],
    ['icons', 'iconTheme', 'icon-theme', 'Icon theme'],
    ['cursors', 'cursorTheme', 'cursor-theme', 'Cursor theme'],
];

function setIfChanged(settings, key, value) {
    if (settings.get_string(key) !== value)
        settings.set_string(key, value);
}

export class Applier {
    /**
     * @param {Gio.Settings} settings - the extension's settings
     */
    constructor(settings) {
        this._settings = settings;
        this._store = new LookStore(settings);
        this._next = null;
        this._running = null;
        this._destroyed = false;

        /** Optional wallpaper transition, see reveal.js */
        this.transition = null;
    }

    destroy() {
        this._destroyed = true;
        this._next = null;
        this.transition?.abort();
        this.transition = null;
    }

    /** @returns {boolean} whether a look is being applied right now */
    get busy() {
        return this._running !== null;
    }

    /**
     * Apply a look. While one is being applied, only the newest request is
     * kept and runs afterwards, so mashing the shortcut can't pile up work.
     *
     * @param {object} look
     * @param {object} [options]
     * @param {boolean} [options.animate] - play the wallpaper transition
     * @returns {Promise<void>}
     */
    apply(look, {animate = true} = {}) {
        this._next = {look, animate};
        this._running ??= this._drain().finally(() => {
            this._running = null;
        });
        return this._running;
    }

    async _drain() {
        while (this._next && !this._destroyed) {
            const {look, animate} = this._next;
            this._next = null;
            try {
                await this._applyOne(look, animate);
            } catch (e) {
                console.error(`BG Changer: applying “${look.name}” failed`, e);
                Main.notifyError('BG Changer', `Could not apply “${look.name}”: ${e.message}`);
            }
        }
    }

    async _applyOne(look, animate) {
        const problems = [];
        const plan = await this._resolve(look, problems);
        if (this._destroyed)
            return;

        // Play the transition with the old settings still in place, then
        // switch everything at once while the new wallpaper is on screen.
        let finishTransition = null;
        if (plan.background && animate && this.transition)
            finishTransition = await this.transition.reveal(plan.background.file, plan.background.options);
        if (this._destroyed)
            return;

        this._write(plan);
        this._store.activeId = look.id;

        const notes = await this._syncGtk4(look, plan, problems);
        await finishTransition?.();

        if (problems.length > 0)
            Main.notify(`BG Changer: “${look.name}” was applied partially`, problems.join('\n'));
        else if (notes.length > 0)
            Main.notify(`BG Changer: “${look.name}” applied`, notes.join('\n'));
    }

    async _resolve(look, problems) {
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const plan = {background: null, iface: {}, shellTheme: null, gtkThemeDir: null};

        if (look.wallpaper) {
            const file = Gio.File.new_for_path(look.wallpaper);
            if (file.query_exists(null))
                plan.background = {file, options: look.pictureOptions};
            else
                problems.push(`Wallpaper not found: ${look.wallpaper}`);
        }

        if (look.colorScheme !== null)
            plan.iface['color-scheme'] = look.colorScheme;

        if (look.accentColor !== null && iface.settings_schema.has_key('accent-color')) {
            let accent = look.accentColor;
            if (accent === AUTO_ACCENT) {
                accent = plan.background
                    ? await accentForWallpaper(look.wallpaper).catch(e => {
                        console.warn(`BG Changer: no accent for ${look.wallpaper}: ${e.message}`);
                        return null;
                    })
                    : null;
            }
            if (accent in ACCENT_COLORS)
                plan.iface['accent-color'] = accent;
        }

        for (const [kind, field, key, label] of THEME_FIELDS) {
            if (look[field] === null)
                continue;
            const dir = await locateTheme(kind, look[field]);
            if (dir === null) {
                problems.push(`${label} “${look[field]}” is not installed`);
                continue;
            }
            plan.iface[key] = look[field];
            if (kind === 'gtk')
                plan.gtkThemeDir = dir;
        }

        if (look.font !== null)
            plan.iface['font-name'] = look.font;

        if (look.shellTheme !== null) {
            const userThemes = Main.extensionManager.lookup(USER_THEME_UUID);
            if (userThemes?.state !== ExtensionState.ACTIVE)
                problems.push('Shell theme skipped: the User Themes extension is not enabled');
            else if (await locateTheme('shell', look.shellTheme) === null)
                problems.push(`Shell theme “${look.shellTheme}” is not installed`);
            else
                plan.shellTheme = look.shellTheme;
        }

        return plan;
    }

    _write(plan) {
        // Background keys and color-scheme each make the shell reload the
        // wallpaper; writing them in one go lets it coalesce the reloads.
        if (plan.background) {
            const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
            const uri = plan.background.file.get_uri();
            background.delay();
            setIfChanged(background, 'picture-uri', uri);
            setIfChanged(background, 'picture-uri-dark', uri);
            setIfChanged(background, 'picture-options', plan.background.options);
            background.apply();
        }

        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        iface.delay();
        for (const [key, value] of Object.entries(plan.iface))
            setIfChanged(iface, key, value);
        iface.apply();

        if (plan.shellTheme !== null) {
            const userTheme = getUserThemeSettings();
            if (userTheme)
                setIfChanged(userTheme, 'name', plan.shellTheme);
        }
    }

    async _syncGtk4(look, plan, problems) {
        // A look that leaves the GTK theme alone leaves its GTK 4 links alone too.
        if (look.gtkTheme === null || !plan.iface['gtk-theme'])
            return [];

        if (look.gtk4 && plan.gtkThemeDir) {
            const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            const dark = iface.get_string('color-scheme') === 'prefer-dark';
            const result = await linkGtk4Theme(this._settings, plan.gtkThemeDir, dark);
            if (!result.ok) {
                problems.push(`GTK 4 apps were not themed: ${result.reason}`);
                return [];
            }
            return result.changed ? ['Restart open apps to see the GTK 4 theme.'] : [];
        }

        const removed = await unlinkGtk4Theme(this._settings);
        return removed ? ['Restart open apps to bring back their default GTK 4 look.'] : [];
    }
}
