import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {placement} from '../lib/depth.js';
import {
    BACKDROP_VERSION, DIM, FROST, GLASS, TINT_GRADIENT, backdropKey, backdropSize, backdropTransform, backgroundPixels,
    boxWidths, frost, frostOf, frostSteps, glassColor, glassFor, glassTint, glyphCells, grainNoise, lensOf, meanColor,
    parseColor, pictureArea, rimSteps, sheenLine, tintShown,
} from '../lib/glassBackdrop.js';
import {LOOK, lookOf} from '../lib/glassLook.js';
import {legibilityPlan} from '../lib/lockLook.js';
import {hexToOklch, hexToRgb} from '../lib/palette.js';
import {
    GlassVariant, LiquidGlass, backdropDir, backdropSpec, loadBackdrop, makeBackdrop,
} from '../shell/lockscreen/liquidGlass.js';
import {assert, assertEqual, freshDir} from './util.js';

const near = (a, b, tolerance, message) =>
    assert(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);
const hueDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// An image of solid colours, RGB: (x, y) => [r, g, b].
function image(width, height, colorAt, channels = 3) {
    const rowstride = width * channels + 4; // (a little padding, as a pixbuf's rows may have)
    const pixels = new Uint8Array(rowstride * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++)
            pixels.set(colorAt(x, y), y * rowstride + x * channels);
    }
    return {pixels, width, height, channels, rowstride};
}

const at = ({pixels, width}, x, y) => [...pixels.slice((y * width + x) * 3, (y * width + x) * 3 + 3)];

export function testBackdropSize() {
    const size = backdropSize([2560, 1440], 1);
    near(size.sigma, 3, 0.05, 'blurred by about three of its pixels');
    near(size.factor[0], 3 / FROST.sigma, 0.002, 'as small as that lets it be');
    assertEqual([size.width, size.height], [Math.round(2560 * 3 / FROST.sigma), Math.round(1440 * 3 / FROST.sigma)]);
    assertEqual(size.factor, [size.width / 2560, size.height / 1440], 'each side its own factor, whole pixels');
    const hidpi = backdropSize([3840, 2160], 2);
    near(hidpi.factor[0], 3 / (2 * FROST.sigma), 0.002, 'the sigma is logical: twice as many pixels at scale 2');
    near(hidpi.sigma, 3, 0.05);
    assertEqual(backdropSize([800, 600], 1, 1).factor, [1, 1], 'never larger than the monitor');
    near(backdropSize([800, 600], 1, 1).sigma, 1, 1e-9, 'and then blurred as little as asked');
}

export function testPictureArea() {
    const size = backdropSize([2560, 1440], 1);
    const factor = size.factor;
    const backdrop = [size.width, size.height];
    // A 16:9 picture zoomed onto a 16:9 monitor fills it.
    const whole = pictureArea(placement('zoom', [2560, 1440], [1920, 1080]), factor, backdrop, [480, 270]);
    assertEqual([whole.x, whole.y, whole.width, whole.height], [0, 0, ...backdrop], 'all of it');
    near(whole.scaleX, size.width / 480, 1e-9, 'scaled to the backdrop');
    near(whole.offsetX, 0, 1e-9);
    // A 4:3 one is cut at the top and the bottom: it starts above the backdrop.
    const shown = placement('zoom', [2560, 1440], [1600, 1200]);
    const cut = pictureArea(shown, factor, backdrop, [400, 300]);
    assertEqual([cut.y, cut.height], [0, size.height], 'only what is on the monitor');
    assert(cut.offsetY < 0, `drawn from above it (${cut.offsetY})`);
    assert(Number.isInteger(cut.offsetY), 'at a whole pixel (as GdkPixbuf draws it anyway)');
    near(cut.offsetY - cut.shift[1], shown.y * factor[1], 1e-9, 'where GNOME draws it, but for the shift');
    assert(Math.abs(cut.shift[1]) <= 0.5, `less than half a pixel away (${cut.shift})`);
    near(cut.scaleY, shown.height * factor[1] / 300, 1e-9);
    // Scaled, a tall one leaves the sides to GNOME's colours.
    const tall = pictureArea(placement('scaled', [2560, 1440], [1000, 2000]), factor, backdrop, [100, 200]);
    assert(tall.x > 0 && tall.x + tall.width < size.width && tall.height === size.height, 'in the middle, as high');
    assertEqual(pictureArea({x: 3000, y: 0, width: 100, height: 100}, factor, backdrop, [10, 10]), null,
        'none of it on the monitor');
    assertEqual(pictureArea(null, factor, backdrop, [10, 10]), null, 'a style that isn\'t followed');
}

export function testColors() {
    assertEqual(parseColor('#000000000000'), [0, 0, 0], 'as GNOME keeps it: 16 bits a channel');
    assertEqual(parseColor('#ffffffffffff'), [255, 255, 255]);
    assertEqual(parseColor('#80008000ffff'), [128, 128, 255]);
    assertEqual(parseColor('#1a2b3c'), [0x1a, 0x2b, 0x3c]);
    assertEqual(parseColor('#abc'), [0xaa, 0xbb, 0xcc]);
    for (const wrong of ['', 'red', '#12345', null, undefined])
        assertEqual(parseColor(wrong), [0, 0, 0], `${wrong}: black`);

    const solid = backgroundPixels(4, 3, {primary: '#102030'});
    assert(solid.length === 4 * 3 * 3 && [0, 5, 11].every(p => at({pixels: solid, width: 4}, p % 4, Math.floor(p / 4))
        .join() === '16,32,48'), 'one colour all over');
    const vertical = backgroundPixels(4, 3, {primary: '#000000', secondary: '#ffffff', shading: 'vertical'});
    assertEqual(at({pixels: vertical, width: 4}, 2, 0), [0, 0, 0], 'from the top');
    assertEqual(at({pixels: vertical, width: 4}, 2, 2), [255, 255, 255], 'to the bottom');
    assertEqual(at({pixels: vertical, width: 4}, 0, 1), [128, 128, 128]);
    const horizontal = backgroundPixels(3, 2, {primary: '#ff0000', secondary: '#0000ff', shading: 'horizontal'});
    assertEqual([at({pixels: horizontal, width: 3}, 0, 1), at({pixels: horizontal, width: 3}, 2, 0)],
        [[255, 0, 0], [0, 0, 255]], 'from the left to the right');
}

