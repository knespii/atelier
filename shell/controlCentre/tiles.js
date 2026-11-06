// The Controls tab's building blocks, as its Layout & Motion spec has them:
// a tile (its glass – raised when it is an open card – a header, what it
// shows open, what sits at its foot), a round toggle with the accent's
// circle growing under its icon, chips with a selection pill sliding
// between them, a list's rows, a spinner. Sizes are the spec's
// pixels at Atelier's size (lib/ccLayout.js SIZE), as the stylesheet has
// them; their motion is lib/ccMotion.js's, run by an Animator
// (shell/controlCentre/animator.js).

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {DURATIONS} from '../../lib/ccMotion.js';
import {SIZE} from '../../lib/ccLayout.js';

/** @returns {number} the stage's scale */
export const scaleOf = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

/** @returns {number} so many of the spec's pixels, as actor pixels */
export const px = v => v * SIZE * scaleOf();

/**
 * A layout manager that is a function: (container, box) => allocate its
 * children; its preferred size [width, height] or none (its children's).
 */
export const FnLayout = GObject.registerClass(
class AtelierCcFnLayout extends Clutter.LayoutManager {
    _init(allocate, preferred = null) {
        super._init();
        this._allocateFn = allocate;
        this._preferredFn = preferred;
    }

    vfunc_get_preferred_width(container, forHeight) {
        if (this._preferredFn) {
            const [width] = this._preferredFn(container);
            return [width, width];
        }
        let [min, nat] = [0, 0];
        for (const child of container) {
            if (!child.visible)
                continue;
            const [cMin, cNat] = child.get_preferred_width(forHeight);
            min = Math.max(min, cMin);
            nat = Math.max(nat, cNat);
        }
        return [min, nat];
    }

    vfunc_get_preferred_height(container, forWidth) {
        if (this._preferredFn) {
            const [, height] = this._preferredFn(container);
            return [height, height];
        }
        let [min, nat] = [0, 0];
        for (const child of container) {
            if (!child.visible)
                continue;
            const [cMin, cNat] = child.get_preferred_height(forWidth);
            min = Math.max(min, cMin);
            nat = Math.max(nat, cNat);
        }
        return [min, nat];
    }

    vfunc_allocate(container, box) {
        this._allocateFn(container, box);
    }
});

/**
 * @param {Clutter.Actor} actor
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 */
export function place(actor, x, y, width, height) {
    actor.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + Math.max(0, width), y2: y + Math.max(0, height)}));
}

/**
 * A button that shrinks a little while it is held down (scale 0.92, the
 * spec's press curve).
 *
 * @param {St.Button} button
 * @param {Animator} animator
 * @returns {St.Button}
 */
export function pressable(button, animator) {
    button.set_pivot_point(0.5, 0.5);
    button.connect('notify::pressed', () => {
        animator.ease(button, {scale: button.pressed ? 0.92 : 1}, {curve: 'press', duration: DURATIONS.press});
    });
    return button;
}

/**
 * An icon: a name, or a Gio.Icon.
 *
 * @param {string|Gio.Icon} icon
 * @param {string} styleClass
 * @returns {St.Icon}
 */
export function iconOf(icon, styleClass) {
    const actor = new St.Icon({style_class: styleClass});
    setIcon(actor, icon);
    return actor;
}

/**
 * @param {St.Icon} actor
 * @param {string|Gio.Icon} icon
 */
export function setIcon(actor, icon) {
    if (icon instanceof Gio.Icon)
        actor.gicon = icon;
    else
        actor.icon_name = icon || 'image-missing-symbolic';
}

/**
 * A tile: its glass at rest; for a card, its raised glass too (crossfaded
 * as it opens) and what it shows open – placed for the card open, revealed
 * as it grows (clipped to it). Each part is placed by a function of the
 * tile's size: part._place(width, height) → [x, y, width, height].
 */
