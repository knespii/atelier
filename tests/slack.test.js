import {
    LONGEST, ROUND, SENDERS, SOONEST, addMessage, ago, combineWriters, isSlack, mentions, mergeSenders, nameOf,
    nextDelay, pickConversations, senderOf, statusOf, timeOf, unreadOf, validToken, writersOf,
} from '../lib/slack.js';
import {assert, assertEqual} from './util.js';

export function testWhatIsSlack() {
    assert(isSlack('slack_slack.desktop', 'Slack'), 'the snap');
    assert(isSlack('com.slack.Slack.desktop', null), 'the flatpak');
    assert(isSlack('chrome-abc-Default', 'Slack'), 'in a browser, by its name');
    assert(!isSlack('org.gnome.Calendar.desktop', 'Calendar'));
    assert(!isSlack(null, null));
}

export function testWhoWrote() {
    assertEqual(senderOf('Alice Smith', 'see you at 5'), 'Alice Smith');
    assertEqual(senderOf('#design', 'Bob: new mockups'), '#design', 'a channel');
    assertEqual(senderOf('Slack', 'Bob: new mockups'), 'Bob', 'only the name before the colon');
    assertEqual(senderOf('Slack', 'You have a new message'), 'Slack', 'never what it says');
    assertEqual(senderOf('', ''), 'Slack');
}

export function testLatestFirst() {
    let senders = addMessage([], 'Alice', 1000);
    senders = addMessage(senders, 'Bob', 2000);
    senders = addMessage(senders, 'Alice', 3000);
    assertEqual(senders, [{name: 'Alice', count: 2, time: 3000}, {name: 'Bob', count: 1, time: 2000}]);
    for (const [i, name] of ['Cecil', 'Dana', 'Eve'].entries())
        senders = addMessage(senders, name, 4000 + i);
    assertEqual(senders.map(sender => sender.name), ['Eve', 'Dana', 'Cecil'], `at most ${SENDERS}`);
}

export function testHowLongAgo() {
    const now = 10 * 3600 * 1000;
    assertEqual(ago(now - 20 * 1000, now), 'now');
    assertEqual(ago(now - 5 * 60 * 1000, now), '5 min');
    assertEqual(ago(now - 125 * 60 * 1000, now), '2 h');
    assertEqual(ago(now + 5000, now), 'now', 'a clock gone back');
    assertEqual(ago(now - 50 * 3600 * 1000, now), '2 d', 'from the API, days ago');
}

// Slack's Web API.

export function testWhatTokenIsAUsers() {
    assert(validToken('xoxp-1234567890-1234567890-abcdef'), 'a user token');
    assert(!validToken('xoxb-1234567890-abcdef'), 'a bot token has no unread of its own');
    assert(!validToken(''));
    assert(!validToken('xoxp-1 2'));
    assert(!validToken(null));
}

export function testWhatFailuresMean() {
    assertEqual(statusOf('invalid_auth'), 'invalid');
    assertEqual(statusOf('token_revoked'), 'invalid');
    assertEqual(statusOf('missing_scope'), 'missing-scope');
    assertEqual(statusOf('ratelimited'), 'rate-limited');
    assertEqual(statusOf('channel_not_found'), 'error');
}

export function testAskingAgain() {
    assertEqual(nextDelay('ok', 0), ROUND, 'every three minutes');
    assertEqual(nextDelay('invalid', 1), null, 'a refused token: never again');
    assertEqual(nextDelay('missing-scope', 1), null);
    assertEqual(nextDelay('rate-limited', 1, 300), 300, 'Retry-After is honoured');
    assertEqual(nextDelay('rate-limited', 1, 2), SOONEST, 'but not sooner than a minute');
    assertEqual(nextDelay('rate-limited', 1, null), SOONEST);
    assertEqual([1, 2, 3].map(failures => nextDelay('offline', failures)), [60, 120, 240], 'offline: each time longer');
    assertEqual(nextDelay('error', 20), LONGEST, 'up to half an hour');
}

export function testSlackTimes() {
    assertEqual(timeOf('1712345678.123456'), 1712345678123);
    assertEqual(timeOf(undefined), 0);
    assertEqual(timeOf('0000000000.000000'), 0);
}

export function testWhichConversations() {
    const list = ['A', 'B', 'C', 'D', 'E', 'F'].map((id, i) => ({id, priority: id === 'E' ? 1 : i / 100}));
    let {ids, offset} = pickConversations(list, new Set(['F']), 0, 4, 1);
    assertEqual(ids, ['F', 'E', 'A', 'B'], 'unread before first, then the highest ranked, then in turn');
    ({ids, offset} = pickConversations(list, new Set(), offset, 4, 1));
    assertEqual(ids, ['E', 'C', 'D', 'F'], 'the turn goes on where it got to');
    assertEqual(pickConversations([], new Set(['X']), 3, 4), {ids: [], offset: 0}, 'none');
    assertEqual(pickConversations(list, new Set(), 0, 20).ids.length, 6, 'each once');
}

