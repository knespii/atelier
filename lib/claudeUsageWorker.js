// Reads what is new in Claude Code's transcripts since the last run and
// prints a summary of the usage as JSON. The shell runs it in a process of
// its own (gjs -m), so reading a lot of transcripts never stalls the desktop.
// Only token counts, times and session ids are kept, in Atelier's cache.
//
// Options (for tests): --projects DIR, --cache FILE, --now MS

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {KEEP, mergeRecords, parseLine, summarize} from './claudeUsage.js';

const CACHE_VERSION = 1;
const CHUNK = 1 << 20;
const ACTIVE_TIME = 120 * 1000; // a transcript written to this recently: a session runs
const WORKING_TIME = 20 * 1000; // …this recently: Claude is working

const NEWLINE = 10;

function option(name, fallback) {
    const index = System.programArgs.indexOf(name);
    return index >= 0 ? System.programArgs[index + 1] : fallback;
}

function defaultProjects() {
    const config = GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
    return GLib.build_filenamev([config, 'projects']);
}

/**
 * @param {Gio.File} dir
 * @param {number} depth - 1 for the files of a project
 * @yields {{path: string, size: number, mtime: number, depth: number}}
 */
function* transcripts(dir, depth = 0) {
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name,standard::type,standard::size,time::modified',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch {
        return;
    }
    let info;
    while ((info = enumerator.next_file(null))) {
        const child = dir.get_child(info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            yield* transcripts(child, depth + 1);
        } else if (info.get_name().endsWith('.jsonl')) {
            yield {
                path: child.get_path(),
                size: info.get_size(),
                mtime: info.get_modification_date_time().to_unix() * 1000,
                depth,
            };
        }
    }
    enumerator.close(null);
}

/**
 * Parse the complete lines after an offset.
 *
 * @param {string} path
 * @param {number} offset - bytes already read
 * @returns {{records: object[], offset: number}}
 */
function readNew(path, offset) {
    const records = [];
    const decoder = new TextDecoder();
    const stream = Gio.File.new_for_path(path).read(null);
    let consumed = offset;
    try {
        stream.seek(offset, GLib.SeekType.SET, null);
        let carry = new Uint8Array(0);
        for (;;) {
            const bytes = stream.read_bytes(CHUNK, null).toArray();
            if (bytes.length === 0)
                break;
            const data = new Uint8Array(carry.length + bytes.length);
            data.set(carry);
            data.set(bytes, carry.length);
            const end = data.lastIndexOf(NEWLINE);
            if (end < 0) {
                carry = data;
                continue;
            }
            for (const line of decoder.decode(data.subarray(0, end)).split('\n')) {
                const record = parseLine(line);
                if (record)
                    records.push(record);
            }
            consumed += end + 1;
            carry = data.slice(end + 1);
        }
    } finally {
        stream.close(null);
    }
    // A line still being written is read next time.
    return {records, offset: consumed};
}

function loadCache(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        const cache = JSON.parse(new TextDecoder().decode(bytes));
        if (cache?.version === CACHE_VERSION)
            return cache;
    } catch {
        // none yet, or unreadable: start over
    }
    return {version: CACHE_VERSION, files: {}, records: []};
}

function main() {
    const now = Number(option('--now', Date.now()));
    const projects = option('--projects', defaultProjects());
    const cachePath = option('--cache',
        GLib.build_filenamev([GLib.get_user_cache_dir(), 'atelier', 'claude-usage.json']));

    const cache = loadCache(cachePath);
    const map = new Map(cache.records.filter(r => r.time > now - KEEP).map(r => [r.key, r]));
    const files = {};
    let active = 0;
    let working = 0;
    let found = false;

    for (const file of transcripts(Gio.File.new_for_path(projects))) {
        found = true;
        // A session's own transcript sits right in its project's folder.
        if (file.depth === 1 && now - file.mtime < ACTIVE_TIME) {
            active++;
            if (now - file.mtime < WORKING_TIME)
                working++;
        }
        const known = cache.files[file.path];
        let offset = known && known.offset <= file.size ? known.offset : 0;
        if (file.mtime > now - KEEP && file.size > offset) {
            try {
                const result = readNew(file.path, offset);
                mergeRecords(map, result.records);
                offset = result.offset;
            } catch (e) {
                printerr(`Atelier: could not read ${file.path}: ${e.message}`);
            }
        }
        files[file.path] = {offset};
    }

    const records = [...map.values()].filter(r => r.time > now - KEEP);
    GLib.mkdir_with_parents(GLib.path_get_dirname(cachePath), 0o700);
    GLib.file_set_contents(cachePath, JSON.stringify({version: CACHE_VERSION, files, records}));
    print(JSON.stringify({...summarize(records, now), found, sessions: {active, working}}));
}

main();
