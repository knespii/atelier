// How the lock screen's widgets look: the tone of their type, picked from
// the wallpaper behind each of them (a light or a dark tint of the
// palette's hue, legible on what is there), the font they are set in, and
// what the battery says. Pure functions, shared by the shell and the
// preferences.

import {hexToOklch, hexToRgb, luminance, oklchToHex, rgbToHex} from './palette.js';

/** How much contrast the type has with what is behind it, at least (WCAG's for text). */
export const LEGIBLE = 4.5;

/**
 * The fonts on offer: families (the first one installed is used; none: the
 * shell's own), the weight of the big digits and of the rest (null: as the
 * widget has them).
 */
export const FONTS = [
    {id: 'default', name: 'Default', families: [], display: null, text: null},
    {id: 'rounded', name: 'Rounded', display: 700, text: 600,
        families: ['Quicksand', 'Comfortaa', 'Nunito', 'Varela Round', 'M PLUS Rounded 1c', 'Baloo 2']},
    {id: 'serif', name: 'Serif', display: 500, text: 400,
        families: ['Noto Serif Display', 'Noto Serif', 'Source Serif 4', 'DejaVu Serif', 'Liberation Serif', 'Nimbus Roman']},
    {id: 'thin', name: 'Thin', families: [], display: 200, text: 400},
    {id: 'heavy', name: 'Heavy', families: [], display: 900, text: 800},
];

/**
 * @param {string} id - one of FONTS
 * @param {string[]|null} [installed] - the font families there are (null:
 *   taken as there)
 * @returns {{id: string, family: string|null, display: number|null, text: number|null, missing: boolean}}
 *   family null for the shell's own; missing when none of the option's
 *   families is installed (then the shell's own, in the option's weights)
 */
export function fontFor(id, installed = null) {
    const font = FONTS.find(f => f.id === id) ?? FONTS[0];
    const there = installed ? new Set(installed.map(name => name.toLowerCase())) : null;
    const family = font.families.find(name => !there || there.has(name.toLowerCase())) ?? null;
    return {
        id: font.id,
        family,
        display: font.display,
        text: font.text,
        missing: font.families.length > 0 && !family,
    };
}

/** @returns {boolean} whether it is a colour as the settings keep one: '#rrggbb' */
export const isColor = value => /^#[0-9a-f]{6}$/i.test(value ?? '');

/**
 * Where a part of the screen is in a sample of its wallpaper: the
 * wallpaper fills the screen (zoomed, cut to its middle), as GNOME shows
 * it by default.
 *
 * @param {number[]} rect - [x, y, width, height] on the screen, 0 … 1
 * @param {number} aspect - the screen's width over its height
 * @param {number} sampleAspect - the sample's
 * @returns {number[]} [x, y, width, height] in the sample, 0 … 1
 */
export function regionIn([x, y, width, height], aspect, sampleAspect) {
    let [sx, sy, sw, sh] = [0, 0, 1, 1];
    if (aspect > sampleAspect) {
        sh = sampleAspect / aspect;
        sy = (1 - sh) / 2;
    } else {
        sw = aspect / sampleAspect;
        sx = (1 - sw) / 2;
    }
    return [sx + x * sw, sy + y * sh, width * sw, height * sh];
}

/**
 * What there is in a part of a sample of the wallpaper.
 *
 * @param {object} sample - {pixels, channels, rowstride, width, height}
 * @param {number[]} region - [x, y, width, height] in it, 0 … 1
 * @returns {{mean: string, low: number, high: number, middle: number}|null}
 *   its average colour, and how light its darker and lighter tenths are
 *   and its middle (WCAG luminance); null if it has no pixels
 */
export function regionStats({pixels, channels, rowstride, width, height}, [x, y, w, h]) {
    const clampTo = (v, n) => Math.min(n - 1, Math.max(0, v));
    const [x1, y1] = [clampTo(Math.floor(x * width), width), clampTo(Math.floor(y * height), height)];
    const [x2, y2] = [clampTo(Math.ceil((x + w) * width) - 1, width), clampTo(Math.ceil((y + h) * height) - 1, height)];
    const lights = [];
    const sum = [0, 0, 0];
    for (let row = y1; row <= y2; row++) {
        for (let col = x1; col <= x2; col++) {
            const i = row * rowstride + col * channels;
            if (i + 2 >= pixels.length)
                continue;
            const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
            rgb.forEach((v, c) => (sum[c] += v));
            lights.push(luminance(rgbToHex(rgb)));
        }
    }
    if (lights.length === 0)
        return null;
    lights.sort((a, b) => a - b);
    const at = share => lights[Math.min(lights.length - 1, Math.floor(share * lights.length))];
    return {mean: rgbToHex(sum.map(v => v / lights.length)), low: at(0.1), high: at(0.9), middle: at(0.5)};
}

const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * The tone for type on a part of the wallpaper: a light or a dark tint of
 * the palette's hue, whichever stands out more, made lighter (or darker)
 * until it is legible there.
 *
 * @param {object|null} stats - regionStats(); null: nothing known (light)
 * @param {object} [options]
 * @param {string|null} [options.tint] - the palette's colour, whose hue
 *   tints the type (null: none)
 * @param {number} [options.dim] - how much of the wallpaper's light is left
 *   at most while the prompt is up (the glass): dark type must be legible
 *   then too
 * @returns {{color: string, dark: boolean, contrast: number}} the tone,
 *   whether it is dark, and its contrast with the part (dimmed, for a dark one)
 */
