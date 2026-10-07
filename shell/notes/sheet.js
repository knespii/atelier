// The form on the sheet that drips from the island for a note, new or not:
// a paper to write on – its title and its text, a line starting with "- [ ]"
// a checkbox – in one of the paper colors, the edge it is pinned to, and a
// reminder if it should have one (a day and a time, when a notification
// comes); one that is there already can be archived or deleted, too.
// Ctrl+Enter saves it from anywhere on it. Enter on a line with a checkbox
// starts the next one with a checkbox too (Shift+Enter: without).

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {
    COLORS, boxLines, continueList, dayOffset, defaultReminder, parseClock, reminderAt, toggleLine,
} from '../../lib/notes.js';
import {dayText, paperStyle} from './card.js';

const PINS = [['left', 'Left'], ['right', 'Right'], [null, 'None']];
// A reminder's time goes up or down by this much (Up, Down, scrolling).
const STEP = 15 * 60 * 1000;

const clockText = ([hours, minutes]) => `${hours}:${String(minutes).padStart(2, '0')}`;

// ClutterText counts characters, JavaScript UTF-16 units (an emoji is two).
const indexOf = (value, chars) => (chars < 0 ? value.length : [...value].slice(0, chars).join('').length);
const charsTo = (value, index) => [...value.slice(0, index)].length;

