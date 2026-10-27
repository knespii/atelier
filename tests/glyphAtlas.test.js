import {ATLAS_WIDTH, atlasBytes, atlasRect, mappedPlace, packTiles, slotPlace, slotReach, strokeWidth} from '../lib/glyphAtlas.js';
import {FAR, TEXEL, decodeTexel, encodeSdf, glyphSdf} from '../lib/glyphSdf.js';
import {assert, assertEqual} from './util.js';

const near = (a, b, tolerance, message) =>
    assert(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);

// A rectangle, y up (font units), wound as fonts wind their outer contours.
const rect = (x, y, w, h) => [['M', x, y], ['L', x, y + h], ['L', x + w, y + h], ['L', x + w, y], ['Z']];

export function testStrokeWidth() {
    const stem = glyphSdf(rect(0, 0, 40, 300), {scale: 1});
    near(strokeWidth(stem), 40, TEXEL, 'a stem 40 px wide: its strokes as thick');
    const bar = glyphSdf(rect(0, 0, 300, 24), {scale: 1});
    near(strokeWidth(bar), 24, TEXEL, 'a bar: as thick as it is high');
    assertEqual(strokeWidth({distances: Float32Array.of(3, 5, 9)}), -0, 'no ink: none');
}

export function testPackTiles() {
    const packed = packTiles([[10, 20], [30, 5], [4090, 8], [7, 7]]);
    // (A texel round each.)
    assertEqual(packed.places[0], [1, 1], 'the first in the corner, a texel in');
    assertEqual(packed.places[1], [13, 1], 'the next beside it');
    assertEqual(packed.places[2], [1, 23], 'one too wide for the row: on the next');
    assertEqual(packed.places[3], [1, 33], 'and the next under that');
    assert(packed.width <= ATLAS_WIDTH && packed.width === 4092 && packed.height === 33 + 7 + 1,
        `as large as they take (${packed.width} × ${packed.height})`);
    assertEqual(packTiles([]), {width: 1, height: 1, places: []}, 'none');
}

export function testAtlasBytes() {
    const tiles = [
        {width: 2, height: 1, bytes: Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)},
        {width: 1, height: 2, bytes: Uint8Array.of(9, 9, 9, 9, 10, 10, 10, 10)},
    ];
    const packing = packTiles(tiles.map(t => [t.width, t.height]));
    const bytes = atlasBytes(tiles, packing);
    const texel = (x, y) => [...bytes.slice((y * packing.width + x) * 4, (y * packing.width + x) * 4 + 4)];
    assertEqual(texel(1, 1), [1, 2, 3, 4], 'each tile where it was put');
    assertEqual(texel(2, 1), [5, 6, 7, 8]);
    assertEqual(texel(5, 2), [10, 10, 10, 10]);
    assertEqual(texel(0, 0), [255, 255, 128, 128], 'far outside all round them');
    assertEqual(decodeTexel(texel(3, 1)).distance, FAR, 'between them too');
    assertEqual(atlasRect(packing.places[1], tiles[1], packing),
        [5 / packing.width, 1 / packing.height, 1 / packing.width, 2 / packing.height], 'where it is in the texture');
}

export function testSlotPlace() {
    const commands = rect(10, 0, 50, 100);
    // At 150 %: the tile's pixels two of the clock's (its resource scale).
    const sdf = glyphSdf(commands, {scale: 2});
    const place = slotPlace(sdf, [300, 400], 2);
    // (The ink starts FAR px of the tile in: 10 font units right of the pen.)
    near(place.box[0] + FAR / 2, 300 + 10, 1e-9, 'its ink where the glyph\'s is, across');
    near(place.box[1] + FAR / 2, 400 - 100, 1e-9, 'and down, the baseline at the origin');
    near(place.box[2], sdf.width * TEXEL / 2, 1e-9, 'as wide as its texels, in the clock\'s pixels');
    assertEqual(place.scale, 0.5, 'its distances, in the clock\'s pixels');
    assertEqual(slotReach(place.scale), FAR / 2, 'as far round as a tile tells');
    // Bytes in and out, as the GPU reads them: inside, near the edge.
    const bytes = encodeSdf(sdf);
    const i = Math.floor((FAR + 4) / TEXEL);
    const j = Math.floor((FAR + 100) / TEXEL);
    const read = decodeTexel([...bytes.slice((j * sdf.width + i) * 4, (j * sdf.width + i) * 4 + 4)]);
    assert(read.distance < 0 && read.distance > -6 && read.normal[0] < -0.9, `just in from its left edge (${JSON.stringify(read)})`);
}

export function testMappedPlace() {
    const sdf = glyphSdf(rect(0, 0, 40, 100), {scale: 1});
    const tile = {...sdf, ink: [FAR, FAR, 40, 100]};
    // Made for its own size: the same place as slotPlace() gives it.
    const own = mappedPlace(tile, {x: 100 - 0, y: 300 - 100, width: 40, height: 100}, 1);
    const placed = slotPlace(tile, [100, 300], 1);
    own.box.forEach((v, k) => near(v, placed.box[k], 1e-9, `box ${k}`));
    // Stretched twice as tall: its ink over the new one, the distances as
    // the lesser of the two ways.
    const taller = mappedPlace(tile, {x: 100, y: 100, width: 40, height: 200}, 1);
    near(taller.box[1] + FAR * 2, 100, 1e-9, 'its ink at the top of the new one');
    near(taller.box[3], sdf.height * TEXEL * 2, 1e-9, 'twice as tall');
    near(taller.box[2], sdf.width * TEXEL, 1e-9, 'as wide');
    assertEqual(taller.scale, 1, 'distances as across');
}
