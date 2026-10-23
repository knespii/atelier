import {
    CHANGE, FEATURES, FIGURES, FILL, SAMPLE, changeAt, changedFigures, fitSize, fontFile, glassInstance, heavier,
    learn, lineOf, opticalSize, unlearnt,
} from '../lib/glassClock.js';
import {bundledFile, fontAt, systemFontFile} from '../lib/glyphOutlines.js';
import {styleFor, typefaceFor} from '../lib/lockType.js';
import {assert, assertEqual} from './util.js';

const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

export function testFontFiles() {
    const inter = typefaceFor('inter');
    assertEqual(fontFile(inter, 600), bundledFile('Inter.ttf'), 'Inter comes with Atelier');
    assertEqual(fontFile(typefaceFor('flex'), 600, 'Cantarell'), bundledFile('RobotoFlex.ttf'));
    const cantarell = systemFontFile('Cantarell');
    assertEqual(fontFile(typefaceFor('default'), 600, 'Cantarell'), cantarell, 'the shell\'s own: its family\'s file');
    assertEqual(fontFile(typefaceFor('default'), 600, 'Cantarell, sans-serif'), cantarell, 'the first of a list');
    assertEqual(fontFile(typefaceFor('default'), 600, null), null, 'no family known: no file (Pango draws them)');
    assertEqual(fontFile(typefaceFor('default'), 600, 'No Such Family'), null);
}

export function testHeavier() {
    const {axes: interAxes} = typefaceFor('inter');
    const {axes: flexAxes} = typefaceFor('flex');
    assertEqual(heavier(interAxes, 600, null), {weight: 600, extra: {}}, 'no plan: as it is');
    assertEqual(heavier(interAxes, 600, {boldness: 0, weight: 600}), {weight: 600, extra: {}});
    assertEqual(heavier(interAxes, 600, {boldness: 0.5, weight: 700}), {weight: 700, extra: {}},
        'Inter: heavier on its weight');
    assertEqual(heavier(flexAxes, 600, {boldness: 0.5, weight: 700}), {weight: 600, extra: {GRAD: 75}},
        'Roboto Flex: on its grade, the weight (and the advances) as they are');
    assertEqual(heavier(flexAxes, 600, {boldness: 3, weight: 1200}).extra.GRAD, 150, 'at most its whole grade');
    assertEqual(heavier(null, 600, {boldness: 0.2, weight: 640}).weight, 640, 'axes not known: the weight');
}

export function testInstances() {
    const inter = typefaceFor('inter');
    const style = styleFor(inter, 'glass');
    const large = glassInstance(fontFile(inter, style.weight), inter, style, {size: 'large'});
    assert(large.font !== null, 'Inter read');
    assertEqual(large.variations, 'wght=600,opsz=32', 'Inter at its display size: the axis\' largest');
    assertEqual(large.scaleX, 0.9, 'no width axis: drawn 90 % as wide');
    const square = glassInstance(fontFile(inter, style.weight), inter, style, {size: 'square'});
    assertEqual(square.key, large.key, 'Inter: one instance for every size');
    assert(square.font === large.font, 'the same kept font');

    const flex = typefaceFor('flex');
    const flexStyle = styleFor(flex, 'glass');
    const flexLarge = glassInstance(fontFile(flex, 600), flex, flexStyle, {size: 'large'});
    assertEqual(flexLarge.variations, `wght=600,wdth=90,opsz=${opticalSize('large')}`,
        'Roboto Flex: its width axis, its optical size the large clock\'s');
    assertEqual(flexLarge.scaleX, 1, 'as wide as the axis makes it');
    const flexSquare = glassInstance(fontFile(flex, 600), flex, flexStyle, {size: 'square'});
    assert(flexSquare.key !== flexLarge.key && flexSquare.variations.endsWith(`opsz=${opticalSize('square')}`),
        `a small clock at a smaller optical size (${flexSquare.variations})`);
    const graded = glassInstance(fontFile(flex, 600), flex, flexStyle, {size: 'large', plan: {boldness: 0.5, weight: 700}});
    assert(graded.variations.includes('GRAD=75') && graded.weight === 600 && graded.key !== flexLarge.key,
        `a plan grades it (${graded.variations})`);
    assertEqual(graded.font.shape(SAMPLE, FEATURES).advance, flexLarge.font.shape(SAMPLE, FEATURES).advance,
        'graded, the line as wide');

    const shell = typefaceFor('default');
    const none = glassInstance(null, shell, styleFor(shell, 'glass'));
    assert(none.font === null && none.file === null && none.variations === 'wght=600',
        `no file: no font, the weight for Pango (${none.variations})`);
    const unreadable = glassInstance('/nonexistent/font.ttf', shell, styleFor(shell, 'glass'));
    assert(unreadable.font === null, 'a file that can\'t be read: none either');
}

