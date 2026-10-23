import Pango from 'gi://Pango';

import {LEGACY, ROLES, TYPEFACES, WIDTHS, labelFont, styleFor, typefaceFor, variationsFor} from '../lib/lockType.js';
import {assert, assertEqual} from './util.js';

const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

export function testTypefaces() {
    assertEqual(TYPEFACES.map(t => t.id), ['inter', 'flex', 'default', 'rounded', 'serif'],
        'as the settings name them (clock-font)');
    const inter = typefaceFor('inter');
    assertEqual([inter.family, inter.file, inter.missing, inter.legacy], ['Inter', 'Inter.ttf', false, null]);
    assertEqual(Object.keys(inter.axes), ['wght', 'opsz'], 'Inter: weight and optical size');
    const flex = typefaceFor('flex', []);
    assertEqual([flex.family, flex.file, flex.missing], ['Roboto Flex', 'RobotoFlex.ttf', false],
        'a bundled font is there whatever is installed');
    assert(flex.axes.wdth.min === 25 && flex.axes.wdth.max === 151 && flex.axes.wght.max === 1000);
    assertEqual(typefaceFor('nonsense').id, 'inter', 'not known: the default, Inter');
    const shell = typefaceFor('default', ['Cantarell']);
    assertEqual([shell.family, shell.file, shell.axes, shell.missing], [null, null, null, false],
        'the shell\'s own font: no family, no file, its axes not known');
}

export function testLegacyFonts() {
    for (const [id, weight, text] of [['thin', 200, 400], ['heavy', 900, 800]]) {
        const typeface = typefaceFor(id);
        assertEqual(typeface.id, 'default', `${id}: the shell's own font`);
        assertEqual(typeface.legacy, LEGACY[id]);
        assertEqual(styleFor(typeface, 'glass').weight, weight, `${id}: its digits' weight`);
        assertEqual(styleFor(typeface, 'digits').weight, weight);
        assertEqual(styleFor(typeface, 'text').weight, text, `${id}: its text's`);
        assertEqual(styleFor(typeface, 'glass', {weight: 550}).weight, 550, 'a weight set wins');
    }
}

export function testInstalledFamilies() {
    assertEqual(typefaceFor('serif', ['Cantarell', 'DejaVu Serif', 'Noto Serif']).family, 'Noto Serif',
        'the first of its families installed');
    assertEqual(typefaceFor('rounded', ['quicksand']).family, 'Quicksand', 'whatever the case');
    const none = typefaceFor('rounded', ['Cantarell']);
    assert(none.family === null && none.missing, 'none installed: the shell\'s font');
    assertEqual(typefaceFor('serif').family, 'Noto Serif Display', 'not knowing what is there: the first');
}

export function testStyles() {
    const inter = typefaceFor('inter');
    assertEqual(styleFor(inter, 'glass'), ROLES.glass, 'the glass digits: 600, a little narrower');
    assertEqual(styleFor(inter, 'glass'), {weight: 600, width: 90});
    assertEqual(styleFor(inter, 'digits'), {weight: 800, width: 100}, 'the digital and stacked clocks');
    assertEqual(styleFor(inter, 'text'), {weight: 600, width: 100}, 'the lines of text');
    assertEqual(styleFor(inter, 'glass', {weight: 0, width: 0}), styleFor(inter, 'glass'), '0: the face\'s own');
    assertEqual(styleFor(inter, 'digits', {weight: 350, width: 120}), {weight: 350, width: 120});
    assertEqual(styleFor(inter, 'text', {weight: 350, width: 120}), ROLES.text, 'the text keeps its own');
    assertEqual(styleFor(inter, 'glass', {weight: 5000, width: 400}), {weight: 1000, width: WIDTHS.max},
        'kept to what can be asked for');
    assertEqual(styleFor(inter, 'glass', {width: 3}).width, WIDTHS.min);
    assertEqual(styleFor(inter, 'nonsense'), ROLES.text, 'not a part known: as text');
}

export function testVariations() {
    const inter = typefaceFor('inter').axes;
    const flex = typefaceFor('flex').axes;
    assertEqual(variationsFor(inter, {weight: 600, width: 90, size: 120}),
        {variations: 'wght=600,opsz=32', values: {wght: 600, opsz: 32}, scaleX: 0.9},
        'Inter: no width axis, so drawn narrower; large, its display cut');
    assertEqual(variationsFor(inter, {weight: 950, size: 20}).variations, 'wght=900,opsz=20',
        'kept to its axes; the optical size is the size in pixels');
    assertEqual(variationsFor(inter, {weight: 50, size: 9}).variations, 'wght=100,opsz=14');
    assertEqual(variationsFor(inter, {weight: 450.4}).variations, 'wght=450', 'no size: no optical size');
    assertEqual(variationsFor(flex, {weight: 800, width: 90, size: 200}),
        {variations: 'wght=800,wdth=90,opsz=144', values: {wght: 800, wdth: 90, opsz: 144}, scaleX: 1},
        'Roboto Flex: the width on its axis');
    const wide = variationsFor(flex, {weight: 400, width: 200});
    assert(wide.values.wdth === 151 && near(wide.scaleX, 1.325, 0.001), `what the axis can't make, drawn (${wide.scaleX})`);
    assertEqual(variationsFor(flex, {weight: 400, width: 10}).values.wdth, 25, 'no narrower than can be asked for');
    assertEqual(variationsFor(flex, {weight: 400, extra: {GRAD: 500, XXXX: 3}}).variations, 'wght=400,wdth=100,GRAD=150',
        'other axes kept to theirs, those it hasn\'t left out');
    assertEqual(variationsFor(null, {weight: 640, width: 80, size: 50}),
        {variations: 'wght=640', values: {wght: 640}, scaleX: 0.8},
        'axes not known: only the weight (a font without the axis takes no notice), the width drawn');
    assertEqual(variationsFor({}, {weight: 640}).variations, '', 'a font that isn\'t variable: none');
}

export function testLabelFonts() {
    const inter = typefaceFor('inter');
    const large = labelFont(inter, styleFor(inter, 'digits'), 48);
    assertEqual(large.families, ['Inter Display', 'Inter'],
        'large, Inter Display first (the static one\'s display cut, where it is installed)');
    assertEqual(large.description, 'Inter Display,Inter weight=800 @wght=800,opsz=32');
    const small = labelFont(inter, styleFor(inter, 'text'), 20);
    assertEqual([small.families, small.description], [['Inter'], 'Inter weight=600 @wght=600,opsz=20']);
    assertEqual(labelFont(typefaceFor('default'), styleFor(typefaceFor('default'), 'text'), 20).description,
        'weight=600 @wght=600', 'the shell\'s own: its family left as it is');
    const serif = labelFont(typefaceFor('serif', ['DejaVu Serif']), {weight: 500, width: 100});
    assertEqual(serif.description, 'DejaVu Serif weight=500 @wght=500');
    // As Pango reads it.
    const desc = Pango.FontDescription.from_string(large.description);
    assertEqual([desc.get_family(), desc.get_variations()], ['Inter Display,Inter', 'wght=800,opsz=32']);
    assert((desc.get_set_fields() & Pango.FontMask.SIZE) === 0, 'no size: the label\'s own stays');
    const flex = labelFont(typefaceFor('flex'), {weight: 700, width: 75}, 30);
    assertEqual([flex.description, flex.scaleX], ['Roboto Flex weight=700 @wght=700,wdth=75,opsz=30', 1]);
}
