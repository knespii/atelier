import {
    FONTS, LEGIBLE, batteryState, chosenTone, fontFor, isColor, partStyle, pickTone, regionIn, regionStats,
    shortTemperature, widgetStyle,
} from '../lib/lockLook.js';
import {contrastRatio, hexToOklch, hexToRgb, luminance} from '../lib/palette.js';
import {assert, assertEqual} from './util.js';

// A sample as sampleWallpaper() has it: width × height pixels, the left
// half one colour and the right half another.
function sample(left, right = left, width = 16, height = 10) {
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++)
            pixels.set(hexToRgb(x < width / 2 ? left : right), (y * width + x) * 3);
    }
    return {pixels, channels: 3, rowstride: width * 3, width, height};
}

const statsOf = hex => regionStats(sample(hex), [0, 0, 1, 1]);
const hueDistance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

export function testRegion() {
    // A 16:10 sample on a 16:9 screen: a little of its top and bottom is cut.
    const [x, y, w, h] = regionIn([0, 0, 1, 1], 16 / 9, 1.6);
    assertEqual([x, w], [0, 1]);
    assert(Math.abs(h - 0.9) < 1e-9 && Math.abs(y - 0.05) < 1e-9, `${y} ${h}`);
    // On a 4:3 one, a little of its sides.
    const [x2, , w2] = regionIn([0.5, 0, 0.5, 1], 4 / 3, 1.6);
    assert(Math.abs(x2 + w2 - (1 - (1 - 4 / 3 / 1.6) / 2)) < 1e-9, 'the right half, inside the cut');

    const two = sample('#000000', '#ffffff');
    assertEqual(regionStats(two, [0, 0, 0.5, 1]).mean, '#000000', 'the left half is black');
    assertEqual(regionStats(two, [0.5, 0, 0.5, 1]).mean, '#ffffff', 'the right half white');
    const both = regionStats(two, [0, 0, 1, 1]);
    assert(both.low === 0 && both.high === 1, 'its darker tenth black, its lighter one white');
    assert(regionStats(two, [0.99, 0.99, 0.001, 0.001]) !== null, 'even a tiny part has a pixel');
}

export function testToneOnLightAndDark() {
    for (const [wallpaper, dark] of [['#f4efe4', true], ['#fbfbfb', true], ['#16202c', false], ['#000000', false],
        ['#3a6ea5', false], ['#e9b949', true]]) {
        const tone = pickTone(statsOf(wallpaper), {tint: '#2f8fb0'});
        assertEqual(tone.dark, dark, `${wallpaper}: ${dark ? 'dark' : 'light'} type`);
        assert(contrastRatio(tone.color, wallpaper) >= LEGIBLE,
            `${wallpaper}: legible (${contrastRatio(tone.color, wallpaper).toFixed(2)})`);
    }
}

export function testToneIsTinted() {
    const tint = '#c75b7a';
    const [, chroma, hue] = hexToOklch(pickTone(statsOf('#20242a'), {tint}).color);
    assert(chroma > 0.01 && hueDistance(hue, hexToOklch(tint)[2]) < 12, `a tint of the palette's hue (${chroma}, ${hue})`);
    const [, plain] = hexToOklch(pickTone(statsOf('#20242a')).color);
    assert(plain < 0.005, 'no tint without a palette');
    const [, gray] = hexToOklch(pickTone(statsOf('#20242a'), {tint: '#777777'}).color);
    assert(gray < 0.005, 'nor with a gray one');
}

export function testToneOnMiddleGray() {
    // Neither light nor dark type stands out much: it goes as far as it takes.
    for (const wallpaper of ['#777777', '#8a8a8a', '#6f7f8f']) {
        const tone = pickTone(statsOf(wallpaper), {tint: '#2f8fb0'});
        assert(tone.contrast >= 3.5, `${wallpaper}: as legible as it gets (${tone.contrast.toFixed(2)})`);
    }
    // Dimmed by the glass, dark type on a light part must be legible still.
    const dimmed = pickTone(statsOf('#d8d8d8'), {dim: 0.85});
    assert(!dimmed.dark || contrastRatio(dimmed.color, '#b8b8b8') >= LEGIBLE, 'legible dimmed too');
    // A busy part (half black, half white): light type, for its darker half.
    assert(pickTone(regionStats(sample('#000000', '#ffffff'), [0, 0, 1, 1])) !== null);
    assertEqual(pickTone(null).dark, false, 'nothing known: light, as GNOME\'s');
}

