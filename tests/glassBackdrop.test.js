import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {placement} from '../lib/depth.js';
import {
    BACKDROP_VERSION, FROST, GLASS, backdropKey, backdropSize, backgroundPixels, boxWidths, frost, frostOf, frostSteps,
    glassColor, glassFor, meanColor, parseColor, pictureArea, tintShown,
} from '../lib/glassBackdrop.js';
import {LOOK, faceColor} from '../lib/glassLook.js';
import {legibilityPlan} from '../lib/lockLook.js';
import {hexToOklch, hexToRgb} from '../lib/palette.js';
import {GlassVariant, backdropDir, backdropSpec, loadBackdrop, makeBackdrop} from '../shell/lockscreen/liquidGlass.js';
import {assert, assertEqual, freshDir} from './util.js';

const near = (a, b, tolerance, message) =>
    assert(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);

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
    const size = backdropSize([2560, 1440], 1, 2);
    near(size.factor[0], 3 / FROST.sample, 0.002, 'small: a fifth or so of the monitor');
    assertEqual([size.width, size.height], [Math.round(2560 * 3 / FROST.sample), Math.round(1440 * 3 / FROST.sample)]);
    assertEqual(size.factor, [size.width / 2560, size.height / 1440], 'each side its own factor, whole pixels');
    near(size.sigma, 2 * size.factor[0], 0.01, 'blurred as the glass blurs, in its pixels');
    const hidpi = backdropSize([3840, 2160], 2, 2);
    near(hidpi.factor[0], 3 / (2 * FROST.sample), 0.002, 'logical: twice as many pixels at scale 2');
    near(hidpi.sigma, 2 * 2 * hidpi.factor[0], 0.01);
    assertEqual(backdropSize([3840, 2160], 1).sigma, 0, 'clear glass: not blurred');
    assertEqual(backdropSize([50, 40], 0.1).factor, [1, 1], 'never larger than the monitor');
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
        ['blurred for another look', picture, {...options, frost: frostOf(LOOK.regular)}],
    ])
        assert(backdropKey(p, o) !== key, `${what}: a name of its own`);
    assertEqual(backdropKey(picture, {...options, frost: frostOf(LOOK.clear)}), key, 'clear glass: as the picture is');
    assert(BACKDROP_VERSION >= 3, 'made anew since the glass is drawn on the GPU');
}

export function testFrostOf() {
    assertEqual(frostOf(LOOK.regular), {sigma: LOOK.regular.blur, saturation: 1, lift: 0},
        'blurred as the glass blurs, its colours and light as they are (the face does the rest)');
    assertEqual(frostOf(LOOK.clear), {sigma: 0, saturation: 1, lift: 0}, 'clear glass: sharp');
    assertEqual(frostOf(null), {sigma: 0, saturation: 1, lift: 0}, 'no look: as the picture is');
}

export function testGlassColor() {
    const behind = '#406080';
    const light = '#f4f4f4';
    const rgb = hex => hexToRgb(hex).map(v => v / 255);
    const hex = c => `#${c.map(v => Math.round(255 * Math.min(1, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
    assertEqual(glassColor({behind, tone: light, wash: 0, face: 'light'}), hex(faceColor(rgb(behind), 'light')),
        'no wash: the glass\'s face, as the GPU makes it');
    assertEqual(glassColor({behind, tone: light, wash: 1}), light, 'washed all the way: the tone');
    const lightness = options => hexToOklch(glassColor({behind, tone: light, ...options}))[0];
    assert(lightness({wash: 0.4}) > lightness({wash: GLASS.wash}), 'more wash, lighter light glass');
    assert(lightness({face: 'light', wash: 0}) > hexToOklch(behind)[0], 'light glass: lighter than what is behind');
    assert(lightness({face: 'dark', wash: 0}) < lightness({face: 'light', wash: 0}), 'dark glass: darker');
    assert(lightness({face: 'clear', wash: 0}) < lightness({face: 'light', wash: 0}), 'clear glass: dimmer than light');
    const [r, g, b] = hexToRgb(glassColor({behind: '#808080', tone: '#808080', wash: 0, face: 'light'}));
    assert(r === g && g === b, `neutral: grey stays grey (${r}, ${g}, ${b})`);
}

export function testPlanBridge() {
    // What a plan is told of the glass at rest: how far it is washed
    // towards the tone.
    near(tintShown(), GLASS.wash, 1e-9, 'the glass at rest');
    assertEqual(glassFor(null), {wash: GLASS.wash}, 'nothing asked: at rest');
    assertEqual(glassFor(tintShown() / 2), {wash: GLASS.wash}, 'never less than at rest');
    for (const shown of [0.2, 0.45, 0.7, 0.92])
        near(tintShown(glassFor(shown)), shown, 1e-9, `${shown}: as much of the tone as asked`);
    assertEqual(glassFor(1.4), {wash: 1}, 'all of it at most');
    // As the lock screen's plan has it: light glass digits over a light
    // part of the wallpaper, no shadow to give them, ask for more of the
    // tone.
    const stats = {tenths: {dark: '#8090a0', middle: '#8090a0', light: '#8090a0'}};
    const tone = {color: '#ffffff', dark: false};
    const ink = glass => glassColor({behind: '#8090a0', tone: tone.color, ...glassFor(glass), face: 'light'});
    const plan = legibilityPlan({size: 60, weight: 600, tone, stats, glass: tintShown(), ink, dim: 0.86,
        reach: {bolder: 0, shadow: 0, glass: 0.92}});
    assert(plan.glass > tintShown() && plan.glass <= 0.92, `the plan wants more of the tone (${JSON.stringify(plan)})`);
    near(tintShown(glassFor(plan.glass)), plan.glass, 1e-9, 'and the glass shows it');
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
    assertEqual([backdrop.sample.width, backdrop.sample.height], [spec.size.width, spec.size.height]);
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