export function testBoxWidths() {
    for (const sigma of [0.8, 1.5, 3, 7.3, 20]) {
        const widths = boxWidths(sigma);
        assertEqual(widths.length, 3);
        assert(widths.every(w => w % 2 === 1 && w >= 1), `odd widths (${widths})`);
        // Each box adds (w² - 1) / 12 to the variance: three of them about sigma².
        const variance = widths.reduce((sum, w) => sum + (w * w - 1) / 12, 0);
        near(Math.sqrt(variance), sigma, Math.max(0.35, sigma * 0.1), `blurred as much as a Gaussian of ${sigma}`);
    }
}

export function testFrost() {
    const plain = {saturation: 1, lift: 0};
    const grey = image(9, 7, () => [90, 90, 90]);
    const same = frost(grey.pixels, grey, {sigma: 2, ...plain});
    assert(same.every(v => Math.abs(v - 90) <= 1), 'one colour stays as it is');
    assertEqual(same.length, 9 * 7 * 3, 'RGB, the padding left out');

    // A light in the middle spreads round it, evenly, and as light adds up
    // (more of it left than a mean of the encoded values would leave).
    const dark = image(15, 15, (x, y) => (x === 7 && y === 7 ? [255, 255, 255] : [0, 0, 0]));
    const spread = frost(dark.pixels, dark, {sigma: 2, ...plain});
    const value = (x, y) => spread[(y * 15 + x) * 3];
    assert(value(7, 7) > value(8, 7) && value(8, 7) > value(10, 7) && value(10, 7) > 0, 'brightest in the middle');
    for (const [x, y] of [[5, 7], [7, 5], [7, 9]])
        near(value(x, y), value(9, 7), 1, `evenly round it (${x}, ${y})`);
    const linear = v => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
    let total = 0;
    for (let i = 0; i < spread.length; i += 3)
        total += linear(spread[i]);
    near(total, 1, 0.1, 'the light kept');

    // Richer, and brighter: dark colours by 1 + lift, as their hue lets.
    const muted = image(4, 4, () => [100, 80, 60]);
    const rich = frost(muted.pixels, muted, {sigma: 1, saturation: 1.5, lift: 0});
    const chroma = hex => hexToOklch(hex)[1];
    assert(chroma('#' + at({pixels: rich, width: 4}, 1, 1).map(v => v.toString(16).padStart(2, '0')).join('')) >
        chroma('#64503c'), 'richer');
    const lit = frost(muted.pixels, muted, {sigma: 1, saturation: 1, lift: 0.5});
    const [r, g, b] = at({pixels: lit, width: 4}, 2, 2);
    near(r, 150, 1, 'brighter by half');
    near(g / r, 0.8, 0.01, 'its hue kept');
    near(b / r, 0.6, 0.01);
    const blue = image(4, 4, () => [40, 90, 230]);
    const [, , bb] = at({pixels: frost(blue.pixels, blue, {sigma: 1, saturation: 1, lift: 0.7}), width: 4}, 1, 1);
    const [br, bg] = at({pixels: frost(blue.pixels, blue, {sigma: 1, saturation: 1, lift: 0.7}), width: 4}, 1, 1);
    assert(bb === 255, `as bright as its brightest channel lets it be (${bb})`);
    near(br / bb, 40 / 230, 0.02, 'none of its channels clipped on its own: no other hue');
    near(bg / bb, 90 / 230, 0.02);

    // A pass at a time, to the same end.
    const rgba = image(6, 5, (x, y) => [x * 40, y * 50, 200, 255], 4);
    const steps = frostSteps(rgba.pixels, rgba, {sigma: 1.5});
    let passes = 0;
    let result;
    for (;;) {
        const {done, value: out} = steps.next();
        if (done) {
            result = out;
            break;
        }
        passes++;
    }
    assert(passes >= 7, `it gives way between its passes (${passes})`);
    assertEqual([...result], [...frost(rgba.pixels, rgba, {sigma: 1.5})], 'as frost() does it, alpha left out');
}

export function testMeanColor() {
    const halves = image(10, 4, x => (x < 5 ? [200, 0, 0] : [0, 0, 100]));
    assertEqual(meanColor(halves, [0, 0, 0.5, 1]), '#c80000', 'the left half');
    assertEqual(meanColor(halves, [0.5, 0, 0.5, 1]), '#000064', 'the right half');
    assertEqual(meanColor(halves, [0, 0, 1, 1]), '#640032', 'both');
    assertEqual(meanColor(halves, [0.9, 0.5, 0.5, 0.9]), '#000064', 'cut to the picture');
    assertEqual(meanColor(halves, [1.2, 0, 0.1, 1]), null, 'off the picture');
    assertEqual(meanColor(halves, [0, 0, 0, 1]), null, 'nothing');
}

