'use strict';

// One implementation lives in lib/grok-events.js. The master distributes THAT file
// to agent boxes under the name grok-events.js (see AGENT_FILES in master.js); this stub
// keeps a repo-run agent working without a second copy. Mirrors agent/codex-events.js.
module.exports = require('../lib/grok-events');
