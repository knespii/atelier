// Where the dock goes on any edge of a monitor: its rectangle, where it is
// when it is away, the strip of the edge that brings it back, the room it
// keeps from windows, where an app dropped on it lands and where an app's
// name shows. Pure functions, shared by the shell and the tests.
//
// A side is 'TOP', 'RIGHT', 'BOTTOM' or 'LEFT'; a rectangle is
// {x, y, width, height}, in logical pixels of the stage.

// The icon sizes the dock picks from when its apps don't all fit.
export const ICON_SIZES = [16, 22, 24, 32, 40, 48, 56, 64];

/**
 * @param {string} side
 * @returns {boolean} whether a dock on it is a row (rather than a column)
 */
export function isHorizontal(side) {
    return side === 'TOP' || side === 'BOTTOM';
}

/**
 * @param {object} area - the rectangle of the monitor it is on
 * @param {string} side
 * @returns {number} how long that edge is
 */
const edgeLength = (area, side) => (isHorizontal(side) ? area.width : area.height);

/**
 * The dock's rectangle while it is shown: in the middle of the edge, a
 * margin away from it – or, in panel mode (extend), along all of it.
 *
 * @param {object} params
 * @param {object} params.area - the rectangle it is in
 * @param {string} params.side
 * @param {number} params.length - along the edge
 * @param {number} params.thickness - across it
 * @param {number} params.margin - between it and the edge
 * @param {boolean} [params.extend] - along all of the edge, at the edge
 * @returns {object} {x, y, width, height}
 */
export function dockRect({area, side, length, thickness, margin, extend = false}) {
    if (extend) {
        length = edgeLength(area, side);
        margin = 0;
    }
    if (isHorizontal(side)) {
        return {
            x: Math.round(area.x + (area.width - length) / 2),
            y: Math.round(side === 'TOP' ? area.y + margin : area.y + area.height - thickness - margin),
            width: Math.ceil(length),
            height: Math.ceil(thickness),
        };
    }
    return {
        x: Math.round(side === 'LEFT' ? area.x + margin : area.x + area.width - thickness - margin),
        y: Math.round(area.y + (area.height - length) / 2),
        width: Math.ceil(thickness),
        height: Math.ceil(length),
    };
}

/**
 * @param {object} area - the rectangle the dock is in
 * @param {string} side
 * @param {number} fraction - of the edge it may take, 0 to 1
 * @param {boolean} [extend] - panel mode: all of it
 * @returns {number} how long the dock may be
 */
export function maxLength(area, side, fraction, extend = false) {
    const length = edgeLength(area, side);
    return extend ? length : Math.floor(length * Math.min(1, Math.max(0, fraction)));
}

/**
 * The biggest icon size at which the apps fit in the room there is: the
 * size asked for, else the next smaller of ICON_SIZES (the smallest when
 * nothing fits; the size asked for when it is fixed, the dock scrolling).
 *
 * @param {object} params
 * @param {number} params.count - how many icons
 * @param {number} [params.extras] - room the rest takes (separators,
 *   padding, the pill), along the dock
 * @param {number} params.maxSize - the size asked for
 * @param {number} params.available - room along the dock
 * @param {number} [params.itemPadding] - room around each icon, both
 *   sides together
 * @param {number} [params.spacing] - between two items
 * @param {boolean} [params.fixed] - keep the size asked for
 * @returns {number} the size
 */
export function fitIconSize({count, extras = 0, maxSize, available, itemPadding = 0, spacing = 0, fixed = false}) {
    if (fixed || count === 0)
        return maxSize;
    const needed = size => count * (size + itemPadding) + Math.max(0, count - 1) * spacing + extras;
    const sizes = [maxSize, ...ICON_SIZES.filter(size => size < maxSize).reverse()];
    return sizes.find(size => needed(size) <= available) ?? sizes[sizes.length - 1];
}

/**
 * How far the dock moves to be away: off the screen, past its edge.
 *
 * @param {string} side
 * @param {number} thickness
 * @param {number} margin - between it and the edge
 * @returns {object} {x, y} to translate it by
 */
export function hiddenOffset(side, thickness, margin) {
    const distance = thickness + margin + 2;
    switch (side) {
    case 'TOP':
        return {x: 0, y: -distance};
    case 'LEFT':
        return {x: -distance, y: 0};
    case 'RIGHT':
        return {x: distance, y: 0};
    default:
        return {x: 0, y: distance};
    }
}

/**
 * The strip of the edge that brings the dock back, as long as the dock.
 *
 * @param {string} side
 * @param {object} monitor
 * @param {object} rect - the dock's, shown
 * @param {number} scale - the stage's scale factor
 * @returns {object} {x, y, width, height}
 */
export function edgeRect(side, monitor, rect, scale) {
    const thin = Math.max(1, Math.round(scale));
    switch (side) {
    case 'TOP':
        return {x: rect.x, y: monitor.y, width: rect.width, height: thin};
    case 'LEFT':
        return {x: monitor.x, y: rect.y, width: thin, height: rect.height};
    case 'RIGHT':
        return {x: monitor.x + monitor.width - thin, y: rect.y, width: thin, height: rect.height};
    default:
        return {x: rect.x, y: monitor.y + monitor.height - thin, width: rect.width, height: thin};
    }
}

