// What a click on an app in the dock does: which action the settings pick
// for the button, and what that action comes to for the app's windows as
// they are. Pure functions, shared by the shell and the tests.

/**
 * @param {Function} settingsGetter - key → the nick of its action
 * @param {number} button - 1 (primary), 2 (middle) or 3
 * @param {boolean} shift - Shift held
 * @returns {string} the action's nick (from atelier.DockClickAction)
 */
export function pickAction(settingsGetter, button, shift) {
    if (button === 2)
        return settingsGetter(shift ? 'shift-middle-click-action' : 'middle-click-action');
    return settingsGetter(shift ? 'shift-click-action' : 'click-action');
}

/**
 * The step an action comes to.
 *
 * @param {string} _action - the action's nick
 * @param {object} _state - {windows (count), focused (one of them has the
 *   focus), minimized (all of them are), running, canOpenNew,
 *   singleWindow (activate-single-window), spreadSupported}
 * @returns {object} {kind, ...}: kind one of 'launch', 'new-window',
 *   'focus', 'focus-all', 'minimize', 'minimize-all', 'cycle', 'spread',
 *   'overview', 'quit', 'none'
 *
 * (For now always 'none'.)
 */
export function plan(_action, _state) {
    return {kind: 'none'};
}
