// The Slack token, in the GNOME keyring (never in the settings, never in a
// log), and asking Slack's Web API with it – for the shell's Slack source
// and the preferences' Check. Only the keyring and Slack ever see the token.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const SCHEMA = new Secret.Schema('org.gnome.shell.extensions.atelier.Slack', Secret.SchemaFlags.NONE,
    {kind: Secret.SchemaAttributeType.STRING});
const ATTRIBUTES = {kind: 'user-token'};
const LABEL = 'Atelier: Slack token';
const API = 'https://slack.com/api/';

// A libsecret call, as a promise.
function secretCall(start, finish, ...args) {
    return new Promise((resolve, reject) => {
        start(...args, null, (_source, result) => {
            try {
                resolve(finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** The token in the user's keyring: lookup(), store(token), clear(). */
export const keyring = {
    /** @returns {Promise<string|null>} */
    lookup: () => secretCall(Secret.password_lookup, Secret.password_lookup_finish, SCHEMA, ATTRIBUTES),
    /** @param {string} token */
    store: token => secretCall(Secret.password_store, Secret.password_store_finish,
        SCHEMA, ATTRIBUTES, Secret.COLLECTION_DEFAULT, LABEL, token),
    clear: () => secretCall(Secret.password_clear, Secret.password_clear_finish, SCHEMA, ATTRIBUTES),
};

/** @returns {Soup.Session} for asking Slack */
export function newSession() {
    return new Soup.Session({timeout: 20, user_agent: 'Atelier (GNOME Shell extension)'});
}

/**
 * Ask Slack's Web API.
 *
 * @param {Soup.Session} session
 * @param {string} token
 * @param {string} method - e.g. "auth.test"
 * @param {object} params - its arguments
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<object>} {status (HTTP), retryAfter (seconds, or null),
 *   body (the answer, parsed, or null)}; a network failure throws
 */
export async function callSlack(session, token, method, params, cancellable) {
    const query = Object.entries(params ?? {})
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');
    const message = Soup.Message.new('GET', `${API}${method}${query ? `?${query}` : ''}`);
    message.get_request_headers().append('Authorization', `Bearer ${token}`);
    const bytes = await session.send_and_read_async(message, GLib.PRIORITY_LOW, cancellable);
    const retryAfter = Number.parseInt(message.get_response_headers().get_one('Retry-After') ?? '', 10);
    let body = null;
    try {
        body = JSON.parse(new TextDecoder().decode(bytes.get_data()));
    } catch {
        // (Not Slack's JSON: a proxy's page, say.)
    }
    return {status: message.get_status(), retryAfter: Number.isFinite(retryAfter) ? retryAfter : null, body};
}