export function pickTone(stats, {tint = null, dim = 1} = {}) {
    const [, tintChroma, hue] = tint ? hexToOklch(tint) : [0, 0, 0];
    const chroma = Math.min(0.04, tintChroma);
    if (!stats)
        return {color: oklchToHex([0.97, chroma, hue]), dark: false, contrast: LEGIBLE};
    const middle = luminance(stats.mean);
    // Against the part, and as much against its lighter (darker) tenth.
    const behindLight = (middle + stats.high) / 2;
    const behindDark = (middle + stats.low) / 2 * dim;
    const tone = (dark, lightness) => {
        const color = oklchToHex([lightness, dark ? chroma * 1.2 : chroma, hue]);
        return {color, dark, contrast: ratio(luminance(color), dark ? behindDark : behindLight)};
    };
    let light = tone(false, 0.96);
    let dark = tone(true, 0.26);
    for (let l = 0.97; light.contrast < LEGIBLE && l <= 1.0001; l += 0.01)
        light = tone(false, Math.min(1, l));
    for (let l = 0.25; dark.contrast < LEGIBLE && l >= 0.08; l -= 0.01)
        dark = tone(true, l);
    // (Light type wins a tie: the lock screen's own is light.)
    return dark.contrast > light.contrast * 1.1 ? dark : light;
}

/**
 * @param {string} color - '#rrggbb', as chosen in the settings
 * @returns {{color: string, dark: boolean, contrast: null}}
 */
export function chosenTone(color) {
    return {color: color.toLowerCase(), dark: luminance(color) < 0.18, contrast: null};
}

// The parts of a widget whose type is quieter than the rest (they have a
// colour of their own on the desktop), drawn faces in the tone, and the big
// digits, set in the font's display weight.
const QUIET = ['atelier-widget-caption', 'atelier-widget-time-suffix', 'atelier-widget-weekday',
    'atelier-widget-placeholder', 'atelier-lock-quiet'];
const DRAWN = ['atelier-widget-face', 'atelier-lock-ring'];
const DISPLAY = ['atelier-widget-time', 'atelier-widget-stacked-hours', 'atelier-widget-stacked-minutes',
    'atelier-widget-day', 'atelier-lock-value'];
const QUIET_ALPHA = 0.72;

const rgba = (hex, alpha) => `rgba(${hexToRgb(hex).join(', ')}, ${alpha})`;

/**
 * @param {object|null} tone - pickTone() or chosenTone(); null: the widget's
 *   own colours (on a card)
 * @param {object} font - fontFor()
 * @returns {string} the inline style of a widget: its colour, a soft halo
 *   of the other polarity behind its type (a scrim of its own, wherever it
 *   goes) and its font
 */
export function widgetStyle(tone, font) {
    let style = '';
    if (tone) {
        const halo = tone.dark ? 'rgba(255, 255, 255, 0.36)' : 'rgba(0, 0, 0, 0.4)';
        style += `color: ${tone.color}; text-shadow: 0 1px 12px ${halo};`;
    }
    if (font.family)
        style += ` font-family: "${font.family}";`;
    return style.trim();
}

/**
 * @param {string[]} classes - a part's style classes
 * @param {object|null} tone - as for widgetStyle()
 * @param {object} font
 * @returns {string} its inline style ('' to leave it as it is)
 */
export function partStyle(classes, tone, font) {
    const has = list => classes.some(name => list.includes(name));
    let style = '';
    if (tone && has(QUIET))
        style += `color: ${rgba(tone.color, QUIET_ALPHA)};`;
    else if (tone && has(DRAWN))
        style += `color: ${tone.color};`;
    const weight = has(DISPLAY) ? font.display : font.text;
    if (weight)
        style += ` font-weight: ${weight};`;
    return style.trim();
}

/**
 * The battery, as GNOME's battery tile has it.
 *
 * @param {object|null} battery - {present, percentage, state (UPower's),
 *   title (GNOME's text: "82 %")}; null: none known
 * @returns {{shown: boolean, fraction: number, text: string, caption: string, charging: boolean}}
 */
export function batteryState(battery) {
    if (!battery?.present)
        return {shown: false, fraction: 0, text: '', caption: '', charging: false};
    const parsed = parseFloat(String(battery.title ?? '').replace(/[^\d.,]/g, '').replace(',', '.'));
    const percentage = Number.isFinite(battery.percentage) ? battery.percentage : parsed;
    const fraction = Number.isFinite(percentage) ? Math.min(1, Math.max(0, percentage / 100)) : 0;
    // UPower's states: 1 charging, 2 discharging, 4 fully charged, 5 waiting to charge.
    const charging = battery.state === 1;
    const caption = {1: 'Charging', 2: 'On battery', 4: 'Charged', 5: 'Plugged in'}[battery.state] ?? '';
    return {
        shown: true,
        fraction,
        text: battery.title || (Number.isFinite(percentage) ? `${Math.round(percentage)} %` : ''),
        caption,
        charging,
    };
}

/**
 * @param {string} summary - GWeather's temperature, e.g. "14 °C"
 * @returns {string} as the lock screen shows it: "14°"
 */
export function shortTemperature(summary) {
    return String(summary ?? '').replace(/\s*°\s*[CF]?$/, '°').trim();
}
