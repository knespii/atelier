import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    CUTOUT_VERSION, DEFAULT_MODEL, MAX_COVER, MAX_COVER_GLASS, MAX_GLYPH_COVER, MODELS, SUBJECT_MODELS, chosenModel,
    chosenSubjectModel, coverage, cutoutKey, cutoutModels, cutoutOpacity, cutoutPath, depthDir, legibility,
    lockWallpaper, modelPath, modelsTag, pictureState, placement, pngText, subjectModelPath,
} from '../lib/depth.js';
import {STRETCH} from '../lib/lockLook.js';
import {fakeDepthModel, fakeSubjectModel} from './fakeOnnx.js';
import {assert, assertEqual, freshDir, writeFile} from './util.js';

const WORKER = GLib.build_filenamev([GLib.get_current_dir(), 'lib', 'depthWorker.py']);

export function testCutoutKey() {
    const picture = {path: '/pictures/a.jpg', mtime: 1700000000, size: 123456};
    const key = cutoutKey(picture, [1920, 1080]);
    assert(/^[0-9a-f]{40}$/.test(key), `a SHA-1 (${key})`);
    assertEqual(cutoutKey({...picture}, [1920, 1080]), key, 'the same picture, the same name');
    for (const [what, other] of [
        ['moved', {...picture, path: '/pictures/b.jpg'}],
        ['written anew', {...picture, mtime: picture.mtime + 1}],
        ['another size', {...picture, size: picture.size + 1}],
    ])
        assert(cutoutKey(other, [1920, 1080]) !== key, `a picture ${what} gets a name of its own`);
    assert(cutoutKey(picture, [2560, 1440]) !== key, 'and so does another monitor');
    assertEqual(cutoutKey(picture, [1920.4, 1080]), key, 'in whole pixels');
    assertEqual(cutoutPath(picture, [1920, 1080]), `${depthDir()}/${key}.png`);
    assert(depthDir().startsWith(GLib.get_user_cache_dir()) && depthDir().endsWith('/atelier/depth'),
        `in Atelier's cache (${depthDir()})`);
    assert(modelPath('base').startsWith(GLib.get_user_data_dir()) &&
        modelPath('base').endsWith('/atelier/models/depth-anything-v2-base.onnx'),
    `the model with Atelier's data (${modelPath('base')})`);
}

export function testModels() {
    assertEqual(Object.keys(MODELS), ['small', 'base', 'large'], 'three sizes, smallest first');
    for (const [id, model] of Object.entries(MODELS)) {
        assert(model.url.startsWith(`https://huggingface.co/onnx-community/depth-anything-v2-${id}/resolve/`) &&
            /\/resolve\/[0-9a-f]{40}\/onnx\/model\.onnx$/.test(model.url),
        `${id}: from Hugging Face, at a revision of its own (${model.url})`);
        assert(/^[0-9a-f]{64}$/.test(model.sha256) && Number.isInteger(model.bytes) && model.bytes > 50e6,
            `${id}: its SHA-256 and size, to check it by`);
        assert(model.label && model.title && model.time, `${id}: what the settings say of it`);
    }
    assertEqual(new Set(Object.values(MODELS).map(m => m.name)).size, 3, 'each in a file of its own');
    assertEqual(MODELS.small.license, 'Apache-2.0');
    assertEqual([MODELS.base.license, MODELS.large.license], ['CC-BY-NC-4.0', 'CC-BY-NC-4.0']);
    assert(MODELS.small.bytes < MODELS.base.bytes && MODELS.base.bytes < MODELS.large.bytes, 'growing');
    assertEqual(DEFAULT_MODEL, 'base');
}

export function testChosenModel() {
    const having = ids => id => ids.includes(id);
    assertEqual(chosenModel('small', having(['large'])), 'small', 'the one chosen, downloaded or not');
    assertEqual(chosenModel('', having([])), DEFAULT_MODEL, 'none chosen, none there: the one offered first');
    assertEqual(chosenModel('', having(['small', 'large'])), 'large', 'none chosen: the biggest one there');
    assertEqual(chosenModel('', having(['small'])), 'small');
    assertEqual(chosenModel('toString', having(['base'])), 'base', 'one that isn\'t a model counts as none');
}

export function testSubjectModels() {
    assertEqual(Object.keys(SUBJECT_MODELS), ['lite'], 'BiRefNet lite');
    const lite = SUBJECT_MODELS.lite;
    assertEqual(lite.url, 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/' +
        'de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model.onnx', 'from Hugging Face, at its revision, in full precision');
    assertEqual([lite.sha256, lite.bytes], ['5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333', 224005088],
        'its SHA-256 and size, as Hugging Face gives them');
    assertEqual([lite.license, lite.label], ['MIT', '224 MB']);
    assert(lite.title && lite.time, 'what the settings say of it');
    assert(!Object.values(MODELS).some(model => model.name === lite.name), 'in a file of its own');
    assert(subjectModelPath('lite').startsWith(GLib.get_user_data_dir()) &&
        subjectModelPath('lite').endsWith('/atelier/models/birefnet-lite.onnx'),
    `with the depth models (${subjectModelPath('lite')})`);
}

