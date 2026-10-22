// The lock screen's own password popup: when GNOME asks for the password
// (or another answer), a popup like the one notes are edited in spreads out
// of a drop in the middle of the screen, with the user's picture and name
// over the field (Enter sends what is typed, Escape goes back to the clock)
// and what GNOME says (a wrong password, a face being looked for), and
// draws back into it when done.
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
import Shell from 'gi://Shell';
import St from 'gi://St';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';

import {clamp01, gather, spread} from '../../lib/liquid.js';
import {MessageKind} from '../../lib/lockState.js';
import {LiquidPaint} from '../core/liquid.js';

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
// message; it takes no clicks itself.)
class MeltPopup {
    /**
     * @param {St.Widget} form
     * @param {Clutter.Actor} island
     */
    constructor(form, island) {
        this.form = form;
        this.closing = false;
        this._paint = null;
        this._timeline = null;
        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout()});
        form.set({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(form);
        island.get_parent().insert_child_below(this.actor, island);
        Main.layoutManager.connectObject('monitors-changed', () => this._fit(), this.actor);
        // However it goes: also with all of GNOME's UI when the shell quits.
        this.actor.connect('destroy', () => {
            this._timeline?.stop();
            this._timeline = null;
            this.actor = this.form = this._paint = null;
        });
        this._fit();
    }

    _fit() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (monitor)
            this.actor.set({x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height});
    }

    // The liquid that the form is while it moves, right under it, in its
    // look; and where the form is (or will be, once laid out).
    _melt() {
        // (As big as the layer: it would be laid out as big as it asks to be.)
        const paint = new LiquidPaint({width: this.actor.width, height: this.actor.height});
        paint.connect('destroy', () => {
            if (this._paint === paint)
                this._paint = null;
        });
        this._paint = paint;
        this.actor.insert_child_below(paint, this.form);
        paint.setLook(this.form);
        const [, width] = this.form.get_preferred_width(-1);
        const [, height] = this.form.get_preferred_height(width);
        const rect = [Math.round((this.actor.width - width) / 2), Math.round((this.actor.height - height) / 2),
            width, height];
        return [rect, {radius: this.form.get_theme_node().get_border_radius(St.Corner.TOPLEFT)}];
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

    // Spreading out of a drop; what is on it shows once it is there.
    open() {
        const [rect, look] = this._melt();
        this.form.opacity = 0;
        this._play(SPREAD_TIME, t => {
            this._paint?.setShapes(spread(rect, clamp01(t / 0.8), look));
            this.form.opacity = Math.round(255 * clamp01((t - 0.7) / 0.3));
        }, () => this._dry());
    }

    // Drawing back into the drop, and gone.
    close() {
        if (this.closing || !this.actor)
            return;
        this.closing = true;
        this._timeline?.stop();
        this._timeline = null;
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
     */
    constructor(island) {
        this._island = island;
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
            this._popup = new MeltPopup(form, this._island.actor);
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
