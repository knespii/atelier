import {RULES, collides, keep, parseState, release, wanted} from '../lib/otherExtensions.js';
import {assert, assertEqual} from './util.js';

const rule = id => RULES.find(r => r.id === id);
const lockBlur = rule('blur-my-shell-lock-screen');
const banners = rule('just-perfection-banners');

export function testRules() {
    const ids = RULES.map(r => r.id);
    assert(new Set(ids).size === ids.length, 'each rule has its own id');
    for (const r of RULES) {
        assert(r.uuid && r.schema && r.key && r.title && r.why && r.loses, `${r.id} says what and why`);
        assert(r.kind === 'keep' ? r.value !== undefined : typeof r.fix === 'function', `${r.id} knows what to do`);
    }
}

export function testKeep() {
    // Turned on: the key goes to Atelier's value, and what was there is kept.
    assertEqual(keep(lockBlur, true), {write: false, entry: {previous: true, set: false}, overridden: false});
    // Already so: nothing written, nothing to put back.
    assertEqual(keep(lockBlur, false), {write: undefined, entry: {previous: null, set: false}, overridden: false});
    // Checked again, as Atelier left it: nothing.
    const entry = {previous: true, set: false};
    assertEqual(keep(lockBlur, false, entry), {write: undefined, entry, overridden: false});
    // Changed by the user since: theirs, and Atelier stops keeping it.
    assertEqual(keep(lockBlur, true, entry), {write: undefined, entry: null, overridden: true});
    // Turned on again after that: kept anew.
    assertEqual(keep(lockBlur, true, {overridden: true}).write, false, 'kept anew once turned on again');
}

export function testGuard() {
    assert(!collides(banners, 1) && collides(banners, 4), 'banners collide at the bottom only');
    assertEqual(wanted(banners, 5), 2, 'bottom right goes top right');
    assertEqual(keep(banners, 1), {write: undefined, entry: {previous: null, set: 1}, overridden: false});
    const stepped = keep(banners, 3);
    assertEqual(stepped, {write: 0, entry: {previous: 3, set: 0}, overridden: false}, 'it steps in at the bottom');
    // The user moves them down again later: it steps in again (a guard is
    // never taken back by the value it guards against).
    assertEqual(keep(banners, 4, stepped.entry), {write: 1, entry: {previous: 4, set: 1}, overridden: false});
    assert(!keep(banners, 2, stepped.entry).overridden, 'another place at the top is fine');
}

export function testRelease() {
    assertEqual(release({previous: true, set: false}, false), true, 'what was there comes back');
    assertEqual(release({previous: true, set: false}, true), undefined, 'not over a change since');
    assertEqual(release({previous: null, set: false}, false), undefined, 'nothing to put back');
    assertEqual(release(null, false), undefined);
}

export function testParseState() {
    assertEqual(parseState(''), {});
    assertEqual(parseState('nonsense'), {});
    assertEqual(parseState('[1]'), {});
    assertEqual(parseState('{"a": {"previous": true, "set": false}}'), {a: {previous: true, set: false}});
}
