import {shouldHide, windowCovers} from '../lib/dockVisibility.js';
import {assert, assertEqual} from './util.js';

const KEYS = ['overview', 'fixed', 'manual', 'autohide', 'intellihide', 'overlapped', 'forced', 'hover',
    'revealed', 'fullscreen', 'urgent'];

// A state with the named keys on, the rest off.
const state = (...on) => Object.fromEntries(KEYS.map(key => [key, on.includes(key)]));

export function testShouldHideAtRest() {
    assert(!shouldHide(state()), 'nothing going on: shown');
    assert(!shouldHide(state('intellihide')), 'out of the way of windows, none covering: shown');
    assert(shouldHide(state('intellihide', 'overlapped')), 'and covered: away');
    assert(!shouldHide(state('overlapped')), 'covered, but not out of the way of windows: shown');
    assert(shouldHide(state('autohide')), 'hiding when the pointer leaves, the pointer away: away');
    assert(shouldHide(state('manual')), 'hidden until called: away');
}

export function testShouldHideOverviewAndFixed() {
    for (const others of [[], ['fixed'], ['hover', 'revealed', 'forced', 'urgent']])
        assert(shouldHide(state('overview', ...others)), `the overview takes it away (${others.join(', ')})`);
    for (const others of [['manual'], ['autohide'], ['intellihide', 'overlapped'], ['fullscreen']])
        assert(!shouldHide(state('fixed', ...others)), `always visible stays (${others.join(', ')})`);
}

export function testShouldHideKept() {
    for (const keep of ['forced', 'hover', 'revealed', 'urgent']) {
        for (const why of [['manual'], ['autohide'], ['intellihide', 'overlapped'], ['fullscreen'],
            ['intellihide', 'fullscreen']])
            assert(!shouldHide(state(keep, ...why)), `${keep} keeps it (${why.join(', ')})`);
    }
}

export function testShouldHideTogether() {
    // Out of the way of windows comes first: hiding when the pointer leaves
    // only adds that it then stays while the pointer is on it.
    assert(!shouldHide(state('intellihide', 'autohide')), 'both, nothing covering: shown');
    assert(shouldHide(state('intellihide', 'autohide', 'overlapped')), 'both, covered: away');
    assert(!shouldHide(state('intellihide', 'autohide', 'overlapped', 'hover')), 'the pointer on it: shown');
    assert(shouldHide(state('manual', 'intellihide')), 'hidden until called, nothing covering: away');
}

export function testShouldHideFullscreen() {
    assert(shouldHide(state('fullscreen')), 'a window fills the screen: away');
    assert(shouldHide(state('intellihide', 'fullscreen')), 'out of the way of windows too');
    assert(shouldHide(state('autohide', 'fullscreen')), 'hiding when the pointer leaves too');
}

const DOCK = {x: 600, y: 1000, width: 720, height: 70};
const over = {x: 500, y: 600, width: 800, height: 450};
const window = (extra = {}) => ({
    rect: over, appId: 'a', monitorIndex: 0, minimized: false, onWorkspace: true, showing: true,
    maximizedHorizontally: false, maximizedVertically: false, fullscreen: false, above: false, ...extra,
});
const ctx = (extra = {}) => ({rect: DOCK, focusAppId: 'a', topAppId: 'a', halfMonitor: -1, ...extra});
const MODES = ['ALL_WINDOWS', 'FOCUS_APPLICATION_WINDOWS', 'MAXIMIZED_WINDOWS', 'ALWAYS_ON_TOP'];
const covers = (win, context = ctx()) => MODES.filter(mode => windowCovers(mode, win, context));

export function testWindowCoversFocusedApp() {
    assertEqual(covers(window()), ['ALL_WINDOWS', 'FOCUS_APPLICATION_WINDOWS'], 'the focused app\'s window');
    assertEqual(covers(window({appId: 'b'})), ['ALL_WINDOWS'], 'another app\'s');
    assertEqual(covers(window({appId: 'b'}), ctx({topAppId: 'b'})), ['ALL_WINDOWS', 'FOCUS_APPLICATION_WINDOWS'],
        'the app on top on the dock\'s monitor');
    assertEqual(covers(window(), ctx({focusAppId: null, topAppId: 'a'})), ['ALL_WINDOWS'],
        'no app has the focus: none of the focused app');
}

export function testWindowCoversMaximized() {
    assertEqual(covers(window({maximizedHorizontally: true, maximizedVertically: true})),
        ['ALL_WINDOWS', 'FOCUS_APPLICATION_WINDOWS', 'MAXIMIZED_WINDOWS'], 'maximized');
    assertEqual(covers(window({appId: 'b', maximizedHorizontally: true, maximizedVertically: true})),
        ['ALL_WINDOWS', 'MAXIMIZED_WINDOWS'], 'maximized, another app');
    assertEqual(covers(window({appId: 'b', fullscreen: true})), MODES.filter(m => m !== 'FOCUS_APPLICATION_WINDOWS'),
        'full screen, another app: also always on top');
    assertEqual(covers(window({fullscreen: true})), MODES, 'full screen, the focused app: every mode');
}

export function testWindowCoversAboveAndSideBySide() {
    assertEqual(covers(window({appId: 'b', above: true})), ['ALL_WINDOWS', 'FOCUS_APPLICATION_WINDOWS'],
        'another app\'s, kept on top');
    const half = {appId: 'b', maximizedVertically: true};
    assertEqual(covers(window(half), ctx({halfMonitor: 0})),
        ['ALL_WINDOWS', 'FOCUS_APPLICATION_WINDOWS', 'MAXIMIZED_WINDOWS'],
        'another app\'s, maximized beside the focused window');
    assertEqual(covers(window(half), ctx({halfMonitor: 1})), ['ALL_WINDOWS', 'MAXIMIZED_WINDOWS'],
        'beside it, but on another monitor');
    assertEqual(covers(window(half)), ['ALL_WINDOWS', 'MAXIMIZED_WINDOWS'], 'the focused window not maximized half');
}

export function testWindowCoversNotThere() {
    const fullscreen = {fullscreen: true};
    assertEqual(covers(window({...fullscreen, minimized: true})), [], 'minimized');
    assertEqual(covers(window({...fullscreen, onWorkspace: false})), [], 'on another workspace');
    assertEqual(covers(window({...fullscreen, showing: false})), [], 'not shown');
    assertEqual(covers(window({...fullscreen, rect: {x: 600, y: 100, width: 700, height: 899}})), [],
        'above the dock, not over it (touching isn\'t)');
    assertEqual(covers(window({...fullscreen, monitorIndex: 1, rect: {x: 1920, y: 0, width: 1280, height: 1024}})),
        [], 'on another monitor');
    assertEqual(covers(window(fullscreen), ctx({rect: null})), [], 'the dock not placed yet');
}

export function testShouldHideInOverview() {
    assert(!shouldHide({overview: true, inOverview: true}), 'in place of the dash, it stays in the overview');
    assert(!shouldHide({overview: true, inOverview: true, autohide: true, overlapped: true, intellihide: true}),
        'whatever else would take it away');
    assert(shouldHide({overview: true, inOverview: false}), 'otherwise it goes');
}
