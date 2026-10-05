// Circular wallpaper reveal.
//
// The new wallpaper is drawn by our own Meta.BackgroundActor on top of the
// desktop background (but below all windows) and uncovered by a growing
// circle. Once it fills the screen the caller writes the settings; GNOME then
// swaps in its own background actor underneath ours (fading the old one out
// over a second), and only after the old actors are gone is the overlay
// removed, so the swap itself is never visible.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GDesktopEnums from 'gi://GDesktopEnums';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const EFFECT_NAME = 'bgc-reveal';
const PRELOAD_TIMEOUT = 5000; // ms
const SWAP_TIMEOUT = 4000; // ms to wait for GNOME's background to catch up
const OVERLAY_FADE_TIME = 200; // ms

const DECLARATIONS = `
uniform float progress;
uniform float aspect;
uniform float feather;
`;

// Texture coordinates run 0..1 on both axes; scale x by the aspect ratio so
// the mask is a circle, and grow it until it covers the corners.
const CODE = `
vec2 p = cogl_tex_coord_in[0].xy - vec2(0.5);
p.x *= aspect;
float radius = progress * (length(vec2(0.5 * aspect, 0.5)) + feather);
cogl_color_out *= 1.0 - smoothstep(radius - feather, radius, length(p));
`;

const CircleRevealEffect = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.float(
            'progress', null, null,
            GObject.ParamFlags.READWRITE,
            0, 1, 0),
    },
}, class CircleRevealEffect extends Shell.GLSLEffect {
    _init(params) {
        this._progress = 0;
        super._init(params);

        this._progressLocation = this.get_uniform_location('progress');
        this._aspectLocation = this.get_uniform_location('aspect');
        this._featherLocation = this.get_uniform_location('feather');

        this.set_uniform_float(this._progressLocation, 1, [0]);
        this.set_uniform_float(this._featherLocation, 1, [0.035]);
        this.setAspect(16 / 9);
    }

    vfunc_build_pipeline() {
        // Not a replacement: the snippet runs after the texture lookup. The
        // color is premultiplied, so all four channels get the mask.
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE, false);
    }

    setAspect(aspect) {
        this.set_uniform_float(this._aspectLocation, 1, [aspect]);
        this.queue_repaint();
    }

    get progress() {
        return this._progress;
    }

    set progress(value) {
        if (this._progress === value)
            return;
        this._progress = value;
        this.set_uniform_float(this._progressLocation, 1, [value]);
        this.queue_repaint();
        this.notify('progress');
    }
});

function styleFor(pictureOptions) {
    return GDesktopEnums.BackgroundStyle[pictureOptions.toUpperCase()] ??
        GDesktopEnums.BackgroundStyle.ZOOM;
}

export class WallpaperTransition {
    /**
     * @param {Gio.Settings} settings - the extension's settings
     */
    constructor(settings) {
        this._settings = settings;
        this._session = null;
    }

    /**
     * Reveal a wallpaper with a growing circle.
     *
     * @param {Gio.File} file - the new wallpaper
     * @param {string} pictureOptions - e.g. 'zoom'
     * @returns {Promise<Function|null>} null when nothing was animated;
     *   otherwise a function to call after the settings were written, which
     *   resolves once the overlay is gone
     */
    async reveal(file, pictureOptions) {
        this.abort();

        if (this._settings.get_string('transition') !== 'circle' ||
            !this._canAnimate() || this._isCurrent(file, pictureOptions))
            return null;

        const session = {overlays: [], timeouts: new Set(), cancelled: false, image: null};
        this._session = session;

        session.image = await this._preload(file, session);
        if (!session.image || session.cancelled || !this._canAnimate()) {
            this._finish(session);
            return null;
        }

        const background = new Meta.Background({meta_display: global.display});
        background.set_file(file, styleFor(pictureOptions));
        const [ok, color] = Cogl.Color.from_string(
            new Gio.Settings({schema_id: 'org.gnome.desktop.background'}).get_string('primary-color'));
        if (ok)
            background.set_color(color);

        const group = Main.layoutManager._backgroundGroup;
        for (const monitor of Main.layoutManager.monitors) {
            const actor = new Meta.BackgroundActor({
                meta_display: global.display,
                monitor: monitor.index,
                request_mode: Clutter.RequestMode.CONTENT_SIZE,
            });
            actor.content.set({background, vignette: false});
            actor.set_position(monitor.x, monitor.y);

            const effect = new CircleRevealEffect();
            effect.setAspect(monitor.width / monitor.height);
            actor.add_effect_with_name(EFFECT_NAME, effect);

            group.add_child(actor); // last child = drawn above GNOME's backgrounds
            session.overlays.push(actor);
        }

        Main.layoutManager.connectObject('monitors-changed', () => this.abort(), session);
        Main.overview.connectObject('showing', () => this.abort(), session);

        const duration = this._settings.get_uint('transition-duration');
        await Promise.all(session.overlays.map(actor => new Promise(resolve => {
            actor.ease_property(`@effects.${EFFECT_NAME}.progress`, 1, {
                duration,
                mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
                onStopped: resolve,
            });
        })));

        if (session.cancelled) {
            this._finish(session);
            return null;
        }

        // Fully opaque now: drop the effect so it stops rendering offscreen.
        for (const actor of session.overlays)
            actor.remove_effect_by_name(EFFECT_NAME);

        const oldBackgrounds = Main.layoutManager._bgManagers
            .map(manager => manager.backgroundActor)
            .filter(Boolean);
        return () => this._waitForSwap(session, oldBackgrounds);
    }

