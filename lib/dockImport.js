// Dash to Dock's settings as Atelier's dock's: the same keys mostly, a few
// renamed or converted, some that have nothing to go to. A pure function,
// shared by the preferences and the tests.
//
// (For now it brings nothing over.)

/**
 * @param {Function} _readFn - key → its value in Dash to Dock (a GLib
 *   Variant unpacked), or undefined when it has no such key
 * @returns {object} {values: [[key, value], ...] to write, ignored: [keys
 *   that have nothing to go to]}
 */
export function mapDashToDock(_readFn) {
    return {values: [], ignored: []};
}
