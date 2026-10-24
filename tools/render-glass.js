// The glass clock's material (shell/lockscreen/liquidGlass.js) drawn over
// wallpapers, in each of Atelier's glass variants (lib/glassLook.js:
// regular, clear and off, solid), as pictures to look at: on the lock
// screen the user has – a laptop's 2560×1600 panel at 150 % (GNOME's
// fractional scaling: the stage in logical pixels, 1704×1065, drawings in
// the panel's), the large glass clock at cell 13, 2 of its 34×20 grid –
// its digits a stand-in for the clock's ("10:52" in Inter, stretched tall
// as the glass face stretches them). Each as the lock screen's legibility
// plan has it (its APCA, lib/lockLook.js legibilityPlan(): a heavier
// weight, a shadow, more opaque glass; the digits measured as their glass
// comes out, glassInk() – solid ones as they are), and up close. The
// backdrops are made as the shell makes them, and timed, as is drawing the
// digits, in full and quickly. With no arguments, the wallpapers in
// Atelier's library and a synthetic one; or the pictures given.
//
//   gjs -m tools/render-glass.js [picture…]
//
// Into tests/output/glass-material/ (left out of version control).

import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import System from 'system';

import {placement} from '../lib/depth.js';
import {GLASS, glassColor, glassFor, glassTint, tintShown} from '../lib/glassBackdrop.js';
import {VARIANTS, lookOf} from '../lib/glassLook.js';
import {glassDigits, glassInk, legibilityPlan, lockTone, regionIn, regionStats} from '../lib/lockLook.js';
import {contrastRatio} from '../lib/palette.js';
import {wallpaperDir} from '../lib/paths.js';
import {cellOrigin, gridOrigin, pixelSize} from '../lib/widgets.js';
import {LiquidGlass, backdropSpec, loadBackdrop, makeBackdrop} from '../shell/lockscreen/liquidGlass.js';

const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
const OUTPUT = GLib.build_filenamev([ROOT, 'tests', 'output', 'glass-material']);
const MONITOR = [1704, 1065]; // logical pixels
const DENSITY = 1.502347469329834; // the panel's pixels per logical one
const SCALE = 1; // St's scale factor (1 with fractional scaling)
const STYLE = 'zoom';
// The user's lock screen: the large glass clock at cell 13, 2.
const [CLOCK_X, CLOCK_Y] = cellOrigin(13, 2, gridOrigin(...MONITOR));
const [CLOCK_W, CLOCK_H] = pixelSize('large');
const CLOCK = {x: CLOCK_X, y: CLOCK_Y, width: CLOCK_W, height: CLOCK_H};
// What of the monitor each picture shows: the clock and some room round it.
const ROOM = [150, 60];
const REGION = {
    x: CLOCK.x - ROOM[0], y: CLOCK.y - ROOM[1], width: CLOCK.width + 2 * ROOM[0], height: CLOCK.height + 2 * ROOM[1],
};
// As shell/lockscreen/clock.js has them.
const NARROW = 0.9;
const FILL = 0.98;
const SAMPLE = '00:00';
const DATE_GAP = 2;
const TEXT = '10:52';
const FAMILY = 'Inter';
const WEIGHT = 600;
const DATE_SIZE = 20; // 15pt, pixels
const REPAINTS = 120; // to time drawing the digits

const ms = since => (GLib.get_monotonic_time() - since) / 1000;

// A surface as St gives one to draw in: logical pixels, the panel's dense.
function surfaceOf(width, height) {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, Math.ceil(width * DENSITY), Math.ceil(height * DENSITY));
    surface.setDeviceScale(DENSITY, DENSITY);
    return surface;
}

function savePixbufPng(pixbuf, path) {
    pixbuf.savev(path, 'png', [], []);
    return path;
}

