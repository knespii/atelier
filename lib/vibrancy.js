// Type and icons on Atelier's glass – the island and its pages, the bar's
// sides, the dock, the desktop's widgets – as Apple's vibrancy has them:
// they keep reading on whatever is behind the glass, turning darker over a
// light backdrop and lighter over a dark one, as far as they must and no
// further, each in its own hue (the palette's stay the palette's).
//
// What is behind a surface is predicted, not read back from the screen:
// the wallpaper as GNOME draws it there, blurred, made richer and lighter
// and veiled as the glass makes it (lib/glassLook.js), under whatever lies
// over the glass (its tint, a card's colour, a dock's wash). Each surface
// takes one polarity – light type, as it is set, or dark – and each of its
// inks (a label, an icon, a mark, a highlight) only as much lightness, then
// opacity, as it needs there (contrast as APCA has it, lib/apca.js): light
// type what its size and weight need to read, no more than it stands out
// by design on Atelier's dark; dark type, in its place, as much as it
// stands out by design – the quieter type quieter than the rest either
// way. The result is a stylesheet: one rule for each ink that changes, in
// a class of the surface's own. Pure functions, shared by the shell and
// the tests.

import {blend, contrastLc, minimumLc} from './apca.js';
import {hexToOklch, hexToRgb, oklchToHex, rgbToHex} from './palette.js';

/**
 * What Atelier's type on glass is set for: its own dark (the dock's, the
 * cards', about the island's), on which each ink stands out as much as it
 * is meant to – the most it ever needs to, so that quieter type stays
 * quieter than the rest wherever it is.
 */
export const REFERENCE = '#121216';

/**
 * Type on glass is set light: it stays light unless dark type stands out
 * this much more (as lib/lockLook.js pickTone() keeps the lock screen's).
 */
export const LIGHT_BIAS = 1.1;

/**
 * The least |Lc| a mark that means something takes (a dot, a bar, a ring,
 * an indicator): APCA's for spot elements and non-text that must be seen.
 */
export const MARK_LC = 30;

/**
 * An ink as it is set still reads when it falls this little short (|Lc|):
 * APCA's lookup goes in steps of five. (Light type on a dark backdrop a
 * little lighter than Atelier's own stays as it is.)
 */
export const SLACK = 5;

// Symbolic icons read as bold type of their size does.
const ICON_WEIGHT = 700;

/**
 * A colour (the palette's, a signal's) stays that colour: an ink more
 * colourful than this (OKLCH chroma) goes no lighter than pale and no
 * darker than deep (OKLCH lightness) – white or black, it would be
 * another colour.
 */
export const COLOURED = {chroma: 0.03, palest: 0.92, deepest: 0.3};

// The palette's colours as the stylesheet has them while there is no
// palette (GNOME's accent, a quiet grey).
const FALLBACK = {primary: '#3584e4', onSurfaceVariant: '#c4c6d0'};

/**
 * The inks on each kind of surface, as stylesheet.css (and the palette's
 * styles, shell/core/theme.js) set them, for type on Atelier's dark.
 *
 * - selector: where it is, '&' the surface's root (several: a list)
 * - property: what it colours (color unless said otherwise); template:
 *   how the colour goes into it ('{}' for the colour)
 * - kind: 'text' (pt, weight: as set), 'icon' (px), 'mark' (non-text that
 *   must be seen), 'fill' (a highlight under something: dark where the
 *   type is dark) or 'keep' (on a colour of its own: stays as it is,
 *   whatever the rest does)
 * - color and alpha, or role: the palette's colour (its dark scheme's)
 * - source: the rule of stylesheet.css it is set in (a colour of the
 *   palette's is GNOME's accent there, until the palette's styles load;
 *   checked by the tests)
 */
