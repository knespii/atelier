// What differs between the GNOME Shell versions Atelier runs on (48–50),
// where it can be told apart without the shell: shared by the shell (see
// shell/core/compat.js) and the tests.

/**
 * @param {string} version - as the shell has it, e.g. "50.1" or "49.rc"
 * @returns {number} its major version (0 when there is none)
 */
export function majorVersion(version) {
    return parseInt(String(version), 10) || 0;
}

/**
 * Parameters for Main.layoutManager.addChrome()/trackChrome(): from 50 on,
 * with no X11, there is no input region to keep out of, and saying so
 * throws.
 *
 * @param {object} params
 * @param {number} shell - the major version
 * @returns {object} what that shell takes
 */
export function chromeParams(params, shell) {
    if (shell < 50 || !('affectsInputRegion' in params))
        return params;
    const {affectsInputRegion: _, ...rest} = params;
    return rest;
}
