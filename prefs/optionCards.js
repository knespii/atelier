// Choices shown as cards with a small preview, like a gallery of styles.

import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

export const OptionCards = GObject.registerClass({
    Signals: {'changed': {param_types: [GObject.TYPE_STRING]}},
}, class AtelierOptionCards extends Gtk.FlowBox {
    /**
     * @param {object} params
     * @param {{id: string, label: string, preview: Gtk.Widget}[]} params.options
     * @param {string} params.selected
     */
    _init({options, selected}) {
        super._init({
            selection_mode: Gtk.SelectionMode.NONE,
            homogeneous: true,
            column_spacing: 12,
            row_spacing: 12,
            min_children_per_line: Math.min(3, options.length),
            max_children_per_line: options.length,
        });
        this._buttons = new Map();
        let group = null;
        for (const option of options) {
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
            option.preview.halign = Gtk.Align.CENTER;
            box.append(option.preview);
            box.append(new Gtk.Label({label: option.label}));
            const button = new Gtk.ToggleButton({
                css_classes: ['atelier-option-card'],
                child: box,
                active: option.id === selected,
            });
            if (group)
                button.set_group(group);
            group ??= button;
            button.connect('toggled', () => {
                if (button.active)
                    this.emit('changed', option.id);
            });
            this.append(button);
            this._buttons.set(option.id, button);
        }
    }

    /** @param {string} id */
    setSelected(id) {
        const button = this._buttons.get(id);
        if (button && !button.active)
            button.active = true;
    }
});

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function setColor(cr, hex) {
    const rgba = new Gdk.RGBA();
    rgba.parse(hex);
    Gdk.cairo_set_source_rgba(cr, rgba);
}

/**
 * A tiny window-like preview painted with a few palette roles.
 *
 * @param {object} scheme - palette.dark or palette.light
 * @param {number} [width]
 * @param {number} [height]
 * @returns {Gtk.DrawingArea}
 */
export function schemePreview(scheme, width = 132, height = 76) {
    const area = new Gtk.DrawingArea({content_width: width, content_height: height});
    area.set_draw_func((_area, cr, w, h) => {
        roundedRect(cr, 0.5, 0.5, w - 1, h - 1, 10);
        setColor(cr, scheme.surface);
        cr.fillPreserve();
        setColor(cr, scheme.outlineVariant ?? scheme.surfaceContainerHigh);
        cr.setLineWidth(1);
        cr.stroke();
        roundedRect(cr, 8, 8, w - 16, 14, 7);
        setColor(cr, scheme.surfaceContainerHigh);
        cr.fill();
        roundedRect(cr, 8, 28, (w - 16) * 0.55, 10, 5);
        setColor(cr, scheme.onSurfaceVariant);
        cr.fill();
        roundedRect(cr, 8, h - 26, (w - 16) * 0.5, 18, 9);
        setColor(cr, scheme.primary);
        cr.fill();
        roundedRect(cr, w - 8 - (w - 16) * 0.38, h - 26, (w - 16) * 0.38, 18, 9);
        setColor(cr, scheme.secondaryContainer ?? scheme.surfaceContainer);
        cr.fill();
    });
    return area;
}

/**
 * A row of color dots.
 *
 * @param {string[]} colors
 * @param {number} [size]
 * @returns {Gtk.DrawingArea}
 */
export function swatchesPreview(colors, size = 18) {
    const gap = 6;
    const area = new Gtk.DrawingArea({
        content_width: Math.max(1, colors.length * (size + gap) - gap),
        content_height: size,
    });
    area.set_draw_func((_area, cr) => {
        colors.forEach((color, i) => {
            cr.arc(i * (size + gap) + size / 2, size / 2, size / 2, 0, 2 * Math.PI);
            setColor(cr, color);
            cr.fill();
        });
    });
    return area;
}
