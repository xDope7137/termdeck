'use strict';

// One implementation lives in lib/usage-behaviour.js. The master distributes THAT
// file to agent boxes under the name usage-behaviour.js (see AGENT_FILES in
// master.js), so installed agents get the full module; this stub keeps a repo-run
// agent working without a second copy drifting out of sync. Mirrors
// agent/command-catalog.js.
module.exports = require('../lib/usage-behaviour');