export function testBackdropKey() {
    const picture = {path: '/pictures/a.jpg', mtime: 1700000000, size: 123456};
    const options = {monitor: [2560, 1440], scale: 1, style: 'zoom', colors: {primary: '#000000'}};
    const key = backdropKey(picture, options);
    assert(/^[0-9a-f]{40}$/.test(key), `a SHA-1 (${key})`);
    assertEqual(backdropKey({...picture}, {...options}), key, 'the same, the same name');
    for (const [what, p, o] of [
        ['another picture', {...picture, path: '/pictures/b.jpg'}, options],
        ['written anew', {...picture, mtime: picture.mtime + 1}, options],
        ['another monitor', picture, {...options, monitor: [1920, 1080]}],
        ['another scale', picture, {...options, scale: 2}],
        ['placed otherwise', picture, {...options, style: 'scaled'}],
        ['another colour round it', picture, {...options, colors: {primary: '#ffffff'}}],
        ['frosted for another look', picture, {...options, frost: frostOf(LOOK.clear)}],
    ])
        assert(backdropKey(p, o) !== key, `${what}: a name of its own`);
    assertEqual(backdropKey(picture, {...options, frost: frostOf(null)}), key, 'no look: as the picture is');
    assert(BACKDROP_VERSION >= 2);
}

export function testFrostOf() {
    assertEqual(frostOf(LOOK.regular), {sigma: FROST.sigma, saturation: LOOK.regular.saturation,
        lift: LOOK.regular.brightness - 1 + FROST.glow}, 'richer and brighter as the look has it, and glowing');
    near(frostOf(LOOK.regular).lift, 0.7, 0.05, 'as bright as the clock was before the look was shared');
    assert(frostOf(LOOK.clear).saturation < frostOf(LOOK.regular).saturation &&
        frostOf(LOOK.clear).lift < frostOf(LOOK.regular).lift, 'clear glass: less so');
    assertEqual(frostOf(null), {sigma: FROST.sigma, saturation: 1, lift: 0}, 'no look: only blurred');
}

export function testBackdropTransform() {
    // Where a point of the drawing takes the backdrop from: the inverse of
    // translate() and scale().
    const source = ({x, y, scaleX, scaleY}, [px, py]) => [(px - x) / scaleX, (py - y) / scaleY];
    const plain = backdropTransform({at: [100, 50], factor: [0.25, 0.2]});
    const [sx, sy] = source(plain, [8, 10]);
    near(sx, (100 + 8) * 0.25, 1e-9, 'where it lies on the monitor, in the backdrop');
    near(sy, (50 + 10) * 0.2, 1e-9);
    const lens = backdropTransform({at: [100, 50], factor: [0.25, 0.25], center: [20, 30], lens: 0.8});
    const middle = source(lens, [20, 30]);
    near(middle[0], 120 * 0.25, 1e-9, 'the middle stays where it is');
    near(middle[1], 80 * 0.25, 1e-9);
    const edge = source(lens, [28, 30]);
    near(edge[0] - middle[0], 8 / 0.8 * 0.25, 1e-9, 'further out, what lies further still (drawn smaller)');
    const apart = backdropTransform({at: [100, 50], factor: [0.25, 0.25], center: [20, 30], lens: [0.8, 0.5]});
    const [across, down] = [source(apart, [28, 30]), source(apart, [20, 38])];
    near(across[0] - middle[0], 8 / 0.8 * 0.25, 1e-9, 'a lens of its own each way: across');
    near(down[1] - middle[1], 8 / 0.5 * 0.25, 1e-9, 'and down');
    const shifted = source(backdropTransform({at: [100, 50], factor: [0.25, 0.2], shift: [0.3, -0.4]}), [8, 10]);
    near(shifted[0], (100 + 8) * 0.25 + 0.3, 1e-9, 'where its picture was moved to');
    near(shifted[1], (50 + 10) * 0.2 - 0.4, 1e-9);
}

export function testGlyphCells() {
    const bounds = {x: 10, y: 5, width: 100, height: 40};
    const one = glyphCells(null, bounds);
    assertEqual(one, [{x: 10, width: 100, center: [60, 25], box: bounds}], 'without glyphs, one cell: the bounds');
    const cells = glyphCells([
        {x: 70, y: 5, width: 40, height: 40},
        {x: 10, y: 5, width: 30, height: 40},
        {x: 36, y: 5, width: 30, height: 40}, // (overlapping the first)
    ], bounds);
    assertEqual(cells.map(c => c.x), [10, 38, 68], 'left to right, split halfway where they meet');
    assertEqual(cells.map(c => c.x + c.width).at(-1), 110, 'to the bounds\' end');
    for (let i = 1; i < cells.length; i++)
        assertEqual(cells[i].x, cells[i - 1].x + cells[i - 1].width, 'side by side');
    assertEqual(cells.map(c => c.center), [[25, 25], [51, 25], [90, 25]], 'about each one\'s middle');
    assertEqual(cells.map(c => c.box.x), [10, 36, 70], 'each with its glyph');
}

export function testLens() {
    // A glyph 40 wide and 120 tall: what lies 10 further out drawn at its
    // edges, each way – red further still, blue less.
    const {red, green, blue} = lensOf([20, 60], 10, 0.35);
    const moved = (lens, half) => half / lens - half;
    near(moved(green[0], 20), 10, 1e-9, 'at its sides, what lies the shift further out');
    near(moved(green[1], 60), 10, 1e-9, 'at its top and its bottom too');
    near(moved(red[0], 20), 13.5, 1e-9, 'red further');
    near(moved(blue[0], 20), 6.5, 1e-9, 'blue less: a hint of colour at the very rim');
    assert(red[1] < green[1] && green[1] < blue[1] && blue[1] < 1, 'what lies further out drawn in, all of them');
    assertEqual(lensOf([20, 60], 10), {red: green, green, blue: green}, 'no aberration: one lens');
    assertEqual(lensOf([20, 60], 0, 0.35).green, [1, 1], 'no shift: as it is');
}

