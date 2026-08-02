'use strict';

// One implementation lives in lib/context-doc.js. The master distributes THAT
// file to agent boxes under the name context-doc.js (see AGENT_FILES in
// master.js), so installed agents get the full module; this stub keeps a
// repo-run agent working without a second copy drifting. Mirrors agent/diff.js.
module.exports = require('../lib/context-doc');