export const NoteSheet = GObject.registerClass({
    Signals: {
        'save': {},
        'cancel': {},
        'archive': {},
        'delete': {},
    },
}, class AtelierNoteSheet extends St.BoxLayout {
    /**
     * @param {object|null} [note] - the note to change; none for a new one
     */
    _init(note = null) {
        super._init({style_class: 'atelier-note-sheet', orientation: Clutter.Orientation.VERTICAL});
        // As new notes are: yellow, on the left edge.
        this._color = note?.color ?? 'yellow';
        this._pin = note ? note.pin : 'left';

        // The paper: its title, and its text from the top, scrolled when
        // long; a click under it writes on.
        this._paper = new St.BoxLayout({style_class: 'atelier-note-sheet-paper', orientation: Clutter.Orientation.VERTICAL});
        this._title = new St.Entry({style_class: 'atelier-note-title-entry', hint_text: 'Title', can_focus: true,
            text: note?.title ?? ''});
        this._title.clutter_text.connect('activate', () => this._text.grab_key_focus());
        this._paper.add_child(this._title);
        this._text = new St.Entry({style_class: 'atelier-note-text-entry', hint_text: 'Write something…',
            can_focus: true, x_expand: true, text: note?.text ?? ''});
        const text = this._text.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        const page = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, reactive: true, x_expand: true});
        page.add_child(this._text);
        page.connect('button-press-event', () => {
            this._text.grab_key_focus();
            text.set_cursor_position(-1);
            return Clutter.EVENT_STOP;
        });
        this._paper.add_child(new St.ScrollView({
            style_class: 'atelier-note-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            y_expand: true,
            child: page,
        }));
        for (const entry of [this._title, this._text]) {
            entry.clutter_text.connect('key-press-event', (_, event) => this._onKey(entry, event));
            entry.clutter_text.connect('text-changed', () => this._sync());
        }
        this.add_child(this._paper);

        // Its color, and where it is pinned.
        const row = new St.BoxLayout({style_class: 'atelier-sheet-row'});
        const colors = new St.BoxLayout({style_class: 'atelier-note-colors', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._colors = Object.entries(COLORS).map(([name, {paper, name: label}]) => {
            const dot = new St.Button({
                style_class: 'atelier-note-color atelier-note-sheet-color',
                style: `background-color: ${paper};`,
                accessible_name: label,
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            dot._color = name;
            dot.connect('clicked', () => {
                this._color = name;
                this._sync();
            });
            colors.add_child(dot);
            return dot;
        });
        row.add_child(colors);
        const pins = new St.BoxLayout({style_class: 'atelier-sheet-segments', accessible_name: 'Pinned to'});
        this._pins = PINS.map(([value, label]) => {
            const segment = new St.Button({style_class: 'atelier-sheet-segment', label, can_focus: true});
            segment._value = value;
            segment.connect('clicked', () => {
                this._pin = value;
                this._sync();
            });
            pins.add_child(segment);
            return segment;
        });
        row.add_child(pins);
        this.add_child(row);

        // When it reminds of itself, if it does: a day (a day earlier or
        // later) and a time. (The row is always there: the sheet doesn't
        // grow out of its panel.)
        this._noteRemind = note?.remind ?? null;
        this._reminding = false;
        this._days = 0;
        this._clock = null;
        const reminder = new St.BoxLayout({style_class: 'atelier-sheet-row atelier-note-sheet-reminder'});
        const remindLabel = new St.BoxLayout({style_class: 'atelier-note-sheet-remind-label'});
        remindLabel.add_child(new St.Icon({icon_name: 'alarm-symbolic', y_align: Clutter.ActorAlign.CENTER}));
        remindLabel.add_child(new St.Label({text: 'Remind me', y_align: Clutter.ActorAlign.CENTER}));
        this._remindButton = new St.Button({
            style_class: 'atelier-sheet-button atelier-sheet-flat atelier-note-sheet-remind',
            can_focus: true,
            child: remindLabel,
        });
        this._remindButton.connect('clicked', () => this._startReminder());
        reminder.add_child(this._remindButton);
        this._reminder = new St.BoxLayout({style_class: 'atelier-note-sheet-reminder-controls', visible: false, x_expand: true});
        reminder.add_child(this._reminder);
        this._reminder.add_child(new St.Icon({
            style_class: 'atelier-note-sheet-reminder-icon',
            icon_name: 'alarm-symbolic',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const step = (icon, name, action) => {
            const b = new St.Button({
                style_class: 'atelier-sheet-button atelier-sheet-icon atelier-note-sheet-reminder-step',
                accessible_name: name,
                can_focus: true,
                child: new St.Icon({icon_name: icon}),
            });
            b.connect('clicked', action);
            return b;
        };
        this._earlier = step('go-previous-symbolic', 'A day earlier', () => this._setReminder(this._days - 1, this._clock));
        this._reminder.add_child(this._earlier);
        this._day = new St.Label({style_class: 'atelier-note-sheet-reminder-day', y_align: Clutter.ActorAlign.CENTER});
        this._reminder.add_child(this._day);
        this._reminder.add_child(step('go-next-symbolic', 'A day later', () => this._setReminder(this._days + 1, this._clock)));
        this._time = new St.Entry({
            style_class: 'atelier-note-sheet-reminder-time',
            hint_text: '9:00',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._time.clutter_text.connect('text-changed', () => {
            this._clock = parseClock(this._time.text);
            this._sync();
        });
        this._time.clutter_text.connect('key-press-event', (_, event) => this._onTimeKey(event));
        this._time.connect('scroll-event', (_, event) => {
            const direction = event.get_scroll_direction();
            if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.DOWN)
                this._moveReminder(direction === Clutter.ScrollDirection.UP ? STEP : -STEP);
            return Clutter.EVENT_STOP;
        });
        this._reminder.add_child(this._time);
        this._reminder.add_child(new St.Widget({x_expand: true}));
        this._reminder.add_child(step('window-close-symbolic', 'No reminder', () => this._dropReminder()));
        this.add_child(reminder);

        const buttons = new St.BoxLayout({style_class: 'atelier-sheet-buttons'});
        const button = (label, action, style = '') => {
            const b = new St.Button({style_class: `atelier-sheet-button ${style}`, label, can_focus: true});
            b.connect('clicked', action);
            buttons.add_child(b);
            return b;
        };
        button('Checkbox', () => this._toggleCheckbox(), 'atelier-sheet-flat');
        // One that is there already: into the archive (or out of it), or gone.
        if (note) {
            for (const [icon, name, signal] of [
                ['package-x-generic-symbolic', note.archived ? 'Unarchive' : 'Archive', 'archive'],
                ['user-trash-symbolic', 'Delete', 'delete'],
            ]) {
                const b = new St.Button({
                    style_class: 'atelier-sheet-button atelier-sheet-icon',
                    accessible_name: name,
                    can_focus: true,
                    child: new St.Icon({icon_name: icon}),
                });
                b.connect('clicked', () => this.emit(signal));
                buttons.add_child(b);
            }
        }
        buttons.add_child(new St.Widget({x_expand: true}));
        button('Cancel', () => this.emit('cancel'));
        this._save = button('Save', () => this.emit('save'), 'atelier-sheet-primary');
        this.add_child(buttons);
        if (this._noteRemind !== null) {
            const date = new Date(this._noteRemind);
            this._setReminder(dayOffset(this._noteRemind, new Date()), [date.getHours(), date.getMinutes()]);
        }
        this._sync();
    }

    /** @returns {object} {title, text, color, pin, remind} as written */
    get fields() {
        // (A reminder half written stays as it was.)
        const remind = !this._reminding ? null : this._reminderValid() ? this._remindAt() : this._noteRemind;
        return {title: this._title.text, text: this._text.text, color: this._color, pin: this._pin, remind};
    }

    /** @returns {number|null} when the reminder set is, in milliseconds */
    _remindAt() {
        return this._clock ? reminderAt(this._days, ...this._clock, new Date()) : null;
    }

    /** @returns {boolean} whether there is no reminder, or one to come */
    _reminderValid() {
        return !this._reminding || (this._clock !== null && this._remindAt() > Date.now());
    }

    _setReminder(days, clock) {
        this._days = Math.max(0, days);
        this._reminding = true;
        if (clock)
            this._time.text = clockText(clock);
        this._sync();
    }

    // At the next full hour, or tomorrow morning: the time ready to be
    // written over.
    _startReminder() {
        const time = defaultReminder(new Date());
        const date = new Date(time);
        this._setReminder(dayOffset(time, new Date()), [date.getHours(), date.getMinutes()]);
        this._time.grab_key_focus();
        this._time.clutter_text.set_selection(0, -1);
    }

    _dropReminder() {
        this._reminding = false;
        this._sync();
        this._remindButton.grab_key_focus();
    }

    /** @param {number} ms - later (or, less than 0, earlier) */
    _moveReminder(ms) {
        const now = new Date();
        const time = (this._remindAt() ?? defaultReminder(now)) + ms;
        if (time <= now.getTime())
            return;
        const date = new Date(time);
        this._setReminder(dayOffset(time, now), [date.getHours(), date.getMinutes()]);
    }

    _onTimeKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Up || key === Clutter.KEY_Down) {
            this._moveReminder(key === Clutter.KEY_Up ? STEP : -STEP);
            return Clutter.EVENT_STOP;
        }
        if ((key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) &&
            event.get_state() & Clutter.ModifierType.CONTROL_MASK) {
            if (!this.empty && this._reminderValid())
                this.emit('save');
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** @returns {boolean} whether nothing is written on it */
    get empty() {
        return !this._title.text.trim() && !this._text.text.trim();
    }

    focus() {
        this._text.grab_key_focus();
        // (At the end of what is written.)
        this._text.clutter_text.set_cursor_position(-1);
    }

    _onKey(entry, event) {
        const key = event.get_key_symbol();
        if (key !== Clutter.KEY_Return && key !== Clutter.KEY_KP_Enter)
            return Clutter.EVENT_PROPAGATE;
        const state = event.get_state();
        if (state & Clutter.ModifierType.CONTROL_MASK) {
            if (!this.empty && this._reminderValid())
                this.emit('save');
            return Clutter.EVENT_STOP;
        }
        if (entry !== this._text || state & Clutter.ModifierType.SHIFT_MASK)
            return Clutter.EVENT_PROPAGATE;
        // In a list of checkboxes, the next line gets one too. (Over a
        // selection, Enter replaces it as ever.)
        const text = this._text.clutter_text;
        const value = this._text.text;
        const cursor = indexOf(value, text.get_cursor_position());
        const after = cursor === indexOf(value, text.get_selection_bound()) ? continueList(value, cursor) : null;
        if (!after)
            return Clutter.EVENT_PROPAGATE;
        this._text.text = after.text;
        const place = charsTo(after.text, after.position);
        text.set_selection(place, place);
        return Clutter.EVENT_STOP;
    }

    // A checkbox at the line the cursor is on (or off it) – or, with lines
    // selected, on all of them (or off, when they all have one).
    _toggleCheckbox() {
        const text = this._text.clutter_text;
        const value = this._text.text;
        const cursor = indexOf(value, text.get_cursor_position());
        const bound = indexOf(value, text.get_selection_bound());
        const lineAt = index => value.slice(0, index).split('\n').length - 1;
        const [first, last] = [lineAt(Math.min(cursor, bound)), lineAt(Math.max(cursor, bound))];
        const updated = first === last ? toggleLine(value, first) : boxLines(value, first, last);
        this._text.text = updated;
        this._text.grab_key_focus();
        // (At the end of the last line of them.)
        const end = charsTo(updated, updated.split('\n').slice(0, last + 1).join('\n').length);
        text.set_selection(end, end);
    }

    _sync() {
        this._paper.style = paperStyle(this._color);
        const {ink} = COLORS[this._color];
        for (const entry of [this._title, this._text])
            entry.style = `color: ${ink}; caret-color: ${ink}; selected-color: ${ink};`;
        for (const dot of this._colors) {
            if (dot._color === this._color)
                dot.add_style_pseudo_class('checked');
            else
                dot.remove_style_pseudo_class('checked');
        }
        for (const segment of this._pins) {
            if (segment._value === this._pin)
                segment.add_style_pseudo_class('checked');
            else
                segment.remove_style_pseudo_class('checked');
        }
        // The reminder: its day, and whether its time is one to come.
        this._remindButton.visible = !this._reminding;
        this._reminder.visible = this._reminding;
        if (this._reminding) {
            this._day.text = dayText(this._days, reminderAt(this._days, 12, 0, new Date()));
            this._earlier.reactive = this._days > 0;
            if (this._reminderValid())
                this._time.remove_style_pseudo_class('error');
            else
                this._time.add_style_pseudo_class('error');
        }
        this._save.reactive = !this.empty && this._reminderValid();
    }
});
