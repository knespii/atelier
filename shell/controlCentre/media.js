// The control centre's Now Playing module: the media player the session
// has (MPRIS on the session bus), its track's picture, title and artist,
// and previous / play-pause / next. The one playing, else the last one
// active (lib/mpris.js); "Not Playing" without one.
//
// MediaWatcher follows the players: the bus's NameOwnerChanged and
// ListNames for org.mpris.MediaPlayer2.* names, and a proxy for each one's
// Player interface, updated by its PropertiesChanged. Nothing is polled,
// nothing launched. The picture is loaded as GNOME's own media message
// loads it (ui/messageList.js): a Gio.FileIcon of the URI, which St loads
// asynchronously. On the lock screen the module watches nothing.

import Cogl from 'gi://Cogl';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {textureFrame} from '../../lib/glassLook.js';
import {becameActive, choosePlayer, isPlayerName, nowPlaying, parseMetadata, playbackStatus} from '../../lib/mpris.js';

const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

const RootProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
  <interface name="${ROOT_IFACE}">
    <property name="Identity" type="s" access="read"/>
    <property name="DesktopEntry" type="s" access="read"/>
  </interface>
</node>`);

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(`<node>
  <interface name="${PLAYER_IFACE}">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
  </interface>
</node>`);

/** A cached property of a proxy, unpacked all the way; undefined for none. */
function cached(proxy, name) {
    return proxy?.get_cached_property(name)?.recursiveUnpack();
}

/**
 * The media players on the session bus, and the one to show.
 * Signals: 'changed' (a player came, went or changed).
 */
export class MediaWatcher extends EventEmitter {
    /** @param {Gio.DBusConnection} [bus] - the session bus */
    constructor(bus = Gio.DBus.session) {
        super();
        this._bus = bus;
        this._players = new Map();
        this._tick = 0;
        this._subscription = 0;
        this._cancellable = null;
    }

    /** @returns {boolean} whether it watches the bus */
    get watching() {
        return this._subscription !== 0;
    }

    /** Watch the bus (again). */
    start() {
        if (this._subscription)
            return;
        this._cancellable = new Gio.Cancellable();
        // Subscribed before asking for the names: none comes in between.
        this._subscription = this._bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE, (_bus, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!isPlayerName(name))
                    return;
                if (oldOwner)
                    this._remove(name);
                if (newOwner)
                    this._add(name);
            });
        const cancellable = this._cancellable;
        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, cancellable, (bus, result) => {
                let names;
                try {
                    [names] = bus.call_finish(result).deepUnpack();
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Atelier: could not list the media players: ${e.message}`);
                    return;
                }
                if (!cancellable.is_cancelled())
                    names.filter(isPlayerName).forEach(name => this._add(name));
            });
    }

    /** Stop watching, and forget the players. */
    stop() {
        if (!this._subscription)
            return;
        this._bus.signal_unsubscribe(this._subscription);
        this._subscription = 0;
        this._cancellable.cancel();
        this._cancellable = null;
        const had = this._players.size > 0;
        for (const name of [...this._players.keys()])
            this._remove(name, false);
        if (had)
            this.emit('changed');
    }

    destroy() {
        this.stop();
        this.disconnectAll();
    }

    /** @returns {string[]} the players' bus names */
    get playerNames() {
        return [...this._players.keys()];
    }

    /** @returns {object|null} the player shown: {name, status, metadata, can…, identity, desktopEntry} */
    get current() {
        const name = choosePlayer([...this._players.values()].filter(p => p.ready));
        return name ? this._players.get(name) : null;
    }

    /** @returns {object} what to show of it, lib/mpris.js nowPlaying()'s */
    get state() {
        return nowPlaying(this.current);
    }

    /** @returns {Shell.App|null} the current player's app, by its DesktopEntry */
    get app() {
        const entry = this.current?.desktopEntry;
        return entry ? Shell.AppSystem.get_default().lookup_app(`${entry}.desktop`) : null;
    }

    playPause() {
        this._call('PlayPause');
    }

    next() {
        this._call('Next');
    }

    previous() {
        this._call('Previous');
    }

    _call(method) {
        const player = this.current;
        if (!player?.proxy)
            return;
        player.proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, player.cancellable, (proxy, result) => {
            try {
                proxy.call_finish(result);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.warn(`Atelier: ${player.name} did not take ${method}: ${e.message}`);
            }
        });
    }

    _add(name) {
        if (this._players.has(name) || !this._subscription)
            return;
        const player = {
            name, ready: false, proxy: null, root: null, cancellable: new Gio.Cancellable(),
            status: 'Stopped', metadata: parseMetadata(null), lastActive: ++this._tick,
            canPlay: false, canPause: false, canGoNext: false, canGoPrevious: false, canControl: true,
            identity: '', desktopEntry: '',
        };
        this._players.set(name, player);
        // (Only the bus name: the proxies follow whoever owns it.)
        new RootProxy(this._bus, name, MPRIS_PATH, (proxy, error) => {
            if (error || player.cancellable.is_cancelled())
                return;
            player.root = proxy;
            proxy.connectObject('g-properties-changed', () => this._refreshRoot(player), this);
            this._refreshRoot(player);
        }, player.cancellable);
        new PlayerProxy(this._bus, name, MPRIS_PATH, (proxy, error) => {
            if (player.cancellable.is_cancelled())
                return;
            if (error) {
                console.warn(`Atelier: media player ${name} has no player: ${error.message}`);
                this._remove(name);
                return;
            }
            player.proxy = proxy;
            proxy.connectObject('g-properties-changed', () => this._refresh(player), this);
            this._refresh(player, true);
        }, player.cancellable);
    }

    _refreshRoot(player) {
        player.identity = cached(player.root, 'Identity') ?? '';
        player.desktopEntry = cached(player.root, 'DesktopEntry') ?? '';
        if (player.ready)
            this.emit('changed');
    }

    _refresh(player, first = false) {
        const proxy = player.proxy;
        const status = playbackStatus(cached(proxy, 'PlaybackStatus'));
        if (becameActive(first ? null : player.status, status))
            player.lastActive = ++this._tick;
        player.status = status;
        player.metadata = parseMetadata(cached(proxy, 'Metadata'));
        for (const [key, prop] of [['canPlay', 'CanPlay'], ['canPause', 'CanPause'], ['canGoNext', 'CanGoNext'],
            ['canGoPrevious', 'CanGoPrevious']])
            player[key] = Boolean(cached(proxy, prop));
        player.canControl = cached(proxy, 'CanControl') !== false;
        player.ready = true;
        this.emit('changed');
    }

    _remove(name, notify = true) {
        const player = this._players.get(name);
        if (!player)
            return;
        this._players.delete(name);
        player.cancellable.cancel();
        player.proxy?.disconnectObject(this);
        player.root?.disconnectObject(this);
        if (notify && player.ready)
            this.emit('changed');
    }
}