// A wallpaper of the hardest kind: hard edges and every colour, fine
// stripes, lights on black and a white field.
function syntheticWallpaper(path) {
    const [width, height] = [2560, 1600];
    const pixels = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 3;
            let rgb;
            if (x < width * 0.38) {
                // Diagonal bands of colour, thick and thin.
                const band = Math.floor((x + y) / (y < height / 2 ? 90 : 14)) % 6;
                rgb = [[230, 57, 70], [241, 250, 238], [69, 123, 157], [29, 53, 87], [255, 183, 3], [42, 157, 143]][band];
            } else if (x < width * 0.62) {
                // A checkerboard, black and white.
                rgb = (Math.floor(x / 36) + Math.floor(y / 36)) % 2 ? [250, 250, 250] : [12, 12, 12];
            } else if (y < height / 2) {
                // Lights on black.
                const lit = (Math.floor(x / 23) * 7 + Math.floor(y / 19) * 13) % 11 === 0 && x % 23 < 6 && y % 19 < 6;
                rgb = lit ? [255, 214, 140] : [6, 8, 18];
            } else {
                // A white field.
                rgb = [246, 244, 238];
            }
            pixels.set(rgb, i);
        }
    }
    const pixbuf = GdkPixbuf.Pixbuf.new_from_bytes(new GLib.Bytes(pixels), GdkPixbuf.Colorspace.RGB, false, 8,
        width, height, width * 3);
    return savePixbufPng(pixbuf, path);
}

// The part of the monitor the picture shows, sharp, as GNOME draws the
// wallpaper there.
function sharpRegion(path, file) {
    let picture = GdkPixbuf.Pixbuf.new_from_file(path);
    picture = picture.apply_embedded_orientation() ?? picture;
    const [pw, ph] = [picture.get_width(), picture.get_height()];
    const shown = placement(STYLE, MONITOR, [pw, ph]);
    const [width, height] = [Math.ceil(REGION.width * DENSITY), Math.ceil(REGION.height * DENSITY)];
    const canvas = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, width, height);
    canvas.fill(0x000000ff);
    picture.composite(canvas, 0, 0, width, height, (shown.x - REGION.x) * DENSITY, (shown.y - REGION.y) * DENSITY,
        shown.width * DENSITY / pw, shown.height * DENSITY / ph, GdkPixbuf.InterpType.HYPER, 255);
    savePixbufPng(canvas, file);
    const surface = Cairo.ImageSurface.createFromPNG(file);
    surface.setDeviceScale(DENSITY, DENSITY);
    // (The tone is picked from a 96×60 sample of a 16:10 thumbnail, as on the lock screen.)
    const scale = Math.max(400 / pw, 250 / ph);
    const cover = picture.scale_simple(Math.round(pw * scale), Math.round(ph * scale), GdkPixbuf.InterpType.BILINEAR);
    const thumb = cover.new_subpixbuf(Math.floor((cover.get_width() - 400) / 2), Math.floor((cover.get_height() - 250) / 2),
        400, 250).scale_simple(96, 60, GdkPixbuf.InterpType.BILINEAR);
    return {
        surface,
        sample: {
            pixels: thumb.get_pixels(), channels: thumb.get_n_channels(), rowstride: thumb.get_rowstride(),
            width: thumb.get_width(), height: thumb.get_height(),
        },
    };
}

