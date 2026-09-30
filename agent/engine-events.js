'use strict';

// One implementation lives in lib/engine-events.js. The master distributes THAT file
// to agent boxes under the name engine-events.js (see AGENT_FILES in master.js); this stub
// keeps a repo-run agent working without a second copy. Mirrors agent/tail-read.js.
module.exports = require('../lib/engine-events');
