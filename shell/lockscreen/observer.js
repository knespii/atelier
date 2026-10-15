// Follows GNOME's unlock dialog while it checks who is there, and tells
// what happens as events for lib/lockState.js. It only listens: GNOME asks
// and checks; the answers themselves are never read here.

import {authPromptOf, isAuthPrompt, promptBoxOf} from './gnome.js';

const FINGERPRINT_SERVICE = 'gdm-fingerprint';

export class AuthObserver {
    /**
     * @param {UnlockDialog} dialog
     * @param {Function} onEvent - (event) => void, with an event for lockState's reduce()
     */
    constructor(dialog, onEvent) {
        this._onEvent = onEvent;
        this._prompt = null;
        this._verifier = null;
        // GNOME makes a new prompt (and verifier) each time it comes up.
        promptBoxOf(dialog)?.connectObject('child-added', (_box, actor) => {
            if (isAuthPrompt(actor))
                this._attach(actor);
        }, this);
        this._dialog = dialog;
        const prompt = authPromptOf(dialog);
        if (prompt)
            this._attach(prompt);
    }

    /** @returns {object|null} GNOME's password prompt (AuthPrompt), while it is up */
    get prompt() {
        return this._prompt;
    }

    _attach(prompt) {
        if (prompt === this._prompt)
            return;
        this._detach();
        this._prompt = prompt;
        // (Kept: GNOME drops its own reference before the verifier goes.)
        this._verifier = prompt._userVerifier;
        const verifier = this._verifier;
        const tell = (make) => (...args) => {
            try {
                this._onEvent(make(...args));
            } catch (e) {
                console.error('Atelier: following the lock screen failed', e);
            }
        };
        prompt.connectObject(
            'next', tell(() => ({type: 'submit'})),
            'cancelled', tell(() => ({type: 'cancelled'})),
            'destroy', () => {
                this._detach();
                tell(() => ({type: 'gone'}))();
            },
            this);
        verifier.connectObject(
            'show-message', tell((_v, service, text, kind) => ({
                type: 'message', text, kind,
                fingerprint: verifier.serviceIsFingerprint?.(service) ?? service === FINGERPRINT_SERVICE,
            })),
            'ask-question', tell((_v, _service, _question, secret) => ({type: 'question', secret})),
            'verification-complete', tell(() => ({type: 'complete'})),
            'verification-failed', tell(() => ({type: 'failed'})),
            'reset', tell(() => ({type: 'reset'})),
            'show-choice-list', tell(() => ({type: 'choices'})),
            this);
        tell(() => ({type: 'prompt'}))();
    }

    _detach() {
        this._prompt?.disconnectObject(this);
        this._verifier?.disconnectObject(this);
        this._prompt = null;
        this._verifier = null;
    }

    destroy() {
        promptBoxOf(this._dialog)?.disconnectObject(this);
        this._detach();
        this._dialog = null;
    }
}
