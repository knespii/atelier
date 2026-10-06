// "Profiles" page: the saved profiles as cards – the wallpaper, what else
// it sets, "In use" or "Switch" – with renaming, exporting and the rest in
// their menus, and the ways to create new ones or import them.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ProfileStore, describeProfile, readCurrentAppearance} from '../lib/profiles.js';
import {deleteWallpaperIfUnused, importWallpaper, prettyName} from '../lib/paths.js';
import {exportProfile, readExportedProfile} from '../lib/profileTransfer.js';
import {getUserThemeSettings, isUserThemeEnabled, scanThemes} from '../lib/themes.js';
import {ensureThumbnail, removeThumbnail} from '../lib/thumbnails.js';
import {readPaletteOptions} from '../lib/wallpaperPalette.js';
import {readWidgets} from '../lib/widgets.js';
import {ProfileEditor} from './profileEditor.js';
import {chooseImages, createThumbnail, requestApply, toast} from './widgets.js';

Gio._promisify(Adw.AlertDialog.prototype, 'choose', 'choose_finish');
Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');

const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'atelier']);

function shortcutLabel(settings) {
    const [accel] = settings.get_strv('atelier-open-switcher');
    if (!accel)
        return null;
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    return ok ? Gtk.accelerator_get_label(key, mods) : accel;
}

