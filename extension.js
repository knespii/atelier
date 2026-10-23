// Atelier: profiles, palette and a desktop built around them.
// This file only takes over BG Changer's data and starts the modules.
//
// Atelier stays enabled on the lock screen (session mode unlock-dialog)
// for its island with the padlock. Everything else stops while the screen
// is locked, as it did when GNOME turned Atelier off for the lock screen,
// and starts again once it is unlocked; only shell/lockscreen runs then,
// and it neither launches anything nor takes the keyboard.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {LEGACY_SCHEMA, migrateFromBgChanger} from './lib/migrate.js';
import {onTime} from './lib/steadyTime.js';
import {ProfileStore} from './lib/profiles.js';
import {registerFonts} from './shell/core/fonts.js';
import {ModuleManager} from './shell/core/moduleManager.js';
import {releaseKeptStyles} from './shell/core/theme.js';
import {BarModule} from './shell/bar/module.js';
import {ClaudeModule} from './shell/claude/module.js';
import {ControlCentreModule} from './shell/controlCentre/module.js';
import {DepthModule} from './shell/depthModule.js';
import {DesktopModule} from './shell/desktop/module.js';
import {DockModule} from './shell/dock/module.js';
import {GlassBackdropModule} from './shell/glassBackdropModule.js';
import {IslandModule} from './shell/island/module.js';
import {LockModule} from './shell/lockscreen/module.js';
import {LockPreviewModule} from './shell/lockscreen/preview.js';
import {WindowAnimationsModule} from './shell/windows/module.js';
import {NotesModule} from './shell/notes/module.js';
import {NotificationsModule} from './shell/notifications/module.js';
import {OtherExtensionsModule} from './shell/otherExtensions.js';
import {PaletteModule} from './shell/paletteModule.js';
import {ProfilesModule} from './shell/profilesModule.js';

// Unlocked, the lock screen goes once the shell is calm again: so many
// frames in a row on time – or after this long at most, ms.
const CALM_FRAMES = 6;
const CALM_LONGEST = 2500;

export default class AtelierExtension extends Extension {
    enable() {
        // (The lock screen's fonts, in this process only: once in its life.)
        registerFonts();
        this._settings = this.getSettings();
        const context = {
            extension: this,
            settings: this._settings,
            store: new ProfileStore(this._settings),
        };
        this.modules = new ModuleManager(context);
        context.modules = this.modules;
        this.modules.register('palette', ctx => new PaletteModule(ctx));
        this.modules.register('profiles', ctx => new ProfilesModule(ctx));
        this.modules.register('island', ctx => new IslandModule(ctx),
            {settings: this._settings.get_child('island'), key: 'enabled'});
        this.modules.register('notifications', ctx => new NotificationsModule(ctx),
            {settings: this._settings.get_child('notifications'), key: 'enabled'});
        this.modules.register('claude', ctx => new ClaudeModule(ctx));
        this.modules.register('control-centre', ctx => new ControlCentreModule(ctx),
            {settings: this._settings.get_child('control-centre'), key: 'enabled'});
        this.modules.register('bar', ctx => new BarModule(ctx));
        this.modules.register('desktop', ctx => new DesktopModule(ctx),
            {settings: this._settings.get_child('desktop'), key: 'enabled'});
        this.modules.register('notes', ctx => new NotesModule(ctx),
            {settings: this._settings.get_child('notes'), key: 'enabled'});
        this.modules.register('dock', ctx => new DockModule(ctx),
            {settings: this._settings.get_child('dock'), key: 'enabled'});
        this.modules.register('windows', ctx => new WindowAnimationsModule(ctx),
            {settings: this._settings.get_child('windows'), key: 'enabled'});
        // (Placing the lock screen's widgets happens in the session.)
        this.modules.register('lockscreen-editor', ctx => new LockPreviewModule(ctx));
        // (And the cutouts of the wallpaper for its depth effect, made then,
        // as the glass clock's frosted wallpaper is.)
        this.modules.register('depth', ctx => new DepthModule(ctx),
            {settings: this._settings.get_child('lockscreen'), key: 'depth-effect'});
        this.modules.register('glass-backdrop', ctx => new GlassBackdropModule(ctx),
            {settings: this._settings.get_child('lockscreen'), key: 'enabled'});
        // (Other extensions' settings kept out of Atelier's way, as asked.)
        this.modules.register('other-extensions', ctx => new OtherExtensionsModule(ctx));

        // What runs while the screen is locked.
        this.lockModules = new ModuleManager(context);
        this.lockModules.register('lockscreen', ctx => new LockModule(ctx),
            {settings: this._settings.get_child('lockscreen'), key: 'enabled'});
        this._afterglow = null;
        this._unlockLater = 0;
        this._ready = false;
        Main.sessionMode.connectObject('updated', () => this._syncSession(), this);

        // BG Changer's data has to be taken over before anything reads the
        // profiles, otherwise the first run would save a second "Original".
        const modules = this.modules;
        migrateFromBgChanger(this._settings, this._legacySettings())
            .then(result => {
                if (result.migrated)
                    console.log(`Atelier: took over ${result.profiles} profiles from BG Changer`);
            })
            .catch(e => console.error('Atelier: taking over BG Changer data failed', e))
            .finally(() => {
                if (this.modules !== modules)
                    return;
                this._ready = true;
                this._syncSession();
            });
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        this._cancelUnlockLater();
        this._slideAway();
        this.lockModules.disable();
        this._afterglow?.destroy();
        this._afterglow = null;
        this.modules.disable();
        releaseKeptStyles();
        this.modules = null;
        this.lockModules = null;
        this._settings = null;
    }