    /** Stop a running transition and remove the overlay immediately. */
    abort() {
        const session = this._session;
        if (!session)
            return;
        session.cancelled = true;
        for (const actor of session.overlays)
            actor.remove_all_transitions();
        this._finish(session);
    }

    _canAnimate() {
        return St.Settings.get().enable_animations &&
            !Main.sessionMode.isLocked &&
            !Main.overview.visible &&
            !Main.layoutManager.screenTransition.visible &&
            Main.layoutManager._backgroundGroup !== undefined &&
            Main.layoutManager._bgManagers?.length > 0;
    }

    _isCurrent(file, pictureOptions) {
        const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        const dark = iface.get_string('color-scheme') === 'prefer-dark';
        const uri = (dark && background.get_string('picture-uri-dark')) ||
            background.get_string('picture-uri');
        return uri === file.get_uri() &&
            background.get_string('picture-options') === pictureOptions;
    }

    _addTimeout(session, ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            session.timeouts.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        session.timeouts.add(id);
    }

    /** Load the image into mutter's cache, which GNOME's own background reuses. */
    _preload(file, session) {
        return new Promise(resolve => {
            const image = Meta.BackgroundImageCache.get_default().load(file);
            if (image.is_loaded()) {
                resolve(image.get_success() ? image : null);
                return;
            }
            let done = false;
            const finish = result => {
                if (done)
                    return;
                done = true;
                image.disconnectObject(session);
                resolve(result);
            };
            image.connectObject('loaded',
                () => finish(image.get_success() ? image : null), session);
            this._addTimeout(session, PRELOAD_TIMEOUT, () => finish(null));
        });
    }

    _waitForSwap(session, oldBackgrounds) {
        return new Promise(resolve => {
            if (session.cancelled) {
                resolve();
                return;
            }
            session.onFinished = resolve;

            let pending = oldBackgrounds.length;
            const removeOverlays = () => {
                if (session.cancelled || session.removing)
                    return;
                session.removing = true;
                // GNOME's background below is identical by now; a short fade
                // hides any difference (e.g. in the fill color).
                for (const actor of session.overlays) {
                    actor.ease({
                        opacity: 0,
                        duration: OVERLAY_FADE_TIME,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
                this._addTimeout(session, OVERLAY_FADE_TIME, () => this._finish(session));
            };

            if (pending === 0) {
                removeOverlays();
                return;
            }
            for (const actor of oldBackgrounds) {
                actor.connectObject('destroy', () => {
                    if (--pending === 0)
                        removeOverlays();
                }, session);
            }
            this._addTimeout(session, SWAP_TIMEOUT, removeOverlays);
        });
    }

    _finish(session) {
        for (const id of session.timeouts)
            GLib.source_remove(id);
        session.timeouts.clear();

        Main.layoutManager.disconnectObject(session);
        Main.overview.disconnectObject(session);
        session.image?.disconnectObject?.(session);

        for (const actor of session.overlays)
            actor.destroy();
        session.overlays = [];
        session.image = null;

        if (this._session === session)
            this._session = null;

        session.onFinished?.();
        session.onFinished = null;
    }
}