// The stand-in for the glass face's digits, laid out as clock.js lays
// them out in the clock's box.
function digitShape(weight = WEIGHT) {
    const surface = surfaceOf(CLOCK.width, CLOCK.height);
    const cr = new Cairo.Context(surface);
    const layoutAt = (size, text) => {
        const layout = PangoCairo.create_layout(cr);
        const font = Pango.FontDescription.from_string(FAMILY);
        font.set_weight(weight);
        font.set_absolute_size(size * Pango.SCALE);
        layout.set_font_description(font);
        const features = new Pango.AttrList();
        features.insert(Pango.attr_font_features_new('tnum'));
        layout.set_attributes(features);
        layout.set_text(text, -1);
        return layout;
    };
    const [, sampleLogical] = layoutAt(100, SAMPLE).get_pixel_extents();
    const fontSize = Math.max(8, Math.floor(100 * CLOCK.width * FILL / (sampleLogical.width * NARROW)));
    const [sampleInk] = layoutAt(fontSize, SAMPLE).get_pixel_extents();
    const date = PangoCairo.create_layout(cr);
    const dateFont = Pango.FontDescription.from_string(FAMILY);
    dateFont.set_weight(600);
    dateFont.set_absolute_size(DATE_SIZE * SCALE * Pango.SCALE);
    date.set_font_description(dateFont);
    date.set_text('Thursday, October 23', -1);
    const [, dateLogical] = date.get_pixel_extents();
    const top = dateLogical.height + DATE_GAP * SCALE;
    const {stretch, y: level} = glassDigits(sampleInk.height, top, CLOCK.height);

    const layout = layoutAt(fontSize, TEXT);
    const [ink] = layout.get_pixel_extents();
    const [tx, ty] = [CLOCK.width / 2 - (ink.x + ink.width / 2) * NARROW, level - sampleInk.y * stretch];
    cr.save();
    cr.translate(tx, ty);
    cr.scale(NARROW, stretch);
    PangoCairo.layout_path(cr, layout);
    cr.restore();
    const path = cr.copyPath();
    const bounds = {x: tx + ink.x * NARROW, y: ty + ink.y * stretch, width: ink.width * NARROW, height: ink.height * stretch};
    const glyphBoxes = [];
    for (let i = 0; i < TEXT.length; i++) {
        const box = layout.index_to_pos(i);
        glyphBoxes.push({
            x: tx + box.x / Pango.SCALE * NARROW, y: bounds.y,
            width: box.width / Pango.SCALE * NARROW, height: bounds.height,
        });
    }
    cr.$dispose();
    return {path, bounds, glyphBoxes, fontSize, stretch, level, date, top};
}

// One look: the sharp wallpaper, the date line in the tone, the digits
// drawn into a surface of the clock's size (as the face's drawing area
// is) and laid over it.
function render(sharp, shape, draw, tone) {
    const clock = surfaceOf(CLOCK.width, CLOCK.height);
    const ccr = new Cairo.Context(clock);
    const start = GLib.get_monotonic_time();
    draw(ccr);
    const took = ms(start);
    ccr.$dispose();

    const surface = surfaceOf(REGION.width, REGION.height);
    const cr = new Cairo.Context(surface);
    cr.setSourceSurface(sharp, 0, 0);
    cr.paint();
    const [ox, oy] = [CLOCK.x - REGION.x, CLOCK.y - REGION.y];
    // The date line, as the face sets it (its shadow as widgetStyle() gives it).
    const [, dateLogical] = shape.date.get_pixel_extents();
    const [dx, dy] = [ox + (CLOCK.width - dateLogical.width) / 2, oy + shape.level - DATE_GAP - dateLogical.height];
    const [r, g, b] = [1, 3, 5].map(i => parseInt(tone.color.slice(i, i + 2), 16) / 255);
    cr.moveTo(dx, dy + 1);
    cr.setSourceRGBA(...(tone.dark ? [1, 1, 1, 0.3] : [0, 0, 0, 0.3]));
    PangoCairo.show_layout(cr, shape.date);
    cr.moveTo(dx, dy);
    cr.setSourceRGB(r, g, b);
    PangoCairo.show_layout(cr, shape.date);
    cr.setSourceSurface(clock, ox, oy);
    cr.paint();
    cr.$dispose();
    return {surface, took};
}

// Side by side, each under its name.
function sideBySide(looks, file, title) {
    const label = 30;
    const gap = 8;
    const width = looks.length * REGION.width + (looks.length - 1) * gap;
    const surface = surfaceOf(width, REGION.height + label);
    const cr = new Cairo.Context(surface);
    cr.setSourceRGB(0.12, 0.12, 0.13);
    cr.paint();
    looks.forEach(({name, surface: look}, i) => {
        const x = i * (REGION.width + gap);
        cr.setSourceSurface(look, x, label);
        cr.paint();
        const text = PangoCairo.create_layout(cr);
        text.set_font_description(Pango.FontDescription.from_string('Sans 11'));
        text.set_text(i === 0 ? `${title} – ${name}` : name, -1);
        cr.moveTo(x + 8, 6);
        cr.setSourceRGB(0.92, 0.92, 0.92);
        PangoCairo.show_layout(cr, text);
    });
    cr.$dispose();
    surface.writeToPNG(file);
}

