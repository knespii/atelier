// Slack: how many messages came since it was last looked at, and who wrote
// them – as a card, the latest three, each with how long ago. Only who (or
// which channel), never what the message says. A click brings Slack up.

import Clutter from 'gi://Clutter';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {ago} from '../../../lib/slack.js';
import {DesktopWidget, label} from '../widget.js';

export const SlackWidget = GObject.registerClass(
class AtelierSlackWidget extends DesktopWidget {
    build(box, size) {
        const slack = this._context.sources.slack;
        if (!this._listening) {
            this._listening = true;
            slack.connectObject('changed', () => this._sync(), this);
            // (How long ago, minute by minute.)
            this._clock = new GnomeDesktop.WallClock({time_only: true});
            this._clock.connectObject('notify::clock', () => this._sync(), this);
        }
        const row = new St.BoxLayout({style_class: 'atelier-widget-slack-row', x_expand: true, y_expand: true});
        box.add_child(row);
        const summary = new St.BoxLayout({
            style_class: 'atelier-widget-slack-summary',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: size === 'square',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({style_class: 'atelier-widget-slack-icon', x_align: Clutter.ActorAlign.START});
        summary.add_child(this._icon);
        this._count = label('atelier-widget-slack-count');
        summary.add_child(this._count);
        this._caption = label('atelier-widget-big-caption');
        summary.add_child(this._caption);
        // The latest one who wrote, on a square; the latest three on a card.
        this._latest = label('atelier-widget-caption');
        this._latest.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._list = null;
        if (size === 'card') {
            this._list = new St.BoxLayout({
                style_class: 'atelier-widget-slack-senders',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(summary);
            row.add_child(this._list);
        } else {
            summary.add_child(this._latest);
            row.add_child(summary);
        }
        this._sync();
    }

    _sync() {
        if (!this._count)
            return;
        const slack = this._context.sources.slack;
        const app = slack.app;
        // (Its own icon; setting a name would drop it again.)
        if (app)
            this._icon.gicon = app.get_icon();
        else
            this._icon.icon_name = 'chat-message-new-symbolic';
        const now = Date.now();
        if (slack.unread === 0) {
            this._count.text = '0';
            this._caption.text = 'All caught up';
        } else {
            this._count.text = String(slack.unread);
            this._caption.text = slack.unread === 1 ? 'new message' : 'new messages';
        }
        const [first] = slack.senders;
        this._latest.text = first ? `${first.name} · ${ago(first.time, now)}` : 'on Slack';
        if (!this._list)
            return;
        this._list.destroy_all_children();
        if (slack.senders.length === 0) {
            this._list.add_child(label('atelier-widget-placeholder', 'Nothing new on Slack since you last looked'));
            this._list.get_last_child().clutter_text.line_wrap = true;
            return;
        }
        for (const sender of slack.senders) {
            const line = new St.BoxLayout({style_class: 'atelier-widget-agenda-row'});
            const name = label('atelier-widget-agenda-text', sender.name, {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            line.add_child(name);
            if (sender.count > 1)
                line.add_child(label('atelier-widget-slack-times', `×${sender.count}`, {y_align: Clutter.ActorAlign.CENTER}));
            line.add_child(label('atelier-widget-agenda-time', ago(sender.time, now), {y_align: Clutter.ActorAlign.CENTER}));
            this._list.add_child(line);
        }
    }

    activate() {
        this._context.sources.slack.open();
    }

    cleanup() {
        this._context.sources.slack?.disconnectObject(this);
        this._clock?.disconnectObject(this);
        this._clock?.run_dispose();
        this._clock = null;
        this._count = null;
    }
});
