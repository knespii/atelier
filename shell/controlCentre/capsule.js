// Brightness and volume as iOS's Control Center has them: a tall capsule
// filled from the bottom as far as the level goes, the icon low in it, no
// knob (lib/levelCapsule.js). It is GNOME's own slider (a QuickSlider:
// GNOME's brightness, its volume, its microphone) shown so: its value both
// ways, its icon, its mute (a click on the icon), its menu (the outputs: a
// chevron at the top, a right click, the Menu key – the chevron only if
// asked for). GNOME's slider itself is kept off the stage meanwhile, alive
// (shell/controlCentre/host.js).
//
// Held, it behaves as a thing in the hand (the control centre's spec,
// "Tažení sliderů"): it lifts (the capsule itself scales, 1.045), its edge
// brightens, it throws a shadow, the value shows at its top, the fill's
// edge glows and follows the pointer exactly – past either end the body
// stretches like rubber toward the pointer (9 % at most) – and the other
// capsules of its group dim. Let go, it settles with a spring. Two layers,
// never one: the capsule (lift, dimming) and its body (the rubber, from
// the edge away from the pointer), so a change of that edge never jumps.
//
// Its icon reacts: dark once the fill covers it (17 %), light on the
// glass; the sun's rays turn and grow with the brightness; the speaker's
// waves, one then two, or its cross at 0; and a bump on reaching 0 or
// 100 %.
//
// Drawn without anything laid out or restyled as it moves: the fill is a
// rounded rect as big as the capsule, clipped to the part under the
// level; the rest moves by transforms and opacity (the value's figures,
// drawn with Cairo, only redrawn). GNOME is told the value ~30 times a
// second; the capsule follows each frame.
//
// For the page: new LevelCapsule(item, name, {menu, group}); 'drag-begin'
// and 'drag-end' as it is held and let go; `dimmed` to dim it (eased).
// Capsules of the same group (default 'control-centre') dim each other
// themselves; group: null leaves that to the page.

import Atk from 'gi://Atk';
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {SIZE} from '../../lib/ccLayout.js';
import {EASE, linear} from '../../lib/cubicBezier.js';
import {
    PAGE, STEP, bumpScale, bumps, fillTop, iconCovered, levelOf, originOf,
    pointerLevel, sendDelay, speakerParts, splitAt, stepped, stretchOf, sunRays, valueOf,
} from '../../lib/levelCapsule.js';

// The spec's times (ms) and curves.
const MOTION = {
    grab: [220, EASE.grab],
    release: [520, EASE.release],
    stretch: [60, linear],
    rubber: [620, EASE.rubber],
    settle: [340, EASE.settle],
    ink: [200, EASE.ease],
    rays: [160, EASE.ease],
    parts: [200, EASE.ease],
    bump: [360, EASE.bump],
    dim: [250, EASE.ease],
};
// Less motion asked for: no springs, short.
const REDUCED = [150, EASE.out];

// Held: lifted so much; the other capsules dimmed to so much.
const LIFT = 1.045;
const DIMMED = 0.55;
// (Logical pixels: the spec's at Atelier's size, lib/ccLayout.js SIZE.)
// Its shadow as it is held.
const SHADOW = {y: 18 * SIZE, blur: 44 * SIZE, alpha: 0.38};
// The glow over the fill's edge (its box-shadow: 0 −4 22 white at 0.5).
const GLOW = {rise: 4 * SIZE, blur: 22 * SIZE, alpha: 0.5};
// The focus ring: so far out (its offset and its width).
const RING_OUT = 7.5 * SIZE;
// A click so near the icon (above or below it) is on it: GNOME's mute.
const ICON_REACH = 15 * SIZE;

// A colour of a theme node's, for Cairo (the stylesheet's, as the
// adaptive type sets it: lib/vibrancy.js).
const rgbaOf = color => [color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255];

const NAMES = {brightness: 'Brightness', volume: 'Volume', microphone: 'Microphone'};

const now = () => GLib.get_monotonic_time() / 1000;
const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

// GNOME 50 asks for less motion apart from animations off.
let a11y;
function reducedMotion() {
    if (!St.Settings.get().enable_animations)
        return true;
    if (a11y === undefined) {
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup('org.gnome.desktop.a11y.interface', true);
        a11y = schema?.has_key('reduced-motion') ? new Gio.Settings({schema_id: 'org.gnome.desktop.a11y.interface'}) : null;
    }
    return Boolean(a11y?.get_boolean('reduced-motion'));
}

