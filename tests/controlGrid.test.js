import {CELL, COLUMNS, GAP, emptyCells, gridSize, packModules, rectsOf, rowsFor} from '../lib/controlGrid.js';
import {assert, assertEqual} from './util.js';

// The modules as shell/controlCentre/host.js asks for them.
const conn = rows => ({id: 'connectivity', cols: 2, rows, maxRows: rows + 2, pane: 0});
const MEDIA = {id: 'media', cols: 2, rows: 2, maxRows: 3, maxCols: 3, pane: 0};
const FOCUS = {id: 'focus', cols: 2, rows: 1, maxCols: 4, pane: 0};
const capsule = id => ({id, cols: 1, rows: 2, maxRows: 3, pane: 1});
const square = (id, pane = 1) => ({id, cols: 1, rows: 1, pane});
const SYSTEM = {id: 'system', cols: 4, rows: 1, minCols: 3, maxCols: 8, pane: 1};
const FOOTER = {id: 'footer', cols: 4, rows: 1, minCols: 2, maxCols: 8, pane: 'any'};
const extension = i => ({id: `extension-${i}`, cols: 1, rows: 1, pane: 'any'});
const wideExtension = i => ({id: `wide-${i}`, cols: 4, rows: 1, minCols: 3, maxCols: 8, pane: 'any'});

// The control centre as on a laptop: Wi-Fi, Bluetooth, Airplane Mode, Now
// Playing, Do Not Disturb; brightness and volume, Dark Style, Night Light,
// Power Mode, the system buttons.
const LAPTOP = [conn(3), MEDIA, FOCUS, capsule('brightness'), capsule('volume'), square('dark'), square('night'),
    square('power-mode'), SYSTEM];

const at = (placements, id) => {
    const p = placements.find(q => q.id === id);
    return p ? [p.col, p.row, p.cols, p.rows] : null;
};

// Every module placed once, within the grid, none over another, no cell
// left empty, fewer rows than columns.
function assertPacked(modules, packed, name) {
    const {placements, rows, columns, empty} = packed;
    assertEqual(placements.map(p => p.id).sort(), modules.map(m => m.id).sort(), `${name}: every module placed`);
    const taken = new Set();
    for (const p of placements) {
        assert(p.col >= 0 && p.row >= 0 && p.col + p.cols <= columns && p.row + p.rows <= rows,
            `${name}: ${p.id} within the grid`);
        const module = modules.find(m => m.id === p.id);
        assert(p.cols >= (module.minCols ?? module.cols) && p.rows >= module.rows,
            `${name}: ${p.id} no smaller than it can be (${p.cols} × ${p.rows})`);
        for (let y = p.row; y < p.row + p.rows; y++) {
            for (let x = p.col; x < p.col + p.cols; x++) {
                assert(!taken.has(`${x},${y}`), `${name}: ${p.id} over another at ${x},${y}`);
                taken.add(`${x},${y}`);
            }
        }
    }
    assertEqual(empty, 0, `${name}: no cell left empty`);
    assertEqual(emptyCells(placements, columns, rows), 0, `${name}: no cell left empty, counted`);
    assert(rows < columns, `${name}: wider than tall (${columns} × ${rows})`);
}

export function testLaptop() {
    const packed = packModules(LAPTOP);
    assertPacked(LAPTOP, packed, 'laptop');
    const {placements, rows, columns} = packed;
    assertEqual([columns, rows], [COLUMNS, 3], 'eight columns, three rows');
    assertEqual(at(placements, 'connectivity'), [0, 0, 2, 3], 'connectivity: the left of it');
    for (const id of ['connectivity', 'media'])
        assert(placements.find(p => p.id === id).pane === 0, `${id} on the left`);
    for (const id of ['brightness', 'volume', 'dark', 'night', 'power-mode', 'system'])
        assert(placements.find(p => p.id === id).pane === 1, `${id} on the right`);
    const [bx, by] = at(placements, 'brightness');
    assertEqual(at(placements, 'volume').slice(0, 2), [bx + 1, by], 'the volume beside the brightness');
    const [width, height] = gridSize(rows, {columns});
    assert(width > 2 * height, `wider than tall (${width} × ${height})`);
}

