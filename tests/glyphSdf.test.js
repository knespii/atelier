import {bundledFile, fontAt} from '../lib/glyphOutlines.js';
import {FAR, NEAR, TEXEL, decodeTexel, encodeSdf, glyphSdf, sdfFromMask, tileFor} from '../lib/glyphSdf.js';
import {inkOf} from '../lib/glyphStretch.js';
import {assert} from './util.js';

// A circle as fonts draw one: four cubic quarters, counter-clockwise (y
// up) – or clockwise.
function circle(cx, cy, r, clockwise = false) {
    const k = 0.5522847498 * r;
    const s = clockwise ? -1 : 1;
    return [
        ['M', cx + r, cy],
        ['C', cx + r, cy + s * k, cx + k, cy + s * r, cx, cy + s * r],
        ['C', cx - k, cy + s * r, cx - r, cy + s * k, cx - r, cy],
        ['C', cx - r, cy - s * k, cx - k, cy - s * r, cx, cy - s * r],
        ['C', cx + k, cy - s * r, cx + r, cy - s * k, cx + r, cy],
        ['Z'],
    ];
}

// A square from (x, y), its side `side`, either way round.
function square(x, y, side, clockwise = false) {
    const corners = [[x, y], [x + side, y], [x + side, y + side], [x, y + side]];
    if (clockwise)
        corners.reverse();
    return [['M', ...corners[0]], ...corners.slice(1).map(c => ['L', ...c]), ['Z']];
}

// Each texel's middle, in px of the tile (y down).
const middle = (sdf, i, j) => [(i + 0.5) * sdf.texel, (j + 0.5) * sdf.texel];

// The worst difference between a tile's distances and the true ones, where
// the true one is within the band; and that past it all are as far as it.
function worstAgainst(sdf, truth) {
    let worst = 0;
    for (let j = 0; j < sdf.height; j++) {
        for (let i = 0; i < sdf.width; i++) {
            const d = sdf.distances[j * sdf.width + i];
            const t = truth(...middle(sdf, i, j));
            if (Math.abs(t) < sdf.band - sdf.texel)
                worst = Math.max(worst, Math.abs(d - t));
            else if (Math.abs(t) > sdf.band + sdf.texel)
                assert(d === Math.sign(t) * sdf.band, `past the band, as far as it (${d} for ${t})`);
        }
    }
    return worst;
}

export function testCircle() {
    for (const r of [20, 100, 300]) {
        const sdf = glyphSdf(circle(0, 0, r), {scale: 1});
        const truth = (x, y) => Math.hypot(x - sdf.x, y - sdf.y) - r;
        const worst = worstAgainst(sdf, truth);
        assert(worst <= 0.5 * TEXEL, `a circle of ${r} px: within half a texel (${worst.toFixed(3)} px)`);
        assert(worst <= 0.15, `a circle of ${r} px: within the flattening's tolerance (${worst.toFixed(3)} px)`);
        assert(sdf.width === Math.ceil((2 * r + 2 * FAR) / TEXEL), `a tile as wide as the ink and the band (${sdf.width})`);
    }
    // Font units to px, and narrower.
    const sdf = glyphSdf(circle(500, 500, 400), {scale: 0.25});
    const worst = worstAgainst(sdf, (x, y) => Math.hypot(x - sdf.x - 125, y - sdf.y + 125) - 100);
    assert(worst <= 0.15, `at a quarter of its units (${worst.toFixed(3)} px)`);
}

export function testSquare() {
    const side = 120;
    const sdf = glyphSdf(square(0, 0, side), {scale: 1});
    // (The square's middle, in px of the tile.)
    const [cx, cy] = [sdf.x + side / 2, sdf.y - side / 2];
    const truth = (x, y) => {
        const [qx, qy] = [Math.abs(x - cx) - side / 2, Math.abs(y - cy) - side / 2];
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
    };
    const worst = worstAgainst(sdf, truth);
    assert(worst <= 1e-3, `a square: exact (${worst})`);
}

