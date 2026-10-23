import {
    CHANGE, FEATURES, FIGURES, FILL, SAMPLE, changeAt, changedFigures, fitSize, fontFile, glassInstance, heavier,
    learn, lineOf, opticalSize, setLine, unlearnt,
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
    const large = glassInstance(inter, style, {size: 'large'});
    assert(large.font !== null, 'Inter read');
    assertEqual(large.variations, 'wght=600,opsz=32', 'Inter at its display size: the axis\' largest');
    assertEqual(large.scaleX, 0.9, 'no width axis: drawn 90 % as wide');
    const square = glassInstance(inter, style, {size: 'square'});
    assertEqual(square.key, large.key, 'Inter: one instance for every size');
    assert(square.font === large.font, 'the same kept font');

    const flex = typefaceFor('flex');
    const flexStyle = styleFor(flex, 'glass');
    const flexLarge = glassInstance(flex, flexStyle, {size: 'large'});
    assertEqual(flexLarge.variations, `wght=600,wdth=90,opsz=${opticalSize('large')}`,
        'Roboto Flex: its width axis, its optical size the large clock\'s');
    assertEqual(flexLarge.scaleX, 1, 'as wide as the axis makes it');
    const flexSquare = glassInstance(flex, flexStyle, {size: 'square'});
    assert(flexSquare.key !== flexLarge.key && flexSquare.variations.endsWith(`opsz=${opticalSize('square')}`),
        `a small clock at a smaller optical size (${flexSquare.variations})`);
    const graded = glassInstance(flex, flexStyle, {size: 'large', plan: {boldness: 0.5, weight: 700}});
    assert(graded.variations.includes('GRAD=75') && graded.weight === 600 && graded.key !== flexLarge.key,
        `a plan grades it (${graded.variations})`);
    assertEqual(graded.font.shape(SAMPLE, FEATURES).advance, flexLarge.font.shape(SAMPLE, FEATURES).advance,
        'graded, the line as wide');

    const shell = typefaceFor('default');
    const none = glassInstance(shell, styleFor(shell, 'glass'), {shellFamily: 'No Such Family'});
    assert(none.font === null && none.file === null && none.variations === 'wght=600' && none.key.startsWith('pango:'),
        `no file: no font, the weight for Pango (${none.variations})`);
    const cantarell = systemFontFile('Cantarell');
    if (cantarell) {
        const own = glassInstance(shell, styleFor(shell, 'glass'), {shellFamily: 'Cantarell'});
        assert(own.file === cantarell && own.variations.startsWith('wght=600'), `the shell's own font's file (${own.variations})`);
    }
    // (A family of a file per weight: a plan's heavier weight, its heavier file.)
    const rounded = typefaceFor('rounded');
    if (systemFontFile('Quicksand', 500) !== systemFontFile('Quicksand', 700)) {
        const roundedStyle = {weight: 500, width: 100};
        const plain = glassInstance(rounded, roundedStyle);
        const bolder = glassInstance(rounded, roundedStyle, {plan: {boldness: 1, weight: 700}});
        assert(plain.file.endsWith('Quicksand-Medium.ttf') && bolder.file.endsWith('Quicksand-Bold.ttf'),
            `Quicksand heavier: its bold file (${plain.file} → ${bolder.file})`);
    }
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
        const lineAt = s => setLine(font, SAMPLE).advance * s / font.upem * 0.9;
        assert(lineAt(size) <= width * FILL && lineAt(size + 1) > width * FILL,
            `${width} px: as large as fits (${size} px, ${lineAt(size).toFixed(1)} px wide)`);
    }
    assertEqual(fitSize(font, 1), 8, 'never smaller than 8 px');
}

export function testTabularWithout() {
    // Quicksand has no tabular figures: each of its own in a cell as wide
    // as its widest, the time doesn't wobble all the same.
    const path = systemFontFile('Quicksand', 700);
    if (!path)
        return;
    const font = fontAt(path, '');
    const own = font.shape('0123456789', FEATURES).glyphs.map(g => g.advance);
    assert(new Set(own).size > 1, `its figures are as wide as each is (${own})`);
    const a = setLine(font, '10:52');
    const b = setLine(font, '11:11');
    assertEqual(a.advance, b.advance, 'the line as long');
    assertEqual([a.glyphs[2].x, a.glyphs[3].x - a.glyphs[2].x > 0], [b.glyphs[2].x, true], 'the colon where it was');
    const one = font.outline(font.glyphOf('1')).advance;
    const widest = Math.max(...own);
    assertEqual(b.glyphs[0].x, (widest - one) / 2, 'a "1" in the middle of its cell');
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