export function testOpticalSize() {
    assert(opticalSize('large') > 120 && opticalSize('large') < 160, `a large clock's (${opticalSize('large')})`);
    assertEqual(opticalSize('tall'), opticalSize('large'), 'as wide as a large one');
    assert(near(opticalSize('square') / opticalSize('large'), 180 / 372, 0.01), 'a square one: in proportion');
    assert(opticalSize('large', 0.9) > opticalSize('large'), 'drawn narrower, larger');
}

export function testFitSize() {
    const font = fontAt(bundledFile('Inter.ttf'), 'wght=600,opsz=32');
    for (const width of [180, 336, 500]) {
        const size = fitSize(font, width, 0.9);
        const lineAt = s => font.shape(SAMPLE, FEATURES).advance * s / font.upem * 0.9;
        assert(lineAt(size) <= width * FILL && lineAt(size + 1) > width * FILL,
            `${width} px: as large as fits (${size} px, ${lineAt(size).toFixed(1)} px wide)`);
    }
    assertEqual(fitSize(font, 1), 8, 'never smaller than 8 px');
}

export function testLines() {
    const font = fontAt(bundledFile('Inter.ttf'), 'wght=600,opsz=32');
    const place = {size: 150, scaleX: 0.9, width: 340};
    const a = lineOf(font, '10:52', place);
    const b = lineOf(font, '11:11', place);
    assertEqual(a.glyphs.map(g => g.char).join(''), '10:52');
    assertEqual(a.glyphs.map(g => g.index), [0, 1, 2, 3, 4]);
    assert(near(a.x, (340 - a.width) / 2, 1e-6), 'centred by its advance');
    assertEqual(a.glyphs.map(g => g.x), b.glyphs.map(g => g.x), 'another time: every figure where it was');
    const short = lineOf(font, '9:41', place);
    assert(short.width < a.width && near(short.x, (340 - short.width) / 2, 1e-6), 'one figure less: centred anew');
    assert(a.glyphs.every(g => g.dy === 0), 'on the baseline');
}

export function testChangedFigures() {
    assertEqual(changedFigures('', '10:52'), {leaving: [], coming: []}, 'the first time: nothing moves');
    assertEqual(changedFigures('10:52', '10:53'), {leaving: [4], coming: [4]}, 'a minute: its figure');
    assertEqual(changedFigures('10:59', '11:00'), {leaving: [1, 3, 4], coming: [1, 3, 4]}, 'the hour too');
    assertEqual(changedFigures('10:52', '10:52'), {leaving: [], coming: []}, 'the same: nothing');
    assertEqual(changedFigures('9:59', '10:00'), {leaving: [0, 1, 2, 3], coming: [0, 1, 2, 3, 4]},
        'a figure more: all of them, centred anew');
}

export function testChangeAt() {
    const start = changeAt(0);
    const end = changeAt(1);
    assertEqual(start, {leaving: {dy: -0, alpha: 1}, coming: {dy: 1, alpha: 0}}, 'at first: the old one, the new one under it, unseen');
    assertEqual(end, {leaving: {dy: -1, alpha: 0}, coming: {dy: 0, alpha: 1}}, 'at last: the old one gone, the new one in place');
    assertEqual(changeAt(-1), start, 'kept to 0 … 1');
    assertEqual(changeAt(2), end);
    let before = start;
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
        const now = changeAt(t);
        assert(now.leaving.dy <= before.leaving.dy && now.coming.dy <= before.coming.dy, `both rise (${t})`);
        assert(now.leaving.alpha <= before.leaving.alpha && now.coming.alpha >= before.coming.alpha, `one fades as the other comes (${t})`);
        before = now;
    }
    const half = changeAt(0.5);
    assert(half.coming.dy < 0.2 && half.coming.alpha > 0.5 && half.leaving.alpha < 0.2,
        `fast at first: half way through, mostly there (${JSON.stringify(half)})`);
    assert(CHANGE.time >= 400 && CHANGE.time <= 500 && CHANGE.travel > 0 && CHANGE.travel < 0.5);
}

export function testLearning() {
    // (An instance of its own: no other test has worked it out.)
    const font = fontAt(bundledFile('RobotoFlex.ttf'), 'wght=432,wdth=90,opsz=100');
    const glyphs = unlearnt(font);
    assertEqual(glyphs.length, FIGURES.length, 'every figure to work out at first');
    learn(font, glyphs[0]);
    assertEqual(unlearnt(font), glyphs.slice(1), 'one less');
    glyphs.slice(1).forEach(glyph => learn(font, glyph));
    assertEqual(unlearnt(font), [], 'all of them known');
    assertEqual(unlearnt(font, '٠١'), [], 'figures the font hasn\'t: nothing to work out');
}