export function testChosenTone() {
    assertEqual(chosenTone('#FFCC00'), {color: '#ffcc00', dark: false, contrast: null});
    assertEqual(chosenTone('#202020').dark, true);
    assert(isColor('#a1b2c3') && !isColor('auto') && !isColor('#abc') && !isColor(null));
}

export function testFonts() {
    assertEqual(FONTS.map(f => f.id), ['default', 'rounded', 'serif', 'thin', 'heavy']);
    assertEqual(fontFor('default', ['Cantarell']), {id: 'default', family: null, display: null, text: null, missing: false});
    assertEqual(fontFor('serif', ['Cantarell', 'DejaVu Serif', 'Noto Serif']).family, 'Noto Serif',
        'the first of its families installed');
    assertEqual(fontFor('rounded', ['quicksand']).family, 'Quicksand', 'whatever the case');
    const none = fontFor('rounded', ['Cantarell', 'DejaVu Sans']);
    assert(none.family === null && none.missing && none.display === 700, 'none installed: the shell\'s font, in its weights');
    assertEqual(fontFor('thin', []).display, 200, 'thin: the shell\'s own font, thin');
    assertEqual(fontFor('heavy').display, 900);
    assertEqual(fontFor('nonsense').id, 'default');
    assertEqual(fontFor('serif').family, 'Noto Serif Display', 'not knowing what is there: the first');
}

export function testStyles() {
    const light = {color: '#f4f6f8', dark: false};
    const font = fontFor('serif', ['DejaVu Serif']);
    const widget = widgetStyle(light, font);
    assert(widget.includes('color: #f4f6f8') && widget.includes('rgba(0, 0, 0,') &&
        widget.includes('font-family: "DejaVu Serif"'), widget);
    assert(widgetStyle({color: '#202428', dark: true}, fontFor('default')).includes('rgba(255, 255, 255,'),
        'dark type: a light halo');
    assertEqual(widgetStyle(null, fontFor('default')), '', 'on a card, as it is');
    assertEqual(partStyle(['atelier-widget-caption'], light, fontFor('default')), 'color: rgba(244, 246, 248, 0.72);');
    assertEqual(partStyle(['atelier-widget-stacked-hours'], light, fontFor('thin')), 'font-weight: 200;');
    assertEqual(partStyle(['atelier-widget-stacked-date'], light, fontFor('thin')), 'font-weight: 400;');
    assertEqual(partStyle(['atelier-widget-face'], light, fontFor('default')), 'color: #f4f6f8;');
    assertEqual(partStyle(['atelier-widget-caption'], null, fontFor('default')), '');
}

export function testBattery() {
    assertEqual(batteryState(null).shown, false);
    assertEqual(batteryState({present: false, percentage: 50}).shown, false, 'no battery: nothing');
    const charging = batteryState({present: true, percentage: 64, state: 1, title: '64 %'});
    assertEqual(charging, {shown: true, fraction: 0.64, text: '64 %', caption: 'Charging', charging: true});
    const fromTitle = batteryState({present: true, title: '82%', state: 2});
    assert(fromTitle.fraction === 0.82 && fromTitle.caption === 'On battery' && !fromTitle.charging);
    assertEqual(batteryState({present: true, percentage: 140, state: 4}).fraction, 1);
    assertEqual(batteryState({present: true, percentage: 100, state: 4}).text, '100 %');
}

export function testTemperature() {
    assertEqual(shortTemperature('14 °C'), '14°');
    assertEqual(shortTemperature('-3 °F'), '-3°');
    assertEqual(shortTemperature(undefined), '');
}

// (luminance is the palette's, exported for this.)
export function testLuminance() {
    assert(luminance('#000000') === 0 && luminance('#ffffff') === 1);
}
