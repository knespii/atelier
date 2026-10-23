// The lock screen's own fonts, Inter and Roboto Flex (fonts/), added to
// this process only – never installed – once in its life: to the font
// map St's labels are laid out with (Clutter's) and to the one Cairo's
// drawing takes (PangoCairo's default: an St.DrawingArea's, GTK's in the
// preferences). Pango can't take a font out again; they stay until the
// process ends, which is harmless: nothing else asks for them (where the
// static Inter is installed, that one is still found for "Inter" outside
// 14 to 32 points, the variable one's optical sizes: see lib/lockType.js).
// Without Pango's add_font_file() (before 1.56) there are none: labels set
// in them fall back to another font, and the glass clock reads them from
// the files all the same (lib/glyphOutlines.js).
//
// And a label's font with variations St can't set from CSS (it knows no
// font-variation-settings, and sets a label's font anew on each change of
// its style): holdLabelFont().
//
// (A Pango.Font from these files must not be asked its face, get_face():
// Pango 1.56 aborts the process on the variable font's own pattern, which
// has no style name. Neither GNOME Shell, St, Clutter nor GTK asks.)

import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {bundledFile} from '../../lib/glyphOutlines.js';
import {TYPEFACES} from '../../lib/lockType.js';

const BUNDLED = TYPEFACES.filter(t => t.file);

// The font maps the fonts are in.
const maps = new WeakSet();

/**
 * Add the bundled fonts to a font map, once (its families then have them).
 * Each map is given the files itself: they go into fontconfig's
 * configuration, which the maps share, but a map made and used before
 * (Clutter's) doesn't find them until it is told – and the files twice in
 * the configuration are still one family, its faces once.
 *
 * @param {Pango.FontMap} map
 * @returns {boolean} whether they are in it
 */
export function addFontsTo(map) {
    if (!map || maps.has(map))
        return Boolean(map);
    if (typeof map.add_font_file !== 'function')
        return false;
    try {
        for (const typeface of BUNDLED) {
            if (!map.add_font_file(bundledFile(typeface.file)))
                throw new Error(`${typeface.file} not taken`);
        }
    } catch (e) {
        console.warn(`Atelier: the lock screen's fonts can't be loaded: ${e.message}`);
        return false;
    }
    const there = BUNDLED.every(t => map.get_family(t.families[0]));
    if (there)
        maps.add(map);
    return there;
}

/**
 * The bundled fonts in every font map the lock screen's text uses: in the
 * shell St's (Clutter's) and PangoCairo's default; in the preferences
 * PangoCairo's default (GTK's). Once for each; call it as early as the
 * extension (or the preferences) starts.
 *
 * @returns {boolean} whether they are there
 */
export function registerFonts() {
    const found = [PangoCairo.FontMap.get_default()];
    // (In the shell: the stage's Pango context, which every actor's text shares.)
    const stage = globalThis.global?.stage;
    const clutter = stage?.get_pango_context?.().get_font_map?.();
    if (clutter && !found.includes(clutter))
        found.push(clutter);
    return found.map(map => addFontsTo(map)).every(Boolean);
}

/**
 * How big a label's text is, in logical pixels: as St set it (in points,
 * or absolute).
 *
 * @param {Clutter.Text} text
 * @param {Pango.FontDescription} font
 * @returns {number}
 */
function pixelsOf(text, font) {
    const size = font.get_size() / Pango.SCALE;
    if (font.get_size_is_absolute())
        return size;
    // (Clutter sets its resolution on its font map, with the text scaling.)
    const context = text.get_pango_context();
    const resolution = [PangoCairo.context_get_resolution(context), context.get_font_map().get_resolution?.()]
        .find(dpi => dpi > 0) ?? 96;
    return size * resolution / 72;
}

/**
 * Keep a label in a font St can't set (the variations of a variable
 * font): after each change of its style – when St sets its font anew –
 * the families, weight and variations given are put over St's font
 * description (its size and style stay St's).
 *
 * @param {St.Label} label
 * @param {Function|null} fontFor - (size: the label's size in logical
 *   pixels) => {families, weight, variations}, as lib/lockType.js
 *   labelFont() gives them; null to leave the label to St again
 */
export function holdLabelFont(label, fontFor) {
    label.disconnectObject(holdLabelFont);
    const text = label.clutter_text;
    if (!fontFor) {
        // (St's own font, as its style has it.)
        if (label.get_stage())
            text.set_font_description(label.get_theme_node().get_font());
        return;
    }
    const apply = () => {
        // (Not styled before it is on the stage: then.)
        if (!label.get_stage())
            return;
        const own = label.get_theme_node().get_font();
        const font = fontFor(pixelsOf(text, own));
        const desc = own.copy();
        if (font.families?.length)
            desc.set_family(font.families.join(','));
        if (font.weight)
            desc.set_weight(Math.round(font.weight));
        desc.set_variations(font.variations ?? '');
        text.set_font_description(desc);
    };
    // (After St's own handler, which sets its font: this over it.)
    label.connectObject('style-changed', apply, GObject.ConnectFlags.AFTER, holdLabelFont);
    apply();
}
