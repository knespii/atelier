// Signed distances to a glyph's outline, for the glass clock drawn on the
// GPU: a tile of texels per figure, each how far its middle is from the
// outline (below 0 inside), which the shader reads (a second texture:
// shell/core/glassShapeTexture.js) to draw the figure's glass – its lens,
// rim and halo – at any size near the one it was made for.
//
// From an outline (lib/glyphOutlines.js, stretched by lib/glyphStretch.js):
// its curves flattened into lines, finely enough that no line strays more
// than a tenth of a pixel from the curve; inside where the outline winds
// round a point (nonzero, as fonts and Cairo fill), told row by row from
// where the lines cross the row; how far, exactly, only for the texels
// within the band of a line (the rest are as far as the band) – a line of
// the outline of what is filled: not one where a contour lies over another
// (outlineLines()), which is no edge to see. From a mask
// instead (what Pango drew, for a font with no file to read): sdfFromMask(),
// an exact Euclidean distance transform.
//
// Texels are 2 device pixels apart (TEXEL): the shader's lookups between
// them are linear, and so is a distance near an edge.
//
// Encoded (encodeSdf()) as premultiplied RGBA bytes, as Cogl takes them
// unchanged (RGBA_8888_PRE: nothing converted, any value in each channel,
// whatever A says), each channel 128 at the outline:
//   R – the distance up to ±FAR px, FAR / 127 px a step;
//   G – the distance up to ±NEAR px, NEAR / 127 px a step: the one read
//     within NEAR_USED of the outline, where the edge is drawn;
//   B, A – the outward normal (towards more distance; x right, y down), as
//     128 + 127 × its x and y.
// In GLSL (SDF_GLSL): atelier_sdf_distance(texel) and
// atelier_sdf_normal(texel).

import {inkOf} from './glyphStretch.js';

/** Device pixels from one texel to the next. */
export const TEXEL = 2;
/** How far R tells the distance, px (and a tile's margin round the ink). */
export const FAR = 32;
/** How far G tells it, px. */
export const NEAR = 8;
// Nearer than this (as R tells it), G is the distance. (A lookup between
// texels mixes G of texels up to 1.5 texels away – 3 px – from it: none
// of them past NEAR, where G stops.)
const NEAR_USED = NEAR - 3;
// How far a flattened line may stray from its curve, px.
const TOLERANCE = 0.1;

export const SDF_GLSL = `
float atelier_sdf_distance(vec4 texel) {
    float near = (texel.g * 255.0 - 128.0) * ${(NEAR / 127).toFixed(8)};
    float far = (texel.r * 255.0 - 128.0) * ${(FAR / 127).toFixed(8)};
    return abs(far) < ${NEAR_USED.toFixed(1)} ? near : far;
}

vec2 atelier_sdf_normal(vec4 texel) {
    return (texel.ba * 255.0 - 128.0) / 127.0;
}
`;

/**
 * Where a glyph goes in a tile of its own: its ink and the band round it.
 *
 * @param {Array[]} commands - its outline (y up, font units)
 * @param {object} place
 * @param {number} place.scale - device pixels per font unit
 * @param {number} [place.scaleX] - and as much again across
 * @param {number} [place.texel] - device pixels per texel
 * @param {number} [place.band] - px round the ink
 * @returns {{width: number, height: number, x: number, y: number}} the
 *   tile's size in texels, and where the glyph's origin is in it (px from
 *   its top left, y down: x where the pen is, y the baseline)
 */
export function tileFor(commands, {scale, scaleX = 1, texel = TEXEL, band = FAR}) {
    const ink = inkOf(commands) ?? {x1: 0, y1: 0, x2: 0, y2: 0};
    const sx = scale * scaleX;
    return {
        width: Math.max(1, Math.ceil(((ink.x2 - ink.x1) * sx + 2 * band) / texel)),
        height: Math.max(1, Math.ceil(((ink.y2 - ink.y1) * scale + 2 * band) / texel)),
        x: band - ink.x1 * sx,
        y: band + ink.y2 * scale,
    };
}

