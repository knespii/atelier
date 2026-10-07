// Slack, as its notifications show it: who writes, and how often since
// Slack was last looked at. What a message says is never kept – only the
// headline of its notification (a person, or a channel). Pure functions,
// shared by the shell and the tests.

/** How many of those who wrote are kept, the latest first. */
export const SENDERS = 3;

const SLACK = /slack/i;

/**
 * @param {string|null} appId - e.g. "slack_slack.desktop" (the snap)
 * @param {string|null} name - an app's or a notification source's name
 * @returns {boolean} whether it is Slack: the app, or Slack in a browser
 */
export function isSlack(appId, name) {
    return SLACK.test(appId ?? '') || SLACK.test(name ?? '');
}

/**
 * @param {string} title - of a notification
 * @param {string} body - its text, only read for a name before a colon
 *   when the title is just "Slack"
 * @returns {string} who (or where) it is from, e.g. "Alice" or "#design"
 */
export function senderOf(title, body) {
    const headline = (title ?? '').trim();
    if (headline && !/^slack$/i.test(headline))
        return headline;
    // "Alice: the message" – the name only.
    const [, name] = /^([^:\n]{1,40}):/.exec(body ?? '') ?? [];
    return name?.trim() || 'Slack';
}

/**
 * @param {object[]} senders - [{name, count, time}], the latest first
 * @param {string} name - who wrote now
 * @param {number} time - when, in milliseconds
 * @returns {object[]} the senders with this message, the latest first, at
 *   most SENDERS of them
 */
export function addMessage(senders, name, time) {
    const earlier = senders.find(sender => sender.name === name);
    return [
        {name, count: (earlier?.count ?? 0) + 1, time},
        ...senders.filter(sender => sender !== earlier),
    ].slice(0, SENDERS);
}

/**
 * @param {number} time - in milliseconds
 * @param {number} now - in milliseconds
 * @returns {string} how long ago, shortly: "now", "5 min", "2 h"
 */
export function ago(time, now) {
    const minutes = Math.floor(Math.max(0, now - time) / 60000);
    if (minutes < 1)
        return 'now';
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}