export function testRimSteps() {
    for (const variant of ['regular', 'clear']) {
        const {rim} = LOOK[variant];
        const steps = rimSteps(rim);
        assert(steps.top + steps.bottom + 2 * steps.side <= 15,
            `${variant}: added up a few times (${JSON.stringify(steps)})`);
        for (const edge of ['top', 'bottom', 'side'])
            near(steps[edge] * steps.unit, rim[edge], 0.025, `${variant}: along the ${edge}s as the look has it`);
        assert(steps.top > steps.side && steps.side > steps.bottom, `${variant}: strongest along the tops`);
        const dark = rimSteps(rim, 0.5);
        near(dark.unit, steps.unit / 2, 1e-9, `${variant}: half as strong on dark glass`);
        assertEqual([dark.top, dark.bottom, dark.side], [steps.top, steps.bottom, steps.side]);
    }
}

export function testSheenLine() {
    // CSS's 135deg across a 100 × 40 box: from its top left to its bottom
    // right, through its middle, (100 + 40) / √2 long.
    const [x0, y0, x1, y1] = sheenLine({x: 10, y: 20, width: 100, height: 40}, 135);
    near((x0 + x1) / 2, 60, 1e-9, 'through the middle');
    near((y0 + y1) / 2, 40, 1e-9);
    assert(x1 > x0 && y1 > y0 && Math.abs((x1 - x0) - (y1 - y0)) < 1e-9, 'down to the right, at 45°');
    near(Math.hypot(x1 - x0, y1 - y0), 140 / Math.SQRT2, 1e-9, 'as long as the box is across that way');
    const down = sheenLine({x: 0, y: 0, width: 100, height: 40}, 180);
    assertEqual(down.map(v => Math.round(v * 1e6) / 1e6), [50, 0, 50, 40], '180deg: from the top down');
}

export function testGrainNoise() {
    const noise = grainNoise(4096);
    assert(noise.every(v => v >= -1 && v <= 1), 'from -1 to 1');
    const mean = noise.reduce((sum, v) => sum + v, 0) / noise.length;
    near(mean, 0, 0.05, 'as much lighter as darker');
    const spread = Math.sqrt(noise.reduce((sum, v) => sum + v * v, 0) / noise.length);
    near(spread, 1 / Math.sqrt(3), 0.05, 'spread evenly');
    assertEqual([...grainNoise(16)], [...grainNoise(16)], 'the same each time');
    assert([...grainNoise(16, 7)].join() !== [...grainNoise(16)].join(), 'another seed, another grain');
}

export function testGlassTint() {
    const light = {color: '#f4f4f4', dark: false};
    assertEqual(glassTint(light, null), light.color, 'nothing known behind: the tone');
    const [lightness] = hexToOklch(light.color);
    for (const behind of ['#2050c0', '#c04020', '#30a040']) {
        const tint = glassTint(light, behind);
        const [l, c, h] = hexToOklch(tint);
        near(l, lightness, 0.02, `${behind}: as light as the tone`);
        assert(c > 0.01 && c < 0.045, `${behind}: a hint of colour (${c})`);
        assert(hueDistance(h, hexToOklch(behind)[2]) < 12, `${behind}: its hue (${tint})`);
    }
    const toned = {color: '#d8e4ff', dark: false};
    assert(hueDistance(hexToOklch(glassTint(toned, '#777777'))[2], hexToOklch(toned.color)[2]) < 15,
        'grey behind: the tone\'s own hue');
    const dark = glassTint({color: '#202020', dark: true}, '#e0c080');
    assert(hexToOklch(dark)[0] < 0.3, `dark glass, a dark tint (${dark})`);
}

export function testGlassColor() {
    const frosted = '#406080';
    const tint = '#f0f0f0';
    assertEqual(glassColor({frosted, tint, tintAlpha: 0, opacity: 1}), frosted, 'no tint: the frost');
    assertEqual(glassColor({frosted, tint, opacity: 0, behind: '#102030'}), '#102030', 'no membrane: what is behind');
    assertEqual(glassColor({frosted, tint: '#000000', dark: true, tintAlpha: 0, opacity: 1}),
        `#${hexToRgb(frosted).map(v => Math.round(v * DIM).toString(16).padStart(2, '0')).join('')}`,
        'dark glass lets less through');
    const [rest, more] = [GLASS.tintAlpha, GLASS.tintAlpha + 0.2].map(tintAlpha =>
        hexToOklch(glassColor({frosted, tint, tintAlpha}))[0]);
    assert(more > rest, 'more tint, lighter light glass');
    const [less, opaque] = [0.5, 1].map(opacity => hexToOklch(glassColor({frosted, tint, opacity, behind: '#000000'}))[0]);
    assert(opaque > less, 'more opaque, less of what is behind');
    // The look's veils over the frost: lighter for its veil, darker for its dim.
    const lightness = look => hexToOklch(glassColor({frosted, tint, tintAlpha: 0, opacity: 1, look}))[0];
    assert(lightness({veil: 0.08, dim: 0}) > lightness(null), 'a light veil over it');
    assert(lightness({veil: 0, dim: 0.12}) < lightness(null), 'a dark one under it');
    assertEqual(glassColor({frosted, tint, tintAlpha: 0, opacity: 1, look: {veil: 0, dim: 0}}), frosted, 'neither');
    assert(lightness(lookOf('clear')) < lightness(lookOf('regular')), 'clear glass dimmer than regular');
}

