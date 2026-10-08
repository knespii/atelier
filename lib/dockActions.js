// What a click on an app in the dock does: which action the settings pick
// for the button, and what that action comes to for the app's windows as
// they are. Pure functions, shared by the shell and the tests.
//
// The actions are Dash to Dock's, with the app's windows spread out in the
// overview where Dash to Dock shows their previews. The default, going
// through the windows, is what the dock always did: a click brings the
// app's latest window up, minimizes it when it is up already and alone, or
// goes on to the next one.

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
 * @param {string} action - the action's nick
 * @param {object} state
 * @param {number} state.windows - how many windows of the app count
 * @param {number} [state.focusedIndex] - which of them has the focus, -1
 *   for none
 * @param {boolean} [state.minimizedAll] - all of them are minimized
 * @param {boolean} [state.canNew] - the app can open another window
 * @param {boolean} [state.singleActivates] - bringing the app up brings
 *   up only its latest window (activate-single-window)
 * @param {boolean} [state.plain] - a plain click: the primary button,
 *   without Shift (some actions do less for the others)
 * @returns {object} {kind, ...}, kind one of
 *   'launch' – start the app (or a window of it here, when it runs elsewhere)
 *   'new-window' – open another window
 *   'activate' – bring up its latest window, or all of them ({all})
 *   'minimize-all' – minimize its windows, or only the latest one ({latest})
 *   'cycle' – on to its next window ({from}: the focused one)
 *   'spread' – its windows spread out, alone, in the overview
 *   'overview' – the overview
 *   'quit' – close its windows
 *   'none'
 */
export function plan(action, {windows, focusedIndex = -1, minimizedAll = false, canNew = false,
    singleActivates = true, plain = true}) {
    // Without windows here, whatever the action, the app is opened.
    if (windows <= 0)
        return {kind: 'launch'};
    const focused = focusedIndex >= 0;
    const single = windows === 1;
    const activate = {kind: 'activate', all: !singleActivates};
    const minimize = {kind: 'minimize-all', latest: false};
    switch (action) {
    case 'skip':
        return activate;
    case 'minimize':
        // Shift or the middle button minimize also an app in the
        // background, one window at a time.
        if ((focused || !plain) && !minimizedAll)
            return {kind: 'minimize-all', latest: !plain};
        return {kind: 'activate', all: true};
    case 'launch':
        // (An app with one window only: as a click always did.)
        return canNew ? {kind: 'new-window'} : plan('cycle-windows', {windows, focusedIndex, singleActivates});
    case 'cycle-windows':
        if (!focused)
            return activate;
        return single ? minimize : {kind: 'cycle', from: focusedIndex};
    case 'minimize-or-overview':
        if (single && plain)
            return focused ? minimize : activate;
        return {kind: 'overview'};
    case 'appspread':
        return single && plain ? activate : {kind: 'spread'};
    case 'minimize-or-appspread':
        if (single && plain)
            return focused ? minimize : activate;
        return {kind: 'spread'};
    case 'focus-or-appspread':
        return focused && !single && plain ? {kind: 'spread'} : activate;
    case 'focus-minimize-or-appspread':
        if (!focused)
            return activate;
        return !single && plain ? {kind: 'spread'} : {kind: 'minimize-all', latest: true};
    case 'quit':
        return {kind: 'quit'};
    default:
        return {kind: 'none'};
    }
}
