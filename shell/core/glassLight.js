// The light Atelier's glass catches: from above, and – while the pointer is
// near a surface – leaning towards it (lib/glassLook.js lightToward()), as
// if the light followed one's hand. It costs nothing at rest: the pointer
// is looked at only while some glass is shown and the user is busy (GNOME's
// PointerWatcher, which stops while they are idle); only surfaces it is
// near get a new light, and they are drawn again only where they are. With
// GNOME's animations off (or reduced motion asked for), the light stays
// where it is, above.

import Gio from 'gi://Gio';
import St from 'gi://St';

import * as PointerWatcher from 'resource:///org/gnome/shell/ui/pointerWatcher.js';

import {REST_LIGHT, lightToward} from '../../lib/glassLook.js';
import {glassScale} from './glassMaterial.js';

// How often the pointer is looked at while it moves, milliseconds.
const INTERVAL = 16;

/**
 * A surface the light falls on:
 * - lightAreas() → [[x, y, width, height], …] on the stage, of what of it
 *   is shown (none while hidden)
 * - lightLook() → LOOK's light ({lean, near}), null for none
 * - setLights(lights) – a direction [x, y] for each area; the surface keeps
 *   what is the same as it was
 */
class GlassLight {
    constructor() {
        this._surfaces = new Set();
        this._watch = null;
        this._interface = null;
        this._a11y = null;
        this._moving = false;
    }

    /** @param {object} surface - one the light falls on */
    add(surface) {
        if (this._surfaces.size === 0)
            this._follow(true);
        this._surfaces.add(surface);
        this.sync();
    }

    /** @param {object} surface */
    remove(surface) {
        if (!this._surfaces.delete(surface))
            return;
        if (this._surfaces.size === 0)
            this._follow(false);
        this.sync();
    }

    // The settings that say whether anything may move.
    _follow(on) {
        if (!on) {
            this._interface?.disconnectObject(this);
            this._a11y?.disconnectObject(this);
            St.Settings.get().disconnectObject(this);
            this._interface = this._a11y = null;
            return;
        }
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._interface.connectObject('changed::enable-animations', () => this.sync(), this);
        // (GNOME 50 asks for less motion apart.)
        const a11y = Gio.SettingsSchemaSource.get_default().lookup('org.gnome.desktop.a11y.interface', true);
        if (a11y?.has_key('reduced-motion')) {
            this._a11y = new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'});
            this._a11y.connectObject('changed::reduced-motion', () => this.sync(), this);
        }
        // (St's also says no while the screen is shared, say.)
        St.Settings.get().connectObject('notify::enable-animations', () => this.sync(), this);
    }

    /**
     * Watch the pointer while there is glass shown and the light may move;
     * call it when a surface shows or hides.
     */
    sync() {
        this._moving = Boolean(this._interface?.get_boolean('enable-animations') &&
            !this._a11y?.get_boolean('reduced-motion') && St.Settings.get().enable_animations);
        // Still, it is from above. (A surface hidden keeps its light until
        // it shows again.)
        if (!this._moving)
            this._surfaces.forEach(surface => this._light(surface, null));
        const wanted = this._moving && [...this._surfaces].some(surface => surface.lightAreas().length > 0);
        if (wanted && !this._watch) {
            this._watch = PointerWatcher.getPointerWatcher().addWatch(INTERVAL, (x, y) => this._update(x, y));
            const [x, y] = global.get_pointer();
            this._update(x, y);
        } else if (!wanted && this._watch) {
            this._watch.remove();
            this._watch = null;
        }
    }

    /**
     * A surface changed its shape (growing, say): its light, for where the
     * pointer is now.
     *
     * @param {object} surface
     */
    refresh(surface) {
        if (!this._watch || !this._surfaces.has(surface))
            return;
        const [x, y] = global.get_pointer();
        this._light(surface, [x, y], glassScale());
    }

    _update(x, y) {
        const scale = glassScale();
        for (const surface of this._surfaces)
            this._light(surface, [x, y], scale);
    }

    // Where the light comes from for each of a surface's areas: from above,
    // or leaning towards the pointer.
    _light(surface, pointer, scale = 1) {
        const look = surface.lightLook();
        const areas = surface.lightAreas();
        if (areas.length === 0)
            return;
        surface.setLights(areas.map(area => (look && pointer ? lightToward(area, pointer, look, scale) : REST_LIGHT)));
    }
}

/** The one light, shared by all of Atelier's glass. */
export const glassLight = new GlassLight();