// Rounds the corners of the album art (an St.Icon, which doesn't clip to
// a border-radius).
const DECLARATIONS = `
uniform vec2 origin;
uniform vec2 texSize;
uniform vec2 size;
uniform float radius;
`;
const CODE = `
vec2 p = origin + cogl_tex_coord_in[0].st * texSize;
vec2 q = abs(p - 0.5 * size) - (0.5 * size - vec2(radius));
float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
cogl_color_out *= clamp(0.5 - d, 0.0, 1.0);
`;

const RoundedCornersEffect = GObject.registerClass(
class AtelierMediaArtCorners extends Shell.GLSLEffect {
    _init(radius) {
        super._init();
        this._radius = radius;
        this._at = Object.fromEntries(['origin', 'texSize', 'size', 'radius']
            .map(name => [name, this.get_uniform_location(name)]));
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    vfunc_paint_target(node, paintContext) {
        const actor = this.get_actor();
        if (actor) {
            // (Clutter paints a box a little larger than the actor:
            // lib/glassLook.js textureFrame().)
            const [x, width] = textureFrame(actor.width);
            const [y, height] = textureFrame(actor.height);
            this.set_uniform_float(this._at.origin, 2, [x, y]);
            this.set_uniform_float(this._at.texSize, 2, [width, height]);
            this.set_uniform_float(this._at.size, 2, [actor.width, actor.height]);
            this.set_uniform_float(this._at.radius, 1, [this._radius]);
        }
        super.vfunc_paint_target(node, paintContext);
    }
});

const ART_SIZE = 56;
const ART_RADIUS = 12;
const PLACEHOLDER_ICON = 'audio-x-generic-symbolic';

/**
 * The module: ~2×2 cells of the control centre (about 162 px square).
 * `actor` is its widget; destroy() stops it.
 */
export class NowPlayingModule {
    /** @param {object} [options] - {watcher}: a MediaWatcher (one of its own by default, which it destroys) */
    constructor({watcher = null} = {}) {
        this._ownWatcher = !watcher;
        this._watcher = watcher ?? new MediaWatcher();
        this._artUri = '';
        this._destroyed = false;

        this.actor = new St.BoxLayout({
            style_class: 'atelier-cc-media',
            vertical: true,
            x_expand: true,
            y_expand: true,
            accessible_name: 'Now Playing',
        });

        this._artBox = new St.Widget({
            style_class: 'atelier-cc-media-art',
            layout_manager: new Clutter.BinLayout(),
            width: ART_SIZE,
            height: ART_SIZE,
            x_align: Clutter.ActorAlign.START,
        });
        this._artIcon = new St.Icon({
            style_class: 'atelier-cc-media-art-icon',
            icon_size: 30,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._art = new St.Icon({
            style_class: 'atelier-cc-media-art-image',
            icon_size: ART_SIZE,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this._art.add_effect(new RoundedCornersEffect(ART_RADIUS));
        this._artBox.add_child(this._artIcon);
        this._artBox.add_child(this._art);
        this.actor.add_child(this._artBox);

        const labels = new St.BoxLayout({
            style_class: 'atelier-cc-media-labels',
            vertical: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        this._title = new St.Label({style_class: 'atelier-cc-media-title'});
        this._artist = new St.Label({style_class: 'atelier-cc-media-artist'});
        for (const label of [this._title, this._artist]) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            labels.add_child(label);
        }
        this.actor.add_child(labels);

        const controls = new St.BoxLayout({
            style_class: 'atelier-cc-media-controls',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        const button = (icon, name, action) => {
            const b = new St.Button({
                style_class: 'atelier-cc-media-button',
                can_focus: true,
                x_expand: true,
                accessible_name: name,
                child: new St.Icon({icon_name: icon, style_class: 'atelier-cc-media-button-icon'}),
            });
            b.connect('clicked', () => {
                if (!Main.sessionMode.isLocked)
                    action();
            });
            controls.add_child(b);
            return b;
        };
        this.previousButton = button('media-skip-backward-symbolic', 'Previous', () => this._watcher.previous());
        this.playPauseButton = button('media-playback-start-symbolic', 'Play', () => this._watcher.playPause());
        this.nextButton = button('media-skip-forward-symbolic', 'Next', () => this._watcher.next());
        this.actor.add_child(controls);

        this._watcher.connectObject('changed', () => this._sync(), this);
        Main.sessionMode.connectObject('updated', () => this._followSession(), this);
        this.actor.connect('destroy', () => this.destroy());
        this._followSession();
        this._sync();
    }

    /** @returns {MediaWatcher} */
    get watcher() {
        return this._watcher;
    }

    /** @returns {object} what it shows: lib/mpris.js nowPlaying()'s */
    get state() {
        return this._state;
    }

    /** @returns {string} the title shown ("Not Playing" when idle) */
    get titleText() {
        return this._title.text;
    }

    /** @returns {string} the artist shown, '' for none */
    get artistText() {
        return this._artist.visible ? this._artist.text : '';
    }

    /** @returns {string} the URI of the picture shown, '' for none */
    get artUri() {
        return this._artUri;
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        Main.sessionMode.disconnectObject(this);
        this._watcher.disconnectObject(this);
        if (this._ownWatcher)
            this._watcher.destroy();
        this.actor.destroy();
    }

    // Nothing is watched on the lock screen.
    _followSession() {
        if (!this._ownWatcher)
            return;
        if (Main.sessionMode.isLocked)
            this._watcher.stop();
        else
            this._watcher.start();
    }

    _sync() {
        if (this._destroyed)
            return;
        const state = this._watcher.state;
        this._state = state;
        const idle = state.state === 'idle';
        this.actor.set_style_pseudo_class(idle ? 'idle' : null);
        const player = this._watcher.current;
        const app = idle ? null : this._watcher.app;
        this._title.text = idle ? 'Not Playing' : state.title || app?.get_name() || player?.identity || 'Unknown title';
        this._artist.text = state.artist;
        this._artist.visible = !idle && Boolean(state.artist);

        // The picture as GNOME's media message has it; without one, the
        // player's app's icon in the square.
        const uri = idle ? '' : state.artUrl;
        if (uri !== this._artUri) {
            this._artUri = uri;
            this._art.gicon = uri ? new Gio.FileIcon({file: Gio.File.new_for_uri(uri)}) : null;
        }
        const appIcon = app?.get_icon() ?? null;
        this._art.fallback_gicon = appIcon ?? new Gio.ThemedIcon({name: PLACEHOLDER_ICON});
        this._art.visible = Boolean(uri);
        this._artIcon.gicon = appIcon ?? new Gio.ThemedIcon({name: PLACEHOLDER_ICON});
        this._artIcon.visible = !idle && !uri;
        this._artBox.set_style_pseudo_class(uri ? 'art' : null);

        const playing = state.state === 'playing';
        this.playPauseButton.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this.playPauseButton.accessible_name = playing ? 'Pause' : 'Play';
        this.playPauseButton.reactive = state.canPlayPause;
        this.previousButton.reactive = state.canGoPrevious;
        this.nextButton.reactive = state.canGoNext;
    }
}