export function testChosenSubjectModel() {
    const having = ids => id => ids.includes(id);
    assertEqual(chosenSubjectModel('', having([])), 'none', 'none chosen, none there: none');
    assertEqual(chosenSubjectModel('', having(['lite'])), 'lite', 'none chosen: the one downloaded');
    assertEqual(chosenSubjectModel('lite', having([])), 'lite', 'the one chosen, downloaded or not');
    assertEqual(chosenSubjectModel('none', having(['lite'])), 'none', 'none, on purpose, downloaded or not');
    assertEqual(chosenSubjectModel('toString', having(['lite'])), 'lite', 'what isn\'t a model counts as nothing chosen');
}

export function testCutoutModels() {
    const having = ids => path => ids.some(id => path.endsWith(`/${id}`));
    const [large, base, lite] = [modelPath('large'), modelPath('base'), subjectModelPath('lite')];
    assertEqual(cutoutModels('', '', having(['depth-anything-v2-large.onnx', 'birefnet-lite.onnx'])),
        {model: large, subject: lite}, 'the ones downloaded');
    assertEqual(cutoutModels('', 'none', having(['depth-anything-v2-large.onnx', 'birefnet-lite.onnx'])),
        {model: large, subject: null}, 'not the subject model when none is chosen');
    assertEqual(cutoutModels('base', 'lite', having(['depth-anything-v2-large.onnx'])),
        {model: null, subject: null}, 'none of them when the ones chosen aren\'t downloaded');
    assertEqual(cutoutModels('', '', having(['birefnet-lite.onnx'])), {model: null, subject: lite},
        'the subject model alone');
    assertEqual(cutoutModels('base', '', having(['depth-anything-v2-base.onnx'])), {model: base, subject: null});
    assertEqual(modelsTag({model: large, subject: lite}), 'depth-anything-v2-large.onnx birefnet-lite.onnx',
        'what the worker writes in a cutout of them');
    assertEqual(modelsTag({model: null, subject: lite}), '- birefnet-lite.onnx');
    assertEqual(modelsTag({model: base, subject: null}), 'depth-anything-v2-base.onnx -');
    assert(CUTOUT_VERSION >= 5, 'cutouts from before the subject made anew');
}

export function testPngText() {
    const path = GLib.build_filenamev([freshDir('depth-png'), 'cutout.png']);
    const picture = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, true, 8, 64, 32);
    picture.fill(0x20406080);
    picture.savev(path, 'png', ['tEXt::atelier-models', 'tEXt::atelier-width'],
        ['depth-anything-v2-large.onnx birefnet-lite.onnx', '1920']);
    const [, bytes] = GLib.file_get_contents(path);
    assertEqual(pngText(bytes), {'atelier-models': 'depth-anything-v2-large.onnx birefnet-lite.onnx',
        'atelier-width': '1920'}, 'the text a PNG keeps');
    assertEqual(pngText(bytes.subarray(0, 60))['atelier-models'], undefined, 'not what was cut off');
    assertEqual(pngText(new TextEncoder().encode('not a picture at all')), {}, 'nothing of what isn\'t a PNG');
}

export function testPictureState() {
    const path = GLib.build_filenamev([freshDir('depth'), 'a.jpg']);
    writeFile(path, 'not really a picture');
    const state = pictureState(path);
    assertEqual([state.path, state.size], [path, 20]);
    assert(state.mtime > 0, 'when it was changed');
    assertEqual(pictureState(`${path}.gone`), null, 'none for a picture that is gone');
}

export function testLockWallpaper() {
    const background = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    try {
        background.set_string('picture-uri', 'file:///pictures/light.jpg');
        background.set_string('picture-uri-dark', 'file:///pictures/dark.jpg');
        background.set_string('picture-options', 'zoom');
        iface.set_string('color-scheme', 'default');
        assertEqual(lockWallpaper(background, iface), '/pictures/light.jpg');
        iface.set_string('color-scheme', 'prefer-dark');
        assertEqual(lockWallpaper(background, iface), '/pictures/dark.jpg', 'the dark one when the style is dark');
        background.set_string('picture-uri-dark', 'file:///pictures/day.xml');
        assertEqual(lockWallpaper(background, iface), null, 'not a slideshow');
        background.set_string('picture-uri-dark', 'file:///pictures/dark.jpg');
        background.set_string('picture-options', 'none');
        assertEqual(lockWallpaper(background, iface), null, 'none without a picture');
    } finally {
        ['picture-uri', 'picture-uri-dark', 'picture-options'].forEach(key => background.reset(key));
        iface.reset('color-scheme');
    }
}

