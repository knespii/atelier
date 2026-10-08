// Places in the dock besides apps: the drives and the trash. Each is an
// icon of its own – a made-up Shell.App that opens the place in the file
// manager – with a menu of what can be done with it: empty the trash
// (once asked), unmount or eject a drive. The trash's icon is full while
// anything is in it. File manager windows showing a place go with its
// icon rather than with the file manager's, as long as the file manager
// says which places its windows show (see fileManager.js). One for all the
// docks; it says 'changed' when the places to show, or the windows that go
// with them, change.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ShellMountOperation from 'resource:///org/gnome/shell/ui/shellMountOperation.js';

import {execArgument, filterMounts, trashIcon, windowShowsLocation} from '../../lib/dockLocations.js';
import {FileManager1} from './fileManager.js';
import {DockIcon, DockItem} from './icon.js';
import {Timers} from './timers.js';

Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');

const TRASH_URI = 'trash:///';
const TRASH_ID = 'atelier-location:trash';
// The trash is looked at again this long after it last changed.
const TRASH_DELAY = 300;
const DRIVE_ICON = 'drive-removable-media';

const KEYS = ['show-trash', 'show-mounts', 'show-mounts-only-mounted', 'show-mounts-network', 'isolate-locations'];

// What the dock knows a place by: a Shell.App (GNOME's icon wants one)
// whose id, name and icon are the place's, and which opens it.
const LocationApp = GObject.registerClass({
    Signals: {'icon-changed': {}},
}, class AtelierLocationApp extends Shell.App {
    /**
     * @param {object} params
     * @param {string} params.id
     * @param {string} params.name
     * @param {string} params.uri - the place (for an unmounted drive, where
     *   it will be, or '')
     * @param {Gio.Icon} params.icon
     * @param {Function} params.open - opens it
     */
    _init({id, name, uri, icon, open}) {
        const keyFile = new GLib.KeyFile();
        keyFile.set_string('Desktop Entry', 'Type', 'Application');
        keyFile.set_string('Desktop Entry', 'Name', name);
        keyFile.set_string('Desktop Entry', 'Exec', `gio open ${execArgument(uri || TRASH_URI)}`);
        super._init({app_info: Gio.DesktopAppInfo.new_from_keyfile(keyFile)});
        this._locationId = id;
        this._name = name;
        this._gicon = icon;
        this._open = open;
        this.uri = uri;
    }

    get_id() {
        return this._locationId;
    }

    get_name() {
        return this._name;
    }

    create_icon_texture(size) {
        return new St.Icon({gicon: this._gicon, icon_size: size});
    }

    /** @param {Gio.Icon} icon */
    setIcon(icon) {
        if (icon.equal(this._gicon))
            return;
        this._gicon = icon;
        this.emit('icon-changed');
    }

    /** @returns {Gio.Icon} */
    get gicon() {
        return this._gicon;
    }

    // Clicked: the place opens (its windows come up, when it has some).
    activate() {
        this._open();
    }

    open_new_window() {
        this._open();
    }

    can_open_new_window() {
        return false;
    }
});

// A place's icon: its own picture (the trash's changes), its own menu.
const LocationIcon = GObject.registerClass(
class AtelierLocationIcon extends DockIcon {
    _init(app, iconSize, ctx, menuFor) {
        super._init(app, iconSize, ctx);
        this._menuFor = menuFor;
        app.connectObject('icon-changed', () => this.icon.update(), this);
    }

    popupMenu() {
        this.setForcedHighlight(true);
        this._removeMenuTimeout();
        this.fake_release();
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side[this._ctx.side] ?? St.Side.BOTTOM);
            this._menu.actor.add_style_class_name('app-menu');
            this._menu.connect('open-state-changed', (_, open) => {
                if (!open)
                    this._onMenuPoppedDown();
            });
            Main.overview.connectObject('hiding', () => this._menu.close(), this);
            Main.uiGroup.add_child(this._menu.actor);
            this._menuManager.addMenu(this._menu);
        }
        this._menu.removeAll();
        for (const entry of this._menuFor(this.app)) {
            if (!entry) {
                this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                continue;
            }
            const item = this._menu.addAction(entry.label, () => entry.action());
            item.setSensitive(entry.sensitive ?? true);
        }
        this.emit('menu-state-changed', true);
        this._menu.open(BoxPointer.PopupAnimation.FULL);
        this._menuManager.ignoreRelease();
        this.emit('sync-tooltip');
        return false;
    }

    _onDestroy() {
        this.app.disconnectObject(this);
        super._onDestroy();
    }
});

