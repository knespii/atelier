// A notification in the island: the app, title and text, and the buttons
// the app's rule asks for (its own, none, or Reply and Mute).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {formatTimeSpan} from 'resource:///org/gnome/shell/misc/dateUtils.js';
import {fixMarkup} from 'resource:///org/gnome/shell/misc/util.js';

import {MUTE_DURATIONS} from '../../lib/notifications.js';
import {IslandPage} from '../island/page.js';

const MAX_BUTTONS = 3;
const MAX_BODY = 180; // characters; long texts end with an ellipsis

/**
 * @param {string} text
 * @param {boolean} markup - whether the text may contain Pango markup
 * @returns {string} the text without markup, on one paragraph
 */
function plainText(text, markup) {
    if (!text)
        return '';
    let plain = text;
    if (markup) {
        try {
            [, , plain] = Pango.parse_markup(fixMarkup(text, true), -1, '');
        } catch {
            plain = text.replace(/<[^>]*>/g, '');
        }
    }
    plain = plain.replace(/\s+/g, ' ').trim();
    return plain.length > MAX_BODY ? `${plain.slice(0, MAX_BODY - 1).trimEnd()}…` : plain;
}

export const NotificationPage = GObject.registerClass({
    Signals: {
        'activate': {},
        'dismiss': {},
        'action': {param_types: [GObject.TYPE_INT]},
        'mute': {param_types: [GObject.TYPE_INT]},
    },
}, class AtelierNotificationPage extends IslandPage {
    /**
     * @param {MessageTray.Notification} notification
     * @param {string} mode - which buttons: 'app', 'none' or 'reply-mute'
     */
    _init(notification, mode) {
        super._init({
            style_class: 'atelier-notification',
            orientation: Clutter.Orientation.VERTICAL,
            track_hover: true,
            reactive: true,
        });
        this.notification = notification;
        this._mode = mode;

        this._content = new St.Button({
            style_class: 'atelier-notification-content',
            can_focus: true,
            x_expand: true,
            child: new St.BoxLayout({style_class: 'atelier-notification-row', x_expand: true}),
        });
        this._content.connect('clicked', () => this.emit('activate'));
        this.add_child(this._content);
        const row = this._content.child;

        this._icon = new St.Icon({style_class: 'atelier-notification-icon', y_align: Clutter.ActorAlign.START});
        row.add_child(this._icon);

        const text = new St.BoxLayout({
            style_class: 'atelier-notification-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        row.add_child(text);

        this._app = new St.Label({style_class: 'atelier-notification-app'});
        this._app.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._app);
        this._title = new St.Label({style_class: 'atelier-notification-title'});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._title);
        this._body = new St.Label({style_class: 'atelier-notification-body'});
        this._body.clutter_text.line_wrap = true;
        this._body.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._body.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        text.add_child(this._body);

        this._dismiss = new St.Button({
            style_class: 'atelier-notification-close',
            accessible_name: 'Dismiss',
            can_focus: true,
            y_align: Clutter.ActorAlign.START,
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
        });
        this._dismiss.connect('clicked', () => this.emit('dismiss'));
        row.add_child(this._dismiss);

        this._buttons = new St.BoxLayout({style_class: 'atelier-notification-buttons', x_expand: true});
        this.add_child(this._buttons);

        notification.connectObject(
            'notify::title', () => this._sync(),
            'notify::body', () => this._sync(),
            'notify::gicon', () => this._sync(),
            'action-added', () => this._syncButtons(),
            'action-removed', () => this._syncButtons(),
            this);
        this._sync();
        this._syncButtons();
    }

    _sync() {
        const notification = this.notification;
        const source = notification.source;
        this._icon.gicon = notification.gicon ?? source?.icon ?? null;
        if (!this._icon.gicon)
            this._icon.icon_name = 'preferences-system-notifications-symbolic';
        const app = source?.title ?? '';
        const when = formatTimeSpan(notification.datetime ?? GLib.DateTime.new_now_local());
        this._app.text = app ? `${app}  ·  ${when}` : when;
        this._title.text = (notification.title ?? '').replace(/\s+/g, ' ').trim();
        this._body.text = plainText(notification.body, notification.useBodyMarkup);
        this._title.visible = this._title.text !== '';
        this._body.visible = this._body.text !== '';
        this.resized();
    }

    _syncButtons() {
        this._buttons.destroy_all_children();
        if (this._choosingMute) {
            MUTE_DURATIONS.forEach(([seconds, label]) =>
                this._addButton(label, () => this.emit('mute', seconds)));
            this._addButton('Cancel', () => {
                this._choosingMute = false;
                this._syncButtons();
            }, 'atelier-notification-button-quiet');
        } else if (this._mode === 'reply-mute') {
            this._addButton('Reply', () => this.emit('activate'));
            this._addButton('Mute', () => {
                this._choosingMute = true;
                this._syncButtons();
            });
        } else if (this._mode === 'app') {
            this.notification.actions.slice(0, MAX_BUTTONS).forEach((action, index) =>
                this._addButton(action.label, () => this.emit('action', index)));
        }
        this._buttons.visible = this._buttons.get_n_children() > 0;
        this.resized();
    }

    _addButton(label, callback, extraClass = null) {
        const button = new St.Button({
            style_class: 'atelier-notification-button',
            label,
            can_focus: true,
            x_expand: true,
        });
        if (extraClass)
            button.add_style_class_name(extraClass);
        button.connect('clicked', callback);
        this._buttons.add_child(button);
        return button;
    }

    /** @returns {string[]} labels of the buttons shown */
    get buttonLabels() {
        return this._buttons.get_children().map(button => button.label);
    }

    focus() {
        this._content.grab_key_focus();
    }
});
