'use strict';

// One implementation lives in lib/project-doc.js. The master distributes THAT
// file to agent boxes under the name project-doc.js (see AGENT_FILES in
// master.js), so installed agents get the full module; this stub keeps a repo-run
// agent working without a second copy drifting out of sync. Mirrors
// agent/project-files.js.
module.exports = require('../lib/project-doc');
