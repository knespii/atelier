// The glass clock's material (shell/lockscreen/liquidGlass.js) drawn over
// wallpapers, next to the look before it, as pictures to look at: where the
// large glass clock stands at cell 13, 2 of a 2560×1440 monitor, its digits
// a stand-in for the clock's ("10:52" in Inter, stretched tall as the glass
// face stretches them). Each picture: before, the glass at rest, and the
// glass as a contrast plan may raise it (more opaque, more tint, a shadow).
// The backdrops are made as the shell makes them, and timed, as is drawing
// the digits. With no arguments, the wallpapers in Atelier's library and a
// synthetic one; or the pictures given.
//
//   gjs -m tools/render-glass.js [picture…]
//
// Into tests/output/glass-material/ (left out of git).

import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import System from 'system';

import {placement} from '../lib/depth.js';
import {GLASS, glassColor, glassTint} from '../lib/glassBackdrop.js';
import {glassDigits, lockTone, regionIn, regionStats} from '../lib/lockLook.js';
import {contrastRatio} from '../lib/palette.js';
import {wallpaperDir} from '../lib/paths.js';
import {cellOrigin, gridOrigin, pixelSize} from '../lib/widgets.js';
import {LiquidGlass, backdropSpec, loadBackdrop, makeBackdrop} from '../shell/lockscreen/liquidGlass.js';

const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
const OUTPUT = GLib.build_filenamev([ROOT, 'tests', 'output', 'glass-material']);
const MONITOR = [2560, 1440];
const SCALE = 1;
const STYLE = 'zoom';
// The user's lock screen: the large glass clock at cell 13, 2.
const [CLOCK_X, CLOCK_Y] = cellOrigin(13, 2, gridOrigin(...MONITOR));
const [CLOCK_W, CLOCK_H] = pixelSize('large');
const CLOCK = {x: CLOCK_X * SCALE, y: CLOCK_Y * SCALE, width: CLOCK_W * SCALE, height: CLOCK_H * SCALE};
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
// The glass as a contrast plan may raise it.
const RAISED = {tintAlpha: 0.62, opacity: 1, shadow: 1};
const REPAINTS = 120; // to time drawing the digits

const ms = since => (GLib.get_monotonic_time() - since) / 1000;

function savePixbufPng(pixbuf, path) {
    pixbuf.savev(path, 'png', [], []);
    return path;
}

// A wallpaper of the hardest kind: hard edges and every colour, fine
// stripes, lights on black and a white field.
function syntheticWallpaper(path) {
    const [width, height] = MONITOR;
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
    const canvas = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, REGION.width, REGION.height);
    canvas.fill(0x000000ff);
    picture.composite(canvas, 0, 0, REGION.width, REGION.height, shown.x - REGION.x, shown.y - REGION.y,
        shown.width / pw, shown.height / ph, GdkPixbuf.InterpType.HYPER, 255);
    savePixbufPng(canvas, file);
    // (The tone is picked from a 96×60 sample of a 16:10 thumbnail, as on the lock screen.)
    const scale = Math.max(400 / pw, 250 / ph);
    const cover = picture.scale_simple(Math.round(pw * scale), Math.round(ph * scale), GdkPixbuf.InterpType.BILINEAR);
    const thumb = cover.new_subpixbuf(Math.floor((cover.get_width() - 400) / 2), Math.floor((cover.get_height() - 250) / 2),
        400, 250).scale_simple(96, 60, GdkPixbuf.InterpType.BILINEAR);
    return {
        surface: Cairo.ImageSurface.createFromPNG(file),
        sample: {
            pixels: thumb.get_pixels(), channels: thumb.get_n_channels(), rowstride: thumb.get_rowstride(),
            width: thumb.get_width(), height: thumb.get_height(),
        },
    };
}

// The stand-in for the glass face's digits, laid out as clock.js lays
// them out in the clock's box.
function digits() {
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, CLOCK.width, CLOCK.height);
    const cr = new Cairo.Context(surface);
    const layoutAt = (size, text) => {
        const layout = PangoCairo.create_layout(cr);
        const font = Pango.FontDescription.from_string(FAMILY);
        font.set_weight(WEIGHT);
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
    const {stretch, y: level} = glassDigits(sampleInk.height, top, CLOCK.height, null);

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

// Today's glass (clock.js before the material): a light tint, more of it
// at the top, a bright rim and a soft shadow round it.
const TINT = [0.66, 0.44];
const RIM = [0.6, 0.14];
const SHADOW = [[16, 0.035], [9, 0.05], [4, 0.07]];

function paintBefore(cr, path, tone, {y, height}) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(tone.color.slice(i, i + 2), 16) / 255);
    const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4;
    const scale = SCALE;
    const [top, bottom] = [y, y + height];
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.pushGroup();
    cr.appendPath(path);
    for (const [lineWidth, alpha] of SHADOW) {
        if (dark)
            cr.setSourceRGBA(1, 1, 1, alpha * 1.4);
        else
            cr.setSourceRGBA(0, 0, 0, alpha);
        cr.setLineWidth(lineWidth * scale);
        cr.strokePreserve();
    }
    cr.setOperator(Cairo.Operator.DEST_OUT);
    cr.setSourceRGBA(0, 0, 0, 1);
    cr.fill();
    cr.popGroupToSource();
    cr.paint();

    cr.newPath();
    cr.appendPath(path);
    const tint = new Cairo.LinearGradient(0, top, 0, bottom);
    tint.addColorStopRGBA(0, r, g, b, TINT[0]);
    tint.addColorStopRGBA(1, r, g, b, TINT[1]);
    cr.setSource(tint);
    cr.fill();

    const rim = new Cairo.LinearGradient(0, top, 0, bottom);
    rim.addColorStopRGBA(0, 1, 1, 1, RIM[0] * (dark ? 0.5 : 1));
    rim.addColorStopRGBA(1, 1, 1, 1, RIM[1] * (dark ? 0.5 : 1));
    cr.pushGroup();
    cr.appendPath(path);
    cr.setSource(rim);
    cr.fill();
    cr.setOperator(Cairo.Operator.DEST_OUT);
    cr.translate(0, 1.6 * scale);
    cr.appendPath(path);
    cr.setSourceRGBA(0, 0, 0, 1);
    cr.fill();
    cr.identityMatrix();
    cr.popGroupToSource();
    cr.paint();
}

