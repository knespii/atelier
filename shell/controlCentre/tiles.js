// The Controls tab's building blocks, as its Layout & Motion spec has them:
// a tile (its glass – raised when it is an open card – a header, what it
// shows open, what sits at its foot), a round toggle with the accent's
// circle growing under its icon, chips with a selection pill sliding
// between them, a list's rows, a spinner, the battery's bar. Sizes are the spec's
// pixels at Atelier's size (lib/ccLayout.js SIZE), as the stylesheet has
// them; their motion is lib/ccMotion.js's, run by an Animator
// (shell/controlCentre/animator.js).

import Atk from 'gi://Atk';
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {DURATIONS} from '../../lib/ccMotion.js';
import {SIZE, chipLayout} from '../../lib/ccLayout.js';
import {reducedMotion} from './animator.js';

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
        // (The chip the pill is on, or on its way to.)
        this._pillIndex = 0;
        this.pill = new St.Widget({style_class: 'atelier-cc-chip-pill', opacity: 0});
        // (Scaled from its left edge as it slides to a chip of another width.)
        this.pill.set_pivot_point(0, 0.5);
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

    /**
     * The chips in a row so wide (actor px): thirds while their labels have
     * room in them, else as each needs (lib/ccLayout.js chipLayout()).
     *
     * @param {number} width
     * @returns {{x: number, width: number}[]}
     */
    _layout(width) {
        const labels = this.chips.map(c => c.visible ? c.get_preferred_width(-1)[1] : 0);
        return chipLayout(width, labels, {gap: px(8), room: px(16)});
    }

    // The chips as they were laid out (none yet: off the stage, not asked
    // of St).
    _laidOut() {
        return this._chipRects ?? this.chips.map(() => ({x: 0, width: 0}));
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
            // (Slid there, as wide as the chip chosen: its width at once,
            // scaled from the one left's. Thirds: the same.)
            const rects = this._laidOut();
            const [to, was] = [rects[index], rects[this._selected] ?? rects[index]];
            const fresh = this._selected < 0;
            this._animator.ease(this.pill, {translation_x: to.x},
                {curve: 'slide', duration: DURATIONS.select, from: fresh ? {translation_x: to.x} : null, instant});
            this._pillIndex = index;
            if (!fresh && to.width > 0 && Math.abs(was.width - to.width) > 0.5) {
                this.queue_relayout();
                this._animator.ease(this.pill, {scale_x: 1},
                    {curve: 'slide', duration: DURATIONS.select, from: {scale_x: was.width / to.width}, instant});
            }
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
        const height = box.get_height();
        const rects = this._chipRects = this._layout(box.get_width());
        this.chips.forEach((c, i) => place(c, rects[i].x, 0, rects[i].width, height));
        place(this.pill, 0, 0, rects[this._pillIndex].width, height);
        // (Where it rests, at once, unless on its way.)
        if (this._selected >= 0 && this._animator.targetOf(this.pill, 'translation_x') === undefined)
            this.pill.translation_x = rects[this._selected].x;
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

// The battery bar's charging wave: how far its edge sways (of its height)
// and how long a wave is (of its height); its shimmer, how wide (of its
// height) and how bright.
const WAVE_SWAY = 0.035;
const WAVE_LENGTH = 0.85;
const SHIMMER_WIDTH = 1.3;
const SHIMMER_ALPHA = 0.32;
// Under the pointer: so much bigger, its light so bright.
const BAR_LIFT = 1.04;
const BAR_GLOW = 0.16;

/**
 * The system tile's battery: a tall capsule as brightness's and volume's
 * are, a faint light track in the glass filled from the left as far as
 * the level goes – white, orange when low, red when critical, green while
 * charging, a shimmer passing along it and its edge swaying then. Drawn
 * with Cairo, as one texture: the level filling it as the panel opens or
 * as it changes, the shimmer and the light under the pointer are each
 * that texture drawn again, nothing restyled or laid out anew. The
 * shimmer runs only while it charges and is on the stage (motion not
 * reduced). Under the pointer it lifts a little (a transform).
 */
export const BatteryBar = GObject.registerClass(
class AtelierCcBatteryBar extends St.DrawingArea {
    /** @param {Animator} animator */
    _init(animator) {
        super._init({style_class: 'atelier-cc-battery-bar', x_expand: true, y_expand: true, reactive: true,
            track_hover: true, accessible_role: Atk.Role.LEVEL_BAR});
        this._animator = animator;
        // Its level as shown (0 … 1), eased; where it is going.
        this.level = 0;
        this._target = 0;
        // The pointer's light (0 … 1) and where it is (of its width).
        this.glow = 0;
        this._pointerX = 0.5;
        this._tone = '';
        this._phase = 0;
        this._wave = null;
        // (Shown: not resting, see-through, in the island closed.)
        this._shown = true;
        /** How many times it was drawn (the tests'). */
        this.repaints = 0;
        this.set_pivot_point(0.5, 0.5);
        this.connect('notify::mapped', () => this._syncWave());
        this.connect('notify::hover', () => this._hovered());
        this.connect('motion-event', (actor, event) => {
            const [x] = event.get_coords();
            const [ok, local] = this.transform_stage_point(x, 0);
            if (ok && this.width > 0) {
                this._pointerX = Math.min(1, Math.max(0, local / this.width));
                this._redraw();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        St.Settings.get().connectObject('notify::enable-animations', () => this._syncWave(), this);
        this.connect('destroy', () => {
            St.Settings.get().disconnectObject(this);
            this._stopWave();
            this._animator.stop(this);
        });
    }

    /**
     * @param {number} fraction - its level, 0 … 1
     * @param {object} [options]
     * @param {boolean} [options.instant]
     */
    setLevel(fraction, {instant = false} = {}) {
        fraction = Math.min(1, Math.max(0, fraction));
        const going = this._animator.targetOf(this, 'level');
        if (fraction === (going ?? this.level) && !instant)
            return;
        this._target = fraction;
        this._animator.ease(this, {level: fraction}, {curve: 'out', duration: DURATIONS.batteryLevel,
            instant: instant || reducedMotion(), onUpdate: () => this._redraw()});
    }

    /**
     * Filled from empty to its level (the panel opening), after a delay;
     * at once with reduced motion.
     *
     * @param {number} delay - ms
     */
    grow(delay) {
        if (reducedMotion()) {
            this.setLevel(this._target, {instant: true});
            return;
        }
        this._animator.ease(this, {level: this._target}, {curve: 'out', duration: DURATIONS.batteryGrow, delay,
            from: {level: 0}, onUpdate: () => this._redraw()});
    }

    /** @param {string} tone - lib/ccLayout.js batteryTone(): 'charging', 'critical', 'low' or '' */
    setTone(tone) {
        if (tone === this._tone)
            return;
        this._tone = tone;
        this._syncWave();
        this._redraw();
    }

    /**
     * Shown or not – the panel open, or resting see-through in the island
     * closed (mapped still): its shimmer only while it is.
     *
     * @param {boolean} shown
     */
    setShown(shown) {
        this._shown = shown;
        this._syncWave();
    }

    /** @returns {boolean} whether its shimmer runs (while charging, shown) */
    get waving() {
        return Boolean(this._wave?.is_playing());
    }

    _syncWave() {
        const run = this._tone === 'charging' && this._shown && this.mapped && !reducedMotion();
        if (run && !this._wave) {
            this._wave = new Clutter.Timeline({actor: this, duration: DURATIONS.batteryWave, repeat_count: -1});
            this._wave.connect('new-frame', timeline => {
                this._phase = timeline.get_progress();
                this._redraw();
            });
            this._wave.start();
        } else if (!run && this._wave) {
            this._stopWave();
            this._phase = 0;
            this._redraw();
        }
    }

    _stopWave() {
        const wave = this._wave;
        this._wave = null;
        wave?.stop();
    }

    // Drawn again – only on the stage (the shell quitting, a frame of an
    // ease may come after it is gone).
    _redraw() {
        if (this.get_stage())
            this.queue_repaint();
    }

    _hovered() {
        const on = this.hover;
        this._animator.ease(this, {scale: on ? BAR_LIFT : 1, glow: on ? 1 : 0},
            {curve: on ? 'out' : 'fade', duration: DURATIONS.batteryHover, onUpdate: () => this._redraw()});
    }

    vfunc_repaint() {
        this.repaints++;
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const color = name => {
            const [, c] = node.lookup_color(name, false);
            return [c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255];
        };
        const radius = Math.min(height / 2, node.get_border_radius(St.Corner.TOPLEFT));
        const k = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const capsule = () => {
            cr.newSubPath();
            cr.arc(width - radius, radius, radius, -Math.PI / 2, 0);
            cr.arc(width - radius, height - radius, radius, 0, Math.PI / 2);
            cr.arc(radius, height - radius, radius, Math.PI / 2, Math.PI);
            cr.arc(radius, radius, radius, Math.PI, 1.5 * Math.PI);
            cr.closePath();
        };
        // The track.
        capsule();
        cr.setSourceRGBA(...color('-atelier-track-color'));
        cr.fillPreserve();
        cr.clip();
        // The fill, its edge swaying while it charges.
        const charging = this._tone === 'charging';
        const fill = this.level * width;
        if (fill > 0.5) {
            const sway = charging && this._wave ? WAVE_SWAY * height : 0;
            cr.moveTo(0, 0);
            if (sway > 0) {
                const length = WAVE_LENGTH * height;
                for (let y = 0; y <= height; y += Math.max(1, k)) {
                    const x = fill - sway + sway * Math.sin(2 * Math.PI * (y / length - this._phase));
                    cr.lineTo(Math.max(0, x), y);
                }
            } else {
                cr.lineTo(fill, 0);
                cr.lineTo(fill, height);
            }
            cr.lineTo(0, height);
            cr.closePath();
            const tone = {charging: '-atelier-charging-color', low: '-atelier-low-color',
                critical: '-atelier-critical-color'}[this._tone] ?? '-atelier-fill-color';
            cr.setSourceRGBA(...color(tone));
            if (sway > 0) {
                cr.fillPreserve();
                // A shimmer passing along it, left to right.
                const band = SHIMMER_WIDTH * height;
                const x = -band + this._phase * (fill + 2 * band);
                const shimmer = new Cairo.LinearGradient(x - band, 0, x + band, 0);
                shimmer.addColorStopRGBA(0, 1, 1, 1, 0);
                shimmer.addColorStopRGBA(0.5, 1, 1, 1, SHIMMER_ALPHA);
                shimmer.addColorStopRGBA(1, 1, 1, 1, 0);
                cr.setSource(shimmer);
                cr.fill();
            } else {
                cr.fill();
            }
        }
        // The pointer's light.
        if (this.glow > 0.01) {
            const x = this._pointerX * width;
            const light = new Cairo.RadialGradient(x, height / 2, 0, x, height / 2, height * 1.4);
            light.addColorStopRGBA(0, 1, 1, 1, BAR_GLOW * this.glow);
            light.addColorStopRGBA(1, 1, 1, 1, 0);
            cr.setSource(light);
            cr.paint();
        }
        // Its rim.
        cr.resetClip();
        const inset = k / 2;
        cr.save();
        cr.translate(inset, inset);
        cr.scale((width - 2 * inset) / width, (height - 2 * inset) / height);
        capsule();
        cr.restore();
        cr.setLineWidth(k);
        cr.setSourceRGBA(...color('-atelier-rim-color'));
        cr.stroke();
        cr.$dispose();
    }
});