export function testMentionsWithoutKeepingText() {
    assert(mentions('hey <@U1> look', 'U1'));
    assert(mentions('hey <@U1|viktor>', 'U1'), 'the older form');
    assert(!mentions('hey <@U12>', 'U1'), 'someone else');
    assert(!mentions('U1', 'U1'));
    assert(!mentions(undefined, 'U1'));
    const messages = [
        {user: 'U2', ts: '100.000100', text: 'secret plans <@U1>'},
        {user: 'U2', ts: '90.000000', text: 'more secret'},
        {user: 'U3', ts: '95.000000', text: '<@U1> lunch?'},
        {user: 'U1', ts: '96.000000', text: 'my own <@U1>'},
        {user: 'U4', ts: '97.000000', subtype: 'channel_join', text: '<@U1> joined'},
        {bot_id: 'B1', ts: '98.000000', text: '<@U1>'},
    ];
    const all = writersOf(messages, 'U1');
    assertEqual(all, [{user: 'U2', count: 2, time: 100000}, {user: 'U3', count: 1, time: 95000}],
        'who wrote and how many, not you, not someone joining');
    const mentioned = writersOf(messages, 'U1', true);
    assertEqual(mentioned, [{user: 'U2', count: 1, time: 100000}, {user: 'U3', count: 1, time: 95000}], 'only mentions');
    assert(!JSON.stringify([all, mentioned]).includes('secret') && !JSON.stringify(mentioned).includes('lunch'),
        'nothing of what they say');
}

export function testUnreadOfAConversation() {
    const im = {id: 'D1', is_im: true, user: 'U2', last_read: '100.0', latest: {user: 'U2', ts: '200.5', text: 'hi'},
        unread_count: 3, unread_count_display: 2};
    assertEqual(unreadOf(im, 'U1'), {unread: true, writers: [{user: 'U2', count: 2, time: 200500}]},
        'a direct message: who, from the conversation');
    assertEqual(unreadOf({...im, unread_count_display: 0}, 'U1'), {unread: false, writers: []}, 'all read');
    assertEqual(unreadOf({...im, is_im: false, is_mpim: true}, 'U1'), {unread: true, writers: null},
        'a few people together: the history says who');
    const channel = {id: 'C1', last_read: '300.0', latest: {user: 'U2', ts: '250.0'}};
    assertEqual(unreadOf(channel, 'U1'), {unread: false, writers: []}, 'no count: the latest is older');
    assertEqual(unreadOf({...channel, latest: {user: 'U1', ts: '350.0'}}, 'U1'), {unread: false, writers: []},
        'you wrote the latest');
    assertEqual(unreadOf({...channel, latest: {user: 'U2', ts: '350.0'}}, 'U1'), {unread: true, writers: null});
    assertEqual(unreadOf({id: 'C2', last_read: '1.0'}, 'U1'), {unread: true, writers: null}, 'nothing said: look');
}

export function testNames() {
    assertEqual(nameOf({name: 'alice', real_name: 'Alice Smith', profile: {display_name: 'ali', real_name: 'Alice Smith'}}),
        {name: 'ali', aliases: ['ali', 'Alice Smith', 'alice']});
    assertEqual(nameOf({name: 'bob', profile: {display_name: ''}}), {name: 'bob', aliases: ['bob']});
    assertEqual(nameOf(null), {name: 'Someone', aliases: []});
}

export function testWritersTogether() {
    const found = [[{user: 'U2', count: 2, time: 100}], [{user: 'U3', count: 1, time: 300}, {user: 'U2', count: 1, time: 50}]];
    assertEqual(combineWriters(found), [{user: 'U3', count: 1, time: 300}, {user: 'U2', count: 3, time: 100}]);
}

export function testMergingWithNotifications() {
    const api = [{name: 'ali', aliases: ['ali', 'Alice Smith'], count: 2, time: 1000},
        {name: 'bob', aliases: ['bob'], count: 1, time: 500}];
    const notified = [{name: 'Alice Smith', count: 1, time: 3000}, {name: '#design', count: 1, time: 2500},
        {name: 'Cecil', count: 4, time: 100}];
    assertEqual(mergeSenders(api, notified, 2000), [
        {name: 'ali', count: 3, time: 3000},
        {name: '#design', count: 1, time: 2500},
        {name: 'bob', count: 1, time: 500},
    ], 'once each, by any of their names; those notified before the API was asked, it knows of (or were read)');
    assertEqual(mergeSenders([], notified, 0).length, SENDERS, `at most ${SENDERS}`);
    assert(!('aliases' in mergeSenders(api, [], 0)[0]), 'only name, count and time');
}