export function testPlanBridge() {
    // What a plan is told of the glass at rest: how much of its tint
    // shows over what is behind it, at its feet, through its transparency.
    near(tintShown(), GLASS.tintAlpha * TINT_GRADIENT[1] * GLASS.opacity, 1e-9, 'the glass at rest');
    assertEqual(glassFor(null), GLASS, 'nothing asked: at rest');
    assertEqual(glassFor(tintShown() / 2), GLASS, 'never less than at rest');
    let before = {...GLASS};
    for (const shown of [0.25, 0.27, 0.3, 0.45, 0.7, 0.92]) {
        const material = glassFor(shown);
        near(tintShown(material), shown, 1e-9, `${shown}: as much of the tint as asked`);
        assert(material.opacity >= before.opacity && material.tintAlpha >= before.tintAlpha, `${shown}: more, not less`);
        assert(material.tintAlpha === GLASS.tintAlpha || material.opacity === 1,
            `${shown}: opaque first, then more tint (${JSON.stringify(material)})`);
        before = material;
    }
    // As the lock screen's plan has it: light glass digits over a light
    // part of the wallpaper (small digits: large ones read with a shadow
    // alone) ask for more opaque glass, which is that much more of the tint.
    const stats = {tenths: {dark: '#a0b0c0', middle: '#a0b0c0', light: '#a0b0c0'}};
    const tone = {color: '#f4f4f4', dark: false};
    const plan = legibilityPlan({size: 60, weight: 600, tone, stats, glass: tintShown(), dim: 0.86});
    assert(plan.glass > tintShown() && plan.shadow, `the plan wants more of the tint, and a shadow (${plan.glass})`);
    const material = glassFor(plan.glass);
    near(tintShown(material), plan.glass, 1e-9, 'and the glass shows it');
    assert(material.opacity === 1, 'all of the membrane first');
}

// A picture: its left half red, its right half blue (16:9).
function twoColourPicture(dir) {
    const path = GLib.build_filenamev([dir, 'picture.png']);
    const {pixels} = image(64, 36, x => (x < 32 ? [220, 30, 30] : [30, 30, 220]));
    const packed = new Uint8Array(64 * 36 * 3);
    for (let y = 0; y < 36; y++)
        packed.set(pixels.slice(y * (64 * 3 + 4), y * (64 * 3 + 4) + 64 * 3), y * 64 * 3);
    GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(packed), GdkPixbuf.Colorspace.RGB, false, 8, 64, 36, 64 * 3)
        .savev(path, 'png', [], []);
    return path;
}

export async function testBackdropMade() {
    const dir = freshDir('glass');
    const path = twoColourPicture(dir);
    assert(backdropDir().startsWith(GLib.get_user_cache_dir()) && backdropDir().endsWith('/atelier/glass'),
        `in Atelier's cache (${backdropDir()})`);
    assertEqual(backdropSpec({path: `${dir}/nothing.png`, style: 'zoom', monitor: [640, 360], dir}), null,
        'no picture, no backdrop');
    assertEqual(backdropSpec({path, style: 'wallpaper', monitor: [640, 360], dir}), null, 'nor tiled');
    const spec = backdropSpec({path, style: 'zoom', monitor: [640, 360], scale: 1, dir});
    assert(spec.file.startsWith(dir) && spec.file.endsWith(`${spec.key}.png`), 'kept where asked, by its name');
    const pixels = await makeBackdrop(spec);
    assert(pixels && GLib.file_test(spec.file, GLib.FileTest.EXISTS), 'made, and kept');
    assertEqual(await makeBackdrop(spec), null, 'made once');
    const backdrop = await loadBackdrop(spec);
    assertEqual([backdrop.surface.getWidth(), backdrop.surface.getHeight()], [spec.size.width, spec.size.height]);
    assertEqual(backdrop.factor, spec.size.factor);
    // As GNOME draws it: red on the left of the monitor, blue on the right,
    // blurred where they meet.
    const left = hexToRgb(meanColor(backdrop.sample, [0, 0, 0.3, 1]));
    const right = hexToRgb(meanColor(backdrop.sample, [0.7, 0, 0.3, 1]));
    assert(left[0] > 200 && left[2] < 60 && right[2] > 200 && right[0] < 60, `aligned (${left} | ${right})`);
    const middle = hexToRgb(meanColor(backdrop.sample, [0.49, 0.4, 0.02, 0.2]));
    assert(middle[0] > 80 && middle[2] > 80, `blurred where they meet (${middle})`);

    // Scaled onto a taller monitor: GNOME's colour above and below it.
    const scaled = backdropSpec({path, style: 'scaled', monitor: [640, 640], scale: 1,
        colors: {primary: '#00ff00'}, dir});
    await makeBackdrop(scaled);
    const sides = await loadBackdrop(scaled);
    const top = hexToRgb(meanColor(sides.sample, [0, 0, 1, 0.08]));
    assert(top[1] > 200 && top[0] < 60, `green over it (${top})`);
}

// A picture of red and blue, red where it is said to be.
function redAndBlue(dir, name, width, height, isRed) {
    const path = GLib.build_filenamev([dir, `${name}.png`]);
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++)
            pixels.set(isRed(x, y) ? [220, 30, 30] : [30, 30, 220], (y * width + x) * 3);
    }
    GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(pixels), GdkPixbuf.Colorspace.RGB, false, 8, width, height,
        width * 3).savev(path, 'png', [], []);
    return path;
}

