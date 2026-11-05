// The control centre's type and icons, a module at a time (Apple's
// vibrancy, shell/core/vibrancy.js): each module – the tabs' bar, each card
// of the Controls tab, a menu's page, another tab – is a surface of its
// own, its rect the module's, its type light or dark for what is behind
// that module alone (a module over a light window dark, the one beside it
// over a dark wallpaper light), each with its own hysteresis. Its glass is
// as it is, darkened only as the glass-dim setting has it.
//
// What is behind is seen before the control centre opens: a small
// picture of that part of the screen, taken while the island is at rest
// (sampleStage()) – as the pointer comes onto it, and once it is back at
// rest after closing – the island at rest in it filled from what is just
// under it. As it opens, that picture is what is behind while it is
// recent and the windows there are where they were; else one is taken
// then. (Taking it costs a frame's worth of time: not in the frame the
// control centre opens in, nor while it grows.) Each module's part of it,
// blurred as its frosted glass blurs it, is what its type is to read on. Where a module lies outside it (a wider
// tab), or once the wallpaper or GNOME's style changed, what is behind is
// told as for the island's pages: the palette's surface where a window is
// under it, else the wallpaper there. Nothing of it is worked out while
// the island moves, nor per frame: as it opens, as its modules move, come
// or go, and as the wallpaper, the palette or the style change – and
// never while the island moves: once it has stopped (a stylesheet made
// anew restyles the whole shell). A module whose type turns light or dark
// while it shows fades out first and back in after.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {layersOf, sampleStage} from '../core/vibrancy.js';
import {windowsUnder} from '../island/module.js';
import {ControlModule} from './layout.js';

// The actors the classes go on, as the stylesheet has them: in the
// control centre in the island (as specific as stylesheet.css's own rules
// for GNOME's tiles, and more).
const INK_CLASS = 'atelier-cc-ink';
const ROOT = `.atelier-island .atelier-cc .${INK_CLASS}`;
// A module's part of the picture: so much of it at least, or the picture
// isn't what is behind it.
const COVERED = 0.9;
// Its type turning: out, then in (ms).
const VEIL_OUT = 120;
const VEIL_IN = 180;
// How long a picture of what is behind is taken to show it still (ms),
// the windows there where they were.
const FRESH = 3000;
// How often whether the island has stopped moving is looked at (ms), and
// for how long at most after it closed.
const SETTLE_POLL = 50;
const SETTLE_MAX = 2000;

/**
 * @param {string} id - a module's (page.js ModuleRect)
 * @param {Clutter.Actor} actor - the module
 * @returns {string} which of lib/vibrancy.js INKS
 */
export function inksOf(id, actor) {
    if (id === 'tabs')
        return 'ccTabs';
    if (id === 'detail')
        return 'ccDetail';
    return actor instanceof ControlModule ? 'ccModule' : 'ccPane';
}

// A picture of the screen with a part of it filled from the row just under
// it (or over it, at the bottom): what the island at rest covered.
function withHoleFilled(picture, hole) {
    const {rect, density, width, height, channels, rowstride} = picture;
    const x1 = Math.max(0, Math.floor((hole.x - rect.x) * density));
    const x2 = Math.min(width, Math.ceil((hole.x + hole.width - rect.x) * density));
    const y1 = Math.max(0, Math.floor((hole.y - rect.y) * density));
    const y2 = Math.min(height, Math.ceil((hole.y + hole.height - rect.y) * density));
    if (x2 <= x1 || y2 <= y1)
        return picture;
    const source = y2 < height ? y2 : y1 - 1;
    if (source < 0)
        return picture;
    const pixels = Uint8Array.from(picture.pixels);
    for (let row = y1; row < y2; row++) {
        const to = row * rowstride;
        pixels.copyWithin(to + x1 * channels, source * rowstride + x1 * channels, source * rowstride + x2 * channels);
    }
    return {...picture, pixels};
}

