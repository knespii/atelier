// GitHub contributions: GitHub shows anyone's on a public page,
// https://github.com/users/<name>/contributions – no account or token
// needed. This reads the days and their levels (0–4) from that page.

/** @param {string} user @returns {string} the page with the user's contributions */
export const contributionsUrl = user => `https://github.com/users/${encodeURIComponent(user)}/contributions`;

/** @param {string} user @returns {string} the user's profile */
export const profileUrl = user => `https://github.com/${encodeURIComponent(user)}`;

/**
 * @param {string} user
 * @returns {boolean} whether it can be a GitHub user name
 */
export function validUser(user) {
    return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(user);
}

/**
 * @param {string} html - the contributions page
 * @returns {object|null} {total, days: [{date: 'YYYY-MM-DD', level}]} sorted
 *   by date, or null when the page has no calendar
 */
export function parseContributions(html) {
    const days = [];
    for (const [tag] of html.matchAll(/<td\b[^>]*>/g)) {
        const date = /\bdata-date="(\d{4}-\d{2}-\d{2})"/.exec(tag)?.[1];
        const level = /\bdata-level="(\d)"/.exec(tag)?.[1];
        if (date && level !== undefined)
            days.push({date, level: Math.min(4, Number(level))});
    }
    if (days.length === 0)
        return null;
    days.sort((a, b) => a.date.localeCompare(b.date));
    const heading = /id="js-contribution-activity-description"[^>]*>([\s\S]*?)<\/h2>/.exec(html)?.[1] ?? '';
    const total = Number(/([\d,.]+)\s+contributions?/.exec(heading)?.[1]?.replace(/[,.]/g, '') ?? NaN);
    return {total: Number.isFinite(total) ? total : null, days};
}

/**
 * The days by week, for a grid with a column per week: weeks start on
 * Sunday, as on GitHub.
 *
 * @param {object[]} days - from parseContributions, sorted
 * @param {number} count - how many of the latest weeks
 * @returns {Array<Array<number|null>>} weeks, each with 7 levels (null for
 *   days not in the data)
 */
export function lastWeeks(days, count) {
    if (days.length === 0)
        return [];
    const levels = new Map(days.map(day => [day.date, day.level]));
    const [y, m, d] = days.at(-1).date.split('-').map(Number);
    const last = new Date(Date.UTC(y, m - 1, d));
    const firstSunday = new Date(last);
    firstSunday.setUTCDate(last.getUTCDate() - last.getUTCDay() - 7 * (count - 1));
    const weeks = [];
    for (let w = 0; w < count; w++) {
        const week = [];
        for (let i = 0; i < 7; i++) {
            const day = new Date(firstSunday);
            day.setUTCDate(firstSunday.getUTCDate() + w * 7 + i);
            week.push(levels.get(day.toISOString().slice(0, 10)) ?? null);
        }
        weeks.push(week);
    }
    return weeks;
}
