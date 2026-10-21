// What the padlock on the lock screen shows, from what GNOME's unlock
// dialog reports while it checks who is there. GNOME does the checking;
// this only follows it, the same way for a password, a face (a PAM module
// such as Howdy says something before any question) and a fingerprint
// (GNOME's own fprintd service, beside the password).
//
// Pure, so the tests can walk through all of it.

export const Phase = {
    LOCKED: 'locked', // the clock, no prompt
    WAITING: 'waiting', // the prompt is up, the check is starting
    READY: 'ready', // a question (the password) is asked
    CHECKING: 'checking', // an answer is being checked
    SCANNING: 'scanning', // a face is being looked for
    FAILED: 'failed', // for a moment, after a wrong answer, face or finger
    SUCCESS: 'success', // unlocked: nothing changes it any more
};

/** GNOME's message types (MessageType in gdm/util.js). */
export const MessageKind = {NONE: 0, HINT: 1, INFO: 2, ERROR: 3};

/** @returns {object} the state of a lock screen showing its clock */
export function initialState() {
    return {phase: Phase.LOCKED, asked: false, finger: false, message: null};
}

/**
 * @param {object} state
 * @param {object} event - one of: {type: 'prompt'} (the prompt came up),
 *   {type: 'question', secret}, {type: 'message', text, kind, fingerprint},
 *   {type: 'submit'} (an answer went off), {type: 'failed'},
 *   {type: 'complete'}, {type: 'reset'} (the check starts over),
 *   {type: 'cancelled'}, {type: 'gone'} (the prompt went away) and
 *   {type: 'settle'} (a failure has been shown long enough)
 * @returns {object} the next state; the given one is left as it is
 */
export function reduce(state, event) {
    if (state.phase === Phase.SUCCESS)
        return state;
    const failed = state.phase === Phase.FAILED;
    switch (event.type) {
    case 'prompt':
        return {phase: Phase.WAITING, asked: false, finger: false, message: null};
    case 'question':
        // (A failure stays up until it settles, as GNOME asks again at once.)
        return {...state, phase: failed ? Phase.FAILED : Phase.READY, asked: true};
    case 'message':
        return withMessage(state, event);
    case 'submit':
        return {...state, phase: Phase.CHECKING};
    case 'failed':
        return {...state, phase: Phase.FAILED};
    case 'complete':
        return {...state, phase: Phase.SUCCESS, message: null};
    case 'reset':
        return {...state, phase: failed ? Phase.FAILED : Phase.WAITING, asked: false};
    case 'cancelled':
    case 'gone':
        return initialState();
    case 'settle':
        if (!failed)
            return state;
        return {...state, phase: state.asked ? Phase.READY : Phase.WAITING};
    default:
        return state;
    }
}

function withMessage(state, {text, kind, fingerprint}) {
    if (!text || kind === MessageKind.NONE)
        return {...state, message: null};
    const next = {...state, message: {text, kind}};
    if (fingerprint)
        next.finger = true;
    if (kind === MessageKind.ERROR)
        return {...next, phase: Phase.FAILED};
    // Something the password's service says before asking anything: a
    // face being looked for (whatever the language it says it in).
    if (!fingerprint && kind === MessageKind.INFO && !state.asked &&
        (state.phase === Phase.WAITING || state.phase === Phase.SCANNING))
        return {...next, phase: Phase.SCANNING};
    return next;
}

/**
 * @param {object} state
 * @returns {object} how the padlock looks: shackle 'closed' or 'open'; ring
 *   'none', 'track' (waiting for a finger), 'spin' (from the moment the
 *   prompt is up – asking, then checking) or 'fill';
 *   tone 'neutral', 'green' or 'red'
 */
export function look(state) {
    switch (state.phase) {
    case Phase.SUCCESS:
        return {shackle: 'open', ring: 'fill', tone: 'green'};
    case Phase.FAILED:
        return {shackle: 'closed', ring: 'fill', tone: 'red'};
    case Phase.CHECKING:
    case Phase.SCANNING:
        return {shackle: 'closed', ring: 'spin', tone: 'neutral'};
    case Phase.WAITING:
    case Phase.READY:
        return {shackle: 'closed', ring: state.finger ? 'track' : 'spin', tone: 'neutral'};
    default:
        return {shackle: 'closed', ring: 'none', tone: 'neutral'};
    }
}
