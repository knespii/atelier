// The overview over the blurred wallpaper. GNOME shrinks the desktop onto a
// plain dark grey; under a bar without a background of its own that grey
// came and went as a band across the top while the overview opened and
// closed. Over the blurred wallpaper the bar has the wallpaper behind it
// all the way, as on the desktop.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BLUR_RADIUS = 48; // logical pixels
const BLUR_BRIGHTNESS = 0.6;

export class OverviewBackdrop {
    constructor() {
        this.actor = new Clutter.Actor({name: 'atelier-overview-backdrop', reactive: false});
        // Under everything the overview shows.
        Main.layoutManager.overviewGroup.insert_child_at_index(this.actor, 0);
        this._managers = [];

        Main.layoutManager.connectObject('monitors-changed', () => this._build(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._build(), this);
        this._build();
    }

    _build() {
        this._managers.forEach(manager => manager.destroy());
        this._managers = Main.layoutManager.monitors.map((_, monitorIndex) => {
            const manager = new Background.BackgroundManager({container: this.actor, monitorIndex});
            manager.connect('changed', () => this._blur(manager));
            this._blur(manager);
            return manager;
        });
    }

    _blur(manager) {
        const actor = manager.backgroundActor;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        actor.remove_effect_by_name('atelier-blur');
        actor.add_effect_with_name('atelier-blur', new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS * scale,
            brightness: BLUR_BRIGHTNESS,
        }));
    }

    destroy() {
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this._managers.forEach(manager => manager.destroy());
        this._managers = [];
        this.actor.destroy();
        this.actor = null;
    }
}