// The windows over a rectangle of the stage (on the workspace shown),
// where they are, in the order they are stacked: a picture of what is
// behind it shows them as long as this is the same.
function windowsKey({x, y, width, height}) {
    const workspace = global.workspace_manager.get_active_workspace();
    const windows = global.display.sort_windows_by_stacking(global.get_window_actors()
        .map(actor => actor.meta_window).filter(Boolean));
    return windows.filter(window => !window.minimized && window.showing_on_its_workspace() &&
        window.located_on_workspace(workspace)).map(window => [window, window.get_frame_rect()])
        .filter(([, f]) => f.x < x + width && f.x + f.width > x && f.y < y + height && f.y + f.height > y)
        .map(([window, f]) => `${window.get_id()}:${f.x},${f.y},${f.width},${f.height}`).join(';');
}

export class ControlCentreInk {
    /**
     * @param {object} params
     * @param {ModuleManager} params.modules
     */
    constructor({modules}) {
        this._modules = modules;
        // Each module's: {surface, actor, stage (its rect on the stage, as
        // it rests open), layers, overWindows, veiled}.
        this._states = new Map();
        this._vibrancy = null;
        this._page = null;
        this._picture = null;
        // (The one being taken or taken last: {key, time}; and the page's
        // size as it opened last, for a picture taken before it opens.)
        this._shot = null;
        this._size = null;
        this._serial = 0;
        this._stale = 0;
        this._idleId = 0;
        this._settleId = 0;
        this._prefetchId = 0;
        this._background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        // (What the picture shows is not what is behind any more.)
        this._background.connectObject('changed', () => this._stale++, this);
        this._interface.connectObject('changed::color-scheme', () => this._stale++, this);
        // (Ahead of an open: the pointer on the island at rest, or the
        // island back at rest.)
        this._island()?.connectObject(
            'notify::hover', () => this._island()?.hover && this._queuePrefetch(0),
            'page-closed', () => this._queuePrefetch(SETTLE_POLL),
            this);
    }

    /**
     * @param {string} id - a module's
     * @returns {object|null} its surface (shell/core/vibrancy.js), for the tests
     */
    surfaceOf(id) {
        return this._states.get(id)?.surface ?? null;
    }

    /** @returns {object|null} the picture of what is behind, as last seen ({rect, …}), for the tests */
    get picture() {
        return this._picture?.picture ?? null;
    }

    /**
     * The control centre is about to open into the island: what is behind
     * where it will be, seen now – the island still at rest.
     *
     * @param {ControlCentrePage} page - in the island already (adopted), not shown yet
     */
    capture(page) {
        const island = this._island();
        if (!this._vibrancyNow() || !island?.restRect())
            return;
        let [, width] = page.get_preferred_width(-1);
        if (page.fillsWidth)
            width = Math.max(width, island.layout_manager?.minPageWidth ?? 0);
        const [, height] = page.get_preferred_height(width);
        if (!(width > 0 && height > 0))
            return;
        this._size = [width, height];
        this._take();
    }

    // A picture of what is behind where the page opens, unless the one
    // there is (or is being taken) still shows it.
    _take() {
        const vibrancy = this._vibrancyNow();
        const island = this._island();
        const rest = island?.restRect();
        if (!vibrancy || !rest || !this._size)
            return;
        const [width, height] = this._size;
        const region = {x: rest[0] + rest[2] / 2 - width / 2, y: rest[1], width, height};
        const key = [this._stale, ...[region.x, region.y, width, height].map(Math.round),
            Main.overview.visible, windowsKey(region)].join(' ');
        const time = GLib.get_monotonic_time() / 1000;
        if (this._shot?.key === key && time - this._shot.time < FRESH)
            return;
        this._shot = {key, time};
        const [hx, hy] = island.get_transformed_position();
        const [hw, hh] = island.get_transformed_size();
        const hole = {x: hx, y: hy, width: hw, height: hh};
        const serial = ++this._serial;
        const stale = this._stale;
        sampleStage(region).then(picture => {
            if (serial !== this._serial || !this._vibrancy)
                return;
            this._picture = picture ? {picture: withHoleFilled(picture, hole), stale} : null;
            this._refresh();
        }).catch(e => {
            this._shot = null;
            console.warn(`Atelier: what is behind the control centre can't be seen: ${e.message}`);
        });
    }