export const Tile = GObject.registerClass(
class AtelierCcTile extends St.Widget {
    /**
     * @param {string} id - lib/ccLayout.js TILES
     * @param {object} params
     * @param {string} params.shape - 'pill', 'tile' or 'slider'
     * @param {boolean} [params.card] - it opens
     */
    _init(id, {shape, card = false}) {
        super._init({
            style_class: `atelier-cc-tile atelier-cc-tile-${id}`,
            layout_manager: new FnLayout((container, box) => this._allocateParts(box)),
            // (Revealed as it grows, not spilling.)
            clip_to_allocation: card,
        });
        this.tileId = id;
        this.focusables = [];
        if (shape !== 'slider') {
            this.glass = new St.Widget({style_class: `atelier-cc-glass atelier-cc-glass-${shape}`});
            this.add_child(this.glass);
        }
        this.raised = null;
        if (card) {
            this.raised = new St.Widget({style_class: 'atelier-cc-glass atelier-cc-raised', opacity: 0});
            this.add_child(this.raised);
        }
        this._parts = [];
    }

    /**
     * @param {Clutter.Actor} actor
     * @param {Function} [placeFn] - (width, height) => [x, y, width, height]; all of it without
     * @returns {Clutter.Actor} it
     */
    addPart(actor, placeFn = null) {
        actor._place = placeFn;
        this._parts.push(actor);
        this.add_child(actor);
        return actor;
    }

    /** @param {St.Widget[]} buttons - those that take the keyboard */
    addFocusables(...buttons) {
        this.focusables.push(...buttons);
    }

    /**
     * Take the keyboard or not (not while another card is open: Tab
     * stays in it).
     *
     * @param {boolean} inert
     */
    setInert(inert) {
        for (const button of this.focusables)
            button.can_focus = !inert;
    }

    _allocateParts(box) {
        const [width, height] = [box.get_width(), box.get_height()];
        for (const layer of [this.glass, this.raised]) {
            if (layer)
                place(layer, 0, 0, width, height);
        }
        for (const part of this._parts) {
            if (!part.visible)
                continue;
            const [x, y, w, h] = part._place?.(width, height) ?? [0, 0, width, height];
            place(part, x, y, w, h);
        }
    }
});

/**
 * A round toggle (Wi-Fi, Bluetooth, Airplane, Caffeine): its icon on a
 * faint circle, and under the icon the accent's circle, grown from its
 * middle as it turns on and shrunk as it turns off.
 */
