import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    DEFAULT_MODEL, MAX_COVER, MODELS, chosenModel, coverage, cutoutKey, cutoutOpacity, cutoutPath, depthDir,
    lockWallpaper, modelPath, pictureState, placement, subjectTop,
} from '../lib/depth.js';
import {fakeDepthModel} from './fakeOnnx.js';
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

export function testSubjectTop() {
    // A hill over the bottom half of the picture, rising to the right (its
    // top at row 60 on the left, 40 on the right); drawn at twice its size.
    const [width, height] = [100, 100];
    const cutout = {pixels: new Uint8Array(width * height * 4), width, height, rowstride: width * 4};
    for (let x = 0; x < width; x++) {
        for (let y = Math.round(60 - x / 5); y < height; y++)
            cutout.pixels[y * cutout.rowstride + x * 4 + 3] = 255;
    }
    const shown = {x: 0, y: 0, width: 200, height: 200};
    const left = subjectTop(cutout, shown, {x: 0, width: 40, from: 0, to: 200});
    const right = subjectTop(cutout, shown, {x: 160, width: 40, from: 0, to: 200});
    assert(Math.abs(left - 118) <= 4 && Math.abs(right - 86) <= 4, `where the hill starts under each (${left}, ${right})`);
    const wide = subjectTop(cutout, shown, {x: 0, width: 200, from: 0, to: 200});
    assert(wide > right && wide < left, `under a wide clock, once it fills a good part of it (${wide})`);
    assertEqual(subjectTop(cutout, shown, {x: 0, width: 40, from: 0, to: 100}), null, 'nothing above the hill');
    assertEqual(subjectTop(cutout, shown, {x: 0, width: 40, from: 150, to: 200}), 150, 'in it from the start');
    assertEqual(subjectTop(cutout, shown, {x: 300, width: 40, from: 0, to: 200}), null, 'off the picture: nothing');
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