    // Locked, the session's modules stop at once (their keybindings and
    // everything they show over the lock screen with them) and the lock
    // screen's start; unlocked, the other way round.
    _syncSession() {
        if (!this._ready)
            return;
        const modules = this.modules;
        if (Main.sessionMode.isLocked) {
            this._cancelUnlockLater();
            modules.disable();
            this.lockModules.enable();
            this._holdSlideAway();
            return;
        }
        if (!this.lockModules.enabled) {
            modules.enable();
            return;
        }
        // Just unlocked: the padlock plays on over the island built anew,
        // which waits until GNOME has let go of the lock screen – and comes
        // out of the top edge once the padlock has gone back up.
        this._afterglow?.destroy();
        this._afterglow = null;
        // (Gone at once, without the padlock out.)
        let afterglow = null;
        afterglow = this.lockModules.get('lockscreen')?.handOver(() => {
            if (this._afterglow === afterglow)
                this._afterglow = null;
            this.modules?.get('island')?.comeOut();
            this.modules?.get('bar')?.comeOut();
        }) ?? null;
        this._afterglow = afterglow?.actor ? afterglow : null;
        this.lockModules.disable();
        // Meanwhile GNOME's bar shows as plain GNOME's, the other
        // extensions' buttons coming into it as they go on (the shell
        // stopped for a while): out of sight until Atelier is built.
        this._veilPanel(true);
        // All of it at once, before the first frame after the unlock (in
        // turn, plain GNOME showed for a moment) – but after GNOME has
        // turned its other extensions on again, in this same turn of the
        // main loop: each of their stylesheets (and a shell theme) restyles
        // everything there is, and Atelier built before them was restyled
        // with every one.
        this._unlockLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._unlockLater = 0;
            if (this.modules !== modules || Main.sessionMode.isLocked) {
                this._veilPanel(false);
                this._slideAway();
                return GLib.SOURCE_REMOVE;
            }
            try {
                modules.enable();
                this._veilPanel(false);
                // (Out of the top edge, the bar and the island, once the
                // padlock has gone back up.)
                if (this._afterglow) {
                    modules.get('island')?.tuckAway();
                    modules.get('bar')?.tuckAway();
                }
            } finally {
                this._veilPanel(false);
                this._slideAway();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Unlocked, GNOME turns its other extensions on again in one go, and
    // the shell stops a while – over the bare desktop, the lock screen gone
    // at once. It stays instead, the padlock open, until that is over,
    // Atelier is built under it and the shell is calm again, and then goes
    // at once, as GNOME has it go (no slide: the user found it jerky, and
    // not Atelier's); GNOME finishes with it as it would have.
    _holdSlideAway() {
        const shield = Main.screenShield;
        if (!shield || this._shieldInjections)
            return;
        this._shieldInjections = new InjectionManager();
        const extension = this;
        this._shieldInjections.overrideMethod(shield, '_continueDeactivate', original => function (...args) {
            const group = this._lockDialogGroup;
            const moves = [];
            group.ease = params => moves.push(params);
            try {
                original.call(this, ...args);
            } finally {
                delete group.ease;
            }
            extension._slide = () => extension._dropCurtain(group, moves);
            // (Atelier built at once, no stop to wait for.)
            if (!extension._unlockLater)
                extension._slideAway();
        });
    }

    _slideAway() {
        const slide = this._slide;
        this._slide = null;
        this._shieldInjections?.clear();
        this._shieldInjections = null;
        slide?.();
    }

    /**
     * @param {Clutter.Actor} group - GNOME's lock screen
     * @param {object[]} moves - its eases GNOME asked for, held back
     */
    _dropCurtain(group, moves) {
        let done = false;
        const finish = () => {
            if (done)
                return;
            done = true;
            this._curtain?.stop();
            this._curtain = null;
            for (const {onStopped, onComplete, ...params} of moves) {
                // (Each as GNOME asked, at once.)
                group.ease({...params, duration: 0, delay: 0});
                onStopped?.(true);
                onComplete?.();
            }
        };
        // Calm: frames on time, as the monitor has them.
        const rate = group.peek_stage_views()[0]?.get_refresh_rate?.() || 60;
        let calm = 0;
        const timeline = new Clutter.Timeline({actor: group, duration: 1000, repeat_count: -1});
        timeline.connect('new-frame', () => {
            calm = onTime(timeline.get_delta(), 1000 / rate) ? calm + 1 : 0;
            if (calm >= CALM_FRAMES)
                finish();
        });
        let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CALM_LONGEST, () => {
            timeoutId = 0;
            finish();
            return GLib.SOURCE_REMOVE;
        });
        // (Gone with the UI as the shell quits: nothing of it may go on.)
        const destroyId = group.connect('destroy', () => this._curtain?.stop());
        this._curtain = {
            finish,
            stop: () => {
                timeline.stop();
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                timeoutId = 0;
                group.disconnect(destroyId);
                this._curtain = null;
            },
        };
        timeline.start();
    }

    // (Locked again, or Atelier turned off, while it waits: gone at once.)
    _finishCurtain() {
        this._curtain?.finish();
    }

    _cancelUnlockLater() {
        if (this._unlockLater)
            global.compositor.get_laters().remove(this._unlockLater);
        this._unlockLater = 0;
        this._veilPanel(false);
        // (A lock screen held back goes now: GNOME finishes with it.)
        if (this._slide)
            this._slideAway();
        this._finishCurtain();
    }

    /** @param {boolean} veiled - GNOME's bar out of sight (or back as it was) */
    _veilPanel(veiled) {
        if (veiled === (this._panelOpacity !== undefined))
            return;
        if (veiled) {
            this._panelOpacity = Main.panel.opacity;
            Main.panel.opacity = 0;
        } else {
            Main.panel.opacity = this._panelOpacity;
            this._panelOpacity = undefined;
        }
    }

    _legacySettings() {
        const source = Gio.SettingsSchemaSource.new_from_directory(
            this.dir.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false);
        const schema = source.lookup(LEGACY_SCHEMA, false);
        return schema ? new Gio.Settings({settings_schema: schema}) : null;
    }
}
