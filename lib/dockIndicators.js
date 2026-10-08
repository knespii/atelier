// How a dock marks its apps: the shapes of a running indicator in each
// style, the colour an icon is mostly of, the text of a badge. Pure
// functions, shared by the shell and the tests.

/**
 * The shapes to draw for an app's windows.
 *
 * @param {string} _style - from atelier.DockIndicator
 * @param {number} _n - how many windows
 * @param {number} _width - of the area to draw in
 * @param {number} _height
 * @param {string} _side - the dock's edge
 * @param {boolean} _focused - the app has the focus
 * @returns {object[]} rectangles and circles: {kind: 'rect'|'circle', x, y,
 *   width, height, radius}
 *
 * (For now none: GNOME's dot shows.)
 */
export function indicatorShapes(_style, _n, _width, _height, _side, _focused) {
    return [];
}

/**
 * The colour an icon is mostly of.
 *
 * @param {Uint8Array} _pixels - RGBA rows
 * @param {number} _width
 * @param {number} _height
 * @param {number} _rowstride
 * @param {number} _channels
 * @returns {number[]|null} [r, g, b], or null for none to speak of
 *
 * (For now none.)
 */
export function dominantColor(_pixels, _width, _height, _rowstride, _channels) {
    return null;
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
