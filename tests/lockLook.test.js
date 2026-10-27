import {blend, contrastLc, minimumLc} from '../lib/apca.js';
import {GLASS, frost, glassColor, glassFor, tintShown} from '../lib/glassBackdrop.js';
import {
    REACH, STRETCH, TYPE, batteryState, chosenTone, glassDigits, glassInk, isColor, legibilityPlan, lockTone, mergeStats,
    partStyle, pickTone, regionIn, regionStats, roleOf, shortTemperature, styleWithPlan, widgetStyle,
} from '../lib/lockLook.js';
import {labelFont, styleFor, typefaceFor} from '../lib/lockType.js';
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
    // From under the date line to the bottom of the box, whatever its size.
    assertEqual(glassDigits(ink, 40, 200), {stretch: 1.6, y: 40});
    assertEqual(glassDigits(ink, 26, 540), {stretch: 5.14, y: 26}, 'a tall box: far past the most they once took (×2.8)');
    const {stretch, y} = glassDigits(ink, 26, 517);
    assert(y === 26 && Math.abs(y + stretch * ink - 517) < 1e-9, `their feet on the box's bottom (×${stretch})`);
    assertEqual(glassDigits(ink, 40, 900).stretch, STRETCH.max, 'never taller than the most');
    assertEqual(glassDigits(ink, 40, 100).stretch, STRETCH.min, 'never squashed');
    assertEqual(glassDigits(0, 40, 200), {stretch: 1, y: 40}, 'not measured: as they are');
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

export function testStyles() {
    const light = {color: '#f4f6f8', dark: false};
    const serif = typefaceFor('serif', ['DejaVu Serif']);
    // No shadow on the widget, whatever its parts need (not the
    // stylesheet's either): each part has the one planned for it.
    assertEqual(widgetStyle(light, serif), 'color: #f4f6f8; text-shadow: none; font-family: "DejaVu Serif";');
    const shadowed = legibilityPlan({...TYPE.line, tone: light, stats: statsOf('#a8b8d0')});
    const {alpha, blur, y} = shadowed.shadow;
    const shadow = `text-shadow: 0 ${y}px ${blur}px rgba(0, 0, 0, ${alpha});`;
    assertEqual(widgetStyle(light, serif, shadowed), `color: #f4f6f8; ${shadow} font-family: "DejaVu Serif";`,
        'as St takes it: x y blur colour');
    const dark = {color: '#202428', dark: true};
    const halo = legibilityPlan({...TYPE.line, tone: dark, stats: statsOf('#9a9a9a')});
    assert(widgetStyle(dark, typefaceFor('default'), halo).includes('rgba(255, 255, 255,'), 'dark type: a light halo');
    assertEqual(widgetStyle(dark, typefaceFor('default'), legibilityPlan({...TYPE.line, tone: dark, stats: statsOf('#ffffff')})),
        'color: #202428; text-shadow: none;', 'none where it reads');
    assertEqual(widgetStyle(null, typefaceFor('default')), '', 'on a card, as it is');
    assertEqual(widgetStyle(null, typefaceFor('inter')), 'font-family: "Inter";', 'in its typeface there too');
    // A part: as it is set, its shadow where planned and nowhere else.
    assertEqual(partStyle(['atelier-lock-value'], light, {weight: 700}, shadowed), `font-weight: 700; ${shadow}`);
    const night = legibilityPlan({...TYPE.line, tone: light, stats: statsOf('#16202c')});
    assertEqual(partStyle(['atelier-lock-value'], light, styleFor(typefaceFor('heavy'), 'text'), night),
        'font-weight: 800;', 'reading as it is: as its role has it, no shadow');
    assertEqual(partStyle(['atelier-widget-caption'], light), 'color: #f4f6f8;',
        'the quieter parts in the one tone too, solid');
    assertEqual(partStyle(['atelier-widget-time-suffix'], light), 'color: #f4f6f8;');
    assertEqual(partStyle(['atelier-widget-face'], light), 'color: #f4f6f8;');
    assertEqual(partStyle(['atelier-widget-caption'], null), '');
    assertEqual(partStyle(['atelier-widget-caption'], null, {weight: 450.4}, shadowed), 'font-weight: 450;',
        'on a card: its weight, never a shadow');
}

export function testRoles() {
    assertEqual(roleOf(['atelier-widget-glass-digits']), 'glass', 'the glass clock\'s digits');
    for (const name of ['atelier-widget-time', 'atelier-widget-stacked-hours', 'atelier-widget-stacked-minutes',
        'atelier-widget-day'])
        assertEqual(roleOf(['atelier-widget-big', name]), 'digits', `${name}: the big digits`);
    for (const name of ['atelier-widget-stacked-date', 'atelier-widget-glass-date', 'atelier-lock-value',
        'atelier-widget-caption', 'atelier-widget-time-suffix', 'atelier-widget-weekday'])
        assertEqual(roleOf([name]), 'text', `${name}: text`);
    assertEqual(roleOf([]), 'text');
    // Thin, from before the weight could be set: its digits thin, its text regular.
    const thin = typefaceFor('thin');
    assertEqual(styleFor(thin, roleOf(['atelier-widget-stacked-hours'])).weight, 200);
    assertEqual(styleFor(thin, roleOf(['atelier-widget-stacked-date'])).weight, 400);
}

