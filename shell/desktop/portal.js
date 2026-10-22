// The system's file chooser, from the shell: the desktop portal's
// FileChooser opens it (as it would for any app) and answers with the
// files chosen, in a Request's Response signal. Without the portal, there
// is none.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS_NAME = 'org.freedesktop.portal.Desktop';
const OBJECT_PATH = '/org/freedesktop/portal/desktop';
const FILE_CHOOSER = 'org.freedesktop.portal.FileChooser';
const REQUEST = 'org.freedesktop.portal.Request';
// How long the portal has to say it is there, ms (it may be started for it).
const ASK_TIMEOUT = 5000;
// The Response's codes: the files chosen; the dialog closed (anything else
// is something that went wrong).
const CHOSEN = 0;
const CANCELLED = 1;

const call = (iface, method, params, replyType, timeout = -1) => new Promise((resolve, reject) => {
    Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, iface, method, params, replyType, Gio.DBusCallFlags.NONE, timeout, null,
        (connection, result) => {
            try {
                resolve(connection.call_finish(result));
            } catch (e) {
                reject(e);
            }
        });
});

export class FileChooserPortal {
    /**
     * @returns {Promise<boolean>} whether there is a file chooser to open
     *   (asked once; the portal is started if it can be)
     */
    available() {
        this._available ??= call('org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [FILE_CHOOSER, 'version']), new GLib.VariantType('(v)'), ASK_TIMEOUT)
            .then(() => true, () => false);
        return this._available;
    }

    /**
     * Let the user choose pictures.
     *
     * @param {string} title - of the dialog
     * @returns {Promise<string[]>} their paths; none when the dialog was
     *   closed
     */
    async choosePictures(title) {
        const bus = Gio.DBus.session;
        // The Request the answer comes on is known before asking (so it
        // can't come before it is listened to): of this connection's name
        // and a token of its own.
        const token = `atelier_${GLib.uuid_string_random().replace(/-/g, '')}`;
        const sender = bus.get_unique_name().replace(/^:/, '').replace(/\./g, '_');
        const path = `${OBJECT_PATH}/request/${sender}/${token}`;
        let subscription = 0;
        const answer = new Promise((resolve, reject) => {
            subscription = bus.signal_subscribe(BUS_NAME, REQUEST, 'Response', path, null, Gio.DBusSignalFlags.NONE,
                (_connection, _sender, _path, _iface, _signal, params) => {
                    const [response, results] = params.deepUnpack();
                    if (response === CHOSEN)
                        resolve((results.uris?.deepUnpack() ?? []).map(uri => Gio.File.new_for_uri(uri).get_path()).filter(Boolean));
                    else if (response === CANCELLED)
                        resolve([]);
                    else
                        reject(new Error(`the file chooser failed (${response})`));
                });
        });
        try {
            const filters = [['Pictures', [[1, 'image/*']]]];
            const options = {
                'handle_token': new GLib.Variant('s', token),
                'multiple': new GLib.Variant('b', true),
                'modal': new GLib.Variant('b', true),
                'filters': new GLib.Variant('a(sa(us))', filters),
                'current_filter': new GLib.Variant('(sa(us))', filters[0]),
            };
            await call(FILE_CHOOSER, 'OpenFile', new GLib.Variant('(ssa{sv})', ['', title, options]),
                new GLib.VariantType('(o)'));
            return await answer;
        } finally {
            bus.signal_unsubscribe(subscription);
        }
    }
}
