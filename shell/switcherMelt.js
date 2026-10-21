// A profile in the switcher, liquid while it is moved. Held (Tab down), it
// softens into a drop of itself where it is: rounder, a little smaller,
// with a wobble, and then it breathes. Moved, it pours over to its new
// place – its picture draws into a drop, which runs off in a stream of the
// picture's own colour and fills the place there with the picture again.
// Let go of, it firms up into its card.
//
// It is drawn over the switcher's strip, in the strip's own pixels (plus a
// margin all round): the liquid in the picture's colour, and over it the
// picture, twice – where the liquid leaves and where it arrives – each
// seen through the liquid.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {pourParts} from '../lib/liquid.js';
import {sampleWallpaper} from '../lib/thumbnails.js';
import {LiquidMaskEffect, LiquidPaint} from './core/liquid.js';

// Milliseconds a pour takes to the next place, and for each place further
// (at most).
const POUR_TIME = 540;
const POUR_FURTHER = 90;
const POUR_LONGEST = 840;
// Softened: how much smaller, and how far its corners go towards round.
const SOFT_SHRINK = 0.05;
const SOFT_ROUND = 0.5;
// Springs (stiffness, 1/s², and damping ratio): softening and firming up,
// a squash (wider, or narrower when below 0) and a nudge sideways.
const SOFT = {stiffness: 260, damping: 0.5};
const SQUASH = {stiffness: 320, damping: 0.32};
const NUDGE = {stiffness: 300, damping: 0.45};
// Kicks to the squash (1/s) as it softens, as it firms up and as it is
// pushed against either end; to the nudge (logical px/s) then.
const SOFTEN_KICK = 0.7;
const FIRM_KICK = 0.6;
const BUMP_SQUASH = -1.0;
const BUMP_NUDGE = 180;
// Breathing while it waits: how much, and how long a breath (seconds).
const BREATH = 0.012;
const BREATH_TIME = 1.8;
// Logical pixels: how near the liquid melts, how far in the picture fades
// into it mid-way.
const BLEND = 18;
const FADE = 14;
// Seconds the springs are worked out in at a time.
const STEP = 1 / 240;
// The liquid, until the picture's colour is known.
const FALLBACK = [0.15, 0.15, 0.17, 1];

const damping = ({stiffness, damping: ratio}) => 2 * ratio * Math.sqrt(stiffness);
const lerp = (a, b, t) => a + (b - a) * t;

// Each picture's colour, on average, once worked out.
const colours = new Map();

/**
 * @param {string|null} wallpaper
 * @returns {Promise<number[]>} [red, green, blue, alpha], 0–1
 */
function colourOf(wallpaper) {
    if (!wallpaper)
        return Promise.resolve(FALLBACK);
    if (!colours.has(wallpaper)) {
        colours.set(wallpaper, sampleWallpaper(wallpaper, 8, 5).then(({pixels, channels, rowstride, width}) => {
            const sum = [0, 0, 0];
            let count = 0;
            for (let row = 0; row * rowstride < pixels.length; row++) {
                for (let col = 0; col < width; col++) {
                    const i = row * rowstride + col * channels;
                    if (i + 2 >= pixels.length)
                        break;
                    sum[0] += pixels[i];
                    sum[1] += pixels[i + 1];
                    sum[2] += pixels[i + 2];
                    count++;
                }
            }
            return count ? [...sum.map(v => v / count / 255), 1] : FALLBACK;
        }).catch(() => FALLBACK));
    }
    return colours.get(wallpaper);
}

