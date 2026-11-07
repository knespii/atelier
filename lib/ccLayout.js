// The control centre's Controls tab as its Layout & Motion spec lays it
// out: one row of four columns 376 px high – Wi-Fi (or Wired, in its
// place, while Ethernet is connected), Bluetooth and Airplane pills;
// Caffeine and Output tiles; the brightness and volume sliders; the
// system tile – each tile placed absolutely in its column, so that a card
// can grow over its neighbours without them moving. And what each tile is
// (where, how big, how round, shown or stepped back) for which card is
// open: the UI is a function of that state. In the spec's pixels; Atelier
// draws it at SIZE of them (shell/controlCentre/host.js). Pure, for the
// unit tests.

/** Atelier's size of the spec's pixels. */
export const SIZE = 0.55;

/**
 * The Controls tab's type (logical px, stylesheet.css), of one scale
 * rather than the spec's × SIZE, to read: titles (a tile's, a card's, a
 * mini pill's), the rest (subtitles, chips, a list's rows and notes), the
 * battery's figure; the tabs above, the same as the titles.
 */
export const TYPE = Object.freeze({title: 11, secondary: 9.5, battery: 28, tab: 11});

/** The panel's padding round its inner area (spec px). */
export const PADDING = 28;

/** Its inner area (spec px). */
export const INNER = Object.freeze({width: 1336, height: 376});

/** The room between columns (spec px). */
export const GAP = 20;

/** The four columns, left to right (spec px): x and width. */
export const COLUMNS = Object.freeze([
    {x: 0, width: 340},
    {x: 360, width: 300},
    {x: 680, width: 284},
    {x: 984, width: 352},
]);

/** The radii (spec px). */
export const RADIUS = Object.freeze({pill: 56, tile: 40, slider: 44, card: 40});

/**
 * Each tile at rest (spec px, in the inner area): its column, where, how
 * big, how round.
 */
export const TILES = Object.freeze({
    wifi: {column: 0, x: 0, y: 0, width: 340, height: 112, radius: RADIUS.pill},
    // (In Wi-Fi's place, the one or the other shown.)
    wired: {column: 0, x: 0, y: 0, width: 340, height: 112, radius: RADIUS.pill},
    bt: {column: 0, x: 0, y: 132, width: 340, height: 112, radius: RADIUS.pill},
    airplane: {column: 0, x: 0, y: 264, width: 340, height: 112, radius: RADIUS.pill},
    caffeine: {column: 1, x: 360, y: 0, width: 300, height: 178, radius: RADIUS.tile},
    output: {column: 1, x: 360, y: 198, width: 300, height: 178, radius: RADIUS.tile},
    brightness: {column: 2, x: 680, y: 0, width: 132, height: 376, radius: RADIUS.slider},
    volume: {column: 2, x: 832, y: 0, width: 132, height: 376, radius: RADIUS.slider},
    system: {column: 3, x: 984, y: 0, width: 352, height: 376, radius: RADIUS.tile},
});

/** The tiles in the order they are drawn at rest. */
export const ORDER = Object.freeze(Object.keys(TILES));

/** The cards that open: which tile each is. */
export const CARDS = Object.freeze({wifi: 'wifi', wired: 'wired', bt: 'bt', out: 'output'});

/** The cards over column 1, dimming column 2. */
const RADIO_CARDS = new Set(['wifi', 'wired', 'bt']);

/** Each card open (spec px): where it grows to. */
export const OPEN = Object.freeze({
    wifi: {x: 0, y: 0, width: 460, height: 376, radius: RADIUS.card},
    wired: {x: 0, y: 0, width: 460, height: 376, radius: RADIUS.card},
    bt: {x: 0, y: 0, width: 460, height: 376, radius: RADIUS.card},
    out: {x: 360, y: 0, width: 300, height: 376, radius: RADIUS.card},
});

/**
 * Where a tile steps back to when hidden by a card open beside it
 * (translateY, scale): Wi-Fi up, Bluetooth and Airplane down, Caffeine up.
 */
export const HIDE = Object.freeze({
    wifi: {dy: -16, scale: 0.94},
    wired: {dy: -16, scale: 0.94},
    bt: {dy: 20, scale: 0.94},
    airplane: {dy: 20, scale: 0.94},
    caffeine: {dy: -14, scale: 0.94},
});

/** Column 2 behind an open Wi-Fi or Bluetooth card. */
export const DIM = Object.freeze({opacity: 0.3, scale: 0.96});

/**
 * The panel's size (spec px): its inner area and padding.
 *
 * @returns {{width: number, height: number}}
 */
