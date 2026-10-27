// Sheets of pictures of the glass to compare, labelled, from what
// testGlassPictures (tools/shell-test.js) shoots with ATELIER_TEST_GLASS_SHEET:
// a reference (a screenshot of the glass to match) next to the specimens
// on each wallpaper, their rims four times as large, the knobs tried
// apart; the island at rest and in the glance, the bar's one island and
// its capsules, the dock – as they were (pictures from another checkout)
// and as they are now, in GNOME's dark style and its light one; the
// island growing into the glance, and the light leaning to the pointer.
//
// Usage: gjs -m tools/glass-sheet.js --now DIR [--before DIR]
//            [--reference PNG] [--zooms DIR] [--walls 0,1,2] [--names a,b,c]
//            [--title TEXT] --out DIR
// DIR: a run's glass-pictures; --zooms: the reference's rims, four times
// as large (ref-zoom-*.png); --names: what each wallpaper is called.

import Cairo from 'cairo';
import GLib from 'gi://GLib';

const BACKGROUND = [0.12, 0.12, 0.13];
const INK = [0.92, 0.92, 0.94];
const QUIET = [0.62, 0.62, 0.66];
const PAD = 16;
const LABEL = 22;
// Sheets no wider than this many pixels (each picture scaled down to fit).
const MOST_WIDTH = 3600;

function parse(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i += 2)
        options[argv[i].replace(/^--/, '')] = argv[i + 1];
    return options;
}

const exists = path => Boolean(path) && GLib.file_test(path, GLib.FileTest.EXISTS);

function load(path) {
    return exists(path) ? Cairo.ImageSurface.createFromPNG(path) : null;
}

// A cell: a picture (or none: a gap saying so), its label, how much larger
// (or smaller) it is drawn, a part of it only.
function cell(path, label, {scale = 1, crop = null, nearest = false} = {}) {
    const surface = load(path);
    const [width, height] = crop ? [crop[2], crop[3]] : surface ? [surface.getWidth(), surface.getHeight()] : [200, 60];
    return {surface, label, scale, crop, nearest, width: width * scale, height: height * scale, missing: !surface};
}

function text(cr, words, x, y, {size = 15, color = INK, bold = false} = {}) {
    cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, bold ? Cairo.FontWeight.BOLD : Cairo.FontWeight.NORMAL);
    cr.setFontSize(size);
    cr.setSourceRGB(...color);
    cr.moveTo(x, y);
    cr.showText(words);
}

/**
 * A sheet: rows of cells, each row with a title, written as a PNG.
 *
 * @param {string} path
 * @param {string} title
 * @param {object[]} rows - {title, cells}
 */
function sheet(path, title, rows) {
    rows = rows.filter(row => row.cells.some(c => !c.missing));
    if (rows.length === 0)
        return false;
    const rowWidth = row => row.cells.reduce((sum, c) => sum + c.width + PAD, PAD);
    const widest = Math.max(...rows.map(rowWidth));
    const fit = Math.min(1, MOST_WIDTH / widest);
    const rowHeight = row => (Math.max(...row.cells.map(c => c.height)) * fit) + LABEL + PAD;
    const width = Math.ceil(widest * fit);
    const height = Math.ceil(48 + rows.reduce((sum, row) => sum + rowHeight(row) + LABEL + 6, 0) + PAD);
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, width, height);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(...BACKGROUND);
    cr.paint();
    text(cr, title, PAD, 32, {size: 20, bold: true});
    let y = 48;
    for (const row of rows) {
        text(cr, row.title ?? '', PAD, y + 18, {size: 16, bold: true, color: QUIET});
        y += LABEL + 6;
        let x = PAD;
        for (const c of row.cells) {
            text(cr, c.label, x, y + 16, {size: 14});
            const top = y + LABEL;
            if (c.surface) {
                cr.save();
                cr.rectangle(x, top, c.width * fit, c.height * fit);
                cr.clip();
                cr.translate(x, top);
                cr.scale(c.scale * fit, c.scale * fit);
                const [cx, cy] = c.crop ? [c.crop[0], c.crop[1]] : [0, 0];
                cr.setSourceSurface(c.surface, -cx, -cy);
                if (c.nearest)
                    cr.getSource().setFilter(Cairo.Filter.NEAREST);
                cr.paint();
                cr.restore();
            } else {
                cr.setSourceRGB(0.25, 0.25, 0.27);
                cr.rectangle(x, top, c.width * fit, c.height * fit);
                cr.fill();
                text(cr, 'none', x + 8, top + 24, {size: 13, color: QUIET});
            }
            x += c.width * fit + PAD;
        }
        y += rowHeight(row);
    }
    surface.writeToPNG(path);
    cr.$dispose();
    return true;
}

// Where the specimens are in a picture of them (the JSON beside it), in
// the picture's pixels.
function specimensIn(dir, wall, picture) {
    const json = `${dir}/${wall}-specimens.json`;
    const surface = load(picture);
    if (!exists(json) || !surface)
        return null;
    const [, contents] = GLib.file_get_contents(json);
    const {area, rects} = JSON.parse(new TextDecoder().decode(contents));
    const density = surface.getWidth() / area[2];
    return rects.map(r => ({...r, x: r.x * density, y: r.y * density, width: r.width * density,
        height: r.height * density, density}));
}

