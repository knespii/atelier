import {lastWeeks, parseContributions, validUser} from '../lib/github.js';
import {parseLists, parseTasks} from '../lib/googleTasks.js';
import {
    DEFAULT_LAYOUT, PITCH, UNIT, cellAt, cellOrigin, cellsOf, findSpot, fitLayout, fits, gridSize, nearestSize,
    nearestSpot, newId, nextSize, parseLayout, pixelSize, placeAt, serializeLayout,
} from '../lib/widgets.js';
import {assert, assertEqual} from './util.js';

export function testSizesAndGrid() {
    assertEqual(pixelSize('square'), [2 * PITCH - 12, 2 * PITCH - 12]);
    assertEqual(pixelSize('card'), [4 * PITCH - 12, 2 * PITCH - 12]);
    assertEqual(pixelSize('nonsense'), pixelSize('square'), 'unknown sizes are squares');
    assertEqual(gridSize(1920, 1048), [19, 10]);
    assertEqual(cellOrigin(1, 2), [24 + PITCH, 24 + 2 * PITCH]);
    assertEqual(cellAt(24 + PITCH + UNIT / 3, 30), [1, 0], 'a drop snaps to the nearest cell');
    assertEqual(cellAt(-50, -50), [0, 0]);
}

export function testParseLayout() {
    const layout = parseLayout(JSON.stringify([
        {id: 'a', kind: 'clock', size: 'card', x: 1.4, y: 2},
        {id: 'a', kind: 'weather', size: 'large', x: -3, y: 'x'},
        {kind: 'toaster', x: 0, y: 0},
        {kind: 'photo', size: 'large', x: 5, y: 1, file: '/tmp/p.jpg'},
    ]));
    assertEqual(layout.map(e => [e.id, e.kind, e.size, e.x, e.y]), [
        ['a', 'clock', 'card', 1, 2],
        ['weather', 'weather', 'square', 0, 0],
        ['photo', 'photo', 'large', 5, 1],
    ], 'known kinds, sizes they come in, whole cells, unique ids');
    assertEqual(layout[2].file, '/tmp/p.jpg', 'options are kept');
    assertEqual(parseLayout('not json'), []);
    assertEqual(parseLayout('{"kind":"clock"}'), []);
    assertEqual(parseLayout(serializeLayout(DEFAULT_LAYOUT)), DEFAULT_LAYOUT);
}

export function testPlacing() {
    const grid = [8, 6];
    const layout = [{id: 'c', kind: 'calendar', size: 'large', x: 0, y: 0}];
    assert(!fits(layout, {id: 'n', size: 'square', x: 2, y: 2}, grid), 'not over another widget');
    assert(fits(layout, {id: 'n', size: 'square', x: 4, y: 0}, grid));
    assert(!fits(layout, {id: 'n', size: 'card', x: 6, y: 0}, grid), 'not past the edge');
    assert(fits(layout, {id: 'c', size: 'large', x: 1, y: 0}, grid), 'a widget never blocks itself');
    assertEqual(findSpot(layout, {id: 'n', size: 'card'}, grid), {x: 4, y: 0});
    assertEqual(findSpot(layout, {id: 'n', size: 'wide'}, [8, 4]), null, 'no room');

    const moved = fitLayout([
        {id: 'a', kind: 'clock', size: 'square', x: 0, y: 0},
        {id: 'b', kind: 'weather', size: 'square', x: 9, y: 0},
    ], [6, 4]);
    assertEqual(moved.map(e => [e.x, e.y]), [[0, 0], [4, 0]], 'a widget off a smaller screen goes to its edge');
    assertEqual(newId([{id: 'clock'}, {id: 'clock-2'}], 'clock'), 'clock-3');
    assertEqual(nextSize('clock', 'square'), 'card');
    assertEqual(nextSize('clock', 'card'), 'square');
}

export function testOtherScreens() {
    const big = [25, 13];
    const small = [13, 6];
    const layout = [
        {id: 'clock', kind: 'clock', size: 'square', x: 0, y: 0, grid: big},
        {id: 'date', kind: 'date', size: 'square', x: 2, y: 0, grid: big},
        {id: 'calendar', kind: 'calendar', size: 'large', x: 0, y: 2, grid: big},
        {id: 'github', kind: 'github', size: 'wide', x: 19, y: 0, grid: big},
        {id: 'photo', kind: 'photo', size: 'square', x: 23, y: 11, grid: big},
        {id: 'weather', kind: 'weather', size: 'square', x: 12, y: 6, grid: big},
    ];
    const where = shown => Object.fromEntries(shown.map(e => [e.id, [e.x, e.y]]));
    assertEqual(where(fitLayout(layout, big)), where(layout), 'on the screen they were placed on, as they were');
    const onSmall = {clock: [0, 0], date: [2, 0], calendar: [0, 2], github: [7, 0], photo: [11, 4], weather: [6, 2]};
    assertEqual(where(fitLayout(layout, small)), onSmall,
        'on a smaller one: near the same edges, those that touch together, the middle one in the middle');
    assertEqual(where(fitLayout(layout.map(({grid: _, ...e}) => e), small)), onSmall,
        'placed before grids were kept: as from a screen big enough for them');

    // Placed anew on the smaller screen: there, and on the bigger one again
    // where it was there.
    const moved = layout.map(e => (e.id === 'weather' ? placeAt(e, 9, 2, small) : e));
    assertEqual(moved[5].grid, small);
    assertEqual(moved[5].places, {'25x13': [12, 6]});
    assertEqual(where(fitLayout(moved, small)).weather, [9, 2]);
    assertEqual(where(fitLayout(moved, big)).weather, [12, 6]);

    // Placed on the smaller one first: on a bigger one, those that touch stay
    // together, near the same edges.
    const first = fitLayout(layout, small).map(e => ({...e, grid: small}));
    assertEqual(where(fitLayout(first, big)),
        {clock: [0, 0], date: [2, 0], calendar: [0, 2], github: [19, 0], photo: [23, 11], weather: [18, 2]});

    // Where others had them first, the free cells nearest to that.
    const crowded = [{id: 'k', kind: 'clock', size: 'square', x: 11, y: 0, grid: small}, ...layout];
    assertEqual(where(fitLayout(crowded, small)).github, [5, 0], 'taken: the free cells nearest to it');

    // A few other screens are remembered, the latest.
    let entry = {id: 'k', kind: 'clock', size: 'square', x: 0, y: 0, grid: [10, 5]};
    for (const [x, grid] of [[1, [11, 5]], [2, [12, 5]], [3, [13, 5]], [4, [14, 5]]])
        entry = placeAt(entry, x, 0, grid);
    assertEqual(Object.keys(entry.places), ['11x5', '12x5', '13x5']);
    assertEqual(parseLayout(serializeLayout([entry]))[0], entry, 'kept as they are');
    const odd = parseLayout(JSON.stringify([{kind: 'clock', grid: [0, 'x'], places: {'1x1': [0, 0], 'a': [1, 1], '2x2': [-1, 0]}}]));
    assertEqual([odd[0].grid, odd[0].places], [undefined, {'1x1': [0, 0]}], 'grids that make no sense are dropped');
}

