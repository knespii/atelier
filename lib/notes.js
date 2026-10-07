// Notes: little papers with a title and some text, whose lines may be
// checkboxes ("- [ ] milk", "- [x] bread"), pinned to an edge of the screen
// (pin: which, the left one for a new note). They are kept in
// ~/.local/share/atelier/notes.json, whatever the profile. Pure functions,
// shared by the shell and the tests.

/** Paper colors: the paper and the ink on it. */
export const COLORS = {
    yellow: {name: 'Yellow', paper: '#fdf1b0', ink: '#3b3420'},
    peach: {name: 'Peach', paper: '#fbd8c2', ink: '#3d2a1f'},
    pink: {name: 'Pink', paper: '#f7cddd', ink: '#3d2230'},
    lilac: {name: 'Lilac', paper: '#e2d6f6', ink: '#2e2640'},
    blue: {name: 'Blue', paper: '#cde1f7', ink: '#1f2c3d'},
    mint: {name: 'Mint', paper: '#d1efda', ink: '#1f3326'},
    paper: {name: 'Paper', paper: '#f6f1e7', ink: '#2a251f'},
};

const CHECKBOX = /^(\s*)[-*] \[( |x|X)\] ?(.*)$/;

/**
 * @param {object[]} notes - those there are
 * @param {object} [fields] - e.g. {color, text}
 * @returns {object} a new, empty note
 */
export function newNote(notes, fields = {}) {
    const ids = new Set(notes.map(note => note.id));
    let id;
    do
        id = `note-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    while (ids.has(id));
    const now = Date.now();
    // New notes go on the left edge of the screen.
    return {id, title: '', text: '', color: 'yellow', created: now, modified: now, archived: false, pin: 'left', ...fields};
}

/**
 * @param {string} json - as kept
 * @returns {object[]} the notes, cleaned up: known colors, sides and fields
 */
export function parseNotes(json) {
    let list;
    try {
        list = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(list))
        return [];
    const ids = new Set();
    return list
        .filter(note => typeof note?.id === 'string' && !ids.has(note.id) && ids.add(note.id))
        .map(note => ({
            id: note.id,
            title: typeof note.title === 'string' ? note.title : '',
            text: typeof note.text === 'string' ? note.text : '',
            color: COLORS[note.color] ? note.color : 'yellow',
            created: Number(note.created) || 0,
            modified: Number(note.modified) || Number(note.created) || 0,
            archived: Boolean(note.archived),
            pin: ['left', 'right'].includes(note.pin) ? note.pin : null,
        }));
}

/**
 * @param {object[]} notes
 * @returns {string}
 */
export function serializeNotes(notes) {
    return JSON.stringify(notes, null, 1);
}

/**
 * @param {string} text
 * @returns {object[]} its lines: {text, checkbox, checked}
 */
export function lines(text) {
    return text.split('\n').map(line => {
        const match = CHECKBOX.exec(line);
        return match
            ? {text: match[3], checkbox: true, checked: match[2] !== ' '}
            : {text: line, checkbox: false, checked: false};
    });
}

/**
 * @param {string} text
 * @param {number} index - of a line
 * @returns {string} the text with that line's checkbox ticked or unticked
 *   (a line without one gets one)
 */
export function toggleLine(text, index) {
    const all = text.split('\n');
    const line = all[index];
    if (line === undefined)
        return text;
    const match = CHECKBOX.exec(line);
    all[index] = match
        ? `${match[1]}- [${match[2] === ' ' ? 'x' : ' '}] ${match[3]}`
        : `- [ ] ${line}`;
    return all.join('\n');
}

/**
 * Enter in a list of checkboxes: on a line with one, the new line gets one
 * too (unticked, indented as it is); on a line with nothing after its box,
 * the box goes instead – which ends the list.
 *
 * @param {string} text
 * @param {number} position - where Enter is pressed (an index in the text)
 * @returns {object|null} {text, position} after Enter; null on a line
 *   without a checkbox (or before its box), where Enter is a line break
 */
export function continueList(text, position) {
    const start = position > 0 ? text.lastIndexOf('\n', position - 1) + 1 : 0;
    const next = text.indexOf('\n', position);
    const end = next < 0 ? text.length : next;
    const line = text.slice(start, end);
    const match = CHECKBOX.exec(line);
    if (!match || position < end - match[3].length)
        return null;
    if (!match[3].trim())
        return {text: text.slice(0, start) + text.slice(end), position: start};
    const box = `\n${match[1]}${line[match[1].length]} [ ] `;
    return {text: text.slice(0, position) + box + text.slice(position), position: position + box.length};
}

/**
 * @param {string} text
 * @param {number} first - index of a line
 * @param {number} last - index of a line, the same one or one after it
 * @returns {string} the text with checkboxes on those lines – or, when they
 *   all have one already, without; empty lines stay as they are
 */
export function boxLines(text, first, last) {
    const all = text.split('\n');
    const chosen = [];
    for (let i = Math.max(0, first); i <= Math.min(last, all.length - 1); i++) {
        if (all[i].trim())
            chosen.push(i);
    }
    const boxed = chosen.every(i => CHECKBOX.test(all[i]));
    for (const i of chosen) {
        const match = CHECKBOX.exec(all[i]);
        const indent = /^\s*/.exec(all[i])[0];
        if (boxed)
            all[i] = `${match[1]}${match[3]}`;
        else if (!match)
            all[i] = `${indent}- [ ] ${all[i].slice(indent.length)}`;
    }
    return all.join('\n');
}

/**
 * @param {object} note
 * @returns {string} its title, or its first words when it has none
 */
export function displayTitle(note) {
    if (note.title.trim())
        return note.title.trim();
    const first = lines(note.text).find(line => line.text.trim());
    return first ? first.text.trim() : 'Empty note';
}

/**
 * @param {object[]} notes
 * @returns {object[]} the latest changed first
 */
export function sortNotes(notes) {
    return [...notes].sort((a, b) => b.modified - a.modified);
}
