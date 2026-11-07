import {
    COLUMNS, GAP, INNER, ORDER, SIZE, TILES, TYPE, batteryDetails, batteryTone, chipLayout, fitScale, linkSpeed, panelSize, restRects, setRadio, shortOutputName,
    tileState, timeLeft, toggleOpen, wiredSubtitle,
} from '../lib/ccLayout.js';
import {assert, assertEqual, stylesheetRules} from './util.js';

const near = (a, b, by = 1e-6) => Math.abs(a - b) < by;

export function testColumns() {
    // 340 + 20 + 300 + 20 + 284 + 20 + 352 = 1336.
    const last = COLUMNS.at(-1);
    assertEqual(last.x + last.width, INNER.width, 'the columns fill the inner area');
    for (let i = 1; i < COLUMNS.length; i++)
        assertEqual(COLUMNS[i].x, COLUMNS[i - 1].x + COLUMNS[i - 1].width + GAP, `column ${i + 1} a gap after`);
    assertEqual(panelSize(), {width: 1392, height: 432}, 'the panel with its padding');
    // At Atelier's size: 1336 × 376 → about 735 × 207.
    assert(near(INNER.width * SIZE, 734.8) && near(INNER.height * SIZE, 206.8), 'at 0.55');
}

export function testTilesInTheirColumns() {
    for (const id of ORDER) {
        const tile = TILES[id];
        const column = COLUMNS[tile.column];
        assert(tile.x >= column.x && tile.x + tile.width <= column.x + column.width, `${id} in its column`);
        assert(tile.y >= 0 && tile.y + tile.height <= INNER.height, `${id} in the row`);
    }
    assertEqual([TILES.wifi.y, TILES.bt.y, TILES.airplane.y], [0, 132, 264], 'the pills at 0 / 132 / 264');
    assertEqual([TILES.caffeine.y, TILES.output.y], [0, 198], 'Caffeine and Output at 0 / 198');
    assertEqual(restRects().map(r => r.id), ORDER.filter(id => id !== 'wired'), 'a rect for each tile shown');
    assertEqual(restRects(true)[0].id, 'wired', 'Wired\'s in Wi-Fi\'s place');
}

export function testFit() {
    assertEqual(fitScale(2000), 1, 'a wide monitor: as it is');
    assert(near(fitScale(1392 * SIZE / 2), 0.5), 'half as wide: half the size');
    assertEqual(fitScale(0), 1, 'no width known: as it is');
}

export function testOpenAndClose() {
    assertEqual(toggleOpen(null, 'wifi'), 'wifi', 'its chevron opens a card');
    assertEqual(toggleOpen('wifi', 'wifi'), null, 'and closes it');
    assertEqual(toggleOpen('wifi', 'bt'), 'bt', 'one at a time');
    assertEqual(toggleOpen('out', null), null, 'the close area closes any');
    assertEqual(toggleOpen(null, 'airplane'), null, 'Airplane has none');
}

export function testRadios() {
    const rest = {wifiOn: true, btOn: true, airOn: false};
    assertEqual(setRadio(rest, 'air', true), {wifiOn: false, btOn: false, airOn: true}, 'Airplane on: both off');
    assertEqual(setRadio({wifiOn: false, btOn: false, airOn: true}, 'wifi', true),
        {wifiOn: true, btOn: false, airOn: false}, 'Wi-Fi on: Airplane off');
    assertEqual(setRadio(rest, 'bt', false), {wifiOn: true, btOn: false, airOn: false}, 'Bluetooth off alone');
}

