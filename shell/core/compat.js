// What differs between the GNOME Shell versions Atelier runs on (48–50),
// in one place: the code elsewhere asks here rather than for a version.

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';

import {chromeParams, majorVersion} from '../../lib/compat.js';

/** The shell's major version: 48, 49, 50. */
export const SHELL = majorVersion(Config.PACKAGE_VERSION);

/**
 * @param {object} params - for addChrome()/trackChrome()
 * @returns {object} what this shell takes
 */
export const chrome = params => chromeParams(params, SHELL);

/**
 * The pointer's shape over the whole screen (until set again).
 *
 * @param {string} name - DEFAULT, GRAB, GRABBING, SE_RESIZE…
 */
export function setCursor(name) {
    // (From 50 the stage has it, as Clutter names it.)
    if (Meta.Cursor && global.display.set_cursor)
        global.display.set_cursor(Meta.Cursor[name]);
    else
        global.stage.set_cursor_type(Clutter.CursorType[name]);
}

/**
 * @param {Clutter.Grab} grab - from Main.pushModal()
 * @returns {boolean} whether it has the keyboard (from 50, a grab always
 *   has it)
 */
export function grabHasKeyboard(grab) {
    if (!grab.get_seat_state || !Clutter.GrabState)
        return true;
    return (grab.get_seat_state() & Clutter.GrabState.KEYBOARD) !== 0;
}