export function testPlacementZoom() {
    // Wider than the monitor: as high as it, cut off at the sides.
    assertEqual(placement('zoom', [1920, 1080], [4000, 2000]), {x: -120, y: 0, width: 2160, height: 1080});
    // Taller: as wide as it, cut off at the top and the bottom.
    assertEqual(placement('zoom', [1920, 1080], [1600, 1200]), {x: 0, y: -180, width: 1920, height: 1440});
    // A square one, as GNOME's own wallpapers are.
    assertEqual(placement('zoom', [1920, 1080], [4096, 4096]), {x: 0, y: -420, width: 1920, height: 1920});
    // Smaller than the monitor: zoomed in all the same.
    assertEqual(placement('zoom', [1920, 1080], [960, 540]), {x: 0, y: 0, width: 1920, height: 1080});
    // Whole pixels as mutter has them (truncated, half of each side apart).
    assertEqual(placement('zoom', [1366, 768], [1000, 999]), {x: 0, y: -298, width: 1366, height: 1364});
}

export function testPlacementScaledCenteredStretched() {
    // Scaled: all of it on the monitor, bars at the sides or above and below.
    assertEqual(placement('scaled', [1920, 1080], [4000, 2000]), {x: 0, y: 60, width: 1920, height: 960});
    assertEqual(placement('scaled', [1920, 1080], [1600, 1200]), {x: 240, y: 0, width: 1440, height: 1080});
    // Centered: as big as it is, in the middle.
    assertEqual(placement('centered', [1920, 1080], [800, 601]), {x: 560, y: 240, width: 800, height: 601});
    assertEqual(placement('centered', [1920, 1080], [3000, 2000]), {x: -540, y: -460, width: 3000, height: 2000});
    // Stretched: over the whole monitor, however it is.
    assertEqual(placement('stretched', [1920, 1080], [800, 800]), {x: 0, y: 0, width: 1920, height: 1080});
    for (const style of ['wallpaper', 'spanned', 'none', ''])
        assertEqual(placement(style, [1920, 1080], [800, 800]), null, `${style || 'nothing'} is not followed`);
    assertEqual(placement('zoom', [1920, 1080], [0, 0]), null, 'nor a picture of no size');
}

// A cutout of width × height with a solid rectangle of the subject in it.
function cutoutWith(width, height, [x1, y1, x2, y2]) {
    const rowstride = width * 4;
    const pixels = new Uint8Array(rowstride * height);
    for (let y = y1; y < y2; y++) {
        for (let x = x1; x < x2; x++)
            pixels[y * rowstride + x * 4 + 3] = 255;
    }
    return {pixels, width, height, rowstride};
}

export function testCoverage() {
    // The left half of the picture is the subject; drawn at twice its size.
    const cutout = cutoutWith(100, 50, [0, 0, 50, 50]);
    const shown = {x: 0, y: 0, width: 200, height: 100};
    const near = (a, b) => Math.abs(a - b) < 0.02;
    assertEqual(coverage(cutout, shown, {x: 0, y: 0, width: 100, height: 100}), 1, 'all of it');
    assertEqual(coverage(cutout, shown, {x: 100, y: 0, width: 100, height: 100}), 0, 'none of it');
    const half = coverage(cutout, shown, {x: 50, y: 20, width: 100, height: 40});
    assert(near(half, 0.5), `half of it (${half})`);
    // Moved as the picture is (zoomed in, cut off at the left).
    const moved = coverage(cutout, {x: -50, y: 0, width: 200, height: 100}, {x: 0, y: 0, width: 100, height: 100});
    assert(near(moved, 0.5), `as the picture is drawn (${moved})`);
    const off = coverage(cutout, shown, {x: -100, y: 0, width: 200, height: 100});
    assert(near(off, 0.5), `what lies off the picture counts as uncovered (${off})`);
    assertEqual(coverage(cutout, shown, {x: 0, y: 0, width: 0, height: 10}), 0, 'nothing for a clock of no size');
    // A big clock, still only so many points looked at.
    const big = cutoutWith(1000, 1000, [0, 0, 300, 1000]);
    const share = coverage(big, {x: 0, y: 0, width: 1000, height: 1000}, {x: 0, y: 0, width: 1000, height: 1000});
    assert(near(share, 0.3) && share < MAX_COVER, `a third of it, still under the limit (${share})`);
    assert(MAX_COVER > 0.2 && MAX_COVER < 0.6, 'the limit lets a clock be partly covered, not hidden');
}

// Four digits of a clock, 100 × 200 each, side by side from (100, 100), on
// a monitor of 800 × 400 the cutout covers one to one.
const DIGITS = [100, 220, 340, 460].map(x => ({x, y: 100, width: 100, height: 200}));
const MONITOR = {x: 0, y: 0, width: 800, height: 400};

// A cutout of 800 × 400 with the subject where inside(x, y) says.
function cutoutWhere(inside) {
    const [width, height] = [800, 400];
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++)
            pixels[(y * width + x) * 4 + 3] = inside(x, y) ? 255 : 0;
    }
    return {pixels, width, height, rowstride: width * 4};
}