export const INKS = {
    // The island at rest.
    island: [
        {selector: '& .atelier-island-time', kind: 'text', pt: 10.5, weight: 800, color: '#ffffff',
            source: '.atelier-island-time'},
        {selector: '& .atelier-island-date', kind: 'text', pt: 10.5, weight: 800, color: '#ffffff', alpha: 0.62,
            source: '.atelier-island-date'},
        {selector: '& .atelier-island-mic', kind: 'icon', px: 14, color: '#ffa348', source: '.atelier-island-mic'},
        {selector: '& .atelier-island-dnd', kind: 'icon', px: 14, color: '#ffffff', alpha: 0.62,
            source: '.atelier-island-dnd'},
        {selector: '& .atelier-island-unread', property: 'background-color', kind: 'mark', role: 'primary',
            source: '.atelier-island-unread'},
    ],
    // What opens in the island: the glance, the power menu, a profile's
    // toast, a notification, the switcher. (Not the control centre: GNOME's
    // own tiles, menus and calendar, set for a dark surface.)
    pages: [
        {selector: '& .atelier-glance-time', kind: 'text', pt: 30, weight: 800, color: '#ffffff',
            source: '.atelier-glance-time'},
        {selector: '& .atelier-glance-suffix', kind: 'text', pt: 11, weight: 800, color: '#ffffff', alpha: 0.62,
            source: '.atelier-glance-suffix'},
        {selector: '& .atelier-glance-day-name', kind: 'text', pt: 8, weight: 800, color: '#ffffff', alpha: 0.4,
            source: '.atelier-glance-day-name'},
        {selector: '& .atelier-glance-day-number', kind: 'text', pt: 11, weight: 700, color: '#ffffff', alpha: 0.42,
            source: '.atelier-glance-day-number'},
        {selector: '& .atelier-glance-day:today .atelier-glance-day-name', kind: 'text', pt: 8, weight: 800,
            role: 'primary', source: '.atelier-glance-day:today .atelier-glance-day-name'},
        {selector: '& .atelier-glance-day:today .atelier-glance-day-number', kind: 'text', pt: 11, weight: 800,
            color: '#ffffff', source: '.atelier-glance-day:today .atelier-glance-day-number'},
        {selector: '& .atelier-glance-day-dot', property: 'background-color', kind: 'mark', color: '#ffffff',
            alpha: 0.4, source: '.atelier-glance-day-dot'},
        {selector: '& .atelier-glance-event-bar', property: 'background-color', kind: 'mark', role: 'primary',
            source: '.atelier-glance-event-bar'},
        {selector: '& .atelier-glance-event-summary', kind: 'text', pt: 10.5, weight: 400, color: '#ffffff',
            source: '.atelier-glance-event-summary'},
        {selector: ['& .atelier-glance-event-time', '& .atelier-glance-more', '& .atelier-glance-placeholder',
            '& .atelier-glance-weather-place'], kind: 'text', pt: 9.5, weight: 400, color: '#ffffff', alpha: 0.55,
        source: '.atelier-glance-event-time'},
        {selector: '& .atelier-glance-weather-icon', kind: 'icon', px: 16, color: '#ffffff',
            source: '.atelier-glance-weather-icon'},
        {selector: '& .atelier-glance-weather-text', kind: 'text', pt: 10, weight: 400, color: '#ffffff',
            alpha: 0.85, source: '.atelier-glance-weather-text'},
        {selector: '& .atelier-power-title', kind: 'text', pt: 9.5, weight: 700, color: '#ffffff', alpha: 0.6,
            source: '.atelier-power-title'},
        {selector: '& .atelier-power-tile', kind: 'text', pt: 9, weight: 700, color: '#ffffff',
            source: '.atelier-power-tile'},
        {selector: '& .atelier-power-tile', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.08, source: '.atelier-power-tile'},
        {selector: '& .atelier-power-tile:hover', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.15, source: '.atelier-power-tile:hover'},
        {selector: '& .atelier-power-tile:active', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.22, source: '.atelier-power-tile:active'},
        {selector: '& .atelier-power-tile:insensitive', kind: 'text', pt: 9, weight: 700, color: '#ffffff',
            alpha: 0.3, source: '.atelier-power-tile:insensitive'},
        {selector: '& .atelier-toast-subtitle', kind: 'text', pt: 8.5, weight: 700, color: '#ffffff', alpha: 0.55,
            source: '.atelier-toast-subtitle'},
        {selector: '& .atelier-toast-title', kind: 'text', pt: 11, weight: 700, color: '#ffffff',
            source: '.atelier-toast-title'},
        {selector: '& .atelier-toast-check', kind: 'icon', px: 16, role: 'primary', source: '.atelier-toast-check'},
        {selector: '& .atelier-notification-content', kind: 'text', pt: 10, weight: 400, color: '#ffffff',
            source: '.atelier-notification-content'},
        {selector: '& .atelier-notification-content:hover', property: 'background-color', kind: 'fill',
            color: '#ffffff', alpha: 0.05, source: '.atelier-notification-content:hover'},
        {selector: '& .atelier-notification-icon', kind: 'icon', px: 36, color: '#ffffff',
            source: '.atelier-notification-icon'},
        {selector: '& .atelier-notification-app', kind: 'text', pt: 8.5, weight: 700, color: '#ffffff',
            alpha: 0.55, source: '.atelier-notification-app'},
        {selector: '& .atelier-notification-title', kind: 'text', pt: 10.5, weight: 700, color: '#ffffff',
            source: '.atelier-notification-title'},
        {selector: '& .atelier-notification-body', kind: 'text', pt: 10, weight: 400, color: '#ffffff',
            alpha: 0.82, source: '.atelier-notification-body'},
        {selector: '& .atelier-notification-close', kind: 'icon', px: 12, color: '#ffffff', alpha: 0.75,
            source: '.atelier-notification-close'},
        {selector: '& .atelier-notification-close', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.08, source: '.atelier-notification-close'},
        {selector: '& .atelier-notification-close:hover', property: 'background-color', kind: 'fill',
            color: '#ffffff', alpha: 0.16, source: '.atelier-notification-close:hover'},
        {selector: '& .atelier-notification-button.atelier-notification-button-quiet', kind: 'text', pt: 9.5,
            weight: 700, role: 'onSurfaceVariant'},
        {selector: '& .atelier-name', kind: 'text', pt: 11, weight: 700, color: '#ffffff', source: '.atelier-name'},
        {selector: '& .atelier-counter', kind: 'text', pt: 9.5, weight: 400, color: '#ffffff', alpha: 0.55,
            source: '.atelier-counter'},
        {selector: '& .atelier-tab', kind: 'text', pt: 9.5, weight: 700, color: '#ffffff', alpha: 0.6,
            source: '.atelier-tab'},
        {selector: '& .atelier-tab:hover', kind: 'text', pt: 9.5, weight: 700, color: '#ffffff',
            source: '.atelier-tab:hover'},
        {selector: '& .atelier-tab:hover', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.08, source: '.atelier-tab:hover'},
        {selector: '& .atelier-empty', kind: 'text', pt: 11, weight: 400, color: '#ffffff', alpha: 0.75,
            source: '.atelier-empty'},
        {selector: '& .atelier-placeholder', kind: 'text', pt: 28, weight: 800, color: '#ffffff', alpha: 0.35,
            source: '.atelier-placeholder'},
    ],
    // A side of the top bar (GNOME's buttons in it, and Atelier's).
    bar: [
        {selector: '& .panel-button', kind: 'text', pt: 11, weight: 700, color: '#ffffff',
            source: '#panel.atelier-bar-clean .panel-button'},
        {selector: '& .panel-button#panelActivities .workspace-dot', property: 'background-color', kind: 'mark',
            color: '#ffffff', source: '#panel.atelier-bar-clean .panel-button#panelActivities .workspace-dot'},
        {selector: ['& .panel-button:hover', '& .panel-button:focus'], property: 'box-shadow',
            template: 'inset 0 0 0 100px {}', kind: 'fill', color: '#ffffff', alpha: 0.17},
        {selector: ['& .panel-button:active', '& .panel-button:checked'], property: 'box-shadow',
            template: 'inset 0 0 0 100px {}', kind: 'fill', color: '#ffffff', alpha: 0.28},
        {selector: ['& .panel-button:active:hover', '& .panel-button:checked:hover'], property: 'box-shadow',
            template: 'inset 0 0 0 100px {}', kind: 'fill', color: '#ffffff', alpha: 0.32},
        {selector: '& .atelier-bar-ring', property: '-atelier-ring-color', kind: 'mark', role: 'primary',
            source: '.atelier-bar-ring'},
        {selector: '& .atelier-bar-module:working .atelier-bar-ring', property: '-atelier-ring-color',
            kind: 'mark', color: '#57e389', source: '.atelier-bar-module:working .atelier-bar-ring'},
        // (On red and orange of their own: GNOME's, as they are.)
        {selector: ['& .panel-button.screen-recording-indicator', '& .panel-button.screen-sharing-indicator'],
            kind: 'keep', color: '#fafafb'},
    ],
    // A dock of glass: its running marks, separators, highlights and the
    // Show Applications icon (the apps' icons are pictures of their own).
    dock: [
        {selector: '& .app-grid-running-dot', property: 'background-color', kind: 'mark', color: '#ffffff',
            source: '.atelier-dock .app-grid-running-dot'},
        {selector: '& .atelier-dock-indicator', kind: 'mark', color: '#ffffff',
            source: '.atelier-dock .atelier-dock-indicator'},
        {selector: '& .atelier-dock-separator', property: 'background-color', kind: 'mark', color: '#ffffff',
            alpha: 0.18, source: '.atelier-dock-separator'},
        {selector: '& .atelier-dock-show-apps .show-apps-icon', kind: 'icon', px: 32, color: '#ffffff',
            source: '.atelier-dock .atelier-dock-show-apps .show-apps-icon'},
        {selector: ['& .overview-tile:hover', '& .overview-tile:focus', '& .overview-tile:selected',
            '& .overview-tile:focus:hover', '& .overview-tile:active:hover', '& .overview-tile:active:focus',
            '& .atelier-dock-show-apps .show-apps:hover', '& .atelier-dock-show-apps .show-apps:focus',
            '& .atelier-dock-show-apps .show-apps:checked'],
        property: 'background-color', kind: 'fill', color: '#ffffff', alpha: 0.12,
        source: '.atelier-dock .overview-tile:hover'},
    ],
    // A widget's card of glass on the desktop (the Modern look).
    widget: [
        {selector: '&', kind: 'text', pt: 10.5, weight: 400, color: '#ffffff', source: '.atelier-widget'},
        {selector: ['& .atelier-widget-caption', '& .atelier-widget-weekday-initial', '& .atelier-widget-agenda-time',
            '& .atelier-widget-placeholder', '& .atelier-widget-time-suffix'],
        kind: 'text', pt: 9, weight: 400, color: '#ffffff', alpha: 0.6, source: '.atelier-widget-agenda-time'},
        {selector: ['& .atelier-widget-weekday', '& .atelier-widget-week-day:today .atelier-widget-weekday-initial'],
            kind: 'text', pt: 10, weight: 800, role: 'primary', source: '.atelier-widget-weekday'},
        {selector: '& .atelier-widget-cell:other-month .atelier-widget-cell-number', kind: 'text', pt: 9.5,
            weight: 700, color: '#ffffff', alpha: 0.3,
            source: '.atelier-widget-cell:other-month .atelier-widget-cell-number'},
        {selector: '& .atelier-widget-cell-dot', property: 'background-color', kind: 'mark', color: '#ffffff',
            alpha: 0.55, source: '.atelier-widget-cell-dot'},
        {selector: '& .atelier-widget-event-bar', property: 'background-color', kind: 'mark', role: 'primary',
            source: '.atelier-widget-event-bar'},
        {selector: '& .atelier-widget-hint', kind: 'text', pt: 9, weight: 400, color: '#ffffff', alpha: 0.5,
            source: '.atelier-widget-hint'},
        {selector: '& .atelier-widget-hint:hover', kind: 'text', pt: 9, weight: 400, color: '#ffffff',
            source: '.atelier-widget-hint:hover'},
        {selector: '& .atelier-widget-slack-times', kind: 'text', pt: 9, weight: 700, color: '#ffffff', alpha: 0.6,
            source: '.atelier-widget-slack-times'},
        {selector: '& .atelier-widget-contributions', property: '-atelier-empty-color', kind: 'fill',
            color: '#ffffff', alpha: 0.08, source: '.atelier-widget-contributions'},
        {selector: '& .atelier-widget-contributions', property: '-atelier-full-color', kind: 'mark',
            role: 'primary', source: '.atelier-widget-contributions'},
        {selector: '& .atelier-widget-ring', kind: 'mark', color: '#ffffff', source: '.atelier-widget-ring'},
        {selector: '& .atelier-widget-ring', property: '-atelier-ring-color', kind: 'mark', role: 'primary',
            source: '.atelier-widget-ring'},
        {selector: '& .atelier-widget-face', kind: 'mark', color: '#ffffff', alpha: 0.85,
            source: '.atelier-widget-face'},
        {selector: '& .atelier-widget-face', property: '-atelier-hand-color', kind: 'mark', role: 'primary',
            source: '.atelier-widget-face'},
    ],
};

