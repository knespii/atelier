// The widgets on the desktop: their kinds and sizes, and where they are.
// Positions are cells of a grid laid over the work area of the primary
// monitor; a widget covers a few cells. A widget keeps the grid it was
// placed on – the main monitor's then – and where it was on a few others,
// so a monitor plugged in again finds them where they were. Pure functions,
// shared by the shell and the preferences.

/** Side of a grid cell and the room between widgets, logical pixels. */
export const UNIT = 36;
export const GAP = 12;
export const PITCH = UNIT + GAP;
/** Room between the grid and the edges of the work area, at least. */
export const MARGIN = 24;

/**
 * Sizes, in cells: [columns, rows]. (Each side an even number of cells, as
 * the grid has: each fits in its middle.)
 */
export const SIZES = {
    square: [4, 4],
    card: [8, 4],
    large: [8, 8],
    wide: [12, 4],
};

export const SIZE_NAMES = {square: 'Square', card: 'Card', large: 'Large square', wide: 'Wide'};

/** What there is, with the sizes each comes in (the first is where it starts). */
export const KINDS = {
    clock: {name: 'Clock', icon: 'preferences-system-time-symbolic', sizes: ['square', 'card']},
    date: {name: 'Date', icon: 'alarm-symbolic', sizes: ['square', 'card']},
    calendar: {name: 'Calendar', icon: 'x-office-calendar-symbolic', sizes: ['large', 'card']},
    weather: {name: 'Weather', icon: 'weather-few-clouds-symbolic', sizes: ['square', 'card']},
    github: {name: 'GitHub', icon: 'view-grid-symbolic', sizes: ['card', 'wide']},
    claude: {name: 'Claude Code', icon: 'starred-symbolic', sizes: ['square', 'card']},
    photo: {name: 'Photo', icon: 'image-x-generic-symbolic', sizes: ['square', 'card', 'large']},
    slack: {name: 'Slack', icon: 'chat-message-new-symbolic', sizes: ['square', 'card']},
};

/** The clock's faces: [id, name]; "auto" is digital in the Modern look and has hands in the Analogue one. */
export const CLOCK_FACES = [
    ['auto', 'Automatic'],
    ['digital', 'Digital'],
    ['watch', 'Watch'],
    ['numerals', 'Numerals'],
    ['minimal', 'Minimal'],
];

/** How many other grids a widget remembers its place on. */
const OTHER_PLACES = 3;

/** What a fresh desktop has. */
export const DEFAULT_LAYOUT = [
    {id: 'clock', kind: 'clock', size: 'square', x: 0, y: 0, fine: true},
    {id: 'date', kind: 'date', size: 'square', x: 4, y: 0, fine: true},
    {id: 'calendar', kind: 'calendar', size: 'large', x: 0, y: 4, fine: true},
];

/**
 * @param {string} size
 * @returns {number[]} [width, height] in logical pixels
 */
export function pixelSize(size) {
    const [columns, rows] = SIZES[size] ?? SIZES.square;
    return [columns * PITCH - GAP, rows * PITCH - GAP];
}

/**
 * @param {number} width - of the work area, logical pixels
 * @param {number} height
 * @returns {number[]} [columns, rows] of the grid that fits it: an even
 *   number of each, so that anything fits in its middle
 */
export function gridSize(width, height) {
    const even = n => Math.max(2, n - n % 2);
    return [
        even(Math.floor((width - 2 * MARGIN + GAP) / PITCH)),
        even(Math.floor((height - 2 * MARGIN + GAP) / PITCH)),
    ];
}

/**
 * @param {number} width - of the work area, logical pixels
 * @param {number} height
 * @returns {number[]} [px, py] of the grid's top left corner in the work
 *   area: the grid is in its middle
 */
export function gridOrigin(width, height) {
    const [columns, rows] = gridSize(width, height);
    return [
        Math.floor((width - (columns * PITCH - GAP)) / 2),
        Math.floor((height - (rows * PITCH - GAP)) / 2),
    ];
}

const isGrid = grid => Array.isArray(grid) && grid.length === 2 && grid.every(n => Number.isInteger(n) && n > 0);
const isCell = cell => Array.isArray(cell) && cell.length === 2 && cell.every(n => Number.isInteger(n) && n >= 0);

/** @returns {string} a grid as a key: "columns x rows", e.g. "19x10" */
const gridKey = ([columns, rows]) => `${columns}x${rows}`;

/**
 * The layout as stored, cleaned up: known kinds only, sizes they come in,
 * whole cells, unique ids, and the grids they were placed on.
 *
 * @param {string} json
 * @returns {object[]} [{id, kind, size, x, y, grid, places, ...options}]: x and
 *   y on grid ([columns, rows]; none when placed before grids were kept),
 *   places on other grids by their key ({"19x10": [x, y]})
 */