export function testLegibilityGlassFeet() {
    // A hill over the digits' feet: the bottom quarter of them, as the
    // glass face has it on purpose.
    const hill = cutoutWhere((x, y) => y >= 250);
    const glass = legibility(hill, MONITOR, {glyphs: DIGITS, overlap: STRETCH.overlap, glass: true});
    assert(glass.stays && glass.worst === 0 && glass.glyph === -1 && Math.abs(glass.whole - 0.25) < 0.01,
        `the glass digits' feet behind the hill: on, nothing that should show covered (${JSON.stringify(glass)})`);
    const plain = legibility(hill, MONITOR, {glyphs: DIGITS});
    assert(plain.stays && Math.abs(plain.worst - 0.25) < 0.01,
        `another face: a quarter of each digit gone still reads (${JSON.stringify(plain)})`);
    // A little higher: a third of each.
    const higher = cutoutWhere((x, y) => y >= 233);
    const covered = legibility(higher, MONITOR, {glyphs: DIGITS});
    assert(!covered.stays && covered.worst > MAX_GLYPH_COVER && covered.whole < MAX_COVER,
        `a third of every digit gone: off, though the clock as a whole is under MAX_COVER (${JSON.stringify(covered)})`);
    const tall = legibility(higher, MONITOR, {glyphs: DIGITS, overlap: STRETCH.overlap, glass: true});
    assert(tall.stays && tall.worst < 0.15,
        `the glass digits, standing behind it a quarter on purpose, keep enough (${JSON.stringify(tall)})`);
}

export function testLegibilityOneDigit() {
    // A head rising into the second digit only, over 40 % of it: the clock
    // as a whole is a tenth covered – on by the box alone, off digit by digit.
    const head = cutoutWhere((x, y) => x >= 220 && x < 320 && y >= 180);
    const box = {x: 100, y: 100, width: 460, height: 200};
    assert(coverage(head, MONITOR, box) < MAX_COVER, 'little of the clock\'s box');
    const verdict = legibility(head, MONITOR, {glyphs: DIGITS, box});
    assert(!verdict.stays && verdict.glyph === 1 && Math.abs(verdict.worst - 0.6) < 0.02,
        `one digit losing more than MAX_GLYPH_COVER is enough (${JSON.stringify(verdict)})`);
    // A narrow subject between the digits: none of them loses anything.
    const pole = cutoutWhere(x => x >= 202 && x < 218);
    assertEqual(legibility(pole, MONITOR, {glyphs: DIGITS, box}).stays, true, 'between the digits: on');
    const none = legibility(cutoutWhere(() => false), MONITOR, {glyphs: DIGITS, box});
    assertEqual([none.stays, none.worst, none.glyph, none.whole], [true, 0, -1, 0], 'nothing in front: on');
}

export function testLegibilityWhole() {
    // The subject over the clock's box all round its digits (none of them
    // touched): the box over MAX_COVER is enough.
    const around = cutoutWhere((x, y) => y < 100 || y >= 300);
    const box = {x: 100, y: 0, width: 460, height: 400};
    const verdict = legibility(around, MONITOR, {glyphs: DIGITS, box});
    assert(!verdict.stays && verdict.worst === 0 && verdict.whole > MAX_COVER,
        `the clock as a whole covered too much: off (${JSON.stringify(verdict)})`);
    // The glass face may have more of it covered.
    const half = cutoutWhere((x, y) => y >= 200);
    const glass = legibility(half, MONITOR, {glyphs: DIGITS, overlap: 0.5, glass: true});
    assert(glass.stays && glass.whole > MAX_COVER && glass.whole <= MAX_COVER_GLASS,
        `glass digits half behind it on purpose: still on (${JSON.stringify(glass)})`);
    // Digits off the picture count as uncovered; none at all, nothing covered.
    const off = legibility(cutoutWhere(() => true), {x: 1000, y: 0, width: 800, height: 400}, {glyphs: DIGITS});
    assertEqual([off.stays, off.worst], [true, 0], 'the cutout elsewhere: on');
    assertEqual(legibility(around, MONITOR, {glyphs: []}).stays, true, 'no digits, no box: nothing to keep legible');
}

export function testCutoutOpacity() {
    assertEqual(cutoutOpacity(0), 1, 'all of it at rest');
    assert(cutoutOpacity(0.15) > 0.4 && cutoutOpacity(0.15) < 0.6, 'fading as the prompt comes up');
    assertEqual([cutoutOpacity(1 / 3), cutoutOpacity(0.5), cutoutOpacity(1)], [0, 0, 0],
        'gone before the wallpaper is much blurred');
}