export function testDerivedWifi() {
    const wifi = tileState('wifi', 'wifi');
    assertEqual([wifi.x, wifi.y, wifi.width, wifi.height, wifi.radius], [0, 0, 460, 376, 40],
        'Wi-Fi open: 460 × 376 from its top left corner, rounder no more');
    assert(wifi.raised && wifi.chevron === 90 && wifi.above && !wifi.inert, 'raised, its chevron turned, on top');
    const bt = tileState('bt', 'wifi');
    assertEqual([bt.opacity, bt.dy, bt.scale], [0, 20, 0.94], 'Bluetooth steps back down');
    assert(bt.inert, 'and takes no clicks');
    const caffeine = tileState('caffeine', 'wifi');
    assertEqual([caffeine.opacity, caffeine.scale, caffeine.pivotX], [0.3, 0.96, 0], 'column 2 dims from its left edge');
    assert(near(caffeine.pivotY, 188 / 178) && near(tileState('output', 'wifi').pivotY, -10 / 178),
        'about the middle of the column, not of each tile');
    assertEqual(tileState('brightness', 'wifi').opacity, 1, 'the sliders stay');
    const rest = tileState('wifi', null);
    assertEqual([rest.width, rest.height, rest.radius, rest.opacity, rest.inert], [340, 112, 56, 1, false],
        'at rest: a pill');
}

export function testDerivedBluetoothAndOutput() {
    const bt = tileState('bt', 'bt');
    assertEqual([bt.y, bt.width, bt.height], [0, 460, 376], 'Bluetooth grows up to the top');
    assertEqual([tileState('wifi', 'bt').dy, tileState('airplane', 'bt').dy], [-16, 20], 'Wi-Fi up, Airplane down');
    const out = tileState('output', 'out');
    assertEqual([out.x, out.y, out.width, out.height], [360, 0, 300, 376], 'Output grows up over Caffeine');
    const caffeine = tileState('caffeine', 'out');
    assertEqual([caffeine.opacity, caffeine.dy, caffeine.scale], [0, -14, 0.94], 'Caffeine steps back up');
    assertEqual(tileState('wifi', 'out').opacity, 1, 'column 1 stays');
}

export function testWiredInWifisPlace() {
    assertEqual([TILES.wired.x, TILES.wired.y, TILES.wired.width, TILES.wired.height],
        [TILES.wifi.x, TILES.wifi.y, TILES.wifi.width, TILES.wifi.height], 'Wired where Wi-Fi is');
    const wifi = tileState('wifi', null);
    const wired = tileState('wired', null);
    assert(wifi.opacity === 1 && wired.opacity === 0 && wired.inert && wired.dy === -16 && wired.scale === 0.94,
        'without Ethernet: Wi-Fi, Wired stepped back');
    const swapped = [tileState('wifi', null, {wired: true}), tileState('wired', null, {wired: true})];
    assert(swapped[0].opacity === 0 && swapped[0].inert && swapped[1].opacity === 1 && !swapped[1].inert,
        'with it: Wired, Wi-Fi stepped back');
    const open = tileState('wired', 'wired', {wired: true});
    assertEqual([open.width, open.height, open.raised], [460, 376, true], 'its card as Wi-Fi\'s');
    assertEqual([tileState('bt', 'wired', {wired: true}).opacity, tileState('caffeine', 'wired', {wired: true}).opacity],
        [0, 0.3], 'Bluetooth stepped back, column 2 dimmed');
    assertEqual(tileState('wifi', 'wifi', {wired: true}).raised, false, 'Wi-Fi\'s card not open while away');
    assertEqual(tileState('wired', 'bt', {wired: true}).dy, -16, 'Bluetooth\'s card: Wired up');
}

export function testWiredSubtitle() {
    assertEqual([linkSpeed(1000), linkSpeed(2500), linkSpeed(100), linkSpeed(0), linkSpeed(-1)],
        ['1 Gb/s', '2.5 Gb/s', '100 Mb/s', '', ''], 'speeds');
    assertEqual(wiredSubtitle({on: true, connecting: false, speed: 1000}), 'Connected · 1 Gb/s', 'connected');
    assertEqual(wiredSubtitle({on: true, connecting: false}), 'Connected', 'speed unknown');
    assertEqual(wiredSubtitle({on: true, connecting: true, speed: 1000}), 'Connecting…', 'connecting');
    assertEqual(wiredSubtitle({on: false, connecting: false}), 'Off', 'off');
}