export function testNoHoleBesideNightLight() {
    // The keyboard's backlight, or an extension's square (Caffeine): in
    // the cell beside Night Light that was left empty.
    for (const extra of [square('keyboard'), extension(0)]) {
        const modules = [...LAPTOP.slice(0, 8), extra, SYSTEM];
        const packed = packModules(modules);
        assertPacked(modules, packed, extra.id);
        assertEqual([packed.columns, packed.rows], [COLUMNS, 3], `${extra.id}: as compact`);
        assert(packed.placements.every(p => p.id !== 'focus' || p.cols === 2) &&
            at(packed.placements, 'system')[2] === 4, `${extra.id}: none grown (an exact fill)`);
    }
}

// Many sets of tiles, as machines and extensions have them: none leaves a
// cell empty.
export function testManySets() {
    let sets = 0;
    let slowest = 0;
    for (const rows of [0, 1, 2, 3, 4]) {
        for (const capsules of [0, 1, 2, 3]) {
            for (const squares of [0, 1, 2, 3, 4]) {
                for (const extensions of [0, 1, 2, 3, 5, 7]) {
                    // (A few of the rest, varied with the others.)
                    const n = rows + capsules + squares + extensions;
                    const focus = n % 2 === 0;
                    const system = n % 3 !== 1;
                    const footer = n % 4 === 3;
                    const wide = n % 5 === 4;
                    const modules = [
                        ...rows ? [conn(rows)] : [],
                        MEDIA,
                        ...focus ? [FOCUS] : [],
                        ...['brightness', 'volume', 'microphone'].slice(0, capsules).map(capsule),
                        ...['dark', 'night', 'power-mode', 'keyboard'].slice(0, squares).map(id => square(id)),
                        ...system ? [SYSTEM] : [],
                        ...footer ? [FOOTER] : [],
                        ...Array.from({length: extensions}, (_, i) => extension(i)),
                        ...wide ? [wideExtension(0)] : [],
                    ];
                    const t = Date.now();
                    const packed = packModules(modules);
                    slowest = Math.max(slowest, Date.now() - t);
                    assertPacked(modules, packed, JSON.stringify({rows, capsules, squares, extensions, focus, system,
                        footer, wide}));
                    sets++;
                }
            }
        }
    }
    assertEqual(sets, 600);
    assert(slowest < 400, `each packed soon enough (the slowest ${slowest} ms)`);
}

export function testExtensionsWhereThereIsRoom() {
    const extensions = [0, 1, 2, 3, 4, 5].map(extension);
    const modules = [...LAPTOP, ...extensions];
    const packed = packModules(modules);
    assertPacked(modules, packed, 'six extensions');
    assertEqual(at(packed.placements, 'connectivity').slice(0, 2), [0, 0], 'connectivity still top left');
}

export function testFallbackStretches() {
    // A module that may not grow, alone with one too wide to share a row:
    // where no packing fills the grid, its neighbour grows over the hole.
    const modules = [{id: 'tall', cols: 1, rows: 3, pane: 0}, {id: 'odd', cols: 3, rows: 2, pane: 1}];
    const packed = packModules(modules);
    assertEqual(packed.empty, 0, 'no hole shows');
    assertEqual(emptyCells(packed.placements, packed.columns, packed.rows), 0, 'none, counted');
    assertEqual(packModules([]).rows, 0, 'nothing: no rows');
}

export function testSameAgain() {
    const a = packModules(LAPTOP);
    a.placements[0].col = 99;
    assertEqual(packModules(LAPTOP).placements[0].col, 0, 'the same packing again, not changed by its user');
}

export function testPixels() {
    const {placements, columns} = packModules(LAPTOP);
    const rects = rectsOf(placements);
    const step = CELL + GAP;
    const p = placements.find(q => q.id === 'volume');
    const volume = rects.find(r => r.id === 'volume');
    assertEqual([volume.x, volume.y, volume.width, volume.height],
        [p.col * step, p.row * step, p.cols * step - GAP, p.rows * step - GAP]);
    assertEqual(rowsFor(CELL), 1, 'a cell\'s height: one row');
    assertEqual(rowsFor(CELL + 1), 2, 'a pixel more: two');
    assertEqual(rowsFor(10, 3), 3, 'at least as asked');
    assertEqual(gridSize(4, {columns}), [columns * step - GAP, 4 * step - GAP]);
}
