// Runs the unit tests: make test
// (uses the in-memory GSettings backend and directories below tests/output)

import System from 'system';

import * as looks from './looks.test.js';
import * as themes from './themes.test.js';
import * as thumbnails from './thumbnails.test.js';

const suites = {looks, themes, thumbnails};

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