// A cubic curve into lines: as many as keep each within TOLERANCE of it
// (the most a line strays is an eighth of the curve's largest second
// derivative over the square of their number).
function flattenCubic(out, x0, y0, x1, y1, x2, y2, x3, y3) {
    const ddx = Math.max(Math.abs(x0 - 2 * x1 + x2), Math.abs(x1 - 2 * x2 + x3));
    const ddy = Math.max(Math.abs(y0 - 2 * y1 + y2), Math.abs(y1 - 2 * y2 + y3));
    const n = Math.max(1, Math.ceil(Math.sqrt(0.75 * Math.hypot(ddx, ddy) / TOLERANCE)));
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        const u = 1 - t;
        const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        out.push(a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3);
    }
}

/**
 * An outline as lines, in px of a tile (y down), each contour closed.
 *
 * @param {Array[]} commands - y up, font units
 * @param {object} place - {scale, scaleX, x, y}: tileFor()'s x and y
 * @returns {Float64Array} x1, y1, x2, y2 of each line
 */
export function flattenOutline(commands, {scale, scaleX = 1, x = 0, y = 0}) {
    const sx = scale * scaleX;
    const lines = [];
    let points = [];
    const close = () => {
        for (let i = 2; i < points.length; i += 2)
            lines.push(points[i - 2], points[i - 1], points[i], points[i + 1]);
        const n = points.length;
        if (n >= 4 && (points[n - 2] !== points[0] || points[n - 1] !== points[1]))
            lines.push(points[n - 2], points[n - 1], points[0], points[1]);
        points = [];
    };
    for (const [op, ...v] of commands) {
        if (op === 'M') {
            close();
            points.push(x + v[0] * sx, y - v[1] * scale);
        } else if (op === 'L') {
            points.push(x + v[0] * sx, y - v[1] * scale);
        } else if (op === 'C' && points.length >= 2) {
            const n = points.length;
            flattenCubic(points, points[n - 2], points[n - 1], x + v[0] * sx, y - v[1] * scale,
                x + v[2] * sx, y - v[3] * scale, x + v[4] * sx, y - v[5] * scale);
        } else if (op === 'Z') {
            close();
        }
    }
    close();
    return Float64Array.from(lines);
}

// How many times lines (closed contours) wind round a point: nonzero
// inside.
function windingAt(lines, px, py) {
    let winding = 0;
    for (let s = 0; s < lines.length; s += 4) {
        const [ax, ay, bx, by] = [lines[s], lines[s + 1], lines[s + 2], lines[s + 3]];
        if ((ay <= py) !== (by <= py) && ax + (py - ay) * (bx - ax) / (by - ay) > px)
            winding += by > ay ? 1 : -1;
    }
    return winding;
}

/**
 * Of lines (closed contours), those on the outline of what they fill:
 * inside on one side, outside on the other – not where a contour lies over
 * another (a figure's stem through its foot, say: no edge there).
 *
 * @param {Float64Array} lines - flattenOutline()'s
 * @returns {Float64Array} the same way
 */
export function outlineLines(lines) {
    const kept = [];
    const step = 0.25;
    for (let s = 0; s < lines.length; s += 4) {
        const [ax, ay, bx, by] = [lines[s], lines[s + 1], lines[s + 2], lines[s + 3]];
        const length = Math.hypot(bx - ax, by - ay);
        if (length === 0)
            continue;
        const [mx, my] = [(ax + bx) / 2, (ay + by) / 2];
        const [nx, ny] = [-(by - ay) / length * step, (bx - ax) / length * step];
        if ((windingAt(lines, mx + nx, my + ny) !== 0) !== (windingAt(lines, mx - nx, my - ny) !== 0))
            kept.push(ax, ay, bx, by);
    }
    return Float64Array.from(kept);
}