function runWorker(args, python = ['python3']) {
    const process = Gio.Subprocess.new([...python, WORKER, ...args],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [, stdout] = process.communicate_utf8(null, null);
    return {status: process.get_exit_status(), answer: JSON.parse(stdout.trim().split('\n').at(-1))};
}

const hasPython = () => Boolean(GLib.find_program_in_path('python3'));

export function testWorkerWithoutItsModules() {
    if (!hasPython()) {
        print('      (no python3 here: skipped)');
        return;
    }
    // (-S: without the system's packages, as if none were installed.)
    const check = runWorker(['--check'], ['python3', '-S']);
    assert(check.status === 0 && check.answer.ok === false && check.answer.missing.includes('python3-onnxruntime'),
        `--check says what is missing (${JSON.stringify(check.answer)})`);
    const dir = freshDir('depth-worker');
    const run = runWorker(['--model', `${dir}/m.onnx`, '--input', `${dir}/a.png`, '--output', `${dir}/c.png`,
        '--width', '64', '--height', '64'], ['python3', '-S']);
    assert(run.status === 3 && run.answer.ok === false && /sudo apt install python3-onnxruntime/.test(run.answer.error),
        `it stops at once and says how to install them (${run.status}: ${run.answer.error})`);
    assert(!GLib.file_test(`${dir}/c.png`, GLib.FileTest.EXISTS), 'and writes nothing');
    const wrong = runWorker(['--colour', 'red']);
    assertEqual([wrong.status, wrong.answer.ok], [2, false], 'asked wrongly, it says so');
}

function workerCanRun() {
    if (!hasPython())
        return false;
    return runWorker(['--check']).answer.ok;
}

export function testWorkerMakesACutout() {
    if (!workerCanRun()) {
        print('      (no python3-onnxruntime, numpy or PIL here: skipped)');
        return;
    }
    const dir = freshDir('depth-worker');
    const model = `${dir}/depth.onnx`;
    GLib.file_set_contents(model, fakeDepthModel());
    const check = runWorker(['--check', '--model', model]);
    assertEqual(check.answer, {ok: true, missing: [], model: 'ok'}, 'the made-up model loads');
    GLib.file_set_contents(`${dir}/broken.onnx`, 'not a model');
    const broken = runWorker(['--check', '--model', `${dir}/broken.onnx`]);
    assert(!broken.answer.ok && broken.answer.model.startsWith('does not load'), 'a broken one is told apart');
    assertEqual(runWorker(['--check', '--model', `${dir}/gone.onnx`]).answer.model, 'missing');

    // A light disc on a dark picture, 1600 × 1000: to the made-up model,
    // the disc is near, the rest far, with nothing between.
    const picture = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 1600, 1000);
    picture.fill(0x141e28ff);
    for (let y = 300; y < 700; y++) {
        const half = Math.floor(Math.sqrt(200 * 200 - (y + 0.5 - 500) ** 2));
        // (A row of the picture itself, filled.)
        picture.new_subpixbuf(800 - half, y, 2 * half, 1).fill(0xfaf0e6ff);
    }
    picture.savev(`${dir}/disc.jpg`, 'jpeg', ['quality'], ['95']);
    const target = `${dir}/depth/cutout.png`;
    const run = runWorker(['--model', model, '--input', `${dir}/disc.jpg`, '--output', target,
        '--width', '800', '--height', '450']);
    assert(run.status === 0 && run.answer.ok && run.answer.split === 'gap', `done (${JSON.stringify(run.answer)})`);
    const cutout = GdkPixbuf.Pixbuf.new_from_file(target);
    assertEqual([cutout.get_width(), cutout.get_height()], [800, 500], 'big enough to cover the monitor, zoomed in');
    assertEqual([cutout.get_option('tEXt::atelier-width'), cutout.get_option('tEXt::atelier-height')],
        ['1600', '1000'], 'with the picture\'s own size, to place it as GNOME does');
    const alpha = (x, y) => cutout.get_pixels()[y * cutout.get_rowstride() + x * 4 + 3];
    assert(alpha(400, 250) === 255 && alpha(10, 10) === 0 && alpha(790, 490) === 0,
        `the near disc opaque, the rest see-through (${alpha(400, 250)}, ${alpha(10, 10)})`);
    const edge = [296, 297, 298, 299, 300, 301, 302, 303, 304].map(x => alpha(x, 250));
    assert(edge.some(a => a > 0 && a < 255) && alpha(294, 250) < 32 && alpha(306, 250) > 223,
        `its edge on the disc's own, soft over a pixel or two (${edge})`);
    assert(Math.abs(run.answer.front - Math.PI * 100 * 100 / (800 * 500)) < 0.01,
        `it says how much of it stands in front (${run.answer.front})`);
    assert(!GLib.file_test(`${target}.partial`, GLib.FileTest.EXISTS), 'written whole');

    const failed = runWorker(['--model', model, '--input', `${dir}/gone.jpg`, '--output', `${dir}/x.png`,
        '--width', '80', '--height', '45']);
    assert(failed.status === 4 && !failed.answer.ok && failed.answer.error,
        `a picture that can't be read: it says why (${failed.answer.error})`);
}

// A picture of width × height, each pixel's [r, g, b] from colour(x, y).
function paint(width, height, colour) {
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++)
            pixels.set(colour(x, y), (y * width + x) * 3);
    }
    return GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(pixels), GdkPixbuf.Colorspace.RGB, false, 8,
        width, height, width * 3);
}

