// How a dock marks its apps: the shapes of a running indicator in each
// style, the colour an icon is mostly of, the text of a badge. Pure
// functions, shared by the shell and the tests.

// Most marks stand for a window each, up to this many.
const MAX_MARKS = 4;
// BINARY counts the windows in four binary digits.
const BINARY_DIGITS = 4;

/**
 * The shapes to draw for an app's windows, at the edge of the area
 * towards the dock's edge (along a column for a dock at the left or the
 * right).
 *
 * @param {string} style - from atelier.DockIndicator
 * @param {number} n - how many windows
 * @param {number} width - of the area to draw in
 * @param {number} height
 * @param {string} side - the dock's edge
 * @param {boolean} focused - the app has the focus
 * @param {number} [border] - the width of the line around each shape
 * @returns {object[]} rectangles and circles: {kind: 'rect'|'circle', x, y,
 *   width, height, radius, shade}; a circle's x, y, width and height are
 *   those of the square around it; shade is how much of the colour (1 all
 *   of it, less darker)
 */
export function indicatorShapes(style, n, width, height, side, focused, border = 0) {
    if (n <= 0 || width <= 0 || height <= 0)
        return [];
    const across = side === 'LEFT' || side === 'RIGHT';
    // Drawn for a dock at the bottom: along its length, and away from the
    // edge; then turned to the side.
    const length = across ? height : width;
    const depth = across ? width : height;
    const shapes = flatShapes(style, n, length, border, focused);
    return shapes.map(shape => toSide(shape, side, length, depth));
}

// The shapes of a style for a dock at the bottom, with `along` the place
// along the edge and `away` the distance from it.
function flatShapes(style, n, length, border, focused) {
    const marks = Math.min(n, MAX_MARKS);
    const thin = Math.max(length / 20, border);
    const square = Math.max(length / 11, border);
    const spacing = Math.ceil(length / 18);
    const rect = (along, size, thickness, away = border, shade = 1) =>
        ({kind: 'rect', along, size, thickness, away, shade});
    const circle = (along, radius, away = border / 2) =>
        ({kind: 'circle', along, size: 2 * radius, thickness: 2 * radius, away, shade: 1});
    // A row of `count` marks `size` long, `gap` apart, in the middle.
    const row = (count, size, gap, make) => {
        const start = (length - count * size - (count - 1) * gap) / 2;
        return Array.from({length: count}, (_, i) => make(start + i * (size + gap), i));
    };

    switch (style) {
    case 'DOT': {
        const radius = Math.max(length / 26, border / 2);
        return row(1, 2 * radius, 0, along => circle(along, radius));
    }
    case 'DOTS': {
        const radius = Math.max(length / 22, border / 2);
        return row(marks, 2 * radius, radius + border, along => circle(along, radius));
    }
    case 'SQUARES':
        return row(marks, square, spacing, along => rect(along, square, square));
    case 'DASHES': {
        const dash = Math.floor(length / 4) - spacing;
        return row(marks, dash, spacing, along => rect(along, dash, thin));
    }
    case 'SEGMENTED': {
        const dash = (length - (marks - 1) * spacing) / marks;
        return row(marks, dash, spacing, along => rect(along, dash, thin));
    }
    case 'SOLID':
        return [rect(0, length, thin)];
    case 'CILIORA': {
        // A line, and a square for each window after the first.
        const line = length - (marks - 1) * 2 * thin;
        return [rect(0, line, thin),
            ...Array.from({length: marks - 1}, (_, i) => rect(line + thin + i * 2 * thin, thin, thin))];
    }
    case 'METRO': {
        if (n <= 1)
            return [rect(0, length, thin, 0)];
        // A bar with a darker end (shorter while the app has the focus),
        // a line darker still between them.
        const black = length / 48;
        const dark = (focused ? 2 : 10) / 48 * length;
        const bright = length - dark - black;
        return [rect(0, bright, thin, 0), rect(bright, black, thin, 0, 0.3), rect(bright + black, dark, thin, 0, 0.7)];
    }
    case 'BINARY': {
        // Up to 15 windows: a dot for each one and a dash for each nought.
        const digits = Math.min(n, 2 ** BINARY_DIGITS - 1).toString(2).padStart(BINARY_DIGITS, '0');
        return row(BINARY_DIGITS, square, spacing, (along, i) => digits[i] === '1'
            ? circle(along, square / 2)
            : rect(along, square, square / 3, border / 2 + square / 3));
    }
    default:
        return [];
    }
}

// A shape for a dock at the bottom, placed for the dock's side.
function toSide({kind, along, size, thickness, away, shade}, side, length, depth) {
    const shape = {kind, shade};
    if (kind === 'circle')
        shape.radius = size / 2;
    switch (side) {
    case 'TOP':
        return {...shape, x: along, y: away, width: size, height: thickness};
    case 'LEFT':
        return {...shape, x: away, y: along, width: thickness, height: size};
    case 'RIGHT':
        return {...shape, x: depth - away - thickness, y: along, width: thickness, height: size};
    default:
        return {...shape, x: along, y: depth - away - thickness, width: size, height: thickness};
    }
}

/**
 * The colour an icon is mostly of: its pixels averaged, the coloured
 * and opaque ones counting most, made about as bright and (unless
 * the icon is grey) as vivid as any other app's.
 *
 * @param {Uint8Array|number[]} pixels - rows of pixels, RGB or RGBA
 * @param {number} width
 * @param {number} height
 * @param {number} rowstride - bytes from one row to the next
 * @param {number} channels - 3 (RGB) or 4 (RGBA)
 * @returns {number[]|null} [r, g, b], 0–255, or null for none to speak of
 *   (no pixels, or all of them transparent)
 */
export function dominantColor(pixels, width, height, rowstride, channels) {
    if (!pixels || width <= 0 || height <= 0 || channels < 3)
        return null;
    // A large icon is read every few pixels.
    const step = Math.max(1, Math.floor(Math.max(width, height) / 64));
    let total = 0, red = 0, green = 0, blue = 0;
    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const i = y * rowstride + x * channels;
            const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]];
            const alpha = channels > 3 ? pixels[i + 3] : 255;
            const weight = alpha * (0.1 * 255 + 0.9 * (Math.max(r, g, b) - Math.min(r, g, b)));
            red += r * weight;
            green += g * weight;
            blue += b * weight;
            total += weight;
        }
    }
    if (total <= 0)
        return null;
    const [h, s] = rgbToHsv(red / total, green / total, blue / total);
    return hsvToRgb(h, s > 0.15 ? 0.65 : s, 0.9);
}

// Hue 0–360, saturation and value 0–1.
function rgbToHsv(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if (delta > 0) {
        if (max === r)
            h = 60 * (((g - b) / delta) % 6);
        else if (max === g)
            h = 60 * ((b - r) / delta + 2);
        else
            h = 60 * ((r - g) / delta + 4);
    }
    return [(h + 360) % 360, max > 0 ? delta / max : 0, max / 255];
}

function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = v - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map(value => Math.round((value + m) * 255));
}

/**
 * @param {number} n - a count
 * @returns {string} what its badge says ('' for none)
 */
export function badgeText(n) {
    if (!n || n <= 0)
        return '';
    return n > 99 ? '99+' : `${n}`;
}
