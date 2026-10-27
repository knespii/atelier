// The lock screen's own password popup: when GNOME asks for the password
// (or another answer), a popup like the one notes are edited in spreads out
// of a drop in the middle of the screen, with the user's picture and name
// over the field (Enter sends what is typed, Escape goes back to the clock)
// and what GNOME says (a wrong password, a face being looked for), and
// draws back into it when done. It is of the same glass as the island over
// it (popupGlass.js), or black with the glass off.
// What is typed goes to GNOME's own prompt, which stays hidden and does the
// asking: it is handed over as GNOME's Enter hands it over
// (AuthPrompt._activateNext), so an answer typed early (while a face is
// looked for) and the counting of tries stay GNOME's. Without what it needs
// of GNOME's prompt, or when GNOME asks for something else (a list to
// choose from), GNOME's prompt shows.

import AccountsService from 'gi://AccountsService';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';

import {edgeReach} from '../../lib/glassLook.js';
import {boxOf, clamp01, gather, gatherBounds, spread} from '../../lib/liquid.js';
import {MessageKind} from '../../lib/lockState.js';
import {LiquidPaint} from '../core/liquid.js';
import {PopupGlass} from './popupGlass.js';

// How far round its shapes the popup's glass draws (its contour and shadow), pixels.
const edgeReachOf = () => edgeReach(true) * St.ThemeContext.get_for_stage(global.stage).scale_factor;

const SPREAD_TIME = 560;
const GATHER_TIME = 380;
const EXPECTED_SIZE = [320, 230]; // the popup's, before it has been shown: logical pixels

// Keys that would copy, cut or paste.
const CLIPBOARD_KEYS = [Clutter.KEY_c, Clutter.KEY_C, Clutter.KEY_x, Clutter.KEY_X, Clutter.KEY_v, Clutter.KEY_V,
    Clutter.KEY_Insert];

/**
 * @param {object} prompt - GNOME's AuthPrompt
 * @returns {St.Entry[]} its password and text entries, if it has them as GNOME 48 does
 */
function entriesOf(prompt) {
    return [prompt?._passwordEntry, prompt?._textEntry].filter(entry => entry instanceof St.Entry);
}

/**
 * @param {object} prompt - GNOME's AuthPrompt
 * @returns {boolean} whether the popup can stand in for its entry
 */
function usable(prompt) {
    return typeof prompt?._activateNext === 'function' && typeof prompt.cancel === 'function' &&
        prompt._entry instanceof St.Entry && entriesOf(prompt).length === 2;
}

/**
 * @param {AccountsService.User|null} user
 * @returns {string} who is asked for the password
 */
function nameOf(user) {
    const name = user?.is_loaded ? user.get_real_name() : GLib.get_real_name();
    return name && name !== 'Unknown' ? name : GLib.get_user_name();
}

// The user's picture, as GNOME's own prompt shows it (AccountsService's),
// round; GNOME's generic one without.
const Avatar = GObject.registerClass(
class AtelierLockAvatar extends St.Bin {
    _init(user) {
        super._init({style_class: 'atelier-lock-avatar', x_align: Clutter.ActorAlign.CENTER});
        this._user = user;
        this._picture = null;
        user?.connectObject(
            'notify::is-loaded', () => this._sync(),
            'changed', () => this._sync(),
            this);
        this._sync();
    }

    /** @returns {string|null} the picture's file, if there is one */
    get picture() {
        return this._picture;
    }

    _sync() {
        const file = this._user?.is_loaded ? this._user.get_icon_file() : null;
        this._picture = file && GLib.file_test(file, GLib.FileTest.EXISTS) ? file : null;
        if (this._picture) {
            this.child = null;
            this.style = `background-image: url("${this._picture}");`;
        } else {
            this.style = null;
            this.child ??= new St.Icon({style_class: 'atelier-lock-avatar-icon', icon_name: 'avatar-default-symbolic'});
        }
    }
});

