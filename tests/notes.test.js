import {COLORS, displayTitle, lines, newNote, parseNotes, serializeNotes, sortNotes, toggleLine} from '../lib/notes.js';
import {assert, assertEqual} from './util.js';

export function testNewAndParse() {
    const note = newNote([], {color: 'mint', text: 'hi'});
    assert(note.id.startsWith('note-') && note.color === 'mint' && note.text === 'hi' && !note.archived);
    const parsed = parseNotes(JSON.stringify([
        note,
        {id: note.id, title: 'duplicate'},
        {title: 'no id'},
        {id: 'b', color: 'tartan', pin: 'top', created: 5},
        {id: 'c', pin: 'right'},
    ]));
    assertEqual(parsed.map(n => n.id), [note.id, 'b', 'c'], 'unique ids only');
    assertEqual([parsed[1].color, parsed[1].pin, parsed[1].modified], ['yellow', null, 5], 'cleaned up');
    assertEqual(parsed[2].pin, 'right');
    assertEqual(note.pin, 'left', 'a new note goes on the left edge');
    assertEqual(parseNotes(serializeNotes(parsed)), parsed);
    assertEqual(parseNotes('{'), []);
    assert(Object.keys(COLORS).includes('yellow'));
}

export function testCheckboxes() {
    const text = 'Shopping\n- [ ] milk\n- [x] bread\n  * [X] eggs';
    assertEqual(lines(text).map(l => [l.checkbox, l.checked, l.text]), [
        [false, false, 'Shopping'], [true, false, 'milk'], [true, true, 'bread'], [true, true, 'eggs'],
    ]);
    assertEqual(toggleLine(text, 1).split('\n')[1], '- [x] milk');
    assertEqual(toggleLine(text, 2).split('\n')[2], '- [ ] bread');
    assertEqual(toggleLine(text, 3).split('\n')[3], '  - [ ] eggs', 'indent kept');
    assertEqual(toggleLine(text, 0).split('\n')[0], '- [ ] Shopping', 'a plain line becomes a checkbox');
    assertEqual(toggleLine(text, 9), text);
}

export function testTitlesAndOrder() {
    assertEqual(displayTitle({title: '  Ideas ', text: 'x'}), 'Ideas');
    assertEqual(displayTitle({title: '', text: '\n- [ ] call mum\nmore'}), 'call mum');
    assertEqual(displayTitle({title: '', text: ''}), 'Empty note');
    assertEqual(sortNotes([{id: 'a', modified: 1}, {id: 'b', modified: 3}]).map(n => n.id), ['b', 'a']);
}
