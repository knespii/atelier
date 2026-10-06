import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {blocks, formatTokens, mergeRecords, parseLine, summarize} from '../lib/claudeUsage.js';
import {assert, assertEqual, freshDir, writeFile} from './util.js';

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

function runWorker(projects, cache, now) {
    const process = Gio.Subprocess.new(
        ['gjs', '-m', 'lib/claudeUsageWorker.js', '--projects', projects, '--cache', cache, '--now', String(now)],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [, stdout, stderr] = process.communicate_utf8(null, null);
    if (!process.get_successful())
        throw new Error(`worker failed: ${stderr}`);
    return JSON.parse(stdout);
}

export function testWorkerWritesItsCacheOnlyWhenNeeded() {
    const dir = freshDir('claude');
    const projects = GLib.build_filenamev([dir, 'projects']);
    const transcript = GLib.build_filenamev([projects, 'project', 'session.jsonl']);
    const cache = GLib.build_filenamev([dir, 'usage.json']);
    const written = () => JSON.parse(new TextDecoder().decode(GLib.file_get_contents(cache)[1])).written;
    const start = Date.now();
    const first = `${line(start - 60000, {id: 'a', request: 'a'})}\n`;
    writeFile(transcript, first);

    assertEqual(runWorker(projects, cache, start).week.messages, 1);
    assertEqual(written(), start, 'written once something new was read');
    assertEqual(runWorker(projects, cache, start + 60000).week.messages, 1);
    assertEqual(written(), start, 'nothing new: not written again');

    writeFile(transcript, `${first}${line(start + 90000, {id: 'b', request: 'b'})}\n`);
    assertEqual(runWorker(projects, cache, start + 120000).week.messages, 2, 'a new message counts');
    assertEqual(written(), start, 'while a session writes on, written every few minutes only');
    assertEqual(runWorker(projects, cache, start + 180000).week.messages, 2, 'read again, it counts once');
    runWorker(projects, cache, start + 6 * 60000);
    assertEqual(written(), start + 6 * 60000, 'and then written');
}

export function testFormatTokens() {
    assertEqual([950, 1234, 56789, 1234567, 89000000, 2.5e9].map(formatTokens),
        ['950', '1.2k', '57k', '1.2M', '89M', '2.5B']);
}
