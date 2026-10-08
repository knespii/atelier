// Tests for lib/dockLocations.js: which drives show, the trash's icon,
// which file manager windows go with a place.

import {
    execArgument, filterMounts, trashIcon, windowShowsLocation, windowsShowing,
} from '../lib/dockLocations.js';
import {assert, assertEqual} from './util.js';

const drive = (id, name, more = {}) => ({id, name, mounted: true, network: false, usable: true, shadowed: false, ...more});

const MOUNTS = [
    drive('usb', 'USB Stick'),
    drive('card', 'card'),
    drive('dvd', 'DVD', {mounted: false}),
    drive('nas', 'NAS', {network: true}),
    drive('share', 'Share', {network: true, mounted: false}),
    drive('root', 'Filesystem', {usable: false}),
    drive('shadow', 'Shadowed', {shadowed: true}),
];

const ids = mounts => mounts.map(mount => mount.id);

export function testMountsFiltered() {
    assertEqual(ids(filterMounts(MOUNTS, {onlyMounted: true, network: false})), ['card', 'usb'],
        'only mounted, no network drives');
    assertEqual(ids(filterMounts(MOUNTS, {onlyMounted: false, network: false})), ['card', 'dvd', 'usb'],
        'with drives not mounted');
    assertEqual(ids(filterMounts(MOUNTS, {onlyMounted: true, network: true})), ['card', 'nas', 'usb'],
        'with network drives');
    assertEqual(ids(filterMounts(MOUNTS, {onlyMounted: false, network: true})), ['card', 'dvd', 'nas', 'share', 'usb'],
        'everything that can be used');
    assertEqual(filterMounts([], {onlyMounted: true, network: true}), [], 'none');
}

export function testMountsInAStableOrder() {
    const reversed = [...MOUNTS].reverse();
    assertEqual(ids(filterMounts(reversed, {onlyMounted: false, network: true})),
        ids(filterMounts(MOUNTS, {onlyMounted: false, network: true})), 'the same order whatever order they come in');
    const twins = [drive('b', 'Disk'), drive('a', 'Disk'), drive('a', 'Disk again')];
    assertEqual(ids(filterMounts(twins, {onlyMounted: true, network: false})), ['a', 'b'],
        'the same name: by id; the same id: once');
    assertEqual(ids(reversed)[0], 'shadow', 'the list given is left as it is');
}

export function testTrashIcon() {
    assertEqual(trashIcon({count: 0}), 'user-trash', 'empty');
    assertEqual(trashIcon({count: 3}), 'user-trash-full', 'with items');
    assertEqual(trashIcon({count: null}), 'user-trash', 'not known yet');
}

export function testWindowShowsLocation() {
    assert(windowShowsLocation('trash:///', ['trash:///']), 'the trash in the trash');
    assert(windowShowsLocation('file:///media/usb', ['file:///media/usb/']), 'a slash at the end or not');
    assert(windowShowsLocation('file:///media/usb/', ['file:///home/me', 'file:///media/usb/photos']),
        'a folder on the drive, in one of the tabs');
    assert(!windowShowsLocation('file:///media/usb', ['file:///media/usb2']), 'not a drive whose name begins the same');
    assert(!windowShowsLocation('file:///media/usb', ['file:///media']), 'not the folder the drive is in');
    assert(!windowShowsLocation('trash:///', []), 'not a window with no places');
    assert(!windowShowsLocation('', ['file:///']), 'not a place with no uri');
}

export function testWindowsShowing() {
    const open = {
        '/org/gnome/Nautilus/window/1': ['trash:///'],
        '/org/gnome/Nautilus/window/2': ['file:///home/me', 'file:///media/usb/a'],
        '/org/gnome/Nautilus/window/3': ['file:///home/me'],
    };
    assertEqual(windowsShowing('trash:///', open), ['/org/gnome/Nautilus/window/1'], 'the trash');
    assertEqual(windowsShowing('file:///media/usb', open), ['/org/gnome/Nautilus/window/2'], 'the drive, in a tab');
    assertEqual(windowsShowing('file:///media/dvd', open), [], 'none');
    assertEqual(windowsShowing('trash:///', {}), [], 'no file manager');
}

export function testExecArgument() {
    assertEqual(execArgument('trash:///'), '"trash:///"');
    assertEqual(execArgument('file:///media/my%20disk'), '"file:///media/my%%20disk"', 'percent signs doubled');
    assertEqual(execArgument('a"b$c`d\\e'), '"a\\"b\\$c\\`d\\\\e"', 'quotes, dollars, backticks, backslashes');
}