/**
 * The pressure barrier at the edge, along the dock less a pixel at each
 * end (so it doesn't meet the hot corners), and the way it lets the
 * pointer through: back from the edge.
 *
 * @param {string} side
 * @param {object} monitor
 * @param {object} rect - the dock's, shown
 * @returns {object} {x1, y1, x2, y2, direction}, the direction a name of
 *   Meta.BarrierDirection
 */
export function barrierLine(side, monitor, rect) {
    if (isHorizontal(side)) {
        const y = side === 'TOP' ? monitor.y : monitor.y + monitor.height;
        return {
            x1: rect.x + 1, y1: y, x2: rect.x + rect.width - 1, y2: y,
            direction: side === 'TOP' ? 'POSITIVE_Y' : 'NEGATIVE_Y',
        };
    }
    const x = side === 'LEFT' ? monitor.x + 1 : monitor.x + monitor.width - 1;
    return {
        x1: x, y1: rect.y + 1, x2: x, y2: rect.y + rect.height - 1,
        direction: side === 'LEFT' ? 'POSITIVE_X' : 'NEGATIVE_X',
    };
}

/**
 * The room the dock keeps from windows while it always shows: from the
 * edge to its inner side and a margin more, along all of the edge (so
 * GNOME can tell which edge it is on).
 *
 * @param {string} side
 * @param {object} monitor
 * @param {object} rect - the dock's, shown
 * @param {number} margin - between the dock and the windows
 * @returns {object} {x, y, width, height}
 */
export function strutRect(side, monitor, rect, margin) {
    switch (side) {
    case 'TOP':
        return {x: monitor.x, y: monitor.y, width: monitor.width, height: rect.y + rect.height + margin - monitor.y};
    case 'LEFT':
        return {x: monitor.x, y: monitor.y, width: rect.x + rect.width + margin - monitor.x, height: monitor.height};
    case 'RIGHT': {
        const x = rect.x - margin;
        return {x, y: monitor.y, width: monitor.x + monitor.width - x, height: monitor.height};
    }
    default: {
        const y = rect.y - margin;
        return {x: monitor.x, y, width: monitor.width, height: monitor.y + monitor.height - y};
    }
    }
}

/**
 * Is the pointer on the dock, or between it and the edge that brought it?
 *
 * @param {string} side
 * @param {object} monitor
 * @param {object} rect - the dock's, shown
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function pointerInZone(side, monitor, rect, x, y) {
    const alongX = x >= rect.x && x < rect.x + rect.width;
    const alongY = y >= rect.y && y < rect.y + rect.height;
    switch (side) {
    case 'TOP':
        return alongX && y >= monitor.y && y < rect.y + rect.height;
    case 'LEFT':
        return alongY && x >= monitor.x && x < rect.x + rect.width;
    case 'RIGHT':
        return alongY && x >= rect.x && x < monitor.x + monitor.width;
    default:
        return alongX && y >= rect.y && y < monitor.y + monitor.height;
    }
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {boolean} whether two rectangles overlap (touching isn't)
 */
export function rectsOverlap(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width &&
        a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Where an app dropped on the dock goes among the pinned ones: before the
 * first whose middle is past the drop, in the way the row reads (right to
 * left in a right-to-left row).
 *
 * @param {string} side
 * @param {boolean} rtl - the text reads right to left
 * @param {Array<number|null>} centres - the middles of the pinned apps
 *   along the dock, in their order (null for one not in it)
 * @param {number} pos - the drop along the dock
 * @returns {number} the position among them
 */
export function dropIndex(side, rtl, centres, pos) {
    const reversed = rtl && isHorizontal(side);
    const index = centres.findIndex(centre => centre !== null && centre !== undefined &&
        (reversed ? centre < pos : centre > pos));
    return index < 0 ? centres.length : index;
}

/**
 * Where an app's name shows: beside its icon, on the side away from the
 * edge, within the stage.
 *
 * @param {string} side
 * @param {object} itemRect - the icon's item on the stage
 * @param {object} labelSize - {width, height}
 * @param {number} offset - between the item and the name
 * @param {object} stageSize - {width, height}
 * @returns {object} {x, y}
 */
export function labelPosition(side, itemRect, labelSize, offset, stageSize) {
    const clampX = x => Math.min(Math.max(0, x), stageSize.width - labelSize.width);
    const clampY = y => Math.min(Math.max(0, y), stageSize.height - labelSize.height);
    const x = clampX(itemRect.x + Math.floor((itemRect.width - labelSize.width) / 2));
    const y = clampY(itemRect.y + Math.floor((itemRect.height - labelSize.height) / 2));
    switch (side) {
    case 'TOP':
        return {x, y: itemRect.y + itemRect.height + offset};
    case 'LEFT':
        return {x: clampX(itemRect.x + itemRect.width + offset), y};
    case 'RIGHT':
        return {x: clampX(itemRect.x - labelSize.width - offset), y};
    default:
        return {x, y: itemRect.y - labelSize.height - offset};
    }
}

/**
 * The monitors with a dock: the main one first, then (on every monitor)
 * the others in their order.
 *
 * @param {object} params
 * @param {number} params.mainIndex - the main dock's monitor
 * @param {boolean} params.multi - a dock on every monitor
 * @param {number} params.count - how many monitors there are
 * @returns {number[]} their indices
 */
export function pickMonitors({mainIndex, multi, count}) {
    if (count <= 0)
        return [];
    const main = mainIndex >= 0 && mainIndex < count ? mainIndex : 0;
    if (!multi)
        return [main];
    return [main, ...Array.from({length: count}, (_, i) => i).filter(i => i !== main)];
}
