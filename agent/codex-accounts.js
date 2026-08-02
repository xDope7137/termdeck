'use strict';

// One implementation lives in lib/codex-accounts.js. The master distributes
// THAT file to agent boxes under the name codex-accounts.js (see AGENT_FILES in
// master.js), so installed agents get the full module; this stub keeps a
// repo-run agent working without a second copy drifting out of sync. Mirrors
// agent/accounts.js.
module.exports = require('../lib/codex-accounts');
