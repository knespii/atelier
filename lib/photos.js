// The photos: one gallery of them, Atelier's own copies of the pictures
// added (in ~/.local/share/atelier/photos, whatever the profile), and each
// photo widget's choice of them – which, in what order, and how long each
// shows – kept with the widget in the layout (so each profile has its
// own). A photo is known by its file's name there, which starts with when
// it was added. Pure functions, shared by the shell, the preferences and
// the tests.

/** How many photos a widget takes turns with, at most. */
export const MAX_PHOTOS = 30;

/** How long each can show, in seconds: [seconds, name]. */
export const INTERVALS = [
    [5, '5 s'],
    [10, '10 s'],
    [30, '30 s'],
    [60, '1 min'],
];
export const DEFAULT_INTERVAL = 10;
const LONGEST_INTERVAL = 3600;
// Back in sight, a photo isn't gone at once: it shows this long at least, ms.
const MOMENT = 250;

/** Pixels of the small copies the galleries show (twice their tiles, for a screen at scale 2). */
export const GRID_THUMB = 192;

// A photo's name: when it was added (milliseconds, base 36), a few random
// letters, and its old name in short: "lk3j2a9x-4f9c1b-sunflower-hill.jpg".
const NAME = /^([0-9a-z]{6,12})-([0-9a-z]{6})-[0-9a-z-]*\.[0-9a-z]{2,5}$/;

/**
 * @param {string} name - of the picture added (its file's name)
 * @param {number} added - when, in milliseconds
 * @param {string} random - six letters or digits (base 36)
 * @param {string} [extension] - its kind ("jpg"); otherwise the name's
 * @returns {string} the name of its copy in the gallery
 */
export function photoName(name, added, random, extension = null) {
    const ext = (extension ?? /\.([A-Za-z0-9]{2,5})$/.exec(name)?.[1] ?? 'img').toLowerCase();
    const slug = name.replace(/\.[^.]+$/, '').toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'photo';
    return `${Math.max(0, Math.floor(added)).toString(36).padStart(8, '0')}-${random.toLowerCase().slice(0, 6).padEnd(6, '0')}-${slug}.${ext}`;
}

/**
 * @param {string[]} names - of the files in the gallery's folder
 * @returns {object[]} the photos, the first added first: {id, added}
 *   (their own names only: copies on their way in, say, are not)
 */
export function parseGallery(names) {
    return names
        .map(name => [name, NAME.exec(name)])
        .filter(([, match]) => match)
        .map(([name, match]) => ({id: name, added: parseInt(match[1], 36)}))
        .sort((a, b) => a.added - b.added || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * @param {*} photos - a widget's choice, as kept
 * @param {string[]|null} [known] - the photos in the gallery; null: any
 * @returns {string[]} it cleaned up: names of photos there are, each once,
 *   as many as a widget takes
 */
export function cleanSelection(photos, known = null) {
    if (!Array.isArray(photos))
        return [];
    const there = known ? new Set(known) : null;
    const seen = new Set();
    return photos.filter(id => typeof id === 'string' && id && (!there || there.has(id)) &&
        !seen.has(id) && seen.add(id)).slice(0, MAX_PHOTOS);
}

/**
 * A photo picked, or not any more.
 *
 * @param {string[]} photos - a widget's choice
 * @param {string} id
 * @param {number} [max]
 * @returns {string[]} without it if it was there; with it at the end if not
 *   (unless the choice is full)
 */
export function toggleSelection(photos, id, max = MAX_PHOTOS) {
    const chosen = cleanSelection(photos);
    if (chosen.includes(id))
        return chosen.filter(other => other !== id);
    return chosen.length < max ? [...chosen, id] : chosen;
}

/**
 * @param {string[]} photos - a widget's choice
 * @param {string[]} ids - photos to add, if not there already
 * @param {number} [max]
 * @returns {string[]} with them at the end, as many as fit
 */
export function addToSelection(photos, ids, max = MAX_PHOTOS) {
    const chosen = cleanSelection(photos);
    for (const id of ids) {
        if (chosen.length >= max)
            break;
        if (!chosen.includes(id))
            chosen.push(id);
    }
    return chosen;
}

/**
 * @param {string[]} photos - a widget's choice
 * @param {string|null} current - the one it shows
 * @returns {number} where the one after it is (the first after the last;
 *   the first when it shows none of them)
 */
export function nextIndex(photos, current) {
    if (photos.length === 0)
        return -1;
    const index = photos.indexOf(current);
    return index < 0 ? 0 : (index + 1) % photos.length;
}

/**
 * @param {object} entry - a photo widget's, in the layout
 * @returns {number} how long each of its photos shows, in seconds
 */
export function intervalOf(entry) {
    const seconds = Number(entry?.interval);
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, LONGEST_INTERVAL) : DEFAULT_INTERVAL;
}

/**
 * @param {number} interval - how long each photo shows, ms
 * @param {number} seen - how long this one has been in sight, ms
 * @returns {number} how much longer it shows, ms (a moment at least)
 */
export function timeLeft(interval, seen) {
    return Math.max(MOMENT, interval - Math.max(0, seen));
}

/**
 * A photo gone from the gallery is gone from every widget's choice.
 *
 * @param {object[]} layout - the widgets (lib/widgets.js)
 * @param {string} id - the photo
 * @returns {object[]} the layout without it; the same layout when no
 *   widget had it
 */
export function dropPhoto(layout, id) {
    if (!layout.some(entry => Array.isArray(entry.photos) && entry.photos.includes(id)))
        return layout;
    return layout.map(entry => (Array.isArray(entry.photos) && entry.photos.includes(id)
        ? {...entry, photos: entry.photos.filter(other => other !== id)} : entry));
}

/**
 * Whether a rectangle is all under others: every bit of it in one of them.
 *
 * @param {number[]} rect - [x, y, width, height]
 * @param {number[][]} over - rectangles over it, the same way
 * @returns {boolean}
 */
export function isCovered([x, y, width, height], over) {
    if (width <= 0 || height <= 0)
        return true;
    const [right, bottom] = [x + width, y + height];
    const cut = over.filter(([ox, oy, ow, oh]) => ow > 0 && oh > 0 && ox < right && ox + ow > x && oy < bottom && oy + oh > y);
    if (cut.length === 0)
        return false;
    // The rectangle cut along the others' edges, into pieces each of which
    // is all in one of them or out of all of them: its middle tells.
    const edges = (start, end, sides) => [...new Set([start, end, ...sides.filter(v => v > start && v < end)])]
        .sort((a, b) => a - b);
    const xs = edges(x, right, cut.flatMap(([ox, , ow]) => [ox, ox + ow]));
    const ys = edges(y, bottom, cut.flatMap(([, oy, , oh]) => [oy, oy + oh]));
    for (let i = 0; i + 1 < xs.length; i++) {
        const px = (xs[i] + xs[i + 1]) / 2;
        for (let j = 0; j + 1 < ys.length; j++) {
            const py = (ys[j] + ys[j + 1]) / 2;
            if (!cut.some(([ox, oy, ow, oh]) => px > ox && px < ox + ow && py > oy && py < oy + oh))
                return false;
        }
    }
    return true;
}
