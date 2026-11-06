// Type and icons on Atelier's glass – the island and its pages, the bar's
// sides, the dock, the desktop's widgets – as Apple's vibrancy has them:
// they keep reading on whatever is behind the glass, turning darker over a
// light backdrop and lighter over a dark one, as far as they must and no
// further, each in its own hue (the palette's stay the palette's).
//
// What is behind a surface is predicted, not read back from the screen:
// the wallpaper as GNOME draws it there, blurred as the glass blurs it,
// made lighter or darker as the glass's face makes it and darkened as the
// glass-dim setting has it, the same on every surface (lib/glassLook.js),
// under whatever lies over the glass (a card's colour, a dock's wash). The
// glass never darkens or lightens by itself: its type does what reading
// takes. Each surface takes one polarity – light type, as it is set, or
// dark: the one GNOME's style implies – light type in its dark style, dark
// in its light one – unless the other falls clearly less short of reading
// there (polarityOf()). Then each of its inks (a label, an icon, a mark, a
// highlight) only as much lightness, then opacity, as it needs on the glass
// (contrast as APCA has it, lib/apca.js): light type what its size and
// weight need to read, no more than it stands out by design on Atelier's
// dark; dark type, in its place, as much as it stands out by design – the
// quieter type quieter than the rest either way. The result is a
// stylesheet: one rule for each ink that changes, in a class of the
// surface's own. Pure functions, shared by the shell and the tests.

import {blend, contrastLc, minimumLc} from './apca.js';
import {faceColor, faceOf} from './glassLook.js';
import {hexToOklch, hexToRgb, oklchToHex, rgbToHex} from './palette.js';

/**
 * What Atelier's type on glass is set for: its own dark (the dock's, the
 * cards', about the island's), on which each ink stands out as much as it
 * is meant to – the most it ever needs to, so that quieter type stays
 * quieter than the rest wherever it is.
 */
export const REFERENCE = '#121216';

/**
 * The most type on glass needs to read (|Lc|): APCA's least for fluent
 * text, body text 18 px regular or 14 px bold. Type set to stand out more
 * than that (Atelier's white on its dark) does where it can (inkOn()), but
 * its polarity is not chosen for more.
 */
export const READ_LC = 75;

/**
 * Type keeps the polarity GNOME's style implies unless the other falls
 * short of reading by more than margin less (|Lc|: a step of APCA's
 * lookup); the other, once taken, stays while it falls short by more than
 * margin − hold less (polarityOf()): a surface moved a little doesn't flip
 * back and forth.
 */
export const POLARITY = Object.freeze({margin: 5, hold: 2});

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

// The control centre's modules (shell/controlCentre/ink.js): each of them –
// the tabs' bar, a module of the Controls tab, a menu's page, another tab
// – a surface of its own, '&' its root. What their inks are on and among:
// a tile's round icon's pill, the calendar's fainter ones.
const ICON_PILL = Object.freeze({color: '#ffffff', alpha: 0.16});
const MENU = Object.freeze({color: '#ffffff', alpha: 0.07});
// (Over GNOME's and other extensions' !important: as stylesheet.css has it.)
const IMPORTANT = '{} !important';
const SYSTEM_BUTTON = '& .quick-settings-system-item .icon-button';
const ARROW = '& .quick-toggle-has-menu .quick-toggle-menu-button';
const ITEMS = ['& .popup-menu-item', '& .popup-sub-menu .popup-menu-item'];
const ITEMS_LIT = ITEMS.flatMap(item => [`${item}:hover`, `${item}:focus`, `${item}:selected`, `${item}:checked`]);
const BUTTONS = ['& .quick-toggle-menu .button', '& .quick-toggle-menu .icon-button'];
const CALENDAR = ['& .calendar', '& .datemenu-today-button', '& .events-button', '& .world-clocks-button',
    '& .weather-button'];
// On the accent – a tile that is on, a switch: the palette's colour and its
// own type on it (onPrimary), whatever the type round it does.
const ACCENT = Object.freeze({fg: '-st-accent-fg-color', bg: '-st-accent-color'});
const SWITCH_INKS = [
    {selector: '& .toggle-switch', kind: 'mark', color: '#ffffff', source: '.atelier-cc .toggle-switch'},
    {selector: '& .toggle-switch', property: 'background-color', kind: 'fill', color: '#ffffff', alpha: 0.15},
    {selector: '& .toggle-switch:hover', property: 'background-color', kind: 'fill', color: '#ffffff',
        alpha: 0.2},
    {selector: '& .toggle-switch:checked', kind: 'keep', value: ACCENT.fg},
    {selector: '& .toggle-switch:checked', property: 'background-color', kind: 'keep', value: ACCENT.bg},
];