// The cutouts the worker makes with the made-up model, 800 × 450, in dir.
function cutoutsIn(dir) {
    const model = `${dir}/depth.onnx`;
    GLib.file_set_contents(model, fakeDepthModel());
    return (name, picture) => {
        picture.savev(`${dir}/${name}.png`, 'png', [], []);
        const run = runWorker(['--model', model, '--input', `${dir}/${name}.png`, '--output', `${dir}/${name}-cutout.png`,
            '--width', '800', '--height', '450']);
        assert(run.status === 0 && run.answer.ok, `done (${JSON.stringify(run.answer)})`);
        const cutout = GdkPixbuf.Pixbuf.new_from_file(`${dir}/${name}-cutout.png`);
        const pixels = cutout.get_pixels();
        return {answer: run.answer, alpha: (x, y) => pixels[y * cutout.get_rowstride() + x * 4 + 3]};
    };
}

export function testWorkerFindsTheFarLayer() {
    if (!workerCanRun()) {
        print('      (no python3-onnxruntime, numpy or PIL here: skipped)');
        return;
    }
    const cutoutOf = cutoutsIn(freshDir('depth-far'));
    // No gap in the depths: a little going away into the dark on the left,
    // a wide wall (the far layer, as many pixels as any depth has) and, on
    // the right, coming nearer and nearer. In front: only what is clearly
    // nearer than the wall.
    const grey = v => [v, v, v].map(c => Math.round(c * 255));
    const {answer, alpha} = cutoutOf('wall', paint(800, 450, x => {
        if (x < 200)
            return grey(0.4 * x / 200);
        return grey(x < 500 ? 0.4 : 0.4 + 0.6 * (x - 500) / 300);
    }));
    assertEqual([answer.split, answer.sky], ['far', false], `the far layer without a gap (${JSON.stringify(answer)})`);
    assert(alpha(100, 200) === 0 && alpha(350, 200) === 0 && alpha(550, 200) === 0,
        `what is farther, the wall and what is hardly nearer see-through (${[100, 350, 550].map(x => alpha(x, 200))})`);
    assert(alpha(720, 200) === 255 && alpha(790, 200) === 255,
        `what is clearly nearer in front (${[720, 790].map(x => alpha(x, 200))})`);
    // (Nearer than the wall by NEARER, 1.6: from about 0.64 of the way, x 620.)
    const from = [...Array(300).keys()].map(x => 500 + x).find(x => alpha(x, 200) >= 128);
    assert(Math.abs(from - 620) < 30, `from where it is NEARER times as near as the wall (${from})`);
}

export function testWorkerFindsTheSky() {
    if (!workerCanRun()) {
        print('      (no python3-onnxruntime, numpy or PIL here: skipped)');
        return;
    }
    const cutoutOf = cutoutsIn(freshDir('depth-sky'));

    // A blue sky, paler down low, over a bright hill: to the made-up model,
    // the hill is the nearest, the sky the farthest – and a grey cloud in
    // it nearer than the sky's edge: it isn't in front all the same.
    const horizon = x => 240 + Math.round(30 * Math.sin(x / 130));
    const cloud = (x, y) => ((x - 600) / 70) ** 2 + ((y - 90) / 28) ** 2 < 1;
    const landscape = cutoutOf('landscape', paint(800, 450, (x, y) => {
        if (cloud(x, y))
            return [175, 175, 185];
        if (y < horizon(x))
            return [20 + y / 5, 60 + y / 5, 150 + y / 5];
        return [255, 255, 150];
    }));
    assert(landscape.answer.sky && landscape.answer.split === 'gap',
        `the sky is found (${JSON.stringify(landscape.answer)})`);
    const {alpha} = landscape;
    assert(alpha(100, 60) === 0 && alpha(300, 200) === 0, `the sky see-through (${alpha(100, 60)}, ${alpha(300, 200)})`);
    assert(alpha(600, 90) === 0 && alpha(560, 95) === 0, `and the cloud in it (${alpha(600, 90)}, ${alpha(560, 95)})`);
    assert(alpha(600, 400) === 255 && alpha(200, 400) === 255,
        `the hill in front (${alpha(600, 400)}, ${alpha(200, 400)})`);
    assert(alpha(650, horizon(650) + 4) === 255 && alpha(650, horizon(650) - 4) === 0,
        `the edge on the horizon (${[-8, -4, -2, -1, 0, 1, 2, 4, 8].map(d => alpha(650, horizon(650) + d))})`);
    assert(Math.abs(landscape.answer.front - 0.47) < 0.05,
        `about the share under the horizon (${landscape.answer.front})`);

    // Texture all over (a pattern, a room): no sky.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const noise = cutoutOf('noise', paint(800, 450, () => [random() * 255, random() * 255, random() * 255]));
    assertEqual(noise.answer.sky, false, 'no sky in a pattern');

    // A blue picture with nothing under it: no ground, so no sky either.
    const blue = cutoutOf('blue', paint(800, 450, (x, y) => [50 + y / 5, 110 + y / 6, 220]));
    assertEqual(blue.answer.sky, false, 'blue all over is not a sky with something in front');
}