export const PasswordForm = GObject.registerClass({
    Signals: {'submit': {}, 'cancel': {}},
}, class AtelierPasswordForm extends St.BoxLayout {
    _init() {
        super._init({style_class: 'atelier-lock-sheet', orientation: Clutter.Orientation.VERTICAL, reactive: true});
        const user = AccountsService.UserManager.get_default()?.get_user(GLib.get_user_name()) ?? null;
        this.avatar = new Avatar(user);
        this.add_child(this.avatar);
        const title = new St.Label({style_class: 'atelier-lock-sheet-title', text: nameOf(user),
            x_align: Clutter.ActorAlign.CENTER});
        user?.connectObject('changed', () => (title.text = nameOf(user)), title);
        this.add_child(title);
        this.entry = new St.PasswordEntry({style_class: 'atelier-lock-entry', can_focus: true, x_expand: true});
        this.add_child(this.entry);
        this._message = new St.Label({style_class: 'atelier-lock-message', visible: false,
            x_align: Clutter.ActorAlign.CENTER});
        this._message.clutter_text.line_wrap = true;
        this.add_child(this._message);
        const capsLock = new ShellEntry.CapsLockWarning({x_align: Clutter.ActorAlign.CENTER});
        capsLock.add_style_class_name('atelier-lock-message');
        this.add_child(capsLock);

        // Enter sends the answer, Escape goes back to the clock.
        this.entry.clutter_text.connect('activate', () => this.emit('submit'));
        this.entry.clutter_text.connect('key-press-event', (_text, event) => this._onEntryKey(event));
    }

    /** @returns {string} what the message says, if anything */
    get message() {
        return this._message.visible ? this._message.text : '';
    }

    _onEntryKey(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.emit('cancel');
            return Clutter.EVENT_STOP;
        }
        // Nothing copied out of it or pasted in.
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        if ((ctrl && CLIPBOARD_KEYS.includes(symbol)) || (shift && symbol === Clutter.KEY_Insert))
            return Clutter.EVENT_STOP;
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * @param {string} question - GNOME's ("Password:")
     * @param {boolean} secret - typed in dots
     */
    setQuestion(question, secret) {
        this.entry.hint_text = secret ? 'Password' : (question ?? '').replace(/:\s*$/, '');
        this.entry.show_peek_icon = secret;
        this.entry.password_visible = !secret;
    }

    /** @param {boolean} sensitive - takes typing (not while an answer is checked) */
    setSensitive(sensitive) {
        this.entry.reactive = sensitive;
        this.entry.clutter_text.editable = sensitive;
    }

    /** @param {object|null} message - {text, kind} from lib/lockState.js */
    setMessage(message) {
        this._message.visible = Boolean(message?.text);
        this._message.text = message?.text ?? '';
        if (message?.kind === MessageKind.ERROR)
            this._message.add_style_class_name('atelier-lock-message-error');
        else
            this._message.remove_style_class_name('atelier-lock-message-error');
    }

    focus() {
        this.entry.grab_key_focus();
    }
});