// Claude Code's usage: a page of its own from the bar, a tab of the control
// centre's.
const CLAUDE_INKS = [
    {selector: '& .atelier-claude-title', kind: 'text', pt: 10.5, weight: 700, color: '#ffffff',
        source: '.atelier-claude-title'},
    {selector: '& .atelier-claude-left', kind: 'text', pt: 9.5, weight: 700, color: '#ffffff', alpha: 0.7,
        source: '.atelier-claude-left'},
    {selector: '& .atelier-claude-span', kind: 'text', pt: 9.5, weight: 400, color: '#ffffff', alpha: 0.55,
        source: '.atelier-claude-span'},
    {selector: '& .atelier-claude-value', kind: 'text', pt: 15, weight: 800, color: '#ffffff',
        source: '.atelier-claude-value'},
    {selector: ['& .atelier-claude-name', '& .atelier-claude-day-name'], kind: 'text', pt: 8, weight: 700,
        color: '#ffffff', alpha: 0.55, source: '.atelier-claude-name'},
    {selector: '& .atelier-claude-line', kind: 'text', pt: 9.5, weight: 400, color: '#ffffff', alpha: 0.82,
        source: '.atelier-claude-line'},
    {selector: '& .atelier-claude-progress', property: 'background-color', kind: 'fill', color: '#ffffff',
        alpha: 0.12, source: '.atelier-claude-progress'},
    {selector: ['& .atelier-claude-progress-fill', '& .atelier-claude-day:today .atelier-claude-day-bar'],
        property: 'background-color', kind: 'mark', role: 'primary', source: '.atelier-claude-progress-fill'},
    {selector: '& .atelier-claude-day-bar', property: 'background-color', kind: 'mark', color: '#ffffff',
        alpha: 0.32, source: '.atelier-claude-day-bar'},
    {selector: '& .atelier-claude-session-dot', property: 'background-color', kind: 'mark', color: '#ffffff',
        alpha: 0.45, source: '.atelier-claude-session-dot'},
    {selector: '& .atelier-claude-session-dot:active', property: 'background-color', kind: 'mark',
        color: '#57e389', source: '.atelier-claude-session-dot:active'},
];

