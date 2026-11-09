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
 * @returns {string} how long ago, shortly: "now", "5 min", "2 h", "3 d"
 *   (from the API, a message may have come days ago)
 */
export function ago(time, now) {
    const minutes = Math.floor(Math.max(0, now - time) / 60000);
    if (minutes < 1)
        return 'now';
    if (minutes < 60)
        return `${minutes} min`;
    return minutes < 24 * 60 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / (24 * 60))} d`;
}

// Slack's Web API, with the user's own token (Settings → Desktop → Slack):
// who wrote while the computer was off or asleep, which no notification
// tells. Of the answers, only who wrote, how many and when are kept – what
// a message says is only looked at for whether it mentions you.

/** How often Slack is asked, and at most how often it is asked again (seconds). */
export const ROUND = 180;
export const SOONEST = 60;
/** The longest wait after failures (seconds). */
export const LONGEST = 1800;

/**
 * @param {string} token
 * @returns {boolean} whether it can be a user token (a bot token has no
 *   unread messages of its own)
 */
export function validToken(token) {
    return /^xoxp-[A-Za-z0-9-]{10,}$/.test(token ?? '');
}

/**
 * What a failed answer means for asking again.
 *
 * @param {string} error - Slack's "error" of an answer with ok false
 * @returns {string} 'invalid' or 'missing-scope' (stop asking: asking again
 *   would not help), 'rate-limited' or 'error'
 */
export function statusOf(error) {
    if (['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive',
        'not_allowed_token_type'].includes(error))
        return 'invalid';
    if (error === 'missing_scope')
        return 'missing-scope';
    return error === 'ratelimited' ? 'rate-limited' : 'error';
}

/**
 * @param {string} status - of the last round: 'ok', 'offline', 'rate-limited', 'error'...
 * @param {number} failures - rounds failed in a row, this one too
 * @param {number|null} retryAfter - Slack's Retry-After, in seconds
 * @returns {number|null} seconds until the next round, or null for none
 */
export function nextDelay(status, failures, retryAfter = null) {
    if (status === 'ok')
        return ROUND;
    if (status === 'invalid' || status === 'missing-scope')
        return null;
    if (status === 'rate-limited')
        return Math.min(LONGEST, Math.max(SOONEST, retryAfter ?? 0));
    return Math.min(LONGEST, SOONEST * 2 ** Math.max(0, failures - 1));
}

/** @param {string|undefined} ts - Slack's "1712345678.123456" @returns {number} in milliseconds, or 0 */
export function timeOf(ts) {
    const seconds = Number.parseFloat(ts ?? '');
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/**
 * Which conversations to look into this round, at most `limit`: those
 * unread at the last look first, then those Slack ranks highest (its
 * "priority", of who you talk to most), then the rest in turn from
 * `offset` – over a few rounds, all of them.
 *
 * @param {object[]} conversations - [{id, priority?}] from conversations.list
 * @param {Set<string>} unread - the ids unread at the last look
 * @param {number} offset - where the turn got to
 * @param {number} limit
 * @param {number} [top] - how many of the highest ranked, each round
 * @returns {object} {ids, offset}: which, and where the turn gets to
 */
export function pickConversations(conversations, unread, offset, limit, top = Math.floor(limit / 2)) {
    const ids = [];
    const add = id => {
        if (ids.length < limit && !ids.includes(id))
            ids.push(id);
    };
    conversations.filter(c => unread.has(c.id)).forEach(c => add(c.id));
    [...conversations].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
        .slice(0, top).forEach(c => add(c.id));
    const count = conversations.length;
    let next = count ? offset % count : 0;
    for (let i = 0; i < count && ids.length < limit; i++) {
        add(conversations[next].id);
        next = (next + 1) % count;
    }
    return {ids, offset: next};
}

// Messages that are someone writing, not someone joining or a topic
// changing.
const WRITTEN = new Set([undefined, 'file_share', 'thread_broadcast', 'me_message']);

/**
 * @param {string} text - a message's, only looked at here
 * @param {string} me - the user's id
 * @returns {boolean} whether it mentions the user (<@U123>, or <@U123|name>)
 */
export function mentions(text, me) {
    return Boolean(me) && typeof text === 'string' && (text.includes(`<@${me}>`) || text.includes(`<@${me}|`));
}

/**
 * Who wrote the messages, and how many – not what they said.
 *
 * @param {object[]} messages - of conversations.history
 * @param {string} me - the user's id: not counted
 * @param {boolean} [mentioned] - only those that mention the user
 * @returns {object[]} [{user, count, time}], time the latest one's, in ms
 */
export function writersOf(messages, me, mentioned = false) {
    const writers = new Map();
    for (const message of messages ?? []) {
        if (!message?.user || message.user === me || !WRITTEN.has(message.subtype))
            continue;
        if (mentioned && !mentions(message.text, me))
            continue;
        const time = timeOf(message.ts);
        const earlier = writers.get(message.user);
        writers.set(message.user, {
            user: message.user,
            count: (earlier?.count ?? 0) + 1,
            time: Math.max(earlier?.time ?? 0, time),
        });
    }
    return [...writers.values()];
}

/**
 * A conversation's unread, from conversations.info: for a user's token it
 * says how many in a direct message, and when the latest one came.
 *
 * @param {object} channel - conversations.info's
 * @param {string} me - the user's id
 * @returns {object} {unread, writers}: whether something is unread, and
 *   who wrote it when that is known without the history ([{user, count,
 *   time}]), else null
 */
export function unreadOf(channel, me) {
    const lastRead = timeOf(channel?.last_read);
    const latest = channel?.latest;
    const latestTime = timeOf(latest?.ts);
    const count = channel?.unread_count_display ?? channel?.unread_count;
    if (typeof count === 'number') {
        if (count <= 0)
            return {unread: false, writers: []};
        // Just the two of you: they wrote them.
        if (channel.is_im && channel.user && channel.user !== me)
            return {unread: true, writers: [{user: channel.user, count, time: latestTime || Date.now()}]};
        return {unread: true, writers: null};
    }
    if (latest && (latestTime <= lastRead || latest.user === me))
        return {unread: false, writers: []};
    return {unread: true, writers: null};
}

/**
 * @param {object} user - users.info's
 * @returns {object} {name, aliases}: the name Slack shows, and all it goes
 *   by (a notification may show another)
 */
export function nameOf(user) {
    const profile = user?.profile ?? {};
    const aliases = [profile.display_name, profile.real_name, user?.real_name, user?.name]
        .map(name => (name ?? '').trim()).filter(Boolean);
    return {name: aliases[0] ?? 'Someone', aliases: [...new Set(aliases)]};
}

/**
 * The writers of all the conversations unread, each once, the latest first.
 *
 * @param {Iterable<object[]>} found - each conversation's [{user, count, time}]
 * @returns {object[]} [{user, count, time}]
 */
export function combineWriters(found) {
    const writers = new Map();
    for (const list of found) {
        for (const writer of list) {
            const earlier = writers.get(writer.user);
            writers.set(writer.user, {
                user: writer.user,
                count: (earlier?.count ?? 0) + writer.count,
                time: Math.max(earlier?.time ?? 0, writer.time),
            });
        }
    }
    return [...writers.values()].sort((a, b) => b.time - a.time);
}

/**
 * Who wrote, as the API said, with those whose notifications came since
 * it was asked (each once, by any of their names).
 *
 * @param {object[]} api - [{name, count, time, aliases?}]
 * @param {object[]} notified - [{name, count, time}], from notifications
 * @param {number} since - when the API was asked, ms
 * @returns {object[]} [{name, count, time}], the latest first, at most SENDERS
 */
export function mergeSenders(api, notified, since) {
    const same = name => sender => [sender.name, ...sender.aliases ?? []]
        .some(alias => alias.toLowerCase() === name.toLowerCase());
    const merged = api.map(({name, count, time, aliases}) => ({name, count, time, aliases}));
    for (const sender of notified) {
        if (sender.time <= since)
            continue;
        const known = merged.find(same(sender.name));
        if (known) {
            known.count += sender.count;
            known.time = Math.max(known.time, sender.time);
        } else {
            merged.push({...sender});
        }
    }
    return merged.sort((a, b) => b.time - a.time).slice(0, SENDERS)
        .map(({name, count, time}) => ({name, count, time}));
}
