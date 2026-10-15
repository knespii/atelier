import {MessageKind, Phase, initialState, look, reduce} from '../lib/lockState.js';
import {assert, assertEqual} from './util.js';

const walk = (...events) => events.reduce(reduce, initialState());

const password = {type: 'question', secret: true};
const face = {type: 'message', text: 'Attempting face login', kind: MessageKind.INFO, fingerprint: false};
const finger = {type: 'message', text: '(or place finger on reader)', kind: MessageKind.HINT, fingerprint: true};
const wrong = {type: 'message', text: 'Sorry, that didn\'t work. Please try again.', kind: MessageKind.ERROR, fingerprint: false};

export function testPassword() {
    assertEqual(initialState().phase, Phase.LOCKED);
    assertEqual(look(initialState()), {shackle: 'closed', ring: 'none', tone: 'neutral'});
    assertEqual(walk({type: 'prompt'}).phase, Phase.WAITING);
    assertEqual(walk({type: 'prompt'}, password).phase, Phase.READY);
    const checking = walk({type: 'prompt'}, password, {type: 'submit'});
    assertEqual(checking.phase, Phase.CHECKING);
    assertEqual(look(checking).ring, 'spin');
    const done = reduce(checking, {type: 'complete'});
    assertEqual(done.phase, Phase.SUCCESS);
    assertEqual(look(done), {shackle: 'open', ring: 'fill', tone: 'green'});
}

export function testWrongPasswordThenRight() {
    // GNOME says why, fails, starts over and asks again – all at once.
    const failed = walk({type: 'prompt'}, password, {type: 'submit'}, wrong, {type: 'failed'},
        {type: 'reset'}, password);
    assertEqual(failed.phase, Phase.FAILED, 'the failure stays up until it settles');
    assertEqual(look(failed), {shackle: 'closed', ring: 'fill', tone: 'red'});
    assertEqual(failed.message?.text, wrong.text, 'GNOME\'s words are kept for a field to show');
    const again = reduce(failed, {type: 'settle'});
    assertEqual(again.phase, Phase.READY, 'and the password is asked again');
    assertEqual(walk({type: 'prompt'}, {type: 'settle'}).phase, Phase.WAITING, 'settling only follows a failure');
    assertEqual(reduce(failed, {type: 'submit'}).phase, Phase.CHECKING, 'typed again before it settled');
}

export function testFace() {
    const scanning = walk({type: 'prompt'}, face);
    assertEqual(scanning.phase, Phase.SCANNING, 'something said before any question: a face');
    assertEqual(look(scanning).ring, 'spin');
    assertEqual(reduce(scanning, {type: 'complete'}).phase, Phase.SUCCESS, 'recognized');
    // Not recognized: the password is asked after all.
    assertEqual(reduce(scanning, password).phase, Phase.READY);
    // Said after the question, it is just a message.
    assertEqual(walk({type: 'prompt'}, password, face).phase, Phase.READY);
}

export function testFingerprint() {
    const ready = walk({type: 'prompt'}, password, finger);
    assertEqual(ready.phase, Phase.READY, 'the password is still asked');
    assert(ready.finger, 'a reader waits beside it');
    assertEqual(look(ready).ring, 'track');
    assertEqual(walk({type: 'prompt'}, finger).phase, Phase.WAITING, 'a hint is no face');
    const missed = reduce(ready, {type: 'message', text: 'Failed to match fingerprint', kind: MessageKind.ERROR, fingerprint: true});
    assertEqual(missed.phase, Phase.FAILED);
    assertEqual(reduce(missed, {type: 'settle'}).phase, Phase.READY, 'and the password is asked as before');
}

export function testBackToTheClock() {
    for (const type of ['cancelled', 'gone'])
        assertEqual(walk({type: 'prompt'}, password, {type}), initialState(), type);
    assertEqual(walk({type: 'prompt'}, finger, {type: 'prompt'}).finger, false, 'a new prompt starts afresh');
}

export function testSuccessIsFinal() {
    const done = walk({type: 'prompt'}, password, {type: 'submit'}, {type: 'complete'});
    for (const event of [{type: 'gone'}, {type: 'failed'}, wrong, {type: 'reset'}, {type: 'prompt'}])
        assertEqual(reduce(done, event), done, event.type);
}

export function testMessages() {
    const said = walk({type: 'prompt'}, password, {type: 'message', text: 'Caps Lock is on', kind: MessageKind.HINT});
    assertEqual(said.message, {text: 'Caps Lock is on', kind: MessageKind.HINT});
    assertEqual(reduce(said, {type: 'message', text: null, kind: MessageKind.NONE}).message, null, 'cleared');
    assertEqual(reduce(said, {type: 'unknown'}), said, 'other events change nothing');
}
