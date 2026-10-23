import {blend, contrastLc, minimumLc} from '../lib/apca.js';
import {
    FONTS, REACH, STRETCH, TYPE, batteryState, chosenTone, fontFor, glassDigits, isColor, legibilityPlan, lockTone,
    mergeStats, partStyle, pickTone, regionIn, regionStats, shortTemperature, widgetStyle,
} from '../lib/lockLook.js';
import {hexToOklch, hexToRgb, luminance} from '../lib/palette.js';
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
// What the date line needs: Lc 57 (15 pt, 600, read off APCA's font lookup).
const LINE = minimumLc(TYPE.line.size, TYPE.line.weight);
// Type's |Lc| on a flat wallpaper, in its own polarity (dark type on it
// dimmed as much as asked).
const lcOn = (tone, wallpaper, dim = 1) =>
    (tone.dark ? 1 : -1) * contrastLc(tone.color, tone.dark ? blend('#000000', 1 - dim, wallpaper) : wallpaper);

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
    assertEqual(both.tenths, {dark: '#000000', middle: '#ffffff', light: '#ffffff'}, 'and their colours');
    assert(regionStats(two, [0.99, 0.99, 0.001, 0.001]) !== null, 'even a tiny part has a pixel');
}

export function testToneOnLightAndDark() {
    for (const [wallpaper, dark] of [['#f4efe4', true], ['#fbfbfb', true], ['#16202c', false], ['#000000', false],
        ['#3a6ea5', false], ['#e9b949', true]]) {
        const tone = pickTone(statsOf(wallpaper), {tint: '#2f8fb0'});
        assertEqual(tone.dark, dark, `${wallpaper}: ${dark ? 'dark' : 'light'} type`);
        assert(lcOn(tone, wallpaper) >= LINE && Math.abs(tone.contrast - lcOn(tone, wallpaper)) < 1e-9,
            `${wallpaper}: it reads (Lc ${lcOn(tone, wallpaper).toFixed(1)})`);
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
    // Light type stands out more on a middle gray than dark type, as APCA
    // sees it (WCAG had the two even): light, and it reads.
    for (const wallpaper of ['#777777', '#8a8a8a', '#6f7f8f']) {
        const tone = pickTone(statsOf(wallpaper), {tint: '#2f8fb0'});
        assert(!tone.dark && tone.contrast >= LINE, `${wallpaper}: light, it reads (Lc ${tone.contrast.toFixed(1)})`);
    }
    // Dimmed by the glass, dark type on a light part must read still.
    const dimmed = pickTone(statsOf('#d8d8d8'), {dim: 0.85});
    assert(dimmed.dark && lcOn(dimmed, '#d8d8d8', 0.85) >= LINE, `it reads dimmed too (${dimmed.color})`);
    // Small type needs more: darker for the battery's caption than for the
    // date line (as dark as it goes, here).
    const [line, caption] = [TYPE.line, TYPE.caption].map(text => pickTone(statsOf('#c4c4c4'), {text}));
    assert(line.dark && caption.dark && line.contrast >= LINE && caption.contrast > line.contrast &&
        luminance(caption.color) < luminance(line.color), `${line.color}, ${caption.color}`);
    // A busy part (half black, half white): a tone still.
    assert(pickTone(regionStats(sample('#000000', '#ffffff'), [0, 0, 1, 1])) !== null);
    assertEqual(pickTone(null).dark, false, 'nothing known: light, as GNOME\'s');
}

export function testOneToneForAll() {
    // The clock over a blue sky (with a few clouds), the battery over the
    // grass: one light tone for both, as an iPhone has it.
    const sky = regionStats(sample('#3b6fd8', '#8fb3ee'), [0, 0, 1, 1]);
    const grass = statsOf('#3f8a2a');
    const tone = lockTone(mergeStats([{stats: sky, weight: 3}, {stats: grass, weight: 1}]), {tint: '#2f8fb0'});
    assert(!tone.dark && luminance(tone.color) > 0.8, `light over the sky and the grass (${tone.color})`);
    // On the sky's lighter half it falls short of what the date line needs,
    // but less than dark type would: light, with a shadow round it.
    assert(tone.contrast < LINE && tone.plan.shadow?.color === '#000000' && tone.plan.short === 0,
        `it reads there with a shadow (Lc ${tone.contrast.toFixed(1)}, ${JSON.stringify(tone.plan.shadow)})`);
    // Over a dark one: light, and nothing more – no shadow at all.
    const night = lockTone(mergeStats([{stats: statsOf('#16202c'), weight: 3}, {stats: statsOf('#202830'), weight: 1}]));
    assert(!night.dark && night.contrast >= LINE && night.plan.shadow === null && night.plan.boldness === 0,
        `no shadow where it reads (${JSON.stringify(night.plan)})`);
    // Where light would not read (a pale wallpaper): dark, for all of them.
    const pale = lockTone(mergeStats([{stats: statsOf('#efe6d2'), weight: 3}, {stats: statsOf('#e9e2d0'), weight: 1}]));
    assert(pale.dark && lcOn(pale, '#efe6d2') >= LINE, `dark on a pale one (${pale.color})`);
    // Each part with its type: the battery's caption needs more than the
    // clock's date line, on the same part of the wallpaper.
    const gray = statsOf('#a2a2a2');
    const parts = [{stats: gray, weight: 3}, {stats: gray, weight: 1, text: TYPE.caption}];
    const merged = mergeStats(parts);
    assertEqual(merged.parts.map(part => part.text), [TYPE.line, TYPE.caption], 'the date line unless said');
    const [plain, withCaption] = [lockTone(mergeStats([parts[0]])), lockTone(merged)];
    assert(withCaption.plan.shadow && (plain.plan.shadow?.alpha ?? 0) < withCaption.plan.shadow.alpha,
        `the caption takes more (${JSON.stringify(plain.plan)}, ${JSON.stringify(withCaption.plan)})`);
    // Weighed: the clock counts more than a small widget.
    const weighed = mergeStats([{stats: statsOf('#000000'), weight: 3}, {stats: statsOf('#ffffff'), weight: 1}]);
    assert(Math.abs(weighed.middle - 0.25) < 1e-9 && weighed.mean === '#404040' && weighed.tenths.light === '#404040',
        `weighed (${weighed.middle}, ${weighed.mean})`);
    assertEqual(mergeStats([{stats: null, weight: 1}]), null, 'nothing known: nothing merged');
    const blind = lockTone(null);
    assert(!blind.dark && blind.contrast === null, 'and the type light');
    assertEqual(blind.plan.shadow, {color: '#000000', alpha: 0.32, blur: 6, y: 1}, 'with the soft shadow it always had');
}

export function testLegibilityPlan() {
    const white = {color: '#ffffff', dark: false};
    const plan = (wallpaper, options = {}) => legibilityPlan({...TYPE.line, tone: white, stats: statsOf(wallpaper), ...options});
    // It reads as it is: nothing.
    const night = plan('#16202c');
    assertEqual([night.boldness, night.weight, night.shadow, night.short], [0, 600, null, 0]);
    assert(night.lc >= night.need && night.need === LINE && night.reaches === night.lc, JSON.stringify(night));
    // A little short: a heavier weight is enough (700 needs less at 20 px).
    const heavy = minimumLc(TYPE.line.size, 700);
    const gray = Array.from({length: 48}, (_, i) => `#${(0x90 + i).toString(16).repeat(3)}`).find(hex => {
        const lc = -contrastLc('#ffffff', hex);
        return lc >= heavy && lc < LINE;
    });
    const bolder = plan(gray);
    assert(bolder.boldness > 0 && bolder.boldness <= 0.5 && bolder.weight > 600 && bolder.shadow === null && bolder.short === 0,
        `${gray}: heavier, no shadow (${JSON.stringify(bolder)})`);
    assertEqual(bolder.boldness, (bolder.weight - 600) / REACH.full.bolder);
    // Shorter: a shadow of the other polarity too, the more the shorter.
    const [sky, cloud] = [plan('#a8b8d0'), plan('#c8d2e0')];
    assert(sky.shadow && cloud.shadow && sky.shadow.color === '#000000', JSON.stringify([sky, cloud]));
    assert(cloud.shadow.alpha > sky.shadow.alpha && cloud.shadow.blur >= sky.shadow.blur, 'more, and wider');
    assert(sky.short === 0 && sky.reaches >= minimumLc(TYPE.line.size, sky.weight), 'and then it reads');
    assert(cloud.shadow.alpha <= REACH.full.shadow, 'never more than the most');
    // Shortest (white type on white): as far as it goes – as heavy as needs
    // least (800 needs no less than 700 at 20 px), the most shadow – and
    // what it still lacks.
    const snow = plan('#ffffff');
    assert(snow.lc === 0 && snow.shadow.alpha === REACH.full.shadow && snow.weight === 700 && snow.short > 0,
        JSON.stringify(snow));
    // Less help allowed, less given.
    const soft = plan('#c8d2e0', {reach: REACH.soft});
    assert(soft.shadow.alpha <= REACH.soft.shadow && soft.weight <= 700, JSON.stringify(soft));
    // Dark type: a light halo, and on the darker tenth of what is behind it, dimmed.
    const ink = {color: '#1c1e22', dark: true};
    const halo = legibilityPlan({...TYPE.line, tone: ink, stats: statsOf('#9a9a9a'), dim: 0.86});
    assert(halo.shadow?.color === '#ffffff' && Math.abs(halo.lc - lcOn(ink, '#9a9a9a', 0.86)) < 1e-9, JSON.stringify(halo));
    // Type in the wrong polarity there (light type on lighter): none of it counts.
    assertEqual(legibilityPlan({...TYPE.line, tone: {color: '#e0e0e0', dark: false}, stats: statsOf('#ffffff')}).lc, 0);
    // The big digits need far less than the date line, on the same sky.
    const digits = legibilityPlan({...TYPE.digits, tone: white, stats: statsOf('#a8b8d0')});
    assert(digits.need < 30 && digits.shadow === null && digits.short === 0, JSON.stringify(digits));
    // Nothing known: the soft shadow solid type always had; type too small to read: all there is.
    assertEqual(plan('#000000', {stats: null}).shadow, {color: '#000000', alpha: 0.32, blur: 6, y: 1});
    const tiny = legibilityPlan({size: 9, weight: 400, tone: white, stats: statsOf('#000000')});
    assert(tiny.need === Infinity && tiny.short === Infinity && tiny.shadow.alpha === REACH.full.shadow, JSON.stringify(tiny));
    assertEqual(legibilityPlan({...TYPE.line, tone: null, stats: statsOf('#000000')}).shadow, null, 'no tone: nothing');
}

export function testLegibilityPlanForGlass() {
    // Glass digits: their tint shows 0.44 over a middle gray – lighter than
    // it, not much.
    const tone = {color: '#f4f6f8', dark: false};
    const glassy = {size: 140, weight: 600, tone, stats: statsOf('#8c8c8c'), glass: 0.44};
    const ink = blend(tone.color, 0.44, '#8c8c8c');
    const plan = legibilityPlan(glassy);
    assert(Math.abs(plan.lc + contrastLc(ink, '#8c8c8c')) < 1e-9 && plan.lc < plan.need, `as the glass shows (${plan.lc})`);
    assert(plan.shadow && plan.short === 0 && plan.glass === 0.44, `a shadow first (${JSON.stringify(plan)})`);
    // Without a shadow to give: more opaque glass, as much as it takes.
    const opaque = legibilityPlan({...glassy, reach: {bolder: 0, shadow: 0, glass: 0.92}});
    assert(opaque.shadow === null && opaque.glass > 0.44 && opaque.glass <= 0.92 && opaque.short === 0,
        JSON.stringify(opaque));
    const solid = blend(tone.color, opaque.glass, '#8c8c8c');
    assert(-contrastLc(solid, '#8c8c8c') >= opaque.need, `it reads then (${solid})`);
    // Reading as it is: the glass as it is.
    assertEqual(legibilityPlan({...glassy, stats: statsOf('#202428')}).glass, 0.44);
    // Nothing known: glass draws its own shadow; nothing planned.
    assertEqual(legibilityPlan({...glassy, stats: null}).shadow, null);
}

export function testGlassDigits() {
    const ink = 100;
    // No subject: as tall as the box lets them, up to the most.
    assertEqual(glassDigits(ink, 40, 200, null), {stretch: 1.6, y: 40});
    assertEqual(glassDigits(ink, 40, 600, null).stretch, STRETCH.max, 'never taller than the most');
    assertEqual(glassDigits(ink, 40, 100, null).stretch, STRETCH.min, 'never squashed');
    // A subject under them: down into it, its top a little above their feet.
    const subject = 40 + 2 * ink * (1 - STRETCH.overlap);
    const {stretch, y} = glassDigits(ink, 40, 400, subject);
    const feet = y + stretch * ink;
    assert(y === 40 && Math.abs(stretch - 2) < 1e-9, `from under the date (${y}, ${stretch})`);
    assert(Math.abs((feet - subject) / (stretch * ink) - STRETCH.overlap) < 1e-9, `their feet in it (${feet})`);
    // Far below: as tall as they get, moved down to meet it.
    const low = glassDigits(ink, 40, 500, 350);
    assert(low.stretch === STRETCH.max && low.y > 40 &&
        Math.abs(350 - low.y - (1 - STRETCH.overlap) * low.stretch * ink) < 1e-9, `moved down to it (${low.y})`);
    // Right under the date: as short as they go, from under it.
    assertEqual(glassDigits(ink, 40, 400, 60), {stretch: STRETCH.min, y: 40});
    // Under the box or over the top: as without one.
    assertEqual(glassDigits(ink, 40, 200, 500), glassDigits(ink, 40, 200, null));
    assertEqual(glassDigits(ink, 40, 200, 10), glassDigits(ink, 40, 200, null));
}

export function testChosenTone() {
    const yellow = chosenTone('#FFCC00');
    assert(yellow.color === '#ffcc00' && !yellow.dark && yellow.contrast === null, JSON.stringify(yellow));
    assertEqual(yellow.plan.shadow?.alpha, 0.32, 'nothing known: the soft shadow');
    assertEqual(chosenTone('#202020').dark, true);
    // Known where it is: what it takes there – nothing on a dark wallpaper,
    // a shadow on a light one.
    const onDark = chosenTone('#ffcc00', statsOf('#141a24'));
    assert(onDark.contrast >= LINE && onDark.plan.shadow === null, JSON.stringify(onDark));
    const onLight = chosenTone('#ffcc00', statsOf('#f4efe4'));
    assert(onLight.contrast < LINE && onLight.plan.shadow?.color === '#000000', JSON.stringify(onLight.plan));
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
    // A shadow only where one is planned: none at all where the type reads
    // (not the stylesheet's either).
    assertEqual(widgetStyle(light, font), 'color: #f4f6f8; text-shadow: none; font-family: "DejaVu Serif";');
    const shadowed = legibilityPlan({...TYPE.line, tone: light, stats: statsOf('#a8b8d0')});
    const {alpha, blur, y} = shadowed.shadow;
    const shadow = `text-shadow: 0 ${y}px ${blur}px rgba(0, 0, 0, ${alpha});`;
    assertEqual(widgetStyle(light, font, shadowed), `color: #f4f6f8; ${shadow} font-family: "DejaVu Serif";`,
        'as St takes it: x y blur colour');
    const dark = {color: '#202428', dark: true};
    const halo = legibilityPlan({...TYPE.line, tone: dark, stats: statsOf('#9a9a9a')});
    assert(widgetStyle(dark, fontFor('default'), halo).includes('rgba(255, 255, 255,'), 'dark type: a light halo');
    assertEqual(widgetStyle(dark, fontFor('default'), legibilityPlan({...TYPE.line, tone: dark, stats: statsOf('#ffffff')})),
        'color: #202428; text-shadow: none;', 'none where it reads');
    assertEqual(widgetStyle(null, fontFor('default')), '', 'on a card, as it is');
    // A part with a plan of its own: its shadow, and heavier where it is to be.
    assertEqual(partStyle(['atelier-lock-value'], light, fontFor('default'), {...shadowed, boldness: 0.5, weight: 700}),
        `font-weight: 700; ${shadow}`);
    assertEqual(partStyle(['atelier-lock-value'], light, fontFor('heavy'), {...shadowed, boldness: 0, shadow: null}),
        'font-weight: 800;', 'nothing planned: as the font has it');
    assertEqual(partStyle(['atelier-widget-caption'], light, fontFor('default')), 'color: #f4f6f8;',
        'the quieter parts in the one tone too, solid');
    assertEqual(partStyle(['atelier-widget-time-suffix'], light, fontFor('default')), 'color: #f4f6f8;');
    assertEqual(partStyle(['atelier-lock-value'], light, fontFor('heavy')), 'font-weight: 800;',
        'the battery\'s and the weather\'s values in the weight of the date line');
    assertEqual(partStyle(['atelier-widget-glass-digits'], light, fontFor('thin')), 'font-weight: 200;',
        'the glass clock\'s digits in the display one');
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
