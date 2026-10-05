import Gio from 'gi://Gio';

import {buildPalette} from '../lib/palette.js';
import {
    applyTerminalColors, isTerminalAvailable, restoreTerminal, terminalColors,
} from '../lib/terminal.js';
import {assert, assertEqual} from './util.js';

const ORIGINAL = 'b1dcc9dd-5262-4d8d-a863-c897e6d979b9';

function profile(uuid) {
    const schema = Gio.SettingsSchemaSource.get_default().lookup('org.gnome.Terminal.Legacy.Profile', true);
    return new Gio.Settings({settings_schema: schema, path: `/org/gnome/terminal/legacy/profiles:/:${uuid}/`});
}

function setup() {
    const list = new Gio.Settings({schema_id: 'org.gnome.Terminal.ProfilesList'});
    list.set_strv('list', [ORIGINAL]);
    list.set_string('default', ORIGINAL);
    const original = profile(ORIGINAL);
    original.set_string('font', 'Monospace 13');
    original.set_boolean('use-system-font', false);
    const palette = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.atelier.palette'});
    for (const key of ['terminal-profile', 'terminal-previous-default'])
        palette.reset(key);
    return {list, original, palette};
}

export function testTerminalColors() {
    const palette = buildPalette({source: '#2f8fb0'});
    const dark = terminalColors(palette, true);
    assertEqual(dark.background, palette.dark.surface);
    assertEqual(dark.palette.length, 16);
    assertEqual(terminalColors(palette, false).foreground, palette.light.onSurface);
}

export function testApplyAndRestore() {
    if (!isTerminalAvailable()) {
        print('      (GNOME Terminal not installed, skipped)');
        return;
    }
    const {list, original, palette} = setup();
    const colors = terminalColors(buildPalette({source: '#c8892b'}), true);

    const first = applyTerminalColors(palette, colors);
    assertEqual(first, {ok: true, created: true});
    const uuid = palette.get_string('terminal-profile');
    assert(uuid && uuid !== ORIGINAL, 'own profile created');
    assertEqual(list.get_strv('list'), [ORIGINAL, uuid]);
    assertEqual(list.get_string('default'), uuid, 'made the default');
    assertEqual(palette.get_string('terminal-previous-default'), ORIGINAL);

    const ours = profile(uuid);
    assertEqual(ours.get_string('visible-name'), 'Atelier');
    assertEqual(ours.get_boolean('use-theme-colors'), false);
    assertEqual(ours.get_string('background-color'), colors.background);
    assertEqual(ours.get_strv('palette'), colors.palette);
    assertEqual(ours.get_string('font'), 'Monospace 13', 'other settings copied from the default');

    // The next palette updates the same profile.
    const next = terminalColors(buildPalette({source: '#2f8fb0'}), false);
    assertEqual(applyTerminalColors(palette, next), {ok: true, created: false});
    assertEqual(palette.get_string('terminal-profile'), uuid);
    assertEqual(ours.get_string('background-color'), next.background);
    assertEqual(list.get_strv('list').length, 2, 'no second profile');

    assertEqual(restoreTerminal(palette), true);
    assertEqual(list.get_string('default'), ORIGINAL, 'previous default is back');
    assertEqual(list.get_strv('list'), [ORIGINAL]);
    assertEqual(ours.get_user_value('background-color'), null, 'own profile forgotten');
    assertEqual(original.get_string('font'), 'Monospace 13', 'user profile untouched');
    assertEqual(restoreTerminal(palette), false, 'nothing left to restore');
}
