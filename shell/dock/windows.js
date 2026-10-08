// Which of an app's windows count for the dock: by default those on the
// current workspace (an urgent one from anywhere), on any monitor; the
// dock's settings may count every workspace, or only its own monitor.
// File manager windows a location item stands for count for that item,
// not for the file manager.

/**
 * @param {Shell.App} app
 * @param {object} [options]
 * @param {boolean} [options.isolateWorkspaces] - only those on the current workspace
 * @param {boolean} [options.isolateMonitors] - only those on the monitor
 * @param {number} [options.monitorIndex] - the dock's monitor
 * @param {boolean} [options.agnosticUrgent] - urgent ones from every workspace
 * @param {object} [options.locations] - the dock's locations (they own
 *   some windows: see shell/dock/locations.js)
 * @returns {Meta.Window[]} its windows that count, the latest used first
 */
export function appWindows(app, {isolateWorkspaces = true, isolateMonitors = false, monitorIndex = -1,
    agnosticUrgent = true, locations = null} = {}) {
    const workspace = global.workspace_manager.get_active_workspace();
    const own = locations?.windowsFor(app) ?? null;
    return (own ?? app.get_windows()).filter(window => {
        if (window.skip_taskbar || (!own && locations?.owns(window)))
            return false;
        if (isolateWorkspaces && !window.located_on_workspace(workspace) &&
            !(agnosticUrgent && (window.urgent || window.demands_attention)))
            return false;
        return !isolateMonitors || monitorIndex < 0 || window.get_monitor() === monitorIndex;
    });
}

/**
 * The options for appWindows() from the dock's settings.
 *
 * @param {Gio.Settings} settings - the dock's
 * @param {number} monitorIndex - the dock's monitor
 * @param {object} [locations]
 * @returns {object}
 */
export function windowOptions(settings, monitorIndex, locations = null) {
    return {
        isolateWorkspaces: settings.get_boolean('isolate-workspaces'),
        isolateMonitors: settings.get_boolean('isolate-monitors'),
        agnosticUrgent: settings.get_boolean('workspace-agnostic-urgent-windows'),
        monitorIndex,
        locations,
    };
}