// One look: the sharp wallpaper, the date line in the tone, the digits
// drawn into a surface of the clock's size (as the face's drawing area
// is) and laid over it.
function render(sharp, shape, draw, tone) {
    const clock = new Cairo.ImageSurface(Cairo.Format.ARGB32, CLOCK.width, CLOCK.height);
    const ccr = new Cairo.Context(clock);
    const start = GLib.get_monotonic_time();
    draw(ccr);
    const took = ms(start);
    ccr.$dispose();

    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, REGION.width, REGION.height);
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
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, REGION.height + label);
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
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, w * 2, h * 2);
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
    // The tone as the lock screen picks it for the clock (dimmed as its
    // glass dims the wallpaper while the password is asked: 0.86).
    const rect = [CLOCK.x / MONITOR[0], CLOCK.y / MONITOR[1], CLOCK.width / MONITOR[0], CLOCK.height / MONITOR[1]];
    const stats = regionStats(sharp.sample, regionIn(rect, MONITOR[0] / MONITOR[1], 1.6));
    const tone = lockTone(stats, {dim: 0.86});

    const spec = backdropSpec({path, style: STYLE, monitor: MONITOR, scale: SCALE, dir: cache});
    let start = GLib.get_monotonic_time();
    const made = await makeBackdrop(spec);
    const making = ms(start);
    start = GLib.get_monotonic_time();
    const backdrop = await loadBackdrop(spec, null);
    const loaded = ms(start);

    const glass = new LiquidGlass();
    glass.backdrop = backdrop;
    const options = {bounds: shape.bounds, tone, at: [CLOCK.x, CLOCK.y], scale: SCALE, glyphBoxes: shape.glyphBoxes};
    const before = render(sharp.surface, shape, cr => paintBefore(cr, shape.path, tone, shape.bounds), tone);
    const rest = render(sharp.surface, shape, cr => glass.paint(cr, shape.path, options), tone);
    const raised = render(sharp.surface, shape, cr => glass.paint(cr, shape.path, {...options, ...RAISED}), tone);
    sideBySide([
        {name: 'before', surface: before.surface},
        {name: `glass (tint ${GLASS.tintAlpha}, opacity ${GLASS.opacity})`, surface: rest.surface},
        {name: `raised (tint ${RAISED.tintAlpha}, opacity ${RAISED.opacity}, shadow)`, surface: raised.surface},
    ], GLib.build_filenamev([OUTPUT, `${name}.png`]), name);
    closeUp(rest.surface, GLib.build_filenamev([OUTPUT, `${name}-close.png`]));

    // Drawing the digits again and again, as a change of them would.
    const repaint = draw => {
        const clock = new Cairo.ImageSurface(Cairo.Format.ARGB32, CLOCK.width, CLOCK.height);
        start = GLib.get_monotonic_time();
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
    const paintBeforeMs = repaint(cr => paintBefore(cr, shape.path, tone, shape.bounds));
    const paintGlassMs = repaint(cr => glass.paint(cr, shape.path, options));
    const paintRaisedMs = repaint(cr => glass.paint(cr, shape.path, {...options, ...RAISED}));

    const frosted = glass.behind({x: CLOCK.x + shape.bounds.x, y: CLOCK.y + shape.bounds.y,
        width: shape.bounds.width, height: shape.bounds.height});
    const tint = glassTint(tone, frosted);
    const around = stats.mean;
    const color = glassColor({frosted, tint, dark: tone.dark, behind: around});
    const raisedColor = glassColor({frosted, tint, dark: tone.dark, behind: around, ...RAISED});
    print(`${name}: tone ${tone.color}${tone.dark ? ' (dark)' : ''}, frosted ${frosted}, tint ${tint}; ` +
        `glass ${color} (WCAG contrast ${contrastRatio(color, around).toFixed(2)} with ${around}), ` +
        `raised ${raisedColor} (${contrastRatio(raisedColor, around).toFixed(2)})`);
    print(`    backdrop ${spec.size.width}×${spec.size.height}: made in ${making.toFixed(1)} ms` +
        `${made ? '' : ' (there already)'}, loaded in ${loaded.toFixed(1)} ms; ` +
        `drawing the digits: before ${paintBeforeMs.toFixed(2)} ms, glass ${paintGlassMs.toFixed(2)} ms, ` +
        `raised ${paintRaisedMs.toFixed(2)} ms`);
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

const shape = digits();
print(`digits: ${FAMILY} ${WEIGHT} at ${shape.fontSize} px, ${shape.stretch.toFixed(2)}× as tall, ` +
    `${Math.round(shape.bounds.width)}×${Math.round(shape.bounds.height)} px in a ${CLOCK.width}×${CLOCK.height} clock`);
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
