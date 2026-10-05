import {blocks, formatTokens, mergeRecords, parseLine, summarize} from '../lib/claudeUsage.js';
import {assert, assertEqual} from './util.js';

const HOUR = 3600 * 1000;

function line(time, {id = 'msg_1', request = 'req_1', output = 10, input = 2, cacheRead = 100, type = 'assistant'} = {}) {
    return JSON.stringify({
        type,
        timestamp: new Date(time).toISOString(),
        requestId: request,
        sessionId: 'session',
        message: {
            id, role: 'assistant', model: 'claude', content: [{type: 'text', text: 'never read'}],
            usage: {input_tokens: input, output_tokens: output, cache_creation_input_tokens: 5, cache_read_input_tokens: cacheRead},
        },
    });
}

export function testParseLine() {
    const time = Date.UTC(2026, 9, 5, 10, 20);
    const record = parseLine(line(time));
    assertEqual(record, {
        key: 'msg_1:req_1', time, session: 'session', input: 2, output: 10, cacheWrite: 5, cacheRead: 100,
    });
    assertEqual(parseLine(line(time, {type: 'user'})), null, 'only answers count');
    assertEqual(parseLine('{"type":"assistant","message":{"usage":'), null, 'a line being written');
    assertEqual(parseLine('{"type":"summary","summary":"no usage"}'), null);
}

export function testRepeatedPartsCountOnce() {
    const time = Date.UTC(2026, 9, 5, 10, 20);
    const map = new Map();
    mergeRecords(map, [parseLine(line(time, {output: 3})), parseLine(line(time + 500, {output: 10}))]);
    mergeRecords(map, [parseLine(line(time + 1000, {id: 'msg_2', request: 'req_2'}))]);
    assertEqual(map.size, 2);
    assertEqual(map.get('msg_1:req_1').output, 10, 'the fullest part wins');
}

export function testBlocksStartAtTheHour() {
    const at = (h, m = 0) => Date.UTC(2026, 9, 5, h, m);
    const records = [at(10, 20), at(11), at(14, 59), at(15, 30), at(21)].map((time, i) =>
        parseLine(line(time, {id: `m${i}`, request: `r${i}`})));
    const result = blocks(records);
    assertEqual(result.map(b => [new Date(b.start).getUTCHours(), b.totals.messages]), [[10, 3], [15, 1], [21, 1]],
        'a block runs five hours from the hour of its first message');
}

export function testSummary() {
    const now = Date.UTC(2026, 9, 5, 16, 0);
    const records = [
        parseLine(line(now - 30 * 60 * 1000, {id: 'a', request: 'a', output: 100})),
        parseLine(line(now - 50 * HOUR, {id: 'b', request: 'b', output: 40})),
        parseLine(line(now - 9 * 24 * HOUR, {id: 'c', request: 'c', output: 1000})),
    ];
    const summary = summarize(records, now);
    assert(summary.block, 'a block is running');
    assertEqual(summary.block.totals.output, 100);
    assertEqual(summary.week.output, 140, 'older than a week is left out');
    assertEqual(summary.days.length, 7);
    assertEqual(summary.days.reduce((n, d) => n + d.output, 0), 140, 'the days add up to the week');
    assertEqual(summarize(records, now + 6 * HOUR).block, null, 'no block once it ended');
}

export function testFormatTokens() {
    assertEqual([950, 1234, 56789, 1234567, 89000000, 2.5e9].map(formatTokens),
        ['950', '1.2k', '57k', '1.2M', '89M', '2.5B']);
}
