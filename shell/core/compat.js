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

/**
 * Whether a press inside an actor is for a gesture of something in it. From
 * 49 a button (St.Button) takes its clicks with a gesture that needs the
 * press to go on through its parents: one of them that keeps it to itself
 * (EVENT_STOP) cancels the click. (Up to 48 the button kept the press.)
 *
 * @param {Clutter.Event} event - a button press or touch begin
 * @param {Clutter.Actor} parent - the actor it reached, inside which it was
 * @returns {boolean}
 */
export function pressIsForGesture(event, parent) {
    if (!Clutter.Gesture)
        return false;
    let gesture = false;
    for (let actor = global.stage.get_event_actor(event); actor; actor = actor.get_parent()) {
        if (actor === parent)
            return gesture;
        gesture ||= actor.reactive && actor.get_actions().some(action => action instanceof Clutter.Gesture && action.enabled);
    }
    // (Outside it, under its grab.)
    return false;
}

/**
 * Maximize a window, both ways.
 *
 * @param {Meta.Window} window
 */
export function maximize(window) {
    // (From 49 it takes no flags: it is both ways, always.)
    if (SHELL >= 49)
        window.maximize();
    else
        window.maximize(Meta.MaximizeFlags.BOTH);
}

/**
 * Put a window maximized both ways back to its size.
 *
 * @param {Meta.Window} window
 */
export function unmaximize(window) {
    if (SHELL >= 49)
        window.unmaximize();
    else
        window.unmaximize(Meta.MaximizeFlags.BOTH);
}