export const RoundToggle = GObject.registerClass(
class AtelierCcRoundToggle extends St.Button {
    /**
     * @param {string|Gio.Icon} icon
     * @param {string} name - for a screen reader
     * @param {Animator} animator
     * @param {string} [size] - 'big' (the tiles') or 'small' (the mini pills')
     */
    _init(icon, name, animator, size = 'big') {
        // (As big as the button: St centres a child of its own size.)
        const box = new St.Widget({style_class: `atelier-cc-round-box atelier-cc-round-${size}`,
            layout_manager: new Clutter.BinLayout()});
        super._init({
            style_class: `atelier-cc-round atelier-cc-round-${size}`,
            child: box,
            can_focus: true,
            accessible_name: name,
            accessible_role: Atk.Role.TOGGLE_BUTTON,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._animator = animator;
        box.add_child(new St.Widget({style_class: 'atelier-cc-round-idle', x_expand: true, y_expand: true}));
        this.accent = new St.Widget({style_class: 'atelier-cc-round-accent', x_expand: true, y_expand: true});
        this.accent.set_pivot_point(0.5, 0.5);
        this.accent.set_scale(0, 0);
        box.add_child(this.accent);
        this.icon = iconOf(icon, `atelier-cc-round-icon atelier-cc-round-icon-${size}`);
        this.icon.x_align = this.icon.y_align = Clutter.ActorAlign.CENTER;
        box.add_child(this.icon);
        this._on = false;
        pressable(this, animator);
    }

    get on() {
        return this._on;
    }

    /**
     * @param {boolean} on
     * @param {boolean} [animate]
     */
    setOn(on, animate = true) {
        if (on === this._on && this._animator.targetOf(this.accent, 'scale') === undefined &&
            this.accent.scale_x === (on ? 1 : 0))
            return;
        this._on = on;
        if (on)
            this.add_accessible_state(Atk.StateType.CHECKED);
        else
            this.remove_accessible_state(Atk.StateType.CHECKED);
        this._animator.ease(this.accent, {scale: on ? 1 : 0},
            {curve: 'spring', duration: DURATIONS.toggle, instant: !animate});
    }
});

/**
 * A row of three chips (Caffeine's durations, Output's devices), the
 * selection pill under them sliding to the one chosen, its text turning
 * dark as the one left turns light.
 */
export const ChipRow = GObject.registerClass(
class AtelierCcChipRow extends St.Widget {
    /**
     * @param {Animator} animator
     * @param {Function} onChoose - (index)
     */
    _init(animator, onChoose) {
        super._init({
            style_class: 'atelier-cc-chips',
            layout_manager: new FnLayout((container, box) => this._allocateChips(box)),
        });
        this._animator = animator;
        this._selected = -1;
        this.pill = new St.Widget({style_class: 'atelier-cc-chip-pill', opacity: 0});
        this.add_child(this.pill);
        this.chips = [0, 1, 2].map(index => {
            const light = new St.Label({style_class: 'atelier-cc-chip-label', x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER, x_expand: true, y_expand: true});
            const dark = new St.Label({style_class: 'atelier-cc-chip-label atelier-cc-chip-label-dark',
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true,
                y_expand: true, opacity: 0});
            const box = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
            box.add_child(light);
            box.add_child(dark);
            const chip = pressable(new St.Button({style_class: 'atelier-cc-chip', child: box, can_focus: true,
                accessible_role: Atk.Role.RADIO_BUTTON}), animator);
            chip._light = light;
            chip._dark = dark;
            chip.connect('clicked', () => onChoose(index));
            this.add_child(chip);
            return chip;
        });
    }

    /** @param {string[]} labels - up to three */
    setLabels(labels) {
        this.chips.forEach((chip, i) => {
            const text = labels[i] ?? '';
            chip.visible = text !== '';
            chip._light.text = chip._dark.text = text;
            chip.accessible_name = text;
        });
    }

    _step() {
        // (As it was laid out: not asked of St off the stage.)
        const width = this.has_allocation() ? this.get_allocation_box().get_width() : 0;
        const gap = px(8);
        return (width - 2 * gap) / 3 + gap;
    }

    /**
     * @param {number} index - the chip chosen, -1 none
     * @param {object} [options]
     * @param {boolean} [options.shown] - the pill shows (Caffeine off: not)
     * @param {boolean} [options.animate]
     */
    select(index, {shown = true, animate = true} = {}) {
        const instant = !animate;
        const visible = shown && index >= 0;
        if (index >= 0) {
            const from = this._selected < 0 ? {translation_x: index * this._step()} : null;
            this._animator.ease(this.pill, {translation_x: index * this._step()},
                {curve: 'slide', duration: DURATIONS.select, from, instant});
        }
        this._animator.ease(this.pill, {opacity: visible ? 255 : 0},
            {curve: 'fade', duration: DURATIONS.selectColour, instant});
        this.chips.forEach((chip, i) => {
            const chosen = visible && i === index;
            this._animator.ease(chip._dark, {opacity: chosen ? 255 : 0},
                {curve: 'fade', duration: DURATIONS.selectColour, instant});
            this._animator.ease(chip._light, {opacity: chosen ? 0 : 255},
                {curve: 'fade', duration: DURATIONS.selectColour, instant});
            if (chosen)
                chip.add_accessible_state(Atk.StateType.CHECKED);
            else
                chip.remove_accessible_state(Atk.StateType.CHECKED);
        });
        if (index >= 0)
            this._selected = index;
    }

    _allocateChips(box) {
        const width = box.get_width();
        const height = box.get_height();
        const gap = px(8);
        const chip = (width - 2 * gap) / 3;
        this.chips.forEach((c, i) => place(c, i * (chip + gap), 0, chip, height));
        place(this.pill, 0, 0, chip, height);
        // (Where it rests, at once, unless on its way.)
        if (this._selected >= 0 && this._animator.targetOf(this.pill, 'translation_x') === undefined)
            this.pill.translation_x = this._selected * (chip + gap);
    }
});

/**
 * A spinner: a ring with its top white, a turn each 0.8 s.
 */
export const Spinner = GObject.registerClass(
class AtelierCcSpinner extends St.Widget {
    _init() {
        super._init({style_class: 'atelier-cc-spinner', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this.set_pivot_point(0.5, 0.5);
    }

    /** @param {boolean} spinning */
    spin(spinning) {
        if (spinning === this.visible)
            return;
        this.visible = spinning;
        this.remove_all_transitions();
        this.rotation_angle_z = 0;
        if (spinning) {
            this.ease({
                rotation_angle_z: 360, duration: DURATIONS.spin, mode: Clutter.AnimationMode.LINEAR,
                repeatCount: -1,
            });
        }
    }
});

/**
 * A row of a card's list: what it shows (icon, name, a line under, a note
 * on the right, a check or a spinner) on a highlight that fades in where it
 * is the one connected or connecting.
 */
export const ListRow = GObject.registerClass(
class AtelierCcListRow extends St.Button {
    /**
     * @param {string} kind - 'network', 'device', 'action', 'output'
     * @param {Animator} animator
     */
    _init(kind, animator) {
        const box = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        super._init({style_class: `atelier-cc-row atelier-cc-row-${kind}`, child: box, can_focus: true,
            x_expand: true});
        this._animator = animator;
        this.highlight = new St.Widget({style_class: 'atelier-cc-row-highlight', opacity: 0, x_expand: true,
            y_expand: true});
        box.add_child(this.highlight);
        const content = new St.BoxLayout({style_class: 'atelier-cc-row-content', x_expand: true});
        box.add_child(content);
        const withCircle = kind === 'device' || kind === 'output';
        this.iconBox = withCircle ? new St.Bin({style_class: 'atelier-cc-row-circle', y_align: Clutter.ActorAlign.CENTER})
            : null;
        this.icon = new St.Icon({style_class: `atelier-cc-row-icon${withCircle ? ' atelier-cc-row-icon-small' : ''}`,
            y_align: Clutter.ActorAlign.CENTER});
        if (this.iconBox) {
            this.iconBox.set_child(this.icon);
            content.add_child(this.iconBox);
        } else {
            content.add_child(this.icon);
        }
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this.title = new St.Label({style_class: 'atelier-cc-row-title'});
        this.subtitle = new St.Label({style_class: 'atelier-cc-row-subtitle', visible: false});
        text.add_child(this.title);
        text.add_child(this.subtitle);
        content.add_child(text);
        this.note = new St.Label({style_class: 'atelier-cc-row-note', y_align: Clutter.ActorAlign.CENTER,
            visible: false});
        content.add_child(this.note);
        this.spinner = new Spinner();
        content.add_child(this.spinner);
        this.check = new St.Icon({style_class: 'atelier-cc-row-check', icon_name: 'object-select-symbolic',
            y_align: Clutter.ActorAlign.CENTER, visible: false});
        content.add_child(this.check);
        this.set_pivot_point(0.5, 0.5);
        this._lit = false;
        pressable(this, animator);
    }

    /**
     * @param {object} row
     * @param {string|Gio.Icon} row.icon
     * @param {string} row.title
     * @param {string} [row.subtitle]
     * @param {string} [row.note] - "Connected", "Connecting…"
     * @param {boolean} [row.check]
     * @param {boolean} [row.spinning]
     * @param {boolean} [row.lit] - its highlight
     * @param {boolean} [animate]
     */
    update({icon, title, subtitle = '', note = '', check = false, spinning = false, lit = false}, animate = true) {
        setIcon(this.icon, icon);
        this.title.text = title;
        this.accessible_name = subtitle ? `${title}, ${subtitle}` : title;
        this.subtitle.text = subtitle;
        this.subtitle.visible = subtitle !== '';
        this.note.text = note;
        this.note.visible = note !== '';
        this.check.visible = check && !spinning;
        this.spinner.spin(spinning);
        if (lit !== this._lit || !animate) {
            this._lit = lit;
            this._animator.ease(this.highlight, {opacity: lit ? 255 : 0},
                {curve: 'fade', duration: DURATIONS.rowBg, instant: !animate});
        }
    }
});
