// Other extensions that get in Atelier's way, each by one setting of
// theirs. Atelier keeps such a setting out of its way only once the user
// has said so in its preferences, puts back what was there when they
// unsay it, leaves a setting they change again themselves to them, and
// never turns an extension on or off.
//
// A rule keeps a key at a value ('keep'), or steps in only when the key
// has a value that collides ('guard'). The rules and what to do with a
// key are pure; the last part finds and writes other extensions' settings.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const onOff = value => (value ? 'on' : 'off');
const banners = ['top left', 'top middle', 'top right', 'bottom left', 'bottom middle', 'bottom right'];

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {string} uuid - of the other extension
 * @property {string} extension - its name
 * @property {string} schema - the settings schema the key is in
 * @property {string} key
 * @property {string} kind - 'keep' or 'guard'
 * @property {*} [value] - kept at, for 'keep'
 * @property {Function} [fix] - for 'guard': a value → the value it should
 *   have instead, or null when it may stay
 * @property {boolean} notice - whether Atelier tells once of the collision
 * @property {Function} label - a value → how the extension calls it
 * @property {string} title
 * @property {string} why - what goes wrong
 * @property {string} loses - what the user gives up
 */

/** @type {Rule[]} */
export const RULES = [
    {
        id: 'blur-my-shell-lock-screen',
        uuid: 'blur-my-shell@aunetx',
        extension: 'Blur my Shell',
        schema: 'org.gnome.shell.extensions.blur-my-shell.lockscreen',
        key: 'blur',
        kind: 'keep',
        value: false,
        notice: true,
        label: onOff,
        title: 'Its blur of the lock screen',
        why: 'Blur my Shell blurs the lock screen its own way, from the moment it locks, so Atelier\'s lock ' +
            'screen can\'t keep the wallpaper sharp until you type your password.',
        loses: 'Blur my Shell\'s lock screen blur: GNOME\'s comes back, and Atelier\'s lock screen leads it.',
    },
    {
        id: 'tiling-shell-snap-assistant',
        uuid: 'tilingshell@ferrarodomenico.com',
        extension: 'Tiling Shell',
        schema: 'org.gnome.shell.extensions.tilingshell',
        key: 'enable-snap-assist',
        kind: 'keep',
        value: false,
        notice: false,
        label: onOff,
        title: 'The snap assistant',
        why: 'As you drag a window, its strip of layouts comes down from under the top bar, and over the ' +
            'island while that is open.',
        loses: 'Picking a layout by dragging a window to the top; tiling at the screen\'s edges stays.',
    },
    {
        id: 'just-perfection-banners',
        uuid: 'just-perfection-desktop@just-perfection',
        extension: 'Just Perfection',
        schema: 'org.gnome.shell.extensions.just-perfection',
        key: 'notification-banner-position',
        kind: 'guard',
        fix: value => (value >= 3 && value <= 5 ? value - 3 : null),
        notice: true,
        label: value => banners[value] ?? String(value),
        title: 'Notification banners at the bottom',
        why: 'At the bottom, Just Perfection hides notifications its own way, which fails for those ' +
            'Atelier shows in the island.',
        loses: 'Banners at the bottom: they come at the top, on the same side.',
    },
    {
        id: 'just-perfection-osd',
        uuid: 'just-perfection-desktop@just-perfection',
        extension: 'Just Perfection',
        schema: 'org.gnome.shell.extensions.just-perfection',
        key: 'osd-position',
        kind: 'guard',
        fix: value => (value === 2 ? 0 : null),
        notice: true,
        label: value => (value === 0 ? 'GNOME\'s place' : value === 2 ? 'top middle' : `place ${value}`),
        title: 'Volume and brightness pop-ups at the top middle',
        why: 'There, they come up over the island.',
        loses: 'That place: they go back to GNOME\'s.',
    },
    {
        id: 'just-perfection-bar',
        uuid: 'just-perfection-desktop@just-perfection',
        extension: 'Just Perfection',
        schema: 'org.gnome.shell.extensions.just-perfection',
        key: 'top-panel-position',
        kind: 'guard',
        fix: value => (value === 1 ? 0 : null),
        notice: true,
        label: value => (value === 1 ? 'bottom' : 'top'),
        title: 'The top bar at the bottom',
        why: 'The island lives in the top bar: at the bottom, it would sit on the dock\'s edge.',
        loses: 'The bar at the bottom.',
    },
    {
        id: 'music-pill-place',
        uuid: 'dynamic-music-pill@andbal',
        extension: 'Dynamic Music Pill',
        schema: 'org.gnome.shell.extensions.dynamic-music-pill',
        key: 'target-container',
        kind: 'guard',
        fix: value => (value !== 0 ? 0 : null),
        notice: true,
        label: value => ['the dock', 'the bar\'s left', 'the bar\'s middle', 'the bar\'s right'][value] ?? String(value),
        title: 'The pill in the top bar',
        why: 'In the bar, Atelier\'s compact bar hides the pill, and the control centre can\'t take it in.',
        loses: 'The pill in the bar: it goes into the dock.',
    },
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {Rule} rule
 * @param {*} value - the key's value now
 * @returns {*} the value it should have, or undefined when it may stay
 */
export function wanted(rule, value) {
    if (rule.kind === 'keep')
        return same(value, rule.value) ? undefined : rule.value;
    const fixed = rule.fix(value);
    return fixed === null ? undefined : fixed;
}

/**
 * @param {Rule} rule
 * @param {*} value
 * @returns {boolean} whether the key is in Atelier's way now
 */
export const collides = (rule, value) => wanted(rule, value) !== undefined;

/**
 * Keep a rule: as it is turned on, and whenever the key changes then.
 *
 * @param {Rule} rule
 * @param {*} value - the key's value now
 * @param {object|null} entry - what Atelier knows of the key: {previous,
 *   set}, the value before Atelier changed it (null: none) and the value
 *   it left there
 * @returns {object} {write, entry, overridden}: the value to write
 *   (undefined: none), what Atelier knows of the key then, and whether the
 *   user has changed a kept value themselves, and so taken it back
 */
export function keep(rule, value, entry = null) {
    if (entry?.set !== undefined && rule.kind === 'keep' && !same(value, entry.set))
        return {write: undefined, entry: null, overridden: true};
    const target = wanted(rule, value);
    if (target === undefined)
        return {write: undefined, entry: entry?.set !== undefined ? entry : {previous: null, set: value}, overridden: false};
    // (A guard puts back the value it last stepped in for.)
    const previous = rule.kind === 'guard' ? value : entry?.previous ?? value;
    return {write: target, entry: {previous, set: target}, overridden: false};
}

/**
 * Let a rule go: what was there before Atelier changed it comes back,
 * unless the key has changed since.
 *
 * @param {object|null} entry - {previous, set}
 * @param {*} value - the key's value now
 * @returns {*} the value to write, or undefined to leave it
 */
export function release(entry, value) {
    if (!entry || entry.previous === null || entry.previous === undefined || !same(value, entry.set))
        return undefined;
    return entry.previous;
}

/**
 * @param {string} text - JSON of what Atelier knows of each rule's key
 * @returns {object} rule id → {previous, set} or {overridden: true}
 */
export function parseState(text) {
    try {
        const state = JSON.parse(text || '{}');
        return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
    } catch {
        return {};
    }
}

// Other extensions' settings: their schemas ship in their folders (the
// user's, then the system's), or are installed with the system's.

const extensionDirs = uuid => [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]
    .map(dataDir => GLib.build_filenamev([dataDir, 'gnome-shell', 'extensions', uuid]));

/**
 * @param {string} uuid
 * @returns {boolean} whether the extension is installed (for the user or the system)
 */
export function isInstalled(uuid) {
    return extensionDirs(uuid)
        .some(dir => GLib.file_test(GLib.build_filenamev([dir, 'metadata.json']), GLib.FileTest.EXISTS));
}

/**
 * @param {Rule} rule
 * @returns {Gio.Settings|null} the other extension's settings with the
 *   rule's key, or null when they can't be found
 */
export function settingsFor(rule) {
    const fallback = Gio.SettingsSchemaSource.get_default();
    for (const extensionDir of extensionDirs(rule.uuid)) {
        const dir = GLib.build_filenamev([extensionDir, 'schemas']);
        if (!GLib.file_test(GLib.build_filenamev([dir, 'gschemas.compiled']), GLib.FileTest.EXISTS))
            continue;
        try {
            const schema = Gio.SettingsSchemaSource.new_from_directory(dir, fallback, false).lookup(rule.schema, false);
            if (schema?.has_key(rule.key))
                return new Gio.Settings({settings_schema: schema});
        } catch (e) {
            console.warn(`Atelier: ${rule.extension}'s settings in ${dir}: ${e.message}`);
        }
    }
    const installed = fallback?.lookup(rule.schema, true);
    return installed?.has_key(rule.key) ? new Gio.Settings({settings_schema: installed}) : null;
}

/**
 * @param {Gio.Settings} settings
 * @param {string} key
 * @returns {*} its value, unpacked
 */
export const readKey = (settings, key) => settings.get_value(key).recursiveUnpack();

/**
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {*} value - of the key's type, unpacked
 */
export function writeKey(settings, key, value) {
    const type = settings.settings_schema.get_key(key).get_value_type().dup_string();
    settings.set_value(key, new GLib.Variant(type, value));
}
