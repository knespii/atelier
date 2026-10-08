import {
    DEFAULT_ALPHAS, backgroundCss, dynamicAlpha, dynamicAlphas, grownRect, parseColor, windowNear,
} from '../lib/dockTheme.js';
import {GLASS_FULL, glassShare} from '../lib/seeThrough.js';
import {assert, assertEqual} from './util.js';

export function testDefaultHasNoStyle() {
    for (const glass of [false, true]) {
        assertEqual(backgroundCss({mode: 'DEFAULT', opacity: 0.3, alpha: 0.5, color: '#ff0000', glass}), '',
            `the stylesheet's look (glass ${glass})`);
    }
    assertEqual(backgroundCss({mode: 'NONSENSE', opacity: 0.3}), '', 'an unknown mode: the stylesheet\'s look');
}

export function testFixed() {
    for (const glass of [false, true]) {
        assertEqual(backgroundCss({mode: 'FIXED', opacity: 0.3, alpha: 0.9, color: null, glass}),
            `background-color: rgba(18, 18, 22, ${glass ? 0 : 0.3});`,
            `the dock's dark at the opacity – of glass, only the glass this low (glass ${glass})`);
        assertEqual(backgroundCss({mode: 'FIXED', opacity: 0, color: '#3366ff', glass}),
            'background-color: rgba(51, 102, 255, 0);', `its own colour, none of it: just glass (glass ${glass})`);
    }
    assertEqual(backgroundCss({mode: 'FIXED', opacity: 1.7, color: 'red'}),
        'background-color: rgba(18, 18, 22, 1);', 'clamped; a colour that isn\'t #rrggbb is the dark');
    assertEqual(backgroundCss({mode: 'FIXED', opacity: 0.333333}),
        'background-color: rgba(18, 18, 22, 0.33);', 'two decimals');
}

export function testDynamic() {
    for (const glass of [false, true]) {
        assertEqual(backgroundCss({mode: 'DYNAMIC', opacity: 0.3, alpha: 0.8, color: '#abc', glass}),
            `background-color: rgba(170, 187, 204, ${glass ? 0.67 : 0.8});`,
            `the opacity now, not the fixed one – of glass, the wash's share of it (glass ${glass})`);
    }
    assertEqual(backgroundCss({mode: 'DYNAMIC', alpha: -1}), 'background-color: rgba(18, 18, 22, 0);', 'clamped');
}

export function testDynamicAlpha() {
    assertEqual(dynamicAlpha(true, 0.2, 0.8), 0.8, 'near: the higher');
    assertEqual(dynamicAlpha(false, 0.2, 0.8), 0.2, 'away: the lower');
    assertEqual(dynamicAlpha(true, 0, 3), 1, 'clamped');
    assertEqual(dynamicAlphas({customize: false, min: 0.5, max: 0.6}), DEFAULT_ALPHAS, 'Dash to Dock\'s, not customized');
    assertEqual(dynamicAlphas({customize: true, min: 0.5, max: 0.6}), {min: 0.5, max: 0.6}, 'the user\'s');
}

export function testParseColor() {
    assertEqual(parseColor('#121216'), [18, 18, 22]);
    assertEqual(parseColor('#FFF'), [255, 255, 255]);
    assert(parseColor('rgb(1, 2, 3)') === null && parseColor(null) === null && parseColor('#12345') === null,
        'only #rgb and #rrggbb');
}

export function testWindowNear() {
    const dock = {x: 500, y: 900, width: 600, height: 60};
    assertEqual(grownRect(dock, 8), {x: 492, y: 892, width: 616, height: 76});
    assert(windowNear(dock, [{x: 0, y: 0, width: 1600, height: 960}], 8), 'a window over it');
    assert(windowNear(dock, [{x: 0, y: 0, width: 1600, height: 900}], 8), 'one ending where it begins');
    assert(windowNear(dock, [{x: 0, y: 0, width: 1600, height: 893}], 8), 'or just short of it');
    assert(!windowNear(dock, [{x: 0, y: 0, width: 1600, height: 880}], 8), 'not one well above it');
    assert(!windowNear(dock, [{x: 1200, y: 800, width: 300, height: 200}], 8), 'nor one beside it');
    assert(!windowNear(dock, [], 8) && !windowNear(null, [{x: 0, y: 0, width: 10, height: 10}], 8),
        'no windows, or not placed yet');
}

export function testGlassShare() {
    assertEqual(glassShare(1), {glass: 1, tint: 1}, 'solid');
    assertEqual(glassShare(GLASS_FULL), {glass: 1, tint: 0}, 'just glass');
    assertEqual(glassShare(0.2), {glass: 0.5, tint: 0}, 'the glass fading');
    assertEqual(glassShare(0), {glass: 0, tint: 0}, 'clear');
}