const clamp = (v, low, high) => Math.min(high, Math.max(low, v));
const mix = (from, to, share) => from.map((v, i) => v + (to[i] - v) * share);

/**
 * The glass over a colour: what is behind it made richer (pushed away from
 * its grey) and lighter, dimmed and veiled as its material has it, so much
 * of that as shows (a glass fading out lets the wallpaper through), and
 * what lies over the glass laid on in turn. In sRGB's values, as the GPU
 * mixes them. Only the body of the glass: its rim, sheen and grain light
 * its edges, not what is under the type.
 *
 * @param {string} behind - '#rrggbb': the wallpaper there, blurred
 * @param {object|null} look - lib/glassLook.js lookOf(): saturation,
 *   brightness, dim, veil; null: none (what is behind as it is)
 * @param {object} [options]
 * @param {object[]} [options.layers] - {color: '#rrggbb', alpha} laid over
 *   it, the lowest first
 * @param {number} [options.strength] - how much of the material shows, 0 … 1
 * @returns {string} '#rrggbb'
 */
export function glassOver(behind, look, {layers = [], strength = 1} = {}) {
    const under = hexToRgb(behind);
    let color = under;
    if (look) {
        const [r, g, b] = under;
        const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        color = under.map(v => clamp((gray + (v - gray) * look.saturation) * look.brightness, 0, 255));
        color = color.map(v => v * (1 - (look.dim ?? 0)));
        color = mix(color, [255, 255, 255], look.veil ?? 0);
        color = mix(under, color, clamp(strength, 0, 1));
    }
    for (const {color: over, alpha} of layers)
        color = mix(color, hexToRgb(over), clamp(alpha, 0, 1));
    return rgbToHex(color);
}

