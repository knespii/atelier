// The overview over the blurred wallpaper. GNOME shrinks the desktop onto a
// plain dark grey; under a bar without a background of its own that grey
// came and went as a band across the top while the overview opened and
// closed. Here the wallpaper stays and blurs as the overview opens (the
// blurred copy fading in over the sharp one, following the overview), so
// the bar has the wallpaper behind it all the way. The glass's fine grain
// lies over the blur, which would band without it.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {GrainEffect} from '../core/glassMaterial.js';

const BLUR_RADIUS = 48; // logical pixels
const BLUR_BRIGHTNESS = 0.6;

export class OverviewBackdrop {
    constructor() {
        this.actor = new Clutter.Actor({name: 'atelier-overview-backdrop', reactive: false});
        // Under everything the overview shows, and never where a dragged
        // window is dropped.
        Shell.util_set_hidden_from_pick(this.actor, true);
        Main.layoutManager.overviewGroup.insert_child_at_index(this.actor, 0);
        this._sharp = new Clutter.Actor();
        this._blurred = new Clutter.Actor({opacity: 0});
        this.actor.add_child(this._sharp);
        this.actor.add_child(this._blurred);
        this._managers = [];
        this._grain = 0;

        Main.layoutManager.connectObject('monitors-changed', () => this._build(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._build(), this);
        // How far the overview is open, as it animates (without it, blurred).
        this._progress = Main.overview._overview?.controls?._stateAdjustment ?? null;
        this._progress?.connectObject('notify::value', () => this._syncBlur(), this);
        this._build();
        this._syncBlur();
    }

    _build() {
        this._managers.forEach(manager => manager.destroy());
        this._managers = [];
        Main.layoutManager.monitors.forEach((_, monitorIndex) => {
            this._managers.push(new Background.BackgroundManager({container: this._sharp, monitorIndex}));
            const blurred = new Background.BackgroundManager({container: this._blurred, monitorIndex});
            blurred.connect('changed', () => this._blur(blurred.backgroundActor));
            this._blur(blurred.backgroundActor);
            this._managers.push(blurred);
        });
    }

    _blur(actor) {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        actor.remove_effect_by_name('atelier-grain');
        actor.remove_effect_by_name('atelier-blur');
        // (An actor's first effect is drawn last: the grain over the blur.)
        if (this._grain > 0) {
            const grain = new GrainEffect();
            grain.setGrain(this._grain);
            actor.add_effect_with_name('atelier-grain', grain);
        }
        actor.add_effect_with_name('atelier-blur', new Shell.BlurEffect({
            mode: Shell.BlurMode.ACTOR,
            radius: BLUR_RADIUS * scale,
            brightness: BLUR_BRIGHTNESS,
        }));
    }

    /** @param {number} amount - of the grain over the blur, 0 for none */
    setGrain(amount) {
        if (amount === this._grain)
            return;
        this._grain = amount;
        this._blurred.get_children().forEach(actor => {
            const grain = actor.get_effect('atelier-grain');
            if (grain && amount > 0)
                grain.setGrain(amount);
            else
                this._blur(actor);
        });
    }

    _syncBlur() {
        const progress = this._progress ? Math.min(1, Math.max(0, this._progress.value)) : 1;
        this._blurred.opacity = Math.round(255 * progress);
    }

    destroy() {
        this._progress?.disconnectObject(this);
        this._progress = null;
        Main.layoutManager.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this._managers.forEach(manager => manager.destroy());
        this._managers = [];
        this.actor.destroy();
        this.actor = null;
    }
}
