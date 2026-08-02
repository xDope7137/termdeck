'use strict';

// One implementation lives in lib/session-head.js. The master distributes THAT file
// to agent boxes under the name session-head.js (see AGENT_FILES in master.js), so
// installed agents get the full module; this stub keeps a repo-run agent working
// without a second copy drifting out of sync. Mirrors agent/tail-read.js.
module.exports = require('../lib/session-head');