export function testDraggingAndStretching() {
    const grid = [8, 6];
    const calendar = {id: 'c', kind: 'calendar', size: 'large', x: 0, y: 0};
    const clock = {id: 'k', kind: 'clock', size: 'square', x: 6, y: 0};
    const layout = [calendar, clock];
    assertEqual(nearestSpot(layout, clock, grid, 4.3, 2.6), {x: 4, y: 3}, 'dragged, it lands on the nearest cells');
    assertEqual(nearestSpot(layout, clock, grid, 1, 1), {x: 4, y: 1}, 'over another widget, beside it');
    assertEqual(nearestSpot(layout, clock, grid, 9, -3), {x: 6, y: 0}, 'past the edge, on the grid');
    const full = [{id: 'g', kind: 'github', size: 'wide', x: 0, y: 0}, {...clock, id: 'o'}];
    assertEqual(nearestSpot(full, {...clock, x: 3, y: 1}, [8, 2], 0, 0), {x: 3, y: 1},
        'where it was when it fits nowhere');

    assertEqual(cellsOf(pixelSize('card')[0]), 4);
    assertEqual(nearestSize(layout, {...clock, x: 4, y: 2}, grid, 3.6, 2.2), 'card', 'stretched, the nearest size');
    assertEqual(nearestSize(layout, {...clock, x: 4, y: 2}, grid, 2.4, 1.5), 'square');
    assertEqual(nearestSize(layout, clock, grid, 4, 2), 'square', 'only a size that fits where it is');
    assertEqual(nearestSize(layout, {id: 'p', kind: 'photo', size: 'square', x: 4, y: 2}, grid, 4.4, 3.8), 'large');
}

// A made-up page in the shape of GitHub's.
const PAGE = `
<h2 id="js-contribution-activity-description" class="f4 text-normal mb-2">
      1,204
      contributions
        in the last year
    </h2>
<table><tbody><tr>
<td tabindex="0" data-ix="0" style="width: 10px" data-date="2026-10-04" id="contribution-day-component-0-0" data-level="2" role="gridcell" class="ContributionCalendar-day"></td>
<td tabindex="0" data-ix="1" data-date="2026-09-27" data-level="0" class="ContributionCalendar-day"></td>
<td class="ContributionCalendar-label">Mon</td>
</tr><tr>
<td data-level="4" data-date="2026-10-05" class="ContributionCalendar-day"></td>
</tr></tbody></table>`;

export function testGithubContributions() {
    const parsed = parseContributions(PAGE);
    assertEqual(parsed.total, 1204);
    assertEqual(parsed.days, [
        {date: '2026-09-27', level: 0}, {date: '2026-10-04', level: 2}, {date: '2026-10-05', level: 4},
    ], 'days in order, whatever the order of the attributes');
    assertEqual(parseContributions('<html>Not Found</html>'), null);

    const weeks = lastWeeks(parsed.days, 2);
    assertEqual(weeks.length, 2);
    assertEqual(weeks[0][0], 0, 'Sunday the 27th starts the first week');
    assertEqual(weeks[1].slice(0, 3), [2, 4, null], 'the last week up to its last day');
    assert(validUser('octo-cat') && !validUser('-bad') && !validUser('a b') && !validUser(''));
}

export function testGoogleTasks() {
    assertEqual(parseLists('{"items":[{"id":"L1","title":"My Tasks"},{"title":"no id"}]}'),
        [{id: 'L1', title: 'My Tasks'}]);
    const tasks = parseTasks(JSON.stringify({items: [
        {id: 'a', title: 'Later', position: '002'},
        {id: 'b', title: 'Due Friday', due: '2026-10-09T00:00:00.000Z', position: '003'},
        {id: 'c', title: 'Done', status: 'completed'},
        {id: 'd', title: '   ', position: '000'},
        {id: 'e', title: 'Due Wednesday', due: '2026-10-07T00:00:00.000Z', position: '004'},
        {id: 'f', title: 'First', position: '001'},
    ]}));
    assertEqual(tasks.map(t => t.id), ['e', 'b', 'f', 'a'], 'due ones first, then in the list\'s order');
    assert(tasks[0].due instanceof Date);
    assertEqual(parseTasks('{}'), []);
}
