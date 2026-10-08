// Tests for lib/dockActions.js: which action a click picks, and what every
// action comes to for the app's windows as they are.

import {pickAction, plan} from '../lib/dockActions.js';
import {assert, assertEqual} from './util.js';

const ACTIONS = ['skip', 'minimize', 'launch', 'cycle-windows', 'minimize-or-overview', 'appspread',
    'minimize-or-appspread', 'focus-or-appspread', 'focus-minimize-or-appspread', 'quit'];

const KINDS = {
    A: 'activate', M: 'minimize-all', C: 'cycle', S: 'spread', O: 'overview', Q: 'quit', N: 'new-window',
};

// For a plain click on an app that can open more windows: the steps with
// one window, then with three, each for [in the background, in the
// background all minimized, focused, focused (and all minimized, which
// can't be, but says what it would do)].
const EXPECTED = {
    'skip': ['AAAA', 'AAAA'],
    'minimize': ['AAMA', 'AAMA'],
    'launch': ['NNNN', 'NNNN'],
    'cycle-windows': ['AAMM', 'AACC'],
    'minimize-or-overview': ['AAMM', 'OOOO'],
    'appspread': ['AAAA', 'SSSS'],
    'minimize-or-appspread': ['AAMM', 'SSSS'],
    'focus-or-appspread': ['AAAA', 'AASS'],
    'focus-minimize-or-appspread': ['AAMM', 'AASS'],
    'quit': ['QQQQ', 'QQQQ'],
};

const STATES = [[false, false], [false, true], [true, false], [true, true]]; // [focused, minimizedAll]

export function testPickAction() {
    const settings = {
        'click-action': 'cycle-windows',
        'shift-click-action': 'minimize',
        'middle-click-action': 'launch',
        'shift-middle-click-action': 'quit',
    };
    const get = key => settings[key];
    assertEqual(pickAction(get, 1, false), 'cycle-windows', 'a click');
    assertEqual(pickAction(get, 1, true), 'minimize', 'Shift and a click');
    assertEqual(pickAction(get, 2, false), 'launch', 'the middle button');
    assertEqual(pickAction(get, 2, true), 'quit', 'Shift and the middle button');
    // (Button 3 opens the menu; anything else counts as a click.)
    assertEqual(pickAction(get, 3, false), 'cycle-windows');
    assertEqual(pickAction(get, 3, true), 'minimize');
    // Every action can be picked for every button.
    for (const action of ACTIONS) {
        for (const button of [1, 2]) {
            for (const shift of [false, true])
                assertEqual(pickAction(() => action, button, shift), action, `${action}, ${button}, ${shift}`);
        }
    }
}

export function testWithoutWindowsTheAppOpens() {
    for (const action of [...ACTIONS, 'unknown']) {
        for (const [focused, minimizedAll] of STATES) {
            for (const plain of [true, false]) {
                assertEqual(plan(action, {windows: 0, focusedIndex: focused ? 0 : -1, minimizedAll, canNew: true, plain}),
                    {kind: 'launch'}, action);
            }
        }
    }
}

export function testEveryAction() {
    for (const action of ACTIONS) {
        [1, 3].forEach((windows, row) => {
            STATES.forEach(([focused, minimizedAll], column) => {
                const step = plan(action, {windows, focusedIndex: focused ? 0 : -1, minimizedAll, canNew: true});
                const expected = KINDS[EXPECTED[action][row][column]];
                assertEqual(step.kind, expected,
                    `${action}, ${windows} windows, ${focused ? 'focused' : 'background'}${minimizedAll ? ', minimized' : ''}`);
            });
        });
    }
    assertEqual(plan('unknown', {windows: 2}), {kind: 'none'}, 'an action it doesn\'t know');
}

// The default, as a click always was: the latest window up, minimized when
// it is up and alone, else on to the next one.
export function testTheDefaultAsBefore() {
    const state = {canNew: true, singleActivates: true};
    assertEqual(plan('cycle-windows', {...state, windows: 1, focusedIndex: -1}), {kind: 'activate', all: false});
    assertEqual(plan('cycle-windows', {...state, windows: 1, focusedIndex: 0}), {kind: 'minimize-all', latest: false});
    assertEqual(plan('cycle-windows', {...state, windows: 2, focusedIndex: 0}), {kind: 'cycle', from: 0});
    assertEqual(plan('cycle-windows', {...state, windows: 2, focusedIndex: 1}), {kind: 'cycle', from: 1});
    assertEqual(plan('cycle-windows', {...state, windows: 2, focusedIndex: -1, minimizedAll: true}),
        {kind: 'activate', all: false});
    // The middle button opens a new window, and when the app can't, does
    // what a click does.
    assertEqual(plan('launch', {...state, windows: 2, focusedIndex: 0}), {kind: 'new-window'});
    for (const [focused, minimizedAll] of STATES) {
        for (const windows of [1, 3]) {
            const params = {windows, focusedIndex: focused ? 0 : -1, minimizedAll, singleActivates: true};
            assertEqual(plan('launch', {...params, canNew: false}), plan('cycle-windows', params),
                `launch without new windows, ${windows}, ${focused}, ${minimizedAll}`);
        }
    }
}

export function testAllWindowsOrTheLatest() {
    for (const action of ['skip', 'cycle-windows', 'focus-or-appspread']) {
        assertEqual(plan(action, {windows: 2, singleActivates: true}), {kind: 'activate', all: false}, action);
        assertEqual(plan(action, {windows: 2, singleActivates: false}), {kind: 'activate', all: true}, action);
    }
    // Minimize in the background brings all of them up, as in Dash to Dock.
    assertEqual(plan('minimize', {windows: 2, singleActivates: true}), {kind: 'activate', all: true});
}

// Shift or the middle button: the actions that are about one window do
// more, the minimizing ones less.
export function testNotAPlainClick() {
    const background = {windows: 1, focusedIndex: -1, plain: false};
    const focused = {windows: 1, focusedIndex: 0, plain: false};
    assertEqual(plan('minimize', background), {kind: 'minimize-all', latest: true},
        'minimize: also in the background, the latest window');
    assertEqual(plan('minimize', {...background, minimizedAll: true}), {kind: 'activate', all: true},
        'and brings them up when all are minimized');
    assertEqual(plan('minimize', {...focused, windows: 3}), {kind: 'minimize-all', latest: true});
    assertEqual(plan('minimize-or-overview', focused).kind, 'overview');
    assertEqual(plan('appspread', background).kind, 'spread');
    assertEqual(plan('minimize-or-appspread', focused).kind, 'spread');
    assertEqual(plan('focus-or-appspread', {...focused, windows: 3}).kind, 'activate');
    assertEqual(plan('focus-minimize-or-appspread', {...focused, windows: 3}), {kind: 'minimize-all', latest: true});
    assertEqual(plan('focus-minimize-or-appspread', {...background, windows: 3}).kind, 'activate');
    assertEqual(plan('cycle-windows', {...focused, windows: 3}).kind, 'cycle', 'cycling is the same');
}

export function testEveryStepKnown() {
    const kinds = new Set(['launch', 'activate', 'minimize-all', 'cycle', 'spread', 'overview', 'quit', 'new-window', 'none']);
    for (const action of ACTIONS) {
        for (const windows of [0, 1, 2, 5]) {
            for (let focusedIndex = -1; focusedIndex < windows; focusedIndex++) {
                for (const plain of [true, false]) {
                    for (const canNew of [true, false]) {
                        const step = plan(action, {windows, focusedIndex, canNew, plain});
                        assert(kinds.has(step.kind), `${action}: ${step.kind}`);
                    }
                }
            }
        }
    }
}
