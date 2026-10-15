// The lock screen's own password field: the island grows into it when
// GNOME asks for the password (or another answer), with a small padlock and
// what GNOME says (a wrong password, a face being looked for). What is typed
// goes to GNOME's own prompt, which stays hidden and does the asking: it is
// handed over as GNOME's Enter hands it over (AuthPrompt._activateNext), so
// an answer typed early (while a face is looked for) and the counting of
// tries stay GNOME's. Without what it needs of GNOME's prompt, or when GNOME
// asks for something else (a list to choose from), GNOME's prompt shows.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as ShellEntry from 'resource:///org/gnome/shell/ui/shellEntry.js';

import {MessageKind} from '../../lib/lockState.js';
import {IslandPage} from '../island/page.js';
import {Padlock} from './padlock.js';

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
 * @returns {boolean} whether the field can stand in for its entry
 */
function usable(prompt) {
    return typeof prompt?._activateNext === 'function' && typeof prompt.cancel === 'function' &&
        prompt._entry instanceof St.Entry && entriesOf(prompt).length === 2;
}

export const PasswordPage = GObject.registerClass({
    Signals: {'submit': {}, 'cancel': {}},
}, class AtelierPasswordPage extends IslandPage {
    _init() {
        super._init({style_class: 'atelier-lock-password', orientation: Clutter.Orientation.VERTICAL});
        const row = new St.BoxLayout({style_class: 'atelier-lock-password-row'});
        this.add_child(row);
        this.padlock = new Padlock();
        row.add_child(this.padlock);
        this.entry = new St.PasswordEntry({
            style_class: 'atelier-lock-entry',
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(this.entry);
        this._message = new St.Label({style_class: 'atelier-lock-message', visible: false,
            x_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._message);
        const capsLock = new ShellEntry.CapsLockWarning({x_align: Clutter.ActorAlign.CENTER});
        capsLock.add_style_class_name('atelier-lock-message');
        this.add_child(capsLock);

        this.entry.clutter_text.connect('activate', () => this.emit('submit'));
        this.entry.clutter_text.connect('key-press-event', (_text, event) => this._onKey(event));
    }

    /** @returns {string} what the message says, if anything */
    get message() {
        return this._message.visible ? this._message.text : '';
    }

    _onKey(event) {
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

export class PasswordField {
    /**
     * @param {LockIsland} island - it grows into the field
     */
    constructor(island) {
        this._island = island;
        this._prompt = null;
        this._page = null;
        this._submitting = false;
        this._broken = false;
        this._watched = [];
    }

    /** @returns {PasswordPage|null} the field, while the island shows it */
    get page() {
        return this._page;
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
            case 'cancelled':
                this._close();
                break;
            case 'gone':
                this._detach({restore: false});
                break;
            }
            this._page?.setMessage(state.message);
        } catch (e) {
            console.error('Atelier: the lock screen\'s password field failed', e);
            this._broken = true;
            this._detach();
        }
    }

    /** @param {object} look - from lib/lockState.js look() */
    setLook(look) {
        this._page?.padlock.setLook(look);
    }

    // GNOME's new prompt: hidden (and out of the pointer's way) while the
    // field asks instead.
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
        if (!this._page) {
            const page = new PasswordPage();
            page.connectObject(
                'submit', () => this._submit(),
                'cancel', () => this._prompt?.cancel(),
                'destroy', () => {
                    if (this._page === page)
                        this._page = null;
                },
                this);
            if (!this._island.open(page)) {
                page.destroy();
                this._detach();
                return;
            }
            this._page = page;
        }
        this._page.setQuestion(question, secret);
        this._syncSensitive();
        // (What went into GNOME's entry before: the key that woke the lock screen.)
        this._takeTyped(this._prompt._entry);
        this._page.focus();
    }

    _close() {
        const page = this._page;
        this._page = null;
        if (page)
            this._island.close(page);
    }

    // Handed over as GNOME's own Enter does it.
    _submit() {
        const prompt = this._prompt;
        const page = this._page;
        if (!prompt || !page || !prompt._entry.reactive)
            return;
        this._submitting = true;
        try {
            prompt._entry.text = page.entry.text;
            page.entry.text = '';
            prompt._activateNext(true);
        } finally {
            this._submitting = false;
        }
    }

    _syncSensitive() {
        const sensitive = Boolean(this._prompt?._entry.reactive);
        this._page?.setSensitive(sensitive);
        if (sensitive)
            this._page?.focus();
    }

    // Typed into GNOME's entry (it takes the key that wakes the lock
    // screen): into the field.
    _takeTyped(entry) {
        if (this._submitting || !this._page || !entry?.text)
            return;
        const typed = entry.text;
        entry.text = '';
        this._page.entry.text += typed;
        this._page.entry.clutter_text.set_cursor_position(-1);
    }

    _takeFocus() {
        const focus = global.stage.key_focus;
        if (this._page && focus && this._prompt?.contains(focus))
            this._page.focus();
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.restore] - put GNOME's prompt back (not when unlocked)
     */
    destroy({restore = true} = {}) {
        this._detach({restore});
    }
}
