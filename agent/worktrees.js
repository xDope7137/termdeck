'use strict';

// One implementation lives in lib/worktrees.js. The master distributes THAT file
// to agent boxes under the name worktrees.js (see AGENT_FILES in master.js), so
// installed agents get the full module; this stub keeps a repo-run agent working
// without a second 400-line copy drifting out of sync.
module.exports = require('../lib/worktrees');
