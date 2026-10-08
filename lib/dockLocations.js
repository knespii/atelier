// The places a dock shows: which drives, the trash's icon, which file
// manager windows go with a place. Pure functions, shared by the shell and
// the tests.

/**
 * The drives to show, in a stable order (by name).
 *
 * @param {object[]} mounts - {id, name, mounted, network, usable, shadowed,
 *   ...}: usable when it can be unmounted, ejected or mounted; shadowed
 *   when another mount stands for it
 * @param {object} options
 * @param {boolean} options.onlyMounted - leave out drives not mounted
 * @param {boolean} options.network - keep network drives
 * @returns {object[]} the drives to show
 */
export function filterMounts(mounts, {onlyMounted, network}) {
    const seen = new Set();
    const shown = mounts.filter(mount => {
        if (!mount.usable || mount.shadowed || seen.has(mount.id))
            return false;
        if ((onlyMounted && !mount.mounted) || (!network && mount.network))
            return false;
        seen.add(mount.id);
        return true;
    });
    const name = mount => (mount.name ?? '').toLowerCase();
    return shown.sort((a, b) => name(a).localeCompare(name(b)) || a.id.localeCompare(b.id));
}

/**
 * @param {object} state
 * @param {number|null} state.count - the items in the trash (null: not
 *   known yet)
 * @returns {string} the trash's icon name
 */
export function trashIcon({count}) {
    return count > 0 ? 'user-trash-full' : 'user-trash';
}

// A place as a directory: with one slash at its end.
const asDirectory = uri => (uri.endsWith('/') ? uri : `${uri}/`);

/**
 * @param {string} uri - a place
 * @param {string[]} windowLocations - the places a file manager window
 *   shows (one per tab)
 * @returns {boolean} whether the window goes with the place: it shows the
 *   place or a folder in it
 */
export function windowShowsLocation(uri, windowLocations) {
    if (!uri)
        return false;
    const place = asDirectory(uri);
    return windowLocations.some(location => asDirectory(location).startsWith(place));
}

/**
 * @param {string} uri - a place
 * @param {object} locationsByWindow - window object path → the places it
 *   shows (the file manager's OpenWindowsWithLocations)
 * @returns {string[]} the object paths of the windows that go with it
 */
export function windowsShowing(uri, locationsByWindow) {
    return Object.entries(locationsByWindow)
        .filter(([, locations]) => windowShowsLocation(uri, locations))
        .map(([path]) => path);
}

/**
 * An argument of a desktop file's Exec line, quoted (the Desktop Entry
 * specification's rules).
 *
 * @param {string} argument
 * @returns {string}
 */
export function execArgument(argument) {
    const escaped = argument.replace(/[\\"`$]/g, c => `\\${c}`).replace(/%/g, '%%');
    return `"${escaped}"`;
}