// Asks before the trash is emptied.
const EmptyTrashDialog = GObject.registerClass(
class AtelierEmptyTrashDialog extends ModalDialog.ModalDialog {
    _init(onEmpty) {
        super._init({styleClass: 'atelier-empty-trash-dialog'});
        this.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: 'Empty the trash?',
            description: 'Everything in the trash is deleted for good.',
        }));
        this.addButton({label: 'Cancel', action: () => this.close(), key: Clutter.KEY_Escape});
        this.addButton({
            label: 'Empty Trash',
            action: () => {
                this.close();
                onEmpty();
            },
        });
    }
});

// The trash: how many items are in it (its icon says whether any), and
// emptying it – by Files, which shows how far it got, or else item by
// item.
class Trash {
    /**
     * @param {Function} isGone - says when the answers of async calls no
     *   longer count
     */
    constructor(isGone) {
        this._isGone = isGone;
        this._file = Gio.File.new_for_uri(TRASH_URI);
        this._cancellable = new Gio.Cancellable();
        this._timers = new Timers();
        this.count = null;
        this.app = new LocationApp({
            id: TRASH_ID, name: 'Trash', uri: TRASH_URI,
            icon: new Gio.ThemedIcon({name: trashIcon({count: null})}),
            open: () => openUri(TRASH_URI, 'Trash', this._cancellable, this._isGone),
        });
        try {
            this._monitor = this._file.monitor_directory(Gio.FileMonitorFlags.NONE, this._cancellable);
            this._monitor.connect('changed', () => this._timers.after('update', TRASH_DELAY, () => this._update()));
        } catch (e) {
            console.warn(`Atelier dock: the trash can't be watched: ${e.message}`);
        }
        this._update();
    }

    _gone() {
        return this._cancellable.is_cancelled() || this._timers.stopped || this._isGone();
    }

    async _update() {
        let count;
        try {
            const info = await this._file.query_info_async('trash::item-count',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancellable);
            count = info.get_attribute_uint32('trash::item-count');
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`Atelier dock: the trash can't be read: ${e.message}`);
            return;
        }
        if (this._gone())
            return;
        this.count = count;
        this.app.setIcon(new Gio.ThemedIcon({name: trashIcon({count})}));
    }

    /** Ask, then empty it. */
    askToEmpty() {
        new EmptyTrashDialog(() => this.empty()).open();
    }

    /** Empty it, by Files (without asking again), or item by item. */
    async empty() {
        try {
            await new Promise((resolve, reject) => {
                Gio.DBus.session.call('org.gnome.Nautilus', '/org/gnome/Nautilus/FileOperations2',
                    'org.gnome.Nautilus.FileOperations2', 'EmptyTrash',
                    new GLib.Variant('(ba{sv})', [false, {
                        'timestamp': new GLib.Variant('u', global.get_current_time()),
                        'window-position': new GLib.Variant('s', 'center'),
                    }]),
                    null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (connection, result) => {
                        try {
                            connection.call_finish(result);
                            resolve();
                        } catch (e) {
                            reject(e);
                        }
                    });
            });
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || this._gone())
                return;
            await this.deleteItems();
        }
    }

    /**
     * Delete what is in it, item by item.
     *
     * @returns {Promise<boolean>} whether everything went
     */
    async deleteItems() {
        let failed = null;
        try {
            const children = await this._file.enumerate_children_async('standard::name',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_DEFAULT, this._cancellable);
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const infos = await children.next_files_async(50, GLib.PRIORITY_DEFAULT, this._cancellable);
                if (infos.length === 0)
                    break;
                for (const info of infos) {
                    try {
                        // eslint-disable-next-line no-await-in-loop
                        await this._file.get_child(info.get_name()).delete_async(GLib.PRIORITY_DEFAULT, this._cancellable);
                    } catch (e) {
                        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                            return false;
                        failed ??= e;
                    }
                }
            }
            await children.close_async(GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return false;
            failed ??= e;
        }
        if (failed && !this._gone())
            Main.notifyError('The trash could not be emptied', failed.message);
        return !failed;
    }

    destroy() {
        this._cancellable.cancel();
        this._monitor?.cancel();
        this._monitor = null;
        this._timers.destroy();
    }
}

/**
 * Open a place in the app for it (the file manager).
 *
 * @param {string} uri
 * @param {string} name - for the error
 * @param {Gio.Cancellable} cancellable
 * @param {Function} isGone
 */
function openUri(uri, name, cancellable, isGone) {
    const context = global.create_app_launch_context(global.get_current_time(), -1);
    Gio.AppInfo.launch_default_for_uri_async(uri, context, cancellable, (_, result) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(result);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) && !isGone())
                Main.notifyError(`${name} could not be opened`, e.message);
        }
    });
}

// An error worth saying: not one the user saw already, nor a cancelled call.
const worthSaying = e => !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) &&
    !e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.FAILED_HANDLED);

