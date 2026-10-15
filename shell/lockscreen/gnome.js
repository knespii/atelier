// Everything of GNOME's own lock screen that Atelier touches, in one place:
// these are GNOME's private parts (GNOME 48), so each is checked before it
// is used, and anything missing leaves GNOME's lock screen as it is.

import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

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
 * Put a layer right over the lock screen's blurred wallpaper, under its
 * clock and prompt; it slides away and goes with the lock screen.
 *
 * @param {UnlockDialog} dialog
 * @param {Clutter.Actor} layer
 * @returns {boolean} whether it is there
 */
export function placeOverBackground(dialog, layer) {
    const background = dialog?._backgroundGroup;
    if (!(background instanceof Clutter.Actor) || background.get_parent() !== dialog)
        return false;
    layer.get_parent()?.remove_child(layer);
    dialog.insert_child_above(layer, background);
    return true;
}

/**
 * @param {UnlockDialog} dialog
 * @returns {Shell.BlurEffect[]} what blurs the lock screen's wallpaper, one
 *   for each monitor; GNOME sets them anew when the monitors or the scale
 *   change
 */
export function wallpaperBlursOf(dialog) {
    const background = dialog?._backgroundGroup;
    if (!(background instanceof Clutter.Actor))
        return [];
    return background.get_children().map(widget => widget.get_effect('blur'))
        .filter(effect => effect instanceof Shell.BlurEffect);
}

/**
 * @param {UnlockDialog} dialog
 * @returns {St.Adjustment|null} from the clock (0) to the prompt (1)
 */
export function promptProgressOf(dialog) {
    const adjustment = dialog?._adjustment;
    return typeof adjustment?.value === 'number' ? adjustment : null;
}

/**
 * @param {UnlockDialog} dialog
 * @returns {Clutter.Actor[]} GNOME's time, date and the hint under them
 *   (how to unlock); GNOME animates the clock around them and the hint's
 *   opacity, never whether they show
 */
export function clockLabelsOf(dialog) {
    const clock = dialog?._clock;
    return [clock?._time, clock?._date, clock?._hint].filter(actor => actor instanceof Clutter.Actor);
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