export function parseLayout(json) {
    let list;
    try {
        list = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(list))
        return [];
    const ids = new Set();
    const layout = [];
    for (const item of list) {
        const kind = KINDS[item?.kind];
        if (!kind)
            continue;
        // (Placed on the grid as it was, of cells twice as big: on this one.)
        const times = item.fine ? 1 : 2;
        let id = typeof item.id === 'string' && item.id ? item.id : item.kind;
        if (ids.has(id))
            id = newId([...ids].map(taken => ({id: taken})), item.kind);
        ids.add(id);
        const entry = {
            ...item,
            id,
            size: kind.sizes.includes(item.size) ? item.size : kind.sizes[0],
            x: Math.max(0, Math.round(Number(item.x) || 0)) * times,
            y: Math.max(0, Math.round(Number(item.y) || 0)) * times,
            fine: true,
        };
        delete entry.grid;
        delete entry.places;
        if (isGrid(item.grid))
            entry.grid = item.grid.map(n => n * times);
        const places = Object.entries(item.places && typeof item.places === 'object' ? item.places : {})
            .filter(([key, cell]) => /^[1-9]\d*x[1-9]\d*$/.test(key) && isCell(cell));
        if (places.length > 0) {
            entry.places = Object.fromEntries(places.map(([key, cell]) =>
                [key.split('x').map(n => Number(n) * times).join('x'), cell.map(n => n * times)]));
        }
        layout.push(entry);
    }
    return layout;
}

/**
 * @param {object[]} layout
 * @returns {string}
 */
export function serializeLayout(layout) {
    // (Every place on this grid, as parseLayout() made them.)
    return JSON.stringify(layout.map(entry => ({...entry, fine: true})));
}

/**
 * @param {object} a - {x, y, size}
 * @param {object} b
 * @returns {boolean} whether they share a cell
 */
function overlaps(a, b) {
    const [aw, ah] = SIZES[a.size];
    const [bw, bh] = SIZES[b.size];
    return a.x < b.x + bw && b.x < a.x + aw && a.y < b.y + bh && b.y < a.y + ah;
}

/**
 * @param {object[]} layout
 * @param {object} entry - {id, x, y, size}; itself in the layout is ignored
 * @param {number[]} grid - [columns, rows]
 * @returns {boolean} whether it fits there: on the grid, over no other widget
 */
export function fits(layout, entry, [columns, rows]) {
    const [w, h] = SIZES[entry.size];
    if (entry.x < 0 || entry.y < 0 || entry.x + w > columns || entry.y + h > rows)
        return false;
    return !layout.some(other => other.id !== entry.id && overlaps(entry, other));
}

/**
 * The first free place for a widget, row by row from the top left.
 *
 * @param {object[]} layout
 * @param {object} entry - {id, size}
 * @param {number[]} grid - [columns, rows]
 * @returns {object|null} {x, y}, or null when it fits nowhere
 */
export function findSpot(layout, entry, grid) {
    const [columns, rows] = grid;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) {
            if (fits(layout, {...entry, x, y}, grid))
                return {x, y};
        }
    }
    return null;
}

/**
 * Where a widget being dragged would land: of the places where it fits,
 * the nearest to where it is now.
 *
 * @param {object[]} layout
 * @param {object} entry - {id, size, x, y}: the widget, where it was
 * @param {number[]} grid - [columns, rows]
 * @param {number} fx - its top left corner now, in cells (not whole ones)
 * @param {number} fy
 * @returns {object} {x, y}; where it was when it fits nowhere else
 */
export function nearestSpot(layout, entry, grid, fx, fy) {
    const [columns, rows] = grid;
    let spot = {x: entry.x, y: entry.y};
    let best = Infinity;
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < columns; x++) {
            const distance = (x - fx) ** 2 + (y - fy) ** 2;
            if (distance < best && fits(layout, {...entry, x, y}, grid)) {
                spot = {x, y};
                best = distance;
            }
        }
    }
    return spot;
}

/**
 * The size a widget being stretched would take: of the sizes its kind
 * comes in, the one nearest to how big it is now that fits where it is.
 *
 * @param {object[]} layout
 * @param {object} entry - {id, kind, size, x, y}
 * @param {number[]} grid - [columns, rows]
 * @param {number} fw - its width now, in cells (not whole ones)
 * @param {number} fh - its height
 * @returns {string} the size; the one it has when no other fits
 */
export function nearestSize(layout, entry, grid, fw, fh) {
    let size = entry.size;
    let best = Infinity;
    for (const candidate of KINDS[entry.kind]?.sizes ?? []) {
        const [w, h] = SIZES[candidate];
        const distance = (w - fw) ** 2 + (h - fh) ** 2;
        if (distance < best && fits(layout, {...entry, size: candidate}, grid)) {
            size = candidate;
            best = distance;
        }
    }
    return size;
}

