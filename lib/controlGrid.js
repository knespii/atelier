// Where the control centre's modules go: a grid of square cells, wider
// than tall (as macOS's Control Center would be with its two columns of
// modules side by side, eight cells across), filled to its last cell –
// no hole, whatever tiles there are. Each module asks for so many columns
// and rows, may grow (Do Not Disturb's pill, the system buttons' row,
// Connectivity's rows, Now Playing) or shrink (the system buttons) by so
// much, and has a side: the left half (pane 0), the right (pane 1) or any.
// The packing is the one of least cost – a cell left empty costing most,
// a grid of other than eight columns, a module grown or shrunk, a module
// on the other side less – found by a search over what goes in each empty
// cell, first to last (so that, as cheap, the modules come in their
// order); squares all alike are taken in their order. Where no packing
// leaves no hole (or the search is cut short), a module beside a hole
// grows over it. Pure, for the unit tests.

// The columns a grid has as it is meant to (two panes of four), and its halves.
export const COLUMNS = 8;
export const PANES = 2;
// Logical pixels: a cell's side, the gap between cells.
// (Two cells wide hold a tile's round icon, its name – "Airplane Mode",
// "Do Not Disturb" – and its menu's arrow, none of it cut short; a cell
// wide and two tall, a capsule of iOS's proportions.)
export const CELL = 96;
export const GAP = 10;

// What a packing costs: a cell left empty, a column more or less than
// COLUMNS, a column or a row more or less than a module asks for, a column
// of a module on the other side, a module of a side before one listed
// before it there (reading left to right, top to bottom).
// (And, only where nothing else fills the grid, a module grown past what
// it may grow to – by a row or two columns at most: stretch.)
export const COST = Object.freeze({empty: 100, width: 6, col: 2, row: 3, side: 1.5, order: 0.6, stretch: 20});
// The most grids tried (columns × rows), and steps of the search in all.
const SIZES = 5;
const STEPS = 16000;

/**
 * @typedef {object} ModuleRequest
 * @property {string} id
 * @property {number} cols - as many as it asks for
 * @property {number} rows - at least
 * @property {number} [minCols] - as few as it can do with (cols)
 * @property {number} [maxCols] - as many as it may grow to (cols)
 * @property {number} [maxRows] - as many as it may grow to (rows)
 * @property {number|string} [pane] - 0 (the left half), 1 (the right) or 'any'
 */

/**
 * @typedef {object} Placement
 * @property {string} id
 * @property {number} col - from the grid's left
 * @property {number} row
 * @property {number} cols
 * @property {number} rows
 * @property {number} pane - the half it is (mostly) in
 */

const int = (value, fallback) => (Number.isFinite(value) ? Math.round(value) : fallback);

// A module's shapes, the cheapest first: [cols, rows, cost]. (Stretched:
// a little past what it may grow to, too.)
function shapesOf(module, columns, stretched = false) {
    const cols = Math.max(1, int(module.cols, 1));
    const rows = Math.max(1, int(module.rows, 1));
    const minCols = Math.max(1, Math.min(cols, int(module.minCols, cols)));
    const maxCols = Math.max(cols, int(module.maxCols, cols));
    const maxRows = Math.max(rows, int(module.maxRows, rows));
    const shapes = [];
    const [lastCol, lastRow] = stretched ? [maxCols + 2, maxRows + 1] : [maxCols, maxRows];
    for (let c = minCols; c <= Math.min(lastCol, columns); c++) {
        for (let r = rows; r <= lastRow; r++) {
            const past = c > maxCols || r > maxRows ? COST.stretch : 0;
            shapes.push([c, r, Math.abs(c - cols) * COST.col + (r - rows) * COST.row + past]);
        }
    }
    // (One wider than the grid: as wide as it, at what it costs.)
    if (shapes.length === 0)
        shapes.push([columns, rows, Math.abs(columns - cols) * COST.col]);
    return shapes.sort((a, b) => a[2] - b[2]);
}

// What a module costs on the other side: a column of it in the other half.
function sideCost(pane, col, cols, columns) {
    if (pane !== 0 && pane !== 1)
        return 0;
    let wrong = 0;
    for (let c = col; c < col + cols; c++) {
        if (pane === 0 ? c >= Math.ceil(columns / 2) : c < Math.floor(columns / 2))
            wrong++;
    }
    return wrong * COST.side;
}