/**
 * Values eased each frame, any curve (a spring's that overshoots too):
 * Clutter's own modes can't. A change mid-way goes on from where it is.
 */
class Motion {
    /**
     * @param {Clutter.Actor} actor - whose frames drive it
     * @param {function(string, number)} apply - a value to the actors
     */
    constructor(actor, apply) {
        this._actor = actor;
        this._apply = apply;
        this._values = new Map();
        this._tweens = new Map();
        this._timeline = null;
    }

    get(name) {
        return this._values.get(name) ?? 0;
    }

    /** At once. */
    set(name, value) {
        this._tweens.delete(name);
        this._put(name, value);
    }

    /**
     * Eased there, from where it is.
     *
     * @param {string} name
     * @param {number} to
     * @param {Array} motion - [ms, curve]
     */
    to(name, to, [duration, ease]) {
        const tween = this._tweens.get(name);
        if (tween ? !tween.fn && tween.to === to : this.get(name) === to)
            return;
        if (!(duration > 0) || !this._actor.mapped) {
            this.set(name, to);
            return;
        }
        this._tweens.set(name, {from: this.get(name), to, start: now(), duration, ease});
        this._run();
    }

    /**
     * Keyframes: the value fn(t) through it, t 0 … 1 (anew if it plays).
     */
    play(name, fn, duration) {
        if (!(duration > 0) || !this._actor.mapped) {
            this.set(name, fn(1));
            return;
        }
        this._tweens.set(name, {fn, start: now(), duration});
        this._run();
    }

    /** All at their ends. */
    finish() {
        for (const [name, tween] of [...this._tweens])
            this.set(name, tween.fn ? tween.fn(1) : tween.to);
        this._timeline?.stop();
    }

    destroy() {
        this._tweens.clear();
        this._timeline?.stop();
        this._timeline = null;
    }

    _put(name, value) {
        if (this._values.get(name) === value)
            return;
        this._values.set(name, value);
        this._apply(name, value);
    }

    _run() {
        if (!this._timeline) {
            this._timeline = new Clutter.Timeline({actor: this._actor, duration: 1000, repeat_count: -1});
            this._timeline.connect('new-frame', () => this._tick());
        }
        if (!this._timeline.is_playing())
            this._timeline.start();
    }

    _tick() {
        const t = now();
        for (const [name, tween] of [...this._tweens]) {
            const p = Math.min(1, Math.max(0, (t - tween.start) / tween.duration));
            if (p >= 1)
                this._tweens.delete(name);
            if (tween.fn)
                this._put(name, tween.fn(p));
            else
                this._put(name, p >= 1 ? tween.to : tween.from + (tween.to - tween.from) * tween.ease(p));
        }
        if (!this._tweens.size)
            this._timeline.stop();
    }
}

