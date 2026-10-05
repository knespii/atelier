// GitHub contributions: a square for each day of the last weeks, brighter
// the more there was, like on the user's GitHub profile – in the accent
// color. The name comes from Atelier's settings.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {lastWeeks, profileUrl} from '../../../lib/github.js';
import {DesktopWidget, label, openUri} from '../widget.js';

// How bright each level is, 0 (nothing) to 4.
const LEVEL_ALPHA = [0, 0.3, 0.5, 0.75, 1];

const Grid = GObject.registerClass(
class AtelierContributionGrid extends St.DrawingArea {
    _init() {
        super._init({style_class: 'atelier-widget-contributions', x_expand: true, y_expand: true});
        this._days = [];
    }

    /** @param {object[]} days - [{date, level}] */
    setDays(days) {
        this._days = days;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const [, empty] = node.lookup_color('-atelier-empty-color', false);
        const [, full] = node.lookup_color('-atelier-full-color', false);
        // Seven rows of squares as big as fit, with a gap of a sixth.
        const cell = height / (7 + 6 / 6);
        const gap = cell / 6;
        const count = Math.max(1, Math.floor((width + gap) / (cell + gap)));
        const weeks = lastWeeks(this._days, count);
        const left = width - weeks.length * (cell + gap) + gap;
        weeks.forEach((week, w) => {
            week.forEach((level, d) => {
                if (level === null)
                    return;
                const color = level > 0 ? full : empty;
                const alpha = level > 0 ? LEVEL_ALPHA[level] : 1;
                cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, alpha * color.alpha / 255);
                const x = left + w * (cell + gap);
                const y = d * (cell + gap);
                const r = cell / 4;
                cr.newSubPath();
                cr.arc(x + cell - r, y + r, r, -Math.PI / 2, 0);
                cr.arc(x + cell - r, y + cell - r, r, 0, Math.PI / 2);
                cr.arc(x + r, y + cell - r, r, Math.PI / 2, Math.PI);
                cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
                cr.closePath();
                cr.fill();
            });
        });
        cr.$dispose();
    }
});

export const GithubWidget = GObject.registerClass(
class AtelierGithubWidget extends DesktopWidget {
    build(box) {
        const source = this._context.sources.github;
        if (!this._listening) {
            this._listening = true;
            source.connectObject('changed', () => this._sync(), this);
        }
        const header = new St.BoxLayout({style_class: 'atelier-widget-header'});
        this._title = label('atelier-widget-title', '', {x_expand: true});
        this._total = label('atelier-widget-caption', '', {y_align: Clutter.ActorAlign.CENTER});
        header.add_child(this._title);
        header.add_child(this._total);
        box.add_child(header);
        this._grid = new Grid();
        box.add_child(this._grid);
        this._message = label('atelier-widget-placeholder', '', {y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._message.clutter_text.line_wrap = true;
        box.add_child(this._message);
        this._sync();
    }

    _sync() {
        if (!this._grid)
            return;
        const source = this._context.sources.github;
        const data = source.data;
        this._title.text = source.user || 'GitHub';
        this._total.text = data?.total !== null && data?.total !== undefined
            ? `${data.total.toLocaleString()} in the last year`
            : '';
        this._grid.visible = Boolean(data);
        this._grid.setDays(data?.days ?? []);
        this._message.visible = !data;
        if (!source.user)
            this._message.text = 'Your GitHub name goes into Atelier\'s settings, under Desktop.';
        else
            this._message.text = source.error ? `Can't reach GitHub: ${source.error}` : 'Reading GitHub…';
    }

    activate() {
        const user = this._context.sources.github.user;
        if (user)
            openUri(profileUrl(user));
        else
            this._context.openSettings('desktop');
    }

    cleanup() {
        this._context.sources.github.disconnectObject(this);
        this._grid = null;
    }
});
