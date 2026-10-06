import GLib from 'gi://GLib';

import {exportProfile, folderName, readExportedProfile} from '../lib/profileTransfer.js';
import {assert, assertEqual, freshDir} from './util.js';

export function testFolderName() {
    assertEqual(folderName('Night / Rain'), 'Night Rain (Atelier)');
    assertEqual(folderName('  '), 'Profile (Atelier)');
}

export async function testExportAndRead() {
    const dir = freshDir('transfer');
    const wallpaper = GLib.build_filenamev([dir, 'sea.png']);
    GLib.file_set_contents(wallpaper, 'not really a png');
    const profile = {
        id: 'abc', name: 'Sea', wallpaper, wallpaperDark: null, colorScheme: 'prefer-dark',
        accentColor: 'teal', iconTheme: 'Papirus', palette: {source: 'wallpaper', variant: 'tonal'},
    };
    const exported = await exportProfile(profile, dir);
    assertEqual(GLib.path_get_basename(exported), 'Sea (Atelier)');
    assert(GLib.file_test(GLib.build_filenamev([exported, 'wallpaper.png']), GLib.FileTest.IS_REGULAR),
        'the wallpaper is copied next to it');
    const again = await exportProfile(profile, dir);
    assertEqual(GLib.path_get_basename(again), 'Sea (Atelier) 2', 'never over another export');

    const read = await readExportedProfile(exported);
    assertEqual(read.id, undefined);
    assertEqual([read.name, read.colorScheme, read.accentColor, read.iconTheme],
        ['Sea', 'prefer-dark', 'teal', 'Papirus']);
    assertEqual(read.wallpaper, GLib.build_filenamev([exported, 'wallpaper.png']), 'its wallpaper, from the folder');

    let error = null;
    try {
        await readExportedProfile(dir);
    } catch (e) {
        error = e.message;
    }
    assertEqual(error, 'This folder has no Atelier profile in it');
}
