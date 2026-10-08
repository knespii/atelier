// The dock's section "Hiding": out of the way of windows (and which ones),
// when the pointer leaves, until called, pushing against the edge, in
// fullscreen, for urgent windows, and its timing.
//
// (For now only out of the way of windows, as it was.)

import Adw from 'gi://Adw';

/**
 * @param {Adw.PreferencesPage} page
 * @param {object} ctx - {settings, binder}
 * @returns {Adw.PreferencesGroup|null}
 */
export function build(page, {settings, binder}) {
    const group = new Adw.PreferencesGroup({title: 'Hiding'});
    binder.bindSwitch(group, settings, 'intellihide', 'Out of the way of windows',
        'It moves away when a window of the focused app covers it; its edge brings it back');
    return group;
}