/**
 * What the glass comes out as over a part of the wallpaper: where it is
 * darkest, on the whole and where it is lightest (its darker and lighter
 * tenths: dark type must read on the one, light type on the other).
 *
 * @param {object} stats - lib/lockLook.js regionStats() of the wallpaper
 *   there, blurred as the glass blurs it: {mean, tenths: {dark, light}}
 * @param {object|null} look - as for glassOver()
 * @param {object} [options] - as for glassOver()
 * @returns {{dark: string, mean: string, light: string}}
 */
export function backdropOf(stats, look, options = {}) {
    return {
        dark: glassOver(stats.tenths.dark, look, options),
        mean: glassOver(stats.mean, look, options),
        light: glassOver(stats.tenths.light, look, options),
    };
}

/**
 * @param {object} ink - {color: '#rrggbb', alpha}
 * @param {string} behind - '#rrggbb'
 * @param {string} polarity - 'light' (light type) or 'dark'
 * @returns {number} how much the ink stands out there (|Lc|) as type of
 *   that polarity – none where it is not lighter (darker) than what is
 *   behind it
 */
export function lcOf({color, alpha = 1}, behind, polarity) {
    const lc = contrastLc(blend(color, alpha, behind), behind);
    return Math.max(0, polarity === 'dark' ? lc : -lc);
}

