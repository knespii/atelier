// Dash to Dock's settings as Atelier's dock's: the same keys mostly, of
// the same types, kept within Atelier's ranges and choices; the largest
// icon size renamed; the window previews, which Atelier's dock hasn't,
// become the app spread; a few have nothing to go to. Whether the dock is
// on is never brought over. Pure functions, shared by the preferences and
// the tests.

// Dash to Dock's keys that have nothing to go to.
export const IGNORED = ['preferred-monitor', 'show-windows-preview', 'default-windows-preview-to-open',
    'preview-size-scale', 'apply-custom-theme', 'apply-glossy-effect', 'unity-backlit-items', 'bolt-support',
    'disable-overview-on-startup', 'minimize-shift', 'shortcut-text'];

// Atelier's keys read from another key of Dash to Dock's.
export const RENAMED = {'icon-size': 'dash-max-icon-size'};

// Atelier's keys never brought over.
export const UNTOUCHED = ['enabled'];

const CLICK_KEYS = ['click-action', 'shift-click-action', 'middle-click-action', 'shift-middle-click-action'];
// Clicks that showed window previews spread the app's windows instead.
export const CLICK_ACTIONS = {
    'previews': 'appspread',
    'minimize-or-previews': 'minimize-or-appspread',
    'focus-or-previews': 'focus-or-appspread',
    'focus-minimize-or-previews': 'focus-minimize-or-appspread',
};

/**
 * What each key of a schema takes, for mapDashToDock().
 *
 * @param {Gio.SettingsSchema} schema - Atelier's dock's
 * @returns {object} key → {type ('b', 'i', 'd', 's', 'as'...), range
 *   ([min, max] or null), choices (an enum's nicks, or null)}
 */
export function describeKeys(schema) {
    const keys = {};
    for (const key of schema.list_keys()) {
        const info = schema.get_key(key);
        const [kind, values] = info.get_range().recursiveUnpack();
        keys[key] = {
            type: info.get_value_type().dup_string(),
            range: kind === 'range' ? values : null,
            choices: kind === 'enum' ? values : null,
        };
    }
    return keys;
}

// A value of Dash to Dock's as one the key takes, or undefined.
function convert(value, {type, range, choices}) {
    switch (type) {
    case 'b':
        return typeof value === 'boolean' ? value : undefined;
    case 'i':
    case 'd': {
        if (typeof value !== 'number' || !Number.isFinite(value))
            return undefined;
        let number = type === 'i' ? Math.round(value) : value;
        if (range)
            number = Math.min(range[1], Math.max(range[0], number));
        return number;
    }
    case 's':
        if (typeof value !== 'string' || (choices && !choices.includes(value)))
            return undefined;
        return value;
    case 'as':
        return Array.isArray(value) && value.every(v => typeof v === 'string') ? value : undefined;
    default:
        return undefined;
    }
}

/**
 * @param {Function} readFn - a key of Dash to Dock's → its value (the
 *   Variant unpacked: an enum as its nick), or undefined when it has no
 *   such key
 * @param {object} keys - Atelier's dock's keys, as describeKeys() says
 * @returns {object} {values: [[key, value], ...] to write, ignored: [Dash
 *   to Dock's keys that have nothing to go to, or whose value Atelier's
 *   key doesn't take]}
 */
export function mapDashToDock(readFn, keys) {
    const values = [];
    const ignored = [];
    for (const [key, info] of Object.entries(keys)) {
        if (UNTOUCHED.includes(key))
            continue;
        const source = RENAMED[key] ?? key;
        let value = readFn(source);
        if (value === undefined)
            continue;
        if (CLICK_KEYS.includes(key))
            value = CLICK_ACTIONS[value] ?? value;
        const converted = convert(value, info);
        if (converted === undefined)
            ignored.push(source);
        else
            values.push([key, converted]);
    }
    for (const key of IGNORED) {
        if (readFn(key) !== undefined)
            ignored.push(key);
    }
    return {values, ignored};
}
