// "Top Bar" section: the bar's shape and look (as cards with little
// pictures, like impasto's), its modules and the control centre.

import Adw from 'gi://Adw';
import Cairo from 'cairo';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {OptionCards} from './optionCards.js';

const STYLES = [
    ['grouped', 'Grouped', 'The workspaces, the island and the status icons together in the middle'],
    ['spread', 'Spread', 'The workspaces at the left edge, the status icons at the right one'],
    ['island', 'One island', 'All of it in one island'],
    ['gnome', 'GNOME', 'GNOME\'s bar across the top, black or glass'],
];
const SHAPES = [
    ['floating', 'Floating', 'A capsule below the top edge'],
    ['notch', 'Notch', 'Hanging from the top edge, which curves into it'],
];
const SURFACES = [
    ['classic', 'Classic', 'Black'],
    ['glass', 'Glass', 'The blurred wallpaper under it'],
];
const SIDES = [
    ['wallpaper', 'On the wallpaper', 'The workspaces and the status icons right on the wallpaper'],
    ['capsules', 'In capsules', 'The workspaces and the status icons in capsules like the island'],
];

// The pictures: a little screen with the top of the desktop.
const PICTURE_WIDTH = 104;
const PICTURE_HEIGHT = 46;
const BAR = 5; // top of a floating island
const PILL = 9; // its height
const ISLAND = 32; // its width
const EAR = 3;