// The worker with the made-up subject model (picking out what is red, or
// as the weights given say), with the made-up depth model or without one:
// pictures of 400 × 300, cutouts for a monitor as big.
function subjectCutouts(dir, {weights, bias} = {}) {
    const subject = `${dir}/subject.onnx`;
    GLib.file_set_contents(subject, fakeSubjectModel(weights, bias));
    const depth = `${dir}/depth.onnx`;
    GLib.file_set_contents(depth, fakeDepthModel());
    return (name, picture, {withDepth = false, withSubject = true} = {}) => {
        picture.savev(`${dir}/${name}.png`, 'png', [], []);
        const run = runWorker([...withDepth ? ['--model', depth] : [], ...withSubject ? ['--subject', subject] : [],
            '--input', `${dir}/${name}.png`, '--output', `${dir}/${name}-cutout.png`, '--width', '400', '--height', '300']);
        assert(run.status === 0 && run.answer.ok, `done (${JSON.stringify(run.answer)})`);
        const cutout = GdkPixbuf.Pixbuf.new_from_file(`${dir}/${name}-cutout.png`);
        const pixels = cutout.get_pixels();
        return {answer: run.answer, cutout, alpha: (x, y) => pixels[y * cutout.get_rowstride() + x * 4 + 3]};
    };
}

const disc = (cx, cy, r) => (x, y) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 < r * r;

export function testWorkerChecksTheSubjectModel() {
    if (!workerCanRun()) {
        print('      (no python3-onnxruntime, numpy or PIL here: skipped)');
        return;
    }
    const dir = freshDir('depth-subject');
    GLib.file_set_contents(`${dir}/subject.onnx`, fakeSubjectModel());
    GLib.file_set_contents(`${dir}/depth.onnx`, fakeDepthModel());
    assertEqual(runWorker(['--check', '--subject', `${dir}/subject.onnx`]).answer, {ok: true, missing: [], subject: 'ok'},
        'the made-up subject model loads');
    assertEqual(runWorker(['--check', '--model', `${dir}/depth.onnx`, '--subject', `${dir}/subject.onnx`]).answer,
        {ok: true, missing: [], model: 'ok', subject: 'ok'}, 'each model said of');
    GLib.file_set_contents(`${dir}/broken.onnx`, 'not a model');
    const broken = runWorker(['--check', '--model', `${dir}/depth.onnx`, '--subject', `${dir}/broken.onnx`]).answer;
    assert(!broken.ok && broken.model === 'ok' && broken.subject.startsWith('does not load'),
        `a broken one told apart (${JSON.stringify(broken)})`);
    assertEqual(runWorker(['--check', '--subject', `${dir}/gone.onnx`]).answer.subject, 'missing');
    const neither = runWorker(['--input', `${dir}/a.png`, '--output', `${dir}/c.png`, '--width', '4', '--height', '4']);
    assert(neither.status === 2 && /--model or --subject/.test(neither.answer.error), 'without a model, it says so');
}

export function testWorkerHoldsASureSubject() {
    if (!workerCanRun()) {
        print('      (no python3-onnxruntime, numpy or PIL here: skipped)');
        return;
    }
    const cutoutOf = subjectCutouts(freshDir('depth-subject'));
    // A red disc on grey: the subject model alone stands the disc in front,
    // its edge on the disc's own.
    const red = disc(200, 150, 60);
    const picture = paint(400, 300, (x, y) => (red(x, y) ? [220, 40, 40] : [128, 128, 128]));
    const {answer, cutout, alpha} = cutoutOf('disc', picture);
    const share = Math.PI * 60 * 60 / (400 * 300);
    assert(answer.subject.parts === 1 && Math.abs(answer.subject.held - share) < 0.01 && answer.split === null &&
        answer.far === null, `the subject alone, held (${JSON.stringify(answer)})`);
    assert(alpha(200, 150) === 255 && alpha(200, 100) === 255 && alpha(20, 20) === 0 && alpha(200, 220) === 0,
        `the disc in front, the rest see-through (${alpha(200, 150)}, ${alpha(20, 20)})`);
    assert(alpha(137, 150) < 32 && alpha(143, 150) > 223,
        `its edge on the disc's (${[136, 138, 140, 142, 144].map(x => alpha(x, 150))})`);
    assertEqual(cutout.get_option('tEXt::atelier-models'), '- subject.onnx', 'which models made it, said in it');

    // The depth model sees the grey nearer than the disc (to the made-up
    // one, the brighter the nearer): the subject, far off, is left to it.
    const far = cutoutOf('far', picture, {withDepth: true});
    assert(far.answer.subject.held === 0 && far.answer.subject.left.includes('far') && far.alpha(200, 150) === 0,
        `a subject the depth model has far off stays behind (${JSON.stringify(far.answer.subject)})`);
    assertEqual(far.cutout.get_option('tEXt::atelier-models'), 'depth.onnx subject.onnx');
}

