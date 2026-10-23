import {blend, contrastLc, minimumLc} from '../lib/apca.js';
import {
    CUBE, TINT, clockColors, colorCube, regionPixels, tenths, typeColors, wallpaperColors,
} from '../lib/lockColor.js';
import {extractSwatches, hexToOklch, hexToRgb, rgbToOklab} from '../lib/palette.js';
import {assert, assertEqual} from './util.js';

// The pixels of a picture 96 × 60 (as the lock screen samples one): each
// colour on its share of them, with a little noise (as a photo has).
function picture(parts, total = 96 * 60) {
    let seed = 7;
    const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 6;
    const pixels = [];
    for (const [hex, share] of parts) {
        const rgb = hexToRgb(hex);
        for (let i = 0; i < Math.round(share * total); i++)
            pixels.push(rgb.map(v => Math.max(0, Math.min(255, Math.round(v + noise())))));
    }
    return pixels;
}

// A sample as sampleWallpaper() has it: the left half one colour, the right
// half another.
function sample(left, right, width = 16, height = 10) {
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++)
            pixels.set(hexToRgb(x < width / 2 ? left : right), (y * width + x) * 3);
    }
    return {pixels, channels: 3, rowstride: width * 3, width, height};
}

const hueDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const labOf = hex => rgbToOklab(hexToRgb(hex));
const distance = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const RED = '#d8322b';

// Three big muted areas (dark, slate, light gray) and a small red patch.
const muted = () => picture([['#101418', 0.35], ['#5a6472', 0.32], ['#c8ccd2', 0.30], [RED, 0.03]]);

export function testRegionPixels() {
    const two = sample('#000000', '#ffffff');
    const left = regionPixels(two, [0, 0, 0.5, 1]);
    assert(left.length === 80 && left.every(rgb => rgb.join() === '0,0,0'), 'the left half, black');
    assertEqual(regionPixels(two, [0.5, 0, 0.5, 1]).length, 80, 'the right half');
    assertEqual(regionPixels(two, [0.99, 0.99, 0.001, 0.001]), [[255, 255, 255]], 'even a tiny part has a pixel');
    // Padded rows and a fourth channel: as the pixbuf has them.
    const padded = {pixels: new Uint8Array([9, 8, 7, 255, 0, 0, 1, 2, 3, 255, 0, 0]), channels: 4, rowstride: 6, width: 1, height: 2};
    assertEqual(regionPixels(padded, [0, 0, 1, 1]), [[9, 8, 7], [1, 2, 3]]);
}

export function testTenths() {
    const grays = [0, 20, 40, 60, 80, 100, 120, 140, 160, 180].map(v => [v, v, v]).reverse();
    assertEqual(tenths(grays), {dark: '#141414', middle: '#646464', light: '#b4b4b4'},
        'a tenth up from the darkest, half way, a tenth down from the lightest');
    assertEqual(tenths([]), null);
}

export function testColorCube() {
    // One colour: one, all of it.
    const flat = colorCube(picture([['#3a6ea5', 1]], 400));
    assert(flat.length === 1 && flat[0].share === 1 && distance(flat[0].lab, labOf('#3a6ea5')) < 0.02,
        JSON.stringify(flat));
    // Two: two, each its share.
    const two = colorCube(picture([['#3a6ea5', 0.7], ['#e9b949', 0.3]], 1000));
    assert(two.length === 2 && Math.abs(two[0].share - 0.7) < 1e-9 && Math.abs(two[1].share - 0.3) < 1e-9,
        two.map(c => `${c.hex} ${c.share}`).join());
    // A few stray pixels are no colour of the picture.
    const stray = colorCube([...picture([['#3a6ea5', 1]], 990), ...picture([['#e9b949', 1]], 5)]);
    assertEqual(stray.length, 1, `under ${CUBE.least} of the pixels: none`);
    // Where the pixels thin out round a dense colour, only it (the two in
    // cells side by side).
    const gradient = [...picture([['#888888', 1]], 300), ...picture([['#989898', 1]], 100)];
    assertEqual(colorCube(gradient).map(c => c.share), [1], 'the denser cell, not its neighbour');
    assertEqual(colorCube(gradient, {cells: 8}).length, 1);
    const apart = [...picture([['#888888', 1]], 300), ...picture([['#a8a8a8', 1]], 100)];
    assertEqual(colorCube(apart).length, 2, 'a cell between them: two');
    assertEqual(colorCube([]), []);
}

