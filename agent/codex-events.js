'use strict';

// One implementation lives in lib/codex-events.js. The master distributes THAT file
// to agent boxes under the name codex-events.js (see AGENT_FILES in master.js); this stub
// keeps a repo-run agent working without a second copy. Mirrors agent/claude-events.js.
module.exports = require('../lib/codex-events');
