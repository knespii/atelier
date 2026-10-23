import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    MAX_COVER, coverage, cutoutKey, cutoutOpacity, cutoutPath, depthDir, lockWallpaper, modelPath,
    pictureState, placement,
} from '../lib/depth.js';
import {fakeU2netp} from './fakeOnnx.js';
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
    assert(modelPath().startsWith(GLib.get_user_data_dir()) && modelPath().endsWith('/atelier/models/u2netp.onnx'),
        `the model with Atelier's data (${modelPath()})`);
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
    const model = `${dir}/u2netp.onnx`;
    GLib.file_set_contents(model, fakeU2netp());
    const check = runWorker(['--check', '--model', model]);
    assertEqual(check.answer, {ok: true, missing: [], model: 'ok'}, 'the made-up model loads');
    GLib.file_set_contents(`${dir}/broken.onnx`, 'not a model');
    const broken = runWorker(['--check', '--model', `${dir}/broken.onnx`]);
    assert(!broken.answer.ok && broken.answer.model.startsWith('does not load'), 'a broken one is told apart');
    assertEqual(runWorker(['--check', '--model', `${dir}/gone.onnx`]).answer.model, 'missing');

    // A light disc on a dark picture, 1600 × 1000: the disc is the subject.
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
    assert(run.status === 0 && run.answer.ok, `done (${JSON.stringify(run.answer)})`);
    const cutout = GdkPixbuf.Pixbuf.new_from_file(target);
    assertEqual([cutout.get_width(), cutout.get_height()], [800, 500], 'big enough to cover the monitor, zoomed in');
    assertEqual([cutout.get_option('tEXt::atelier-width'), cutout.get_option('tEXt::atelier-height')],
        ['1600', '1000'], 'with the picture\'s own size, to place it as GNOME does');
    const alpha = (x, y) => cutout.get_pixels()[y * cutout.get_rowstride() + x * 4 + 3];
    assert(alpha(400, 250) === 255 && alpha(10, 10) === 0 && alpha(790, 490) === 0,
        `the subject opaque, the rest see-through (${alpha(400, 250)}, ${alpha(10, 10)})`);
    const edge = alpha(300, 250);
    assert(edge > 0 && edge < 255, `soft at the edges (${edge})`);
    assert(Math.abs(run.answer.subject - Math.PI * 100 * 100 / (800 * 500)) < 0.01,
        `it says how much of it is the subject (${run.answer.subject})`);
    assert(!GLib.file_test(`${target}.partial`, GLib.FileTest.EXISTS), 'written whole');

    const failed = runWorker(['--model', model, '--input', `${dir}/gone.jpg`, '--output', `${dir}/x.png`,
        '--width', '80', '--height', '45']);
    assert(failed.status === 4 && !failed.answer.ok && failed.answer.error,
        `a picture that can't be read: it says why (${failed.answer.error})`);
}