function main(argv) {
    const options = parse(argv);
    const now = options.now;
    const before = options.before ?? null;
    const out = options.out;
    const walls = (options.walls ?? '0').split(',');
    const names = (options.names ?? '').split(',');
    const title = options.title ?? '';
    GLib.mkdir_with_parents(out, 0o755);
    const made = [];
    const styles = [['', 'dark style'], ['light-', 'light style']];
    const reference = options.reference ? cell(options.reference, 'iOS 26 Control Center (reference)') : null;

    walls.forEach((wall, i) => {
        const name = names[i] || `wallpaper ${wall}`;
        // The specimens next to the reference, and their rims up close.
        const rows = [];
        for (const [prefix, style] of styles) {
            const cells = ['regular', 'clear'].map(variant =>
                cell(`${now}/${wall}-${prefix}${variant}-specimens.png`, `${variant}, ${style}`));
            rows.push({title: `Specimens on ${name}, ${style}`, cells: reference && !prefix ? [reference, ...cells] : cells});
        }
        const picture = `${now}/${wall}-regular-specimens.png`;
        const spots = specimensIn(now, wall, picture);
        if (spots) {
            const zoom = (spot, [fx, fy], label) => {
                const side = 40 * spot.density;
                const crop = [Math.max(0, spot.x + spot.width * fx - side / 2), Math.max(0, spot.y + spot.height * fy - side / 2),
                    side, side];
                return cell(picture, label, {scale: 4 / spot.density, crop, nearest: true});
            };
            const [, , circle, capsule, , panel] = spots;
            const crops = [
                zoom(circle, [0.15, 0.15], '96 px circle, top left'),
                zoom(circle, [0.85, 0.85], 'bottom right'),
                zoom(capsule, [0.05, 0.5], 'capsule, left end'),
                zoom(panel, [0.04, 0.06], 'panel, corner'),
            ];
            const refs = ['tl', 'tr', 'capsule', 'bottom'].map(part =>
                cell(`${options.zooms}/ref-zoom-${part}.png`, `reference, ${part}`, {scale: 0.5}))
                .filter(c => !c.missing);
            rows.push({title: 'Rims, 4× (dark style, regular)', cells: crops});
            if (refs.length > 0)
                rows.push({title: 'The reference\'s rims, zoomed', cells: refs});
        }
        if (sheet(`${out}/specimens-${wall}.png`, `${title} Specimens – ${name}`, rows))
            made.push(`specimens-${wall}.png`);

        // As it was, and now: the island, the bar, the dock.
        const pair = (shot, label) => [
            ...(before ? [cell(`${before}/${wall}-${shot}.png`, `before: ${label}`)] : []),
            cell(`${now}/${wall}-${shot}.png`, `now: ${label}`),
        ];
        // The widgets' cards of glass: their dark fill over it, or none.
        const cards = styles.map(([prefix, style]) => ({
            title: `widgets, regular, ${style}`,
            cells: [
                ...(before ? [cell(`${before}/${wall}-${prefix}regular-widgets.png`, 'before: card fill', {scale: 0.75})] : []),
                cell(`${now}/${wall}-${prefix}regular-widgets.png`, 'now: the glassy card\'s dark fill on', {scale: 0.75}),
                cell(`${now}/${wall}-${prefix}regular-widgets-bare.png`, 'now: no fill, just glass', {scale: 0.75}),
            ],
        }));
        if (sheet(`${out}/widgets-${wall}.png`, `${title} Widgets – ${name}: card fill on or off`, cards))
            made.push(`widgets-${wall}.png`);
        const surfaces = [
            ['island', [['top', 'one island, notch, at rest'], ['glance', 'the glance']]],
            ['bar', [['top', 'one island, notch'], ['capsules', 'capsules, floating island']]],
            ['dock', [['dock', 'the dock']]],
        ];
        for (const [surface, shots] of surfaces) {
            const sheetRows = [];
            for (const [prefix, style] of styles) {
                for (const variant of ['regular', 'clear']) {
                    for (const [shot, label] of shots) {
                        sheetRows.push({title: `${label} – ${variant}, ${style}`,
                            cells: pair(`${prefix}${variant}-${shot}`, `${variant}, ${style}`)});
                    }
                }
            }
            if (sheet(`${out}/${surface}-${wall}.png`, `${title} ${surface} – ${name}: before and now`, sheetRows))
                made.push(`${surface}-${wall}.png`);
        }
    });

    // The knobs tried apart, the light leaning, the island growing.
    for (const wall of [...walls, 'stripes']) {
        const rows = [];
        for (const [prefix, style] of styles) {
            for (const knob of ['blur', 'depth', 'glint']) {
                const values = {blur: ['0', '2', '4'], depth: ['2', '3'], glint: ['30', '50', '70']}[knob];
                const label = v => ({blur: `blur σ ${v}`, depth: `depth ${v} × bevel`, glint: `glint 0.${v}`}[knob]);
                rows.push({title: `${knob}, ${style}`, cells: values.map(v =>
                    cell(`${now}/${wall}-${prefix}sweep-${knob}-${v}.png`, label(v)))});
            }
            rows.push({title: `the light leaning to the pointer, ${style}`, cells: [0, 1, 2].map(i =>
                cell(`${now}/${wall}-${prefix}lean-${i}.png`, ['pointer left', 'pointer above', 'pointer over'][i],
                    {scale: 2}))});
        }
        if (sheet(`${out}/sweeps-${wall}.png`, `${title} Knobs – ${wall}`, rows))
            made.push(`sweeps-${wall}.png`);
        const morph = styles.map(([prefix, style]) => ({
            title: `rest → glance, slowed down tenfold, ${style}`,
            cells: Array.from({length: 10}, (_, i) => cell(`${now}/${wall}-${prefix}morph-${i}.png`, `${i}`, {scale: 0.5})),
        }));
        if (sheet(`${out}/morph-${wall}.png`, `${title} The island growing – ${wall}`, morph))
            made.push(`morph-${wall}.png`);
    }
    print(made.map(file => `${out}/${file}`).join('\n'));
}

main(ARGV);
