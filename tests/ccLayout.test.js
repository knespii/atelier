import {
    COLUMNS, GAP, INNER, ORDER, SIZE, TILES, fitScale, linkSpeed, panelSize, restRects, setRadio, shortOutputName,
    tileState, timeLeft, toggleOpen, wiredSubtitle,
} from '../lib/ccLayout.js';
import {assert, assertEqual} from './util.js';

const near = (a, b, by = 1e-6) => Math.abs(a - b) < by;

export function testColumns() {
    // 340 + 20 + 300 + 20 + 284 + 20 + 352 = 1336.
    const last = COLUMNS.at(-1);
    assertEqual(last.x + last.width, INNER.width, 'the columns fill the inner area');
    for (let i = 1; i < COLUMNS.length; i++)
        assertEqual(COLUMNS[i].x, COLUMNS[i - 1].x + COLUMNS[i - 1].width + GAP, `column ${i + 1} a gap after`);
    assertEqual(panelSize(), {width: 1392, height: 432}, 'the panel with its padding');
    // At Atelier's size: 1336 × 376 → about 534 × 150.
    assert(near(INNER.width * SIZE, 534.4) && near(INNER.height * SIZE, 150.4), 'at 0.4');
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
    assertEqual(shortOutputName({description: 'Speakers – Built-in Audio'}), 'Speakers', 'speakers');
    assertEqual(shortOutputName({description: 'HDMI / DisplayPort 2 – GA102'}), 'HDMI', 'HDMI');
    assertEqual(shortOutputName({description: 'Headset', icon: 'audio-headset-symbolic'}), 'Headset', 'headset');
    assertEqual(shortOutputName({description: 'WH-1000XM4', icon: 'audio-headphones-symbolic'}), 'Headphones',
        'headphones by their icon');
    assertEqual(shortOutputName({description: 'Analog Output – Built-in Audio'}), 'Speakers', 'analog output');
    assertEqual(shortOutputName({description: 'Studio Monitor Interface'}), 'Studio Mo…', 'else its first words, short');
}