/**
 * The inks on each kind of surface, as stylesheet.css (and the palette's
 * styles, shell/core/theme.js) set them, for type on Atelier's dark.
 *
 * - selector: where it is, '&' the surface's root (several: a list)
 * - property: what it colours (color unless said otherwise); template:
 *   how the colour goes into it ('{}' for the colour)
 * - kind: 'text' (pt, weight: as set), 'icon' (px), 'mark' (non-text that
 *   must be seen), 'fill' (a highlight under something: dark where the
 *   type is dark – or what is on a fill that is not faint, a capsule's
 *   level, light there) or 'keep' (on a colour of its own: stays as it is,
 *   whatever the rest does; value: what it is under type of either
 *   polarity, as the stylesheet writes it – GNOME's accent, say)
 * - always: its rule is written even where it is as set, while any other
 *   colour of the surface changes (over another ink's, as specific, that
 *   would reach it otherwise)
 * - over: the faint fill it lies on ({color, alpha}, or several, the
 *   lowest first: a tile's pill, a menu's), which turns dark under dark
 *   type as a 'fill' does – its type must read on it
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
    // toast, a notification, the switcher, Claude Code's usage. (Not the
    // control centre: controls.)
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
        // Claude Code's usage, from the bar.
        ...CLAUDE_INKS,
    ],
    // The control centre (.atelier-cc), a module at a time: GNOME's quick
    // settings, the tabs, a tile's menu, GNOME's notification list and
    // calendar, the notes, Claude Code's usage, the extensions' icons – as
    // stylesheet.css restyles them for the island's glass. Their faint
    // pills turn dark under dark type as its highlights do; what is on the
    // accent keeps it, and the accent's own type. (The notifications'
    // cards are opaque, of their own: as they are.)
    //
    // The tabs' bar: the tab shown on a pill of its own.
    ccTabs: [
        {selector: '& .atelier-cc-tab', kind: 'text', pt: 9.5, weight: 700, color: '#ffffff', alpha: 0.65,
            source: '.atelier-cc-tab'},
        {selector: '& .atelier-cc-tab:hover', kind: 'text', pt: 9.5, weight: 700, color: '#ffffff',
            over: {color: '#ffffff', alpha: 0.08}, source: '.atelier-cc-tab:hover'},
        {selector: '& .atelier-cc-tab:checked', kind: 'text', pt: 9.5, weight: 700, color: '#ffffff',
            over: {color: '#ffffff', alpha: 0.14}, source: '.atelier-cc-tab:checked'},
        {selector: '& .atelier-cc-tab:hover', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.08, source: '.atelier-cc-tab:hover'},
        {selector: '& .atelier-cc-tab:checked', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.14, source: '.atelier-cc-tab:checked'},
    ],
    // A module of the Controls tab: its tiles – a round icon, the accent's
    // when on, its name and state beside it – their menus' arrows, the
    // system buttons, the sliders (their icons, handle and trough), the
    // brightness and volume capsules and Now Playing.
    ccModule: [
        {selector: '&', kind: 'text', pt: 10, weight: 400, color: '#ffffff', source: '.atelier-cc-module'},
        {selector: '& .atelier-cc-module-title', kind: 'text', pt: 10, weight: 700, color: '#ffffff',
            source: '.atelier-cc-module-title'},
        {selector: '& .quick-toggle', kind: 'text', pt: 10, weight: 700, color: '#ffffff',
            source: '.atelier-island .atelier-cc-mac .quick-toggle'},
        {selector: '& .quick-toggle .quick-toggle-title', kind: 'text', pt: 10, weight: 700, color: '#ffffff',
            source: '.atelier-cc-mac .quick-toggle .quick-toggle-title'},
        {selector: '& .quick-toggle .quick-toggle-subtitle', kind: 'text', pt: 9, weight: 400, color: '#ffffff',
            alpha: 0.72, source: '.atelier-cc-mac .quick-toggle .quick-toggle-subtitle'},
        {selector: '& .quick-toggle .quick-toggle-icon', kind: 'icon', px: 16, color: '#ffffff', over: ICON_PILL,
            source: '.atelier-island .atelier-cc-mac .quick-toggle .quick-toggle-icon'},
        {selector: '& .quick-toggle .quick-toggle-icon', property: 'background-color', kind: 'fill', ...ICON_PILL,
            source: '.atelier-island .atelier-cc-mac .quick-toggle .quick-toggle-icon'},
        {selector: '& .quick-toggle:hover', property: 'background-color', template: IMPORTANT, kind: 'fill',
            color: '#ffffff', alpha: 0.07, source: '.atelier-island .atelier-cc-mac .quick-toggle:hover'},
        {selector: '& .quick-toggle:active', property: 'background-color', template: IMPORTANT, kind: 'fill',
            color: '#ffffff', alpha: 0.12, source: '.atelier-island .atelier-cc-mac .quick-toggle:active'},
        {selector: ARROW, kind: 'icon', px: 14, color: '#ffffff', alpha: 0.75,
            source: '.atelier-island .atelier-cc-mac .quick-toggle-has-menu .quick-toggle-menu-button'},
        {selector: `${ARROW}:hover`, kind: 'icon', px: 14, color: '#ffffff', over: {color: '#ffffff', alpha: 0.1},
            source: '.atelier-island .atelier-cc-mac .quick-toggle-has-menu .quick-toggle-menu-button:hover'},
        {selector: `${ARROW}:hover`, property: 'background-color', template: IMPORTANT, kind: 'fill',
            color: '#ffffff', alpha: 0.1,
            source: '.atelier-island .atelier-cc-mac .quick-toggle-has-menu .quick-toggle-menu-button:hover'},
        // The system buttons (Screenshot, Settings, Lock, Power Off) on
        // their round pills.
        {selector: SYSTEM_BUTTON, kind: 'icon', px: 16, color: '#ffffff', over: {color: '#ffffff', alpha: 0.12},
            source: '.atelier-island .atelier-cc-mac .quick-settings-system-item .icon-button'},
        {selector: SYSTEM_BUTTON, property: 'background-color', template: IMPORTANT, kind: 'fill', color: '#ffffff',
            alpha: 0.12, source: '.atelier-island .atelier-cc-mac .quick-settings-system-item .icon-button'},
        {selector: `${SYSTEM_BUTTON}:hover`, property: 'background-color', template: IMPORTANT, kind: 'fill',
            color: '#ffffff', alpha: 0.2,
            source: '.atelier-island .atelier-cc-mac .quick-settings-system-item .icon-button:hover'},
        {selector: `${SYSTEM_BUTTON}:active`, property: 'background-color', template: IMPORTANT, kind: 'fill',
            color: '#ffffff', alpha: 0.26,
            source: '.atelier-island .atelier-cc-mac .quick-settings-system-item .icon-button:active'},
        // The sliders: their icons, the handle (their colour) and the
        // trough (dark under dark type: as seen as it is set).
        {selector: '& .quick-slider .icon-button', kind: 'icon', px: 16, color: '#ffffff',
            source: '.atelier-cc .quick-slider .icon-button'},
        {selector: '& .quick-slider .icon-button:hover', property: 'background-color', kind: 'fill',
            color: '#ffffff', alpha: 0.12, source: '.atelier-cc .quick-slider .icon-button:hover'},
        {selector: '& .slider', kind: 'mark', color: '#ffffff', source: '.atelier-cc .slider'},
        {selector: '& .slider', property: '-barlevel-background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.14, source: '.atelier-cc .slider'},
        {selector: '& .quick-slider .slider-bin:focus', property: 'background-color', kind: 'fill',
            color: '#ffffff', alpha: 0.06, source: '.atelier-cc .quick-slider .slider-bin:focus'},
        // Brightness and volume as capsules: the icon (and the chevron of
        // the outputs' menu) light on the glass; the fill, and the icon dark
        // on it, turning over with the type round them – a dark fill, the
        // icon light on it, under dark type.
        {selector: '& .atelier-cc-capsule-icon', kind: 'icon', px: 26, color: '#ffffff',
            source: '.atelier-cc-capsule-icon'},
        {selector: '& .atelier-cc-capsule-value', kind: 'text', pt: 15.75, weight: 700, color: '#ffffff',
            source: '.atelier-cc-capsule-value'},
        {selector: '& .atelier-cc-capsule-menu-icon', kind: 'icon', px: 14, color: '#ffffff',
            source: '.atelier-cc-capsule-menu-icon'},
        {selector: '& .atelier-cc-capsule-menu:hover', property: 'background-color', kind: 'fill',
            color: '#ffffff', alpha: 0.12, source: '.atelier-cc-capsule-menu:hover'},
        {selector: '& .atelier-cc-capsule-fill', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.92, source: '.atelier-cc-capsule-fill'},
        {selector: '& .atelier-cc-capsule-icon-filled', kind: 'fill', color: '#1b1b1b',
            source: '.atelier-cc-capsule-icon-filled'},
        {selector: '& .atelier-cc-capsule-menu-icon-filled', kind: 'fill', color: '#2c2c2e',
            source: '.atelier-cc-capsule-menu-icon-filled'},
        // Now Playing, and its place until something plays.
        {selector: '& .atelier-cc-media', kind: 'text', pt: 10.5, weight: 700, color: '#ffffff',
            source: '.atelier-cc-media'},
        {selector: '& .atelier-cc-media-title', kind: 'text', pt: 10.5, weight: 700, color: '#ffffff',
            source: '.atelier-cc-media-title'},
        {selector: '& .atelier-cc-media:idle .atelier-cc-media-title', kind: 'text', pt: 10.5, weight: 700,
            color: '#ffffff', alpha: 0.75, source: '.atelier-cc-media:idle .atelier-cc-media-title'},
        {selector: '& .atelier-cc-media-artist', kind: 'text', pt: 9.5, weight: 400, color: '#ffffff', alpha: 0.65,
            source: '.atelier-cc-media-artist'},
        {selector: '& .atelier-cc-media-art', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.14, source: '.atelier-cc-media-art'},
        {selector: '& .atelier-cc-media-art-icon', kind: 'icon', px: 30, color: '#ffffff', alpha: 0.75,
            over: {color: '#ffffff', alpha: 0.14}, source: '.atelier-cc-media-art-icon'},
        {selector: '& .atelier-cc-media-button', kind: 'icon', px: 18, color: '#ffffff',
            source: '.atelier-cc-media-button'},
        {selector: '& .atelier-cc-media-button:hover', property: 'background-color', kind: 'fill',
            color: '#ffffff', alpha: 0.12, source: '.atelier-cc-media-button:hover'},
        {selector: '& .atelier-cc-media-button:active', property: 'background-color', kind: 'fill',
            color: '#ffffff', alpha: 0.2, source: '.atelier-cc-media-button:active'},
        {selector: '& .atelier-cc-media-button:insensitive', kind: 'icon', px: 18, color: '#ffffff', alpha: 0.3,
            source: '.atelier-cc-media-button:insensitive'},
        {selector: '& .atelier-cc-media-placeholder-title', kind: 'text', pt: 10, weight: 700, color: '#ffffff',
            alpha: 0.7, source: '.atelier-cc-media-placeholder-title'},
        {selector: '& .atelier-cc-media-placeholder-art', property: 'background-color', kind: 'fill',
            color: '#ffffff', alpha: 0.12, source: '.atelier-cc-media-placeholder-art'},
        // On the accent, or on nothing of their own (last: as specific as
        // the type and the pills they are among, they come after them).
        {selector: '& .quick-toggle:checked .quick-toggle-icon', kind: 'keep', value: ACCENT.fg},
        {selector: '& .quick-toggle:checked .quick-toggle-icon', property: 'background-color', kind: 'keep',
            value: ACCENT.bg},
        {selector: ['& .atelier-cc-system .quick-toggle .quick-toggle-icon',
            '& .atelier-cc-wide .quick-toggle .quick-toggle-icon'], property: 'background-color', kind: 'keep',
        value: 'transparent'},
        {selector: ['& .atelier-cc-square .quick-toggle-has-menu .quick-toggle',
            '& .atelier-cc-square .quick-toggle-has-menu .quick-toggle:hover'], property: 'background-color',
        kind: 'keep', value: 'transparent !important'},
        ...SWITCH_INKS,
    ],
    // A tile's menu, as a page in place of the modules: its header (back,
    // its name, its switch), items (and their checkmarks), switches and
    // buttons.
    ccDetail: [
        {selector: '& .quick-toggle-menu', kind: 'text', pt: 11, weight: 400, color: '#ffffff',
            source: '.atelier-island .atelier-cc .quick-toggle-menu'},
        {selector: '& .atelier-cc-detail-back', kind: 'icon', px: 16, color: '#ffffff',
            source: '.atelier-cc-detail-back'},
        {selector: '& .atelier-cc-detail-back:hover', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.1, source: '.atelier-cc-detail-back:hover'},
        {selector: '& .atelier-cc-detail-title', kind: 'text', pt: 11, weight: 700, color: '#ffffff',
            source: '.atelier-cc-detail-title'},
        {selector: ['& .quick-toggle-menu .header .title', '& .background-app-item .title'], kind: 'text',
            pt: 11, weight: 700, color: '#ffffff', source: '.atelier-cc .quick-toggle-menu .header .title'},
        {selector: ['& .quick-toggle-menu .header .subtitle', '& .background-app-item .subtitle'],
            kind: 'text', pt: 9, weight: 400, color: '#ffffff',
            source: '.atelier-cc .quick-toggle-menu .header .subtitle'},
        {selector: ITEMS, kind: 'text', pt: 11, weight: 400, color: '#ffffff', source: '.atelier-cc .popup-menu-item'},
        {selector: ITEMS_LIT, kind: 'text', pt: 11, weight: 400, color: '#ffffff',
            over: {color: '#ffffff', alpha: 0.1}, source: '.atelier-cc .popup-menu-item:hover'},
        {selector: ITEMS_LIT, property: 'background-color', kind: 'fill', color: '#ffffff', alpha: 0.1,
            source: '.atelier-cc .popup-menu-item:hover'},
        {selector: ITEMS.map(item => `${item}:active`), property: 'background-color', kind: 'fill',
            color: '#ffffff', alpha: 0.16, source: '.atelier-cc .popup-menu-item:active'},
        {selector: ITEMS.map(item => `${item}:insensitive`), kind: 'text', pt: 11, weight: 400, color: '#ffffff',
            alpha: 0.5, source: '.atelier-cc .popup-menu-item:insensitive'},
        // (A note, insensitive too: as it is set, over the insensitive
        // items' colour, whatever that comes out as.)
        {selector: ['& .popup-inactive-menu-item', '& .popup-inactive-menu-item:insensitive'], kind: 'text',
            pt: 11, weight: 400, color: '#ffffff', always: true, source: '.atelier-cc .popup-inactive-menu-item'},
        {selector: '& .popup-sub-menu', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.06, source: '.atelier-cc .popup-sub-menu'},
        {selector: '& .device-subtitle', kind: 'text', pt: 9, weight: 400, color: '#ffffff', alpha: 0.55,
            source: '.atelier-cc .device-subtitle'},
        {selector: BUTTONS, kind: 'text', pt: 11, weight: 700, color: '#ffffff',
            over: {color: '#ffffff', alpha: 0.1}, source: '.atelier-cc .quick-toggle-menu .button'},
        {selector: BUTTONS, property: 'background-color', kind: 'fill', color: '#ffffff', alpha: 0.1,
            source: '.atelier-cc .quick-toggle-menu .button'},
        {selector: BUTTONS.map(button => `${button}:hover`), property: 'background-color', kind: 'fill',
            color: '#ffffff', alpha: 0.16, source: '.atelier-cc .quick-toggle-menu .button:hover'},
        {selector: BUTTONS.map(button => `${button}:active`), property: 'background-color', kind: 'fill',
            color: '#ffffff', alpha: 0.22, source: '.atelier-cc .quick-toggle-menu .button:active'},
        {selector: '& .popup-separator-menu-item .popup-separator-menu-item-separator',
            property: 'background-color', kind: 'fill', color: '#ffffff', alpha: 0.1,
            source: '.atelier-cc .popup-separator-menu-item .popup-separator-menu-item-separator'},
        // (A slider in a menu, an extension's.)
        {selector: '& .slider', kind: 'mark', color: '#ffffff', source: '.atelier-cc .slider'},
        {selector: '& .slider', property: '-barlevel-background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.14, source: '.atelier-cc .slider'},
        // On the accent (last).
        {selector: ['& .quick-toggle-menu .header .icon.active', '& .quick-toggle-menu .button:checked'],
            kind: 'keep', value: ACCENT.fg},
        {selector: ['& .quick-toggle-menu .header .icon.active', '& .quick-toggle-menu .button:checked'],
            property: 'background-color', kind: 'keep', value: ACCENT.bg},
        ...SWITCH_INKS,
    ],
    // Another tab, as one: GNOME's notification list and calendar, the
    // notes, Claude Code's usage, the extensions' icons.
    ccPane: [
        {selector: '&', kind: 'text', pt: 11, weight: 400, color: '#f4f4f5', source: '.atelier-cc'},
        // GNOME's notification list: its controls and placeholder on the
        // glass.
        {selector: '& .message-list-controls', kind: 'text', pt: 11, weight: 700, color: '#ffffff',
            source: '.atelier-cc .message-list-controls'},
        {selector: '& .message-list .message-list-placeholder', kind: 'text', pt: 15, weight: 700,
            color: '#ffffff', alpha: 0.45, source: '.atelier-cc .message-list .message-list-placeholder'},
        // GNOME's calendar, its events, clocks and weather, on their pills.
        {selector: CALENDAR, kind: 'text', pt: 11, weight: 400, color: '#ffffff', over: MENU,
            source: '.atelier-island .atelier-cc .calendar'},
        {selector: CALENDAR, property: 'background-color', template: IMPORTANT, kind: 'fill', ...MENU,
            source: '.atelier-island .atelier-cc .calendar'},
        {selector: CALENDAR.slice(1).map(part => `${part}:hover`), property: 'background-color',
            template: IMPORTANT, kind: 'fill', color: '#ffffff', alpha: 0.12,
            source: '.atelier-island .atelier-cc .datemenu-today-button:hover'},
        {selector: '& .calendar .calendar-month-header .calendar-month-label', template: IMPORTANT,
            kind: 'text', pt: 11, weight: 700, color: '#ffffff', over: MENU,
            source: '.atelier-cc .calendar .calendar-month-header .calendar-month-label'},
        {selector: ['& .calendar .calendar-day', '& .calendar .calendar-day-heading', '& .calendar .pager-button'],
            template: IMPORTANT, kind: 'text', pt: 9, weight: 400, color: '#ffffff', over: MENU,
            source: '.atelier-island .atelier-cc .calendar .calendar-day'},
        {selector: ['& .calendar .calendar-day:hover', '& .calendar .calendar-month-header .pager-button:hover'],
            property: 'background-color', template: IMPORTANT, kind: 'fill', color: '#ffffff', alpha: 0.1,
            source: '.atelier-island .atelier-cc .calendar .calendar-day:hover'},
        {selector: '& .calendar .calendar-day:selected', property: 'background-color', template: IMPORTANT,
            kind: 'fill', color: '#ffffff', alpha: 0.2,
            source: '.atelier-island .atelier-cc .calendar .calendar-day:selected'},
        {selector: '& .calendar .calendar-day.calendar-weekend', template: IMPORTANT, kind: 'text', pt: 9,
            weight: 400, color: '#ffffff', alpha: 0.6, over: MENU,
            source: '.atelier-island .atelier-cc .calendar .calendar-day.calendar-weekend'},
        {selector: ['& .calendar .calendar-day.calendar-other-month',
            '& .calendar .calendar-day.calendar-other-month.calendar-weekend'], template: IMPORTANT,
        kind: 'text', pt: 9, weight: 400, color: '#ffffff', alpha: 0.35, over: MENU,
        source: '.atelier-island .atelier-cc .calendar .calendar-day.calendar-other-month'},
        // The notes: their heading, buttons and the new one's tile (the
        // papers have colours of their own).
        {selector: '& .atelier-notes-heading', kind: 'text', pt: 13, weight: 800, color: '#ffffff',
            source: '.atelier-notes-heading'},
        {selector: '& .atelier-notes-button', kind: 'text', pt: 9.5, weight: 700, color: '#ffffff',
            over: {color: '#ffffff', alpha: 0.09}, source: '.atelier-notes-button'},
        {selector: '& .atelier-notes-button', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.09, source: '.atelier-notes-button'},
        {selector: ['& .atelier-notes-button:hover', '& .atelier-notes-button:focus'], property: 'background-color',
            kind: 'fill', color: '#ffffff', alpha: 0.17, source: '.atelier-notes-button:hover'},
        {selector: '& .atelier-note-new', kind: 'text', pt: 9.5, weight: 700, color: '#ffffff', alpha: 0.75,
            over: MENU, source: '.atelier-note-new'},
        {selector: '& .atelier-note-new', property: 'background-color', kind: 'fill', ...MENU,
            source: '.atelier-note-new'},
        {selector: ['& .atelier-note-new:hover', '& .atelier-note-new:focus'], kind: 'text', pt: 9.5, weight: 700,
            color: '#ffffff', over: {color: '#ffffff', alpha: 0.13}, source: '.atelier-note-new:hover'},
        {selector: ['& .atelier-note-new:hover', '& .atelier-note-new:focus'], property: 'background-color',
            kind: 'fill', color: '#ffffff', alpha: 0.13, source: '.atelier-note-new:hover'},
        {selector: '& .atelier-notes-empty', kind: 'text', pt: 10, weight: 400, color: '#ffffff', alpha: 0.5,
            source: '.atelier-notes-empty'},
        // The extensions' icons, on tiles of their own.
        {selector: ['& .atelier-ext-tile', '& .atelier-ext-tile .panel-button'], kind: 'icon', px: 20,
            color: '#ffffff', over: {color: '#ffffff', alpha: 0.08}, source: '.atelier-ext-tile'},
        {selector: '& .atelier-ext-tile', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.08, source: '.atelier-ext-tile'},
        {selector: '& .atelier-ext-tile:hover', property: 'background-color', kind: 'fill', color: '#ffffff',
            alpha: 0.15, source: '.atelier-ext-tile:hover'},
        {selector: '& .atelier-ext-label', kind: 'text', pt: 8.5, weight: 700, color: '#ffffff', alpha: 0.85,
            over: {color: '#ffffff', alpha: 0.08}, source: '.atelier-ext-label'},
        ...CLAUDE_INKS,
        // On the accent (last).
        {selector: '& .calendar .calendar-day.calendar-today', kind: 'keep', value: `${ACCENT.fg} !important`},
        {selector: '& .calendar .calendar-day.calendar-today', property: 'background-color', kind: 'keep',
            value: `${ACCENT.bg} !important`},
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

// Colours laid over one another, the lowest first.
const laid = (color, layers) => layers.reduce((under, {color: over, alpha}) =>
    mix(under, hexToRgb(over), clamp(alpha, 0, 1)), color);

/**
 * The glass over a colour, as Atelier's glass draws it on the GPU: what is
 * behind it, blurred, made lighter or darker by the glass's face
 * (lib/glassLook.js faceColor(): GNOME's style's, a small control's), then
 * darkened by its dim (the glass-dim setting's), as its shader does it; so
 * much of that as shows (a glass fading out lets the wallpaper through),
 * and what lies over the glass laid on in turn. In sRGB's values, as the
 * GPU mixes them. Only the flat middle of the glass: its lens, bevel,
 * glint and grain are at its edges, not under the type.
 *
 * @param {string} behind - '#rrggbb': the wallpaper there, blurred
 * @param {object|null} look - lib/glassLook.js lookOf() (dimmedLook());
 *   null: no glass (what is behind as it is)
 * @param {object} [options]
 * @param {boolean} [options.light] - GNOME's style is light
 * @param {number} [options.small] - how much a small control the surface
 *   is (lib/glassLook.js smallness())
 * @param {number} [options.strength] - how much of the glass shows, 0 … 1
 * @param {object[]} [options.layers] - laid over the glass (a card's
 *   colour, a wash): {color: '#rrggbb', alpha}, the lowest first
 * @returns {string} '#rrggbb'
 */