// A form in the middle of the main monitor, over GNOME's lock screen (right
// under the island): it spreads out of a drop there and draws back into it.
// (A layer over the monitor keeps it in the middle as it grows, with a
// message; it takes no clicks itself.) Of glass, the glass stays under the
// form while it is open, and takes its size as it grows; black, the liquid
// dries once it has spread, and the form's own background is the popup.
class MeltPopup {
    /**
     * @param {St.Widget} form
     * @param {Clutter.Actor} island
     * @param {object|null} [glass] - {source, look, light} of its glass
     *   (popupGlass.js); null: black
     */
    constructor(form, island, glass = null) {
        this.form = form;
        this.closing = false;
        this._glass = glass;
        this._paint = null;
        this._timeline = null;
        this._open = false;
        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout()});
        form.set({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        if (glass)
            form.add_style_class_name('atelier-lock-sheet-glass');
        this.actor.add_child(form);
        island.get_parent().insert_child_below(this.actor, island);
        Main.layoutManager.connectObject('monitors-changed', () => this._fit(), this.actor);
        // (Grown with a message, say: its glass with it, once laid out.)
        this._laterId = 0;
        if (glass)
            form.connectObject('notify::allocation', () => this._queueFit(), this.actor);
        // However it goes: also with all of GNOME's UI when the shell quits.
        this.actor.connect('destroy', () => {
            this._timeline?.stop();
            this._timeline = null;
            if (this._laterId)
                global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
            this.actor = this.form = this._paint = null;
        });
        this._fit();
    }

    /** @returns {PopupGlass|LiquidPaint|null} what the popup is drawn in while it moves (and, of glass, rests) */
    get liquid() {
        return this._paint;
    }

    _fit() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor)
            this.actor.set({x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height});
        this._queueFit();
    }

    _queueFit() {
        if (this._laterId || !this._glass)
            return;
        this._laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._fitGlass();
            return GLib.SOURCE_REMOVE;
        });
    }

    // The liquid that the form is while it moves, right under it, in its
    // look; and where the form is (or will be, once laid out), in the
    // liquid. The liquid covers only as far as it flows, its shadow round
    // it – not all of the monitor: what it is drawn in is made as it first
    // shows, and over all of a large monitor that takes a frame of its own,
    // as the popup opens and as it closes.
    _melt() {
        const [, width] = this.form.get_preferred_width(-1);
        const [, height] = this.form.get_preferred_height(width);
        const rect = [Math.round((this.actor.width - width) / 2), Math.round((this.actor.height - height) / 2),
            width, height];
        const node = this.form.get_theme_node();
        const radius = node.get_border_radius(St.Corner.TOPLEFT);
        // (Of glass: the one it is drawn in already, as it closes.)
        if (this._paint instanceof PopupGlass) {
            const [left, top] = this._glassAt;
            return [[rect[0] - left, rect[1] - top, width, height], {radius}];
        }
        const shadow = node.get_box_shadow();
        const reach = this._glass ? Math.ceil(edgeReachOf()) + 1
            : 1 + (shadow ? shadow.blur + Math.max(Math.abs(shadow.xoffset), Math.abs(shadow.yoffset)) : 0);
        const [left, top, right, bottom] = this._boundsOf(rect, reach);
        let paint;
        if (this._glass) {
            paint = new PopupGlass(this._glass);
            this._glassAt = [left, top];
            this._placeGlass(paint, [left, top, right - left, bottom - top]);
        } else {
            // (Placed, it is laid out where it is put, as big as it is made.)
            paint = new LiquidPaint({x: left, y: top, width: right - left, height: bottom - top});
        }
        paint.connect('destroy', () => {
            if (this._paint === paint)
                this._paint = null;
        });
        this._paint = paint;
        this.actor.insert_child_below(paint, this.form);
        if (!this._glass)
            paint.setLook(this.form);
        return [[rect[0] - left, rect[1] - top, width, height], {radius}];
    }

    // As far as the liquid flows round a rect, on the monitor, its reach
    // round it too: [left, top, right, bottom].
    _boundsOf(rect, reach) {
        const [x, y, w, h] = gatherBounds(rect, reach);
        return [Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)),
            Math.min(this.actor.width, Math.ceil(x + w)), Math.min(this.actor.height, Math.ceil(y + h))];
    }

    _placeGlass(glass, [left, top, width, height]) {
        const [px, py] = [this.actor.x, this.actor.y];
        glass.place([px + left, py + top], [px, py], [width, height]);
    }

    // Open, of glass: the glass under the form as it is now (grown with a
    // message), the form's own box.
    _fitGlass() {
        const glass = this._paint;
        if (!this._open || this.closing || !(glass instanceof PopupGlass) || !this.form?.has_allocation())
            return;
        const box = this.form.get_allocation_box();
        const rect = [box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1];
        const [left, top, right, bottom] = this._boundsOf(rect, Math.ceil(edgeReachOf()) + 1);
        // (Placed anew only where it changed: a texture of another size is
        // made anew, a frame of its own on a large monitor.)
        const [px, py] = [this.actor.x, this.actor.y];
        if (left !== this._glassAt[0] || top !== this._glassAt[1] || right - left !== glass.width ||
            bottom - top !== glass.height || glass.placedAt?.[0] !== px || glass.placedAt?.[1] !== py) {
            this._glassAt = [left, top];
            this._placeGlass(glass, [left, top, right - left, bottom - top]);
        }
        const radius = this.form.get_theme_node().get_border_radius(St.Corner.TOPLEFT);
        glass.setShapes({boxes: [boxOf([rect[0] - left, rect[1] - top, rect[2], rect[3]], radius)], capsules: []});
    }

    // Over a duration: step(t) every frame, then done (at once without
    // animations).
    _play(time, step, done) {
        const duration = adjustAnimationTime(time);
        if (duration <= 0) {
            step(1);
            done();
            return;
        }
        const timeline = new Clutter.Timeline({actor: this.actor, duration});
        timeline.connect('new-frame', () => step(timeline.get_progress()));
        timeline.connect('completed', () => {
            this._timeline = null;
            step(1);
            done();
        });
        this._timeline = timeline;
        step(0);
        timeline.start();
    }

    // Spreading out of a drop; what is on it shows once it is there. (Of
    // glass, the glass stays under it.)
    open() {
        const [rect, look] = this._melt();
        this.form.opacity = 0;
        this._play(SPREAD_TIME, t => {
            this._paint?.setShapes(spread(rect, clamp01(t / 0.8), look));
            this.form.opacity = Math.round(255 * clamp01((t - 0.7) / 0.3));
        }, () => {
            this._open = true;
            if (this._glass)
                this._fitGlass();
            else
                this._dry();
        });
    }

    // Drawing back into the drop, and gone.
    close() {
        if (this.closing || !this.actor)
            return;
        this.closing = true;
        this._open = false;
        this._timeline?.stop();
        this._timeline = null;
        if (!this._glass)
            this._dry();
        const [rect, look] = this._melt();
        this.form.hide();
        this._play(GATHER_TIME, t => this._paint?.setShapes(gather(rect, clamp01(t / 0.8), look)),
            () => this.destroy());
    }

    _dry() {
        this._paint?.destroy();
    }

    destroy() {
        this.actor?.destroy();
    }
}