    // Seen ahead, while the island is at rest without a page (and the
    // control centre has opened before: its size known), once it is.
    _queuePrefetch(delay) {
        if (this._prefetchId || !this._size)
            return;
        const start = GLib.get_monotonic_time() / 1000;
        this._prefetchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, delay, () => {
            const island = this._island();
            if (!island || island.page)
                return this._endPrefetch();
            if (this._moving(island)) {
                if (GLib.get_monotonic_time() / 1000 - start > SETTLE_MAX)
                    return this._endPrefetch();
                return GLib.SOURCE_CONTINUE;
            }
            this._take();
            return this._endPrefetch();
        });
    }

    _endPrefetch() {
        this._prefetchId = 0;
        return GLib.SOURCE_REMOVE;
    }

    _moving(island) {
        return ['x', 'width', 'height'].some(name => island.get_transition(name));
    }

    // What is behind worked out anew – once the island has stopped moving.
    _refresh() {
        if (this._settleId)
            return;
        const run = () => {
            const island = this._island();
            if (island && this._moving(island))
                return false;
            this._settleId = 0;
            this._vibrancy?.refresh();
            return true;
        };
        if (run())
            return;
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_POLL,
            () => (run() ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE));
    }

    /**
     * The control centre opened: its modules' type follows what is behind
     * each, as they move, come and go.
     *
     * @param {ControlCentrePage} page
     */
    attach(page) {
        this._page?.disconnectObject(this);
        this._page = page;
        page.connectObject(
            'modules-changed', () => this._queue(),
            'destroy', () => {
                if (this._page === page)
                    this._page = null;
            },
            this);
        this._queue();
    }

    destroy() {
        this._serial++;
        for (const id of [this._idleId, this._settleId, this._prefetchId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._idleId = this._settleId = this._prefetchId = 0;
        this._island()?.disconnectObject(this);
        this._page?.disconnectObject(this);
        this._page = null;
        this._background.disconnectObject(this);
        this._interface.disconnectObject(this);
        this._drop();
    }

    _island() {
        return this._modules.get('island')?.island ?? null;
    }

    // What colours type on glass, while the island is of glass.
    _vibrancyNow() {
        const vibrancy = this._modules.get('vibrancy') ?? null;
        const wanted = this._modules.get('island')?.glassy ? vibrancy : null;
        if (wanted !== this._vibrancy || [...this._states.values()].some(state =>
            wanted?.surfaceOf(state.surface.id) !== state.surface)) {
            this._drop();
            this._vibrancy = wanted;
        }
        return wanted;
    }

    _drop() {
        for (const state of this._states.values()) {
            state.actor?.disconnectObject(this);
            state.actor?.remove_style_class_name(INK_CLASS);
            state.actor?.remove_style_class_name(state.surface.scope);
            state.surface.destroy();
        }
        this._states.clear();
        this._picture = null;
        this._shot = null;
    }

    // (Not as the page is laid out: its handlers may not restyle it.)
    _queue() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Where each module rests open, what lies over its glass there and
    // whether windows are under it; anew where any of it changed.
    _sync() {
        const page = this._page;
        const island = this._island();
        const vibrancy = this._vibrancyNow();
        if (!page || !island || !vibrancy || !page.get_stage())
            return;
        const rest = island.restRect();
        if (!rest)
            return;
        // (As it rests open: centred under the island at rest, at its top;
        // where it is, once the island has stopped moving.)
        const moving = ['x', 'width', 'height'].some(name => island.get_transition(name));
        const [x, y] = moving
            ? [Math.round(rest[0] + rest[2] / 2 - page.width / 2), rest[1] + page.y]
            : page.get_transformed_position();
        let changed = false;
        for (const rect of page.moduleRects()) {
            let state = this._states.get(rect.id);
            if (!state) {
                state = {actor: null, stage: null, layers: [], overWindows: false, veiled: null};
                state.surface = this._surface(rect, state, vibrancy);
                this._states.set(rect.id, state);
                changed = true;
            }
            if (state.actor !== rect.actor) {
                state.actor?.disconnectObject(this);
                state.actor?.remove_style_class_name(INK_CLASS);
                state.actor?.remove_style_class_name(state.surface.scope);
                state.actor = rect.actor;
                state.actor.add_style_class_name(INK_CLASS);
                state.actor.add_style_class_name(state.surface.scope);
                // (The tabs' bar goes with the page.)
                state.actor.connectObject('destroy', () => {
                    state.actor = null;
                    state.veiled = null;
                }, this);
            }
            const stage = {x: Math.round(x + rect.x), y: Math.round(y + rect.y),
                width: Math.round(rect.width), height: Math.round(rect.height)};
            const layers = layersOf(island, rect.actor);
            const overWindows = windowsUnder(stage);
            if (JSON.stringify([stage, layers, overWindows]) !==
                JSON.stringify([state.stage, state.layers, state.overWindows])) {
                Object.assign(state, {stage, layers, overWindows});
                changed = true;
            }
        }
        if (changed)
            this._refresh();
    }

    _surface(rect, state, vibrancy) {
        const id = `cc-${rect.id}`;
        return vibrancy.surface({
            id,
            inks: inksOf(rect.id, rect.actor),
            roots: [ROOT],
            rect: () => state.stage,
            picture: () => (this._covers(state.stage) ? this._picture.picture : null),
            region: () => this._regionOf(state.stage),
            behind: () => (state.overWindows ? vibrancy.windowSurface() : null),
            // (GNOME's controls are on frosted glass: shell/island/module.js.)
            frosted: () => true,
            // (The tabs: a strip of the island's large glass.)
            small: rect.id === 'tabs' ? () => 0 : null,
            layers: () => state.layers,
            veil: this._veilOf(state),
        });
    }

    // The picture, while it is what is behind and the rect is in it.
    _covers(stage) {
        const rect = this._picture?.picture.rect;
        if (!rect || !stage || this._picture.stale !== this._stale)
            return false;
        const width = Math.min(stage.x + stage.width, rect.x + rect.width) - Math.max(stage.x, rect.x);
        const height = Math.min(stage.y + stage.height, rect.y + rect.height) - Math.max(stage.y, rect.y);
        return width > 0 && height > 0 && width * height >= COVERED * stage.width * stage.height;
    }

    _regionOf(stage) {
        const rect = this._picture?.picture.rect;
        if (!rect || !stage)
            return null;
        const x1 = Math.max(0, (stage.x - rect.x) / rect.width);
        const y1 = Math.max(0, (stage.y - rect.y) / rect.height);
        const x2 = Math.min(1, (stage.x + stage.width - rect.x) / rect.width);
        const y2 = Math.min(1, (stage.y + stage.height - rect.y) / rect.height);
        return [x1, y1, x2 - x1, y2 - y1];
    }

    // What shows a module's type: what is in it (not the module itself,
    // whose glass stays), faded out while its type turns – at once where
    // it doesn't show yet (the control centre still fading in).
    _veilOf(state) {
        const parts = () => state.actor?.get_children() ?? [];
        return {
            hide: () => new Promise(resolve => {
                const page = this._page;
                const island = this._island();
                const shows = page && island && page.opacity === 255 && state.actor?.mapped &&
                    !['width', 'height'].some(name => island.get_transition(name));
                if (!shows || state.veiled) {
                    resolve();
                    return;
                }
                state.veiled = new Map(parts().map(part => [part, part.opacity]));
                let left = state.veiled.size;
                // (A transition of an actor taken off the stage meanwhile
                // may never end.)
                const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VEIL_OUT + 150, () => {
                    left = 0;
                    resolve();
                    return GLib.SOURCE_REMOVE;
                });
                const done = () => {
                    if (left > 0 && --left === 0) {
                        GLib.source_remove(id);
                        resolve();
                    }
                };
                if (left === 0) {
                    GLib.source_remove(id);
                    resolve();
                }
                for (const part of state.veiled.keys()) {
                    part.ease({
                        opacity: 0,
                        duration: VEIL_OUT,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onStopped: done,
                    });
                }
            }),
            show: () => {
                const veiled = state.veiled;
                state.veiled = null;
                for (const [part, opacity] of veiled ?? []) {
                    part.ease({
                        opacity,
                        duration: VEIL_IN,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
            },
        };
    }
}
