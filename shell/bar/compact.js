// A compact bar: grouped in the middle or as one island, only the essentials
// stay – the workspaces, the island with the time and the battery, plus the
// screen recording and sharing indicators while they are on. Everything
// else in the bar is hidden (the control centre has it) and comes back when
// the bar is no longer compact.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {BatteryIndicator} from './indicators.js';

// What stays, by its key in Main.panel.statusArea.
const KEEP = new Set([
    'activities', 'atelier-island', 'atelier-battery', 'screenRecording', 'screenSharing',
    'dateMenu', // (hidden by the island; GNOME's clock when there is none)
]);

export class CompactBar {
    constructor() {
        this._hidden = new Map(); // actor → whether it wanted to show
        const powerToggle = Main.panel.statusArea.quickSettings?._system?._systemItem?.powerToggle;
        if (powerToggle) {
            this._battery = new BatteryIndicator(powerToggle);
            Main.panel.addToStatusArea('atelier-battery', this._battery, 0, 'right');
        }
        for (const box of this._boxes()) {
            box.connectObject(
                'child-added', (_, actor) => this._hide(actor),
                'child-removed', (_, actor) => this._restore(actor),
                this);
            box.get_children().forEach(actor => this._hide(actor));
        }
    }

    _boxes() {
        return [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox];
    }

    _keeps(actor) {
        return Object.entries(Main.panel.statusArea)
            .some(([role, indicator]) => KEEP.has(role) && indicator?.container === actor);
    }

    _hide(actor) {
        if (this._hidden.has(actor) || this._keeps(actor))
            return;
        this._hidden.set(actor, actor.visible);
        actor.visible = false;
        // Whatever shows it again (its own indicator) is noted, and it stays
        // hidden until the bar is no longer compact.
        actor.connectObject('notify::visible', () => {
            if (!actor.visible)
                return;
            this._hidden.set(actor, true);
            actor.visible = false;
        }, this);
    }

    // It leaves the bar (into the control centre's Extensions tab, say):
    // as it was.
    _restore(actor) {
        if (!this._hidden.has(actor))
            return;
        actor.disconnectObject(this);
        actor.visible = this._hidden.get(actor);
        this._hidden.delete(actor);
    }

    destroy() {
        this._boxes().forEach(box => box.disconnectObject(this));
        [...this._hidden.keys()].forEach(actor => this._restore(actor));
        this._battery?.destroy();
        this._battery = null;
    }
}