export class PasswordField {
    /**
     * @param {LockIsland} island - the popup goes right under it
     * @param {object} [options]
     * @param {Function} [options.glass] - () => {source, look, light} of
     *   the popup's glass as it opens (popupGlass.js), null: black
     */
    constructor(island, {glass = () => null} = {}) {
        this._island = island;
        this._glassOf = glass;
        this._prompt = null;
        this._popup = null;
        this._submitting = false;
        this._broken = false;
        this._watched = [];
        this._message = null;
        this._dismissed = null;
        this._size = null;
    }

    /** @returns {PasswordForm|null} the popup's form, while it is open */
    get form() {
        return this._popup && !this._popup.closing ? this._popup.form : null;
    }

    /** @returns {boolean} whether it stands in for GNOME's prompt (which is hidden) */
    get standing() {
        return this._prompt !== null;
    }

    /**
     * @returns {number[]} where the popup is on the main monitor (or was
     *   last, or will be about), [x, y, width, height] from its corner
     */
    get rect() {
        const form = this._popup?.form;
        if (form) {
            const [, width] = form.get_preferred_width(-1);
            const [, height] = form.get_preferred_height(width);
            this._size = [width, height];
        }
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const [width, height] = this._size ?? [EXPECTED_SIZE[0] * scale, EXPECTED_SIZE[1] * scale];
        const monitor = Main.layoutManager.primaryMonitor;
        return [Math.round((monitor.width - width) / 2), Math.round((monitor.height - height) / 2), width, height];
    }

    /**
     * What GNOME's unlock dialog says (see lib/lockState.js reduce()).
     *
     * @param {object} event - with GNOME's AuthPrompt, for a new one
     * @param {object} state - lockState's after it
     */
    follow(event, state) {
        try {
            switch (event.type) {
            case 'prompt':
                this._attach(event.prompt);
                break;
            case 'question':
                this._ask(event.question, event.secret);
                break;
            case 'choices':
                // (Something to choose from: GNOME's prompt has it.)
                this._detach();
                break;
            case 'complete':
                // (Unlocked: gone at once, not caught half way as GNOME
                // stops the shell a moment.)
                this._popup?.destroy();
                break;
            case 'cancelled':
                this._close();
                break;
            case 'gone':
                this._detach({restore: false});
                break;
            }
            this._message = state.message;
            this._showMessage();
        } catch (e) {
            console.error('Atelier: the lock screen\'s password popup failed', e);
            this._broken = true;
            this._detach();
        }
    }

