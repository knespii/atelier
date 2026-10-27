// The glass clock's figures as the GPU draws them (shell/lockscreen/
// glassText.js): each figure's signed distances (lib/glyphSdf.js) a tile of
// one texture – the atlas – and each figure on the clock a slot: where its
// tile lies on the clock, and where in the atlas. A minute turning, a figure
// moves and fades: only its slot changes, never a tile. Stretched in the
// editor, a tile made for another size is laid over the figure's new ink
// (mappedPlace()) until one is made for the size it rests at. Pure, shared
// by the shell and the tests.

import {FAR, TEXEL} from './glyphSdf.js';

/** The atlas's width at most, texels (every GPU GNOME runs on takes 4096). */
export const ATLAS_WIDTH = 4096;
// Texels round each tile, as far from any outline as a texel says.
const PAD = 1;
// A texel far outside, as lib/glyphSdf.js encodeSdf() stores it.
const OUTSIDE = [255, 255, 128, 128];

/**
 * How thick a figure's strokes are, as its distances tell: twice as far as
 * its ink goes in from its outline (the middle of its thickest stroke).
 *
 * @param {object} sdf - lib/glyphSdf.js glyphSdf()'s or sdfFromMask()'s
 * @returns {number} px (of the tile's), 0 for no ink
 */
export function strokeWidth({distances}) {
    let deepest = 0;
    for (const d of distances) {
        if (d < deepest)
            deepest = d;
    }
    return -2 * deepest;
}

/**
 * Tiles packed into rows, left to right, as wide as `width` at most.
 *
 * @param {number[][]} sizes - [width, height] of each tile, texels
 * @param {number} [width] - texels
 * @returns {{width: number, height: number, places: number[][]}} the
 *   atlas's size, and [x, y] of each tile in it (each with PAD texels
 *   round it)
 */
export function packTiles(sizes, width = ATLAS_WIDTH) {
    const places = [];
    let [x, y, row, widest] = [0, 0, 0, 0];
    for (const [w, h] of sizes) {
        const [outerW, outerH] = [w + 2 * PAD, h + 2 * PAD];
        if (x > 0 && x + outerW > width) {
            y += row;
            [x, row] = [0, 0];
        }
        places.push([x + PAD, y + PAD]);
        x += outerW;
        row = Math.max(row, outerH);
        widest = Math.max(widest, x);
    }
    return {width: Math.max(1, widest), height: Math.max(1, y + row), places};
}

/**
 * The atlas's texels: each tile's bytes (lib/glyphSdf.js encodeSdf()) where
 * packTiles() put it, far outside all round them.
 *
 * @param {object[]} tiles - {width, height, bytes} each
 * @param {object} packing - packTiles()'s
 * @returns {Uint8Array} RGBA, width × 4 bytes a row
 */
export function atlasBytes(tiles, {width, height, places}) {
    const bytes = new Uint8Array(width * height * 4);
    const outside = new Uint32Array(Uint8Array.from(OUTSIDE).buffer)[0];
    new Uint32Array(bytes.buffer).fill(outside);
    tiles.forEach((tile, i) => {
        const [x, y] = places[i];
        for (let row = 0; row < tile.height; row++) {
            const from = row * tile.width * 4;
            bytes.set(tile.bytes.subarray(from, from + tile.width * 4), ((y + row) * width + x) * 4);
        }
    });
    return bytes;
}

/**
 * @param {number[]} place - [x, y] of a tile in the atlas, texels
 * @param {object} tile - {width, height} in texels
 * @param {object} atlas - {width, height} in texels
 * @returns {number[]} [u, v, du, dv]: where it is in the atlas's texture
 *   coordinates
 */
export function atlasRect([x, y], tile, atlas) {
    return [x / atlas.width, y / atlas.height, tile.width / atlas.width, tile.height / atlas.height];
}

/**
 * Where a tile lies on the clock, for the figure it was made for.
 *
 * @param {object} tile - {width (texels), height, x, y (px of the tile from
 *   its top left to the glyph's origin), texel (px a texel)}
 * @param {number[]} origin - [x, y] where the glyph's origin goes (its
 *   pen, its baseline), in the clock's pixels
 * @param {number} density - the tile's px in one of the clock's pixels
 * @returns {{box: number[], scale: number}} box: [x, y, width, height] in
 *   the clock's pixels; scale: its pixels in a px of the tile (what its
 *   distances are multiplied by)
 */
export function slotPlace(tile, [x, y], density) {
    const texel = tile.texel ?? TEXEL;
    return {
        box: [x - tile.x / density, y - tile.y / density, tile.width * texel / density, tile.height * texel / density],
        scale: 1 / density,
    };
}

/**
 * Where a tile lies on the clock for a figure of another size than it was
 * made for (stretched in the editor, the figure taller): its ink laid over
 * the figure's, scaled to it each way – its distances as much as the
 * lesser of the two.
 *
 * @param {object} tile - as for slotPlace(), and ink: [x, y, width,
 *   height] of the figure's ink in it, px
 * @param {object} ink - {x, y, width, height}: the figure's ink now, in the
 *   clock's pixels
 * @param {number} density
 * @returns {{box: number[], scale: number}} as slotPlace()'s
 */
export function mappedPlace(tile, ink, density) {
    const texel = tile.texel ?? TEXEL;
    const [ix, iy, iw, ih] = tile.ink;
    const kx = iw > 0 ? ink.width * density / iw : 1;
    const ky = ih > 0 ? ink.height * density / ih : 1;
    return {
        box: [ink.x - ix * kx / density, ink.y - iy * ky / density,
            tile.width * texel * kx / density, tile.height * texel * ky / density],
        scale: Math.min(kx, ky) / density,
    };
}

/**
 * How far round a slot its glass draws: its contour and glint, and its
 * halo – as far as a tile tells the distance (FAR), at most.
 *
 * @param {number} scale - a slot's (slotPlace())
 * @returns {number} its pixels
 */
export function slotReach(scale) {
    return FAR * scale;
}