export function testColorCubeFindsWhatKMeansLumpsIn() {
    const pixels = muted();
    // k-means with three clusters for four colours lumps the small red in
    // with the slate: no red of its own.
    const means = extractSwatches(Uint8Array.from(pixels.flat()), {k: 3});
    assert(means.every(swatch => hexToOklch(swatch.hex)[1] < 0.05),
        `k-means: no vivid colour (${means.map(s => s.hex)})`);
    // Color Cube finds it, as it is, and its share.
    const cube = colorCube(pixels);
    const red = cube.find(color => distance(color.lab, labOf(RED)) < 0.03);
    assert(red && Math.abs(red.share - 0.03) < 0.005, `Color Cube: the red (${cube.map(c => `${c.hex} ${c.share}`)})`);
    // Together: the four, the red Color Cube's only, the rest found by both
    // (Color Cube's own colour kept, not k-means' average of the slate and the red).
    const colors = wallpaperColors(pixels, {k: 3});
    assertEqual(colors.length, 4, colors.map(c => c.hex).join());
    assertEqual(colors.find(c => distance(c.lab, labOf(RED)) < 0.03)?.by, ['cube']);
    const slate = colors.find(c => distance(c.lab, labOf('#5a6472')) < 0.03);
    assert(slate && slate.by.includes('k-means') && slate.by.includes('cube'), `the slate, by both (${slate?.hex})`);
    assert(colors.every((c, i) => i === 0 || colors[i - 1].share >= c.share), 'the most common first');
}

export function testWallpaperColorsAreDistinct() {
    const colors = wallpaperColors(picture([['#5a6472', 0.5], ['#5e6876', 0.3], ['#e9b949', 0.2]]));
    for (const [i, a] of colors.entries()) {
        for (const b of colors.slice(i + 1))
            assert(distance(a.lab, b.lab) >= CUBE.distinct, `${a.hex} and ${b.hex} are one`);
    }
    assertEqual(colors.length, 2, colors.map(c => c.hex).join());
}

export function testTypeColorsOnDark() {
    const need = minimumLc(20, 600);
    const pixels = picture([['#101418', 0.6], ['#2a3340', 0.37], [RED, 0.03]]);
    const colors = typeColors(pixels, {need});
    const lighter = tenths(pixels).light;
    assert(colors.length > 0 && colors.every(c => !c.dark && c.reaches), `light tints on a dark part (${colors.map(c => c.color)})`);
    for (const c of colors)
        assert(Math.abs(-contrastLc(c.color, lighter) - c.lc) < 1e-9 && c.lc >= need, `${c.color}: Lc ${c.lc} on ${lighter}`);
    // Of the red too: a light tint of its hue, still a colour.
    const red = colors.find(c => c.source && distance(labOf(c.source), labOf(RED)) < 0.03);
    const [, chroma, hue] = hexToOklch(red?.color ?? '#000000');
    assert(red && chroma > 0.05 && hueDistance(hue, hexToOklch(RED)[2]) < 25, `a red tint (${red?.color})`);
    for (const [i, a] of colors.entries()) {
        for (const b of colors.slice(i + 1))
            assert(distance(labOf(a.color), labOf(b.color)) >= TINT.distinct, `${a.color} and ${b.color} look alike`);
    }
    assert(typeColors(pixels, {need, count: 1}).length === 1);
    assertEqual(typeColors([], {need}), []);
}

export function testTypeColorsOnLight() {
    const need = minimumLc(20, 600);
    const pixels = picture([['#efe6d2', 0.6], ['#d9cdb4', 0.37], ['#2a6fdb', 0.03]]);
    const colors = typeColors(pixels, {need, dim: 0.86});
    assert(colors.length > 0 && colors.every(c => c.dark && c.reaches), `dark tints on a pale part (${colors.map(c => c.color)})`);
    // Dark type reads on its darker tenth, dimmed as the prompt dims it.
    const darker = blend('#000000', 1 - 0.86, tenths(pixels).dark);
    assert(colors.every(c => contrastLc(c.color, darker) >= need), 'dimmed too');
    assert(colors.some(c => hueDistance(hexToOklch(c.color)[2], hexToOklch('#2a6fdb')[2]) < 25 && hexToOklch(c.color)[1] > 0.05),
        `a dark blue among them (${colors.map(c => c.color)})`);
    // Nothing reads (type too small for any contrast): the nearest to it.
    const none = typeColors(pixels, {need: Infinity});
    assert(none.length > 0 && none.every(c => !c.reaches) &&
        none.every((c, i) => i === 0 || none[i - 1].lc >= c.lc), 'the nearest first');
}

export function testClockColors() {
    const two = sample('#101418', '#efe6d2');
    const need = minimumLc(20, 600);
    assertEqual(clockColors(two, [0, 0, 0.5, 1], {need}), typeColors(regionPixels(two, [0, 0, 0.5, 1]), {need}));
    assert(clockColors(two, [0, 0, 0.5, 1], {need}).every(c => !c.dark), 'on the dark half, light');
    assert(clockColors(two, [0.5, 0, 0.5, 1], {need}).every(c => c.dark), 'on the pale one, dark');
}