// The least costly packing of a grid of so many columns and rows, cheaper
// than `best` (or null).
function search(modules, columns, rows, base, best, budget, stretched) {
    const n = modules.length;
    const shapes = modules.map(m => shapesOf(m, columns, stretched));
    const panes = modules.map(m => (m.pane === 0 || m.pane === 1 ? m.pane : 'any'));
    // (Alike: the same shapes, the same side – taken in their order.)
    const kinds = modules.map((_, i) => `${panes[i]}:${shapes[i].map(s => s.join('x')).join(',')}`);
    const before = modules.map((_, i) => {
        for (let j = i - 1; j >= 0; j--) {
            if (kinds[j] === kinds[i])
                return j;
        }
        return -1;
    });
    const minArea = shapes.map(s => Math.min(...s.map(([c, r]) => c * r)));
    const maxArea = shapes.map(s => Math.max(...s.map(([c, r]) => c * r)));
    const cells = new Int16Array(columns * rows).fill(-1);
    const placed = new Array(n).fill(null);
    let left = n;
    let leftMin = minArea.reduce((a, b) => a + b, 0);
    let leftMax = maxArea.reduce((a, b) => a + b, 0);
    let found = best;

    const fits = (index, c, r) => {
        const col = index % columns;
        const row = Math.floor(index / columns);
        if (col + c > columns || row + r > rows)
            return false;
        for (let y = row; y < row + r; y++) {
            for (let x = col; x < col + c; x++) {
                if (cells[y * columns + x] !== -1)
                    return false;
            }
        }
        return true;
    };
    const fill = (index, c, r, value) => {
        const col = index % columns;
        const row = Math.floor(index / columns);
        for (let y = row; y < row + r; y++)
            cells.fill(value, y * columns + col, y * columns + col + c);
    };

    const step = (from, cost, free) => {
        if (budget.steps-- <= 0)
            return;
        // (At least what cannot be filled stays empty.)
        const bound = cost + Math.max(0, free - leftMax) * COST.empty;
        if (found && bound >= found.cost)
            return;
        if (leftMin > free)
            return;
        let index = from;
        while (index < cells.length && cells[index] !== -1)
            index++;
        if (index >= cells.length) {
            if (left === 0) {
                found = {cost, columns, rows, placed: placed.map(p => ({...p}))};
            }
            return;
        }
        const col = index % columns;
        const row = Math.floor(index / columns);
        for (let i = 0; i < n; i++) {
            if (placed[i] || (before[i] >= 0 && !placed[before[i]]))
                continue;
            for (const [c, r, shapeCost] of shapes[i]) {
                if (!fits(index, c, r))
                    continue;
                fill(index, c, r, i);
                // (Those of its side listed after it, before it already.)
                let after = 0;
                for (let j = i + 1; j < n; j++) {
                    if (placed[j] && panes[j] === panes[i])
                        after++;
                }
                placed[i] = {id: modules[i].id, col, row, cols: c, rows: r};
                left--;
                leftMin -= minArea[i];
                leftMax -= maxArea[i];
                step(index + c, cost + shapeCost + sideCost(panes[i], col, c, columns) + after * COST.order,
                    free - c * r);
                left++;
                leftMin += minArea[i];
                leftMax += maxArea[i];
                placed[i] = null;
                fill(index, c, r, -1);
            }
        }
        // (Or nothing here.)
        cells[index] = n;
        step(index + 1, cost + COST.empty, free - 1);
        cells[index] = -1;
    };
    step(0, base, columns * rows);
    return found;
}

// Holes left (none found without, or the search cut short): a module
// beside one grows over it where it stays a rectangle.
function stretchOverHoles(placements, columns, rows) {
    const grid = Array.from({length: rows}, () => new Array(columns).fill(null));
    for (const p of placements) {
        for (let y = p.row; y < p.row + p.rows; y++) {
            for (let x = p.col; x < p.col + p.cols; x++)
                grid[y][x] = p;
        }
    }
    const free = (x1, x2, y1, y2) => {
        if (x1 < 0 || y1 < 0 || x2 > columns || y2 > rows)
            return false;
        for (let y = y1; y < y2; y++) {
            for (let x = x1; x < x2; x++) {
                if (grid[y][x])
                    return false;
            }
        }
        return true;
    };
    const take = (p, x1, x2, y1, y2) => {
        for (let y = y1; y < y2; y++) {
            for (let x = x1; x < x2; x++)
                grid[y][x] = p;
        }
    };
    let grown = true;
    while (grown) {
        grown = false;
        for (const p of placements) {
            const right = p.col + p.cols;
            const bottom = p.row + p.rows;
            if (free(right, right + 1, p.row, bottom)) {
                take(p, right, right + 1, p.row, bottom);
                p.cols++;
                grown = true;
            } else if (free(p.col - 1, p.col, p.row, bottom)) {
                take(p, p.col - 1, p.col, p.row, bottom);
                p.col--;
                p.cols++;
                grown = true;
            } else if (free(p.col, right, bottom, bottom + 1)) {
                take(p, p.col, right, bottom, bottom + 1);
                p.rows++;
                grown = true;
            } else if (free(p.col, right, p.row - 1, p.row)) {
                take(p, p.col, right, p.row - 1, p.row);
                p.row--;
                p.rows++;
                grown = true;
            }
        }
    }
    return grid.reduce((sum, line) => sum + line.filter(cell => !cell).length, 0);
}

const cache = new Map();

/**
 * Place the modules in a grid with no cell left empty: the packing of
 * least cost (COST), over grids of COLUMNS columns, or a few more or
 * fewer, as many rows as it takes, and fewer rows than columns.
 *
 * @param {ModuleRequest[]} modules - in their order
 * @param {object} [options]
 * @param {number} [options.columns] - as it is meant to be
 * @returns {{placements: Placement[], rows: number, columns: number, empty: number}}
 *   empty: the cells left empty (0 but where no module can grow over one)
 */
