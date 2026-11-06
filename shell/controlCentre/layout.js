// Where the control centre's parts are.

import St from 'gi://St';

/**
 * Where an actor is in another (an ancestor), and its corners' radius.
 *
 * @param {Clutter.Actor} actor
 * @param {Clutter.Actor} ancestor
 * @returns {{x: number, y: number, width: number, height: number, radius: number}|null}
 */
export function rectIn(actor, ancestor) {
    if (!actor?.visible || !ancestor?.contains(actor))
        return null;
    const box = actor.get_allocation_box();
    let x = 0;
    let y = 0;
    for (let a = actor; a && a !== ancestor; a = a.get_parent()) {
        const b = a.get_allocation_box();
        x += b.x1 + a.translation_x;
        y += b.y1 + a.translation_y;
    }
    let radius = 0;
    try {
        if (actor instanceof St.Widget && actor.get_stage())
            radius = actor.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
    } catch {
        radius = 0;
    }
    return {x, y, width: box.get_width(), height: box.get_height(), radius};
}
