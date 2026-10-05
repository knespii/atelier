// Claude Code's usage on this computer, from its transcripts
// (~/.claude/projects/**/*.jsonl): tokens and messages in the current 5-hour
// block, today and over the last week. Only timestamps, token counts and
// session ids are read; nothing leaves the computer and no account is asked.
// Pure functions, shared by the worker process and the tests.

export const BLOCK_HOURS = 5;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
/** How far back records are kept: a week plus a block. */
export const KEEP = 8 * DAY;

/**
 * @typedef {object} UsageRecord
 * @property {string} key - message id and request id: streamed parts repeat them
 * @property {number} time - ms since the epoch
 * @property {string} session
 * @property {number} input
 * @property {number} output
 * @property {number} cacheWrite
 * @property {number} cacheRead
 */

/**
 * The usage in one transcript line, if it has any.
 *
 * @param {string} line
 * @returns {UsageRecord|null}
 */
export function parseLine(line) {
    // Most lines carry no usage; skip them without parsing.
    if (!line.includes('"usage"'))
        return null;
    let entry;
    try {
        entry = JSON.parse(line);
    } catch {
        return null;
    }
    const message = entry?.message;
    const usage = message?.usage;
    if (entry?.type !== 'assistant' || !usage || typeof usage !== 'object')
        return null;
    const time = Date.parse(entry.timestamp);
    if (!Number.isFinite(time))
        return null;
    const count = value => (Number.isFinite(value) && value > 0 ? value : 0);
    return {
        key: `${message.id ?? ''}:${entry.requestId ?? entry.uuid ?? ''}`,
        time,
        session: String(entry.sessionId ?? ''),
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
    };
}

/**
 * Add records to a map by key; a repeated message keeps its largest counts.
 *
 * @param {Map<string, UsageRecord>} map
 * @param {UsageRecord[]} records
 */
export function mergeRecords(map, records) {
    for (const record of records) {
        const known = map.get(record.key);
        if (!known) {
            map.set(record.key, record);
            continue;
        }
        for (const field of ['input', 'output', 'cacheWrite', 'cacheRead'])
            known[field] = Math.max(known[field], record[field]);
        known.time = Math.min(known.time, record.time);
    }
}

function emptyTotals() {
    return {input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0};
}

function add(totals, record) {
    totals.input += record.input;
    totals.output += record.output;
    totals.cacheWrite += record.cacheWrite;
    totals.cacheRead += record.cacheRead;
    totals.messages++;
}

/**
 * @param {object} totals
 * @returns {number} all tokens
 */
export function totalTokens(totals) {
    return totals.input + totals.output + totals.cacheWrite + totals.cacheRead;
}

/**
 * Split records into 5-hour blocks as Claude's limits count them: a block
 * starts at the full hour of the first message after the previous block
 * ended, and lasts five hours.
 *
 * @param {UsageRecord[]} records
 * @returns {{start: number, end: number, totals: object}[]} oldest first
 */
export function blocks(records) {
    const sorted = [...records].sort((a, b) => a.time - b.time);
    const result = [];
    let current = null;
    for (const record of sorted) {
        if (!current || record.time >= current.end) {
            const start = Math.floor(record.time / HOUR) * HOUR;
            current = {start, end: start + BLOCK_HOURS * HOUR, totals: emptyTotals()};
            result.push(current);
        }
        add(current.totals, record);
    }
    return result;
}

/**
 * @param {number} time - ms since the epoch
 * @returns {number} local midnight before it
 */
function startOfDay(time) {
    const date = new Date(time);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * What the island and the bar show.
 *
 * @param {UsageRecord[]} records
 * @param {number} now - ms since the epoch
 * @returns {object} the summary
 */
export function summarize(records, now) {
    const recent = records.filter(r => r.time <= now && r.time > now - KEEP);
    const last = blocks(recent).at(-1);
    const block = last && now < last.end ? last : null;

    const today = emptyTotals();
    const week = emptyTotals();
    const todayStart = startOfDay(now);
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const date = new Date(todayStart);
        date.setDate(date.getDate() - i);
        days.push({start: date.getTime(), totals: emptyTotals()});
    }
    const weekStart = days[0].start;
    for (const record of recent) {
        if (record.time >= todayStart)
            add(today, record);
        if (record.time >= weekStart) {
            add(week, record);
            const day = days.findLast(d => record.time >= d.start);
            add(day.totals, record);
        }
    }
    return {
        now,
        block: block ? {start: block.start, end: block.end, totals: block.totals} : null,
        today,
        week,
        // Cache reads dwarf everything else; the days compare what was written.
        days: days.map(d => ({start: d.start, output: d.totals.output, messages: d.totals.messages})),
    };
}

/**
 * @param {number} count
 * @returns {string} e.g. "950", "12k", "1.2M"
 */
export function formatTokens(count) {
    if (count < 1000)
        return String(count);
    if (count < 1e6)
        return `${count < 1e4 ? (count / 1e3).toFixed(1) : Math.round(count / 1e3)}k`;
    if (count < 1e9)
        return `${count < 1e7 ? (count / 1e6).toFixed(1) : Math.round(count / 1e6)}M`;
    return `${(count / 1e9).toFixed(1)}B`;
}
