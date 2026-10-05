// Tiny assertion helpers and fixtures for the GJS test runner.

import GLib from 'gi://GLib';

const OUTPUT = GLib.build_filenamev([GLib.get_current_dir(), 'tests', 'output']);

export function assert(condition, message = 'assertion failed') {
    if (!condition)
        throw new Error(message);
}

export function assertEqual(actual, expected, message = '') {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e)
        throw new Error(`${message ? `${message}: ` : ''}expected ${e}, got ${a}`);
}

/**
 * @param {string} name
 * @returns {string} a fresh, empty directory below tests/output
 */
export function freshDir(name) {
    const dir = GLib.build_filenamev([OUTPUT, `${name}-${GLib.uuid_string_random().slice(0, 6)}`]);
    GLib.mkdir_with_parents(dir, 0o755);
    return dir;
}

/**
 * Create a file (and its parent directories).
 *
 * @param {string} path
 * @param {string} [contents]
 */
export function writeFile(path, contents = '') {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, contents);
}