export function packModules(modules, {columns = COLUMNS} = {}) {
    const key = `${columns}|${modules.map(m => [m.id, m.cols, m.rows, m.minCols, m.maxCols, m.maxRows,
        m.pane].join(',')).join(';')}`;
    const known = cache.get(key);
    if (known)
        return structuredCopy(known);
    const result = pack(modules, columns);
    if (cache.size > 64)
        cache.clear();
    cache.set(key, result);
    return structuredCopy(result);
}

const structuredCopy = ({placements, rows, columns, empty}) =>
    ({placements: placements.map(p => ({...p})), rows, columns, empty});

function pack(modules, wanted) {
    if (modules.length === 0)
        return {placements: [], rows: 0, columns: wanted, empty: 0};
    // The grids, the likeliest first: columns near those wanted, as few
    // rows as the modules may fill, or one more.
    const sizes = [];
    for (let columns = 2; columns <= wanted + 4; columns++) {
        const all = modules.map(m => shapesOf(m, columns));
        const least = all.reduce((sum, s) => sum + Math.min(...s.map(([c, r]) => c * r)), 0);
        const tallest = Math.max(...all.map(s => Math.min(...s.map(([, r]) => r))));
        const first = Math.max(tallest, Math.ceil(least / columns));
        for (const rows of [first, first + 1]) {
            if (rows < columns)
                sizes.push({columns, rows, base: Math.abs(columns - wanted) * COST.width + (rows - first) * 0.5});
        }
    }
    sizes.sort((a, b) => a.base - b.base || b.columns - a.columns);
    // (Each grid half of the steps left, at least a few; then, where none
    // fills its grid, again with the modules stretched.)
    let best = null;
    for (const stretched of [false, true]) {
        if (best && emptyCells(best.placed, best.columns, best.rows) === 0)
            break;
        let steps = STEPS;
        for (const {columns, rows, base} of sizes.slice(0, SIZES)) {
            const budget = {steps: Math.max(Math.floor(steps / 2), 1000)};
            const given = budget.steps;
            best = search(modules, columns, rows, base, best, budget, stretched) ?? best;
            steps = Math.max(0, steps - (given - Math.max(0, budget.steps)));
        }
    }
    if (!best) {
        // (Not one found in time: each on a row of its own, as wide as the grid.)
        let row = 0;
        const placements = modules.map(m => {
            const [cols, rows] = shapesOf(m, wanted)[0];
            const p = {id: m.id, col: 0, row, cols, rows};
            row += rows;
            return p;
        });
        best = {columns: Math.max(wanted, ...placements.map(p => p.cols)), rows: row, placed: placements};
    }
    const placements = best.placed;
    const empty = stretchOverHoles(placements, best.columns, best.rows);
    for (const p of placements)
        p.pane = p.col + p.cols / 2 <= best.columns / 2 ? 0 : 1;
    // (In the modules' order.)
    const order = new Map(modules.map((m, i) => [m.id, i]));
    placements.sort((a, b) => order.get(a.id) - order.get(b.id));
    return {placements, rows: best.rows, columns: best.columns, empty};
}

/**
 * How many rows a module of some height needs.
 *
 * @param {number} height - in pixels
 * @param {number} [minRows]
 * @param {object} [size]
 * @param {number} [size.cell]
 * @param {number} [size.gap]
 * @returns {number}
 */
export function rowsFor(height, minRows = 1, {cell = CELL, gap = GAP} = {}) {
    return Math.max(minRows, Math.ceil((height + gap - 0.5) / (cell + gap)));
}

/**
 * The grid's placements in pixels.
 *
 * @param {Placement[]} placements
 * @param {object} [size]
 * @param {number} [size.cell]
 * @param {number} [size.gap]
 * @returns {{id: string, x: number, y: number, width: number, height: number}[]}
 */
export function rectsOf(placements, {cell = CELL, gap = GAP} = {}) {
    const step = cell + gap;
    return placements.map(({id, col, row, cols, rows}) => ({
        id,
        x: col * step,
        y: row * step,
        width: cols * step - gap,
        height: rows * step - gap,
    }));
}

/**
 * The size of a grid of so many rows.
 *
 * @param {number} rows
 * @param {object} [size]
 * @param {number} [size.cell]
 * @param {number} [size.gap]
 * @param {number} [size.columns]
 * @returns {[number, number]} width, height
 */
export function gridSize(rows, {cell = CELL, gap = GAP, columns = COLUMNS} = {}) {
    const step = cell + gap;
    return [Math.max(0, columns * step - gap), Math.max(0, rows * step - gap)];
}

/**
 * The cells of a grid no module covers (none, packed by packModules()).
 *
 * @param {Placement[]} placements
 * @param {number} columns
 * @param {number} rows
 * @returns {number}
 */
export function emptyCells(placements, columns, rows) {
    const taken = new Set();
    for (const {col, row, cols, rows: r} of placements) {
        for (let y = row; y < row + r; y++) {
            for (let x = col; x < col + cols; x++) {
                if (x < columns && y < rows)
                    taken.add(y * columns + x);
            }
        }
    }
    return columns * rows - taken.size;
}
