// The widgets on the desktop: their kinds and sizes, and where they are.
// Positions are cells of a grid laid over the work area of the primary
// monitor; a widget covers a few cells. Pure functions, shared by the shell
// and the preferences.

/** Side of a grid cell and the room between widgets, logical pixels. */
export const UNIT = 84;
export const GAP = 12;
export const PITCH = UNIT + GAP;
/** Room between the grid and the edges of the work area. */
export const MARGIN = 24;

/** Sizes, in cells: [columns, rows]. */
export const SIZES = {
    square: [2, 2],
    card: [4, 2],
    large: [4, 4],
    wide: [6, 2],
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
};

/** What a fresh desktop has. */
export const DEFAULT_LAYOUT = [
    {id: 'clock', kind: 'clock', size: 'square', x: 0, y: 0},
    {id: 'date', kind: 'date', size: 'square', x: 2, y: 0},
    {id: 'calendar', kind: 'calendar', size: 'large', x: 0, y: 2},
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
 * @returns {number[]} [columns, rows] of the grid that fits it
 */
export function gridSize(width, height) {
    return [
        Math.max(1, Math.floor((width - 2 * MARGIN + GAP) / PITCH)),
        Math.max(1, Math.floor((height - 2 * MARGIN + GAP) / PITCH)),
    ];
}

/**
 * The layout as stored, cleaned up: known kinds only, sizes they come in,
 * whole cells, unique ids.
 *
 * @param {string} json
 * @returns {object[]} [{id, kind, size, x, y, ...options}]
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
        let id = typeof item.id === 'string' && item.id ? item.id : item.kind;
        if (ids.has(id))
            id = newId([...ids].map(taken => ({id: taken})), item.kind);
        ids.add(id);
        layout.push({
            ...item,
            id,
            size: kind.sizes.includes(item.size) ? item.size : kind.sizes[0],
            x: Math.max(0, Math.round(Number(item.x) || 0)),
            y: Math.max(0, Math.round(Number(item.y) || 0)),
        });
    }
    return layout;
}

/**
 * @param {object[]} layout
 * @returns {string}
 */
export function serializeLayout(layout) {
    return JSON.stringify(layout);
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
 * The cell nearest to a point, for dropping a widget whose top left corner
 * is there.
 *
 * @param {number} px - from the left of the work area, logical pixels
 * @param {number} py - from its top
 * @returns {number[]} [x, y] in cells
 */
export function cellAt(px, py) {
    return [Math.max(0, Math.round((px - MARGIN) / PITCH)), Math.max(0, Math.round((py - MARGIN) / PITCH))];
}

/**
 * @param {number} x - in cells
 * @param {number} y
 * @returns {number[]} [px, py] of the cell's top left corner in the work area
 */
export function cellOrigin(x, y) {
    return [MARGIN + x * PITCH, MARGIN + y * PITCH];
}

/**
 * Keep every widget on the grid (after the screen got smaller, say): those
 * that no longer fit move to the nearest free place, or stay where they are
 * when there is none.
 *
 * @param {object[]} layout
 * @param {number[]} grid - [columns, rows]
 * @returns {object[]} a new layout
 */
export function fitLayout(layout, grid) {
    const placed = [];
    for (const entry of layout) {
        if (fits(placed, entry, grid)) {
            placed.push(entry);
            continue;
        }
        const spot = findSpot(placed, entry, grid);
        placed.push(spot ? {...entry, ...spot} : entry);
    }
    return placed;
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

/**
 * The desktop's widgets as a profile keeps them.
 *
 * @param {Gio.Settings} settings - the desktop's
 * @returns {object} {layout, style, glass}
 */
export function readWidgets(settings) {
    return {
        layout: parseLayout(settings.get_string('widgets')),
        style: settings.get_string('style'),
        glass: settings.get_boolean('glass'),
    };
}

/**
 * @param {object|null} raw - widgets as a profile keeps them
 * @returns {object|null} {layout, style, glass}, cleaned up
 */
export function normalizeWidgets(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.layout))
        return null;
    return {
        layout: parseLayout(JSON.stringify(raw.layout)),
        style: WIDGET_STYLES.includes(raw.style) ? raw.style : 'modern',
        glass: raw.glass !== false,
    };
}