/**
 * @param {number} pixels - a length in logical pixels
 * @returns {number} how many cells it spans, not whole ones (a widget of
 *   two cells is two, with the gap between them)
 */
export function cellsOf(pixels) {
    return (pixels + GAP) / PITCH;
}

/**
 * Where a point is on the grid, for dropping a widget whose top left
 * corner is there.
 *
 * @param {number} px - from the left of the work area, logical pixels
 * @param {number} py - from its top
 * @param {number[]} [origin] - of the grid (gridOrigin())
 * @returns {number[]} [x, y] in cells, not whole ones
 */
export function cellsAt(px, py, [ox, oy] = [MARGIN, MARGIN]) {
    return [(px - ox) / PITCH, (py - oy) / PITCH];
}

/**
 * The cell nearest to a point.
 *
 * @param {number} px - from the left of the work area, logical pixels
 * @param {number} py - from its top
 * @param {number[]} [origin] - of the grid (gridOrigin())
 * @returns {number[]} [x, y] in cells
 */
export function cellAt(px, py, origin) {
    return cellsAt(px, py, origin).map(n => Math.max(0, Math.round(n)));
}

/**
 * @param {number} x - in cells
 * @param {number} y
 * @param {number[]} [origin] - of the grid (gridOrigin())
 * @returns {number[]} [px, py] of the cell's top left corner in the work area
 */
export function cellOrigin(x, y, [ox, oy] = [MARGIN, MARGIN]) {
    return [ox + x * PITCH, oy + y * PITCH];
}

/**
 * Along one side of a grid, where something placed on a grid of another
 * length goes: as near to the edge it was near as it was, or as far from
 * the middle when it was in the middle third – and on a smaller grid, in
 * the same third.
 *
 * @param {number} position - its first cell
 * @param {number} size - how many cells it covers
 * @param {number} length - of the grid it was placed on
 * @param {number} newLength - of the grid now
 * @returns {number} its first cell now
 */
function along(position, size, length, newLength) {
    const room = length - size;
    const newRoom = newLength - size;
    if (room <= 0 || newRoom <= 0)
        return 0;
    const third = Math.floor(newRoom / 3);
    if (position <= room / 3)
        return Math.min(position, third);
    if (position >= room * 2 / 3)
        return newRoom - Math.min(room - position, third);
    const shifted = Math.round(newRoom / 2 + position - room / 2);
    return Math.min(Math.max(shifted, Math.ceil(newRoom / 3)), Math.floor(newRoom * 2 / 3));
}

/**
 * @param {object[]} entries - on one grid
 * @returns {object[][]} those that touch one another, together
 */
function touching(entries) {
    const touch = (a, b) => {
        const [aw, ah] = SIZES[a.size];
        const [bw, bh] = SIZES[b.size];
        return a.x <= b.x + bw && b.x <= a.x + aw && a.y <= b.y + bh && b.y <= a.y + ah;
    };
    let groups = [];
    for (const entry of entries) {
        const joined = groups.filter(group => group.some(other => touch(entry, other)));
        groups = [...groups.filter(group => !joined.includes(group)), [entry, ...joined.flat()]];
    }
    return groups;
}

/**
 * The layout on the grid there is now (of the main monitor's work area).
 * A widget placed on a grid of this size is where it was placed; others go
 * from where they were last placed, together with the widgets they touched
 * there, as near to the same edges (or the middle) as they were. Where one
 * would be in another's way, it goes to the free cells nearest to that.
 * The layout itself stays as it was placed: this is only how it shows.
 *
 * @param {object[]} layout
 * @param {number[]} grid - [columns, rows]
 * @returns {object[]} a new layout, in the same order
 */
export function fitLayout(layout, grid) {
    const key = gridKey(grid);
    // Placed before grids were kept: on this grid, or one big enough for it.
    const loose = layout.filter(entry => !entry.grid);
    const assumed = [0, 1].map(axis => Math.max(grid[axis],
        ...loose.map(entry => (axis ? entry.y : entry.x) + SIZES[entry.size][axis])));
    const cells = new Map();
    const exact = new Set();
    const elsewhere = new Map();
    for (const entry of layout) {
        const from = entry.grid ?? assumed;
        const place = gridKey(from) === key ? [entry.x, entry.y] : entry.places?.[key];
        if (place) {
            cells.set(entry, place);
            exact.add(entry);
        } else {
            if (!elsewhere.has(gridKey(from)))
                elsewhere.set(gridKey(from), {from, entries: []});
            elsewhere.get(gridKey(from)).entries.push(entry);
        }
    }
    for (const {from, entries} of elsewhere.values()) {
        for (const group of touching(entries)) {
            const [left, top] = [Math.min(...group.map(e => e.x)), Math.min(...group.map(e => e.y))];
            const width = Math.max(...group.map(e => e.x + SIZES[e.size][0])) - left;
            const height = Math.max(...group.map(e => e.y + SIZES[e.size][1])) - top;
            const dx = along(left, width, from[0], grid[0]) - left;
            const dy = along(top, height, from[1], grid[1]) - top;
            group.forEach(entry => cells.set(entry, [entry.x + dx, entry.y + dy]));
        }
    }
    // Those placed on this grid first, in the way of the others.
    const placed = [];
    for (const entry of [...layout.filter(e => exact.has(e)), ...layout.filter(e => !exact.has(e))]) {
        const [x, y] = cells.get(entry);
        const moved = {...entry, x, y};
        placed.push(fits(placed, moved, grid) ? moved : {...moved, ...nearestSpot(placed, moved, grid, x, y)});
    }
    return layout.map(entry => placed.find(p => p.id === entry.id));
}

