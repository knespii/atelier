// The dock's section "Indicators and badges": how running apps are marked
// and in what colours, counts and progress on the icons, wiggling urgent
// apps, the apps' names.

import Adw from 'gi://Adw';

const STYLES = [
    ['DEFAULT', 'GNOME\'s dot'],
    ['DOT', 'Dot'],
    ['DOTS', 'Dots, one per window'],
    ['SQUARES', 'Squares, one per window'],
    ['DASHES', 'Dashes, one per window'],
    ['SEGMENTED', 'Segments, one per window'],
    ['SOLID', 'Bar'],
    ['CILIORA', 'Line and squares'],
    ['METRO', 'Metro'],
    ['BINARY', 'Windows counted in binary'],
];

/**
 * @param {Adw.PreferencesPage} page
 * @param {object} ctx - {settings, binder}
 * @returns {Adw.PreferencesGroup}
 */
export function build(page, {settings, binder}) {
    const group = new Adw.PreferencesGroup({title: 'Indicators and badges'});
    binder.bindCombo(group, settings, 'running-indicator-style', 'Running apps',
        'How their windows are marked on the icon', STYLES);
    binder.bindSwitch(group, settings, 'running-indicator-dominant-color', 'In the icon\'s own colour',
        'The colour the app\'s icon is mostly of');

    const colors = new Adw.ExpanderRow({
        title: 'Custom colours',
        subtitle: 'For the marks of the styles other than GNOME\'s dot',
        show_enable_switch: true,
    });
    binder.bind(settings, 'custom-theme-customize-running-dots', colors, 'enable-expansion');
    binder.register('custom-theme-customize-running-dots', colors);
    group.add(colors);
    const colorRows = [
        binder.bindColor(colors, settings, 'custom-theme-running-dots-color', 'Colour'),
        binder.bindColor(colors, settings, 'custom-theme-running-dots-border-color', 'Border colour'),
        binder.bindSpin(colors, settings, 'custom-theme-running-dots-border-width', 'Border width', 'In pixels',
            {lower: 0, upper: 3}),
    ];
    colorRows.forEach(row => binder.bindSensitive(row, settings, 'custom-theme-customize-running-dots'));

    const badges = new Adw.ExpanderRow({
        title: 'Badges and progress',
        subtitle: 'Counts in the corner of the icons, and how far along an app is',
        show_enable_switch: true,
    });
    binder.bind(settings, 'show-icons-emblems', badges, 'enable-expansion');
    binder.register('show-icons-emblems', badges);
    group.add(badges);
    const badgeRows = [
        binder.bindSwitch(badges, settings, 'show-icons-notifications-counter', 'Notification counter',
            'How many notifications an app has (none with Do Not Disturb on)'),
        binder.bindSwitch(badges, settings, 'application-counter-overrides-notifications', 'App counts first',
            'An app\'s own count, when it gives one, instead of its notifications'),
    ];
    badgeRows.forEach(row => binder.bindSensitive(row, settings, 'show-icons-emblems'));

    binder.bindSwitch(group, settings, 'dance-urgent-applications', 'Wiggle urgent apps',
        'While one of their windows asks for attention');
    binder.bindSwitch(group, settings, 'hide-tooltip', 'Hide app names',
        'No name beside an icon while the pointer rests on it');
    return group;
}
