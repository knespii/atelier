import Gio from 'gi://Gio';

import {CLICK_ACTIONS, IGNORED, describeKeys, mapDashToDock} from '../lib/dockImport.js';
import {assert, assertEqual} from './util.js';

// Atelier's dock's keys, from its schema (make test points GSettings at
// schemas/).
const keys = describeKeys(Gio.SettingsSchemaSource.get_default()
    .lookup('org.gnome.shell.extensions.atelier.dock', true));

// A Dash to Dock with only these keys.
const reader = values => key => values[key];
const valueOf = (result, key) => result.values.find(([k]) => k === key)?.[1];

export function testDescribeKeys() {
    assertEqual(keys['icon-size'], {type: 'i', range: [16, 64], choices: null}, 'a range');
    assertEqual(keys['dock-position'].choices, ['TOP', 'RIGHT', 'BOTTOM', 'LEFT'], 'an enum\'s nicks');
    assertEqual(keys['shortcut'].type, 'as', 'a list');
    assertEqual(keys['autohide'], {type: 'b', range: null, choices: null}, 'a boolean');
}

export function testSameKeysCopied() {
    const result = mapDashToDock(reader({
        'dock-position': 'LEFT',
        'autohide': true,
        'pressure-threshold': 40,
        'background-color': '#336699',
        'shortcut': ['<Super>d'],
        'running-indicator-style': 'DOTS',
        'custom-theme-running-dots-border-width': 2,
    }), keys);
    assertEqual(result.values, [
        ['autohide', true], ['background-color', '#336699'], ['custom-theme-running-dots-border-width', 2],
        ['dock-position', 'LEFT'], ['pressure-threshold', 40], ['running-indicator-style', 'DOTS'],
        ['shortcut', ['<Super>d']],
    ].sort(([a], [b]) => Object.keys(keys).indexOf(a) - Object.keys(keys).indexOf(b)), 'as they are');
    assertEqual(result.ignored, [], 'nothing left over');
}

export function testIconSizeRenamedAndClamped() {
    assertEqual(valueOf(mapDashToDock(reader({'dash-max-icon-size': 40}), keys), 'icon-size'), 40, 'renamed');
    assertEqual(valueOf(mapDashToDock(reader({'dash-max-icon-size': 128}), keys), 'icon-size'), 64, 'at most 64');
    assertEqual(valueOf(mapDashToDock(reader({'dash-max-icon-size': 8}), keys), 'icon-size'), 16, 'at least 16');
    assertEqual(valueOf(mapDashToDock(reader({'icon-size': 24}), keys), 'icon-size'), undefined,
        'not from a key of the same name');
}

export function testClicksConverted() {
    for (const key of ['click-action', 'shift-click-action', 'middle-click-action', 'shift-middle-click-action']) {
        for (const [previews, spread] of Object.entries(CLICK_ACTIONS))
            assertEqual(valueOf(mapDashToDock(reader({[key]: previews}), keys), key), spread, `${key} ${previews}`);
        assertEqual(valueOf(mapDashToDock(reader({[key]: 'quit'}), keys), key), 'quit', `${key}: the others stay`);
    }
}

export function testClamped() {
    const result = mapDashToDock(reader({
        'animation-time': 5, 'show-delay': -1, 'pressure-threshold': 5000, 'height-fraction': 0.01,
        'background-opacity': 1.5, 'min-alpha': -0.2, 'shortcut-timeout': 99,
        'custom-theme-running-dots-border-width': 9,
    }), keys);
    const expected = {
        'animation-time': 2, 'show-delay': 0, 'pressure-threshold': 1000, 'height-fraction': 0.1,
        'background-opacity': 1, 'min-alpha': 0, 'shortcut-timeout': 10, 'custom-theme-running-dots-border-width': 3,
    };
    assertEqual(result.values.length, Object.keys(expected).length, 'all of them');
    for (const [key, value] of Object.entries(expected))
        assertEqual(valueOf(result, key), value, `${key} within Atelier's range`);
}

export function testUnknownChoicesAndTypesLeft() {
    const result = mapDashToDock(reader({
        'dock-position': 'MIDDLE', 'intellihide-mode': 'SOMETIMES', 'autohide': 'yes', 'icon-size-fixed': 1,
        'shortcut': 'a', 'show-trash': true,
    }), keys);
    assertEqual(result.values, [['show-trash', true]], 'only the one Atelier takes');
    assertEqual(result.ignored.sort(), ['autohide', 'dock-position', 'icon-size-fixed', 'intellihide-mode', 'shortcut'],
        'the others not applicable');
}

export function testIgnored() {
    const all = Object.fromEntries(IGNORED.map(key => [key, true]));
    const result = mapDashToDock(reader(all), keys);
    assertEqual(result.values, [], 'nothing to write');
    assertEqual(result.ignored, IGNORED, 'every one listed');
    assertEqual(mapDashToDock(reader({}), keys), {values: [], ignored: []}, 'and only those Dash to Dock has');
}

export function testEnabledUntouched() {
    const result = mapDashToDock(reader({enabled: false, intellihide: false}), keys);
    assertEqual(result.values, [['intellihide', false]], 'whether the dock is on never comes over');
    assert(!result.ignored.includes('enabled'), 'nor counts as left over');
}