/**
 * Signed distances to lines (closed contours), at the middles of a grid
 * of texels: how far to the outline of what they fill (outlineLines()).
 *
 * @param {Float64Array} lines - flattenOutline()'s
 * @param {object} grid
 * @param {number} grid.width - texels across
 * @param {number} grid.height - and down
 * @param {number} [grid.texel] - px from one to the next
 * @param {number} [grid.band] - px: farther is as far as this
 * @returns {Float32Array} by row, px, below 0 inside
 */
export function linesSdf(lines, {width, height, texel = TEXEL, band = FAR}) {
    const count = width * height;
    // The squared distance, in texels.
    const reach = band / texel;
    const reach2 = reach * reach;
    const nearest = new Float32Array(count).fill(reach2);
    // (In texels from here on: a texel's middle at i + 0.5.)
    const scaled = lines.map(v => v / texel);
    const crossings = Array.from({length: height}, () => []);
    for (let s = 0; s < scaled.length; s += 4) {
        const [ax, ay, bx, by] = [scaled[s], scaled[s + 1], scaled[s + 2], scaled[s + 3]];
        const dy = by - ay;
        // Where it crosses the rows' middles, and which way (half open: a
        // line ending on a row's middle crosses it once with the next).
        if (dy !== 0) {
            const [top, bottom] = dy > 0 ? [ay, by] : [by, ay];
            const first = Math.max(0, Math.ceil(top - 0.5));
            const last = Math.min(height - 1, Math.ceil(bottom - 0.5) - 1);
            for (let j = first; j <= last; j++)
                crossings[j].push(ax + (j + 0.5 - ay) * (bx - ax) / dy, dy > 0 ? 1 : -1);
        }
    }
    const outline = outlineLines(lines).map(v => v / texel);
    for (let s = 0; s < outline.length; s += 4) {
        const [ax, ay, bx, by] = [outline[s], outline[s + 1], outline[s + 2], outline[s + 3]];
        const dx = bx - ax;
        const dy = by - ay;
        // How far from it each texel within the band is: row by row, those
        // across from the part of it that is within the band of the row.
        const length2 = dx * dx + dy * dy;
        const inverse = length2 > 0 ? 1 / length2 : 0;
        const rowFirst = Math.max(0, Math.ceil(Math.min(ay, by) - reach - 0.5));
        const rowLast = Math.min(height - 1, Math.floor(Math.max(ay, by) + reach - 0.5));
        for (let j = rowFirst; j <= rowLast; j++) {
            const py = j + 0.5;
            let x1, x2;
            if (dy === 0) {
                [x1, x2] = ax < bx ? [ax, bx] : [bx, ax];
            } else {
                let t1 = (py - reach - ay) / dy;
                let t2 = (py + reach - ay) / dy;
                if (t1 > t2)
                    [t1, t2] = [t2, t1];
                t1 = Math.max(0, t1);
                t2 = Math.min(1, t2);
                if (t1 > t2)
                    continue;
                [x1, x2] = [ax + t1 * dx, ax + t2 * dx];
                if (x1 > x2)
                    [x1, x2] = [x2, x1];
            }
            const colFirst = Math.max(0, Math.ceil(x1 - reach - 0.5));
            const colLast = Math.min(width - 1, Math.floor(x2 + reach - 0.5));
            const row = j * width;
            const ry = py - ay;
            for (let i = colFirst; i <= colLast; i++) {
                const rx = i + 0.5 - ax;
                let t = (rx * dx + ry * dy) * inverse;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const ex = rx - t * dx;
                const ey = ry - t * dy;
                const d2 = ex * ex + ey * ey;
                if (d2 < nearest[row + i])
                    nearest[row + i] = d2;
            }
        }
    }
    // (The squared distances become the signed ones, in place: span by
    // span between where the row is crossed, inside or out.)
    const distances = nearest;
    for (let j = 0; j < height; j++) {
        const row = j * width;
        const across = crossings[j];
        // (Pairs [x, way], sorted by x.)
        const order = [];
        for (let k = 0; k < across.length; k += 2)
            order.push(k);
        order.sort((a, b) => across[a] - across[b]);
        let winding = 0;
        let i = 0;
        for (let next = 0; next <= order.length; next++) {
            // Up to the texel whose middle is past the next crossing.
            const end = next < order.length
                ? Math.min(width, Math.max(i, Math.ceil(across[order[next]] - 0.5))) : width;
            const sign = winding !== 0 ? -texel : texel;
            for (; i < end; i++) {
                const d2 = distances[row + i];
                distances[row + i] = d2 < reach2 ? Math.sqrt(d2) * sign : sign * reach;
            }
            if (next < order.length)
                winding += across[order[next] + 1];
        }
    }
    return distances;
}

