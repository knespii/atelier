import {APCA, FONT_LOOKUP, apcaContrast, apcaY, blend, contrastLc, minimumLc} from '../lib/apca.js';
import {assert, assertEqual} from './util.js';

const near = (a, b, within = 1e-9) => Math.abs(a - b) <= within;

// APCA-W3's own test values (test/index.js of github.com/Myndex/apca-w3,
// calcAPCA(text, background)): text, background, Lc.
const REFERENCE = [
    ['#888888', '#ffffff', 63.056469930209424],
    ['#ffffff', '#888888', -68.54146436644962],
    ['#000000', '#aaaaaa', 58.146262578561334],
    ['#aaaaaa', '#000000', -56.24113336839742],
    ['#112233', '#ddeeff', 91.66830811481631],
    ['#ddeeff', '#112233', -93.06770049484275],
    ['#112233', '#444444', 8.32326136957393],
    ['#444444', '#112233', -7.526878460278154],
];

export function testReferenceValues() {
    for (const [text, background, lc] of REFERENCE) {
        const got = contrastLc(text, background);
        assert(near(got, lc), `${text} on ${background}: Lc ${lc}, got ${got}`);
    }
    // '#0006' on white: black at 0x66 / 255 = 0.4 alpha, laid over it first.
    const translucent = blend('#000000', 0x66 / 255, '#ffffff');
    assertEqual(translucent, '#999999');
    assert(near(contrastLc(translucent, '#ffffff'), 54.62184067441377), 'translucent black on white');
}

export function testPolarity() {
    // Dark on light positive, light on dark negative, and not the same size:
    // APCA scores the two apart.
    const normal = contrastLc('#000000', '#ffffff');
    const reverse = contrastLc('#ffffff', '#000000');
    assert(normal > 105 && normal < 107, `black on white ${normal}`);
    assert(reverse < -107 && reverse > -109, `white on black ${reverse}`);
    assertEqual(contrastLc('#777777', '#777777'), 0, 'the same: none');
    // Too close to count (under the low clip): 0, not a small number.
    assertEqual(contrastLc('#7a7a7a', '#777777'), 0);
    assertEqual(apcaContrast(NaN, 1), 0, 'not a Y: 0');
    assertEqual(apcaContrast(-0.1, 1), 0);
}

export function testScreenLuminance() {
    assertEqual(apcaY('#000000'), 0);
    assert(near(apcaY('#ffffff'), APCA.sRco + APCA.sGco + APCA.sBco), 'white: the coefficients summed');
    // The screen's plain 2.4 exponent, not sRGB's piecewise curve.
    assert(near(apcaY('#808080'), (128 / 255) ** 2.4 * (APCA.sRco + APCA.sGco + APCA.sBco)));
    assertEqual(apcaY([255, 0, 0]), APCA.sRco, 'as an array too');
    // (A picture's whole channel values from a table, the rest worked out: the same.)
    const own = ([r, g, b]) => APCA.sRco * (r / 255) ** 2.4 + APCA.sGco * (g / 255) ** 2.4 + APCA.sBco * (b / 255) ** 2.4;
    for (const rgb of [[1, 2, 3], [200, 100, 50], [127.5, 64, 0.25], [-1, 256, 30]])
        assertEqual(apcaY(rgb), own(rgb), `${rgb}`);
    // Near black, dark text barely stands out: the soft clamp.
    assert(Math.abs(contrastLc('#000000', '#0a0a0a')) < 1, 'black on near-black: nothing');
}

export function testBlend() {
    assertEqual(blend('#ffffff', 0.5, '#000000'), '#808080', 'half white on black: in sRGB, not linear light');
    assertEqual(blend('#ff0000', 1, '#00ff00'), '#ff0000');
    assertEqual(blend('#ff0000', 0, '#00ff00'), '#00ff00');
    assertEqual(blend('#ff0000', 2, '#00ff00'), '#ff0000', 'alpha clamped');
    // Translucent light type on a mid gray stands out less than solid.
    const glass = blend('#ffffff', 0.44, '#777777');
    assert(Math.abs(contrastLc(glass, '#777777')) < Math.abs(contrastLc('#ffffff', '#777777')) / 2, glass);
}

export function testFontLookup() {
    // Read off the table: on its rows, its Lc.
    assertEqual(minimumLc(16, 400), 90);
    assertEqual(minimumLc(24, 400), 60);
    assertEqual(minimumLc(18, 600), 60);
    assertEqual(minimumLc(14, 700), 75);
    assertEqual(minimumLc(96, 700), 25);
    // Between rows, between their Lc: 20 px is a third of the way from 21 px
    // (Lc 55) to 18 px (Lc 60).
    assert(near(minimumLc(20, 600), 55 + 5 / 3), `${minimumLc(20, 600)}`);
    // Between weights, between their needs.
    assert(near(minimumLc(24, 450), (60 + 55) / 2), `${minimumLc(24, 450)}`);
    // Larger than the table: its lowest Lc for text, no less.
    assertEqual(minimumLc(300, 600), 25);
    assertEqual(minimumLc(300, 100), 40, 'hairlines need more, however large');
    // Too small to read at any contrast.
    assertEqual(minimumLc(9, 400), Infinity);
    assertEqual(minimumLc(13, 900), Infinity, 'the heaviest close up when small');
    assertEqual(minimumLc(15, 900), 120);
    assertEqual(minimumLc(0, 400), Infinity);
    // Bigger and heavier needs less: the big clock far less than the date
    // line, the date line less than an 11 pt caption.
    const [digits, line, caption] = [minimumLc(133, 800), minimumLc(20, 600), minimumLc(44 / 3, 600)];
    assert(digits < line && line < caption, `${digits} < ${line} < ${caption}`);
    assert(digits <= 30 && line > 55 && line < 60 && caption > 75 && caption < 90, `${digits} ${line} ${caption}`);
    for (const weight of [100, 300, 500, 700, 900]) {
        let before = Infinity;
        for (let size = 10; size <= 160; size += 2) {
            const need = minimumLc(size, weight);
            assert(need <= before + 1e-9, `${weight}: no more needed at ${size} px than at ${size - 2} px`);
            before = need;
        }
    }
    assertEqual(FONT_LOOKUP.length, 25);
}
