// Where the control centre's modules go: a grid of square cells in two
// panes of four columns side by side (wider than tall, as macOS's Control
// Center would be with its two columns of modules next to each other).
// Each module asks for so many columns and rows and for a pane; one that
// may go anywhere (an extension's toggle) goes where the panes end up the
// shortest. Pure, for the unit tests.

export const COLUMNS = 4;
export const PANES = 2;
// Logical pixels: a cell's side, the gap between cells (and between panes).
export const CELL = 80;
export const GAP = 10;

/**
 * @typedef {object} ModuleRequest
 * @property {string} id
 * @property {number} cols - 1 to COLUMNS
 * @property {number} rows - at least 1
 * @property {number|string} [pane] - 0, 1, or 'any' (the default)
 */

/**
 * @typedef {object} Placement
 * @property {string} id
 * @property {number} pane
 * @property {number} col - in its pane
 * @property {number} row
 * @property {number} cols
 * @property {number} rows
 */

class Pane {
    constructor(columns) {
        this.columns = columns;
        this.cells = [];
    }

    _free(row, col, cols, rows) {
        for (let r = row; r < row + rows; r++) {
            for (let c = col; c < col + cols; c++) {
                if (this.cells[r]?.[c])
                    return false;
            }
        }
        return true;
    }

    // The first place, row by row, left to right, it fits in.
    find(cols, rows) {
        for (let row = 0; ; row++) {
            for (let col = 0; col + cols <= this.columns; col++) {
                if (this._free(row, col, cols, rows))
                    return {row, col};
            }
        }
    }

    take(row, col, cols, rows) {
        for (let r = row; r < row + rows; r++) {
            this.cells[r] ??= [];
            for (let c = col; c < col + cols; c++)
                this.cells[r][c] = true;
        }
    }

    get height() {
        return this.cells.length;
    }
}

/**
 * Place modules, in their order, each where it first fits.
 *
 * @param {ModuleRequest[]} modules
 * @param {object} [options]
 * @param {number} [options.columns] - per pane
 * @param {number} [options.panes]
 * @returns {{placements: Placement[], rows: number}} rows: of the taller pane
 */
export function packModules(modules, {columns = COLUMNS, panes = PANES} = {}) {
    const grid = Array.from({length: Math.max(1, panes)}, () => new Pane(columns));
    const placements = [];
    for (const module of modules) {
        const cols = Math.max(1, Math.min(columns, Math.round(module.cols) || 1));
        const rows = Math.max(1, Math.round(module.rows) || 1);
        const wanted = Number.isInteger(module.pane) && module.pane >= 0 && module.pane < grid.length
            ? [module.pane] : grid.map((_, i) => i);
        let best = null;
        for (const pane of wanted) {
            const {row, col} = grid[pane].find(cols, rows);
            const bottom = Math.max(grid[pane].height, row + rows);
            // (The pane that stays the shortest, then the higher place,
            // then the first pane.)
            if (!best || bottom < best.bottom || (bottom === best.bottom && row < best.row))
                best = {pane, row, col, bottom};
        }
        grid[best.pane].take(best.row, best.col, cols, rows);
        placements.push({id: module.id, pane: best.pane, col: best.col, row: best.row, cols, rows});
    }
    return {placements, rows: Math.max(0, ...grid.map(pane => pane.height))};
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
 * @param {number} [size.columns] - per pane
 * @returns {{id: string, x: number, y: number, width: number, height: number}[]}
 */
export function rectsOf(placements, {cell = CELL, gap = GAP, columns = COLUMNS} = {}) {
    const step = cell + gap;
    return placements.map(({id, pane, col, row, cols, rows}) => ({
        id,
        x: (pane * columns + col) * step,
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
 * @param {number} [size.columns] - per pane
 * @param {number} [size.panes]
 * @returns {[number, number]} width, height
 */
export function gridSize(rows, {cell = CELL, gap = GAP, columns = COLUMNS, panes = PANES} = {}) {
    const step = cell + gap;
    return [panes * columns * step - gap, Math.max(0, rows * step - gap)];
}
