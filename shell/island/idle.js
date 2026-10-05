// The island at rest: the time (and the date, if wanted), with a microphone
// icon while an app records and a dot for unseen notifications.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import St from 'gi://St';

export const IdleView = GObject.registerClass({
    Signals: {'changed': {}},
}, class AtelierIslandIdle extends St.BoxLayout {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings - the island's settings
     * @param {MicWatcher} params.mic
     * @param {UnseenWatcher} params.unseen
     */
    _init({settings, mic, unseen}) {
        super._init({style_class: 'atelier-island-idle'});
        this._settings = settings;
        this._mic = mic;
        this._unseen = unseen;

        this._micIcon = new St.Icon({
            style_class: 'atelier-island-mic',
            icon_name: 'audio-input-microphone-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.add_child(this._micIcon);

        this._time = new St.Label({style_class: 'atelier-island-time', y_align: Clutter.ActorAlign.CENTER});
        this.add_child(this._time);
        this._date = new St.Label({
            style_class: 'atelier-island-date',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.add_child(this._date);

        this._dot = new St.Widget({
            style_class: 'atelier-island-unread',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.add_child(this._dot);
        this._dnd = new St.Icon({
            style_class: 'atelier-island-dnd',
            icon_name: 'notifications-disabled-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.add_child(this._dnd);

        // time-only follows GNOME's 12/24-hour and seconds settings
        this._clock = new GnomeDesktop.WallClock({time_only: true});
        this._clock.connectObject('notify::clock', () => this._sync(), this);
        settings.connectObject('changed::show-date', () => this._sync(), this);
        mic.connectObject('changed', () => this._sync(), this);
        unseen.connectObject('changed', () => this._sync(), this);
        this.connect('destroy', () => {
            this._clock.disconnectObject(this);
            this._clock.run_dispose();
            this._settings.disconnectObject(this);
            this._mic.disconnectObject(this);
            this._unseen.disconnectObject(this);
        });
        this._sync();
    }

    /** @returns {string} the time as shown */
    get text() {
        return this._time.text;
    }

    /**
     * @param {boolean} compact - just the time, as in a compact bar
     */
    setCompact(compact) {
        if (compact === Boolean(this._compact))
            return;
        this._compact = compact;
        this._sync();
    }

    _sync() {
        this._time.text = this._clock.clock.trim();
        const showDate = !this._compact && this._settings.get_boolean('show-date');
        this._date.visible = showDate;
        if (showDate)
            this._date.text = GLib.DateTime.new_now_local().format('%a %b %-d');
        this._micIcon.visible = this._mic.active;
        this._dnd.visible = this._unseen.doNotDisturb;
        this._dot.visible = !this._unseen.doNotDisturb && this._unseen.unseen > 0;
        this.emit('changed');
    }
});