export function glassOver(behind, look, {light = false, small = 0, strength = 1, layers = []} = {}) {
    const under = hexToRgb(behind);
    let color = under;
    if (look) {
        const seen = under.map(v => v / 255);
        color = faceColor(seen, faceOf(look, {light}), {small}).map(v => v * 255);
        color = color.map(v => v * (1 - clamp(look.dim ?? 0, 0, 1)));
        color = mix(under, color, clamp(strength, 0, 1));
    }
    return rgbToHex(laid(color, layers));
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
 * How finely a backdrop is told apart (in sRGB's values, 0 … 255): a
 * surface moved a little, a clock a little wider, comes out the same –
 * its stylesheet made anew for nothing would restyle the whole shell.
 */
export const STEADY = 8;

// A colour to the nearest STEADY.
const steady = hex => rgbToHex(hexToRgb(hex).map(v => clamp(Math.round(v / STEADY) * STEADY, 0, 255)));

/**
 * @param {object} backdrop - backdropOf()
 * @returns {object} its colours to the nearest STEADY
 */
export function steadied(backdrop) {
    return {dark: steady(backdrop.dark), mean: steady(backdrop.mean), light: steady(backdrop.light)};
}

/**
 * How far type of a polarity falls short of reading on the glass: white
 * where the glass is lightest, or black where it is darkest.
 *
 * @param {object} backdrop - backdropOf() (steadied())
 * @param {string} polarity - 'light' or 'dark' type
 * @param {number} need - |Lc| (readingNeed())
 * @returns {number} |Lc| it lacks; 0: it reads
 */
export function shortfallOf(backdrop, polarity, need) {
    const dark = polarity === 'dark';
    const type = {color: dark ? '#000000' : '#ffffff'};
    return Math.max(0, need - lcOf(type, dark ? backdrop.dark : backdrop.light, polarity));
}

/**
 * Light type or dark, by how far each falls short of reading (shortfallOf()):
 * the one GNOME's style implies – light type in its dark style, dark in its
 * light one – unless the other falls short by more than POLARITY.margin
 * less. Once taken, the other stays while it falls short by more than
 * POLARITY.margin − POLARITY.hold less.
 *
 * @param {{light: number, dark: number}} short - how far each falls short
 * @param {object} [options]
 * @param {string} [options.prefer] - the polarity GNOME's style implies
 * @param {string|null} [options.was] - the polarity it had
 * @returns {string} 'light' or 'dark'
 */
export function polarityOf(short, {prefer = 'light', was = null} = {}) {
    const other = prefer === 'dark' ? 'light' : 'dark';
    const margin = was === other ? POLARITY.margin - POLARITY.hold : POLARITY.margin;
    return short[other] + margin < short[prefer] - 1e-9 ? other : prefer;
}

/**
 * @param {object} ink - one of INKS'
 * @param {object|null} [palette] - the palette (lib/palette.js buildPalette())
 * @returns {{color: string, alpha: number}} its colour as set
 */
export function designedOf(ink, palette = null) {
    // (One kept as the stylesheet writes it: as white.)
    const color = (ink.role ? palette?.dark?.[ink.role] ?? FALLBACK[ink.role] : ink.color) ?? '#ffffff';
    return {color: color.toLowerCase(), alpha: ink.alpha ?? 1};
}

/**
 * @param {object} fill - {color: '#rrggbb', alpha}: a highlight, a faint pill
 * @param {string} polarity - the type's over it
 * @returns {{color: string, alpha: number}} as it is under light type, as
 *   dark as it is light under dark type
 */
export function fillAs({color, alpha = 1}, polarity) {
    if (polarity !== 'dark')
        return {color, alpha};
    const [lightness, chroma, hue] = hexToOklch(color);
    return {color: oklchToHex([1 - lightness, chroma, hue]), alpha};
}

/**
 * @param {object} ink - one of INKS'
 * @param {string} behind - '#rrggbb': what is behind it, on the glass
 * @param {string} polarity - its type's
 * @returns {string} '#rrggbb': what is under it, its faint pills (over)
 *   laid on that as they are under type of that polarity
 */
export function underOf(ink, behind, polarity) {
    const over = [ink.over ?? []].flat();
    return over.length ? rgbToHex(laid(hexToRgb(behind), over.map(fill => fillAs(fill, polarity)))) : behind;
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
    // (On its pills as they are on Atelier's dark.)
    const set = lcOf(designed, underOf(ink, REFERENCE, 'light'), 'light');
    if (polarity === 'dark')
        return set;
    let own = MARK_LC;
    if (ink.kind === 'text')
        own = minimumLc(ink.pt * 4 / 3, ink.weight ?? 400);
    else if (ink.kind === 'icon')
        own = minimumLc(ink.px, ICON_WEIGHT);
    return Math.min(own, set);
}

/**
 * How much a surface's type must stand out to read, |Lc|: as much as its
 * most demanding text, icon or mark needs (needOf(): what its size and
 * weight need, no more than it is set to stand out), READ_LC at most. (Its
 * highlights, and what keeps a colour of its own, aside.)
 *
 * @param {string} inks - which of INKS
 * @param {object|null} [palette]
 * @returns {number} 0: nothing to read
 */
export function readingNeed(inks, palette = null) {
    let most = 0;
    for (const ink of INKS[inks] ?? []) {
        if (ink.kind === 'text' || ink.kind === 'icon' || ink.kind === 'mark')
            most = Math.max(most, Math.min(needOf(ink, designedOf(ink, palette)), READ_LC));
    }
    return most;
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
 * under light type, and as dark as it is light under dark type (fillAs()).
 * Measured on the backdrop's lighter tenth for light type, its darker one
 * for dark – with the faint pills it lies on over it (underOf()).
 *
 * @param {object} ink - one of INKS'
 * @param {object} backdrop - backdropOf()
 * @param {string} polarity - polarityOf()
 * @param {object|null} [palette]
 * @returns {{color: string, alpha: number}|{value: string}|null} its
 *   colour there (or, kept, its value as the stylesheet writes it); null:
 *   as it is set
 */
export function inkOn(ink, backdrop, polarity, palette = null) {
    const designed = designedOf(ink, palette);
    const [lightness, chroma, hue] = hexToOklch(designed.color);
    const dark = polarity === 'dark';
    // (One written as the stylesheet writes it – on the accent, say – in
    // either polarity: lighter type round it would reach it otherwise.)
    if (ink.kind === 'keep')
        return ink.value ? {value: ink.value} : (dark ? designed : null);
    if (ink.kind === 'fill')
        return dark ? fillAs(designed, polarity) : null;
    const need = needOf(ink, designed, polarity);
    const behind = underOf(ink, dark ? backdrop.dark : backdrop.light, polarity);
    const reads = (color, alpha) => lcOf({color, alpha}, behind, polarity) >= need;
    if (!dark && lcOf(designed, behind, polarity) >= need - SLACK)
        return ink.always ? designed : null;
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
    return same && !ink.always ? null : shown;
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
 * @param {string} [surface.polarity] - its type's (polarityOf())
 * @param {object|null} [palette]
 * @returns {string[]} a rule for each of its inks that is not as it is set
 */
// Whether an ink comes out as it is set.
const sameAs = (ink, {color, alpha}, palette) => {
    const designed = designedOf(ink, palette);
    return designed.color === color && designed.alpha === alpha;
};

export function surfaceRules({roots, scope, inks, backdrop, polarity = 'light'}, palette = null) {
    const rules = [];
    const shown = (INKS[inks] ?? []).map(ink => [ink, inkOn(ink, backdrop, polarity, palette)]);
    // (One written where it is as set only while another colour changes.)
    const changes = shown.some(([ink, ink2]) => ink2 && !ink2.value && !(ink.always && sameAs(ink, ink2, palette)));
    for (const [ink, color] of shown) {
        if (!color || (!changes && ink.always && sameAs(ink, color, palette)))
            continue;
        const selectors = [ink.selector].flat().flatMap(selector =>
            roots.map(root => selector.replaceAll('&', `${root}.${scope}`)));
        const value = color.value ?? (ink.template ?? '{}').replace('{}', cssColor(color));
        rules.push(`${selectors.join(',\n')} { ${ink.property ?? 'color'}: ${value}; }`);
    }
    return rules;
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