// The middle of the look, twice as large: the edges up close.
function closeUp(look, file) {
    const [w, h] = [260, 200];
    const surface = surfaceOf(w * 2, h * 2);
    const cr = new Cairo.Context(surface);
    cr.scale(2, 2);
    cr.setSourceSurface(look, -(REGION.width / 2 - w / 2), -(CLOCK.y - REGION.y + 70));
    cr.getSource().setFilter(Cairo.Filter.NEAREST);
    cr.paint();
    cr.$dispose();
    surface.writeToPNG(file);
}

async function renderWallpaper(path, {cache, work}, shape) {
    const name = GLib.path_get_basename(path).replace(/\.[^.]+$/, '');
    const sharp = sharpRegion(path, GLib.build_filenamev([work, `${name}-sharp.png`]));
    // What is behind the digits, as the lock screen samples the wallpaper
    // (its thumbnail), the tone for them and what it takes them to read
    // there (dimmed as the prompt dims the wallpaper: 0.86).
    const ink = {x: CLOCK.x + shape.bounds.x, y: CLOCK.y + shape.bounds.y, width: shape.bounds.width,
        height: shape.bounds.height};
    const rect = [ink.x / MONITOR[0], ink.y / MONITOR[1], ink.width / MONITOR[0], ink.height / MONITOR[1]];
    const stats = regionStats(sharp.sample, regionIn(rect, MONITOR[0] / MONITOR[1], 400 / 250));
    const text = {size: shape.fontSize, weight: WEIGHT};
    const tone = lockTone(stats, {dim: 0.86, text});
    const around = stats.mean;
    const looks = [];
    const timings = [];
    for (const variant of VARIANTS) {
        const look = lookOf(variant);
        // The backdrop for the look (none for no glass), made as the shell
        // makes it.
        let backdrop = null;
        let made = '';
        if (look) {
            const spec = backdropSpec({path, style: STYLE, monitor: MONITOR, scale: SCALE, look, dir: cache});
            const start = GLib.get_monotonic_time();
            const fresh = await makeBackdrop(spec);
            made = `backdrop ${spec.size.width}×${spec.size.height} made in ${ms(start).toFixed(1)} ms` +
                `${fresh ? '' : ' (there already)'}`;
            backdrop = await loadBackdrop(spec, null);
        }
        // What it takes the digits to read there, as the lock screen's
        // board plans them (lib/lockLook.js: glass type measured as its
        // material comes out over the frost, glassInk(); no glass, solid).
        let frostedStats = null;
        if (backdrop) {
            const {monitor: [mw, mh], factor: [fx, fy], shift: [sx, sy]} = backdrop;
            frostedStats = regionStats(backdrop.sample,
                [(ink.x + sx / fx) / mw, (ink.y + sy / fy) / mh, ink.width / mw, ink.height / mh]);
        }
        const plan = legibilityPlan({...text, tone, stats, glass: look ? tintShown() : null, dim: 0.86,
            ink: look ? glassInk(tone, frostedStats, look) : null});
        const planned = {...glassFor(plan.glass), shadow: plan.shadow};
        const plannedShape = plan.weight === WEIGHT ? shape : digitShape(plan.weight);
        const glass = new LiquidGlass();
        glass.backdrop = backdrop;
        const options = {...planned, bounds: plannedShape.bounds, tone, at: [CLOCK.x, CLOCK.y], scale: SCALE,
            glyphBoxes: plannedShape.glyphBoxes, variant};
        const drawn = render(sharp.surface, plannedShape, cr => glass.paint(cr, plannedShape.path, options), tone);
        const said = [
            plan.weight !== WEIGHT && `weight ${plan.weight}`,
            plan.shadow && `shadow ${plan.shadow.alpha}`,
            look && planned.opacity !== GLASS.opacity && `opacity ${planned.opacity.toFixed(2)}`,
            look && planned.tintAlpha !== GLASS.tintAlpha && `tint ${planned.tintAlpha.toFixed(2)}`,
        ].filter(Boolean);
        const reads = `Lc ${plan.lc?.toFixed(0)} of ${plan.need?.toFixed(0)}`;
        looks.push({name: `${variant} (${reads}: ${said.join(', ') || 'as it is'})`, surface: drawn.surface});
        closeUp(drawn.surface, GLib.build_filenamev([OUTPUT, `${name}-${variant}-close.png`]));
        // Drawing the digits again and again, as a change of them would.
        const repaint = draw => {
            const clock = surfaceOf(CLOCK.width, CLOCK.height);
            const start = GLib.get_monotonic_time();
            for (let i = 0; i < REPAINTS; i++) {
                const cr = new Cairo.Context(clock);
                cr.setOperator(Cairo.Operator.CLEAR);
                cr.paint();
                cr.setOperator(Cairo.Operator.OVER);
                draw(cr);
                cr.$dispose();
            }
            return ms(start) / REPAINTS;
        };
        const paintMs = repaint(cr => glass.paint(cr, plannedShape.path, options));
        const sketchMs = repaint(cr => glass.sketch(cr, plannedShape.path, options));
        let colour = '';
        if (backdrop) {
            const frosted = glass.behind({x: ink.x, y: ink.y, width: ink.width, height: ink.height});
            const tint = glassTint(tone, frosted);
            const color = glassColor({frosted, tint, dark: tone.dark, ...planned, behind: around, look});
            const contrast = contrastRatio(color, around).toFixed(2);
            colour = `frosted ${frosted}, tint ${tint}, glass ${color} (WCAG ${contrast} with ${around}); `;
        }
        timings.push(`    ${variant}: ${colour}reaches Lc ${plan.reaches?.toFixed(1)}; ${made ? `${made}; ` : ''}` +
            `drawing the digits ${paintMs.toFixed(2)} ms, quickly ${sketchMs.toFixed(2)} ms`);
    }
    sideBySide(looks, GLib.build_filenamev([OUTPUT, `${name}.png`]), name);
    print(`${name}: tone ${tone.color}${tone.dark ? ' (dark)' : ''}, the wallpaper round the digits ${around}`);
    timings.forEach(line => print(line));
}

