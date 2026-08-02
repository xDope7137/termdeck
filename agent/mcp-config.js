'use strict';

// One implementation lives in lib/mcp-config.js. The master distributes THAT file
// to agent boxes as mcp-config.js (see AGENT_FILES in master.js); this stub keeps
// a repo-run agent working without a second copy drifting. Mirrors agent/diff.js.
module.exports = require('../lib/mcp-config');