// A rounded rect's path.
function roundedRect(cr, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// The normal distribution's quantile, near enough for a shadow's layers.
function probit(p) {
    // (A logistic's, scaled to the normal's slope.)
    return Math.log(p / (1 - p)) / 1.702;
}

/**
 * The capsule's shadow as it is held: drawn once for its size, outside
 * it only (St's box-shadow would darken its glass from under it too).
 */
const CapsuleShadow = GObject.registerClass(
class AtelierCapsuleShadow extends St.DrawingArea {
    _init() {
        super._init({opacity: 0});
        this.radius = 0;
        this.extent = 0;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const s = scaleFactor();
        const e = this.extent;
        const [w, h] = [width - 2 * e, height - 2 * e];
        if (w > 0 && h > 0) {
            // A Gaussian blur as layers of the shape, each grown a little,
            // their alphas added.
            const sigma = SHADOW.blur * s / 2;
            const layers = 14;
            cr.setOperator(Cairo.Operator.ADD);
            cr.setSourceRGBA(0, 0, 0, SHADOW.alpha / layers);
            for (let k = 0; k < layers; k++) {
                const grow = sigma * probit((k + 0.5) / layers);
                roundedRect(cr, e - grow, e - grow + SHADOW.y * s, w + 2 * grow, h + 2 * grow, this.radius + grow);
                cr.fill();
            }
            // None under the capsule.
            cr.setOperator(Cairo.Operator.CLEAR);
            roundedRect(cr, e, e, w, h, this.radius);
            cr.fill();
        }
        cr.$dispose();
    }
});

/**
 * The glow over the fill's edge as it is held, faded up from the edge.
 */
const EdgeGlow = GObject.registerClass(
class AtelierCapsuleGlow extends St.DrawingArea {
    _init() {
        super._init({opacity: 0});
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const s = scaleFactor();
        // (The box-shadow's profile above the edge: half its blur's
        // Gaussian, risen.)
        const sigma = GLOW.blur * s / 2;
        const rise = GLOW.rise * s;
        const gradient = new Cairo.LinearGradient(0, height, 0, 0);
        for (let i = 0; i <= 6; i++) {
            const d = height * i / 6;
            const z = (d - rise) / sigma;
            // 1 − Φ(z), near enough.
            const alpha = GLOW.alpha / (1 + Math.exp(1.702 * z));
            gradient.addColorStopRGBA(i / 6, 1, 1, 1, alpha);
        }
        cr.setSource(gradient);
        cr.rectangle(0, 0, width, height);
        cr.fill();
        cr.$dispose();
    }
});

/**
 * A part of the icon drawn in one colour (its paths in a 24-unit box).
 */
const Ink = GObject.registerClass(
class AtelierCapsuleInk extends St.DrawingArea {
    _init(draw, styleClass) {
        super._init({style_class: styleClass, x_expand: true, y_expand: true});
        this._draw = draw;
        this.connect('style-changed', () => this.queue_repaint());
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const unit = Math.min(width, height) / 24;
        cr.translate((width - 24 * unit) / 2, (height - 24 * unit) / 2);
        cr.scale(unit, unit);
        cr.setSourceRGBA(...rgbaOf(this.get_theme_node().get_foreground_color()));
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        this._draw(cr);
        cr.$dispose();
    }
});

// The icons' parts (24 × 24, as Lucide's sun and volume).
const PATHS = {
    core(cr) {
        cr.arc(12, 12, 4.4, 0, 2 * Math.PI);
        cr.fill();
    },
    rays(cr) {
        cr.setLineWidth(2.2);
        for (let i = 0; i < 8; i++) {
            const a = i * Math.PI / 4;
            cr.moveTo(12 + 7.6 * Math.sin(a), 12 - 7.6 * Math.cos(a));
            cr.lineTo(12 + 10 * Math.sin(a), 12 - 10 * Math.cos(a));
        }
        cr.stroke();
    },
    speaker(cr) {
        cr.moveTo(3.4, 9);
        cr.lineTo(6.6, 9);
        cr.lineTo(11, 5);
        cr.lineTo(11, 19);
        cr.lineTo(6.6, 15);
        cr.lineTo(3.4, 15);
        cr.closePath();
        cr.setLineWidth(1.6);
        cr.strokePreserve();
        cr.fill();
    },
    wave1(cr) {
        cr.setLineWidth(2.1);
        cr.arc(12, 12, 5, -0.6435, 0.6435);
        cr.stroke();
    },
    wave2(cr) {
        cr.setLineWidth(2.1);
        cr.arc(13, 12, 9, -Math.PI / 4, Math.PI / 4);
        cr.stroke();
    },
    cross(cr) {
        cr.setLineWidth(2.1);
        cr.moveTo(16, 9);
        cr.lineTo(22, 15);
        cr.moveTo(22, 9);
        cr.lineTo(16, 15);
        cr.stroke();
    },
};

/**
 * One part of the icon, light and dark (crossfaded: no restyle).
 */
const Part = GObject.registerClass(
class AtelierCapsuleIconPart extends St.Widget {
    _init(path) {
        super._init({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this.set_pivot_point(0.5, 0.5);
        this.light = new Ink(PATHS[path], 'atelier-cc-capsule-icon');
        this.dark = new Ink(PATHS[path], 'atelier-cc-capsule-icon-filled');
        this.add_child(this.light);
        this.add_child(this.dark);
    }
});

/**
 * The capsule's icon: the sun (brightness), the speaker (volume), or
 * GNOME's (the microphone) – light, or dark over the fill.
 */
const CapsuleIcon = GObject.registerClass(
class AtelierCapsuleIcon extends St.Widget {
    _init(kind) {
        super._init({
            style_class: 'atelier-cc-capsule-icon-box',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        this.set_pivot_point(0.5, 0.5);
        this.parts = {};
        const paths = {brightness: ['core', 'rays'], volume: ['speaker', 'wave1', 'wave2', 'cross']}[kind];
        this._layers = [];
        if (paths) {
            for (const path of paths) {
                const part = new Part(path);
                this.parts[path] = part;
                this.add_child(part);
                this._layers.push([part.light, part.dark]);
            }
        } else {
            this._light = new St.Icon({style_class: 'atelier-cc-capsule-icon'});
            this._dark = new St.Icon({style_class: 'atelier-cc-capsule-icon-filled'});
            this.add_child(this._light);
            this.add_child(this._dark);
            this._layers.push([this._light, this._dark]);
        }
    }

    /** @param {Gio.Icon|null} gicon - GNOME's (only where it draws none) */
    set gicon(gicon) {
        if (this._light) {
            this._light.gicon = gicon;
            this._dark.gicon = gicon;
        }
    }

    /** @returns {Cogl.Color} the icon's colour on the fill */
    darkInk() {
        return this._layers[0][1].get_theme_node().get_foreground_color();
    }

    /** @param {number} ink - 0 light … 1 dark */
    set ink(ink) {
        const dark = Math.round(255 * Math.min(1, Math.max(0, ink)));
        for (const [light, darkLayer] of this._layers) {
            light.opacity = 255 - dark;
            darkLayer.opacity = dark;
        }
    }
});

/**
 * An icon twice over: light on the glass, dark on the fill (the menu's
 * chevron, at the top: split by the fill's edge).
 */
const SplitIcon = GObject.registerClass(
class AtelierSplitIcon extends St.Widget {
    _init(style, params = {}) {
        super._init({layout_manager: new Clutter.BinLayout(), ...params});
        this.glass = new St.Icon({style_class: style});
        this.filled = new St.Icon({style_class: `${style}-filled`});
        this.add_child(this.glass);
        this.add_child(this.filled);
    }

    /** @param {string} name */
    set iconName(name) {
        this.glass.icon_name = name;
        this.filled.icon_name = name;
    }

    /** @param {number} top - the fill's top edge, from this one's top */
    split(top) {
        const width = this.width;
        const {glass, fill} = splitAt(top, 0, this.height);
        this.glass.set_clip(0, glass.y, width, glass.height);
        this.filled.set_clip(0, fill.y, width, fill.height);
        this.glass.opacity = glass.height > 0 ? 255 : 0;
        this.filled.opacity = fill.height > 0 ? 255 : 0;
    }
});

/**
 * The capsule's body: what stretches. Its glass (the track), the fill,
 * the icon, the value; the shadow round it, the glow on the fill's edge.
 */
const CapsuleBody = GObject.registerClass(
class AtelierCapsuleBody extends St.Widget {
    _init() {
        super._init({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this.shadow = new CapsuleShadow();
        this.track = new St.Widget({style_class: 'atelier-cc-capsule-track', x_expand: true, y_expand: true});
        this.edge = new St.Widget({style_class: 'atelier-cc-capsule-edge', x_expand: true, y_expand: true, opacity: 0});
        this.fill = new St.Widget({style_class: 'atelier-cc-capsule-fill', x_expand: true, y_expand: true});
        this.glow = new EdgeGlow();
        for (const child of [this.shadow, this.track, this.fill, this.glow, this.edge])
            this.add_child(child);
        this.inset = 0;
        this.radius = 0;
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const [width, height] = [box.get_width(), box.get_height()];
        const node = this.track.get_theme_node();
        this.inset = node.get_border_width(St.Side.TOP);
        this.radius = node.get_border_radius(St.Corner.TOPLEFT);
        const s = scaleFactor();
        // (Round it, as far as its blur and drop go.)
        const extent = Math.ceil((SHADOW.blur + SHADOW.y) * s);
        if (extent !== this.shadow.extent || this.radius !== this.shadow.radius) {
            this.shadow.extent = extent;
            this.shadow.radius = this.radius;
            this.shadow.queue_repaint();
        }
        this.shadow.allocate(Clutter.ActorBox.new(-extent, -extent, width + extent, height + extent));
        // The fill inside the glass's edge.
        const i = this.inset;
        this.fill.allocate(Clutter.ActorBox.new(i, i, width - i, height - i));
        // The glow: as tall as it reaches, moved to the fill's edge.
        const reach = Math.ceil((GLOW.blur + GLOW.rise) * s);
        this.glow.allocate(Clutter.ActorBox.new(i, 0, width - i, reach));
    }
});

// The capsules of each group, which dim each other as one is held.
const groups = new Map();

/**
 * GNOME's QuickSlider as a capsule.
 */
export const LevelCapsule = GObject.registerClass({
    Properties: {
        // How full it shows, 0 … 1 (eased to the slider's).
        'level': GObject.ParamSpec.double('level', null, null, GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
    Signals: {
        // Held (lifted, the value shown), let go.
        'drag-begin': {},
        'drag-end': {},
    },
}, class AtelierLevelCapsule extends St.Widget {
    /**
     * @param {QuickSettings.QuickSlider} item - GNOME's
     * @param {string} name - 'brightness', 'volume', 'microphone'
     * @param {object} [options]
     * @param {boolean} [options.menu] - a chevron at the top for GNOME's
     *   menu (the outputs), where it has one
     * @param {string|null} [options.group] - the capsules that dim each
     *   other as one is held (null: none; the page may, from the signals)
     */
    _init(item, name, {menu = true, group = 'control-centre'} = {}) {
        super._init({
            style_class: `atelier-cc-capsule atelier-cc-capsule-${name}`,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: true,
            x_expand: true,
            y_expand: true,
            accessible_role: Atk.Role.SLIDER,
        });
        this.set_pivot_point(0.5, 0.5);
        this._level = 0;
        this._dimmed = false;
        this._kind = name;
        this.item = item;
        this.slider = item.slider;
        this._press = null;
        this._grab = null;
        this._held = false;
        this._origin = 'bottom';
        this._pending = null;
        this._sentAt = null;
        this._sendId = 0;
        // (The ancestors whose clip it lifted while it is out of its place.)
        this._unclipped = null;

        this._body = new CapsuleBody();
        // (Stretched up, its bottom holds: this._origin.)
        this._body.set_pivot_point(0.5, 1);
        this.add_child(this._body);
        this.track = this._body.track;
        this._fill = this._body.fill;
        this.icon = new CapsuleIcon(name);
        this._body.add_child(this.icon);
        // The menu (Sound's outputs), where GNOME has one and it is asked for.
        this.menuButton = null;
        this._chevron = null;
        if (menu) {
            this._chevron = new SplitIcon('atelier-cc-capsule-menu-icon');
            this._chevron.iconName = 'go-next-symbolic';
            this.menuButton = new St.Button({
                style_class: 'atelier-cc-capsule-menu',
                child: this._chevron,
                can_focus: true,
                accessible_name: 'Open menu',
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.START,
                x_expand: true,
                y_expand: true,
            });
            this.menuButton.connect('clicked', () => this.openMenu());
            this._body.add_child(this.menuButton);
        }
        // Focused from the keyboard: a ring round it, apart.
        this._ring = new St.Widget({style_class: 'atelier-cc-capsule-ring', visible: false});
        this.add_child(this._ring);
        this.connect('key-focus-in', () => (this._ring.visible = true));
        this.connect('key-focus-out', () => (this._ring.visible = false));

        this._motion = new Motion(this, (key, value) => this._apply(key, value));

        this._customAccessible = St.GenericAccessible.new_for_actor(this);
        this.set_accessible(this._customAccessible);
        this._customAccessible.connectObject(
            'get-current-value', () => this.slider.value,
            'get-minimum-value', () => 0,
            'get-maximum-value', () => this.slider.maximum_value,
            'set-current-value', (_, value) => (this.slider.value = value),
            this);

        // GNOME's icon (the microphone's), its menu, its name.
        const sync = () => {
            this.icon.gicon = item.gicon ?? null;
            if (this.menuButton)
                this.menuButton.visible = Boolean(item.menuEnabled && item.menu);
            this.accessible_name = this.slider.accessible_name || NAMES[name] || '';
        };
        sync();
        item.connectObject(
            'notify::gicon', sync,
            'notify::icon-name', sync,
            'notify::menu-enabled', sync,
            this);
        this.slider.connectObject(
            'notify::value', () => this._follow(),
            'notify::maximum-value', () => this._follow(),
            this);

        this._group = group;
        if (group) {
            if (!groups.has(group))
                groups.set(group, new Set());
            groups.get(group).add(this);
        }

        // As it is, at once.
        const target = this._target();
        for (const [key, value] of [['lift', 1], ['stretch', 1], ['bump', 1], ['dim', 0]])
            this._motion.set(key, value);
        this._motion.set('level', target);
        this._react(target, true);

        this.connect('notify::mapped', () => {
            if (!this.mapped) {
                this._endPress();
                this._motion.finish();
                this._overflow(this._out());
            }
        });
        this.connect('destroy', () => {
            this._endPress();
            this._motion.destroy();
            this._overflow(false);
            if (this._sendId)
                GLib.source_remove(this._sendId);
            this._sendId = 0;
            groups.get(group)?.delete(this);
            item.disconnectObject(this);
            this.slider.disconnectObject(this);
            this._customAccessible.disconnectObject(this);
        });
    }

    get level() {
        return this._level;
    }

    set level(level) {
        level = Math.min(1, Math.max(0, level));
        if (level === this._level)
            return;
        this._level = level;
        this.notify('level');
        this._split();
        this._customAccessible?.notify('accessible-value');
    }

    /** @returns {boolean} whether it is held (lifted, the value shown) */
    get held() {
        return this._held;
    }

    /** @returns {boolean} whether it is dimmed (another of its group held) */
    get dimmed() {
        return this._dimmed;
    }

    /** @param {boolean} dimmed - eased to 0.55 opacity, or back */
    set dimmed(dimmed) {
        dimmed = Boolean(dimmed);
        if (dimmed === this._dimmed)
            return;
        this._dimmed = dimmed;
        this._motion.to('dim', dimmed ? 1 : 0, this._mode('dim'));
    }

    /** @returns {number} how far it is stretched now (1: not) */
    get stretch() {
        return this._body.scale_y;
    }

    /** @returns {number} the level GNOME's slider is at */
    _target() {
        return levelOf(this.slider.value, this.slider.maximum_value);
    }

    // A motion's time and curve, or the reduced one.
    _mode(key) {
        return reducedMotion() ? REDUCED : MOTION[key];
    }

    // A value of the motion to the actors.
    _apply(key, value) {
        switch (key) {
        case 'level':
            this.level = value;
            break;
        case 'lift':
            this.set_scale(value, value);
            this._overflow(this._out());
            break;
        case 'stretch':
            this._body.scale_y = value;
            this._overflow(this._out());
            break;
        case 'dim':
            this.opacity = Math.round(255 * (1 - (1 - DIMMED) * value));
            break;
        case 'ink':
            this.icon.ink = value;
            break;
        case 'bump':
            this.icon.set_scale(value, value);
            break;
        case 'sun': {
            const rays = this.icon.parts.rays;
            const {angle, scale} = sunRays(value);
            rays.rotation_angle_z = angle;
            rays.set_scale(scale, scale);
            break;
        }
        case 'wave1':
        case 'wave2':
        case 'cross':
            this.icon.parts[key].opacity = Math.round(255 * Math.min(1, Math.max(0, value)));
            break;
        }
    }

    // The icon and the value for a level (eased each its own way).
    _react(level, atOnce = false) {
        const ease = (key, value, motion) => (atOnce ? this._motion.set(key, value) : this._motion.to(key, value, this._mode(motion)));
        ease('ink', iconCovered(level) ? 1 : 0, 'ink');
        if (this.icon.parts.rays)
            ease('sun', level * 100, 'rays');
        if (this.icon.parts.speaker) {
            const parts = speakerParts(Math.round(level * 100));
            for (const key of ['wave1', 'wave2', 'cross'])
                ease(key, parts[key] ? 1 : 0, 'parts');
        }
    }

    // Up on reaching an end, and back.
    _bump() {
        if (reducedMotion())
            return;
        const [duration] = MOTION.bump;
        this._motion.play('bump', t => bumpScale(t, EASE.bump), duration);
    }

    // GNOME's slider moved (by a key, a scroll, GNOME): there, eased –
    // unless held (the pointer has it then).
    _follow() {
        if (this._held)
            return;
        const target = this._target();
        this._react(target);
        this._motion.to('level', target, this._mode('settle'));
    }

    /**
     * Set GNOME's slider (which tells GNOME: the brightness, the volume).
     *
     * @param {number} level - 0 … 1
     */
    setLevel(level) {
        this.slider.value = valueOf(level, this.slider.maximum_value);
    }

    // Held: GNOME told ~30 times a second, the last at once as it is let go.
    _send(level) {
        this._pending = level;
        const delay = sendDelay(now(), this._sentAt);
        if (delay <= 0) {
            this._flush();
        } else if (!this._sendId) {
            this._sendId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(delay), () => {
                this._sendId = 0;
                this._flush();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _flush() {
        if (this._sendId)
            GLib.source_remove(this._sendId);
        this._sendId = 0;
        if (this._pending === null)
            return;
        const level = this._pending;
        this._pending = null;
        this._sentAt = now();
        this.setLevel(level);
    }

    /** Open GNOME's menu (Sound's outputs), where it has one. */
    openMenu() {
        if (this.item.menuEnabled && this.item.menu)
            this.item.menu.open(true);
    }

    // The fill, the glow on its edge and the chevron as the level has
    // them: clips and a move only.
    _split() {
        const body = this._body;
        const height = body.height;
        if (!(height > 0))
            return;
        const top = fillTop(this._level, height);
        const inset = body.inset;
        const fill = this._fill;
        fill.set_clip(0, top - inset, fill.width, Math.max(0, height - inset - top));
        fill.opacity = top < height - inset ? 255 : 0;
        this._glowAt(top);
        if (this._chevron?.mapped) {
            let y = 0;
            for (let a = this._chevron; a && a !== this; a = a.get_parent())
                y += a.get_allocation_box().y1;
            this._chevron.split(top - y);
        }
    }

    // The glow above the fill's edge, faded where the glass rounds off
    // (it would show past its corners).
    _glowAt(top) {
        const {glow, radius} = this._body;
        const height = this._body.height;
        glow.translation_y = top - glow.height;
        const room = radius > 0 ? Math.min(top, height - top) / radius : 1;
        glow.opacity = this._held ? Math.round(255 * Math.min(1, Math.max(0, room))) : 0;
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const out = RING_OUT * scaleFactor();
        this._ring.allocate(Clutter.ActorBox.new(-out, -out, box.get_width() + out, box.get_height() + out));
        this._split();
    }

    // Whether it is out of its place: held, lifted or stretched.
    _out() {
        return this._held || this._motion.get('lift') !== 1 || this._motion.get('stretch') !== 1;
    }

    // Out of its place, it may reach past the page (the island clips what
    // is in it, for its corners as it grows): its stretch, lift and shadow
    // seen whole, its ancestors' clips lifted until it is back. (Only
    // while a capsule is held or settling: the page is at rest then.)
    _overflow(out) {
        if (out === Boolean(this._unclipped))
            return;
        if (out) {
            this._unclipped = [];
            for (let actor = this.get_parent(); actor; actor = actor.get_parent()) {
                if (actor.clip_to_allocation) {
                    actor.clip_to_allocation = false;
                    this._unclipped.push(actor);
                }
            }
        } else {
            for (const actor of this._unclipped)
                actor.clip_to_allocation = true;
            this._unclipped = null;
        }
    }

    // Lifted as it is held, or set down.
    _hold(held) {
        if (held === this._held)
            return;
        this._held = held;
        const reduced = reducedMotion();
        const {edge, shadow} = this._body;
        edge.opacity = held ? 255 : 0;
        shadow.opacity = held ? 255 : 0;
        this._glowAt(fillTop(this._level, this._body.height));
        this._motion.to('lift', held ? LIFT : 1, reduced ? REDUCED : held ? MOTION.grab : MOTION.release);
        if (!held)
            this._motion.to('stretch', 1, reduced ? REDUCED : MOTION.rubber);
        this._overflow(this._out());
        for (const other of groups.get(this._group) ?? []) {
            if (other !== this)
                other.dimmed = held;
        }
        this.emit(held ? 'drag-begin' : 'drag-end');
    }

    // The pointer at y (in the parent's coordinates): the level there, the
    // rubber past an end.
    _pointer(y) {
        const press = this._press;
        const {value, over} = pointerLevel(y, press.top, press.bottom);
        if (bumps(value, press.previous))
            this._bump();
        press.previous = value;
        const level = value / 100;
        this._react(level);
        this._motion.set('level', level);
        this._send(level);
        if (!reducedMotion()) {
            const origin = originOf(over, this._origin);
            if (origin !== this._origin) {
                this._origin = origin;
                this._body.set_pivot_point(0.5, origin === 'bottom' ? 1 : 0);
            }
            this._motion.to('stretch', stretchOf(over), MOTION.stretch);
        }
    }

    // The icon's part of it: a click there mutes (where GNOME's does).
    _onIcon(y) {
        const box = this.icon.get_allocation_box();
        const reach = ICON_REACH * scaleFactor();
        return this.item.iconReactive && y >= box.y1 - reach && y <= box.y2 + reach;
    }

    // GNOME's volume plays its sound as a drag ends, from its stream: told
    // of drags only while it has one (as its own slider only shows then).
    _tellsDrags() {
        return !('stream' in this.item) || Boolean(this.item.stream);
    }

    // Where the pointer is in the parent's coordinates (where its
    // allocation is: as it is laid out, before it lifts).
    _parentY(event) {
        const [x, y] = event.get_coords();
        const parent = this.get_parent();
        if (!parent)
            return 0;
        const [, , py] = parent.transform_stage_point(x, y);
        return py;
    }

    _beginPress(event) {
        this._endPress();
        const box = this.get_allocation_box();
        const y = this._parentY(event);
        this._press = {
            y, top: box.y1, bottom: box.y2, onIcon: this._onIcon(y - box.y1),
            previous: Math.round(this._target() * 100), taken: false,
        };
        this._grab = global.stage.grab(this);
        // (On the icon, a click mutes: taken only once it moves.)
        if (!this._press.onIcon)
            this._take(y);
    }

    // The value is the pointer's from now on.
    _take(y) {
        this._press.taken = true;
        // (GNOME plays its sound for the volume once it is let go.)
        if (this._tellsDrags())
            this.slider.emit('drag-begin');
        this._hold(true);
        this._pointer(y);
    }

    _movePress(event) {
        const press = this._press;
        if (!press)
            return;
        const y = this._parentY(event);
        if (!press.taken) {
            const threshold = Clutter.Settings.get_default().dnd_drag_threshold ?? 8;
            if (Math.abs(y - press.y) >= threshold)
                this._take(y);
            return;
        }
        this._pointer(y);
    }

    _releasePress() {
        const press = this._press;
        if (!press)
            return;
        this._endPress();
        if (!press.taken && press.onIcon)
            this.item.emit('icon-clicked');
    }

    _endPress() {
        this._grab?.dismiss();
        this._grab = null;
        const taken = this._press?.taken;
        this._press = null;
        if (!taken)
            return;
        this._flush();
        if (this._tellsDrags())
            this.slider.emit('drag-end');
        this._hold(false);
        this._follow();
    }

    vfunc_button_press_event(event) {
        const button = event.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this.openMenu();
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._beginPress(event);
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._press)
            return Clutter.EVENT_PROPAGATE;
        this._movePress(event);
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._press || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._releasePress();
        return Clutter.EVENT_STOP;
    }

    vfunc_touch_event(event) {
        switch (event.type()) {
        case Clutter.EventType.TOUCH_BEGIN:
            this._beginPress(event);
            return Clutter.EVENT_STOP;
        case Clutter.EventType.TOUCH_UPDATE:
            this._movePress(event);
            return Clutter.EVENT_STOP;
        case Clutter.EventType.TOUCH_END:
            this._releasePress();
            return Clutter.EVENT_STOP;
        case Clutter.EventType.TOUCH_CANCEL:
            this._endPress();
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    vfunc_scroll_event(event) {
        // (As GNOME's slider scrolls: its steps, smooth scrolling too.)
        return this.slider.scroll(event);
    }

    vfunc_key_press_event(event) {
        const steps = {
            [Clutter.KEY_Up]: STEP,
            [Clutter.KEY_KP_Up]: STEP,
            [Clutter.KEY_Down]: -STEP,
            [Clutter.KEY_KP_Down]: -STEP,
            [Clutter.KEY_Page_Up]: PAGE,
            [Clutter.KEY_KP_Page_Up]: PAGE,
            [Clutter.KEY_Page_Down]: -PAGE,
            [Clutter.KEY_KP_Page_Down]: -PAGE,
            [Clutter.KEY_End]: Infinity,
            [Clutter.KEY_Home]: -Infinity,
        };
        const symbol = event.get_key_symbol();
        if (symbol in steps) {
            // (Not while held: the pointer has it.)
            if (!this._held) {
                const from = this._target();
                const to = stepped(from, steps[symbol]);
                if (bumps(Math.round(to * 100), Math.round(from * 100)))
                    this._bump();
                this.setLevel(to);
            }
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Menu) {
            this.openMenu();
            return Clutter.EVENT_STOP;
        }
        if ((symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter || symbol === Clutter.KEY_space) &&
            this.item.iconReactive) {
            this.item.emit('icon-clicked');
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});