// The files in a folder.
function filesIn(path) {
    const dir = Gio.File.new_for_path(path);
    const files = [];
    const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null))
        files.push(dir.get_child(info.get_name()));
    return files.sort((a, b) => a.get_path().localeCompare(b.get_path()));
}

// The backdrops in a folder of their own, made anew each time (timed as
// the first time), the sharp parts of the wallpapers in another.
const cache = GLib.build_filenamev([OUTPUT, 'backdrops']);
const work = GLib.build_filenamev([OUTPUT, 'work']);
for (const dir of [OUTPUT, cache, work])
    GLib.mkdir_with_parents(dir, 0o755);
filesIn(cache).forEach(file => file.delete(null));

const pictures = ARGV.length > 0 ? [...ARGV]
    : [...filesIn(wallpaperDir()).map(file => file.get_path()),
        syntheticWallpaper(GLib.build_filenamev([work, 'synthetic.png']))];

const shape = digitShape();
print(`digits: ${FAMILY} ${WEIGHT} at ${shape.fontSize} px, ${shape.stretch.toFixed(2)}× as tall, ` +
    `${Math.round(shape.bounds.width)}×${Math.round(shape.bounds.height)} px in a ${CLOCK.width}×${CLOCK.height} clock ` +
    `at ${CLOCK.x}, ${CLOCK.y} of a ${MONITOR.join('×')} monitor (logical pixels; drawn ${DENSITY.toFixed(2)}× as dense)`);
let failed = false;
for (const path of pictures) {
    try {
        await renderWallpaper(path, {cache, work}, shape);
    } catch (e) {
        failed = true;
        printerr(`${path}: ${e.message}\n${e.stack}`);
    }
}
print(`\nPictures in ${OUTPUT}`);
System.exit(failed ? 1 : 0);