/**
 * Light type or dark on a backdrop: light unless dark stands out clearly
 * more – light type where the backdrop is lightest, dark where it is
 * darkest, each at its strongest.
 *
 * @param {object} backdrop - backdropOf()
 * @returns {string} 'light' or 'dark'
 */
export function polarityOn(backdrop) {
    const light = lcOf({color: '#ffffff'}, backdrop.light, 'light');
    const dark = lcOf({color: '#000000'}, backdrop.dark, 'dark');
    return dark > light * LIGHT_BIAS ? 'dark' : 'light';
}

/**
 * @param {object} ink - one of INKS'
 * @param {object|null} [palette] - the palette (lib/palette.js buildPalette())
 * @returns {{color: string, alpha: number}} its colour as set
 */
export function designedOf(ink, palette = null) {
    const color = ink.role ? palette?.dark?.[ink.role] ?? FALLBACK[ink.role] : ink.color;
    return {color: color.toLowerCase(), alpha: ink.alpha ?? 1};
}

/**
 * How much an ink must stand out (|Lc|). As light type, as it is set: as
 * much as APCA's font lookup has type of its size and weight need to read
 * (an icon as bold type of its size, a mark MARK_LC) – but no more than it
 * stands out on Atelier's dark: quieter type is meant to be quieter, and
 * what reads stays as it is. As dark type, where all of it changes anyway:
 * as much as it stands out on Atelier's dark, so that it is as emphatic as
 * it was set – the time black, the date beside it grey.
 *
 * @param {object} ink - one of INKS'
 * @param {object} [designed] - designedOf() it
 * @param {string} [polarity] - 'light' or 'dark' type
 * @returns {number}
 */
