'use strict';

// One implementation lives in lib/session-title.js. The master distributes THAT file
// to agent boxes under the name session-title.js (see AGENT_FILES in master.js), so
// installed agents get the full module; this stub keeps a repo-run agent working
// without a second copy drifting out of sync. Mirrors agent/session-head.js.
//
// Missing until 2026-08-04, which meant a repo-run agent — what the test harness
// and a dev box use — could not append a title record at all: capabilities.js's
// `require('./session-title')` threw, the mutate op answered a bare error, and
// renaming a session simply did nothing there. Installed agents were fine (they
// download the file), so it only ever showed up off the installed path.
module.exports = require('../lib/session-title');