export function testWorkerAddsTheSubject() {
    if (!workerCanRun()) {
        print('      (no python3-onnxruntime, numpy or PIL here: skipped)');
        return;
    }
    // A red disc on a dusky blue, its top bright (near, to the made-up depth
    // model), its foot dark red (farther than the blue, so behind it): the
    // subject model takes the whole disc for the subject, held as most of it
    // is near – its foot stands in front too.
    const cutoutOf = subjectCutouts(freshDir('depth-union'), {weights: [6, -3, -3], bias: -8});
    const red = disc(200, 150, 60);
    const picture = paint(400, 300, (x, y) => {
        if (!red(x, y))
            return [40, 50, 80];
        return y < 192 ? [240, 60, 50] : [125, 0, 0];
    });
    const depthOnly = cutoutOf('depth-only', picture, {withDepth: true, withSubject: false});
    assert(depthOnly.answer.subject === null && depthOnly.alpha(200, 120) === 255 && depthOnly.alpha(200, 202) === 0,
        `the depth model alone: the bright top in front, the dark foot not (${depthOnly.alpha(200, 202)})`);
    const both = cutoutOf('both', picture, {withDepth: true});
    assert(both.answer.subject.parts === 1 && both.alpha(200, 120) === 255 && both.alpha(200, 202) === 255 &&
        both.alpha(20, 20) === 0 && both.alpha(200, 280) === 0,
    `with the subject: the whole disc in front, the rest still behind (${JSON.stringify(both.answer)})`);
    // (The foot: a segment of the disc 18 pixels high, 0.9 % of the picture.)
    assert(Math.abs(both.answer.front - depthOnly.answer.front - 0.0089) < 0.002,
        `that much more in front (${both.answer.front}, ${depthOnly.answer.front})`);
}

export function testWorkerLeavesUnsureSubjects() {
    if (!workerCanRun()) {
        print('      (no python3-onnxruntime, numpy or PIL here: skipped)');
        return;
    }
    const dir = freshDir('depth-unsure');
    const [red, grey] = [[220, 40, 40], [128, 128, 128]];
    const left = (cutoutOf, name, inside) => {
        const {answer, alpha} = cutoutOf(name, paint(400, 300, (x, y) => (inside(x, y) ? red : grey)));
        assert(answer.subject.held === 0 && answer.front === 0 && alpha(200, 150) === 0,
            `${name}: nothing in front (${JSON.stringify(answer.subject)})`);
        return answer.subject.left;
    };
    const cutoutOf = subjectCutouts(dir);
    // Across the picture from side to side: the land, depth's to place.
    assertEqual(left(cutoutOf, 'across', (x, y) => y >= 130 && y < 190), ['across']);
    // A block with a dozen holes in it: a heap of things, not one.
    assertEqual(left(cutoutOf, 'heap', (x, y) => x >= 50 && x < 350 && y >= 50 && y < 250 &&
        !((x - 50) % 75 >= 30 && (x - 50) % 75 < 55 && (y - 50) % 66 >= 20 && (y - 50) % 66 < 45)), ['heap']);
    // A dozen squares, none of them the subject more than the others.
    assertEqual(left(cutoutOf, 'scattered', (x, y) => x % 100 >= 35 && x % 100 < 65 && y % 100 >= 35 && y % 100 < 65),
        ['scattered']);
    // One square under a hundredth of the picture: no subject.
    assertEqual(left(cutoutOf, 'small', (x, y) => x >= 185 && x < 215 && y >= 135 && y < 165), ['small']);
    // A model hardly sure of anything: a haze, not an edge.
    assertEqual(left(subjectCutouts(dir, {weights: [0.4, -0.2, -0.2], bias: 0}), 'haze', disc(200, 150, 60)), ['unsure']);
}

export function testWorkerLeavesTheSkyOut() {
    if (!workerCanRun()) {
        print('      (no python3-onnxruntime, numpy or PIL here: skipped)');
        return;
    }
    // A subject model that picks out what is light: a grey cloud in a blue
    // sky is the sky's, the bright hill under it (from one side to the
    // other) the land's – with the depth model or without.
    const cutoutOf = subjectCutouts(freshDir('depth-cloud'), {weights: [2, 2, 2], bias: -4});
    const cloud = (x, y) => ((x - 300) / 35) ** 2 + ((y - 45) / 14) ** 2 < 1;
    const picture = paint(400, 300, (x, y) => {
        if (cloud(x, y))
            return [175, 175, 185];
        if (y < 130 + Math.round(15 * Math.sin(x / 65)))
            return [20 + y / 3, 60 + y / 3, 150 + y / 3];
        return [255, 255, 150];
    });
    const alone = cutoutOf('cloud', picture);
    assert(alone.answer.sky && alone.answer.subject.held === 0 && alone.answer.front === 0 &&
        JSON.stringify(alone.answer.subject.left) === '["across","sky"]',
    `a cloud picked as the subject is left out, and the land (${JSON.stringify(alone.answer)})`);
    const both = cutoutOf('cloud-depth', picture, {withDepth: true});
    const depth = cutoutOf('cloud-depth-only', picture, {withDepth: true, withSubject: false});
    assert(both.answer.subject.left.includes('sky') && both.alpha(300, 45) === 0 && both.alpha(200, 250) === 255 &&
        both.answer.front === depth.answer.front, `with the depth model, its cutout as it was (${JSON.stringify(both.answer)})`);
}