export function testWinding() {
    // Two squares overlapping, both the same way round: where they overlap
    // is inside too (nonzero: an even-odd fill would leave it out).
    const both = glyphSdf([...square(0, 0, 100), ...square(50, 0, 100)], {scale: 1});
    const at = (sdf, x, y) => sdf.distances[Math.floor((sdf.y - y) / sdf.texel) * sdf.width +
        Math.floor((sdf.x + x) / sdf.texel)];
    assert(at(both, 75, 50) < -20, `overlapping the same way: inside (${at(both, 75, 50)})`);
    // (And no edge where one square's side lies inside the other: as far
    // from any edge there as the band tells.)
    assert(at(both, 101, 50) <= -FAR + 1 && at(both, 49, 50) <= -FAR + 1,
        `no edge inside, where they overlap (${at(both, 49, 50)}, ${at(both, 101, 50)})`);
    // One inside the other the other way round: a hole.
    const ring = glyphSdf([...square(0, 0, 200), ...square(50, 50, 100, true)], {scale: 1});
    assert(at(ring, 100, 100) > 20 && at(ring, 25, 100) < -10, `the other way round: a hole (${at(ring, 100, 100)})`);
    // Inter's "0": its counter outside, its stroke inside, at both sides.
    const font = fontAt(bundledFile('Inter.ttf'), 'wght=600,opsz=32');
    const commands = font.outline(font.glyphOf('0')).commands;
    const scale = 400 / (font.figures.top - font.figures.bottom);
    const sdf = glyphSdf(commands, {scale});
    const ink = inkOf(commands);
    const [midX, midY] = [(ink.x1 + ink.x2) / 2 * scale, (ink.y1 + ink.y2) / 2 * scale];
    const stroke = font.figures.stroke * scale;
    assert(at(sdf, midX, midY) > 20, `"0": its counter outside (${at(sdf, midX, midY)})`);
    for (const x of [ink.x1 * scale + stroke / 2, ink.x2 * scale - stroke / 2]) {
        assert(at(sdf, x, midY) < -stroke / 2 + 2 * TEXEL && at(sdf, x, midY) < 0,
            `"0": its stroke inside, its middle half a stroke in (${at(sdf, x, midY)}, ${stroke / 2})`);
    }
    // Where it changes sign, the row through the middle: its four edges.
    const row = Math.floor((sdf.y - midY) / sdf.texel) * sdf.width;
    let changes = 0;
    for (let i = 1; i < sdf.width; i++)
        changes += Math.sign(sdf.distances[row + i]) !== Math.sign(sdf.distances[row + i - 1]) ? 1 : 0;
    assert(changes === 4, `"0": four edges across its middle (${changes})`);
}

export function testStretched() {
    const font = fontAt(bundledFile('Inter.ttf'), 'wght=600,opsz=32');
    const scale = 300 / (font.figures.top - font.figures.bottom);
    for (const char of ['1', '0', ':']) {
        const glyph = font.glyphOf(char);
        for (const [stretch, scaleX] of [[1, 1], [2.5, 1], [2.5, 0.6]]) {
            const commands = font.stretched(glyph, stretch);
            const ink = inkOf(commands);
            const tile = tileFor(commands, {scale, scaleX});
            const sdf = glyphSdf(commands, {scale, scaleX, tile});
            assert(Math.abs(sdf.height * TEXEL - ((ink.y2 - ink.y1) * scale + 2 * FAR)) < TEXEL,
                `"${char}" ×${stretch}: a tile as tall as it is stretched`);
            assert(Math.abs(sdf.width * TEXEL - ((ink.x2 - ink.x1) * scale * scaleX + 2 * FAR)) < TEXEL,
                `"${char}" ×${stretch}, ${scaleX} across: as wide`);
            // Its ink's box, where the distances say: the first and last
            // rows and columns with any texel inside, within a texel.
            let [x1, y1, x2, y2] = [Infinity, Infinity, -Infinity, -Infinity];
            for (let j = 0; j < sdf.height; j++) {
                for (let i = 0; i < sdf.width; i++) {
                    if (sdf.distances[j * sdf.width + i] < 0) {
                        [x1, x2] = [Math.min(x1, i), Math.max(x2, i)];
                        [y1, y2] = [Math.min(y1, j), Math.max(y2, j)];
                    }
                }
            }
            const box = [x1 * TEXEL, y1 * TEXEL, (x2 + 1) * TEXEL, (y2 + 1) * TEXEL];
            const expected = [FAR, FAR, FAR + (ink.x2 - ink.x1) * scale * scaleX, FAR + (ink.y2 - ink.y1) * scale];
            assert(box.every((v, k) => Math.abs(v - expected[k]) <= TEXEL),
                `"${char}" ×${stretch}, ${scaleX}: inside where its ink is (${box} for ${expected.map(v => v.toFixed(1))})`);
        }
    }
}