    // GNOME's new prompt: hidden (and out of the pointer's way) while the
    // popup asks instead.
    _attach(prompt) {
        this._detach();
        if (this._broken || !usable(prompt))
            return;
        this._prompt = prompt;
        prompt.opacity = 0;
        Shell.util_set_hidden_from_pick(prompt, true);
        // (Kept: GNOME destroys an entry of its own before the prompt goes.)
        this._watched = [];
        for (const entry of entriesOf(prompt)) {
            entry.connectObject('notify::reactive', () => this._syncSensitive(), this);
            entry.clutter_text.connectObject('text-changed', () => this._takeTyped(entry), this);
            this._watched.push(entry, entry.clutter_text);
        }
        global.stage.connectObject('notify::key-focus', () => this._takeFocus(), this);
    }

    /**
     * Put GNOME's prompt back, as it was.
     *
     * @param {object} [options]
     * @param {boolean} [options.restore] - false when the prompt is going anyway
     */
    _detach({restore = true} = {}) {
        this._close();
        const prompt = this._prompt;
        this._prompt = null;
        global.stage.disconnectObject(this);
        if (!prompt)
            return;
        this._watched.forEach(watched => watched.disconnectObject(this));
        this._watched = [];
        if (restore) {
            Shell.util_set_hidden_from_pick(prompt, false);
            prompt.opacity = 255;
        }
    }

    _ask(question, secret) {
        if (!this._prompt)
            return;
        if (!this.form) {
            if (!this._island.actor) {
                this._detach();
                return;
            }
            this._popup?.destroy();
            const form = new PasswordForm();
            form.connectObject(
                'submit', () => this._submit(),
                'cancel', () => this._prompt?.cancel(),
                this);
            form.entry.clutter_text.connectObject('text-changed', () => this._onTyped(form), this);
            this._popup = new MeltPopup(form, this._island.actor, this._glassOf());
            this._popup.open();
        }
        this.form.setQuestion(question, secret);
        this._syncSensitive();
        // (What went into GNOME's entry before: the key that woke the lock screen.)
        this._takeTyped(this._prompt._entry);
        this.form.focus();
    }

    _close() {
        this._popup?.close();
    }

    /** @returns {PopupGlass|LiquidPaint|null} what the popup is drawn in, while it moves (and, of glass, rests) */
    get liquid() {
        return this._popup?.liquid ?? null;
    }

    // What GNOME says, unless typing has put it away.
    _showMessage() {
        this.form?.setMessage(this._message === this._dismissed ? null : this._message);
    }

    // Typing again puts away what GNOME said, as in GNOME's own prompt.
    _onTyped(form) {
        if (!form.entry.text || !this._message)
            return;
        this._dismissed = this._message;
        this._showMessage();
    }

    // Handed over as GNOME's own Enter does it.
    _submit() {
        const prompt = this._prompt;
        const form = this.form;
        if (!prompt || !form || !prompt._entry.reactive)
            return;
        this._submitting = true;
        try {
            prompt._entry.text = form.entry.text;
            form.entry.text = '';
            prompt._activateNext(true);
        } finally {
            this._submitting = false;
        }
    }

    _syncSensitive() {
        const form = this.form;
        const sensitive = Boolean(this._prompt?._entry.reactive);
        form?.setSensitive(sensitive);
        if (sensitive)
            form?.focus();
    }

    // Typed into GNOME's entry (it takes the key that wakes the lock
    // screen): into the popup.
    _takeTyped(entry) {
        const form = this.form;
        if (this._submitting || !form || !entry?.text)
            return;
        const typed = entry.text;
        entry.text = '';
        form.entry.text += typed;
        form.entry.clutter_text.set_cursor_position(-1);
    }

    _takeFocus() {
        const focus = global.stage.key_focus;
        if (this.form && focus && this._prompt?.contains(focus))
            this.form.focus();
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.restore] - put GNOME's prompt back; not when
     *   unlocked, when the popup draws back into its drop on its own
     */
    destroy({restore = true} = {}) {
        this._detach({restore});
        if (restore)
            this._popup?.destroy();
        this._popup = null;
    }
}
