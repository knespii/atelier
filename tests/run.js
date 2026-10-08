// Runs the unit tests: make test
// (uses the in-memory GSettings backend and directories below tests/output)

import System from 'system';

import * as claudeUsage from './claudeUsage.test.js';
import * as dockActions from './dockActions.test.js';
import * as dockGeometry from './dockGeometry.test.js';
import * as dockImport from './dockImport.test.js';
import * as dockIndicators from './dockIndicators.test.js';
import * as dockLocations from './dockLocations.test.js';
import * as dockTheme from './dockTheme.test.js';
import * as dockVisibility from './dockVisibility.test.js';
import * as gtkCss from './gtkCss.test.js';
import * as liquid from './liquid.test.js';
import * as migrate from './migrate.test.js';
import * as notes from './notes.test.js';
import * as notifications from './notifications.test.js';
import * as palette from './palette.test.js';
import * as terminal from './terminal.test.js';
import * as profiles from './profiles.test.js';
import * as profileTransfer from './profileTransfer.test.js';
import * as slack from './slack.test.js';
import * as themes from './themes.test.js';
import * as thumbnails from './thumbnails.test.js';
import * as widgets from './widgets.test.js';

const suites = {profiles, themes, thumbnails, gtkCss, migrate, palette, terminal, notifications, claudeUsage, widgets, notes, profileTransfer, slack, liquid,
    dockGeometry, dockVisibility, dockActions, dockIndicators, dockLocations, dockTheme, dockImport};

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
