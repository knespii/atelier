// The lock screen's typefaces: which font each choice in the settings is
// (Inter and Roboto Flex come with Atelier, in fonts/; the shell's own
// font, and the first rounded or serif one installed, are the system's),
// the axes the bundled ones have, and how heavy and wide each part of the
// lock screen is set: the big digits as the settings say (or as their
// clock face has them), the lines of text in the face's own weight. An
// instance's variations keep to the axes the font has, its optical size
// follows the size the text is drawn at, and a width the font can't make
// on an axis is left to a horizontal scale. Pure functions, shared by the
// shell and the preferences.

/**
 * @typedef {object} Axis - a variable font's axis: the values it takes
 * @property {number} min
 * @property {number} default
 * @property {number} max
 */

const axis = (min, value, max) => ({min, default: value, max});

/**
 * The typefaces on offer, as the settings' clock-font names them. Each
 * has its family (bundled) or the families to look for (the first one
 * installed is used; none: the shell's own), its file in fonts/ (null for
 * a system font: shell/core/fonts.js and lib/glyphOutlines.js find those)
 * and the axes it is known to have (null: not known before the file is
 * read).
 */
export const TYPEFACES = [
    {
        id: 'inter', name: 'Inter', families: ['Inter'], file: 'Inter.ttf',
        // (Its optical sizes: text from 14, display from 32.)
        axes: {wght: axis(100, 400, 900), opsz: axis(14, 14, 32)},
    },
    {
        id: 'flex', name: 'Roboto Flex', families: ['Roboto Flex'], file: 'RobotoFlex.ttf',
        axes: {
            wght: axis(100, 400, 1000), wdth: axis(25, 100, 151), opsz: axis(8, 14, 144),
            GRAD: axis(-200, 0, 150), slnt: axis(-10, 0, 0),
            XOPQ: axis(27, 96, 175), XTRA: axis(323, 468, 603), YOPQ: axis(25, 79, 135),
            YTAS: axis(649, 750, 854), YTDE: axis(-305, -203, -98), YTFI: axis(560, 738, 788),
            YTLC: axis(416, 514, 570), YTUC: axis(528, 712, 760),
        },
    },
    {id: 'default', name: 'Default', families: [], file: null, axes: null},
    {
        id: 'rounded', name: 'Rounded', file: null, axes: null,
        families: ['Quicksand', 'Comfortaa', 'Nunito', 'Varela Round', 'M PLUS Rounded 1c', 'Baloo 2'],
    },
    {
        id: 'serif', name: 'Serif', file: null, axes: null,
        families: ['Noto Serif Display', 'Noto Serif', 'Source Serif 4', 'DejaVu Serif', 'Liberation Serif', 'Nimbus Roman'],
    },
];

/**
 * The fonts from before the weight could be set: the shell's own, thin
 * or heavy (the big digits' weight, and the text's).
 */
export const LEGACY = {
    thin: {id: 'default', weight: 200, text: 400},
    heavy: {id: 'default', weight: 900, text: 800},
};

/**
 * How heavy and wide each part is set, unless the settings say otherwise
 * (clock-weight and clock-width 0): the glass clock's digits, the big
 * digits of the other faces (digital, stacked, the time beside hands, the
 * date's day) and the lines of text (dates, the weather, the battery).
 * Width in percent of the font's normal width.
 */
export const ROLES = {
    glass: {weight: 600, width: 90},
    digits: {weight: 800, width: 100},
    text: {weight: 600, width: 100},
};

/** The widths that can be asked for, in percent (Roboto Flex's narrowest to twice as wide). */
export const WIDTHS = {min: 25, max: 200};

// Inter's display cut (its optical size 32) as the family that has it,
// where the static Inter is installed: that one would otherwise be found
// for "Inter" at sizes over its own (see shell/core/fonts.js).
const INTER_DISPLAY = 'Inter Display';

/**
 * @param {string} id - clock-font: one of TYPEFACES, or thin/heavy
 * @param {string[]|null} [installed] - the font families there are (null:
 *   taken as there)
 * @returns {{id: string, name: string, family: string|null, file: string|null,
 *   axes: object|null, missing: boolean, legacy: object|null}} family null
 *   for the shell's own; missing when none of the families looked for is
 *   installed (then the shell's own); legacy {weight, text} for thin and
 *   heavy
 */
