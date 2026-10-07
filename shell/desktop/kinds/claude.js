// Claude Code on this computer: how far the 5-hour block is (a ring, with
// what Claude wrote in it), and as a card today and the last seven days.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {formatTokens} from '../../../lib/claudeUsage.js';
import {DesktopWidget, label} from '../widget.js';

const Ring = GObject.registerClass(
class AtelierClaudeRing extends St.DrawingArea {
    _init() {
        super._init({style_class: 'atelier-widget-ring', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.fraction = 0;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const node = this.get_theme_node();
        const color = node.get_foreground_color();
        const [, accent] = node.lookup_color('-atelier-ring-color', false);
        const line = Math.max(3, Math.min(width, height) * 0.07);
        const radius = Math.min(width, height) / 2 - line / 2;
        const set = (c, alpha) => cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, alpha);
        cr.setLineWidth(line);
        cr.setLineCap(Cairo.LineCap.ROUND);
        set(color, 0.15);
        cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
        cr.stroke();
        if (this.fraction > 0) {
            set(accent, 1);
            cr.arc(width / 2, height / 2, radius, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * this.fraction);
            cr.stroke();
        }
        cr.$dispose();
    }
});

const left = ms => {
    const minutes = Math.max(0, Math.round(ms / 60000));
    return minutes < 60 ? `${minutes} min left` : `${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
};

export const ClaudeWidget = GObject.registerClass(
class AtelierClaudeWidget extends DesktopWidget {
    build(box, size) {
        const row = new St.BoxLayout({style_class: 'atelier-widget-claude-row', x_expand: true, y_expand: true});
        box.add_child(row);
        const dial = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER,
            x_expand: size === 'square'});
        this._ring = new Ring();
        dial.add_child(this._ring);
        const middle = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._output = label('atelier-widget-claude-output', '', {x_align: Clutter.ActorAlign.CENTER});
        this._left = label('atelier-widget-caption', '', {x_align: Clutter.ActorAlign.CENTER});
        middle.add_child(this._output);
        middle.add_child(this._left);
        dial.add_child(middle);
        row.add_child(dial);
        this._numbers = null;
        if (size === 'card') {
            this._numbers = new St.BoxLayout({
                style_class: 'atelier-widget-claude-numbers',
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(this._numbers);
        }
        // (Its connection to the usage stays: built anew for another size or
        // look, it would otherwise get one more each time.)
        this._sync();
    }

    _sync() {
        if (!this._ring)
            return;
        // The usage is the Claude module's, which may have started anew.
        const usage = this._context.claude()?.usage ?? null;
        if (usage !== this._usage) {
            this._usage?.disconnectObject(this);
            this._usage = usage;
            usage?.connectObject('changed', () => this._sync(), this);
            usage?.watch(this);
        }
        const summary = usage?.summary;
        const block = summary?.block;
        this._ring.fraction = block
            ? Math.min(1, Math.max(0, (Date.now() - block.start) / Math.max(1, block.end - block.start)))
            : 0;
        this._ring.queue_repaint();
        this._output.text = block ? formatTokens(block.totals.output) : '–';
        this._left.text = !summary?.found ? 'No Claude Code here' : block ? left(block.end - Date.now()) : 'No block';
        if (this._numbers) {
            this._numbers.destroy_all_children();
            for (const [name, period] of [['Today', summary?.today], ['7 days', summary?.week]]) {
                const line = new St.BoxLayout({style_class: 'atelier-widget-claude-line'});
                line.add_child(label('atelier-widget-caption', name, {x_expand: true}));
                line.add_child(label('atelier-widget-agenda-text', period ? `${formatTokens(period.output)} out` : '–'));
                this._numbers.add_child(line);
            }
            const sessions = summary?.sessions?.active ?? 0;
            if (sessions > 0) {
                this._numbers.add_child(label('atelier-widget-caption',
                    summary.sessions.working > 0 ? 'Claude is working' : `${sessions} running`));
            }
        }
    }

    cleanup() {
        this._usage?.disconnectObject(this);
        this._usage = null;
        this._ring = null;
    }
});