// Where red turns to blue along a line of the backdrop, in its pixels:
// where red and blue are as strong (blurred as light adds up, evenly, they
// are where the two meet; made richer and brighter, they still are).
function redMeetsBlue({pixels}, length, at) {
    const balance = i => pixels[at(i)] - pixels[at(i) + 2];
    for (let i = 0; i + 1 < length; i++) {
        const [here, next] = [balance(i), balance(i + 1)];
        if (here > 0 && next <= 0)
            return i + 0.5 + here / (here - next);
    }
    return NaN;
}

export async function testBackdropAligned() {
    const dir = freshDir('glass-aligned');
    const monitor = [640, 360];
    // A tall picture, zoomed: cut at the top and the bottom. Red above
    // its row 250, which GNOME draws at y = -246 + 250 × 853 / 400.
    const tall = redAndBlue(dir, 'tall', 300, 400, (x, y) => y < 250);
    const zoom = backdropSpec({path: tall, style: 'zoom', monitor, dir});
    const shown = placement('zoom', monitor, [300, 400]);
    const made = await makeBackdrop(zoom);
    const kept = await loadBackdrop(zoom);
    assertEqual(kept.shift.map(v => v.toFixed(4)), made.shift.map(v => v.toFixed(4)), 'its shift kept with it');
    const zoomed = kept.sample;
    const column = Math.floor(zoomed.width / 2);
    const y = redMeetsBlue(zoomed, zoomed.height, i => i * zoomed.rowstride + column * zoomed.channels);
    near(y, (shown.y + 250 * shown.height / 400) * zoom.size.factor[1] + kept.shift[1], 0.2,
        'zoomed: where GNOME draws it');

    // Scaled: in the middle, GNOME's colour beside it. Red left of its
    // column 100.
    const scaled = backdropSpec({path: redAndBlue(dir, 'left', 300, 400, x => x < 100), style: 'scaled', monitor,
        colors: {primary: '#000000'}, dir});
    const placed = placement('scaled', monitor, [300, 400]);
    await makeBackdrop(scaled);
    const {sample, shift} = await loadBackdrop(scaled);
    const row = Math.floor(sample.height / 2);
    const x = redMeetsBlue(sample, sample.width, i => row * sample.rowstride + i * sample.channels);
    assert(Math.abs(shift[0]) > 0.05, `(a picture GdkPixbuf moves: ${shift})`);
    near(x, (placed.x + 100 * placed.width / 300) * scaled.size.factor[0] + shift[0], 0.2,
        'scaled: where GNOME draws it');
}

// Pixels of a surface, as a pixbuf reads them from its PNG.
function pixelsOf(surface, dir, name) {
    const path = GLib.build_filenamev([dir, `${name}.png`]);
    surface.writeToPNG(path);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
    const [pixels, stride, channels] = [pixbuf.get_pixels(), pixbuf.get_rowstride(), pixbuf.get_n_channels()];
    return (x, y) => [...pixels.slice(y * stride + x * channels, y * stride + x * channels + 4)];
}

// The mean of a patch of pixels round a point (the grain evened out).
const meanAt = (pixels, x, y, half = 3) => {
    const sum = [0, 0, 0, 0];
    for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++)
            pixels(x + dx, y + dy).forEach((v, i) => (sum[i] += v));
    }
    return sum.map(v => v / (2 * half + 1) ** 2);
};
const lightOf = rgba => (rgba[0] + rgba[1] + rgba[2]) / 3;

// A picture of one grey.
function greyPicture(dir) {
    const path = GLib.build_filenamev([dir, 'grey.png']);
    // (Dark enough that the frost's glow leaves room for the light added.)
    GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(new Uint8Array(64 * 36 * 3).fill(70)), GdkPixbuf.Colorspace.RGB,
        false, 8, 64, 36, 64 * 3).savev(path, 'png', [], []);
    return path;
}