export const ProfilesPage = GObject.registerClass(
class AtelierProfilesPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: 'Profiles',
            icon_name: 'preferences-desktop-wallpaper-symbolic',
            name: 'profiles',
        });
        this._settings = settings;
        this._store = new ProfileStore(settings);
        this._rows = [];

        this._group = new Adw.PreferencesGroup({title: 'Saved Profiles'});
        this.add(this._group);
        this._cards = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            homogeneous: true,
            min_children_per_line: 2,
            max_children_per_line: 3,
            column_spacing: 12,
            row_spacing: 12,
        });
        this._group.add(this._cards);

        const actions = new Adw.PreferencesGroup();
        this.add(actions);
        for (const [title, icon, handler] of [
            ['New Profile…', 'list-add-symbolic', () => this._newProfile()],
            ['Save Current Setup…', 'document-save-symbolic', () => this._saveCurrent()],
            ['Add Wallpapers…', 'image-x-generic-symbolic', () => this._addWallpapers()],
            ['Import a Profile…', 'document-open-symbolic', () => this._import()],
        ]) {
            const row = new Adw.ButtonRow({title, start_icon_name: icon});
            row.connect('activated', () => handler().catch(e => {
                console.error('Atelier:', e);
                toast(this, e.message);
            }));
            actions.add(row);
        }

        const data = new Adw.PreferencesGroup({title: 'Data'});
        this.add(data);
        const where = new Adw.ActionRow({
            title: 'Profiles and their wallpapers',
            subtitle: DATA_DIR.replace(GLib.get_home_dir(), '~'),
        });
        const open = new Gtk.Button({label: 'Open', valign: Gtk.Align.CENTER});
        open.connect('clicked', () => {
            GLib.mkdir_with_parents(DATA_DIR, 0o755);
            new Gtk.FileLauncher({file: Gio.File.new_for_path(DATA_DIR)}).launch(this.get_root(), null, null);
        });
        where.add_suffix(open);
        data.add(where);

        this._settingsIds = [
            settings.connect('changed::profiles', () => this._rebuild()),
            settings.connect('changed::active-profile', () => this._rebuild()),
            settings.connect('changed::atelier-open-switcher', () => this._updateDescription()),
        ];
        this._updateDescription();
        this._rebuild();
    }

    disconnectSettings() {
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._settingsIds = [];
    }

    _updateDescription() {
        const shortcut = shortcutLabel(this._settings);
        this._group.description = shortcut
            ? `Switch between them with ${shortcut} or the button in the top bar.`
            : 'Switch between them with the button in the top bar.';
    }

    _rebuild() {
        this._rows.forEach(card => this._cards.remove(card));
        this._rows = [];
        this._empty?.get_parent()?.remove(this._empty);

        const profiles = this._store.getAll();
        const activeId = this._store.activeId;
        if (profiles.length === 0) {
            this._empty ??= new Adw.ActionRow({
                title: 'No profiles yet',
                subtitle: 'Add some wallpapers or save your current setup below.',
            });
            this._group.add(this._empty);
            return;
        }

        profiles.forEach((profile, index) => {
            const card = this._createCard(profile, index, profiles.length, profile.id === activeId);
            this._cards.append(card);
            this._rows.push(card);
        });
    }

    _createCard(profile, index, count, active) {
        const card = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            css_classes: active ? ['atelier-profile-card', 'active'] : ['atelier-profile-card'],
        });
        card.profileId = profile.id;
        const thumbnail = createThumbnail(profile.wallpaper, 280, 'atelier-profile-thumb').widget;
        thumbnail.halign = Gtk.Align.FILL;
        card.append(thumbnail);
        // Clicking the picture edits it.
        const click = new Gtk.GestureClick();
        click.connect('released', () => this._edit(profile).catch(e => toast(this, e.message)));
        thumbnail.add_controller(click);
        thumbnail.cursor = Gdk.Cursor.new_from_name('pointer', null);

        const top = new Gtk.Box({spacing: 8});
        top.append(new Gtk.Label({
            label: profile.name,
            xalign: 0,
            hexpand: true,
            ellipsize: 3, // end
            css_classes: ['heading'],
        }));
        if (active) {
            top.append(new Gtk.Label({label: 'In use', css_classes: ['atelier-in-use'], valign: Gtk.Align.CENTER}));
        } else {
            const apply = new Gtk.Button({label: 'Switch', valign: Gtk.Align.CENTER, css_classes: ['atelier-switch']});
            apply.connect('clicked', () => {
                requestApply(this._settings, profile.id);
                toast(this, `Switching to “${profile.name}”`);
            });
            top.append(apply);
        }
        card.append(top);

        const bottom = new Gtk.Box({spacing: 4});
        const parts = describeProfile(profile).map(({value}) => value);
        bottom.append(new Gtk.Label({
            label: parts.join(' · ') || 'Wallpaper only',
            xalign: 0,
            hexpand: true,
            wrap: true,
            lines: 2,
            ellipsize: 3,
            css_classes: ['dim-label', 'caption'],
        }));

        const menu = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2});
        const popover = new Gtk.Popover({child: menu});
        const addItem = (label, handler, {sensitive = true, destructive = false} = {}) => {
            const button = new Gtk.Button({
                label,
                sensitive,
                css_classes: destructive ? ['flat', 'error'] : ['flat'],
            });
            button.get_child().halign = Gtk.Align.START;
            button.connect('clicked', () => {
                popover.popdown();
                Promise.resolve(handler()).catch(e => toast(this, e.message));
            });
            menu.append(button);
        };
        addItem('Edit…', () => this._edit(profile));
        addItem('Rename…', () => this._rename(profile));
        addItem('Duplicate', () => this._duplicate(profile));
        addItem('Export…', () => this._export(profile));
        if (active)
            addItem('Restore', () => this._restore(profile));
        addItem('Move Earlier', () => this._store.move(profile.id, -1), {sensitive: index > 0});
        addItem('Move Later', () => this._store.move(profile.id, 1), {sensitive: index < count - 1});
        addItem('Delete…', () => this._delete(profile), {destructive: true});
        bottom.append(new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            tooltip_text: 'More',
            valign: Gtk.Align.START,
            css_classes: ['flat', 'circular'],
            popover,
        }));
        card.append(bottom);
        return card;
    }

    async _openEditor(profile, initial = null) {
        const themes = await scanThemes();
        const editor = new ProfileEditor({
            store: this._store,
            profile,
            initial,
            themes,
            userThemesEnabled: isUserThemeEnabled(),
        });
        editor.present(this);
    }

    _newProfile() {
        return this._openEditor(null);
    }

    _edit(profile) {
        return this._openEditor(profile);
    }

    async _saveCurrent() {
        const current = readCurrentAppearance(isUserThemeEnabled() ? getUserThemeSettings() : null);
        // ~/.config/background (set by the wallpaper portal) has no useful name.
        const name = current.wallpaper && !current.wallpaper.endsWith('/.config/background')
            ? prettyName(current.wallpaper) : 'My Setup';
        const palette = readPaletteOptions(this._settings.get_child('palette'));
        await this._openEditor(null, {...current, name, palette});
    }

    async _addWallpapers() {
        const paths = await chooseImages(this, true);
        if (paths.length === 0)
            return;

        const fields = [];
        for (const path of paths) {
            try {
                const wallpaper = await importWallpaper(path);
                fields.push({name: prettyName(path), wallpaper});
            } catch (e) {
                toast(this, `Skipped ${GLib.path_get_basename(path)}: ${e.message}`);
            }
        }
        if (fields.length === 0)
            return;

        this._store.addAll(fields);
        fields.forEach(({wallpaper}) => ensureThumbnail(wallpaper).catch(() => {}));
        toast(this, fields.length === 1
            ? `Added “${fields[0].name}”`
            : `Added ${fields.length} profiles`);
    }

    _duplicate(profile) {
        this._store.add({...profile, id: '', name: `${profile.name} (copy)`});
    }

    async _rename(profile) {
        const entry = new Gtk.Entry({text: profile.name, activates_default: true});
        const dialog = new Adw.AlertDialog({
            heading: 'Rename Profile',
            extra_child: entry,
            close_response: 'cancel',
            default_response: 'rename',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('rename', 'Rename');
        dialog.set_response_appearance('rename', Adw.ResponseAppearance.SUGGESTED);
        entry.connect('changed', () => dialog.set_response_enabled('rename', entry.text.trim() !== ''));
        if (await dialog.choose(this, null) !== 'rename')
            return;
        this._store.update(profile.id, {name: entry.text.trim()});
    }

    // Back to the profile as saved (after a wallpaper for now, say).
    _restore(profile) {
        requestApply(this._settings, profile.id);
        toast(this, `“${profile.name}” is as saved again`);
    }

    async _export(profile) {
        const dialog = new Gtk.FileDialog({title: 'Export to a Folder', modal: true});
        let folder;
        try {
            folder = await dialog.select_folder(this.get_root(), null);
        } catch (e) {
            if (e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                return;
            throw e;
        }
        const dir = await exportProfile(profile, folder.get_path());
        toast(this, `Exported to ${GLib.path_get_basename(dir)}`);
    }

    async _import(path = null) {
        if (!path) {
            const dialog = new Gtk.FileDialog({title: 'Import an Exported Profile', modal: true});
            try {
                path = (await dialog.select_folder(this.get_root(), null)).get_path();
            } catch (e) {
                if (e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    return null;
                throw e;
            }
        }
        const profile = await readExportedProfile(path);
        for (const key of ['wallpaper', 'wallpaperDark']) {
            if (profile[key])
                profile[key] = await importWallpaper(profile[key]);
        }
        // (Without widgets of its own, it keeps those on the desktop now.)
        const added = this._store.add({
            ...profile,
            id: '',
            widgets: profile.widgets ?? readWidgets(this._settings.get_child('desktop')),
        });
        if (profile.wallpaper)
            ensureThumbnail(profile.wallpaper).catch(() => {});
        toast(this, `Imported “${profile.name}”`);
        return added;
    }

    async _delete(profile) {
        const dialog = new Adw.AlertDialog({
            heading: `Delete “${profile.name}”?`,
            body: 'The profile and its copy of the wallpaper will be removed.',
            close_response: 'cancel',
            default_response: 'cancel',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        if (await dialog.choose(this, null) !== 'delete')
            return;

        this._store.remove(profile.id);
        const remaining = this._store.getAll();
        if (profile.wallpaper && await deleteWallpaperIfUnused(profile.wallpaper, remaining))
            await removeThumbnail(profile.wallpaper);
        if (profile.wallpaperDark)
            await deleteWallpaperIfUnused(profile.wallpaperDark, remaining);
        toast(this, `Deleted “${profile.name}”`);
    }
});