export function typefaceFor(id, installed = null) {
    const legacy = LEGACY[id] ?? null;
    const typeface = TYPEFACES.find(t => t.id === (legacy?.id ?? id)) ?? TYPEFACES[0];
    // (The bundled ones are there whatever is installed.)
    const there = installed && !typeface.file ? new Set(installed.map(name => name.toLowerCase())) : null;
    const family = typeface.families.find(name => !there || there.has(name.toLowerCase())) ?? null;
    return {
        id: typeface.id,
        name: typeface.name,
        family,
        file: typeface.file,
        axes: typeface.axes,
        missing: typeface.families.length > 0 && !family,
        legacy,
    };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * How heavy and wide a part is set.
 *
 * @param {object} typeface - typefaceFor()
 * @param {string} role - one of ROLES: 'glass', 'digits' or 'text'
 * @param {object} [chosen] - the settings: {weight: clock-weight, width:
 *   clock-width}, 0 for the part's own (they are the big digits'; the text
 *   keeps its own)
 * @returns {{weight: number, width: number}} wght 1–1000, width in percent
 *   (WIDTHS)
 */
export function styleFor(typeface, role, {weight = 0, width = 0} = {}) {
    const own = ROLES[role] ?? ROLES.text;
    if (role === 'text' || !ROLES[role])
        return {weight: typeface.legacy?.text ?? own.weight, width: own.width};
    return {
        weight: clamp(weight > 0 ? weight : typeface.legacy?.weight ?? own.weight, 1, 1000),
        width: clamp(width > 0 ? width : own.width, WIDTHS.min, WIDTHS.max),
    };
}

/**
 * An instance of a font: its variations, kept to its axes, and what is
 * left of the width as a horizontal scale.
 *
 * @param {object|null} axes - {tag: {min, default, max}}, the font's (as
 *   TYPEFACES or lib/glyphOutlines.js axesOf() have them); null when they
 *   aren't known (a system font not read): only the weight is said, which
 *   a font without the axis takes no notice of, and all of the width is
 *   the scale
 * @param {object} style
 * @param {number} style.weight - wght
 * @param {number} [style.width] - percent of the normal width
 * @param {number|null} [style.size] - how big the text is drawn, logical
 *   pixels: its optical size (none: the font's default, or what Pango
 *   makes of the point size)
 * @param {object} [style.extra] - {tag: value} of other axes (Roboto
 *   Flex's GRAD, say); those the font hasn't are left out
 * @returns {{variations: string, values: object, scaleX: number}} the
 *   variations as Pango and HarfBuzz take them ("wght=600,opsz=32"), the
 *   same as {tag: value}, and how much wider (or narrower) to draw it
 */
export function variationsFor(axes, {weight, width = 100, size = null, extra = {}}) {
    const values = {};
    const wide = clamp(width, WIDTHS.min, WIDTHS.max);
    let scaleX = wide / 100;
    if (!axes) {
        values.wght = Math.round(clamp(weight, 1, 1000));
    } else {
        // (Whole units: an instance is kept for each, and none of these
        // shows a difference smaller than that.)
        const put = (tag, value) => {
            const range = axes[tag];
            if (range && Number.isFinite(value))
                values[tag] = Math.round(clamp(value, range.min, range.max));
        };
        put('wght', weight);
        if (axes.wdth) {
            put('wdth', wide);
            scaleX = wide / values.wdth;
        }
        if (size !== null && size > 0)
            put('opsz', size);
        for (const [tag, value] of Object.entries(extra))
            put(tag, value);
    }
    const variations = Object.entries(values).map(([tag, value]) => `${tag}=${value}`).join(',');
    return {variations, values, scaleX: Math.round(scaleX * 1000) / 1000};
}

/**
 * The font of a label (St): the families to ask for, its weight, and its
 * variations, which St can't set from CSS (shell/core/fonts.js
 * setLabelFont() puts them over St's own font description).
 *
 * @param {object} typeface - typefaceFor()
 * @param {object} style - styleFor()
 * @param {number|null} [size] - the label's size, logical pixels (for the
 *   optical size; null: as Pango makes it)
 * @returns {{families: string[], weight: number, variations: string,
 *   scaleX: number, description: string}} families empty for the shell's
 *   own font; description as Pango.FontDescription.from_string() reads
 *   it, without a size (St's stays)
 */
export function labelFont(typeface, style, size = null) {
    const {variations, values, scaleX} = variationsFor(typeface.axes, {...style, size});
    let families = typeface.family ? [typeface.family] : [];
    // Large, Inter is set in its display cut: where the static Inter is
    // installed (as the fonts-inter package has it), its Inter Display
    // has it; elsewhere this Inter on its optical size axis.
    if (typeface.id === 'inter' && values.opsz >= typeface.axes.opsz.max)
        families = [INTER_DISPLAY, ...families];
    const weight = Math.round(clamp(style.weight, 1, 1000));
    const description = [families.join(','), `weight=${weight}`, variations && `@${variations}`]
        .filter(Boolean).join(' ');
    return {families, weight, variations, scaleX, description};
}