// A drive, as filterMounts() wants it, from a volume, its mount or both.
function describeDrive(volume, mount) {
    const root = mount?.get_default_location() ?? mount?.get_root() ?? volume?.get_activation_root() ?? null;
    const name = mount?.get_name() ?? volume.get_name();
    const key = volume?.get_uuid() ?? volume?.get_identifier('unix-device') ?? mount?.get_uuid() ??
        root?.get_uri() ?? name;
    return {
        id: `atelier-location:drive:${key}`,
        name,
        uri: root?.get_uri() ?? '',
        icon: mount?.get_icon() ?? volume?.get_icon() ?? new Gio.ThemedIcon({name: DRIVE_ICON}),
        mounted: Boolean(mount),
        network: volume?.get_identifier('class') === 'network' || (root !== null && !root.is_native()),
        usable: mount ? mount.can_unmount() || mount.can_eject() : volume.can_mount() || volume.can_eject(),
        shadowed: mount?.is_shadowed() ?? false,
        volume,
        mount,
    };
}

export class Locations extends EventEmitter {
    /**
     * @param {Gio.Settings} settings - the dock's
     */
    constructor(settings) {
        super();
        this._settings = settings;
        this._timers = new Timers();
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._trash = null;
        this._drives = []; // {place, app}, in their order
        this._volumeMonitor = null;
        this._fileManager = null;
        settings.connectObject(...KEYS.flatMap(key => [`changed::${key}`, () => this._sync()]), this);
        this._sync();
    }

    // The answers of async calls no longer count.
    get _gone() {
        return this._destroyed || this._timers.stopped;
    }

    // The trash, the drives and the file manager's windows, as the
    // settings say.
    _sync() {
        const before = this._signature();
        const showTrash = this._settings.get_boolean('show-trash');
        if (showTrash && !this._trash) {
            this._trash = new Trash(() => this._gone);
        } else if (!showTrash && this._trash) {
            this._trash.destroy();
            this._trash = null;
        }

        const showDrives = this._settings.get_boolean('show-mounts');
        if (showDrives && !this._volumeMonitor) {
            this._volumeMonitor = Gio.VolumeMonitor.get();
            const queue = () => this._timers.idle('drives', () => this._onMountsChanged());
            this._volumeMonitor.connectObject(
                ...['mount-added', 'mount-removed', 'mount-changed', 'volume-added', 'volume-removed', 'volume-changed']
                    .flatMap(signal => [signal, queue]),
                this);
        } else if (!showDrives && this._volumeMonitor) {
            this._volumeMonitor.disconnectObject(this);
            this._volumeMonitor = null;
            this._timers.clear('drives');
        }
        this._onMountsChanged(undefined, false);

        const isolate = this._settings.get_boolean('isolate-locations') && (showTrash || showDrives);
        if (isolate && !this._fileManager) {
            this._fileManager = new FileManager1();
            this._fileManager.connectObject('changed', () => this.emit('changed'), this);
        } else if (!isolate && this._fileManager) {
            this._fileManager.disconnectObject(this);
            this._fileManager.destroy();
            this._fileManager = null;
        }
        this._isolate = isolate;

        if (this._signature() !== before)
            this.emit('changed');
    }

    // What the docks show of it: the places, and whose the windows are.
    _signature() {
        return `${this.apps().map(app => app.get_id()).join('\n')}\n${this._isolate}`;
    }

    // The drives, as the volume monitor knows them.
    _readMounts() {
        if (!this._volumeMonitor)
            return [];
        const drives = this._volumeMonitor.get_volumes().map(volume => describeDrive(volume, volume.get_mount()));
        for (const mount of this._volumeMonitor.get_mounts()) {
            if (!mount.get_volume())
                drives.push(describeDrive(null, mount));
        }
        return drives;
    }

    /**
     * The drives changed: those to show now. (The checks pass made-up ones.)
     *
     * @param {object[]} [drives] - as describeDrive() makes them
     * @param {boolean} [notify] - say so when the drives shown change
     */
    _onMountsChanged(drives = this._readMounts(), notify = true) {
        if (this._destroyed)
            return;
        const before = this._signature();
        const shown = this._settings.get_boolean('show-mounts')
            ? filterMounts(drives, {
                onlyMounted: this._settings.get_boolean('show-mounts-only-mounted'),
                network: this._settings.get_boolean('show-mounts-network'),
            }) : [];
        const old = new Map(this._drives.map(drive => [drive.place.id, drive]));
        this._drives = shown.map(place => {
            const drive = old.get(place.id);
            if (!drive) {
                const entry = {place};
                entry.app = new LocationApp({
                    id: place.id, name: place.name, uri: place.uri, icon: place.icon,
                    open: () => this._openDrive(entry.place),
                });
                return entry;
            }
            drive.place = place;
            drive.app.uri = place.uri;
            drive.app.setIcon(place.icon);
            return drive;
        });
        if (notify && this._signature() !== before)
            this.emit('changed');
    }

