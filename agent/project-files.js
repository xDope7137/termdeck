'use strict';

// One implementation lives in lib/project-files.js. The master distributes THAT
// file to agent boxes under the name project-files.js (see AGENT_FILES in
// master.js), so installed agents get the full module; this stub keeps a repo-run
// agent working without a second copy drifting out of sync. Mirrors
// agent/checkpoints.js.
module.exports = require('../lib/project-files');
