// The glass clock's atlases: each a texture of its figures' signed
// distances (lib/glyphAtlas.js), for one instance of a font at one size and
// stretch and one density of pixels – made once, while the shell is idle
// (a few tiles at a time, never more than a few milliseconds of a frame),
// and kept in this process for whoever draws those figures next: the
// session makes them ahead of the lock screen (clock.js GlassWarmUp), the
// lock screen finds them made.

import GLib from 'gi://GLib';

import {atlasBytes, atlasRect, packTiles, strokeWidth} from '../../lib/glyphAtlas.js';
import {encodeSdf} from '../../lib/glyphSdf.js';
import {ShapeTexture} from '../core/glassShapeTexture.js';

// Atlases kept: the lock screen's clocks', the editor's while it stretches
// one, a font being tried.
const KEPT = 6;
// What one idle pass may take before it lets the shell draw, ms.
const PASS_TIME = 6;

const atlases = new Map();
const jobs = new Map();

/** Tiles made in this process, all told (the tests' count). */
export const made = {tiles: 0, atlases: 0, time: 0};

/**
 * @param {string} key
 * @returns {object|null} the atlas made for it, if it is kept: {key, from
 *   (the font it was made from), texture (ShapeTexture), size ([width,
 *   height] texels), tiles (Map: id → {tile, uv, thick})}
 */
export function atlasOf(key) {
    const atlas = atlases.get(key);
    if (!atlas)
        return null;
    // (The latest used last: the first to go is the one unused longest.)
    atlases.delete(key);
    atlases.set(key, atlas);
    return atlas;
}

/**
 * @param {string} key
 * @returns {boolean} whether an atlas is being made for it
 */
export function making(key) {
    return jobs.has(key);
}

class Job {
    constructor({key, from, parts}) {
        this.key = key;
        this._from = from;
        this._parts = parts;
        this._tiles = [];
        this._waiting = new Set();
        this._started = GLib.get_monotonic_time();
        this._spent = 0;
        this._idle = GLib.idle_add(GLib.PRIORITY_LOW, () => this._pass());
    }

    wait(request) {
        this._waiting.add(request);
    }

    leave(request) {
        this._waiting.delete(request);
        if (this._waiting.size === 0)
            this._stop();
    }

    // Tiles, a few at a time; the atlas once they are all made.
    _pass() {
        const start = GLib.get_monotonic_time();
        try {
            while (this._tiles.length < this._parts.length) {
                const part = this._parts[this._tiles.length];
                const sdf = part.make();
                this._tiles.push({
                    id: part.id,
                    tile: {width: sdf.width, height: sdf.height, x: sdf.x, y: sdf.y, texel: sdf.texel, ink: sdf.ink},
                    bytes: encodeSdf(sdf),
                    thick: strokeWidth(sdf),
                });
                made.tiles++;
                this._waiting.forEach(request => request.onTile?.());
                if ((GLib.get_monotonic_time() - start) / 1000 >= PASS_TIME)
                    return GLib.SOURCE_CONTINUE;
            }
            this._finish();
        } catch (e) {
            console.warn(`Atelier: the glass clock's figures weren't made: ${e.message}`);
            this._idle = 0;
            this._stop();
        } finally {
            this._spent += GLib.get_monotonic_time() - start;
        }
        return GLib.SOURCE_REMOVE;
    }

    _finish() {
        this._idle = 0;
        const packing = packTiles(this._tiles.map(({tile}) => [tile.width, tile.height]));
        const texture = new ShapeTexture({filter: 'linear'});
        texture.setPixels(atlasBytes(this._tiles.map(({tile, bytes}) => ({...tile, bytes})), packing),
            packing.width, packing.height);
        const tiles = new Map(this._tiles.map(({id, tile, thick}, i) =>
            [id, {tile, thick, uv: atlasRect(packing.places[i], tile, packing)}]));
        const atlas = {key: this.key, from: this._from, texture, size: [packing.width, packing.height], tiles};
        while (atlases.size >= KEPT)
            atlases.delete(atlases.keys().next().value);
        atlases.set(this.key, atlas);
        made.atlases++;
        made.time += this._spent / 1000;
        jobs.delete(this.key);
        const waiting = [...this._waiting];
        this._waiting.clear();
        waiting.forEach(request => request.onReady?.(atlas));
    }

    _stop() {
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        if (jobs.get(this.key) === this)
            jobs.delete(this.key);
    }
}

/**
 * Have an atlas made, unless it is kept: in passes while the shell is
 * idle, shared by whoever asks for it meanwhile; let go of by all who
 * asked, it stops.
 *
 * @param {object} spec
 * @param {string} spec.key - what it is of (the same key, the same atlas)
 * @param {string} spec.from - the font it is made from (an atlas of
 *   another size of it serves meanwhile; of another font, none)
 * @param {object[]} spec.parts - {id, make}: each tile's, make() making its
 *   signed distances (lib/glyphSdf.js glyphSdf()'s, with ink: [x, y,
 *   width, height] of the figure's ink in it, px)
 * @param {object} [request] - {onTile, onReady}: called as each tile is
 *   made, and with the atlas once it is
 * @returns {Function} lets go of it (the atlas still made for whoever else
 *   waits for it)
 */
export function makeAtlas(spec, request = {}) {
    const kept = atlasOf(spec.key);
    if (kept) {
        request.onReady?.(kept);
        return () => {};
    }
    let job = jobs.get(spec.key);
    if (!job) {
        job = new Job(spec);
        jobs.set(spec.key, job);
    }
    job.wait(request);
    return () => job.leave(request);
}
