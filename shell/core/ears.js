// The ears of a notch: where it hangs from the top edge of the screen, the
// edge curves into its sides instead of meeting them at a right angle. These
// are black, for the classic look; glass draws its ears in its mask.

import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// One ear: a square less a quarter circle, filled with its CSS color.
const Ear = GObject.registerClass(
class AtelierNotchEar extends St.DrawingArea {
    _init(right) {
        super._init({style_class: 'atelier-notch-ear', reactive: false});
        // (Never the target of a drag and drop.)
        Shell.util_set_hidden_from_pick(this, true);
        this._right = right;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const color = this.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
        if (this._right) {
            // From the notch's top corner along the edge, then round back.
            cr.moveTo(w, 0);
            cr.lineTo(0, 0);
            cr.lineTo(0, h);
            cr.arc(w, h, w, Math.PI, 1.5 * Math.PI);
        } else {
            cr.moveTo(0, 0);
            cr.lineTo(w, 0);
            cr.lineTo(w, h);
            cr.arcNegative(0, h, w, 0, -Math.PI / 2);
        }
        cr.closePath();
        cr.fill();
        cr.$dispose();
    }
});

export class NotchEars {
    /**
     * @param {Clutter.Actor} sibling - the ears go right below it
     */
    constructor(sibling) {
        this._ears = [new Ear(false), new Ear(true)];
        for (const ear of this._ears)
            Main.layoutManager.uiGroup.insert_child_below(ear, sibling);
    }

    /**
     * Put the ears beside the top of a notch, in stage coordinates.
     *
     * @param {number} x - left edge of the notch
     * @param {number} y - its top
     * @param {number} width
     * @param {number} radius - of the ears
     */
    setShape(x, y, width, radius) {
        const [left, right] = this._ears;
        for (const ear of this._ears) {
            if (ear.width !== radius || ear.height !== radius)
                ear.set_size(radius, radius);
        }
        // Moved, not laid out anew: this follows the island every frame.
        left.set_translation(x - radius, y, 0);
        right.set_translation(x + width, y, 0);
    }

    /**
     * @param {boolean} visible
     * @param {number} [opacity]
     */
    show(visible, opacity = 255) {
        for (const ear of this._ears) {
            ear.visible = visible;
            ear.opacity = opacity;
        }
    }

    destroy() {
        this._ears.forEach(ear => ear.destroy());
        this._ears = [];
    }
}