export function needOf(ink, designed = designedOf(ink), polarity = 'light') {
    const set = lcOf(designed, REFERENCE, 'light');
    if (polarity === 'dark')
        return set;
    let own = MARK_LC;
    if (ink.kind === 'text')
        own = minimumLc(ink.pt * 4 / 3, ink.weight ?? 400);
    else if (ink.kind === 'icon')
        own = minimumLc(ink.px, ICON_WEIGHT);
    return Math.min(own, set);
}

// The value nearest `from`, towards `to`, at which `does` holds (it holds
// from some value on), or null where even `to` does not.
function nearest(does, from, to) {
    if (does(from))
        return from;
    if (!does(to))
        return null;
    let [missed, held] = [from, to];
    for (let i = 0; i < 24; i++) {
        const middle = (missed + held) / 2;
        if (does(middle))
            held = middle;
        else
            missed = middle;
    }
    return held;
}

// (Opacity in hundredths, never less than it takes.)
const upTo = value => Math.min(1, Math.ceil(value * 100 - 1e-9) / 100);

/**
 * An ink on a backdrop in a polarity: as it is set where it reads so (or
 * falls short by SLACK at most); else its lightness – its hue and
 * colourfulness kept – moved towards white (light type) or black (dark
 * type) only as far as it needs to stand out (needOf()), then, where even
 * that is not enough, more opaque: as far as it goes (a colour no further
 * than pale or deep: COLOURED). A highlight under something is as it is
 * under light type, and as dark as it is light under dark type. Measured on
 * the backdrop's lighter tenth for light type, its darker one for dark.
 *
 * @param {object} ink - one of INKS'
 * @param {object} backdrop - backdropOf()
 * @param {string} polarity - polarityOn()
 * @param {object|null} [palette]
 * @returns {{color: string, alpha: number}|null} its colour there; null:
 *   as it is set
 */
export function inkOn(ink, backdrop, polarity, palette = null) {
    const designed = designedOf(ink, palette);
    const [lightness, chroma, hue] = hexToOklch(designed.color);
    const dark = polarity === 'dark';
    if (ink.kind === 'keep')
        return dark ? designed : null;
    if (ink.kind === 'fill')
        return dark ? {color: oklchToHex([1 - lightness, chroma, hue]), alpha: designed.alpha} : null;
    const need = needOf(ink, designed, polarity);
    const behind = dark ? backdrop.dark : backdrop.light;
    const reads = (color, alpha) => lcOf({color, alpha}, behind, polarity) >= need;
    if (!dark && lcOf(designed, behind, polarity) >= need - SLACK)
        return null;
    const at = l => oklchToHex([l, chroma, hue]);
    const coloured = chroma > COLOURED.chroma;
    let end = dark ? 0 : 1;
    if (coloured)
        end = dark ? Math.min(lightness, COLOURED.deepest) : Math.max(lightness, COLOURED.palest);
    const l = nearest(value => reads(at(value), designed.alpha), lightness, end);
    let shown;
    if (l !== null) {
        shown = {color: at(l), alpha: designed.alpha};
    } else {
        const alpha = nearest(value => reads(at(end), value), designed.alpha, 1);
        shown = {color: at(end), alpha: alpha === null ? 1 : upTo(alpha)};
    }
    // (As it is set, after all: white as light as it gets, or a deep
    // colour of the palette's dark enough as it is.)
    const same = shown.color === designed.color && shown.alpha === designed.alpha;
    return same ? null : shown;
}