export function testEncodeRoundTrip() {
    // A row of distances from -40 to 40 px.
    const width = 801;
    const distances = Float32Array.from({length: width}, (_, i) => Math.max(-FAR, Math.min(FAR, -40 + i * 0.1)));
    const bytes = encodeSdf({width, height: 1, texel: TEXEL, distances});
    assert(bytes.length === width * 4 && bytes instanceof Uint8Array, 'four bytes a texel');
    for (let i = 0; i < width; i++) {
        const d = distances[i];
        const {distance, normal} = decodeTexel(bytes.subarray(i * 4, i * 4 + 4));
        const step = Math.abs(d) < NEAR - 3 ? NEAR / 127 : FAR / 127;
        assert(Math.abs(distance - d) <= step / 2 + 1e-6, `${d.toFixed(1)} px: ${distance} back`);
        if (Math.abs(d) < FAR)
            assert(Math.abs(normal[0] - 1) < 0.01 && Math.abs(normal[1]) < 0.01, `${d.toFixed(1)} px: the normal right (${normal})`);
    }
    assert(bytes[400 * 4] === 128 && bytes[400 * 4 + 1] === 128, 'the outline at 128');
    // A circle's normals point away from its middle.
    const r = 60;
    const sdf = glyphSdf(circle(0, 0, r), {scale: 1});
    const encoded = encodeSdf(sdf);
    let worst = 0;
    for (let j = 0; j < sdf.height; j++) {
        for (let i = 0; i < sdf.width; i++) {
            const [x, y] = middle(sdf, i, j);
            const [dx, dy] = [x - sdf.x, y - sdf.y];
            const length = Math.hypot(dx, dy);
            if (Math.abs(length - r) > FAR - 2 * TEXEL)
                continue;
            const k = j * sdf.width + i;
            const {distance, normal} = decodeTexel(encoded.subarray(k * 4, k * 4 + 4));
            worst = Math.max(worst, Math.hypot(normal[0] - dx / length, normal[1] - dy / length));
            assert(Math.abs(distance - (length - r)) <= 0.5 * TEXEL, `decoded within half a texel (${distance}, ${length - r})`);
        }
    }
    assert(worst < 0.03, `a circle's normals outward (${worst.toFixed(4)})`);
}

export function testMask() {
    // A circle's coverage, 4 × 4 samples a pixel.
    const [width, height, r, c] = [160, 140, 40.3, [80.2, 69.6]];
    const alpha = new Uint8Array(width * height);
    for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
            let covered = 0;
            for (let s = 0; s < 16; s++)
                covered += Math.hypot(i + (s % 4 + 0.5) / 4 - c[0], j + (Math.floor(s / 4) + 0.5) / 4 - c[1]) < r ? 1 : 0;
            alpha[j * width + i] = Math.round(covered / 16 * 255);
        }
    }
    for (const texel of [1, 2]) {
        const sdf = sdfFromMask(alpha, width, height, {texel});
        assert(sdf.width === width / texel && sdf.height === height / texel, `${texel}: its size`);
        const truth = (x, y) => Math.hypot(x - c[0], y - c[1]) - r;
        const worst = worstAgainst(sdf, truth);
        assert(worst <= Math.max(1, 0.5 * texel), `from a mask, texel ${texel}: within half a texel, a pixel (${worst.toFixed(3)})`);
    }
    // With a stride, and nothing in it: all outside, as far as the band.
    const empty = sdfFromMask(new Uint8Array(20 * 10), 16, 10, {stride: 20});
    assert(empty.distances.every(d => d === FAR), 'nothing: all outside');
}
