// "Wallpapers" section: the folder shown on the switcher's Wallpapers tab.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {listWallpapers, prettyName, wallpaperFolder} from '../lib/paths.js';
import {chooseImages, createThumbnail, toast} from './widgets.js';

Gio._promisify(Gtk.FileDialog.prototype, 'select_folder', 'select_folder_finish');
Gio._promisify(Gio.File.prototype, 'copy_async');

const MAX_SHOWN = 30;
const home = path => path.replace(GLib.get_home_dir(), '~');

export const WallpapersPage = GObject.registerClass(
class AtelierWallpapersPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Wallpapers'});
        this._settings = settings;

        const folderGroup = new Adw.PreferencesGroup({
            title: 'Folder',
            description: 'Pictures in this folder show up on the Wallpapers tab of the switcher. ' +
                'Picking one changes only the wallpaper, and the active profile keeps it.',
        });
        this.add(folderGroup);

        this._folderRow = new Adw.ActionRow({title: 'Folder', use_markup: false});
        const choose = new Gtk.Button({label: 'Choose…', valign: Gtk.Align.CENTER});
        choose.connect('clicked', () => this._chooseFolder().catch(e => toast(this, e.message)));
        const open = new Gtk.Button({
            icon_name: 'folder-open-symbolic',
            tooltip_text: 'Open in Files',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        open.connect('clicked', () => {
            GLib.mkdir_with_parents(this._folder(), 0o755);
            Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(this._folder(), null), null);
        });
        this._resetButton = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Back to ~/Pictures/Wallpapers',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this._resetButton.connect('clicked', () => this._settings.reset('wallpaper-folder'));
        this._folderRow.add_suffix(this._resetButton);
        this._folderRow.add_suffix(open);
        this._folderRow.add_suffix(choose);
        folderGroup.add(this._folderRow);

        const add = new Adw.ButtonRow({title: 'Add Pictures…', start_icon_name: 'list-add-symbolic'});
        add.connect('activated', () => this._addPictures().catch(e => toast(this, e.message)));
        folderGroup.add(add);

        this._picturesGroup = new Adw.PreferencesGroup({title: 'Pictures'});
        this.add(this._picturesGroup);
        this._grid = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            column_spacing: 10,
            row_spacing: 10,
            min_children_per_line: 2,
            max_children_per_line: 5,
            homogeneous: true,
        });
        this._picturesGroup.add(this._grid);

        this._changedId = settings.connect('changed::wallpaper-folder', () => this._refresh());
        this._refresh();
    }

    disconnectSettings() {
        this._settings.disconnect(this._changedId);
    }

    _folder() {
        return wallpaperFolder(this._settings);
    }

    async _refresh() {
        const folder = this._folder();
        this._folderRow.subtitle = home(folder);
        this._resetButton.visible = this._settings.get_string('wallpaper-folder') !== '';

        const paths = await listWallpapers(folder);
        let child;
        while ((child = this._grid.get_first_child()))
            this._grid.remove(child);
        this._picturesGroup.description = paths.length === 0
            ? 'No pictures yet. Add some, or put them into the folder.'
            : `${paths.length} picture${paths.length === 1 ? '' : 's'}`;
        for (const path of paths.slice(0, MAX_SHOWN)) {
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
            box.append(createThumbnail(path, 150).widget);
            box.append(new Gtk.Label({
                label: prettyName(path),
                ellipsize: 3, // Pango.EllipsizeMode.END
                max_width_chars: 18,
                css_classes: ['caption'],
            }));
            this._grid.append(box);
        }
    }

    async _chooseFolder() {
        const dialog = new Gtk.FileDialog({
            title: 'Wallpaper Folder',
            initial_folder: Gio.File.new_for_path(this._folder()),
        });
        let folder;
        try {
            folder = await dialog.select_folder(this.get_root(), null);
        } catch (e) {
            if (e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) ||
                e.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                return;
            throw e;
        }
        if (folder?.get_path())
            this._settings.set_string('wallpaper-folder', folder.get_path());
    }

    async _addPictures() {
        const paths = await chooseImages(this, true);
        if (paths.length === 0)
            return;
        const folder = this._folder();
        GLib.mkdir_with_parents(folder, 0o755);
        for (const path of paths) {
            const target = Gio.File.new_for_path(GLib.build_filenamev([folder, GLib.path_get_basename(path)]));
            if (target.query_exists(null))
                continue;
            await Gio.File.new_for_path(path).copy_async(target, Gio.FileCopyFlags.NONE,
                GLib.PRIORITY_DEFAULT, null, null);
        }
        toast(this, paths.length === 1 ? 'Added 1 picture' : `Added ${paths.length} pictures`);
        this._refresh();
    }
});