/**
 * A widget placed on a grid by hand. Where it was on another grid is kept
 * (for a few), for when the screen is that big again.
 *
 * @param {object} entry - as kept in the layout
 * @param {number} x
 * @param {number} y
 * @param {number[]} grid - the one it was placed on
 * @returns {object} the entry, placed
 */
export function placeAt(entry, x, y, grid) {
    const places = {...entry.places};
    if (entry.grid && gridKey(entry.grid) !== gridKey(grid)) {
        delete places[gridKey(entry.grid)];
        places[gridKey(entry.grid)] = [entry.x, entry.y];
    }
    delete places[gridKey(grid)];
    const placed = {...entry, x, y, grid: [...grid]};
    delete placed.places;
    const kept = Object.entries(places).slice(-OTHER_PLACES);
    return kept.length > 0 ? {...placed, places: Object.fromEntries(kept)} : placed;
}

/**
 * @param {object[]} layout
 * @param {string} kind
 * @returns {string} an id no widget has yet
 */
export function newId(layout, kind) {
    const ids = new Set(layout.map(entry => entry.id));
    for (let n = 1; ; n++) {
        const id = n === 1 ? kind : `${kind}-${n}`;
        if (!ids.has(id))
            return id;
    }
}

/**
 * @param {string} kind
 * @param {string} size - the current one
 * @returns {string} the next size it comes in
 */
export function nextSize(kind, size) {
    const sizes = KINDS[kind]?.sizes ?? ['square'];
    return sizes[(sizes.indexOf(size) + 1) % sizes.length];
}

export const WIDGET_STYLES = ['modern', 'analogue'];

// The cards' background and shadow in each look, as in stylesheet.css:
// [red, green, blue, alpha] and the shadow's [offset, blur, alpha].
const CARD_LOOKS = {
    modern: {background: [18, 18, 22, 0.94], shadow: [8, 22, 0.28]},
    glassy: {background: [14, 14, 18, 0.38], shadow: [8, 22, 0.16]},
    analogue: {background: [246, 241, 231, 1], shadow: [8, 20, 0.26]},
};

const clampOpacity = value => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1);

/**
 * The cards more see-through than their look has them: their background,
 * and their shadow with it (it would show through).
 *
 * @param {string} look - modern, glassy or analogue
 * @param {number} opacity - how much of the background they keep, 0 to 1
 * @returns {string} inline CSS for a card; '' for the look as it is
 */
export function cardStyle(look, opacity) {
    const card = CARD_LOOKS[look] ?? CARD_LOOKS.modern;
    const keep = clampOpacity(opacity);
    if (keep >= 1)
        return '';
    const [r, g, b, a] = card.background;
    const [offset, blur, shadow] = card.shadow;
    const alpha = n => Math.round(n * keep * 1000) / 1000;
    return `background-color: rgba(${r}, ${g}, ${b}, ${alpha(a)}); ` +
        `box-shadow: 0 ${offset}px ${blur}px rgba(0, 0, 0, ${alpha(shadow)});`;
}

/**
 * The desktop's widgets as a profile keeps them.
 *
 * @param {Gio.Settings} settings - the desktop's
 * @returns {object} {layout, style, glass, opacity}
 */
export function readWidgets(settings) {
    return {
        layout: parseLayout(settings.get_string('widgets')),
        style: settings.get_string('style'),
        glass: settings.get_boolean('glass'),
        opacity: settings.get_double('card-opacity'),
    };
}

/**
 * @param {object|null} raw - widgets as a profile keeps them
 * @returns {object|null} {layout, style, glass, opacity}, cleaned up
 */
export function normalizeWidgets(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.layout))
        return null;
    return {
        layout: parseLayout(JSON.stringify(raw.layout)),
        style: WIDGET_STYLES.includes(raw.style) ? raw.style : 'modern',
        glass: raw.glass !== false,
        opacity: clampOpacity(raw.opacity ?? 1),
    };
}