/**
 * A glyph's signed distances, in a tile.
 *
 * @param {Array[]} commands - its outline (y up, font units), stretched as
 *   it is to be drawn
 * @param {object} place
 * @param {number} place.scale - device pixels per font unit
 * @param {number} [place.scaleX] - and as much again across
 * @param {number} [place.texel] - device pixels per texel
 * @param {number} [place.band] - px: farther is as far as this
 * @param {object} [place.tile] - {width, height, x, y}: tileFor()'s
 * @returns {{width: number, height: number, x: number, y: number, texel:
 *   number, band: number, distances: Float32Array}} the tile (as
 *   tileFor() has it) and its distances, by row, px, below 0 inside
 */
export function glyphSdf(commands, {scale, scaleX = 1, texel = TEXEL, band = FAR, tile = null}) {
    const {width, height, x, y} = tile ?? tileFor(commands, {scale, scaleX, texel, band});
    const lines = flattenOutline(commands, {scale, scaleX, x, y});
    return {width, height, x, y, texel, band, distances: linesSdf(lines, {width, height, texel, band})};
}

// The squared distance to the nearest point of a row of sites (f: 0 at a
// site, Infinity elsewhere – or a column's squared distances so far),
// Felzenszwalb and Huttenlocher's lower envelope of parabolas.
function transform1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0;
    z[0] = -Infinity;
    z[1] = Infinity;
    for (let q = 1; q < n; q++) {
        if (f[q] === Infinity)
            continue;
        if (f[v[k]] === Infinity) {
            v[k] = q;
            continue;
        }
        let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
            k--;
            s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++;
        v[k] = q;
        z[k] = s;
        z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
        while (z[k + 1] < q)
            k++;
        const dq = q - v[k];
        d[q] = f[v[k]] === Infinity ? Infinity : dq * dq + f[v[k]];
    }
}

// Each pixel's squared distance to the nearest pixel that is a site.
function squaredDistances(sites, width, height) {
    const n = Math.max(width, height);
    const [f, d, v, z] = [new Float64Array(n), new Float64Array(n), new Int32Array(n), new Float64Array(n + 1)];
    const grid = new Float64Array(width * height);
    for (let i = 0; i < width; i++) {
        for (let j = 0; j < height; j++)
            f[j] = sites[j * width + i] ? 0 : Infinity;
        transform1d(f, height, d, v, z);
        for (let j = 0; j < height; j++)
            grid[j * width + i] = d[j];
    }
    for (let j = 0; j < height; j++) {
        const row = j * width;
        for (let i = 0; i < width; i++)
            f[i] = grid[row + i];
        transform1d(f, width, d, v, z);
        for (let i = 0; i < width; i++)
            grid[row + i] = d[i];
    }
    return grid;
}

/**
 * Signed distances from a mask (what Pango drew): inside where it is at
 * least half covered; the outline half a pixel past the last pixel in.
 *
 * @param {Uint8Array} alpha - coverage, 0–255
 * @param {number} width - pixels across
 * @param {number} height - and down
 * @param {object} [options]
 * @param {number} [options.stride] - bytes from one row to the next
 * @param {number} [options.texel] - pixels per texel: a tile that many
 *   times smaller, each texel's distance its pixels' mean
 * @param {number} [options.band] - px: farther is as far as this
 * @returns {{width: number, height: number, x: number, y: number, texel:
 *   number, band: number, distances: Float32Array}} as glyphSdf()'s (x and
 *   y 0), distances in pixels of the mask
 */