export function testTimeLeftAndNames() {
    assertEqual(timeLeft({seconds: 15000, discharging: true}), '≈ 4 h 10 min left', 'hours and minutes');
    assertEqual(timeLeft({seconds: 1500, discharging: true}), '≈ 25 min left', 'minutes');
    assertEqual(timeLeft({seconds: 7200, discharging: true}), '≈ 2 h left', 'whole hours');
    assertEqual(timeLeft({seconds: 15000, discharging: false}), '', 'charging or on mains power: none');
    assertEqual(timeLeft({seconds: 0, discharging: true}), '', 'unknown: none');
    assertEqual(batteryTone({percent: 60, discharging: true}), '', 'discharging: no tone');
    assertEqual(batteryTone({percent: 20, discharging: true}), 'low', '20 %: low');
    assertEqual(batteryTone({percent: 10, discharging: true}), 'critical', '10 %: critical');
    assertEqual(batteryTone({percent: 8, charging: true}), 'charging', 'charging, however low');
    assertEqual(batteryTone({percent: 15, discharging: false}), '', 'on mains, not charging: no tone');
    assertEqual(batteryDetails({rate: 11.62, seconds: 15000, discharging: true, health: 92.4})[0],
        '11.6 W · 4 h 10 min left · Health 92 %', 'the details: power, time to empty, health');
    assertEqual(batteryDetails({rate: 24, toFull: 4800, charging: true})[0], '24.0 W · 1 h 20 min to full',
        'charging: the time to full; health unknown, not told');
    assertEqual(batteryDetails({health: 104})[0], 'Health 100 %', 'health at most 100 %');
    assertEqual(batteryDetails({}), [], 'nothing known: no details');
    const variants = batteryDetails({rate: 8, seconds: 3600, discharging: true, health: 90});
    assert(variants.length > 1 && variants.every((v, i) => i === 0 || v.length < variants[i - 1].length),
        `the details shorter one after another (${variants.join(' / ')})`);
    assertEqual(shortOutputName({description: 'Speakers – Built-in Audio'}), 'Speakers', 'speakers');
    assertEqual(shortOutputName({description: 'HDMI / DisplayPort 2 – GA102'}), 'HDMI', 'HDMI');
    assertEqual(shortOutputName({description: 'Headset', icon: 'audio-headset-symbolic'}), 'Headset', 'headset');
    assertEqual(shortOutputName({description: 'WH-1000XM4', icon: 'audio-headphones-symbolic'}), 'Headphones',
        'headphones by their icon');
    assertEqual(shortOutputName({description: 'Analog Output – Built-in Audio'}), 'Speakers', 'analog output');
    assertEqual(shortOutputName({description: 'Studio Monitor Interface'}), 'Studio Mo…', 'else its first words, short');
}

