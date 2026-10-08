// The dock's magnification, as on a Mac – but the dock keeps its size: the
// icon under the pointer grows (and those beside it, less and less), the
// others move apart to make room, and the row is pressed back into the
// length it had – give or take a little at each end (the room around the
// icons inside the dock). Pure, shared by the shell and the tests.

/**
 * How much an icon grows at a distance from the pointer: smoothly from
 * all of it to nothing.
 *
 * @param {number} distance - from the pointer, in icons
 * @param {number} spread - how far the growing reaches, in icons
 * @returns {number} 0–1
 */
export function falloff(distance, spread) {
    const d = Math.abs(distance);
    if (spread <= 0 || d >= spread)
        return 0;
    return (Math.cos(Math.PI * d / spread) + 1) / 2;
}

/**
 * @param {object} params
 * @param {number[]} params.centers - of the icons along the dock, pixels,
 *   in order
 * @param {number} params.size - of an icon at rest, pixels
 * @param {number|null} params.pointer - where the pointer is along the
 *   dock, or null for nowhere near
 * @param {number} params.scale - how big the icon under the pointer gets
 *   (1.5 is half again)
 * @param {number} params.spread - how far the growing reaches, in icons
 * @param {number} [params.give] - how far the row may reach past its ends
 *   at rest, at each end, pixels
 * @returns {object} {scales, offsets}: for each icon, how big it is drawn
 *   and how far it moves along the dock, pixels
 */
export function magnify({centers, size, pointer, scale, spread, give = 0}) {
    const count = centers.length;
    if (pointer === null || count === 0 || scale <= 1 || size <= 0)
        return {scales: centers.map(() => 1), offsets: centers.map(() => 0)};
    const scales = centers.map(center => 1 + (scale - 1) * falloff((center - pointer) / size, spread));
    const widths = scales.map(s => s * size);
    // Laid out again with the grown icons, the gaps between them as they
    // were (separators, padding)...
    const start = centers[0] - size / 2;
    const grown = [start + widths[0] / 2];
    for (let i = 1; i < count; i++) {
        const gap = centers[i] - centers[i - 1] - size;
        grown.push(grown[i - 1] + widths[i - 1] / 2 + gap + widths[i] / 2);
    }
    // ...then pressed back into the length the row had (and the give at
    // each end), the icons at its ends as drawn, about its middle.
    const last = count - 1;
    const length = centers[last] + size / 2 - start;
    const span = grown[last] - grown[0];
    const room = length + 2 * give - widths[0] / 2 - widths[last] / 2;
    const press = span > 0 ? Math.min(1, Math.max(0, room) / span) : 1;
    const middle = start + length / 2;
    const first = middle + (widths[0] / 2 - widths[last] / 2 - span * press) / 2;
    const offsets = grown.map((center, i) => first + (center - grown[0]) * press - centers[i]);
    return {scales, offsets};
}
