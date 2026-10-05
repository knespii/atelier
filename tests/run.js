// Runs the unit tests: make test
// (uses the in-memory GSettings backend and directories below tests/output)

import System from 'system';

import * as gtkCss from './gtkCss.test.js';
import * as migrate from './migrate.test.js';
import * as notifications from './notifications.test.js';
import * as palette from './palette.test.js';
import * as terminal from './terminal.test.js';
import * as profiles from './profiles.test.js';
import * as themes from './themes.test.js';
import * as thumbnails from './thumbnails.test.js';

const suites = {profiles, themes, thumbnails, gtkCss, migrate, palette, terminal, notifications};

let total = 0;
let failures = 0;
for (const [suite, tests] of Object.entries(suites)) {
    for (const [name, test] of Object.entries(tests)) {
        if (!name.startsWith('test'))
            continue;
        total++;
        try {
            await test();
            print(`ok    ${suite} › ${name}`);
        } catch (e) {
            failures++;
            printerr(`FAIL  ${suite} › ${name}: ${e.message}\n${e.stack}`);
        }
    }
}

print(`\n${total - failures}/${total} tests passed`);
System.exit(failures > 0 ? 1 : 0);