export function testStyleWithPlan() {
    const bolder = {boldness: 0.5, weight: 700};
    const text = {weight: 600, width: 100};
    assertEqual(styleWithPlan(typefaceFor('inter'), text, bolder), {weight: 700, width: 100}, 'heavier on its weight');
    assertEqual(styleWithPlan(typefaceFor('default'), text, bolder), {weight: 700, width: 100},
        'axes not known: on its weight');
    const flex = typefaceFor('flex');
    const graded = styleWithPlan(flex, text, bolder);
    assertEqual(graded, {weight: 600, width: 100, extra: {GRAD: 75}},
        'Roboto Flex: on its grade, as wide as it was');
    assertEqual(labelFont(flex, graded, 20).variations, 'wght=600,wdth=100,opsz=20,GRAD=75', 'as a label takes it');
    assertEqual(styleWithPlan(flex, text, {boldness: 1, weight: 800}).extra.GRAD, flex.axes.GRAD.max, 'its most');
    assertEqual(styleWithPlan(flex, text, {boldness: 0, weight: 600}), text, 'not heavier: as it is');
    assertEqual(styleWithPlan(flex, text, null), text);
}

// A sample of bands of colours side by side, each as wide (a sky lighter
// at one side, say), or of the colours pixel by pixel (fine stripes).
function bands(colors, fine = false, width = 48, height = 30) {
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = fine ? (x + y) % colors.length : Math.floor(x * colors.length / width);
            pixels.set(hexToRgb(colors[i]), (y * width + x) * 3);
        }
    }
    return {pixels, channels: 3, rowstride: width * 3, width, height};
}

// The same frosted as the glass's backdrop is.
function frosted(sample) {
    const pixels = frost(sample.pixels, {width: sample.width, height: sample.height}, {sigma: 2});
    return {...sample, pixels, channels: 3, rowstride: sample.width * 3};
}

export function testGlassMaterial() {
    // The glass digits: large, so they need little (Lc 25); the glass at rest.
    const digits = {size: 140, weight: 600, glass: tintShown(), dim: 0.86};
    const all = [0, 0, 1, 1];
    const planOn = (colors, tone, {fine = false, ...options} = {}) => {
        const wallpaper = bands(colors, fine);
        const stats = regionStats(wallpaper, all);
        const ink = glassInk(tone, regionStats(frosted(wallpaper), all));
        return {stats, ink, plan: legibilityPlan({...digits, tone, stats, ink, ...options})};
    };
    const light = {color: '#f4f4f4', dark: false};
    // A night sky, lighter towards the city: light glass over it, lighter
    // than it, washed a little towards the tone – it reads as it is, no
    // shadow. (A flat tint over it would have wanted one.)
    const night = ['#1c2233', '#232a3d', '#2c3550', '#4a4a66'];
    const {stats, ink, plan} = planOn(night, light);
    assert(plan.lc >= plan.need && plan.shadow === null && plan.boldness === 0 && plan.glass === digits.glass,
        `on a night sky, as it is (${JSON.stringify(plan)})`);
    const flat = legibilityPlan({...digits, tone: light, stats});
    assert(flat.shadow !== null && flat.lc < plan.lc, `a flat tint would have taken a shadow (${JSON.stringify(flat)})`);
    // The colour it comes out: glassColor() of the lighter tenth of what is
    // behind, as the glass blurs it, through light glass.
    const frost = regionStats(frosted(bands(night)), all);
    assertEqual(ink(digits.glass, stats.tenths.light), glassColor({behind: frost.tenths.light, tone: light.color,
        ...glassFor(digits.glass), face: 'light'}));
    assertEqual(glassFor(digits.glass), {wash: GLASS.wash}, 'at rest');
    // Fine stripes, blurred, give the glass their mean: lit less.
    const fine = planOn(night, light, {fine: true}).plan;
    assert(fine.lc <= plan.lc, `${fine.lc} <= ${plan.lc}`);
    // A bright blue sky: the frost as light as the sky's lighter half –
    // a shadow round the digits (no heavier weight is read better that
    // large), as much as they lack.
    const sky = planOn(['#3b6fd8', '#8fb3ee'], {color: '#ffffff', dark: false}).plan;
    assert(sky.lc < sky.need && sky.boldness === 0 && sky.shadow?.color === '#000000' && sky.short === 0 &&
        sky.glass === digits.glass, `on a bright sky, a shadow (${JSON.stringify(sky)})`);
    // Without a shadow to give: more opaque glass, as much as it takes.
    const opaque = planOn(['#3b6fd8', '#8fb3ee'], {color: '#ffffff', dark: false},
        {reach: {bolder: 0, shadow: 0, glass: 0.92}}).plan;
    assert(opaque.shadow === null && opaque.glass > digits.glass && opaque.glass <= 0.92 && opaque.short === 0,
        `or more opaque glass (${JSON.stringify(opaque)})`);
    // Fog, under dark glass: it reads.
    const fog = planOn(['#d8dde3', '#c8ced6', '#e8ebef'], {color: '#242424', dark: true}).plan;
    assert(fog.short === 0 && fog.boldness === 0 && (fog.shadow?.alpha ?? 0) < 0.1 && fog.glass === digits.glass,
        `dark glass on fog: it reads, at most a faint glow round it (${JSON.stringify(fog)})`);
    // Dark type: through dark glass, washed towards its own tone.
    const darkInk = glassInk({color: '#242424', dark: true}, regionStats(frosted(bands(['#d8dde3'])), all));
    assertEqual(darkInk(GLASS.wash), glassColor({behind: '#d8dde3', tone: '#242424', wash: GLASS.wash, face: 'dark'}));
    // No backdrop made yet, or no glass: the tone alone, as without ink.
    assertEqual(glassInk(light, null), null);
    assertEqual(glassInk(light, stats, null), null);
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