export async function testGlassPainted() {
    const dir = freshDir('glass-paint');
    const path = twoColourPicture(dir);
    const spec = backdropSpec({path, style: 'zoom', monitor: [640, 360], scale: 1, dir});
    await makeBackdrop(spec);
    const backdrop = await loadBackdrop(spec);
    const grey = backdropSpec({path: greyPicture(dir), style: 'zoom', monitor: [640, 360], scale: 1, dir});
    await makeBackdrop(grey);
    const greyBackdrop = await loadBackdrop(grey);
    // A bar of glass across the middle of a 200×100 drawing at (220, 130)
    // on the monitor, over the red and the blue.
    const shape = cr => cr.rectangle(40, 30, 120, 40);
    const bounds = {x: 40, y: 30, width: 120, height: 40};
    const draw = (options, name, {behind = backdrop, density = 1} = {}) => {
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, Math.ceil(200 * density), Math.ceil(100 * density));
        surface.setDeviceScale(density, density);
        const cr = new Cairo.Context(surface);
        const glass = new LiquidGlass();
        glass.backdrop = behind;
        glass.paint(cr, shape, {bounds, tone: {color: '#f4f4f4', dark: false}, at: [220, 130], ...options});
        cr.$dispose();
        return pixelsOf(surface, dir, name);
    };
    const glass = draw({opacity: 1}, 'glass');
    const [leftInside, rightInside] = [glass(60, 50), glass(140, 50)];
    assert(leftInside[3] === 255 && rightInside[3] === 255, 'opaque inside');
    assert(leftInside[0] > leftInside[2] && rightInside[2] > rightInside[0],
        `red behind its left, blue behind its right (${leftInside} | ${rightInside})`);
    assertEqual(glass(10, 10), [0, 0, 0, 0], 'nothing far from it');
    assert(glass(110, 30)[1] > glass(110, 50)[1] + 40, `light caught along its top (${glass(110, 30)})`);

    const clear = draw({opacity: 0.3}, 'clear');
    assert(clear(60, 50)[3] < 140, `less opaque, as asked (${clear(60, 50)})`);
    const shadow = draw({opacity: 1, shadow: 1}, 'shadow');
    const [close, further] = [shadow(100, 72), shadow(100, 76)];
    assert(close[3] > further[3] && further[3] > 0 && close[0] < 40,
        `a dark shadow under it, fading (${close} | ${further})`);
    assertEqual(glass(100, 72), [0, 0, 0, 0], 'none unless asked');
    // As a plan gives it: CSS's blur, falling a few pixels down.
    const planned = draw({opacity: 1, shadow: {alpha: 0.6, blur: 8, y: 3}}, 'planned');
    assert(planned(100, 73)[3] > planned(100, 27)[3] + 10, `lower under it than over it (${planned(100, 73)} | ` +
        `${planned(100, 27)})`);
    assertEqual(draw({opacity: 1, shadow: null}, 'none')(100, 72), [0, 0, 0, 0], 'a plan without one: none');
    const bare = draw({opacity: 1}, 'bare', {behind: null});
    assert(bare(60, 50)[3] > 100, 'without a backdrop, the tint alone');

    // Over one grey: the light from above along its edges, strongest along
    // its top, faintest along its bottom, in between along its sides; a
    // sheen from the top left of it, fading out a part of the way across;
    // the grain, a little lighter or darker from a pixel to the next.
    const even = draw({opacity: 1}, 'grey', {behind: greyBackdrop});
    const along = points => points.reduce((sum, [x, y]) => sum + lightOf(even(x, y)), 0) / points.length;
    const span = (from, to, point) => Array.from({length: to - from + 1}, (_, i) => point(from + i));
    // (Its right side: the sheen lights its left one too.)
    const [top, side, bottom, inside] = [
        along(span(104, 116, x => [x, 30])), along(span(44, 56, y => [159, y])), along(span(104, 116, x => [x, 69])),
        along(span(104, 116, x => [x, 50])),
    ];
    assert(top > side + 10 && side > bottom + 5 && bottom > inside + 5,
        `light along its top, its side, its bottom (${[top, side, bottom, inside].map(Math.round)})`);
    const [sheened, unsheened] = [meanAt(even, 62, 50), meanAt(even, 138, 50)];
    assert(lightOf(sheened) > lightOf(unsheened) + 8, `a sheen at its top left (${sheened} | ${unsheened})`);
    const row = Array.from({length: 40}, (_, i) => lightOf(even(100 + i, 52)));
    const steps = row.slice(1).map((v, i) => Math.abs(v - row[i]));
    assert(Math.max(...steps) >= 2 && Math.max(...steps) <= 16, `a fine grain (${Math.max(...steps)} levels at most)`);

    // Clear glass: dimmer under a lighter veil; no glass: solid, in the tone.
    const [regularMean, clearMean] = ['regular', 'clear'].map(variant =>
        lightOf(meanAt(draw({opacity: 1, variant}, `even-${variant}`, {behind: greyBackdrop}), 120, 50)));
    assert(clearMean < regularMean - 3, `clear glass dimmer over the grey (${clearMean} | ${regularMean})`);
    const solid = draw({opacity: 1, variant: 'off', shadow: 1}, 'solid');
    assertEqual([solid(60, 50), solid(110, 30), solid(140, 50)], [[244, 244, 244, 255], [244, 244, 244, 255],
        [244, 244, 244, 255]], 'no glass: solid in the tone, no light along its edges');
    assert(solid(100, 72)[3] > 0, 'its shadow as planned');

    // At 150 % (the screen's pixels half again as many as the stage's), the
    // same, in its pixels.
    const dense = draw({opacity: 1}, 'dense', {density: 1.5});
    const [denseLeft, denseRight] = [dense(90, 75), dense(210, 75)];
    assert(denseLeft[3] === 255 && denseRight[3] === 255 && denseLeft[0] > denseLeft[2] && denseRight[2] > denseRight[0],
        `at 150 %: red behind its left, blue behind its right (${denseLeft} | ${denseRight})`);
    assertEqual(dense(15, 15), [0, 0, 0, 0], 'at 150 %: nothing far from it');
    assert(dense(165, 45)[1] > dense(165, 75)[1] + 40, `at 150 %: light along its top (${dense(165, 45)})`);
}

// Drawn again – as a clock is whenever anything about it changes – the
// glass comes out the same: nothing it keeps from one drawing to the next
// adds up (the band where it bends, blurred, once grew stronger each time).
export async function testGlassDrawnAgain() {
    const dir = freshDir('glass-again');
    const spec = backdropSpec({path: twoColourPicture(dir), style: 'zoom', monitor: [640, 360], scale: 1, dir});
    await makeBackdrop(spec);
    const glass = new LiquidGlass();
    glass.backdrop = await loadBackdrop(spec);
    const shape = cr => {
        cr.rectangle(40, 20, 30, 60);
        cr.rectangle(100, 20, 40, 60);
    };
    const boxes = [{x: 40, y: 20, width: 30, height: 60}, {x: 100, y: 20, width: 40, height: 60}];
    const drawn = Array.from({length: 3}, (_, i) => {
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 200, 100);
        const cr = new Cairo.Context(surface);
        glass.paint(cr, shape, {bounds: {x: 40, y: 20, width: 100, height: 60}, glyphBoxes: boxes,
            tone: {color: '#e4f9df', dark: false}, at: [220, 130]});
        cr.$dispose();
        return pixelsOf(surface, dir, `again-${i}`);
    });
    for (const [x, y] of [[55, 50], [45, 25], [120, 50], [101, 75]]) {
        assertEqual(drawn[2](x, y), drawn[0](x, y), `drawn a third time as the first, at ${x}, ${y}`);
        assertEqual(drawn[1](x, y), drawn[0](x, y), `and a second, at ${x}, ${y}`);
    }
}