export function panelSize() {
    return {width: INNER.width + 2 * PADDING, height: INNER.height + 2 * PADDING};
}

/**
 * How much smaller than SIZE it has to be drawn to fit a monitor so wide
 * (logical px, after the island's own margins): 1 when it fits.
 *
 * @param {number} available - logical px
 * @returns {number} 0 … 1
 */
export function fitScale(available) {
    const width = panelSize().width * SIZE;
    if (!(available > 0))
        return 1;
    return Math.min(1, available / width);
}

/**
 * The next state of which card is open, as the spec has it: a card's
 * chevron opens it, or closes it when it is open; the close area (or Esc)
 * closes any. At most one is open.
 *
 * @param {string|null} open - 'wifi', 'wired', 'bt', 'out' or null
 * @param {string|null} key - the card clicked, or null for the close area
 * @returns {string|null}
 */
export function toggleOpen(open, key) {
    if (!key || !(key in OPEN))
        return null;
    return open === key ? null : key;
}

/**
 * A row of chips (Caffeine's, Output's) so wide (any unit): thirds, as the
 * spec has them, while each label has `room` round it in its own; else a
 * chip too narrow for its label as wide as it needs, the others as even as
 * what is left lets them be – their room less, then their gaps, if there
 * isn't enough – so that no label is cut short that can be helped; past
 * that, each as its label in the row. (Hidden chips: labels 0 wide.)
 *
 * @param {number} width
 * @param {number[]} labels - each label's width
 * @param {object} options
 * @param {number} options.gap - between chips
 * @param {number} options.room - round a label, both sides together
 * @returns {{x: number, width: number}[]}
 */
export function chipLayout(width, labels, {gap, room}) {
    const count = labels.length;
    const total = labels.reduce((a, b) => a + b, 0);
    gap = Math.max(0, Math.min(gap, (width - total) / Math.max(1, count - 1)));
    const free = width - (count - 1) * gap;
    room = Math.max(0, Math.min(room, (free - total) / count));
    // (Too long for the row at all: each in it as its label, cut short.)
    const shrink = total > free ? free / total : 1;
    const needs = labels.map(w => w * shrink + room);
    // (The even width t that, the chips needing more taking what they need,
    // fills the row: the largest needs first.)
    const order = needs.map((need, i) => i).sort((a, b) => needs[b] - needs[a]);
    let rest = free;
    let left = count;
    let even = free / count;
    for (const i of order) {
        if (needs[i] <= even)
            break;
        rest -= needs[i];
        left--;
        even = left > 0 ? rest / left : 0;
    }
    let x = 0;
    return needs.map(need => {
        const chip = {x, width: Math.max(need, even)};
        x += chip.width + gap;
        return chip;
    });
}

/**
 * Airplane mode against the radios, as the spec has it: turning it on
 * turns Wi-Fi and Bluetooth off; turning either on turns it off.
 *
 * @param {{wifiOn: boolean, btOn: boolean, airOn: boolean}} radios
 * @param {string} which - 'wifi', 'bt' or 'air'
 * @param {boolean} on
 * @returns {{wifiOn: boolean, btOn: boolean, airOn: boolean}}
 */
export function setRadio(radios, which, on) {
    const next = {...radios};
    if (which === 'air') {
        next.airOn = on;
        if (on) {
            next.wifiOn = false;
            next.btOn = false;
        }
    } else {
        next[`${which}On`] = on;
        if (on)
            next.airOn = false;
    }
    return next;
}

/**
 * A tile as the state has it (spec px, in the inner area): where it is,
 * how big and round, how shown – raised (the open card: its raised glass
 * and shadow, its chevron turned) or stepped back (hidden by the card open
 * beside it, or column 2 dimmed behind Wi-Fi's, Wired's or Bluetooth's) –
 * and whether it takes clicks and the keyboard. Wi-Fi and Wired are in one
 * place, the other stepped back as Wi-Fi's neighbours are by its card.
 *
 * @param {string} id - one of TILES
 * @param {string|null} open - the card open
 * @param {object} [options]
 * @param {boolean} [options.wired] - Wired shows in Wi-Fi's place
 * @returns {{x: number, y: number, width: number, height: number, radius: number, opacity: number,
 *   dy: number, scale: number, pivotY: number, raised: boolean, chevron: number, inert: boolean, above: boolean}}
 */