    /** @returns {Shell.App[]} the places to show, in their order: the drives, then the trash */
    apps() {
        const apps = this._drives.map(drive => drive.app);
        if (this._trash)
            apps.push(this._trash.app);
        return apps;
    }

    // One of the places shown.
    _isPlace(app) {
        return app instanceof LocationApp && this.apps().includes(app);
    }

    /**
     * The dock's item for a place.
     *
     * @param {Shell.App} app - one of apps(), or any other app
     * @param {number} iconSize
     * @param {object} ctx - the icon's context: {dock, settings, services, side}
     * @returns {DockItem|null} the item, or null for an app that isn't a place
     */
    createItem(app, iconSize, ctx) {
        if (!this._isPlace(app))
            return null;
        return new DockItem(app, iconSize, ctx, new LocationIcon(app, iconSize, ctx, a => this._menuFor(a)));
    }

    /**
     * @param {Shell.App} app
     * @returns {Meta.Window[]|null} the windows of a place (none unless they
     *   go with it), or null for an app that isn't one
     */
    windowsFor(app) {
        if (!(app instanceof LocationApp))
            return null;
        if (!this._isolate || !this._fileManager || !app.uri)
            return [];
        return this._fileManager.windowsAt(app.uri);
    }

    /**
     * @param {Meta.Window} window
     * @returns {boolean} whether the window goes with a place (and not with
     *   the file manager)
     */
    owns(window) {
        if (!this._isolate || !this._fileManager)
            return false;
        const shown = this._fileManager.locationsOf(window);
        return shown.length > 0 && this.apps().some(app => windowShowsLocation(app.uri, shown));
    }

    // A place's menu: [{label, action, sensitive}, or null for a line].
    _menuFor(app) {
        if (this._trash && app === this._trash.app) {
            return [
                {label: 'Open', action: () => app.activate()},
                null,
                {label: 'Empty Trash…', action: () => this._trash?.askToEmpty(), sensitive: this._trash.count !== 0},
            ];
        }
        const place = this._drives.find(drive => drive.app === app)?.place;
        if (!place)
            return [];
        const entries = [{label: 'Open', action: () => app.activate()}];
        const unmount = place.mount?.can_unmount();
        const eject = (place.mount ?? place.volume)?.can_eject();
        if (unmount || eject)
            entries.push(null);
        if (unmount)
            entries.push({label: 'Unmount', action: () => this._unmount(place)});
        if (eject)
            entries.push({label: 'Eject', action: () => this._eject(place)});
        return entries;
    }

    // Open a drive, mounting it first when it isn't.
    _openDrive(place) {
        if (place.mount || !place.volume) {
            openUri(place.uri, place.name, this._cancellable, () => this._gone);
            return;
        }
        const operation = new ShellMountOperation.ShellMountOperation(place.volume);
        place.volume.mount(Gio.MountMountFlags.NONE, operation.mountOp, this._cancellable, (volume, result) => {
            operation.close();
            try {
                volume.mount_finish(result);
            } catch (e) {
                if (worthSaying(e) && !this._gone)
                    Main.notifyError(`${place.name} could not be mounted`, e.message);
                return;
            }
            const root = volume.get_mount()?.get_default_location();
            if (root && !this._gone)
                openUri(root.get_uri(), place.name, this._cancellable, () => this._gone);
        });
    }

    _unmount(place) {
        const operation = new ShellMountOperation.ShellMountOperation(place.mount);
        place.mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, operation.mountOp, this._cancellable,
            (mount, result) => {
                operation.close();
                try {
                    mount.unmount_with_operation_finish(result);
                } catch (e) {
                    if (worthSaying(e) && !this._gone)
                        Main.notifyError(`${place.name} could not be unmounted`, e.message);
                }
            });
    }

    _eject(place) {
        const target = place.mount ?? place.volume;
        const operation = new ShellMountOperation.ShellMountOperation(target);
        target.eject_with_operation(Gio.MountUnmountFlags.NONE, operation.mountOp, this._cancellable,
            (source, result) => {
                operation.close();
                try {
                    source.eject_with_operation_finish(result);
                } catch (e) {
                    if (worthSaying(e) && !this._gone)
                        Main.notifyError(`${place.name} could not be ejected`, e.message);
                }
            });
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._settings.disconnectObject(this);
        this._volumeMonitor?.disconnectObject(this);
        this._volumeMonitor = null;
        this._drives = [];
        this._trash?.destroy();
        this._trash = null;
        this._fileManager?.disconnectObject(this);
        this._fileManager?.destroy();
        this._fileManager = null;
        this._timers.destroy();
        this.disconnectAll();
    }
}