export function sdfFromMask(alpha, width, height, {stride = width, texel = 1, band = FAR} = {}) {
    const inside = new Uint8Array(width * height);
    for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++)
            inside[j * width + i] = alpha[j * stride + i] >= 128 ? 1 : 0;
    }
    const toInside = squaredDistances(inside, width, height);
    const toOutside = squaredDistances(inside.map(v => 1 - v), width, height);
    const signed = new Float32Array(width * height);
    for (let k = 0; k < signed.length; k++) {
        const d = inside[k] ? -(Math.sqrt(toOutside[k]) - 0.5) : Math.sqrt(toInside[k]) - 0.5;
        signed[k] = Math.max(-band, Math.min(band, Number.isFinite(d) ? d : inside[k] ? -band : band));
    }
    const step = Math.max(1, Math.round(texel));
    if (step === 1)
        return {width, height, x: 0, y: 0, texel: 1, band, distances: signed};
    const [w, h] = [Math.ceil(width / step), Math.ceil(height / step)];
    const distances = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
            let sum = 0;
            let n = 0;
            for (let y = j * step; y < Math.min(height, (j + 1) * step); y++) {
                for (let x = i * step; x < Math.min(width, (i + 1) * step); x++, n++)
                    sum += signed[y * width + x];
            }
            distances[j * w + i] = sum / n;
        }
    }
    return {width: w, height: h, x: 0, y: 0, texel: step, band, distances};
}

/**
 * The bytes to upload (Cogl.PixelFormat.RGBA_8888_PRE, rows of width × 4).
 *
 * @param {object} sdf - glyphSdf()'s or sdfFromMask()'s
 * @returns {Uint8Array}
 */
export function encodeSdf({width, height, distances}) {
    // (Clamped and rounded as they are stored.)
    const bytes = new Uint8ClampedArray(width * height * 4);
    // Past the band, whole texels at once: no edge near, no normal.
    const texels = new Uint32Array(bytes.buffer);
    const [outside, inside] = [[128 + 127, 255, 128, 128], [128 - 127, 0, 128, 128]].map(v => new Uint32Array(Uint8Array.from(v).buffer)[0]);
    const [far, near] = [127 / FAR, 127 / NEAR];
    for (let j = 0; j < height; j++) {
        const row = j * width;
        // The normal by central differences (one-sided at the tile's edges).
        const up = j > 0 ? row - width : row;
        const down = j < height - 1 ? row + width : row;
        for (let i = 0; i < width; i++) {
            const k = row + i;
            const d = distances[k];
            if (d >= FAR || d <= -FAR) {
                texels[k] = d > 0 ? outside : inside;
                continue;
            }
            const left = i > 0 ? k - 1 : k;
            const right = i < width - 1 ? k + 1 : k;
            const nx = distances[right] - distances[left];
            const ny = distances[down + i] - distances[up + i];
            const length2 = nx * nx + ny * ny;
            const unit = length2 > 1e-12 ? 127 / Math.sqrt(length2) : 0;
            bytes[k * 4] = 128 + d * far;
            bytes[k * 4 + 1] = 128 + d * near;
            bytes[k * 4 + 2] = 128 + nx * unit;
            bytes[k * 4 + 3] = 128 + ny * unit;
        }
    }
    return new Uint8Array(bytes.buffer);
}

/**
 * A texel read back, as SDF_GLSL reads it.
 *
 * @param {number[]} texel - [r, g, b, a] bytes
 * @returns {{distance: number, normal: number[]}} px; [x, y]
 */
export function decodeTexel([r, g, b, a]) {
    const near = (g - 128) * NEAR / 127;
    const far = (r - 128) * FAR / 127;
    return {
        distance: Math.abs(far) < NEAR_USED ? near : far,
        normal: [(b - 128) / 127, (a - 128) / 127],
    };
}
