// The dock's section "Hiding": out of the way of windows (and which ones),
// when the pointer leaves, until called, pushing against the edge, in
// fullscreen, for urgent windows, and its timing. Always visible (in
// "Position and size") keeps it from moving away: the rows that hide it
// grey out then.

import Adw from 'gi://Adw';

const MODES = [
    ['FOCUS_APPLICATION_WINDOWS', 'The focused app\'s'],
    ['ALL_WINDOWS', 'Any window'],
    ['MAXIMIZED_WINDOWS', 'Maximized windows'],
    ['ALWAYS_ON_TOP', 'Only full screen windows'],
];

// Seconds, from none to two.
const TIME = {lower: 0, upper: 2, step: 0.05, digits: 2};

/**
 * @param {Adw.PreferencesPage} page
 * @param {object} ctx - {settings, binder}
 * @returns {Adw.PreferencesGroup}
 */
export function build(page, {settings, binder}) {
    const group = new Adw.PreferencesGroup({title: 'Hiding'});
    const intellihide = binder.bindSwitch(group, settings, 'intellihide', 'Out of the way of windows',
        'It moves away when windows cover it; its edge brings it back');
    const mode = binder.bindCombo(group, settings, 'intellihide-mode', 'Windows',
        'Which ones move it away', MODES);
    const autohide = binder.bindSwitch(group, settings, 'autohide', 'Hide when the pointer leaves',
        'Out of the way of windows too, it then goes only while they cover it');
    const manual = binder.bindSwitch(group, settings, 'manualhide', 'Hidden until called',
        'It stays away until the pointer reaches its edge, or its shortcut calls it');
    const pressure = binder.bindSwitch(group, settings, 'require-pressure-to-show', 'Push against the edge to show',
        'Reaching the edge is not enough: the pointer has to keep going');
    const threshold = binder.bindSpin(group, settings, 'pressure-threshold', 'Pressure',
        'How far the pointer pushes, in pixels', {lower: 0, upper: 1000, step: 10});
    const fullscreen = binder.bindSwitch(group, settings, 'autohide-in-fullscreen', 'In fullscreen too',
        'Over a window that fills the screen, its edge brings it back');
    const urgent = binder.bindSwitch(group, settings, 'show-dock-urgent-notify', 'Show for urgent windows',
        'It comes back for a moment when an app\'s window asks for attention');

    const timing = new Adw.ExpanderRow({title: 'Timing', subtitle: 'In seconds'});
    group.add(timing);
    binder.register('timing', timing);
    binder.bindSpin(timing, settings, 'animation-time', 'Moving', 'How long it takes to go and come back', TIME);
    binder.bindSpin(timing, settings, 'show-delay', 'Before showing',
        'How long the pointer stays at the edge (or pushes against it)', TIME);
    binder.bindSpin(timing, settings, 'hide-delay', 'Before hiding', 'Once nothing keeps it any more', TIME);

    // Always visible, nothing hides it; the mode only with intellihide,
    // the pressure only when pushing.
    const sync = () => {
        const free = !settings.get_boolean('dock-fixed');
        for (const row of [intellihide, autohide, manual, pressure, fullscreen, urgent])
            row.sensitive = free;
        mode.sensitive = free && settings.get_boolean('intellihide');
        threshold.sensitive = free && settings.get_boolean('require-pressure-to-show');
    };
    sync();
    for (const key of ['dock-fixed', 'intellihide', 'require-pressure-to-show'])
        binder.connect(settings, `changed::${key}`, sync);
    return group;
}