// Drawn quickly, as a clock being stretched is: the frost, the veils and
// the tint where the shape is, as the glass in full has them away from its
// edges and its sheen, and the light along its top; nothing round it. What
// it is filled with is made once while it serves (the shape larger, as a
// clock grows), and let go of once the glass is drawn in full.
export async function testGlassSketched() {
    const dir = freshDir('glass-sketch');
    const path = twoColourPicture(dir);
    const spec = backdropSpec({path, style: 'zoom', monitor: [640, 360], scale: 1, dir});
    await makeBackdrop(spec);
    const backdrop = await loadBackdrop(spec);
    const glass = new LiquidGlass();
    glass.backdrop = backdrop;
    const tone = {color: '#f4f4f4', dark: false};
    const draw = (how, name, {width = 120, height = 40, density = 1, ...options} = {}) => {
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, Math.ceil(200 * density), Math.ceil(100 * density));
        surface.setDeviceScale(density, density);
        const cr = new Cairo.Context(surface);
        glass[how](cr, c => c.rectangle(40, 30, width, height),
            {bounds: {x: 40, y: 30, width, height}, tone, at: [220, 130], ...options});
        cr.$dispose();
        return pixelsOf(surface, dir, name);
    };
    const full = draw('paint', 'full', {opacity: 1});
    const quick = draw('sketch', 'quick', {opacity: 1});
    const made = glass._sketch;
    // (Away from its edges, and from its sheen at the top left.)
    for (const [x, y] of [[120, 50], [140, 50], [100, 52]]) {
        const [a, b] = [meanAt(full, x, y), meanAt(quick, x, y)];
        assert(a.every((v, i) => Math.abs(v - b[i]) <= 3), `inside, as in full (${a} | ${b} at ${x}, ${y})`);
    }
    assert(quick(60, 50)[0] > quick(60, 50)[2] && quick(140, 50)[2] > quick(140, 50)[0],
        `red behind its left, blue behind its right (${quick(60, 50)} | ${quick(140, 50)})`);
    assert(quick(100, 30)[1] > quick(100, 50)[1] + 40, `light caught along its top (${quick(100, 30)})`);
    assertEqual([quick(10, 10), quick(100, 72)], [[0, 0, 0, 0], [0, 0, 0, 0]], 'nothing round it');

    // Larger, as a clock grows: what it is filled with serves still.
    const larger = draw('sketch', 'larger', {opacity: 1, width: 140, height: 50});
    assert(glass._sketch === made && larger(170, 70)[3] === 255, `made once (${larger(170, 70)} at its new corner)`);
    assert(draw('sketch', 'clear', {opacity: 0.3})(60, 50)[3] < 140, 'less opaque, as asked');
    draw('paint', 'full-again');
    assertEqual(glass._sketch, null, 'drawn in full: let go of');
    assertEqual(draw('sketch', 'solid', {variant: 'off'})(100, 50), [244, 244, 244, 255], 'no glass: solid');

    // At 150 %, in its pixels; and without a backdrop, the tint alone.
    const dense = draw('sketch', 'dense', {opacity: 1, density: 1.5});
    assert(dense(90, 75)[0] > dense(90, 75)[2] && dense(210, 75)[2] > dense(210, 75)[0] && dense(90, 75)[3] === 255,
        `at 150 %: red behind its left, blue behind its right (${dense(90, 75)} | ${dense(210, 75)})`);
    assertEqual(dense(15, 15), [0, 0, 0, 0], 'at 150 %: nothing far from it');
    glass.backdrop = null;
    assert(draw('sketch', 'bare', {opacity: 1})(60, 50)[3] > 100, 'without a backdrop, the tint alone');
}

// The glass the lock screen's clocks are drawn in: as chosen, none with
// GNOME's high contrast on, whatever is chosen; told as it changes.
export function testGlassVariant() {
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.atelier'});
    const a11y = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
    // (The settings' signals come through the main loop.)
    const settle = () => {
        const context = GLib.MainContext.default();
        while (context.pending())
            context.iteration(false);
    };
    const told = [];
    const variant = new GlassVariant(settings, v => told.push(v));
    assertEqual(variant.variant, 'regular', 'regular glass at first');
    settings.set_string('glass-variant', 'clear');
    settle();
    assertEqual([variant.variant, told], ['clear', ['clear']], 'clear, as chosen, and told so');
    a11y.set_boolean('high-contrast', true);
    settle();
    assertEqual([variant.variant, told.at(-1)], ['off', 'off'], 'none with GNOME\'s high contrast');
    settings.set_string('glass-variant', 'regular');
    settle();
    assertEqual([variant.variant, told.length], ['off', 2], 'whatever is chosen meanwhile');
    a11y.reset('high-contrast');
    settle();
    assertEqual([variant.variant, told.at(-1)], ['regular', 'regular'], 'as chosen, without it');
    variant.destroy();
    settings.set_string('glass-variant', 'clear');
    settle();
    assertEqual(told.length, 3, 'gone: told nothing more');
    settings.reset('glass-variant');
    assertEqual(new GlassVariant(null).variant, 'regular', 'without Atelier\'s settings: regular glass');
}
