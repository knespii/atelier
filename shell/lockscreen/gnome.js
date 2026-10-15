// Everything of GNOME's own lock screen that Atelier touches, in one place:
// these are GNOME's private parts (GNOME 48), so each is checked before it
// is used, and anything missing leaves GNOME's lock screen as it is.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {UnlockDialog} from 'resource:///org/gnome/shell/ui/unlockDialog.js';

/** @returns {UnlockDialog|null} the lock screen's dialog, while there is one */
export function dialogOf() {
    const dialog = Main.screenShield?._dialog;
    return dialog instanceof UnlockDialog ? dialog : null;
}

/**
 * @param {UnlockDialog} dialog
 * @returns {Clutter.Actor|null} what holds the password prompt when it is up
 */
export function promptBoxOf(dialog) {
    const box = dialog?._promptBox;
    return box instanceof Clutter.Actor ? box : null;
}

/**
 * @param {Clutter.Actor} actor - something in the prompt box, or the dialog's prompt
 * @returns {boolean} whether it is GNOME's password prompt, with its verifier
 */
export function isAuthPrompt(actor) {
    const verifier = actor?._userVerifier;
    return Boolean(verifier && typeof verifier.connect === 'function');
}

/**
 * @param {UnlockDialog} dialog
 * @returns {object|null} the password prompt (AuthPrompt), while it is up
 */
export function authPromptOf(dialog) {
    const prompt = dialog?._authPrompt;
    return isAuthPrompt(prompt) ? prompt : null;
}

/**
 * Bring up the password prompt, as a key press does.
 *
 * @param {UnlockDialog} dialog
 */
export function showPrompt(dialog) {
    if (typeof dialog?.activate === 'function')
        dialog.activate();
}