/**
 * Where a part of a monitor lies on the picture GNOME draws there.
 *
 * @param {number[]} rect - [x, y, width, height] on the monitor, pixels
 * @param {object|null} shown - where the picture is drawn on the monitor,
 *   {x, y, width, height} (lib/depth.js placement())
 * @returns {{region: number[], cover: number}|null} the part of the
 *   picture, [x, y, width, height] 0 … 1, and how much of the rect it
 *   covers, 0 … 1 (the rest is the background's colour); null: none of it
 */
export function pictureRegion([x, y, width, height], shown) {
    if (!shown || !(width > 0 && height > 0) || !(shown.width > 0 && shown.height > 0))
        return null;
    const x1 = Math.max(x, shown.x);
    const y1 = Math.max(y, shown.y);
    const x2 = Math.min(x + width, shown.x + shown.width);
    const y2 = Math.min(y + height, shown.y + shown.height);
    if (x2 <= x1 || y2 <= y1)
        return null;
    return {
        region: [(x1 - shown.x) / shown.width, (y1 - shown.y) / shown.height,
            (x2 - x1) / shown.width, (y2 - y1) / shown.height],
        cover: (x2 - x1) * (y2 - y1) / (width * height),
    };
}

/**
 * The stats of a part of the wallpaper partly off its picture: the
 * background's colour (GNOME's primary-color there) taking the rest.
 *
 * @param {object|null} stats - regionStats() of the part on the picture;
 *   null: none of it is
 * @param {number} cover - how much of it the picture covers, 0 … 1
 * @param {string} background - '#rrggbb'
 * @returns {object} {mean, tenths: {dark, middle, light}}
 */
export function withBackground(stats, cover, background) {
    if (!stats || cover <= 0)
        return {mean: background, tenths: {dark: background, middle: background, light: background}};
    if (cover >= 1)
        return stats;
    const toward = hex => rgbToHex(mix(hexToRgb(hex), hexToRgb(background), 1 - cover));
    return {
        mean: toward(stats.mean),
        tenths: {dark: toward(stats.tenths.dark), middle: toward(stats.tenths.middle), light: toward(stats.tenths.light)},
    };
}

// A colour as St takes it.
const cssColor = ({color, alpha}) => `rgba(${hexToRgb(color).join(', ')}, ${Number(alpha.toFixed(2))})`;

/**
 * @param {object} surface
 * @param {string[]} surface.roots - the selectors of the actors the class
 *   is on (the island, a side of the bar, a dock, a widget)
 * @param {string} surface.scope - the class
 * @param {string} surface.inks - which INKS
 * @param {object} surface.backdrop - backdropOf() where it is
 * @param {object|null} [palette]
 * @returns {{polarity: string, rules: string[]}} its polarity, and a rule
 *   for each of its inks that is not as it is set
 */
export function surfaceRules({roots, scope, inks, backdrop}, palette = null) {
    const polarity = polarityOn(backdrop);
    const rules = [];
    for (const ink of INKS[inks] ?? []) {
        const shown = inkOn(ink, backdrop, polarity, palette);
        if (!shown)
            continue;
        const selectors = [ink.selector].flat().flatMap(selector =>
            roots.map(root => selector.replaceAll('&', `${root}.${scope}`)));
        const value = (ink.template ?? '{}').replace('{}', cssColor(shown));
        rules.push(`${selectors.join(',\n')} { ${ink.property ?? 'color'}: ${value}; }`);
    }
    return {polarity, rules};
}

/**
 * @param {string} id - a surface's own name (the island, a dock's monitor,
 *   a widget's id)
 * @returns {string} the class its type's colours are in
 */
export function scopeOf(id) {
    return `atelier-vibrant-${String(id).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
}

/**
 * @param {string[]} rules - surfaceRules() of each surface
 * @returns {string} the stylesheet (empty: nothing changes)
 */
export function vibrancyStylesheet(rules) {
    if (rules.length === 0)
        return '';
    return `/* Generated by Atelier: its type on glass, to read on what is behind it. */\n${rules.join('\n')}\n`;
}
