// The windows as liquid (shell/windows/): one opened from the dock comes
// out of its icon in a drop, one opened otherwise spreads out of its
// middle, one closing draws into its middle – then all is as GNOME has it.

import {TestWindows} from './behaviour.js';


const maskOf = actor => actor?.get_effect('atelier-window-liquid') ?? null;
// The drop's layer, over the windows.
const overlays = t => t.Main.layoutManager.uiGroup.get_children().filter(child =>
    child.constructor.name === 'AtelierLiquidPaint' && child.get_parent() === t.Main.layoutManager.uiGroup);

export async function shell(t) {
    const {check, ext} = t;
    const module = ext.stateObj.modules.get('windows');
    if (!check(Boolean(module), 'windows as liquid: on'))
        return;
    const windows = new TestWindows(t);
    try {
        // Opened otherwise: out of its middle, then as it is.
        const middle = windows.open('liquid-middle');
        let actor = null;
        await t.waitFor(() => {
            const window = global.display.list_all_windows().find(w => w.title === 'liquid-middle');
            actor = window?.get_compositor_private() ?? null;
            return Boolean(maskOf(actor));
        }, 10000);
        check(Boolean(maskOf(actor)) && overlays(t).length === 0, 'a window opened otherwise spreads out of its middle');
        const first = await middle;
        check(await t.waitFor(() => !maskOf(first?.get_compositor_private()), 2000) &&
            first.get_compositor_private().opacity === 255, 'and then is as it is');

        // Out of the dock: a drop from the app's icon first, then the window.
        const app = await windows.app();
        const dock = t.module.dock;
        // (As the extension has it: by its own path, the same module.)
        const {noteLaunch} = await import(`file://${ext.path}/shell/core/launchOrigins.js`);
        noteLaunch(app.get_id(), {x: 900, y: 1000, width: 64, height: 64}, dock?.side ?? 'BOTTOM');
        const fromDock = windows.open('liquid-dock');
        await t.waitFor(() => overlays(t).length > 0, 10000);
        check(overlays(t).length === 1, 'out of the dock: a drop from the icon, over the windows');
        await t.sleep(250);
        await t.screenshot('70-window-from-dock');
        const second = await fromDock;
        check(await t.waitFor(() => overlays(t).length === 0 && !maskOf(second?.get_compositor_private()), 3000),
            'and the window it spreads into, then as it is');

        // Its app has an icon in the dock: put out of sight, it goes back
        // into it in a drop – and comes out of it again.
        const picture = () => global.window_group.get_children().find(child =>
            child.get_effect?.('atelier-window-liquid') && !child.meta_window) ?? null;
        await t.waitFor(() => dock.items.has(app.get_id()), 3000);
        second.minimize();
        check(await t.waitFor(() => picture() && overlays(t).length === 1, 2000) && second.minimized,
            'put out of sight, it goes back into its icon in a drop');
        check(await t.waitFor(() => !picture() && overlays(t).length === 0, 3000), 'and is gone');
        second.unminimize();
        check(await t.waitFor(() => maskOf(second.get_compositor_private()) && overlays(t).length === 1, 2000),
            'brought back, out of its icon again');
        check(await t.waitFor(() => !maskOf(second.get_compositor_private()) && overlays(t).length === 0, 3000),
            'then as it is');

        // Closing, into its icon too; a window of an app without one draws
        // into its middle.
        second.delete(global.get_current_time());
        check(await t.waitFor(() => picture() && overlays(t).length === 1, 2000), 'closing, into its icon');
        check(await t.waitFor(() => !picture() && overlays(t).length === 0, 3000), 'and is gone');
        // (Running apps not in the dock: it has no icon for this one.)
        t.settings.set_boolean('show-running', false);
        await t.waitFor(() => !t.module.dock.items.has(app.get_id()), 2000);
        first.delete(global.get_current_time());
        check(await t.waitFor(() => picture(), 2000) && overlays(t).length === 0, 'without one, into its middle');
        check(await t.waitFor(() => !picture(), 3000), 'and gone too');
        t.settings.reset('show-running');
    } finally {
        t.settings.reset('show-running');
        await windows.closeAll();
        t.Main.messageTray.getSources().forEach(source => [...source.notifications].forEach(n => n.destroy()));
        await t.sleep(300);
    }
}

export async function prefs() {}