export function tileState(id, open, {wired = false} = {}) {
    const rest = TILES[id];
    const card = Object.entries(CARDS).find(([, tile]) => tile === id)?.[0] ?? null;
    const away = (id === 'wifi' && wired) || (id === 'wired' && !wired);
    const isOpen = card !== null && open === card && !away;
    const radioCard = RADIO_CARDS.has(open);
    const hidden = away || (rest.column === 0 && radioCard && !isOpen) || (id === 'caffeine' && open === 'out');
    const dimmed = rest.column === 1 && radioCard;
    const at = isOpen ? OPEN[card] : rest;
    let [opacity, dy, scale] = [1, 0, 1];
    // (Scaled about its centre; column 2 about its left edge, halfway down
    // the column: its pivot's y, of the tile's height.)
    let pivotY = 0.5;
    if (hidden) {
        ({dy, scale} = HIDE[id]);
        opacity = 0;
    } else if (dimmed) {
        ({opacity, scale} = DIM);
        pivotY = (INNER.height / 2 - rest.y) / rest.height;
    }
    return {
        x: at.x, y: at.y, width: at.width, height: at.height, radius: at.radius,
        opacity, dy, scale, pivotY, pivotX: dimmed ? 0 : 0.5,
        raised: isOpen, chevron: isOpen ? 90 : 0,
        // (Nothing but the open card takes the keyboard while one is open;
        // the close area takes the clicks round it.)
        inert: away || (open !== null && !isOpen),
        above: isOpen,
    };
}

/**
 * The tiles' rects at rest (spec px, in the inner area), for what is
 * behind each (shell/controlCentre/ink.js) and the tests: Wi-Fi's or, in
 * its place, Wired's.
 *
 * @param {boolean} [wired] - Wired shows in Wi-Fi's place
 * @returns {{id: string, x: number, y: number, width: number, height: number, radius: number}[]}
 */
export function restRects(wired = false) {
    return ORDER.filter(id => id !== (wired ? 'wifi' : 'wired')).map(id => {
        const {x, y, width, height, radius} = TILES[id];
        return {id, x, y, width, height, radius};
    });
}

/**
 * A battery's time left, as the system tile shows it ("≈ 4 h 10 min
 * left"): none when it is charged, charging or on mains power, or unknown.
 *
 * @param {object} battery
 * @param {number} battery.seconds - to empty
 * @param {boolean} battery.discharging
 * @returns {string}
 */
export function timeLeft({seconds, discharging}) {
    if (!discharging || !(seconds > 0))
        return '';
    const minutes = Math.round(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0)
        return `≈ ${rest} min left`;
    return rest === 0 ? `≈ ${hours} h left` : `≈ ${hours} h ${rest} min left`;
}

/**
 * A link's speed as the Wired pill tells it ("1 Gb/s", "100 Mb/s"): none
 * when unknown.
 *
 * @param {number} speed - Mb/s
 * @returns {string}
 */
export function linkSpeed(speed) {
    if (!(speed > 0))
        return '';
    if (speed < 1000)
        return `${Math.round(speed)} Mb/s`;
    return `${Math.round(speed / 100) / 10} Gb/s`;
}

/**
 * The Wired pill's line under its title.
 *
 * @param {object} wired
 * @param {boolean} wired.on - a wired connection up or on its way
 * @param {boolean} wired.connecting
 * @param {number} [wired.speed] - Mb/s
 * @returns {string}
 */
export function wiredSubtitle({on, connecting, speed = 0}) {
    if (connecting)
        return 'Connecting…';
    if (!on)
        return 'Off';
    const fast = linkSpeed(speed);
    return fast ? `Connected · ${fast}` : 'Connected';
}

/**
 * A short name for an audio output's chip ("Speakers", "Headset",
 * "HDMI"…), from its description and what GNOME tells of its kind.
 *
 * @param {object} device
 * @param {string} device.description - "Speakers – Built-in Audio", say
 * @param {string} [device.icon] - its icon's name
 * @param {string} [device.origin] - the card's name
 * @returns {string}
 */
export function shortOutputName({description = '', icon = '', origin = ''}) {
    const text = `${description} ${origin}`.toLowerCase();
    if (/hdmi|displayport|\bdp\b/.test(text))
        return 'HDMI';
    if (/headset/.test(text) || icon.includes('headset'))
        return 'Headset';
    if (/headphone/.test(text) || icon.includes('headphones'))
        return 'Headphones';
    if (/bluetooth/.test(text) || icon.includes('bluetooth'))
        return 'Bluetooth';
    if (/usb/.test(text))
        return 'USB';
    if (/speaker|analog output|built-in/.test(text) || icon.includes('speaker'))
        return 'Speakers';
    const word = description.split(/[–—(-]/)[0].trim();
    return word.length > 10 ? `${word.slice(0, 9)}…` : word || 'Output';
}
