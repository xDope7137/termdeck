'use strict';

// One implementation lives in lib/session-index.js. The master distributes THAT
// file to agent boxes under the name session-index.js (see AGENT_FILES in
// master.js); this stub keeps a repo-run agent working. Mirrors agent/index-head.js.
module.exports = require('../lib/session-index');
