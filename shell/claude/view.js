// Claude Code's usage, for the island: the current 5-hour block, today, the
// last seven days and the sessions running.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {formatTime} from 'resource:///org/gnome/shell/misc/dateUtils.js';

import {formatTokens} from '../../lib/claudeUsage.js';

const BAR_HEIGHT = 34; // logical pixels, the busiest day

const shortTime = time => formatTime(new Date(time), {timeOnly: true}).trim();

/**
 * @param {number} ms
 * @returns {string} e.g. "2 h 13 min"
 */
function duration(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    if (minutes < 60)
        return `${minutes} min`;
    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const plural = (count, word) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

function label(styleClass, text = '', params = {}) {
    return new St.Label({style_class: styleClass, text, ...params});
}

// The bar of the block's progress: its child fills a fraction of the width.
// (Laid out, not sized from the outside while the bar is being allocated.)
const ProgressLayout = GObject.registerClass(
class AtelierClaudeProgressLayout extends Clutter.BinLayout {
    _init() {
        super._init();
        this._fraction = 0;
    }

    /** @param {number} fraction - 0 to 1 */
    setFraction(fraction) {
        if (fraction === this._fraction)
            return;
        this._fraction = fraction;
        this.layout_changed();
    }

    vfunc_allocate(container, box) {
        const fill = box.copy();
        fill.x2 = fill.x1 + Math.round(box.get_width() * this._fraction);
        for (const child of container.get_children())
            child.allocate(fill);
    }
});

export const ClaudeView = GObject.registerClass(
class AtelierClaudeView extends St.BoxLayout {
    /**
     * @param {ClaudeUsage} usage
     */
    _init(usage) {
        super._init({style_class: 'atelier-claude', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._usage = usage;

        const header = new St.BoxLayout({style_class: 'atelier-claude-header'});
        this.add_child(header);
        header.add_child(label('atelier-claude-title', 'This block', {x_expand: true}));
        this._left = label('atelier-claude-left');
        header.add_child(this._left);

        this._span = label('atelier-claude-span');
        this.add_child(this._span);
        this._progressLayout = new ProgressLayout();
        this._progress = new St.Widget({
            style_class: 'atelier-claude-progress',
            layout_manager: this._progressLayout,
            x_expand: true,
        });
        this._progressFill = new St.Widget({style_class: 'atelier-claude-progress-fill'});
        this._progress.add_child(this._progressFill);
        this.add_child(this._progress);

        this._numbers = new St.BoxLayout({style_class: 'atelier-claude-numbers', x_expand: true});
        this.add_child(this._numbers);
        this._stats = new Map();
        for (const [id, name] of [['output', 'Output'], ['cacheWrite', 'Cache write'],
            ['cacheRead', 'Cache read'], ['messages', 'Messages']]) {
            const box = new St.BoxLayout({
                style_class: 'atelier-claude-stat',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            const value = label('atelier-claude-value');
            box.add_child(value);
            box.add_child(label('atelier-claude-name', name));
            this._numbers.add_child(box);
            this._stats.set(id, value);
        }

        this._today = label('atelier-claude-line');
        this.add_child(this._today);
        this._week = label('atelier-claude-line');
        this.add_child(this._week);

        this._chart = new St.BoxLayout({style_class: 'atelier-claude-chart', x_expand: true});
        this.add_child(this._chart);

        this._sessions = new St.BoxLayout({style_class: 'atelier-claude-sessions'});
        this._sessionDot = new St.Widget({style_class: 'atelier-claude-session-dot', y_align: Clutter.ActorAlign.CENTER});
        this._sessions.add_child(this._sessionDot);
        this._sessionText = label('atelier-claude-line', '', {y_align: Clutter.ActorAlign.CENTER});
        this._sessions.add_child(this._sessionText);
        this.add_child(this._sessions);

        usage.connectObject('changed', () => this._sync(), this);
        this.connect('notify::mapped', () => {
            if (!this.mapped)
                return;
            usage.refresh();
            this._syncProgress();
        });
        usage.watch(this);
        this._sync();
    }

    _sync() {
        const summary = this._usage.summary;
        if (!summary) {
            this._left.text = '';
            this._span.text = 'Reading Claude Code\'s history…';
            this._showDetails(false);
            return;
        }
        if (!summary.found) {
            this._left.text = '';
            this._span.text = 'No Claude Code history on this computer.';
            this._showDetails(false);
            return;
        }
        this._showDetails(true);

        const block = summary.block;
        this._block = block;
        this._now = summary.now;
        if (block) {
            this._left.text = `${duration(block.end - Date.now())} left`;
            this._span.text = `${shortTime(block.start)} – ${shortTime(block.end)}`;
        } else {
            this._left.text = '';
            this._span.text = 'No block running: it starts with the next message.';
        }
        const totals = block?.totals ?? {output: 0, cacheWrite: 0, cacheRead: 0, messages: 0};
        for (const [id, value] of this._stats)
            value.text = id === 'messages' ? totals.messages.toLocaleString() : formatTokens(totals[id]);
        this._progress.visible = Boolean(block);
        this._syncProgress();

        this._today.text = `Today   ${formatTokens(summary.today.output)} output · ${plural(summary.today.messages, 'message')}`;
        this._week.text = `7 days   ${formatTokens(summary.week.output)} output · ${plural(summary.week.messages, 'message')}`;
        this._syncChart(summary.days);

        const {active = 0, working = 0} = summary.sessions ?? {};
        this._sessions.visible = active > 0;
        this._sessionText.text = working > 0
            ? `${plural(active, 'session')} running, Claude is working`
            : `${plural(active, 'session')} running`;
        if (working > 0)
            this._sessionDot.add_style_pseudo_class('active');
        else
            this._sessionDot.remove_style_pseudo_class('active');
    }

    _showDetails(shown) {
        for (const actor of [this._numbers, this._today, this._week, this._chart, this._progress])
            actor.visible = shown;
        if (!shown)
            this._sessions.visible = false;
    }

    _syncProgress() {
        const block = this._block;
        if (!block)
            return;
        const fraction = (Date.now() - block.start) / Math.max(1, block.end - block.start);
        this._progressLayout.setFraction(Math.min(1, Math.max(0, fraction)));
    }

    _syncChart(days) {
        this._chart.destroy_all_children();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const most = Math.max(1, ...days.map(day => day.output));
        days.forEach((day, i) => {
            const column = new St.BoxLayout({
                style_class: 'atelier-claude-day',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
            });
            if (i === days.length - 1)
                column.add_style_pseudo_class('today');
            const room = new St.Widget({
                style_class: 'atelier-claude-day-room',
                layout_manager: new Clutter.BinLayout(),
                height: BAR_HEIGHT * scale,
            });
            room.add_child(new St.Widget({
                style_class: 'atelier-claude-day-bar',
                height: Math.max(2 * scale, Math.round(BAR_HEIGHT * scale * day.output / most)),
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.END,
            }));
            column.add_child(room);
            const date = GLib.DateTime.new_from_unix_local(Math.floor(day.start / 1000));
            column.add_child(label('atelier-claude-day-name', date.format('%a'), {x_align: Clutter.ActorAlign.CENTER}));
            this._chart.add_child(column);
        });
    }
});
