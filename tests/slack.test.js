import {SENDERS, addMessage, ago, isSlack, senderOf} from '../lib/slack.js';
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
}