// The Controls tab's sizes in stylesheet.css (spec px: its Layout & Motion
// spec's, or as Atelier drew them at 0.8 of it where it says none), each
// at SIZE of them – icons whole pixels; edges 1 px, as St draws them, not
// here – so that a SIZE changed changes them all.
const SPEC_SIZES = {
    '.atelier-cc-grid': {margin: [0, 8, 8]},
    '.atelier-cc-glass-pill': {'border-radius': [56]},
    '.atelier-cc-raised': {'border-radius': [40]},
    '.atelier-cc-pill-header': {padding: [0, 22, 0, 24], spacing: [18]},
    '.atelier-cc-tile-header': {padding: [24], spacing: [18]},
    '.atelier-cc-tile-header-chevron': {spacing: [6]},
    '.atelier-cc-tile-header-chevron .atelier-cc-round': {'margin-right': [12]},
    '.atelier-cc-pill-text': {spacing: [10]},
    '.atelier-cc-opener-tile': {'border-radius': [40]},
    '.atelier-cc-chevron': {'icon-size': [20]},
    '.atelier-cc-round-big': {width: [60], height: [60]},
    '.atelier-cc-round-small': {width: [45], height: [45]},
    '.atelier-cc-round-icon-big': {'icon-size': [26]},
    '.atelier-cc-round-icon-small': {'icon-size': [20]},
    '.atelier-cc-chip': {'border-radius': [22]},
    '.atelier-cc-chip-pill': {'border-radius': [22]},
    '.atelier-cc-list': {padding: [0, 16]},
    '.atelier-cc-rows': {spacing: [2]},
    '.atelier-cc-list-placeholder': {padding: [16]},
    '.atelier-cc-row': {'border-radius': [22]},
    '.atelier-cc-row-action': {height: [44]},
    '.atelier-cc-row-device': {height: [56]},
    '.atelier-cc-row-output': {'border-radius': [25]},
    '.atelier-cc-row-highlight': {'border-radius': [22]},
    '.atelier-cc-row-content': {padding: [0, 15], spacing: [12]},
    '.atelier-cc-row-icon': {'icon-size': [20]},
    '.atelier-cc-row-icon-small': {'icon-size': [18.75]},
    '.atelier-cc-row-circle': {width: [38], height: [38]},
    '.atelier-cc-row-check': {'icon-size': [17.5]},
    '.atelier-cc-output-pill': {'border-radius': [25], padding: [0, 15]},
    '.atelier-cc-spinner': {width: [16], height: [16]},
    '.atelier-cc-minis': {spacing: [10]},
    '.atelier-cc-mini': {padding: [0, 15, 0, 7.5], spacing: [10]},
    '.atelier-cc-system': {padding: [30, 28, 28]},
    '.atelier-cc-battery-label': {spacing: [7.5]},
    '.atelier-cc-battery-icon': {'icon-size': [17.5]},
    '.atelier-cc-battery-bar': {margin: [22, 0, 24], 'border-radius': [44]},
    '.atelier-cc-system-gap': {height: [24]},
    '.atelier-cc-system-button': {width: [64], height: [64]},
    '.atelier-cc-system-icon': {'icon-size': [25]},
    // The capsules: the fill inside the 1 px edge, the ring 7.5 out
    // (shell/controlCentre/capsule.js).
    '.atelier-cc-capsule-track': {'border-radius': [44]},
    '.atelier-cc-capsule-edge': {'border-radius': [44]},
    '.atelier-cc-capsule-fill': {'border-radius': [{spec: 44, px: -1}]},
    '.atelier-cc-capsule-ring': {'border-radius': [51.5]},
    '.atelier-cc-capsule-icon-filled': {'icon-size': [32]},
    // (Its box as big as its icon.)
    '.atelier-cc-capsule-icon-box': {width: [{spec: 32, icon: true}], height: [{spec: 32, icon: true}],
        'margin-bottom': [34]},
    '.atelier-cc-capsule-menu': {margin: [10], padding: [7.5]},
    '.atelier-cc-capsule-menu-icon-filled': {'icon-size': [17.5]},
};

// Its type, of the one scale.
const TYPE_OF = {
    '.atelier-cc-title': TYPE.title,
    '.atelier-cc-mini-title': TYPE.title,
    '.atelier-cc-subtitle': TYPE.secondary,
    '.atelier-cc-chip-label': TYPE.secondary,
    '.atelier-cc-list-placeholder': TYPE.secondary,
    '.atelier-cc-row-title': TYPE.secondary,
    '.atelier-cc-row-subtitle': TYPE.secondary,
    '.atelier-cc-row-note': TYPE.secondary,
    '.atelier-cc-mini-subtitle': TYPE.secondary,
    '.atelier-cc-battery-title': TYPE.secondary,
    '.atelier-cc-battery-time': TYPE.secondary,
    '.atelier-cc-battery-details': TYPE.secondary,
    '.atelier-cc-battery-percent': TYPE.battery,
    '.atelier-cc-tab-label': TYPE.tab,
};

