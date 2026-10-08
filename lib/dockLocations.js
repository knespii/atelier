// The places a dock shows: which drives, the trash's icon, which file
// manager windows go with a place. Pure functions, shared by the shell and
// the tests.
//
// (For now: every drive, an empty trash, no windows.)

/**
 * @param {object[]} mounts - {name, uri, mounted, network, ...}
 * @param {object} _options - {onlyMounted, network}
 * @returns {object[]} the drives to show
 */
export function filterMounts(mounts, _options) {
    return mounts;
}

/**
 * @param {object} _state - {empty}
 * @returns {string} the trash's icon name
 */
export function trashIcon(_state) {
    return 'user-trash';
}

/**
 * @param {string} _uri - a place
 * @param {string[]} _windowLocations - the places a file manager window shows
 * @returns {boolean} whether the window goes with the place
 */
export function windowShowsLocation(_uri, _windowLocations) {
    return false;
}
