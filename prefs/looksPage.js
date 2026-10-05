// "Looks" page: the list of saved looks and the ways to create new ones.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {LookStore, describeLook, readCurrentAppearance} from '../lib/looks.js';
import {deleteWallpaperIfUnused, importWallpaper, prettyName} from '../lib/paths.js';
import {getUserThemeSettings, isUserThemeEnabled, scanThemes} from '../lib/themes.js';
import {ensureThumbnail, removeThumbnail} from '../lib/thumbnails.js';
import {LookEditor} from './lookEditor.js';
import {chooseImages, createThumbnail, requestApply, toast} from './widgets.js';

Gio._promisify(Adw.AlertDialog.prototype, 'choose', 'choose_finish');

function shortcutLabel(settings) {
    const [accel] = settings.get_strv('bgc-open-switcher');
    if (!accel)
        return null;
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    return ok ? Gtk.accelerator_get_label(key, mods) : accel;
}

export const LooksPage = GObject.registerClass(
class BgChangerLooksPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({
            title: 'Looks',
            icon_name: 'preferences-desktop-wallpaper-symbolic',
            name: 'looks',
        });
        this._settings = settings;
        this._store = new LookStore(settings);
        this._rows = [];

        this._group = new Adw.PreferencesGroup({title: 'Saved Looks'});
        this.add(this._group);

        const actions = new Adw.PreferencesGroup();
        this.add(actions);
        for (const [title, icon, handler] of [
            ['New Look…', 'list-add-symbolic', () => this._newLook()],
            ['Add Wallpapers…', 'image-x-generic-symbolic', () => this._addWallpapers()],
            ['Save Current Setup…', 'document-save-symbolic', () => this._saveCurrent()],
        ]) {
            const row = new Adw.ButtonRow({title, start_icon_name: icon});
            row.connect('activated', () => handler().catch(e => {
                console.error('BG Changer:', e);
                toast(this, e.message);
            }));
            actions.add(row);
        }

        this._settingsIds = [
            settings.connect('changed::looks', () => this._rebuild()),
            settings.connect('changed::active-look', () => this._rebuild()),
            settings.connect('changed::bgc-open-switcher', () => this._updateDescription()),
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
        this._rows.forEach(row => this._group.remove(row));
        this._rows = [];

        const looks = this._store.getAll();
        const activeId = this._store.activeId;
        if (looks.length === 0) {
            const row = new Adw.ActionRow({
                title: 'No looks yet',
                subtitle: 'Add some wallpapers or save your current setup below.',
            });
            this._group.add(row);
            this._rows.push(row);
            return;
        }

        looks.forEach((look, index) => {
            const row = this._createRow(look, index, looks.length, look.id === activeId);
            this._group.add(row);
            this._rows.push(row);
        });
    }

    _createRow(look, index, count, active) {
        const parts = describeLook(look).map(({label, value}) => `${label}: ${value}`);
        const row = new Adw.ActionRow({
            title: GLib.markup_escape_text(look.name, -1),
            subtitle: GLib.markup_escape_text(parts.join(' · ') || 'Wallpaper only', -1),
            subtitle_lines: 2,
            activatable: true,
        });
        row.add_prefix(createThumbnail(look.wallpaper, 96).widget);
        row.connect('activated', () => this._edit(look).catch(e => toast(this, e.message)));

        if (active) {
            row.add_suffix(new Gtk.Image({
                icon_name: 'object-select-symbolic',
                tooltip_text: 'Active look',
                css_classes: ['accent'],
            }));
        }

        const apply = new Gtk.Button({
            icon_name: 'media-playback-start-symbolic',
            tooltip_text: 'Apply',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        apply.connect('clicked', () => {
            requestApply(this._settings, look.id);
            toast(this, `Applying “${look.name}”`);
        });
        row.add_suffix(apply);

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
        addItem('Edit…', () => this._edit(look));
        addItem('Duplicate', () => this._duplicate(look));
        addItem('Move Up', () => this._store.move(look.id, -1), {sensitive: index > 0});
        addItem('Move Down', () => this._store.move(look.id, 1), {sensitive: index < count - 1});
        addItem('Delete…', () => this._delete(look), {destructive: true});

        row.add_suffix(new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            tooltip_text: 'More',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            popover,
        }));
        return row;
    }

    async _openEditor(look, initial = null) {
        const themes = await scanThemes();
        const editor = new LookEditor({
            store: this._store,
            look,
            initial,
            themes,
            userThemesEnabled: isUserThemeEnabled(),
        });
        editor.present(this);
    }

    _newLook() {
        return this._openEditor(null);
    }

    _edit(look) {
        return this._openEditor(look);
    }

    async _saveCurrent() {
        const current = readCurrentAppearance(isUserThemeEnabled() ? getUserThemeSettings() : null);
        // ~/.config/background (set by the wallpaper portal) has no useful name.
        const name = current.wallpaper && !current.wallpaper.endsWith('/.config/background')
            ? prettyName(current.wallpaper) : 'My Setup';
        await this._openEditor(null, {...current, name});
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
            : `Added ${fields.length} looks`);
    }

    _duplicate(look) {
        this._store.add({...look, id: '', name: `${look.name} (copy)`});
    }

    async _delete(look) {
        const dialog = new Adw.AlertDialog({
            heading: `Delete “${look.name}”?`,
            body: 'The look and its copy of the wallpaper will be removed.',
            close_response: 'cancel',
            default_response: 'cancel',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        if (await dialog.choose(this, null) !== 'delete')
            return;

        this._store.remove(look.id);
        if (look.wallpaper && await deleteWallpaperIfUnused(look.wallpaper, this._store.getAll()))
            await removeThumbnail(look.wallpaper);
        toast(this, `Deleted “${look.name}”`);
    }
});