export function testStylesheetAtSize() {
    const rules = stylesheetRules();
    const valueOf = (selector, property) =>
        rules.filter(rule => rule.selectors.includes(selector) && property in rule.declarations).at(-1)
            ?.declarations[property];
    const pixels = value => value.split(/\s+/).map(v => v === '0' ? 0 : Number(/^(-?[\d.]+)px$/.exec(v)?.[1]));
    let checked = 0;
    for (const [selector, properties] of Object.entries(SPEC_SIZES)) {
        for (const [property, spec] of Object.entries(properties)) {
            const value = valueOf(selector, property);
            assert(value !== undefined, `${selector} sets its ${property}`);
            const expected = spec.map(v => {
                const at = typeof v === 'number' ? v * SIZE : v.spec * SIZE + (v.px ?? 0);
                return property === 'icon-size' || v.icon ? Math.round(at) : at;
            });
            const got = pixels(value);
            assert(got.length === expected.length && got.every((v, i) => Math.abs(v - expected[i]) < 0.006),
                `${selector} ${property}: the spec's ${spec.map(v => v.spec ?? v).join(' ')} at ${SIZE} ` +
                `(${expected.map(v => Math.round(v * 100) / 100).join(' ')}), not ${value}`);
            checked++;
        }
    }
    // The type: of the scale, each font size of the tab's (and the tabs').
    const known = new Set(Object.keys(TYPE_OF));
    for (const rule of rules) {
        const size = rule.declarations['font-size'];
        if (!size)
            continue;
        for (const selector of rule.selectors.filter(s => /^\.atelier-cc-(?!media|notif|calendar|ext)/.test(s)))
            assert(known.has(selector), `${selector}'s font size (${size}) of the Controls tab's type`);
    }
    for (const [selector, px] of Object.entries(TYPE_OF)) {
        assertEqual(valueOf(selector, 'font-size'), `${px}px`, `${selector}: its type`);
        checked++;
    }
    assertEqual(valueOf('.atelier-cc-battery-percent', 'letter-spacing'), `${-0.04 * TYPE.battery}px`,
        'the battery\'s figure −0.04 em apart');
    assert(checked > 70, `checked ${checked}`);
}

export function testChipLayout() {
    const widths = (...labels) =>
        chipLayout(138.6, labels, {gap: 4.4, room: 8.8}).map(c => Math.round(c.width * 10) / 10);
    const thirds = Math.round((138.6 - 8.8) / 3 * 10) / 10;
    assertEqual(widths(28, 11, 34), [thirds, thirds, thirds], 'labels with room in their thirds: thirds');
    assertEqual(widths(40, 37, 25), [48.8, 45.8, 35.2], 'one too wide: as wide as it needs, the rest even');
    const narrower = chipLayout(138.6, [44, 38, 26], {gap: 4.4, room: 8.8});
    assert(narrower.every((c, i) => near(c.width, [44, 38, 26][i] + 8.8, 1e-6)) && narrower[1].x - 52.8 < 4.4,
        `too little room for all of it: the gaps narrower first (${narrower.map(c => c.x.toFixed(1))})`);
    const cramped = widths(49, 44, 29);
    assert(near(cramped.reduce((a, b) => a + b, 0), 138.6, 0.2) && near(cramped[0] - 49, cramped[2] - 29, 0.1) &&
        cramped[0] > 49, `then less room round each, no gaps (${cramped})`);
    const over = chipLayout(138.6, [67, 54, 49], {gap: 4.4, room: 8.8});
    assert(near(over[2].x + over[2].width, 138.6, 1e-6) && over[0].width > over[2].width,
        `too long for the row: in it all the same (${over.map(c => c.width.toFixed(1))})`);
    const row = chipLayout(138.6, [28, 11, 34], {gap: 4.4, room: 8.8});
    assert(near(row[1].x, thirds + 4.4, 0.06) && near(row[2].x + row[2].width, 138.6, 1e-6),
        'a gap between, the row filled');
}
