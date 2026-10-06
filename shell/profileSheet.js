// The form on the sheet that drips from the island for a new profile: its
// name and its style – the wallpaper, themes and the rest as they were taken
// from the desktop. It is saved from here; Settings have the rest to change.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {ACCENT_COLORS, AUTO_ACCENT, describeProfile, effectiveWallpaper} from '../lib/profiles.js';
import {hasThumbnail, thumbnailPath} from '../lib/thumbnails.js';

const SCHEMES = [[null, 'Keep'], ['default', 'Light'], ['prefer-dark', 'Dark']];
const ACCENTS = [
    [null, 'Keep as it is', 'action-unavailable-symbolic'],
    [AUTO_ACCENT, 'Match the wallpaper', 'color-select-symbolic'],
    ...Object.keys(ACCENT_COLORS).map(name => [name, name[0].toUpperCase() + name.slice(1), null]),
];

export const ProfileSheet = GObject.registerClass({
    Signals: {
        'save': {},
        'more': {},
        'cancel': {},
    },
}, class AtelierProfileSheet extends St.BoxLayout {
    /**
     * @param {object} draft - the new profile, as taken from the desktop
     */
    _init(draft) {
        super._init({style_class: 'atelier-profile-sheet', orientation: Clutter.Orientation.VERTICAL});
        this._scheme = draft.colorScheme === 'prefer-light' ? 'default' : draft.colorScheme;
        this._accent = draft.accentColor;
        this._draftName = draft.name;

        // The wallpaper, and what else it keeps.
        const header = new St.BoxLayout({style_class: 'atelier-profile-sheet-header'});
        const picture = new St.Widget({style_class: 'atelier-profile-sheet-picture', y_align: Clutter.ActorAlign.CENTER});
        const wallpaper = effectiveWallpaper(draft, draft.colorScheme ?? 'default');
        if (wallpaper) {
            const path = hasThumbnail(wallpaper) ? thumbnailPath(wallpaper) : wallpaper;
            picture.style = `background-image: url("${Gio.File.new_for_path(path).get_uri()}");`;
        }
        header.add_child(picture);
        const titles = new St.BoxLayout({
            style_class: 'atelier-profile-sheet-titles',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        titles.add_child(new St.Label({style_class: 'atelier-profile-sheet-title', text: 'New Profile'}));
        // (Its style is below.)
        const parts = Object.fromEntries(describeProfile(draft).map(({label, value}) => [label, value]));
        const kept = [parts.GTK, parts.Icons && `${parts.Icons} icons`, parts.Font, parts.Widgets].filter(Boolean);
        const caption = new St.Label({
            style_class: 'atelier-profile-sheet-caption',
            text: kept.length > 0 ? kept.join(' · ') : 'This wallpaper, as the desktop has it',
        });
        caption.clutter_text.line_wrap = true;
        titles.add_child(caption);
        header.add_child(titles);
        this.add_child(header);

        this._name = new St.Entry({
            style_class: 'atelier-profile-sheet-entry',
            text: draft.name,
            hint_text: 'Name',
            can_focus: true,
            x_expand: true,
        });
        this._name.clutter_text.connect('activate', () => {
            if (this._name.text.trim())
                this.emit('save');
        });
        this._name.clutter_text.connect('text-changed', () => this._sync());
        this.add_child(this._label('Name'));
        this.add_child(this._name);

        const style = new St.BoxLayout({style_class: 'atelier-profile-sheet-row'});
        const styleLabel = this._label('Light or dark');
        styleLabel.x_expand = true;
        styleLabel.y_align = Clutter.ActorAlign.CENTER;
        style.add_child(styleLabel);
        const segments = new St.BoxLayout({style_class: 'atelier-profile-sheet-segments'});
        this._schemes = SCHEMES.map(([value, text]) => {
            const button = new St.Button({style_class: 'atelier-profile-sheet-segment', label: text, can_focus: true});
            button._value = value;
            button.connect('clicked', () => {
                this._scheme = value;
                this._sync();
            });
            segments.add_child(button);
            return button;
        });
        style.add_child(segments);
        this.add_child(style);

        this.add_child(this._label('Accent color'));
        const swatches = new St.BoxLayout({style_class: 'atelier-profile-sheet-swatches'});
        this._accents = ACCENTS.map(([value, name, icon]) => {
            const button = new St.Button({
                style_class: 'atelier-profile-sheet-swatch',
                accessible_name: name,
                can_focus: true,
                child: new St.Icon({icon_name: icon ?? 'object-select-symbolic'}),
            });
            if (isAccent(value))
                button.style = `background-color: ${ACCENT_COLORS[value]};`;
            else
                button.add_style_class_name('atelier-profile-sheet-swatch-plain');
            button._value = value;
            button._icon = icon;
            button.connect('clicked', () => {
                this._accent = value;
                this._sync();
            });
            swatches.add_child(button);
            return button;
        });
        this.add_child(swatches);

        const buttons = new St.BoxLayout({style_class: 'atelier-profile-sheet-buttons'});
        const button = (text, signal, extra = '') => {
            const b = new St.Button({style_class: `atelier-profile-sheet-button ${extra}`, label: text, can_focus: true});
            b.connect('clicked', () => this.emit(signal));
            buttons.add_child(b);
            return b;
        };
        button('More in Settings…', 'more', 'atelier-profile-sheet-more');
        buttons.add_child(new St.Widget({x_expand: true}));
        button('Cancel', 'cancel');
        this._save = button('Save', 'save', 'atelier-profile-sheet-save');
        this.add_child(buttons);
        this._sync();
    }

    /** @returns {object} {name, colorScheme, accentColor} as chosen */
    get fields() {
        return {
            name: this._name.text.trim() || this._draftName,
            colorScheme: this._scheme,
            accentColor: this._accent,
        };
    }

    focus() {
        this._name.grab_key_focus();
        this._name.clutter_text.set_selection(0, -1);
    }

    _label(text) {
        return new St.Label({style_class: 'atelier-profile-sheet-label', text});
    }

    _sync() {
        for (const segment of this._schemes) {
            if (segment._value === this._scheme)
                segment.add_style_pseudo_class('checked');
            else
                segment.remove_style_pseudo_class('checked');
        }
        for (const swatch of this._accents) {
            const chosen = swatch._value === this._accent;
            if (chosen)
                swatch.add_style_pseudo_class('checked');
            else
                swatch.remove_style_pseudo_class('checked');
            // A tick on the chosen color; the other two always show theirs.
            swatch.child.visible = chosen || swatch._icon !== null;
        }
        // Save in the accent it will have; not without a name.
        this._save.reactive = this._name.text.trim().length > 0;
        this._save.style = isAccent(this._accent) && this._save.reactive
            ? `background-color: ${ACCENT_COLORS[this._accent]}; color: #ffffff;` : '';
    }
});

function isAccent(value) {
    return typeof value === 'string' && Object.hasOwn(ACCENT_COLORS, value);
}
