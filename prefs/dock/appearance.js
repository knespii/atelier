// The dock's section "Appearance": how see-through the background is (as
// the profile has it, fixed, or more opaque near windows; the opacities
// for the mode chosen), its colour, a compact dock, square corners.

import Adw from 'gi://Adw';

const MODES = [
    ['DEFAULT', 'As the profile'],
    ['FIXED', 'Fixed'],
    ['DYNAMIC', 'More opaque near windows'],
];
const PERCENT = {lower: 0, upper: 100, step: 5, scale: 100};

/**
 * @param {Adw.PreferencesPage} page
 * @param {object} ctx - {settings, binder}
 * @returns {Adw.PreferencesGroup}
 */
export function build(page, {settings, binder}) {
    const group = new Adw.PreferencesGroup({
        title: 'Appearance',
        description: 'Over glass the colour tints the blurred wallpaper; at no opacity the dock is just glass.',
    });
    binder.bindCombo(group, settings, 'transparency-mode', 'Background',
        'How see-through it is', MODES);
    const fixed = binder.bindSpin(group, settings, 'background-opacity', 'Opacity', 'Percent', PERCENT);
    const customize = binder.bindSwitch(group, settings, 'customize-alphas', 'Own opacities',
        'Rather than the usual 20% away from windows and 80% near them');
    const min = binder.bindSpin(group, settings, 'min-alpha', 'Away from windows', 'Opacity, percent', PERCENT);
    const max = binder.bindSpin(group, settings, 'max-alpha', 'Near windows', 'Opacity, percent', PERCENT);
    for (const row of [min, max])
        binder.bindSensitive(row, settings, 'customize-alphas');
    const ownColor = binder.bindSwitch(group, settings, 'custom-background-color', 'Own colour',
        'Rather than the dock\'s dark one');
    const color = binder.bindColor(group, settings, 'background-color', 'Colour');
    binder.bindSensitive(color, settings, 'custom-background-color');

    // The opacities of the mode chosen; a colour with either opacity (as
    // the profile has it, the background is the profile's).
    const syncMode = () => {
        const mode = settings.get_string('transparency-mode');
        // (As the profile has it, there to see, waiting for Fixed.)
        fixed.visible = mode !== 'DYNAMIC';
        fixed.sensitive = mode === 'FIXED';
        fixed.subtitle = mode === 'FIXED' ? 'Percent: none, and the dock is clear' : 'Choose Fixed above to set it';
        for (const row of [customize, min, max])
            row.visible = mode === 'DYNAMIC';
        for (const row of [ownColor, color])
            row.visible = mode !== 'DEFAULT';
    };
    syncMode();
    binder.connect(settings, 'changed::transparency-mode', syncMode);

    binder.bindSwitch(group, settings, 'magnification', 'Magnification',
        'The icons under the pointer grow; the dock keeps its size');
    const scale = binder.bindSpin(group, settings, 'magnification-scale', 'How big', 'Percent of an icon at rest',
        {lower: 100, upper: 200, step: 10, scale: 100});
    const spread = binder.bindSpin(group, settings, 'magnification-spread', 'How far', 'Icons from the pointer',
        {lower: 1, upper: 5, step: 0.5, digits: 1});
    for (const row of [scale, spread])
        binder.bindSensitive(row, settings, 'magnification');
    binder.bindSwitch(group, settings, 'custom-theme-shrink', 'Compact', 'Less room around the icons');
    binder.bindSwitch(group, settings, 'force-straight-corner', 'Square corners', 'Always square in panel mode');
    return group;
}
