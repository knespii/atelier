import {CELL, GAP, gridSize, packModules, rectsOf, rowsFor} from '../lib/controlGrid.js';
import {assert, assertEqual} from './util.js';

// The control centre as on a laptop: connectivity, Now Playing, Do Not
// Disturb; then brightness and volume as capsules, the squares beside
// them, the system buttons.
const LAPTOP = [
    {id: 'connectivity', cols: 2, rows: 3, pane: 0},
    {id: 'media', cols: 2, rows: 2, pane: 0},
    {id: 'dnd', cols: 2, rows: 1, pane: 0},
    {id: 'brightness', cols: 1, rows: 2, pane: 1},
    {id: 'volume', cols: 1, rows: 2, pane: 1},
    {id: 'dark', cols: 1, rows: 1, pane: 1},
    {id: 'night', cols: 1, rows: 1, pane: 1},
    {id: 'power', cols: 1, rows: 1, pane: 1},
    {id: 'system', cols: 4, rows: 1, pane: 1},
];

const at = (placements, id) => {
    const p = placements.find(q => q.id === id);
    return p ? [p.pane, p.col, p.row, p.cols, p.rows] : null;
};

export function testMacLikeLayout() {
    const {placements, rows} = packModules(LAPTOP);
    assertEqual(at(placements, 'connectivity'), [0, 0, 0, 2, 3], 'connectivity: the left of the first pane');
    assertEqual(at(placements, 'media'), [0, 2, 0, 2, 2], 'Now Playing: top right of it');
    assertEqual(at(placements, 'dnd'), [0, 2, 2, 2, 1], 'Do Not Disturb under Now Playing');
    assertEqual(at(placements, 'brightness'), [1, 0, 0, 1, 2], 'brightness: the second pane\'s top left');
    assertEqual(at(placements, 'volume'), [1, 1, 0, 1, 2], 'volume beside it');
    assertEqual(at(placements, 'dark'), [1, 2, 0, 1, 1], 'Dark Style beside them');
    assertEqual(at(placements, 'night'), [1, 3, 0, 1, 1], 'Night Light beside it');
    assertEqual(at(placements, 'power'), [1, 2, 1, 1, 1], 'Power Mode under Dark Style');
    assertEqual(at(placements, 'system'), [1, 0, 2, 4, 1], 'then the system buttons');
    assertEqual(rows, 3, 'three rows');
    const [width, height] = gridSize(rows);
    assert(width > 2 * height, `wider than tall (${width} × ${height})`);
}

export function testExtensionsOverflow() {
    const extensions = ['caffeine', 'one', 'two', 'three', 'four', 'five', 'six']
        .map(id => ({id, cols: 1, rows: 1, pane: 'any'}));
    const {placements, rows} = packModules([...LAPTOP, ...extensions]);
    assertEqual(at(placements, 'caffeine'), [1, 3, 1, 1, 1], 'the first beside Power Mode');
    for (const [i, id] of ['one', 'two', 'three', 'four'].entries())
        assertEqual(at(placements, id), [0, i, 3, 1, 1], `${id}: a square under the first pane`);
    assertEqual(at(placements, 'five'), [1, 0, 3, 1, 1], 'then under the system buttons');
    assertEqual(rows, 4, 'one more row for those');
    const all = placements.map(p => `${p.id}@${p.pane}:${p.col},${p.row}`);
    assertEqual(new Set(all).size, all.length, 'none dropped');
    assertEqual(placements.length, LAPTOP.length + extensions.length, 'every module placed');
}

export function testNoOverlap() {
    const modules = [...LAPTOP, {id: 'wide', cols: 4, rows: 1}, {id: 'x', cols: 1, rows: 2},
        {id: 'y', cols: 3, rows: 1}, {id: 'z', cols: 9, rows: 0}];
    const {placements} = packModules(modules);
    const taken = new Set();
    for (const p of placements) {
        assert(p.col + p.cols <= 4 && p.cols >= 1 && p.rows >= 1, `${p.id} within its pane`);
        for (let r = p.row; r < p.row + p.rows; r++) {
            for (let c = p.col; c < p.col + p.cols; c++) {
                const key = `${p.pane}:${c},${r}`;
                assert(!taken.has(key), `${p.id} overlaps at ${key}`);
                taken.add(key);
            }
        }
    }
    assertEqual(at(placements, 'z').slice(3), [4, 1], 'too wide or flat: clamped');
}

export function testDesktopWithoutModules() {
    // No battery, no brightness, no Wi-Fi: what there is still packs.
    const {placements, rows} = packModules([
        {id: 'media', cols: 2, rows: 2, pane: 0},
        {id: 'dark', cols: 1, rows: 1, pane: 0},
        {id: 'volume', cols: 1, rows: 2, pane: 1},
    ]);
    assertEqual(at(placements, 'media'), [0, 0, 0, 2, 2]);
    assertEqual(at(placements, 'dark'), [0, 2, 0, 1, 1], 'beside it');
    assertEqual(rows, 2);
    assertEqual(packModules([]).rows, 0, 'nothing: no rows');
}

export function testPixels() {
    const {placements} = packModules(LAPTOP);
    const rects = rectsOf(placements);
    const step = CELL + GAP;
    const volume = rects.find(r => r.id === 'volume');
    assertEqual([volume.x, volume.y, volume.width, volume.height], [5 * step, 0, CELL, 2 * step - GAP]);
    const system = rects.find(r => r.id === 'system');
    assertEqual([system.x, system.y, system.width, system.height], [4 * step, 2 * step, 4 * step - GAP, CELL]);
    const connectivity = rects.find(r => r.id === 'connectivity');
    assertEqual([connectivity.width, connectivity.height], [2 * step - GAP, 3 * step - GAP]);
    assertEqual(rowsFor(CELL), 1, 'a cell\'s height: one row');
    assertEqual(rowsFor(CELL + 1), 2, 'a pixel more: two');
    assertEqual(rowsFor(10, 3), 3, 'at least as asked');
    assertEqual(gridSize(4), [8 * step - GAP, 4 * step - GAP]);
}