function roundedRect(cr, x, y, w, h, r) {
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// A notch from the top edge: rounded at the bottom, curving into the edge.
function notchPath(cr, x, w, h, r, ear) {
    cr.newSubPath();
    cr.moveTo(x - ear, 0);
    cr.arc(x - ear, ear, ear, -Math.PI / 2, 0);
    cr.arcNegative(x + r, h - r, r, Math.PI, Math.PI / 2);
    cr.arcNegative(x + w - r, h - r, r, Math.PI / 2, 0);
    cr.arc(x + w + ear, ear, ear, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/**
 * @param {object} cr - Cairo context
 * @param {string} surface - 'classic' or 'glass'
 */
function fillSurface(cr, surface) {
    if (surface === 'glass') {
        cr.setSourceRGBA(0.1, 0.11, 0.13, 0.5);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 1, 1, 0.28);
        cr.setLineWidth(1);
        cr.stroke();
    } else {
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.fill();
    }
}

function accent() {
    const color = Adw.StyleManager.get_default().get_accent_color_rgba();
    return [color.red, color.green, color.blue];
}

/**
 * The top of a desktop in a given look.
 *
 * @param {Function} look - () => {style, shape, surface, sides}
 * @returns {Gtk.DrawingArea}
 */
function barPicture(look) {
    const area = new Gtk.DrawingArea({content_width: PICTURE_WIDTH, content_height: PICTURE_HEIGHT});
    area.set_draw_func((_area, cr, w, h) => {
        const {style, shape, surface, sides} = look();
        roundedRect(cr, 0, 0, w, h, 8);
        cr.save();
        cr.clip();
        const wallpaper = new Cairo.LinearGradient(0, 0, w * 0.6, h * 1.4);
        wallpaper.addColorStopRGB(0, 0.66, 0.6, 0.5);
        wallpaper.addColorStopRGB(1, 0.24, 0.3, 0.22);
        cr.setSource(wallpaper);
        cr.paint();

        const cx = Math.round(w / 2);
        const notch = shape === 'notch';
        const islandX = cx - ISLAND / 2;
        const spaces = 16; // the workspaces' width
        const icons = 14; // the status icons'
        let spacesX = 5;
        let iconsX = w - 5 - icons;
        if (style === 'gnome') {
            cr.rectangle(0, 0, w, PILL + 2 * BAR - 2);
            cr.setSourceRGBA(0, 0, 0, 1);
            cr.fill();
        } else if (style === 'grouped') {
            const gap = notch ? 4 + EAR : 4;
            spacesX = islandX - gap - spaces;
            iconsX = islandX + ISLAND + gap;
        } else if (style === 'island') {
            spacesX = islandX - 2 - spaces;
            iconsX = islandX + ISLAND + 2;
            const [x1, x2] = [spacesX - 4, iconsX + icons + 4];
            if (notch)
                notchPath(cr, x1, x2 - x1, PILL + BAR, 4, EAR);
            else
                roundedRect(cr, x1, BAR, x2 - x1, PILL, PILL / 2);
            fillSurface(cr, surface);
        }
        if (sides === 'capsules' && (style === 'grouped' || style === 'spread')) {
            for (const [x, width] of [[spacesX, spaces], [iconsX, icons]]) {
                roundedRect(cr, x - 3, BAR, width + 6, PILL, PILL / 2);
                fillSurface(cr, surface);
            }
        }

        // The island, with the time in it.
        if (style !== 'island') {
            if (notch)
                notchPath(cr, islandX, ISLAND, PILL + BAR, 4, EAR);
            else
                roundedRect(cr, islandX, BAR, ISLAND, PILL, PILL / 2);
            fillSurface(cr, surface);
        }
        const middle = notch ? (PILL + BAR) / 2 : BAR + PILL / 2;
        cr.setSourceRGBA(1, 1, 1, 0.9);
        roundedRect(cr, cx - 9, middle - 1, 18, 2, 1);
        cr.fill();

        // The workspaces (the current one in the accent color) and the icons.
        cr.setSourceRGBA(...accent(), 1);
        roundedRect(cr, spacesX + 1, middle - 1.5, 7, 3, 1.5);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 0.9);
        for (const x of [spacesX + 11, spacesX + 15]) {
            cr.arc(x, middle, 1.4, 0, 2 * Math.PI);
            cr.fill();
        }
        for (const x of [iconsX + 2, iconsX + 7, iconsX + 12]) {
            cr.arc(x, middle, 1.6, 0, 2 * Math.PI);
            cr.fill();
        }
        cr.restore();
    });
    return area;
}

/**
 * Black or glass: a capsule with some text over the wallpaper.
 *
 * @param {string} surface
 * @returns {Gtk.DrawingArea}
 */
function surfacePicture(surface) {
    const area = new Gtk.DrawingArea({content_width: PICTURE_WIDTH, content_height: PICTURE_HEIGHT});
    area.set_draw_func((_area, cr, w, h) => {
        roundedRect(cr, 0, 0, w, h, 8);
        cr.save();
        cr.clip();
        const wallpaper = new Cairo.LinearGradient(0, 0, w, h);
        wallpaper.addColorStopRGB(0, 0.66, 0.6, 0.5);
        wallpaper.addColorStopRGB(0.55, 0.42, 0.5, 0.36);
        wallpaper.addColorStopRGB(1, 0.24, 0.3, 0.22);
        cr.setSource(wallpaper);
        cr.paint();
        const [pw, ph] = [52, 26];
        roundedRect(cr, (w - pw) / 2, (h - ph) / 2, pw, ph, 8);
        fillSurface(cr, surface);
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(11);
        const extents = cr.textExtents('Aa');
        cr.moveTo((w - extents.width) / 2 - extents.xBearing, (h - extents.height) / 2 - extents.yBearing);
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.showText('Aa');
        cr.restore();
    });
    return area;
}

export const BarPage = GObject.registerClass(
class AtelierBarPage extends Adw.PreferencesPage {
    _init(settings) {
        super._init({title: 'Top Bar', name: 'top-bar'});
        this._ids = [];
        this._bound = [];
        this._pictures = [];
        this._bar = settings.get_child('bar');
        const controlCentre = settings.get_child('control-centre');

        const shape = new Adw.PreferencesGroup({title: 'Shape'});
        this.add(shape);
        const look = override => () => ({
            style: this._bar.get_string('style'),
            shape: this._bar.get_string('island-shape'),
            surface: this._bar.get_string('surface'),
            sides: this._bar.get_string('sides'),
            ...override,
        });
        this._style = this._cards(shape, 'style', 'Style', STYLES, id => barPicture(look({style: id})));
        this._shape = this._cards(shape, 'island-shape', 'Island', SHAPES, id => barPicture(look({shape: id})));
        this._surface = this._cards(shape, 'surface', 'Ground', SURFACES, id => surfacePicture(id));
        this._sides = this._toggles(shape, 'sides', 'Sides', SIDES);
        this._compact = new Adw.SwitchRow({
            title: 'Only the essentials',
            subtitle: 'Grouped or as one island: the workspaces, the time and the battery. ' +
                'The control centre has the rest.',
        });
        this._bar.bind('compact', this._compact, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push(this._compact, 'active');
        shape.add(this._compact);
        const syncRows = () => {
            const style = this._bar.get_string('style');
            this._sidesRow.sensitive = ['grouped', 'spread'].includes(style);
            this._compact.sensitive = ['grouped', 'island'].includes(style);
        };
        syncRows();
        this._ids.push(this._bar.connect('changed::style', syncRows));
        // The pictures show the other choices as they are.
        for (const key of ['style', 'island-shape', 'surface', 'sides'])
            this._ids.push(this._bar.connect(`changed::${key}`, () => this._pictures.forEach(p => p.queue_draw())));

        const modules = new Adw.PreferencesGroup({
            title: 'Modules',
            description: 'Next to the status icons. They only show something; resting the pointer on one ' +
                'shows its details in the island.',
        });
        this.add(modules);
        this._claude = this._module(modules, 'claude', 'Claude Code',
            'How far the 5-hour block is and what Claude wrote in it; read from this computer only');
        this._weather = this._module(modules, 'weather', 'Weather', 'From GNOME Weather');
        const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._battery = new Adw.SwitchRow({title: 'Battery percentage', subtitle: 'Next to the battery icon'});
        iface.bind('show-battery-percentage', this._battery, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push(this._battery, 'active');
        modules.add(this._battery);

        const centre = new Adw.PreferencesGroup({
            title: 'Control Centre',
            description: 'GNOME\'s quick settings – Wi-Fi, Bluetooth, sound, brightness, power mode and the ' +
                'tiles of extensions such as Caffeine – with the notifications and the calendar on further ' +
                'tabs, in the island. The status icons in the bar only show the state.',
        });
        this.add(centre);
        this._controlCentre = this._switch(centre, controlCentre, 'enabled', 'Open the control centre in the island',
            'Click the island, or Super+S; Super+V for the notifications');
        this._extensions = this._switch(centre, controlCentre, 'extensions', 'Extension icons in the control centre',
            'On its Extensions tab instead of the top bar');
        controlCentre.bind('enabled', this._extensions, 'sensitive', Gio.SettingsBindFlags.GET);
        this._bound.push(this._extensions, 'sensitive');
    }

    // A title, what the choice means, and the choices as cards.
    _cards(group, key, title, choices, picture) {
        const row = new Adw.PreferencesRow({activatable: false});
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        box.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['heading']}));
        const description = new Gtk.Label({xalign: 0, wrap: true, css_classes: ['dim-label', 'caption']});
        box.append(description);
        const cards = new OptionCards({
            options: choices.map(([id, label]) => {
                const preview = picture(id);
                this._pictures.push(preview);
                return {id, label, preview};
            }),
            selected: this._bar.get_string(key),
            columns: choices.length,
        });
        cards.margin_top = 10;
        cards.connect('changed', (_, id) => {
            if (this._bar.get_string(key) !== id)
                this._bar.set_string(key, id);
        });
        box.append(cards);
        row.set_child(box);
        group.add(row);

        const sync = () => {
            const value = this._bar.get_string(key);
            cards.setSelected(value);
            description.label = choices.find(([id]) => id === value)?.[2] ?? '';
        };
        sync();
        this._ids.push(this._bar.connect(`changed::${key}`, sync));
        return cards;
    }

    // Two or three choices side by side.
    _toggles(group, key, title, choices) {
        const toggles = new Adw.ToggleGroup({valign: Gtk.Align.CENTER});
        for (const [id, label] of choices)
            toggles.add(new Adw.Toggle({name: id, label}));
        const row = new Adw.ActionRow({title});
        row.add_suffix(toggles);
        group.add(row);
        this._sidesRow = row;

        const sync = () => {
            const value = this._bar.get_string(key);
            if (toggles.active_name !== value)
                toggles.active_name = value;
            row.subtitle = choices.find(([id]) => id === value)?.[2] ?? '';
        };
        sync();
        toggles.connect('notify::active-name', () => {
            if (toggles.active_name && this._bar.get_string(key) !== toggles.active_name)
                this._bar.set_string(key, toggles.active_name);
        });
        this._ids.push(this._bar.connect(`changed::${key}`, sync));
        return toggles;
    }

    _module(group, id, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        const sync = () => (row.active = this._bar.get_strv('modules').includes(id));
        sync();
        row.connect('notify::active', () => {
            const modules = this._bar.get_strv('modules').filter(m => m !== id);
            if (row.active)
                modules.push(id);
            if (modules.join() !== this._bar.get_strv('modules').join())
                this._bar.set_strv('modules', modules);
        });
        this._ids.push(this._bar.connect('changed::modules', sync));
        group.add(row);
        return row;
    }

    _switch(group, settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        this._bound.push(row, 'active');
        group.add(row);
        return row;
    }

    disconnectSettings() {
        this._ids.forEach(id => this._bar.disconnect(id));
        this._ids = [];
        for (let i = 0; i < this._bound.length; i += 2)
            Gio.Settings.unbind(this._bound[i], this._bound[i + 1]);
        this._bound = [];
    }
});