export const ProfileMelt = GObject.registerClass({
    Signals: {
        // Let go of, and a card again.
        'firm': {},
    },
}, class AtelierProfileMelt extends St.Widget {
    /**
     * @param {St.Widget} card - what turns liquid: its style has its picture
     * @param {number[]} place - [x, y, width, height] of the card, in the strip
     * @param {object} look
     * @param {number} look.radius - of the card's corners
     * @param {number} look.margin - room round the strip for the liquid
     * @param {number} look.scale - the scale factor
     */
    _init(card, place, {radius, margin, scale}) {
        super._init({reactive: false});
        Shell.util_set_hidden_from_pick(this, true);
        this._radius = radius;
        this._margin = margin;
        this._scale = scale;
        this._place = place;
        // A pour on its way {from, to, t, duration}, and where the next one goes.
        this._pour = null;
        this._next = null;
        this._held = true;
        this._soft = 0;
        this._softSpeed = 0;
        this._squash = 0;
        this._squashSpeed = SOFTEN_KICK;
        this._nudge = 0;
        this._nudgeSpeed = 0;
        this._breath = 0;
        this._timeline = null;

        this._liquid = new LiquidPaint();
        this._liquid.add_constraint(new Clutter.BindConstraint({source: this, coordinate: Clutter.BindCoordinate.SIZE}));
        this._liquid.setColors(FALLBACK);
        this.add_child(this._liquid);
        this._pictures = [0, 1].map(() => {
            const picture = new St.Widget({style_class: 'atelier-melt-picture', style: card.style, visible: false});
            picture.mask = new LiquidMaskEffect();
            picture.add_effect(picture.mask);
            this.add_child(picture);
            return picture;
        });
        // (Its thumbnail may come only now.)
        card.connectObject('notify::style', () => this._pictures.forEach(picture => (picture.style = card.style)), this);
        colourOf(card.item.wallpaper).then(colour => {
            if (!this._destroyed)
                this._liquid.setColors(colour);
        });

        this.connect('destroy', () => {
            this._destroyed = true;
            this._timeline?.stop();
            this._timeline = null;
        });
        this._show();
        this._run();
    }

    /** @param {boolean} held - softened, or firming up once it is where it goes */
    hold(held) {
        if (held === this._held)
            return;
        this._held = held;
        if (!held && !this._pour)
            this._squashSpeed += FIRM_KICK;
        this._run();
    }

    /**
     * Pour over to another place (once the pour on its way is done).
     *
     * @param {number[]} place - [x, y, width, height], in the strip
     */
    pourTo(place) {
        if (this._pour)
            this._next = place;
        else
            this._startPour(place);
        this._run();
    }

    /** @param {number} direction - pushed against the end that way */
    bump(direction) {
        this._squashSpeed += BUMP_SQUASH;
        this._nudgeSpeed += direction * BUMP_NUDGE * this._scale;
        this._run();
    }

    _startPour(place) {
        const slots = Math.max(1, Math.round(Math.abs(place[0] - this._place[0]) / place[2]));
        const duration = Math.min(POUR_LONGEST, POUR_TIME + POUR_FURTHER * (slots - 1));
        this._pour = {from: this._place, to: place, t: 0, duration};
    }

    // Frame by frame, slower as the shell's animations are slowed down.
    _run() {
        if (this._timeline)
            return;
        const pace = 1000 / Math.max(1, adjustAnimationTime(1000));
        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', timeline => {
            this._step(Math.min(timeline.get_delta(), 50) / 1000 * pace);
            this._show();
            if (this._settled()) {
                this._timeline.stop();
                this._timeline = null;
                this.emit('firm');
            }
        });
        this._timeline.start();
    }

    _step(seconds) {
        const pour = this._pour;
        if (pour) {
            pour.t += seconds * 1000 / pour.duration;
            if (pour.t >= 1) {
                this._place = pour.to;
                this._pour = null;
                if (this._next) {
                    this._startPour(this._next);
                    this._next = null;
                } else if (!this._held) {
                    this._squashSpeed += FIRM_KICK;
                }
            }
        }
        this._breath += seconds;
        // (Soft until it is where it goes.)
        const soft = this._held || this._pour ? 1 : 0;
        for (let left = seconds; left > 0; left -= STEP) {
            const dt = Math.min(STEP, left);
            this._softSpeed += (SOFT.stiffness * (soft - this._soft) - damping(SOFT) * this._softSpeed) * dt;
            this._soft += this._softSpeed * dt;
            this._squashSpeed += (-SQUASH.stiffness * this._squash - damping(SQUASH) * this._squashSpeed) * dt;
            this._squash += this._squashSpeed * dt;
            this._nudgeSpeed += (-NUDGE.stiffness * this._nudge - damping(NUDGE) * this._nudgeSpeed) * dt;
            this._nudge += this._nudgeSpeed * dt;
        }
    }

    _settled() {
        return !this._held && !this._pour && Math.abs(this._soft) < 0.002 && Math.abs(this._softSpeed) < 0.02 &&
            Math.abs(this._squash) < 0.002 && Math.abs(this._squashSpeed) < 0.02 &&
            Math.abs(this._nudge) < 0.3 && Math.abs(this._nudgeSpeed) < 3;
    }

    // A place in the strip as the card is there now (soft, squashed,
    // breathing), in this actor's pixels: [x, y, width, height], radius.
    _shape([x, y, width, height]) {
        const soft = this._soft;
        const breath = BREATH * Math.sin(2 * Math.PI * this._breath / BREATH_TIME) * Math.max(0, soft);
        const [w, h] = [
            width * (1 - SOFT_SHRINK * soft) * (1 + this._squash + breath),
            height * (1 - SOFT_SHRINK * soft) * (1 - this._squash - breath),
        ];
        const [cx, cy] = [x + width / 2 + this._nudge + this._margin, y + height / 2 + this._margin];
        const radius = lerp(this._radius, Math.min(w, h) / 2, SOFT_ROUND * Math.max(0, soft));
        return [[cx - w / 2, cy - h / 2, w, h], Math.max(0, Math.min(radius, w / 2, h / 2))];
    }

    _show() {
        const pour = this._pour;
        const [from, radius] = this._shape(pour ? pour.from : this._place);
        const look = {radius, blend: BLEND * this._scale};
        const parts = pourParts(from, pour ? this._shape(pour.to)[0] : from, pour ? pour.t : 0, look);
        const shapes = {
            boxes: [parts.source, parts.drop, parts.target].filter(Boolean),
            capsules: parts.stream ? [parts.stream] : [],
        };
        this._liquid.setShapes(shapes);
        // Mid-way, the pictures fade into the liquid towards their edges.
        const fade = pour ? FADE * this._scale * Math.sin(Math.PI * pour.t) : 0;
        [parts.source, parts.target].forEach((box, i) => {
            const picture = this._pictures[i];
            picture.visible = Boolean(box);
            if (!box)
                return;
            const [cx, cy, halfWidth, halfHeight, corner] = box;
            const [x, y] = [cx - halfWidth, cy - halfHeight];
            picture.set_position(x, y);
            picture.set_size(halfWidth * 2, halfHeight * 2);
            picture.mask.setShapes({
                boxes: shapes.boxes.map(([bx, by, ...rest]) => [bx - x, by - y, ...rest]),
                capsules: shapes.capsules.map(([ax, ay, bx, by, ...rest]) => [ax - x, ay - y, bx - x, by - y, ...rest]),
            });
            picture.mask.setEdge([halfWidth, halfHeight, halfWidth, halfHeight, corner], fade);
        });
    }
});
