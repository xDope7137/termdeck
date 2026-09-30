'use strict';

// The thin agent's capability handlers — the ONLY things it will do for the master. This is
// the security boundary (trust inversion): the agent is a narrow typed capability, never a
// generic "run this". readFile/stat/watch are confined to the two transcript roots; spawn is
// limited to the two known engines. A master compromise still can't read arbitrary files or
// run arbitrary commands on the customer's box.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { randomUUID } = require('crypto');
const { registry: DEFAULT_RUNS } = require('./engine-runs');
// The wire protocol, written down: every frame this file answers has a row there
// naming its reply type, its legal ops and the master's timeout for it. The switch
// below and that table are pinned to each other by tests/agent-protocol.mjs, so a
// case with no row (or a row with no case) fails the suite instead of shipping as a
// capability one side advertises and the other cannot serve.
const protocol = require('./agent-protocol');
const diffLib = require('./diff'); // stub → ../lib/diff (repo run); shipped as diff.js on installed agents
// Tail reads — how the master gets "the last fifteen messages" without pulling
// the whole transcript across the tunnel. Guarded like the readers below: an
// agent that pulled a new capabilities.js before tail-read.js landed still
// boots, and the master falls back to the whole-file read it used before.
let tailReadLib; try { tailReadLib = require('./tail-read'); } catch { tailReadLib = null; }
// The parsers, for the three reads that decide something ABOUT a transcript on
// this side of the tunnel (features/04 phase 4): whether a tail window filled,
// the whole-file totals a tail cannot see, and the background shells a chat
// recorded. Same guard as the rest: an agent that pulled a new capabilities.js
// before transcript.js landed still boots, and those ops answer AGENT_OUTDATED.
let transcriptLib; try { transcriptLib = require('./transcript'); } catch { transcriptLib = null; }
// The session index's head/tail parse, run agent-side so the bytes stay here.
// Guarded like the rest: a missing module degrades `indexHeads` to AGENT_OUTDATED
// and the master falls back to reading the file itself, rather than crash-looping.
let indexHeadLib; try { indexHeadLib = require('./index-head'); } catch { indexHeadLib = null; }
// The machine's own session index (features/04 phase 8), persisted under the
// agent's state dir. Guarded like the rest: a missing module answers
// `indexSync` with AGENT_OUTDATED and the master walks the roots itself.
let sessionIndexLib; try { sessionIndexLib = require('./session-index'); } catch { sessionIndexLib = null; }
// Concurrency-capped Promise.all, for the batch above. Not guarded like the
// libs around it: pool.js has shipped in AGENT_FILES since the scan layers took
// it, it has no dependencies of its own, and `indexHeads` is the only caller
// here. A guard would have to degrade the op rather than the width, which is
// the wrong trade for a helper that cannot fail to load on its own.
const { mapLimit } = require('./pool');
// Per-chat preferences on this machine (the thinking dial). Guarded like the
// rest: a missing module degrades the capability, never crash-loops boot.
let sessionSettingsLib; try { sessionSettingsLib = require('./session-settings'); } catch { sessionSettingsLib = null; }
// U5/U8 readers — distributed like diff. Guarded so an agent that pulled a new
// capabilities.js before these files land (self-update ordering) still boots and
// serves every other capability; the op below returns a clean "outdated" error.
let mcpConfigLib; try { mcpConfigLib = require('./mcp-config'); } catch { mcpConfigLib = null; }
// /rewind — the same lib/checkpoints.js the hub restores from, so a cloud restore
// and a local one resolve the same backups by the same rules. Guarded like the
// rest: an agent that pulled a new capabilities.js before checkpoints.js landed
// still boots and answers AGENT_OUTDATED for this one op.
let checkpointsLib; try { checkpointsLib = require('./checkpoints'); } catch { checkpointsLib = null; }
// Read-only browsing of a session's PROJECT folder — the one READ that lands
// outside the transcript roots, and the module that IS its confinement. Guarded
// like the rest: an agent that pulled a new capabilities.js before this file
// landed still boots, and the op answers AGENT_OUTDATED instead of crash-looping.
let projectFilesLib; try { projectFilesLib = require('./project-files'); } catch { projectFilesLib = null; }
// Background shells: which processes a parked shell host still owns, and which
// output file each one writes to. Guarded like the rest — an agent that pulled a
// new capabilities.js before this file landed still boots and answers
// AGENT_OUTDATED for the two ops that need it.
let procTreeLib; try { procTreeLib = require('./proc-tree'); } catch { procTreeLib = null; }
let machineConfigLib; try { machineConfigLib = require('./machine-config'); } catch { machineConfigLib = null; }
let projectDocLib; try { projectDocLib = require('./project-doc'); } catch { projectDocLib = null; }
let commandCatalogLib; try { commandCatalogLib = require('./command-catalog'); } catch { commandCatalogLib = null; }
let usageBehaviourLib; try { usageBehaviourLib = require('./usage-behaviour'); } catch { usageBehaviourLib = null; }
let codexAttachmentLib; try { codexAttachmentLib = require('./codex-attachment'); } catch { codexAttachmentLib = null; }
// The attachment allowlist, shared with the master so both sides refuse the same
// file for the same reason. Guarded like the rest: an agent that pulled a new
// capabilities.js before upload-types.js landed still boots, and `upload`
// answers AGENT_OUTDATED until the next self-update brings the file.
let uploadTypesLib; try { uploadTypesLib = require('./upload-types'); } catch { uploadTypesLib = null; }
// Account switching (cloud path) — same lib/accounts.js the hub uses, via the
// agent/accounts.js stub. Its cache-invalidation hooks point at THIS agent's
// own caches (claudeModelCache below, agent/limits.js's), not the hub's.
let accountsLib; try { accountsLib = require('./accounts'); } catch { accountsLib = null; }
if (accountsLib) {
  accountsLib.setInvalidateHooks({
    invalidateModels: () => { claudeModelCache = null; },
    invalidateClaude: () => { try { require('./limits').invalidateClaudeCache(); } catch {} },
  });
}
// ChatGPT (Codex) account switching, same deal one engine over. There is no
// reloadCodex hook here: the master asks for the shared `codex app-server`
// (engine-runs.js) to be recycled after a switch, through engineRun 'recycle',
// and passes in the in-flight turn count it sees.
// The usage cache IS this process's to drop, though — it holds percentages read
// under the outgoing account, and serving them under the incoming account's name
// is exactly the mislabelling this hook exists to prevent.
let codexAccountsLib; try { codexAccountsLib = require('./codex-accounts'); } catch { codexAccountsLib = null; }
if (codexAccountsLib) {
  codexAccountsLib.setInvalidateHooks({
    invalidateModels: () => {},
    reloadCodex: () => { try { require('./limits').invalidateCodexCache(); } catch {} },
  });
}
let chokidar; try { chokidar = require('chokidar'); } catch { /* watch degrades to unavailable */ }

// Where this box keeps each engine's data. Read from the environment ONCE, here,
// and nowhere else: everything below takes its roots from a CONFINEMENT built out
// of these rather than reaching for a module constant.
//
// That is not tidiness. makeCapabilities() closed over env-derived module state, so
// one process had one root set, a test could hold exactly one fixture, and 30 of
// the 40 capabilities in this file had no test at all as a direct result.
// agent/engine-runs.js solves the same problem next door with createRunRegistry(opts),
// and its tests build a registry per case because of it.
const DEFAULT_ROOTS = {
  // CLAUDE_CONFIG_DIR relocates Claude Code's whole data dir (SDK-supported var).
  // The confinement root MUST follow it: an agent that reads from the configured
  // dir but confines to the hardcoded default would authorise nothing and refuse
  // its own reads (or worse, authorise the wrong tree). Unset means today's ~/.claude.
  claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  // Grok's ~/.grok holds auth.json (the OIDC access + refresh token) directly at its
  // root. Unlike claudeDir/codexHome (whole-home roots with no bare secret file at
  // the top level), granting the whole dir would make that token readable over the
  // tunnel, so only its SESSIONS SUBTREE becomes a root: the one thing the master
  // needs to render transcripts (mirrors lib/grok-data.js's SESSIONS_DIR).
  grokDir: process.env.GROK_HOME || path.join(os.homedir(), '.grok'),
};

// Defense in depth (on top of the root scoping above, not instead of it): refuse these
// basenames outright even if some future root ever widened to cover them — auth.json
// (grok's OIDC token) and .credentials.json (Claude's OAuth token, which already sits
// INSIDE the whole-home CLAUDE_DIR root today) must never cross the tunnel as a plain
// file read, however a root gets misconfigured.
const DENYLIST_BASENAMES = new Set(['auth.json', '.credentials.json']);

// One confinement: the three roots, resolved through their own symlinks once, and
// every question this file asks about a path. A guard anywhere below goes through
// the `confined` of the confinement it was built with, never a module constant, so
// two of these can answer about two different fixtures in one process.
function makeConfinement(roots = {}) {
  const dirs = { ...DEFAULT_ROOTS, ...roots };
  const ROOTS = [dirs.claudeDir, dirs.codexHome, path.join(dirs.grokDir, 'sessions')];
  // Resolve the roots' own symlinks once at startup so the prefix check compares real paths.
  const REAL_ROOTS = ROOTS.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });

  const within = (rp) => REAL_ROOTS.some((r) => rp === r || rp.startsWith(r + path.sep));
  const rootOf = (rp) => REAL_ROOTS.find((r) => rp === r || rp.startsWith(r + path.sep));

  // Containment mirrors resolveTranscriptPath but resolves SYMLINKS too (path.resolve only
  // collapses `..`): realpath the target so a symlink inside a root that points outside can't
  // smuggle an out-of-root read. For a path that doesn't exist yet (e.g. watch-before-create)
  // resolve the parent and re-append the basename. Fail closed on any resolve error.
  const confined = async (p) => {
    try {
      const rp = await fsp.realpath(p);
      if (DENYLIST_BASENAMES.has(path.basename(rp))) return false;
      return within(rp);
    } catch {
      try {
        const parent = await fsp.realpath(path.dirname(path.resolve(p)));
        const candidate = path.join(parent, path.basename(p));
        if (DENYLIST_BASENAMES.has(path.basename(candidate))) return false;
        return within(candidate);
      } catch { return false; }
    }
  };

  return { dirs, ROOTS, REAL_ROOTS, within, rootOf, confined };
}

// The one built from the environment. The module's exports are its members, so
// agent.js's hello frame and tests/bg-shell-confinement.mjs keep reading exactly
// what they always read.
const DEFAULT_CONFINEMENT = makeConfinement();
const { ROOTS, REAL_ROOTS, rootOf, confined } = DEFAULT_CONFINEMENT;
const CLAUDE_DIR = DEFAULT_CONFINEMENT.dirs.claudeDir;
const CODEX_HOME = DEFAULT_CONFINEMENT.dirs.codexHome;
const GROK_DIR = DEFAULT_CONFINEMENT.dirs.grokDir;

// Background-shell output files. These are the one READ that lands outside the
// transcript roots AND takes a path from the master, so the rule has to be tight
// enough to state in a sentence: a file named <backgroundTaskId>.output, in a
// directory named `tasks`, somewhere under this user's own Claude scratchpad root
// in the OS temp dir. Nothing else resolves, whatever the master asks for.
//
// The path is VALIDATED here rather than trusted, like every other argument the
// master forwards. It reaches us because only the CLI's own tool_result names it
// (and it embeds the ROOT session id, not the resumed one, so it cannot be
// derived) — but "we can't compute it" is not "we'll read whatever we're told".
const BG_SCRATCH_ROOT = (() => {
  // Mirrors the CLI's own layout: <tmp>/claude-<uid>/<project-slug>/<sessionId>/tasks/.
  // getuid is POSIX-only; Windows scratchpads carry no uid segment, so match the
  // prefix rather than an exact directory name.
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return { dir: os.tmpdir(), prefix: uid == null ? 'claude-' : `claude-${uid}` };
})();
const BG_LOG_RE = /^b[a-z0-9]+\.output$/i;

function bgLogPathOk(p) {
  if (typeof p !== 'string' || !p) return false;
  let rp;
  // realpath, not resolve: the temp dir is a symlink on macOS (/tmp → /private/tmp),
  // so an un-resolved compare rejects every legitimate path there.
  try { rp = fs.realpathSync(p); } catch { return false; }
  if (!BG_LOG_RE.test(path.basename(rp))) return false;
  if (path.basename(path.dirname(rp)) !== 'tasks') return false;
  let tmp;
  try { tmp = fs.realpathSync(BG_SCRATCH_ROOT.dir); } catch { tmp = path.resolve(BG_SCRATCH_ROOT.dir); }
  if (rp !== tmp && !rp.startsWith(tmp + path.sep)) return false;
  // The segment directly under the temp dir must be this user's scratchpad root —
  // otherwise any world-writable `*/tasks/b*.output` under /tmp would qualify.
  const seg = rp.slice(tmp.length + 1).split(path.sep)[0] || '';
  if (!seg.startsWith(BG_SCRATCH_ROOT.prefix)) return false;
  try { return fs.statSync(rp).isFile(); } catch { return false; }
}

// Where an attachment lands on its way to a CLI: ~/.termdeck/uploads, with
// TERMDECK_HOME overriding the home the same way every other consumer of that
// var does (lib/cloud/db.js, lib/policies.js, agent/agent.js).
//
// Read at CALL time, not at module load. A module-level constant here would bake
// whatever the environment held when this file was first required, which is the
// trap that has already bitten the db (a test that sets TERMDECK_HOME after the
// first require gets the developer's real home instead of its fixture).
function uploadsRoot() {
  const home = process.env.TERMDECK_HOME || path.join(os.homedir(), '.termdeck');
  return path.join(home, 'uploads');
}

// Delete staging buckets nothing has touched for a week. Runs on the write path
// rather than on a timer: a machine that never uploads never sweeps, and one
// that uploads constantly sweeps constantly, which is the shape the cost should
// have. Every failure is swallowed on purpose: a bucket that will not stat is
// not a reason to refuse the upload the user is waiting on.
async function sweepUploads(root, now = Date.now()) {
  const ttl = (uploadTypesLib && uploadTypesLib.UPLOAD_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    try {
      const s = await fsp.stat(dir);
      if (now - s.mtimeMs < ttl) continue;
      await fsp.rm(dir, { recursive: true, force: true });
    } catch { /* next bucket */ }
  }
}

// How a converted handler refuses. Anything else it throws is an UNEXPECTED failure
// and gets reported the way the hand-written catch reported it: `e.code || e.message`,
// so an ENOENT still reaches the master as ENOENT rather than as a sentence.
const fail = (message, code = null, extra = null) => Object.assign(new Error(message), { capRefusal: true, capCode: code, capExtra: extra });

// The only thing a fire-and-forget op can do with a failure. Lazy require and a
// bare catch for the same reason the log module is lazy everywhere else in this
// file: this runs on the path that exists to STOP a throw from reaching an
// uncaught handler, so it must not be able to throw itself.
function logSwallowed(t, e) {
  try { require('./log').warn(`capability ${t} failed with no reply channel: ${(e && (e.stack || e.message)) || e}`); } catch { /* nothing left to try */ }
}

// Cross-mount-safe move (the in-root trash dir is always same-filesystem, but keep
// the fallback in case a root is itself a mount/symlink to another device).
async function moveFile(src, dst) {
  try {
    await fsp.rename(src, dst);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(src, dst);
    await fsp.unlink(src);
  }
}

const RECORD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A straight sessionId/cwd rewrite still shares the original's record uuid/parentUuid
// chain, so Termdeck's own fork-family collapse (keyed on the first message's uuid)
// treats the clone as a sibling fork of the source and hides one of them in the sidebar
// — the duplicate silently "disappears". Two passes: first collect every record's own
// uuid into a fresh-uuid map, then rewrite uuid/parentUuid/leafUuid (last-prompt
// records) through that map so the clone gets its own independent identity.
//
// `upTo` turns the same machinery into a FORK (SDK-SIGNALS §F). It names the
// PROMPT the checkpoint sits in front of ("before this prompt"), and the branch
// keeps everything strictly BEFORE it: that prompt is the instruction the user
// wants to replace. Keeping it (the old cut, through the record) left it in the
// branch unanswered, the resumed CLI injected its synthetic "No response
// requested." reply to it, and the wrong instruction stayed in context. The
// prompt's own submission records go with it: its checkpoint snapshot/deltas
// (keyed on its uuid) and the queue enqueue/dequeue written just ahead of it.
// What is left ends on the prompt's parent chain, so that is the leaf the
// resumed CLI continues from.
//
// An unknown uuid THROWS rather than cloning the whole conversation, because a
// "branch from here" that quietly branched from the end is a copy the user would
// only catch by reading it. A cut that leaves no message at all (the first
// prompt) throws too: there is nothing to resume, and a new chat is the answer.
function rewriteDuplicateTranscript(content, oldSessionId, newId, newCwd, upTo) {
  let lines = content.split('\n');
  let records = lines.map((line) => {
    if (!line.trim()) return undefined;
    try { return JSON.parse(line); } catch { return undefined; }
  });
  if (upTo) {
    const cut = records.findIndex((rec) => rec && rec.uuid === upTo);
    if (cut < 0) throw Object.assign(new Error('fork point not in transcript'), { code: 'BAD_FORK_POINT' });
    const ownRecord = (rec) => rec
      && (rec.type === 'file-history-snapshot' || rec.type === 'file-history-delta')
      && (rec.messageId === upTo || rec.snapshotMessageId === upTo || (rec.snapshot && rec.snapshot.messageId === upTo));
    let end = cut;
    while (end > 0) {
      const rec = records[end - 1];
      const pending = rec && rec.type === 'queue-operation' && (rec.operation === 'enqueue' || rec.operation === 'dequeue');
      if (!pending && !ownRecord(rec) && lines[end - 1].trim()) break;
      end -= 1;
    }
    const keep = [];
    for (let i = 0; i < end; i += 1) if (!ownRecord(records[i])) keep.push(i);
    lines = keep.map((i) => lines[i]);
    records = keep.map((i) => records[i]);
    if (!records.some((rec) => rec && (rec.type === 'user' || rec.type === 'assistant'))) {
      throw Object.assign(new Error('There is nothing before the first prompt to branch from. Start a new chat instead.'), { code: 'EMPTY_FORK' });
    }
  }
  const uuidMap = new Map();
  for (const rec of records) {
    if (rec && typeof rec.uuid === 'string' && RECORD_UUID_RE.test(rec.uuid)) uuidMap.set(rec.uuid, randomUUID());
  }
  const out = records
    .map((rec, i) => {
      if (!rec) return lines[i];
      if (rec.sessionId === oldSessionId) rec.sessionId = newId;
      if (newCwd && typeof rec.cwd === 'string') rec.cwd = newCwd;
      if (typeof rec.uuid === 'string' && uuidMap.has(rec.uuid)) rec.uuid = uuidMap.get(rec.uuid);
      if (typeof rec.parentUuid === 'string' && uuidMap.has(rec.parentUuid)) rec.parentUuid = uuidMap.get(rec.parentUuid);
      if (typeof rec.leafUuid === 'string' && uuidMap.has(rec.leafUuid)) rec.leafUuid = uuidMap.get(rec.leafUuid);
      return JSON.stringify(rec);
    })
    .join('\n');
  // A jsonl line ends in a newline, and the CLI appends its next record straight
  // after whatever is here. The uncut path only kept one because the source's
  // trailing empty line survived the split; a cut drops it, and the first record
  // the resumed CLI wrote landed glued onto the fork point, one unparseable line.
  return out.endsWith('\n') ? out : `${out}\n`;
}


// The injected reader lib/index-head.js's parse runs against — local fs, since
// this is the box that holds the disk. Two callers now (`indexHeads` batches it
// across the session list, `projectFiles` runs it on ONE transcript to learn
// where that chat's project folder is), so it is built in one place: two copies
// would be two answers to "what is this chat's cwd", and the second one would be
// the one that decides what may be read.
function headIo() {
  return {
    path,
    // Only used to confirm a directory a rollout NAMES still exists (index-head's
    // codex worktree promotion). Deliberately not `confined` — it answers about the
    // user's project tree, which is where their code lives, and it returns one bool
    // about a path the transcript already contains.
    isDir: async (p) => {
      try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
    },
    readFile: async (p, offset = 0, len = null) => {
      const fd = await fsp.open(p, 'r');
      try {
        const st = await fd.stat();
        const length = len == null ? Math.max(0, st.size - offset) : len;
        const buf = Buffer.alloc(Math.max(0, length));
        const { bytesRead } = length > 0 ? await fd.read(buf, 0, length, Math.max(0, offset)) : { bytesRead: 0 };
        return buf.subarray(0, bytesRead);
      } finally { await fd.close(); }
    },
    readAll: (p) => fsp.readFile(p),
  };
}

// Could this file be a session transcript for `kind`? A coarse structural test,
// used only to keep `indexScan` from putting obviously-irrelevant files on the
// wire — the master re-checks every survivor against its own exact patterns, so
// a false positive here costs nothing and this never becomes a second, drifting
// copy of those rules. Erring towards INCLUDING a file is therefore always safe;
// excluding one that is really a session is not, which is why each branch tests
// a fact about where the engine puts its files rather than how it names them.
function indexCandidate(kind, root, dir, name) {
  // Grok: <root>/<group>/<sessionId>/updates.jsonl — the filename is the constant.
  if (kind === 'grok') return name === 'updates.jsonl';
  // Codex: rollouts nest under dated directories, so depth is not a signal;
  // a warm rollout is .jsonl and an archived one is .jsonl.zst.
  if (kind === 'codex') return name.endsWith('.jsonl') || name.endsWith('.jsonl.zst');
  // Claude: sessions live at exactly <root>/<slug>/<uuid>.jsonl. Anything deeper
  // (a session's own subagents/ dir) is not a session row — and on a working box
  // that is most of the tree.
  return name.endsWith('.jsonl') && path.resolve(path.dirname(dir)) === root;
}

// Resolve an engine binary the way a shell would. The old default (~/.local/bin/<name>,
// no extension) only ever existed on Linux/macOS — on Windows the binary is <name>.exe (or
// an npm .cmd shim) and lives elsewhere, so codex/claude were invisible there (empty
// availability flag + ENOENT on spawn). Order: explicit override, ~/.local/bin, the
// standalone install's bin (mirrors this box's ~/.codex/packages/.../bin/codex), then PATH.
// Returns an absolute path when found (so fs.existsSync gives an accurate availability
// flag); falls back to the bare name for spawn's own PATH lookup.
function resolveEngine(kind, envVar, extraDirs = []) {
  if (process.env[envVar]) return process.env[envVar];
  const names = process.platform === 'win32' ? [`${kind}.exe`, `${kind}.cmd`, kind] : [kind];
  const dirs = [path.join(os.homedir(), '.local', 'bin'), ...extraDirs, ...(process.env.PATH || '').split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const full = path.join(dir, name);
      try { if (fs.statSync(full).isFile()) return full; } catch {} // statSync follows the ~/.local/bin symlink
    }
  }
  return names[0]; // not found on disk — let spawn try PATH; the availability flag reads false
}

const ENGINES = {
  claude: resolveEngine('claude', 'TERMDECK_CLAUDE_EXE'),
  codex: resolveEngine('codex', 'TERMDECK_CODEX_EXE', [path.join(CODEX_HOME, 'packages', 'standalone', 'current', 'bin')]),
  // Candidate order: env override, ~/.local/bin, ~/.grok/bin, PATH.
  grok: resolveEngine('grok', 'TERMDECK_GROK_EXE', [path.join(GROK_DIR, 'bin')]),
};
// limits.js spawns a short-lived `codex app-server` to read live usage; hand it
// the binary resolved here so there is one answer to "which codex" on this box.
try { require('./limits').setCodexExe(ENGINES.codex); } catch {}
try { require('./codex-accounts').setCodexExe(ENGINES.codex); } catch {}
// Same for claude, and for the same reason — with the same cost when it lapses.
// accounts.js resolves independently (which.js, PATHEXT order) and on a box with
// BOTH an npm global and a WinGet install those two orders pick DIFFERENT
// binaries: turns ran on one, `auth login` was driven on the other, and the
// sign-in hung with every payload internally consistent. The binary that runs
// the turns is the one whose login matters, so it wins.
try { require('./accounts').setClaudeExe(ENGINES.claude); } catch {}

const MODEL_CACHE_MS = 6 * 60 * 60 * 1000;
// The Models API is the authority on effort names. Keep a presentation order
// for the levels known today, then retain any future level after them instead
// of filtering it out. A fixed allow-list here used to make a newly released
// Claude effort visible in the API response and invisible everywhere in
// Termdeck.
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
function claudeEffortLevels(capabilities) {
  if (!capabilities) return null; // an older response did not report capabilities
  const effort = capabilities.effort;
  if (!effort || effort.supported === false) return []; // positive: no effort dial
  const order = new Map(EFFORT_ORDER.map((level, index) => [level, index]));
  return Object.entries(effort)
    .filter(([level, value]) => level !== 'supported' && value && value.supported === true)
    .map(([level]) => level)
    .sort((a, b) => {
      const ai = order.has(a) ? order.get(a) : EFFORT_ORDER.length;
      const bi = order.has(b) ? order.get(b) : EFFORT_ORDER.length;
      return ai - bi || a.localeCompare(b);
    });
}
// No hardcoded catalog here, mirroring lib/models.js. An agent that cannot fetch
// reports the failure and the master 502s; it never invents a list. A stale
// static list on a long-lived agent is precisely what hid Opus 5 in the cloud
// picker while every other layer was already correct.
let claudeModelCache = null; // { models, at }

// An agent installed as a service does NOT inherit the shell where someone
// exported ANTHROPIC_API_KEY — but Claude Code reads its own `env` block out of
// settings.json, so a box configured that way (an API key, a gateway/proxy base
// URL) looked credential-less to us while the CLI on the same disk was perfectly
// signed in. Read the same file the CLI does. Process env still wins.
function claudeSettingsEnv() {
  const out = {};
  for (const name of ['settings.json', 'settings.local.json']) {
    try {
      const env = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, name), 'utf8')).env;
      if (env && typeof env === 'object') {
        for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && v) out[k] = v;
      }
    } catch {}
  }
  return out;
}

function claudeEnv(name) {
  return process.env[name] || claudeSettingsEnv()[name] || null;
}

function readOauth() {
  try {
    return JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, '.credentials.json'), 'utf8')).claudeAiOauth || null;
  } catch {
    return null;
  }
}

// A subscription access token lasts hours, and .credentials.json is only
// refreshed when the CLI itself runs. A machine that hasn't started a chat since
// the token lapsed therefore looked "not signed in" — the picker said "Failed to
// fetch models" on a box whose login was fine, and stayed that way until someone
// opened a terminal. Nudging the CLI is the safe way back: `claude auth status`
// reads its own credentials, and the CLI owns the refresh. We never POST the
// refresh token ourselves — a rotated refresh token replayed by two writers is
// how a login gets revoked outright (the lesson lib/codex-accounts.js is built
// around). Best-effort, single-flight, and at most once a minute.
let refreshNudge = { at: 0, promise: null };
function nudgeClaudeRefresh() {
  if (refreshNudge.promise) return refreshNudge.promise;
  if (Date.now() - refreshNudge.at < 60_000) return Promise.resolve();
  refreshNudge.at = Date.now();
  refreshNudge.promise = new Promise((resolve) => {
    const exe = ENGINES.claude;
    const win = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
    // Kept short on purpose: the model fetch this sits inside answers a request
    // with its own deadline upstream, and a nudge that outlives it turns a slow
    // refresh into the same blank picker it was meant to fix.
    execFile(win ? `"${exe}"` : exe, ['auth', 'status', '--json'], { timeout: 8000, ...(win ? { shell: true } : {}) }, () => resolve());
  }).finally(() => { refreshNudge.promise = null; });
  return refreshNudge.promise;
}

async function claudeModelCred() {
  const apiKey = claudeEnv('ANTHROPIC_API_KEY');
  if (apiKey) return { header: 'x-api-key', value: apiKey, oauth: false, how: 'ANTHROPIC_API_KEY' };
  const authToken = claudeEnv('ANTHROPIC_AUTH_TOKEN');
  if (authToken) return { header: 'authorization', value: `Bearer ${authToken}`, oauth: true, how: 'ANTHROPIC_AUTH_TOKEN' };
  let o = readOauth();
  if (o && o.accessToken && o.expiresAt && o.expiresAt <= Date.now()) {
    await nudgeClaudeRefresh();
    o = readOauth() || o;
  }
  if (o && o.accessToken) {
    const stale = !!(o.expiresAt && o.expiresAt <= Date.now());
    return { header: 'authorization', value: `Bearer ${o.accessToken}`, oauth: true, how: 'claude.ai login', stale };
  }
  return null;
}

// A gateway/proxy install points the CLI at its own endpoint; asking
// api.anthropic.com with that box's key is a 401 nobody can explain.
function anthropicBase() {
  const raw = claudeEnv('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com';
  return String(raw).replace(/\/+$/, '');
}

// A stale cache is real catalog data this box fetched earlier, so it is served
// on a failed refresh. With nothing cached, throw — the 'models' capability turns
// that into ok:false and the master reports the failure.
//
// `auth` says the catalog failed BECAUSE of the login, and only the two callers
// that actually know that pass it: no usable credential at all, and a 401/403
// from a box that has one. A timeout, a 503, an empty catalog and a network
// throw are all left unmarked, because "the model list did not arrive" and "your
// login is bad" are different claims and cli-status must not flatten one into
// the other (the same line `loggedIn: null` exists to hold). The settings card
// reads this to stop painting Ready over a login the API has rejected.
function claudeModelsOrThrow(reason, auth = false) {
  if (claudeModelCache) return claudeModelCache.models;
  const err = new Error('Failed to fetch models');
  err.code = 'MODELS_UNAVAILABLE';
  err.reason = reason;
  err.auth = auth;
  throw err;
}

async function getClaudeModels() {
  if (claudeModelCache && Date.now() - claudeModelCache.at < MODEL_CACHE_MS) return claudeModelCache.models;
  const cred = await claudeModelCred();
  if (!cred || typeof fetch !== 'function') {
    return cred
      ? claudeModelsOrThrow('no fetch available')
      : claudeModelsOrThrow('this machine has no Claude login. Run `claude` on it and sign in', true);
  }
  const headers = { 'anthropic-version': '2023-06-01', [cred.header]: cred.value };
  if (cred.oauth) headers['anthropic-beta'] = 'oauth-2025-04-20';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    // The endpoint allows 1,000 rows. Ask for its full page so "available on
    // this account" and "listed in Termdeck" stay the same set even after the
    // catalog grows; 100 was an arbitrary client-side ceiling.
    const r = await fetch(`${anthropicBase()}/v1/models?limit=1000`, { headers, signal: ctrl.signal });
    if (!r.ok) {
      // 401/403 on a box that HAS a credential is a login problem, not a network
      // one, and saying so is the difference between a fix and a support ticket.
      const why =
        r.status === 401 || r.status === 403
          ? cred.stale
            ? 'the Claude login on this machine has gone stale. Run `claude` on it once to refresh it, and sign in again if it asks'
            : `the Claude login on this machine was rejected (${r.status} from ${cred.how})`
          : `the model list request failed (${r.status})`;
      return claudeModelsOrThrow(why, r.status === 401 || r.status === 403);
    }
    const body = await r.json();
    const fetched = (body.data || []).map((m) => {
      const caps = m.capabilities || null;
      return {
        id: m.id,
        label: (m.display_name || m.id).replace(/^Claude /, ''),
        thinking: caps ? !!(caps.thinking && caps.thinking.supported) : null,
        effortLevels: claudeEffortLevels(caps),
        contextWindow: m.max_input_tokens ?? null,
      };
    });
    if (fetched.length) {
      claudeModelCache = { models: fetched, at: Date.now() };
      return fetched;
    }
  } catch (err) {
    if (err.code === 'MODELS_UNAVAILABLE') throw err; // already the honest failure
    return claudeModelsOrThrow(err.message);
  } finally {
    clearTimeout(timer);
  }
  return claudeModelsOrThrow('/v1/models returned an empty catalog');
}

/* ---------- CLI status (is each engine installed, and is its login working?) ---------- */

// Everything Termdeck does on a machine runs through one of three CLIs, and when
// one of them is signed out the symptom lands somewhere else entirely: an empty
// model picker, a turn that dies on the first frame, a limits widget that never
// fills in. Nothing in the product ever ASKED the box the direct question. This
// does, per engine, and it is deliberately cheap and read-only: a version probe
// and whatever the engine already wrote to disk about its own login. No turn is
// started, no token is refreshed, nothing is switched.
// Memoised on the BINARY's identity (path + mtime + size), not on a clock.
//
// `--version` on any of these three is a Node process start: measured at
// 0.4-1.6s for claude on a warm laptop, and cliStatus runs three of them. That
// cost landed on the reader every time, because nothing here cached and the
// browser's own memo (public/js/readiness.js) is per-document and is cleared on
// every host-status frame. The new-chat page asks on open, so it was paying for
// three process starts before it could name the machine — most of the 3-5s that
// sent us looking.
//
// A version string cannot change while the file on disk stays byte-identical, so
// there is no TTL to pick and nothing to invalidate: a reinstall or an
// `npm -g update` rewrites the file, the stat changes, and the next ask probes
// again. A stat is microseconds. An in-place edit that preserved both mtime and
// size would read stale, which is a thing no installer does.
const versionMemo = new Map(); // exe -> { key, version }

function statKey(exe) {
  try {
    const s = fs.statSync(exe);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

function runVersion(exe) {
  return new Promise((resolve) => {
    if (!exe) return resolve(null);
    const key = statKey(exe);
    const hit = key && versionMemo.get(exe);
    if (hit && hit.key === key) return resolve(hit.version);
    const win = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
    execFile(win ? `"${exe}"` : exe, ['--version'], { timeout: 8000, ...(win ? { shell: true } : {}) }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout || '').trim().split('\n')[0] || '';
      const version = line.slice(0, 80) || null;
      // Only a real answer is remembered. A spawn that failed or timed out is not
      // a fact about the binary, and caching it would outlive whatever was wrong.
      if (key && version) versionMemo.set(exe, { key, version });
      resolve(version);
    });
  });
}

const installed = (exe) => { try { return !!exe && fs.statSync(exe).isFile(); } catch { return false; } };

// grok has no accounts module of its own: its OIDC login is a map of
// "<issuer>::<client_id>" -> { email, expires_at, refresh_token } written by the
// CLI. Presence of a key is the login; expires_at is the access token only, and
// grok refreshes it itself, so an expired one is NOT signed out.
function grokLogin() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(GROK_DIR, 'auth.json'), 'utf8'));
    for (const entry of Object.values(raw || {})) {
      if (entry && (entry.key || entry.refresh_token)) {
        return { loggedIn: true, email: entry.email || null, authMethod: entry.auth_mode || null };
      }
    }
  } catch {}
  return { loggedIn: false };
}

// The other full CLI start on this path, and the one runVersion's memo does not
// cover: listAccounts' first act is `claude auth status --json` (lib/accounts.js
// authStatus), a second Node process per cli-status call on top of the three
// `--version` probes.
//
// Memoised the same way and for the same reason, but keyed on what that command
// READS rather than on the binary: `.credentials.json` holds the OAuth token and
// `.claude.json` the rest of the CLI's state, so a sign-in, a sign-out, an
// account switch or a token refresh rewrites one of them and the next ask spawns
// again. Two stats where there was a process start.
//
// Deliberately here and not in lib/accounts.js: authStatus has another caller,
// the account-switch path (switchTookEffect), and that one is asking precisely
// whether the thing it just did took effect. It must keep seeing live truth.
const claudeLoginMemo = { key: null, row: null };

function loginKey() {
  const parts = [];
  for (const f of [path.join(CLAUDE_DIR, '.credentials.json'), claudeConfigJsonPath()]) {
    parts.push(statKey(f) || '-');
  }
  return parts.join('|');
}

// Mirrors lib/accounts.js configJsonPath(): under CLAUDE_CONFIG_DIR when a file
// is actually there, else the one beside the home directory.
function claudeConfigJsonPath() {
  const base = process.env.CLAUDE_CONFIG_DIR;
  if (base) {
    const inDir = path.join(base, '.claude.json');
    try { if (fs.existsSync(inDir)) return inDir; } catch { /* fall through */ }
  }
  return path.join(os.homedir(), '.claude.json');
}

async function claudeLogin() {
  const key = loginKey();
  if (claudeLoginMemo.key === key && claudeLoginMemo.row) return claudeLoginMemo.row;
  const row = await claudeLoginUncached();
  // Only a definite answer is remembered. `loggedIn: null` is "couldn't tell",
  // and this module's header forbids ever hardening that into a verdict.
  if (row && row.loggedIn !== null) { claudeLoginMemo.key = key; claudeLoginMemo.row = row; }
  return row;
}

async function claudeLoginUncached() {
  if (accountsLib) {
    try {
      const { active } = await accountsLib.listAccounts();
      if (active) {
        return {
          loggedIn: active.loggedIn !== false,
          email: active.email || null,
          orgName: active.orgName || null,
          subscriptionType: active.subscriptionType || null,
          apiProvider: active.apiProvider || null,
          authMethod: active.authMethod || null,
        };
      }
      return { loggedIn: false };
    } catch (e) {
      return { loggedIn: null, error: e.message };
    }
  }
  // No accounts module (a very old agent, or a stripped install): fall back to
  // what is on disk. `loggedIn: null` means "couldn't tell", never "signed out".
  const o = readOauth();
  if (o && o.accessToken) return { loggedIn: true, authMethod: 'claude.ai' };
  return claudeEnv('ANTHROPIC_API_KEY') || claudeEnv('ANTHROPIC_AUTH_TOKEN') ? { loggedIn: true, authMethod: 'api key' } : { loggedIn: false };
}

async function codexLogin() {
  if (!codexAccountsLib) return { loggedIn: null };
  try {
    const { active } = await codexAccountsLib.listAccounts();
    if (!active) return { loggedIn: false };
    return {
      loggedIn: active.loggedIn !== false,
      email: active.email || null,
      orgName: active.orgName || null,
      subscriptionType: active.subscriptionType || active.planType || null,
      authMethod: active.authMethod || null,
    };
  } catch (e) {
    return { loggedIn: null, error: e.message };
  }
}

async function cliStatus() {
  const engines = await Promise.all(
    ['claude', 'codex', 'grok'].map(async (engine) => {
      const exe = ENGINES[engine];
      const present = installed(exe);
      // All three in ONE Promise.all, catalog included. The catalog used to be
      // awaited after this pair rather than beside it, so a claude row cost
      // max(version, auth) PLUS a 5s-timeout HTTP call to the models endpoint
      // instead of the max of all three. Nothing downstream reads one of the
      // three to decide another, so the sequence bought nothing.
      const [version, auth, catalog] = await Promise.all([
        present ? runVersion(exe) : Promise.resolve(null),
        engine === 'claude' ? claudeLogin() : engine === 'codex' ? codexLogin() : Promise.resolve(grokLogin()),
        // Claude's catalog is the one the browser fetches through this agent, so the
        // status page answers "why is my model picker empty?" without a second trip.
        engine === 'claude' && present
          ? getClaudeModels().then(
            (models) => ({ ok: true, count: models.length }),
            // `auth` only when this box actually established that the login is the
            // problem (claudeModelsOrThrow's own comment). Absent from an older
            // agent, which every reader treats exactly as it did before: a failure
            // with a reason and no verdict about the login.
            (e) => ({ ok: false, reason: e.reason || e.message, auth: e.auth === true }),
          )
          : Promise.resolve(null),
      ]);
      const row = { engine, installed: present, path: present ? exe : null, version, ...auth };
      // Can this machine be signed in FROM the dashboard, or only at its own
      // keyboard? Only this box can answer — it owns the CLI and the shape it
      // was installed in (lib/accounts.js signInSupport). Sent even when already
      // signed in, because the answer governs whether ADDING another account is
      // offered. Absent from an older agent, which the browser reads as "yes"
      // and behaves exactly as it did before.
      if (engine === 'claude' && present && accountsLib && accountsLib.signInSupport) {
        try { row.signIn = accountsLib.signInSupport(); } catch { /* never fail the whole status over it */ }
      }
      if (engine === 'codex' && present && codexAccountsLib && codexAccountsLib.signInSupport) {
        try { row.signIn = codexAccountsLib.signInSupport(); } catch { /* same */ }
      }
      if (catalog) row.models = catalog;
      return row;
    })
  );
  return { engines, checkedAt: Date.now() };
}

// Feature 73: how long the watch coalescer holds fs events before ONE frame
// carries the window's [path, size] pairs. A CLI writing a transcript fires
// several events per second, and each used to cost a blocking statSync and its
// own frame; the master then debounced most of them away on arrival. Anything
// this window hides, the master's own 500ms delta flush hides anyway.
const WATCH_BATCH_MS = 100;
// A registry record older than this is a crashed CLI's leftover, and its pid may
// belong to something else by now (mirrors LIVE_STALE_MS in lib/claude-data.js).
const LIVE_REGISTRY_STALE_MS = 48 * 3600 * 1000;
// The widest frame one flush may send - a mass change (a checkout restored
// whole) becomes several frames rather than one oversized one.
const WATCH_BATCH_MAX = 500;

// ---- readTail's whole-file facts, kept up to date by appends ----------------
// cumulativeUsage, prLink, cwd and the usage seed are facts about the WHOLE
// transcript, which a tail cannot see and the cost chip needs. They used to be
// one whole-file pass per (path, size, mtimeMs), so every append to a chat was
// a full re-read of it, and the memo lived inside one connection. Now the memo
// is the process's, and it keeps what makes an append cheap (features/04 phase
// 9): Claude's parse cursor, fed only the bytes past what it has seen, and for
// Codex the byte after the last complete line with the running answer there.
// A file that shrank, or whose bytes before the old end moved (the probe:
// identity plus the last bytes of what was read), is read whole again.
const TOTALS_MEMO_MAX = 200;
const TOTALS_PROBE_BYTES = 64;
const totalsMemo = new Map(); // path -> { size, mtimeMs, probe, totals, cursor | codex }

async function readRange(filePath, from, to) {
  const len = Math.max(0, to - from);
  const fd = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = len ? await fd.read(buf, 0, len, from) : { bytesRead: 0 };
    return buf.subarray(0, bytesRead);
  } finally { await fd.close(); }
}

async function fileProbe(filePath, offset) {
  const fd = await fsp.open(filePath, 'r');
  try {
    const st = await fd.stat();
    const len = Math.min(TOTALS_PROBE_BYTES, offset);
    const buf = Buffer.alloc(Math.max(0, len));
    const { bytesRead } = len > 0 ? await fd.read(buf, 0, len, offset - len) : { bytesRead: 0 };
    return `${st.dev}:${st.ino}:${buf.subarray(0, bytesRead).toString('base64')}`;
  } finally { await fd.close(); }
}

// Two running usage totals, field by field (machine-host's addCumulative).
function addUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k];
    const y = b[k];
    out[k] = typeof x === 'number' || typeof y === 'number' ? (x || 0) + (y || 0) : null;
  }
  return out;
}

// Whole-file facts for (path, size, mtimeMs). Claude goes through its cursor
// rather than the one-shot because the usage seed (the last message.id whose
// usage was summed) lives only in the cursor's state, and a running total
// handed out without its seed is a total the next delta can double-count.
// Grok keeps none of these on its transcript (its cwd is in summary.json, its
// usage is per turn), so it costs no pass at all.
async function totalsFor(engine, filePath, size, mtimeMs) {
  const none = { cumulativeUsage: null, prLink: null, cwd: null, usageId: null };
  if (!transcriptLib || engine === 'grok') return none;
  const hit = totalsMemo.get(filePath);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) {
    totalsMemo.delete(filePath); totalsMemo.set(filePath, hit); // LRU touch
    return hit.totals;
  }
  const remember = (entry) => {
    totalsMemo.delete(filePath);
    totalsMemo.set(filePath, entry);
    while (totalsMemo.size > TOTALS_MEMO_MAX) totalsMemo.delete(totalsMemo.keys().next().value);
    return entry.totals;
  };
  let grew = false;
  if (hit && size > hit.size) {
    try { grew = (await fileProbe(filePath, hit.size)) === hit.probe; } catch { grew = false; }
  }
  if (engine === 'claude') {
    if (grew && hit.cursor) {
      const out = hit.cursor.feed(await readRange(filePath, hit.cursor.bytesSeen(), size));
      if (!out.needsRescan) {
        const st = hit.cursor.state();
        const totals = {
          cumulativeUsage: addUsage(hit.totals.cumulativeUsage, out.usageDelta || null),
          prLink: out.prLink || hit.totals.prLink,
          cwd: hit.totals.cwd || out.cwd || null, // first-wins, like the scanner
          usageId: st.turnState && st.turnState.usageId ? st.turnState.usageId : null,
        };
        return remember({ size, mtimeMs, probe: await fileProbe(filePath, size), totals, cursor: hit.cursor });
      }
    }
    const cursor = transcriptLib.createParseCursor('claude', { ringBytes: 0 });
    const out = cursor.feed(await readRange(filePath, 0, size));
    const st = cursor.state();
    const totals = { cumulativeUsage: out.cumulativeUsage || null, prLink: out.prLink || null, cwd: out.cwd || null, usageId: st.turnState && st.turnState.usageId ? st.turnState.usageId : null };
    return remember({ size, mtimeMs, probe: await fileProbe(filePath, size), totals, cursor: out.needsRescan ? null : cursor });
  }
  // Codex: its cumulativeUsage is the LAST token_count's total, not a sum, and
  // its cwd is the head's, so an append only has to be scanned for a newer
  // total. `committed` is the answer up to the last complete line (`offset`);
  // an unterminated last record is read for the answer but not committed.
  const from = grew && hit.codex ? hit.codex.offset : 0;
  const buf = await readRange(filePath, from, size);
  const nl = buf.lastIndexOf(0x0a);
  const complete = nl === -1 ? '' : buf.subarray(0, nl + 1).toString('utf8');
  const tail = buf.subarray(nl + 1).toString('utf8');
  const parsed = complete ? transcriptLib.parseRolloutText(complete, 0, null) : { cumulativeUsage: null, cwd: null };
  const base = from > 0 ? hit.codex : { usage: null, cwd: null };
  const committed = { offset: from + nl + 1, usage: parsed.cumulativeUsage || base.usage, cwd: base.cwd || parsed.cwd || null };
  const tailParsed = tail.trim() ? transcriptLib.parseRolloutText(tail, 0, null) : null;
  const totals = {
    cumulativeUsage: (tailParsed && tailParsed.cumulativeUsage) || committed.usage || null,
    prLink: null,
    cwd: committed.cwd || (tailParsed && tailParsed.cwd) || null,
    usageId: null,
  };
  return remember({ size, mtimeMs, probe: await fileProbe(filePath, size), totals, codex: committed });
}

// The background shells a transcript recorded, kept per file and fed only the
// lines appended since the last ask (features/04 phase 9). Same probe rule as
// the totals above: a file that did not simply grow is scanned whole.
const SHELL_MEMO_MAX = 64;
const shellMemo = new Map(); // path -> { size, probe, offset, scanner }
async function shellsFor(filePath) {
  const st = await fsp.stat(filePath);
  const hit = shellMemo.get(filePath);
  let base = null;
  if (hit && st.size >= hit.size) {
    try { if ((await fileProbe(filePath, hit.offset)) === hit.probe) base = hit; } catch {}
  }
  const from = base ? base.offset : 0;
  const scanner = base ? base.scanner : transcriptLib.createShellScanner();
  const buf = await readRange(filePath, from, st.size);
  const nl = buf.lastIndexOf(0x0a);
  if (nl !== -1) scanner.feed(buf.subarray(0, nl + 1).toString('utf8'));
  const offset = from + nl + 1;
  shellMemo.delete(filePath);
  shellMemo.set(filePath, { size: st.size, offset, probe: await fileProbe(filePath, offset), scanner });
  while (shellMemo.size > SHELL_MEMO_MAX) shellMemo.delete(shellMemo.keys().next().value);
  // An unterminated last record is part of this answer, never of the memo.
  const tail = buf.subarray(nl + 1).toString('utf8');
  let read = scanner;
  if (tail.trim()) {
    read = scanner.clone();
    read.feed(tail);
  }
  // `runs` is how each backgrounded Agent run ended, by tool_use_id (a scanner
  // from an older transcript.js has no runEndings, and a master that predates
  // the field ignores it).
  return { shells: read.result(), runs: read.runEndings ? read.runEndings() : null };
}

// ONE session index per process, like the engine-run registry: it outlives the
// connection (makeCapabilities runs once per dial), which is the whole point of
// it. Read TERMDECK_HOME at first use, not at load, for the reason uploadsRoot
// gives. Null on an install missing either module.
let defaultIndex;
function agentVersion() {
  try { return require('./package.json').version || null; } catch { return null; }
}
function makeSessionIndex(confinedFn, file) {
  if (!sessionIndexLib || !indexHeadLib) return null;
  return sessionIndexLib.createSessionIndex({
    file,
    version: agentVersion(),
    candidate: indexCandidate,
    readHead: (ask) => indexHeadLib.readIndexHead(ask, headIo()),
    confined: confinedFn,
  });
}
function defaultSessionIndex() {
  if (defaultIndex === undefined) {
    const home = process.env.TERMDECK_HOME || path.join(os.homedir(), '.termdeck');
    defaultIndex = makeSessionIndex(confined, path.join(home, 'session-index.json'));
  }
  return defaultIndex;
}

function makeCapabilities(send, opts = {}) {
  // The roots this instance guards against. Defaults are the environment's, so the
  // agent behaves exactly as it did; a test passes { roots: { claudeDir, codexHome,
  // grokDir } } and gets a capability set that answers about a fixture. Shadowing
  // the module-level bindings on purpose: every guard in this file already names
  // `confined`, `REAL_ROOTS`, `rootOf` and `CLAUDE_DIR`, so injecting is one
  // declaration here rather than an argument threaded through forty case bodies.
  const { REAL_ROOTS, rootOf, confined, dirs, ROOTS } = opts.roots ? makeConfinement(opts.roots) : DEFAULT_CONFINEMENT;
  const CLAUDE_DIR = dirs.claudeDir;
  const GROK_DIR = dirs.grokDir;

  // The three libraries this instance drives, injected on the same terms as
  // `roots` above: the default is the module's own binding, so the agent behaves
  // exactly as it did, and a test hands in a double. Same one-declaration trick:
  // every site below already names `chokidarLib` and `procTree`.
  //
  // `!== undefined` rather than `||` for two of them, because passing `null` is a
  // MEANINGFUL argument: it is the box where chokidar would not load or where
  // proc-tree is missing from the install, and those two branches are the ones
  // that answer a person "this machine cannot watch" and "update the agent"
  // instead of doing the work. Until now neither was reachable from a test at
  // all, so the only way to see either sentence was to break an install.
  const chokidarLib = opts.chokidar !== undefined ? opts.chokidar : chokidar;
  const procTree = opts.procTree !== undefined ? opts.procTree : procTreeLib;

  // The providers, on the same terms again. These are the frames that shell out or
  // talk to a network service, and until they were injectable not one of them could
  // be asked a question without a real Claude login, a real ChatGPT login, a real
  // git checkout and a real ~/.claude to walk. That is why all seven had no test.
  //
  // Two shapes, and the difference is whether `null` means anything on a real box:
  //
  //   `||`, for the modules a box always has. limits/usage/diff are plain requires,
  //   not guarded ones, and no case has ever had a missing-module branch for them,
  //   so `null` would only produce a capability set that throws a TypeError where
  //   the shipped one throws MODULE_NOT_FOUND. Kept as a thunk rather than a value
  //   because that is the call shape the cases had: `require('./usage')` inside the
  //   handler means a box that never opens #/usage never loads it, and hoisting it
  //   to a module binding here would quietly change that. (`./limits` is already
  //   loaded at module scope by setCodexExe, so its thunk only preserves the shape.)
  //
  //   `!== undefined`, for the guarded ones. A `null` here is a real machine
  //   mid-rollout whose install is missing that file, and its refusal sentence is
  //   what a person reads. Same reasoning that made { chokidar, procTree } worth
  //   injecting rather than defaulting.
  const limitsMod = opts.limits ? () => opts.limits : () => require('./limits');
  const usageMod = opts.usage ? () => opts.usage : () => require('./usage');
  const diff = opts.diff || diffLib;
  const mcpConfig = opts.mcpConfig !== undefined ? opts.mcpConfig : mcpConfigLib;
  const accounts = opts.accounts !== undefined ? opts.accounts : accountsLib;
  const codexAccounts = opts.codexAccounts !== undefined ? opts.codexAccounts : codexAccountsLib;
  const codexAttachment = opts.codexAttachment !== undefined ? opts.codexAttachment : codexAttachmentLib;
  // The two that are a FUNCTION rather than a module, because that is the seam
  // that exists: both are module-level in this file, both close over the process's
  // own ENGINES and credential paths, and both reach the network. Injecting the
  // call rather than carving out two new agent files keeps AGENT_FILES where it is
  // and still makes every branch of the two cases reachable, which is all the
  // conversion needs: what is in the CASE is an engine allowlist and a failure
  // shape, and the failure shape is the part that has silently differed before.
  const claudeModels = opts.claudeModels || getClaudeModels;
  const cliStatusFn = opts.cliStatus || cliStatus;

  // The engine allowlist this instance will start, injected last and on `||` terms:
  // `ENGINES` is resolved once at module load off three env vars and the disk, so a
  // process had exactly one answer to "which claude" and a test could not spawn
  // anything it was willing to be responsible for. This is the whole of what makes
  // an engine run narrow, and until it was injectable the only way to exercise it
  // was to run a real coding CLI, which the suite rules forbid outside the live tier.
  const engineExes = opts.engines || ENGINES;

  // The session index: the process's own for the real roots, a memory-only one
  // per instance for a test's fixture roots (their confinement is not the
  // process's), or whatever the test hands in.
  const sessionIndex = opts.sessionIndex !== undefined ? opts.sessionIndex
    : opts.roots ? makeSessionIndex(confined, null) : defaultSessionIndex();

  const watchers = new Map(); // watchId -> chokidar watcher
  const watchBatches = new Map(); // watchId -> { paths: Set, timer } - the fs-event coalescer (feature 73)
  const runs = opts.runs || DEFAULT_RUNS; // engine runs; module-level, they outlive this connection
  const engineSubs = new Map(); // engineEvents id -> unsubscribe, for this connection only

  // ---------------------------------------------------------------------------
  // Converted ops
  // ---------------------------------------------------------------------------
  // A handler returns the FIELDS of its reply and the registry stamps the rest:
  // `t` off the row in agent-protocol.js, `id` off the request, `ok` off whether it
  // threw. That is the whole prize of this conversion. This file carried 163
  // hand-written send({ t: ... }) sites, and every one of them was a chance to
  // stamp a type the master does not dispatch on; a mis-stamped type is a frame the
  // master bins while its caller waits out the full timeout.
  //
  // The plan wrote defineOp({ name, reply, timeoutMs, handler }). `reply` and
  // `timeoutMs` are not arguments here: the row already holds both, and a second
  // copy in this file is exactly the drift the table was written to end.
  //
  // `onError` is for the ops whose UNEXPECTED failures do not all read the same
  // way. Most report the errno; a few translate EACCES into a sentence and carry
  // their own code so the browser can tell "you cannot read this" from "this went
  // wrong". It returns the failure BODY and the registry stamps the envelope, so
  // there is still exactly one place a reply type can be written.
  const ops = new Map();
  const defineOp = (name, handler, { onError = null } = {}) => {
    const row = protocol.frame(name);
    // Thrown at CONSTRUCTION, not on the frame: an op defined under a name the
    // table does not carry fails the first test that builds a capability set,
    // rather than the first customer who asks for it.
    if (!row) throw new Error(`defineOp('${name}'): agent-protocol.js has no row for it`);
    ops.set(name, { family: row.family, reply: row.reply, handler, onError });
  };

  // The two failure translations the ops below share. EACCES/EPERM is the one
  // errno a person can act on ("this is not yours to read"), so it becomes a
  // sentence; everything else stays a code the log can be grepped for.
  const denied = (e) => !!e && (e.code === 'EACCES' || e.code === 'EPERM');

  // The registry's default failure body is `e.code || e.message`, which is right
  // for a disk read: ENOENT says everything a caller needs. It is wrong for
  // anything that shells out or calls a provider, where the code is the transport's
  // ("ENOENT" for a missing binary, "ERR_BAD_REQUEST" for an HTTP client) and the
  // MESSAGE is the only part that names what went wrong. Every one of those cases
  // reported `e.message` by hand; this is that, once.
  const justMessage = { onError: (e) => ({ error: e && e.message }) };

  // ---- family 1: the confined reads ------------------------------------------
  // Converted first because all five are the same shape exactly: a confinement
  // guard, one read, and an errno on the way out. tests/agent-capability-reads.mjs
  // covers them, and covers them against a fixture rather than the developer's own
  // ~/.claude, which is what the roots injection above bought.

  defineOp('stat', async (m) => {
    if (!(await confined(m.path))) throw fail('path not permitted');
    const s = await fsp.stat(m.path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  });

  defineOp('list', async (m) => {
    if (!(await confined(m.path))) throw fail('path not permitted');
    const ents = await fsp.readdir(m.path, { withFileTypes: true });
    const entries = [];
    for (const e of ents) {
      let size = 0, mtimeMs = 0;
      if (e.isFile()) { try { const s = await fsp.stat(path.join(m.path, e.name)); size = s.size; mtimeMs = s.mtimeMs; } catch {} }
      entries.push({ name: e.name, dir: e.isDirectory(), size, mtimeMs });
    }
    return { entries };
  });

  // Recursive file walk (one round trip vs one-per-dir). Files only, capped. Confined.
  defineOp('listTree', async (m) => {
    if (!(await confined(m.path))) throw fail('path not permitted');
    const ents = await fsp.readdir(m.path, { recursive: true, withFileTypes: true });
    const files = [];
    for (const e of ents) {
      if (!e.isFile()) continue;
      const full = path.join(e.parentPath || m.path, e.name);
      let st; try { st = await fsp.stat(full); } catch { continue; }
      files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
      if (files.length >= 4000) break; // ponytail: cap the payload; enrich w/ agent-side index if a fleet outgrows it
    }
    return { files };
  });

  // Answers `fileChunk`, not `readFile`. One of the three frames whose reply is not
  // named after its request, which is precisely the pairing nobody could hold in
  // their head before the table wrote it down.
  defineOp('readFile', async (m) => {
    if (!(await confined(m.path))) throw fail('path not permitted');
    const fd = await fsp.open(m.path, 'r');
    try {
      const st = await fd.stat();
      const offset = m.offset || 0;
      const len = m.len == null ? Math.max(0, st.size - offset) : m.len;
      const buf = Buffer.alloc(Math.max(0, len));
      const { bytesRead } = len > 0 ? await fd.read(buf, 0, len, offset) : { bytesRead: 0 };
      // A Buffer, not base64. sendReply decides how it crosses the wire; this
      // handler has no opinion and no longer pays a +33% encode either way.
      return { data: buf.subarray(0, bytesRead), size: st.size, eof: offset + bytesRead >= st.size };
    } finally { await fd.close(); }
  });

  // Answers `tailChunk`. The last bytes of a transcript, from a line boundary, plus
  // how many lines precede them. Same confinement as readFile because it IS a
  // readFile, with the offset chosen HERE because only this side can see the file
  // cheaply. It is what stops a 51 MB chat from crossing the tunnel to show fifteen
  // messages; the counting pass is local disk I/O.
  //
  // features/04 phase 4 grew the request and the reply, all optional, all
  // shape-gated on the master's side so an older agent's answer still works:
  //   fillTo { preview, cap, engine }  widen the window HERE, from 64 KiB up to
  //                                    `cap`, until `preview` messages parse
  //                                    from it. The master used to escalate
  //                                    itself, one tunnel round trip per rung.
  //   totals                           one whole-file META pass, memoised by
  //                                    (path, size, mtimeMs): cumulativeUsage,
  //                                    prLink, cwd and the usage seed, which a
  //                                    tail cannot see and the cost chip needs.
  //   turnHint                         the codex/grok turn in effect at the cut,
  //                                    so a tail-born cursor carries a real turn
  //                                    id and is resumable.
  // and answers `cutOffset` (the byte `data` starts at), `totals`, `lastTurnId`.
  const tailEngineOf = (m) => {
    const e = (m.fillTo && m.fillTo.engine) || m.engine;
    return e === 'codex' || e === 'grok' ? e : 'claude';
  };
  const parseTailText = (engine, text) => {
    if (engine === 'codex') return transcriptLib.parseRolloutText(text, 0, null);
    if (engine === 'grok') return transcriptLib.parseGrokUpdatesText(text, 0, null);
    return transcriptLib.parseTranscriptText(text, 0);
  };
  // The turn in effect at `cutOffset`: the last task_started (codex) or the
  // last promptId (grok) before it, scanned backwards in bounded chunks. A
  // task_started that names no turn_id ends the scan with null rather than
  // reaching past it to an OLDER turn, which would be the wrong answer.
  const lastTurnIdBefore = async (engine, filePath, cutOffset) => {
    if (engine === 'codex') {
      const hit = await tailReadLib.scanBackLines(filePath, cutOffset, (line) => {
        if (line.indexOf('task_started') < 0) return null;
        let rec; try { rec = JSON.parse(line); } catch { return null; }
        if (!rec || rec.type !== 'event_msg' || !rec.payload || rec.payload.type !== 'task_started') return null;
        return { id: typeof rec.payload.turn_id === 'string' && rec.payload.turn_id ? rec.payload.turn_id : null };
      });
      return hit ? hit.id : null;
    }
    if (engine === 'grok') {
      const hit = await tailReadLib.scanBackLines(filePath, cutOffset, (line) => {
        if (line.indexOf('promptId') < 0 && line.indexOf('prompt_id') < 0) return null;
        let rec; try { rec = JSON.parse(line); } catch { return null; }
        const id = transcriptLib.grokPromptId(rec);
        return id ? { id } : null;
      });
      return hit ? hit.id : null;
    }
    return null;
  };
  defineOp('readTail', async (m) => {
    if (!(await confined(m.path))) throw fail('path not permitted');
    if (!tailReadLib) throw fail('agent outdated: tail-read.js missing', 'AGENT_OUTDATED');
    const maxBytes = Math.max(4096, Math.min(8 * 1024 * 1024, m.maxBytes || tailReadLib.TAIL_BYTES));
    // headBytes: some engines write model/effort/permission mode ONCE at the top of
    // the rollout, so the master asks for the opening records too. Bounded here as
    // well: this is a capability, not a file server.
    const headBytes = Math.max(0, Math.min(256 * 1024, m.headBytes || 0));
    const engine = tailEngineOf(m);
    const fill = m.fillTo && typeof m.fillTo === 'object' && transcriptLib ? m.fillTo : null;
    let tail;
    if (fill) {
      const preview = Math.max(0, Math.min(100, Math.floor(fill.preview) || 0));
      const cap = Math.max(maxBytes, Math.min(8 * 1024 * 1024, fill.cap || tailReadLib.TAIL_BYTES_MAX));
      // The ladder starts under the master's budget on purpose: 64 KiB fills
      // most chats, and the budget it named is the rung an older agent would
      // have read in one go.
      const windows = [Math.min(tailReadLib.FILL_WINDOWS[0], maxBytes), maxBytes, ...tailReadLib.FILL_WINDOWS];
      tail = await tailReadLib.readTailFilled(m.path, {
        windows,
        cap,
        headBytes,
        filled: (t) => {
          if (!(preview > 0)) return true;
          let count = 0;
          try { count = parseTailText(engine, t.buf.toString('utf8')).messages.length; } catch { return true; }
          return !tailReadLib.tailUnderfilled({ messageCount: count, preview, whole: t.whole });
        },
      });
    } else {
      tail = await tailReadLib.readTail(m.path, maxBytes, { headBytes });
    }
    const out = {
      data: tail.buf,
      head: tail.head || null,
      startLine: tail.startLine,
      cutOffset: tail.cutOffset || 0,
      whole: tail.whole,
      size: tail.size,
      mtimeMs: tail.mtimeMs,
    };
    if (m.totals && transcriptLib) out.totals = await totalsFor(engine, m.path, tail.size, tail.mtimeMs);
    if (m.turnHint && transcriptLib && engine !== 'claude') {
      out.lastTurnId = tail.whole ? null : await lastTurnIdBefore(engine, m.path, out.cutOffset);
    }
    return out;
  });

  // One page of scroll-back (features/04 phase 5): the whole lines ending at
  // `endOffset`, from a line boundary, widened here over the ladder readTail
  // climbs until `fillTo.preview` messages parse from the page. The master
  // used to answer a page off a whole-file parse it had to pull across the
  // tunnel first; this crosses the page's own bytes and nothing else.
  defineOp('readBefore', async (m) => {
    if (!(await confined(m.path))) throw fail('path not permitted');
    if (!tailReadLib || !tailReadLib.readBeforeFilled) throw fail('agent outdated: tail-read.js missing', 'AGENT_OUTDATED');
    const endOffset = Math.max(0, Math.floor(Number(m.endOffset)) || 0);
    // The same 8 MiB this side clamps every window ask to is the most one
    // RECORD may cost a page: a longer line is skipped (an empty page, the
    // cut at its start, `skippedBytes` saying so), never shipped whole.
    const lineMax = 8 * 1024 * 1024;
    const maxBytes = Math.max(4096, Math.min(lineMax, m.maxBytes || tailReadLib.TAIL_BYTES));
    const engine = tailEngineOf(m);
    const fill = m.fillTo && typeof m.fillTo === 'object' && transcriptLib ? m.fillTo : null;
    let page;
    if (fill) {
      const preview = Math.max(0, Math.min(200, Math.floor(fill.preview) || 0));
      const cap = Math.max(maxBytes, Math.min(lineMax, fill.cap || tailReadLib.TAIL_BYTES_MAX));
      const windows = [Math.min(tailReadLib.FILL_WINDOWS[0], maxBytes), maxBytes, ...tailReadLib.FILL_WINDOWS];
      page = await tailReadLib.readBeforeFilled(m.path, endOffset, {
        windows,
        cap,
        lineMax,
        filled: (p) => {
          if (!(preview > 0)) return true;
          let count = 0;
          try { count = parseTailText(engine, p.buf.toString('utf8')).messages.length; } catch { return true; }
          return count >= preview;
        },
      });
    } else {
      page = await tailReadLib.readBefore(m.path, endOffset, maxBytes, { lineMax });
    }
    const out = {
      data: page.buf,
      startLine: page.startLine,
      cutOffset: page.cutOffset || 0,
      whole: page.whole,
      size: page.size,
      mtimeMs: page.mtimeMs,
      skippedBytes: page.skippedBytes || 0,
    };
    if (m.turnHint && transcriptLib && engine !== 'claude') {
      out.lastTurnId = page.whole ? null : await lastTurnIdBefore(engine, m.path, out.cutOffset);
    }
    return out;
  });

  // Where jsonl line `line` starts, counted on this disk (features/04 phase 4).
  // The one question a browser that lost its cursor token still has an answer
  // to is its LINE count, and this turns that back into a byte the master can
  // resume from with one offset read instead of the whole file.
  defineOp('lineOffset', async (m) => {
    if (!(await confined(m.path))) throw fail('path not permitted');
    if (!tailReadLib || !tailReadLib.lineOffset) throw fail('agent outdated: tail-read.js missing', 'AGENT_OUTDATED');
    return tailReadLib.lineOffset(m.path, Number(m.line) || 0);
  });

  // The background shells one transcript records, scanned where the file is.
  // Same scanner the master used to run over the whole file after pulling it
  // across the tunnel; a few hundred bytes of records come back instead.
  defineOp('bgShellScan', async (m) => {
    if (!(await confined(m.path))) throw fail('path not permitted');
    if (!transcriptLib || !transcriptLib.scanBackgroundShells) throw fail('agent outdated: transcript.js missing', 'AGENT_OUTDATED');
    if (!transcriptLib.createShellScanner) return { shells: transcriptLib.scanBackgroundShells(await fsp.readFile(m.path, 'utf8')) };
    return shellsFor(m.path);
  });

  // ---- family 2: the folder picker -------------------------------------------
  // The three frames that deliberately reach OUTSIDE the transcript roots, because
  // the thing they exist for is choosing a project folder, and a project folder is
  // by definition not under .claude/.codex. They stay narrow on every other axis
  // instead, and each of those narrowings is a test in
  // tests/agent-capability-fs.mjs rather than a comment nobody can check.

  // Boolean-only validation for a user-supplied project folder. This does not list
  // or read the directory; it mirrors the spawn-time cwd stat.
  defineOp('cwdCheck', async (m) => {
    const cwd = typeof m.path === 'string' ? m.path : '';
    if (!cwd) throw fail('Folder is required', 'BAD_CWD');
    let st;
    try { st = await fsp.stat(cwd); } catch { throw fail(`Folder does not exist: ${cwd}`, 'BAD_CWD'); }
    if (!st.isDirectory()) throw fail(`Not a folder: ${cwd}`, 'BAD_CWD');
    return { cwd };
  });

  // Folder picker (Settings, Projects, "Add folder"). DELIBERATELY OUTSIDE the
  // ROOTS confinement, and narrow in the other two axes instead: DIRECTORY NAMES
  // ONLY (no file names, no contents, no sizes; readFile is still root-confined and
  // always will be), and read-only. 'spawn' already takes an arbitrary cwd and
  // 'cwdCheck' already stats an arbitrary path, so the master could already probe a
  // path it guessed; this lets it enumerate rather than guess. That IS a real
  // widening, a master compromise can now map the customer's directory tree,
  // accepted knowingly so the cloud picker matches the hub's. It still cannot read
  // a single byte of any file it finds.
  defineOp('fsList', async (m) => {
    const dir = typeof m.path === 'string' && m.path.trim() ? path.resolve(m.path.trim()) : os.homedir();
    let st;
    try { st = await fsp.stat(dir); } catch { throw fail(`Folder does not exist: ${dir}`, 'BAD_CWD'); }
    if (!st.isDirectory()) throw fail(`Not a folder: ${dir}`, 'BAD_CWD');
    try {
      const ents = await fsp.readdir(dir, { withFileTypes: true });
      const entries = [];
      let truncated = false;
      for (const e of ents) {
        let isDir = e.isDirectory();
        if (!isDir && e.isSymbolicLink()) {
          try { isDir = (await fsp.stat(path.join(dir, e.name))).isDirectory(); } catch { isDir = false; }
        }
        if (!isDir || e.name.startsWith('.')) continue;
        if (entries.length >= 500) { truncated = true; break; }
        entries.push({ name: e.name, path: path.join(dir, e.name) });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      const parent = path.dirname(dir);
      return { path: dir, parent: parent === dir ? null : parent, home: os.homedir(), sep: path.sep, entries, truncated };
    } catch (e) {
      const denied = e.code === 'EACCES' || e.code === 'EPERM';
      throw fail(denied ? `Permission denied: ${dir}` : (e.code || e.message), 'FS_LIST_FAILED');
    }
  });

  // The agent's only write outside a transcript root, and it is one mkdir of one
  // NAMED CHILD under an existing parent: a separator in the name is rejected, so
  // there is no path to traverse with, and mkdir is non-recursive so a wrong parent
  // errors instead of being conjured up. It creates an EMPTY directory and nothing
  // else: no file ever gets written through this, and nothing existing can be
  // touched (EEXIST).
  defineOp('fsMkdir', async (m) => {
    const parent = typeof m.parent === 'string' ? m.parent.trim() : '';
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    if (!parent) throw fail('Parent folder is required', 'BAD_CWD');
    if (!name || name === '.' || name === '..' || name.length > 100 || /[\\/:*?"<>|\x00-\x1f]/.test(name)) {
      throw fail('That name has characters a folder can’t contain.', 'BAD_NAME');
    }
    const dir = path.join(parent, name);
    // Belt and braces on the separator check above: whatever the name was, the
    // thing being created must be a DIRECT child of the parent that was named.
    if (path.dirname(path.resolve(dir)) !== path.resolve(parent)) {
      throw fail('That name has characters a folder can’t contain.', 'BAD_NAME');
    }
    try {
      await fsp.mkdir(dir);
    } catch (e) {
      if (e.code === 'EEXIST') throw fail(`“${name}” already exists here.`, 'EEXIST');
      const denied = e.code === 'EACCES' || e.code === 'EPERM';
      throw fail(e.code === 'ENOENT' ? `Folder does not exist: ${parent}` : denied ? `Permission denied: ${parent}` : (e.code || e.message), 'MKDIR_FAILED');
    }
    return { path: dir };
  });

  // An attachment, staged where a CLI can read it. The second write outside a
  // transcript root, and the first that carries BYTES THE MASTER CHOSE, so it is
  // the narrowest thing in this file:
  //
  //   * the directory is computed HERE, never taken from the request. The master
  //     names a bucket and a file name; it cannot name a path. ~/.termdeck is
  //     the agent's own home and uploads/ is one directory inside it.
  //   * the bucket must match BUCKET_RE (no separators, no '..'), and the file
  //     name goes through safeUploadName, which throws away everything that
  //     could make it point elsewhere. Both checks ran on the master already;
  //     this is the run that matters, because it is the one on the user's box.
  //   * the extension must be on lib/upload-types.js's list. A .sh or a .dll is
  //     refused here and not merely left out of the picker, so a master that
  //     asked for one gets a named refusal in the agent's log.
  //   * 'wx' and mode 0600: the write fails if anything already exists at that
  //     name, symlink included, so nothing here can be aimed at a file that
  //     matters by planting a link first, and nothing lands executable.
  //
  // Uploads are turn INPUTS, not storage: every write first sweeps buckets
  // nothing has touched for UPLOAD_TTL_MS, which is the only thing that ever
  // deletes them.
  defineOp('upload', async (m) => {
    if (!uploadTypesLib) throw fail('agent is out of date (upload-types module missing). Update the agent', 'AGENT_OUTDATED');
    const bucket = typeof m.bucket === 'string' ? m.bucket.trim() : '';
    if (!uploadTypesLib.validBucket(bucket)) throw fail('bad bucket', 'BAD_BUCKET');
    const name = uploadTypesLib.safeUploadName(m.name);
    if (!name) throw fail('That file name has nothing usable left in it.', 'BAD_NAME');
    if (!uploadTypesLib.kindFor(name)) throw fail(`Termdeck does not upload ${uploadTypesLib.extOf(name) || 'files with no extension'}`, 'UNSUPPORTED_TYPE');
    const data = typeof m.data === 'string' ? m.data : '';
    const buf = Buffer.from(data, 'base64');
    if (!buf.length) throw fail('That file arrived empty.', 'WRITE_FAILED');
    if (buf.length > uploadTypesLib.UPLOAD_MAX_BYTES) throw fail('That file is over the upload limit.', 'TOO_BIG');

    const root = uploadsRoot();
    const dir = path.join(root, bucket);
    // Same belt-and-braces as fsMkdir: whatever the strings were, the directory
    // being written into must be a DIRECT child of the uploads root.
    if (path.dirname(path.resolve(dir)) !== path.resolve(root)) throw fail('bad bucket', 'BAD_BUCKET');
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (e) {
      throw fail(e.code || e.message, 'WRITE_FAILED');
    }
    await sweepUploads(root);

    // Two sends of the same file name are two files, not an overwrite: the first
    // one may already be named in a prompt that is still running.
    const ext = uploadTypesLib.extOf(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    let dst = path.join(dir, name);
    for (let n = 2; n <= 50; n += 1) {
      try {
        await fsp.writeFile(dst, buf, { mode: 0o600, flag: 'wx' });
        // `dir` is the bucket, sent back because the master cannot compute it:
        // this path was built with THIS box's separator, and a Windows agent
        // answering a POSIX master makes path.dirname the wrong tool. Claude's
        // turn adds it with --add-dir (lib/attachments.js uploadDirs).
        return { path: dst, dir, name: path.basename(dst), bytes: buf.length, kind: uploadTypesLib.kindFor(name) };
      } catch (e) {
        if (e.code !== 'EEXIST') throw fail(e.code || e.message, 'WRITE_FAILED');
        dst = path.join(dir, `${stem}-${n}${ext}`);
      }
    }
    throw fail('Too many files by that name are already staged.', 'WRITE_FAILED');
  });

  // ---- family 3: the write path ----------------------------------------------
  // The agent's ONLY write inside a transcript root, and the reason it stays inside
  // one: every target is confined(), and 'trash' moves into a hidden dir INSIDE that
  // same root (never ~/.termdeck, never anywhere else), so a master compromise still
  // cannot write outside .claude/.codex. tests/agent-capability-mutate.mjs is the
  // first thing that has ever checked that, rather than reading it.
  defineOp('mutate', async (m) => {
    if (!(await confined(m.path))) throw fail('path not permitted');

    if (m.op === 'trash') {
      const rp = await fsp.realpath(m.path);
      const root = rootOf(rp);
      if (!root) throw fail('path not permitted');
      const trashDir = path.join(root, '.termdeck-trash');
      await fsp.mkdir(trashDir, { recursive: true });
      await moveFile(rp, path.join(trashDir, `${Date.now()}-${path.basename(rp)}`));
      return {};
    }

    if (m.op === 'duplicate') {
      // Claude-only (plain .jsonl). The master picks newId; the destination is
      // computed HERE (same dir, using this box's own path rules) so a Windows
      // agent doesn't get a POSIX-joined path from the master. An optional newCwd
      // moves the clone into THAT folder's own project dir (same slug rule the CLI
      // itself uses), mirroring the 'spawn' cwd check: an existing folder, or a
      // clear error, never a silent wrong-directory clone.
      if (typeof m.newId !== 'string' || !/^[0-9a-f-]{36}$/i.test(m.newId)) throw fail('bad newId');
      const rp = await fsp.realpath(m.path);
      let dst = path.join(path.dirname(rp), `${m.newId}.jsonl`);
      const newCwd = typeof m.newCwd === 'string' && m.newCwd.trim() ? m.newCwd.trim() : null;
      if (newCwd) {
        let isDir = false;
        try { isDir = fs.statSync(newCwd).isDirectory(); } catch {}
        if (!isDir) throw fail('bad cwd');
        const destDir = path.join(CLAUDE_DIR, 'projects', newCwd.replace(/[^A-Za-z0-9]/g, '-'));
        if (!(await confined(destDir))) throw fail('dst not permitted');
        await fsp.mkdir(destDir, { recursive: true });
        dst = path.join(destDir, `${m.newId}.jsonl`);
      }
      if (!(await confined(dst))) throw fail('dst not permitted');
      // Validated here as well as master-side: this decides how much of a
      // customer's transcript the clone keeps.
      const upTo = typeof m.upTo === 'string' && /^[0-9a-f-]{36}$/i.test(m.upTo) ? m.upTo : null;
      let out;
      try {
        out = rewriteDuplicateTranscript(await fsp.readFile(rp, 'utf8'), m.oldId, m.newId, newCwd, upTo);
      } catch (e) {
        // The two refusals a user can act on travel as refusals, sentence and
        // code both, so the master can answer 400 with the sentence.
        if (e && (e.code === 'BAD_FORK_POINT' || e.code === 'EMPTY_FORK')) throw fail(e.message, e.code);
        throw e;
      }
      // A branch is titled as one (the master sends "<source title> (branch)"),
      // or the sidebar shows two identical rows with nothing saying which is the
      // copy. A custom-title record, appended last, so it beats the source's own
      // title records the clone carries, and `claude --resume` shows it too.
      if (upTo && typeof m.title === 'string' && m.title.trim()) {
        out += `${JSON.stringify(require('./session-title').titleRecord(m.newId, m.title))}\n`;
      }
      await fsp.writeFile(dst, out);
      return {};
    }

    if (m.op === 'title' || m.op === 'tag' || m.op === 'ai-title') {
      // A title/tag the TERMINAL also sees (SDK-SIGNALS §E). Narrow and typed on
      // purpose, exactly like `limits` and `models`: the master names the session
      // and the string, never the record, so this cannot be used to append
      // arbitrary JSON into a transcript. The record is built HERE by the same
      // module the hub uses, so the two paths cannot write different bytes.
      const rp = await fsp.realpath(m.path);
      // Re-checked on the RESOLVED path. The guard at the top ran on the request
      // string; between the two, only this one is about the file being written.
      if (!(await confined(rp))) throw fail('path not permitted');
      const sessionTitle = require('./session-title');
      // `ai-title` is the DERIVED title Termdeck writes for a chat the CLI never
      // titled (see lib/session-title.js). Guarded on its own: an agent that pulled
      // this capabilities.js before session-title.js must say so rather than throw,
      // exactly like the module guards up top.
      if (m.op === 'ai-title' && typeof sessionTitle.aiTitleRecord !== 'function') {
        throw fail('agent is out of date (ai-title unsupported). Update the agent', 'AGENT_OUTDATED');
      }
      const record = m.op === 'title'
        ? sessionTitle.titleRecord(m.sessionId, m.title)
        : m.op === 'ai-title'
        ? sessionTitle.aiTitleRecord(m.sessionId, m.title)
        : sessionTitle.tagRecord(m.sessionId, m.tag ?? null);
      await sessionTitle.appendRecord(rp, record);
      return {};
    }

    // Unreachable: handle() refuses any op the row does not declare, and
    // tests/agent-protocol.mjs asserts every declared op has a branch above.
    // Spelled out anyway, because the alternative in a returns-a-value handler is
    // an `ok: true` with no fields, which reads to the master as a write that
    // happened.
    throw fail(`mutate has no branch for '${m.op}'`);
  });

  // ---- family 4: a chat's own project folder ---------------------------------
  // Three frames drawn on ONE design, which is why they convert together and share
  // a fixture: the master names a CONFINED TRANSCRIPT and an engine, never a path,
  // never a filename and never a cwd. Where the project root IS gets read HERE, out
  // of that transcript's own head, by the same lib/index-head.js parse the session
  // index uses.
  //
  // That is what lets them reach outside the transcript roots at all. A compromised
  // master cannot aim them at a folder of its choosing; the worst it can do is read
  // a real project belonging to a real session on this box, which is the feature.
  //
  // Nothing may throw out of these: an uncaught rejection takes the agent down and
  // view-only-locks every live chat on the machine. That is what the try/catch used
  // to be for, and it is now the registry's job plus the onError below.

  // Where a chat's project folder is, read out of the transcript's own head. Shared
  // by all three, because three copies of "resolve the root" would be three answers
  // to the question that decides what may be read.
  const rootFromTranscript = async (m, engine) => {
    const rp = await fsp.realpath(m.path);
    let sizeBytes = 0;
    try { sizeBytes = (await fsp.stat(rp)).size; } catch {}
    const head = await indexHeadLib.readIndexHead({ path: rp, engine, zst: rp.endsWith('.zst'), sizeBytes }, headIo());
    return head && head.cwd ? head.cwd : null;
  };
  const engineOf = (m) => (m.engine === 'codex' || m.engine === 'grok' ? m.engine : 'claude');

  // The project's instruction file, read and written (U5's editor, and V3 §B's `#`).
  // The filename comes from a fixed table in the shared module: a name from the
  // request would be a path from the request wearing a hat.
  defineOp('projectDoc', async (m) => {
    if (!projectDocLib || !indexHeadLib) throw fail('agent is out of date (project-doc module missing). Update the agent', 'AGENT_OUTDATED');
    if (!(await confined(m.path))) throw fail('path not permitted');
    const engine = engineOf(m);
    const cwd = await rootFromTranscript(m, engine);
    if (!cwd) throw fail('This chat has no project folder on disk yet', 'NO_CWD');
    let root;
    try { root = await fsp.realpath(cwd); } catch { throw fail(`Project folder is missing: ${cwd}`, 'NO_CWD'); }

    if (m.op === 'write') {
      const content = typeof m.content === 'string' ? m.content : '';
      return { doc: { ...(await projectDocLib.writeDoc(root, engine, content)), content } };
    }
    if (m.op === 'append') {
      const r = await projectDocLib.appendDoc(root, engine, m.text);
      return { doc: await projectDocLib.readDoc(root, engine), wrote: r.bytes };
    }
    // `read`, the row's defaultOp.
    return { doc: await projectDocLib.readDoc(root, engine) };
  }, { onError: (e) => ({ error: denied(e) ? 'Permission denied' : (e.message || e.code), code: denied(e) ? 'DENIED' : (e.code || 'DOC_FAILED') }) });

  // What this chat can type after a slash, and what each one does. Drawn on
  // projectDoc's terms with one difference: a chat with NO cwd is not an error. The
  // user's own commands are still a real answer, and a palette that refuses to open
  // because a folder was renamed is worse than one missing a few rows.
  //
  // The grok tier reads ~/.grok/{commands,skills}, which are outside this agent's
  // roots on purpose (see the note in lib/command-catalog.js).
  defineOp('commandCatalog', async (m) => {
    if (!commandCatalogLib || !indexHeadLib) throw fail('agent is out of date (command-catalog module missing). Update the agent', 'AGENT_OUTDATED');
    const engine = engineOf(m);
    let cwd = null;
    if (typeof m.path === 'string' && m.path) {
      if (!(await confined(m.path))) throw fail('path not permitted');
      try {
        const found = await rootFromTranscript(m, engine);
        if (found) cwd = await fsp.realpath(found);
      } catch { cwd = null; }
    } else if (typeof m.cwd === 'string' && m.cwd) {
      // The new-chat page: no transcript exists yet to resolve a project root from.
      // Like the 'git' capability's cwd ops, this is NOT confined to the transcript
      // roots. Projects live wherever the user codes, and the master only ever sends
      // back a path this SAME browser session chose through the folder picker.
      try { cwd = await fsp.realpath(m.cwd); } catch { cwd = null; }
    }
    return {
      data: await commandCatalogLib.readCatalog({
        engine,
        cwd,
        claudeDir: REAL_ROOTS[0],
        codexHome: REAL_ROOTS[1],
        grokDir: GROK_DIR,
      }),
    };
  }, { onError: (e) => ({ error: denied(e) ? 'Permission denied' : (e.message || e.code), code: denied(e) ? 'DENIED' : (e.code || 'CATALOG_FAILED') }) });

  // Read-only browsing of a chat's PROJECT folder. The master names a TRANSCRIPT and
  // a RELATIVE path, and nothing else.
  //
  // `includeHidden` IS a master-named flag, and that is an accepted widening
  // documented like fsList's: it comes from a per-project toggle the OWNER set in
  // Settings, the master is the only side that holds that preference, and it can
  // only ever widen within a root already resolved from the customer's own
  // transcript. It cannot name a different root.
  defineOp('projectFiles', async (m) => {
    if (!projectFilesLib || !indexHeadLib) throw fail('agent is out of date (project-files module missing). Update the agent', 'AGENT_OUTDATED');
    // The string test first, before a single fs call. See validateRelPath.
    const v = projectFilesLib.validateRelPath(m.relPath);
    if (v.error) throw fail(v.error, v.code);
    if (!(await confined(m.path))) throw fail('path not permitted');
    const engine = engineOf(m);
    const cwd = await rootFromTranscript(m, engine);
    if (!cwd) throw fail('This chat has no project folder on disk yet', 'NO_CWD');
    let root;
    try { root = await fsp.realpath(cwd); } catch { throw fail(`Project folder is missing: ${cwd}`, 'NO_CWD'); }

    // Policy runs on every segment, so `.git/config` is refused by its first rather
    // than by a rule about its last. Skipped entirely when the owner has opted in,
    // and skipped for a read that NAMES AN IMAGE.
    //
    // That last exemption is narrow and it is policy, not confinement: resolveTarget
    // below is the confinement and it runs either way. The policy exists so a file
    // tree opened on a phone cannot casually surface a private key; a picture is not
    // one, and it cannot be made into one, because readFileCapped decides the media
    // type from a CLOSED extension list that shares no member with the secret-shaped
    // names, so an exempted read can only ever come back as an <img>. Without it
    // every screenshot an agent takes into a dot-directory is a file the person who
    // asked for it is refused, and the message that links it renders broken.
    //
    // The name is only half of it: a symlink called `shot.png` is whatever it points
    // at. So an exempted path is re-checked against the RESOLVED file below, and a
    // hidden path that names no image is still refused before anything touches disk.
    const refuseHidden = (seg) => fail(`Hidden and sensitive files are turned off for this project (${seg})`, 'HIDDEN_BLOCKED');
    const asked = m.includeHidden ? null : projectFilesLib.hiddenSegment(v.segments);
    if (asked && !(m.op === 'read' && projectFilesLib.imageTypeFor(m.relPath))) throw refuseHidden(asked);

    const r = await projectFilesLib.resolveTarget(root, v.segments);
    if (r.error) throw fail(r.error, r.code);

    // ...and again on the file the path RESOLVED to, which is the half that holds. A
    // name is not evidence: `shot.png` may be a symlink to `.env`, and `notes.md`
    // may be one to `.aws/credentials`; neither has a hidden segment to refuse, so a
    // policy that only ever reads the REQUEST is one any project can walk straight
    // past. Containment is already settled above (resolveTarget realpaths and
    // re-compares); this is the policy catching up to it, on the same terms
    // readFileCapped uses to decide what the file IS.
    if (!m.includeHidden) {
      const real = path.relative(root, r.target).split(path.sep).filter(Boolean);
      const hidden = projectFilesLib.hiddenSegment(real);
      if (hidden && !(m.op === 'read' && projectFilesLib.imageTypeFor(r.target))) throw refuseHidden(hidden);
    }

    // Every read below uses r.target, the RESOLVED path, never the request string.
    // Same TOCTOU rule as restore and mutate.
    if (m.op === 'read') {
      const data = await projectFilesLib.readFileCapped(r.target);
      if (data.error) throw fail(data.error, data.code);
      return { name: path.basename(r.target), ...data };
    }
    // `list`, the row's defaultOp.
    return { root, sep: path.sep, ...(await projectFilesLib.listDir(root, r.target, { includeHidden: !!m.includeHidden })) };
  }, { onError: (e) => ({ error: denied(e) ? 'Permission denied' : (e.code || e.message), code: denied(e) ? 'DENIED' : 'FILES_FAILED' }) });

  // ---- family 5: the small ones a fixture can already reach -------------------
  // Five frames that needed nothing injected beyond what families 1-3 already
  // bought. Two are pure (pidAliveMany, killPid ask the OS about a pid and nothing
  // else), one writes inside a root the confinement already parameterises
  // (sessionSettings), and two read a module-level env root of their own that a
  // test can set before requiring this file (restore's ~/.claude/file-history via
  // lib/checkpoints.js, agentLog's ~/.termdeck/agent.log via agent/log.js).
  // tests/agent-capability-small.mjs covers all five.

  defineOp('sessionSettings', async (m) => {
    if (!sessionSettingsLib) throw fail('agent is out of date (session-settings module missing). Update the agent', 'AGENT_OUTDATED');
    const root = REAL_ROOTS[0]; // CLAUDE_DIR — the thinking dial is a Claude setting
    if (m.op === 'set') {
      return { thinking: await sessionSettingsLib.writeThinking(root, m.sessionId, m.thinking ?? null) };
    }
    if (m.op === 'setRunOptions') {
      // Validation is the shared module's, run HERE as well as on the master:
      // these values become argv for a process on this box, and a master is not
      // the thing that gets to decide that.
      if (!sessionSettingsLib.writeRunOptions) throw fail('agent is out of date (run options unsupported). Update the agent', 'AGENT_OUTDATED');
      return { runOptions: await sessionSettingsLib.writeRunOptions(root, m.sessionId, m.runOptions ?? null) };
    }
    // `get`, the row's defaultOp, so this is also what an op-less frame means.
    return { settings: await sessionSettingsLib.readSettings(root) };
  });

  // /rewind on the cloud path. This is the one capability that writes OUTSIDE the
  // transcript roots — it has to, the files it rolls back are the customer's own
  // checkout — so the trust boundary is drawn differently and has to hold on its
  // own terms: the master names a TRANSCRIPT (confined, like every other path it
  // may name) and a list of checkpoint ids, and nothing else. Which files exist,
  // where they live and what bytes go into them are all read HERE, from this box's
  // own transcript records and its own ~/.claude/file-history blobs. There is no
  // path and no content in the request, so a compromised master cannot use this to
  // write a file of its choosing anywhere — the worst it can do is roll a real
  // checkpoint of a real session back, which is the feature.
  defineOp('restore', async (m) => {
    if (!checkpointsLib) throw fail('agent is out of date (checkpoints module missing). Update the agent', 'AGENT_OUTDATED');
    if (!(await confined(m.path))) throw fail('path not permitted');
    const rp = await fsp.realpath(m.path);
    if (typeof m.sessionId !== 'string' || !RECORD_UUID_RE.test(m.sessionId)) throw fail('bad sessionId');
    // The ids index the backup blobs under file-history/<sessionId>/, so a junk one
    // can only fail to resolve — but they are validated anyway, on both sides,
    // exactly like `upTo` on duplicate.
    const ids = (Array.isArray(m.messageIds) ? m.messageIds : []).filter((x) => typeof x === 'string' && RECORD_UUID_RE.test(x));
    if (!ids.length) throw fail('messageIds required');
    if (ids.length > 500) throw fail('too many checkpoints');
    // cwd is deliberately NOT taken from the request: resolveCheckpoint reads it
    // out of the transcript itself, and a delta's realParentDir wins over even
    // that. The master never gets to say where a file lands.
    const data = checkpointsLib.restoreCheckpoint(rp, m.sessionId, null, ids, { dryRun: !!m.dryRun });
    // A checkpoint the transcript does not describe is a 404 rather than a
    // failure, and the status rides as an extra field the way it always has.
    if (data && data.error) throw fail(data.error, null, { status: 404 });
    return { data };
  });

  // The agent's own log, tailed back to its owner's dashboard. Deliberately NOT
  // part of the readFile capability: that one is confined to the transcript roots
  // and must stay that way — this is one fixed file, no path parameter, and
  // nothing the agent serves is written into it (agent/log.js).
  defineOp('agentLog', async (m) => {
    // The catch is here rather than left to the registry because this one reported
    // `e.message` where the registry reports `e.code || e.message`. The only
    // reachable throw is the require failing, and "Cannot find module './log'"
    // tells its reader more than "MODULE_NOT_FOUND" does. tail() itself cannot
    // throw: agent/log.js's readTail swallows to ''.
    try {
      const logLib = require('./log');
      return { text: logLib.tail(Number(m.bytes) || 64 * 1024), file: logLib.LOG_FILE };
    } catch (e) { throw fail(e.message); }
  });

  // Liveness only (signal 0, never delivered) — feeds the master's view-only
  // computation for the Claude live registry. EPERM = alive but not ours.
  // A zombie answers signal 0 as alive, though it has exited and holds nothing;
  // on Linux its /proc state says so (B43). Elsewhere there is no cheap read and
  // the master's registry check covers it.
  const zombie = (pid) => {
    if (process.platform !== 'linux') return false;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
    } catch { return false; }
  };
  defineOp('pidAliveMany', async (m) => {
    const alive = (Array.isArray(m.pids) ? m.pids : []).filter((pid) => {
      if (typeof pid !== 'number') return false;
      try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
      return !zombie(pid);
    });
    return { alive };
  });

  // A rollout lifecycle says whether a turn is generating. This answers the
  // separate ownership question: which threads a live local Codex client still
  // controls after its turn goes idle. The helper reads process-held handles
  // locally and returns ids plus pids only; no transcript bytes or arbitrary
  // process details leave the machine.
  defineOp('codexAttached', async () => {
    if (!codexAttachment) throw fail('agent is out of date (codex-attachment module missing). Update the agent', 'AGENT_OUTDATED');
    // Stamp before scanning. A task_started written after this point must beat
    // a negative snapshot even if the scan reply reaches the master later.
    const at = Date.now();
    const snapshot = await codexAttachment.scanCodexAttachments({ codexHome: dirs.codexHome });
    return { ...snapshot, at };
  });

  // Signal a pid. Used by "take over" to end an idle terminal `claude` holding the
  // same session, by background-shell stop, and by the leaked-runner reaper. The
  // master checks the pid first, but the agent does not take its word for it.
  // A pid the master may have signalled is one this agent can vouch for itself:
  // a process under its own tree (a CLI it spawned, that CLI's shells), or a
  // Claude CLI that registered itself in <claudeDir>/sessions/<pid>.json (the
  // terminal client "take over" ends) and anything under that one. A master
  // naming any other pid on the box is refused, so a compromised master cannot
  // turn this into "signal whatever runs as this user".
  const registeredClaudePids = async () => {
    const out = new Set();
    const dir = path.join(CLAUDE_DIR, 'sessions');
    let names = [];
    try { names = await fsp.readdir(dir); } catch { return out; }
    await Promise.all(names.filter((n) => /^\d+\.json$/.test(n)).map(async (n) => {
      try {
        const rec = JSON.parse(await fsp.readFile(path.join(dir, n), 'utf8'));
        const fresh = Date.now() - (rec.updatedAt || rec.startedAt || 0) <= LIVE_REGISTRY_STALE_MS;
        if (rec && rec.pid === Number(n.slice(0, -5)) && rec.sessionId && fresh) out.add(rec.pid);
      } catch {}
    }));
    return out;
  };
  const mayKill = async (pid, rows) => {
    if (pid <= 1 || pid === process.pid) return false;
    const registered = await registeredClaudePids();
    if (registered.has(pid)) return true;
    if (!rows) return false; // no process table: only the registry can vouch
    for (const owner of [process.pid, ...registered]) {
      if (procTree.descendants(rows, owner).some((r) => r.pid === pid)) return true;
    }
    return false;
  };

  defineOp('killPid', async (m) => {
    if (typeof m.pid !== 'number' || !Number.isInteger(m.pid)) throw fail('bad pid');
    const signal = m.signal || 'SIGTERM';
    let rows = null;
    if (procTree && typeof procTree.snapshot === 'function') {
      try { rows = await procTree.snapshot(); } catch { rows = null; }
    }
    // An already-gone pid needs no vouching: there is nothing left to signal.
    try { process.kill(m.pid, 0); } catch (e) { if (e.code === 'ESRCH') return {}; }
    if (!(await mayKill(m.pid, rows))) throw fail('not a process this agent started or a registered engine session', 'PID_NOT_OURS');
    // `tree`: everything under the pid as well. A background shell's loop runs its
    // commands as children, and a shell stopped alone leaves the one it was
    // running behind (bugs.md B14). Listed BEFORE the kill, while they are still
    // its descendants rather than orphans reparented to init.
    let kids = [];
    if (m.tree && rows) {
      try { kids = procTree.descendants(rows, m.pid); } catch { kids = []; }
    }
    // ESRCH is success: the pid we were asked to end is already gone, which is the
    // state the caller wanted. Anything else is a real failure and says so.
    try { process.kill(m.pid, signal); }
    catch (e) { if (e.code !== 'ESRCH') throw fail(e.message); }
    for (const k of kids) { try { process.kill(k.pid, signal); } catch {} }
    return {};
  });

  // ---- family 6: what the master asks ABOUT this machine ----------------------
  // Four frames that answer questions about the box rather than about a file the
  // master named, and they convert together because that is the shape they share:
  // two take no argument at all (the root is this agent's own, and there is
  // nothing here for a master to name), and two take paths that are confined the
  // same way `readFile` is. All four were reachable the moment `{ roots }` was
  // injectable; none needed the env that family 5 had to set.
  // tests/agent-capability-machine.mjs covers them.

  // The session index's own walk. Same tree `listTree` returns, minus the files
  // the master was always going to throw away, and in a compact shape.
  //
  // WHY: the master rebuilds its index whenever a transcript changes (which, on a
  // box you are actually working on, is constantly) and each rebuild re-fetched
  // the WHOLE tree. Measured on a real box: 2,675 entries / 790 KB per rebuild, of
  // which ~755 were sessions and the rest were subagent transcripts and sidecars
  // the master discards on arrival. That 790 KB is an uplink round trip on a home
  // connection, and it showed up as a flat ~2.3s added to /api/sessions every time
  // the index was dirty.
  //
  // The filter is deliberately COARSE and structural. The master still owns the
  // exact shape rules (UUID_JSONL / ROLLOUT_RE / the grok id regex) and re-checks
  // every row this returns; all this does is refuse to put a file on the wire that
  // could not possibly be a session. Keeping it structural rather than a second
  // copy of those regexes is what stops the two from drifting.
  defineOp('indexScan', async (m) => {
    if (!(await confined(m.path))) throw fail('path not permitted');
    const kind = m.kind === 'codex' || m.kind === 'grok' ? m.kind : 'claude';
    const root = path.resolve(m.path);
    const ents = await fsp.readdir(m.path, { recursive: true, withFileTypes: true });
    const files = [];
    let truncated = false;
    for (const e of ents) {
      if (!e.isFile()) continue;
      const dir = e.parentPath || m.path;
      if (!indexCandidate(kind, root, dir, e.name)) continue;
      const full = path.join(dir, e.name);
      let st; try { st = await fsp.stat(full); } catch { continue; }
      // Relative paths: every entry shares the root prefix, and on a deep
      // transcript root that prefix is most of the string.
      files.push([path.relative(root, full), st.size, st.mtimeMs]);
      if (files.length >= 4000) { truncated = true; break; }
    }
    return { root, sep: path.sep, files, truncated };
  });

  // The whole session index in one round trip (features/04 phase 8): the walk,
  // the heads the master will show, and Codex's rename index, answered from the
  // copy this agent keeps, as a delta against the generation the master holds
  // (`since`, `epoch`) or `unchanged` when it holds the current one. Every root
  // is confined inside the module, per root, exactly like indexScan.
  defineOp('indexSync', async (m) => {
    if (!sessionIndex) throw fail('agent is out of date (session-index module missing). Update the agent', 'AGENT_OUTDATED');
    return sessionIndex.sync({ roots: m.roots, since: m.since, epoch: m.epoch, max: m.max, codexIndex: m.codexIndex });
  });

  // Parse the index's head/tail metadata HERE, where the disk is, and send back
  // the answer instead of the bytes. The master used to stream 124 MB across 581
  // reads to index 200 sessions; this is the same parse (one shared module,
  // lib/index-head.js — never a second copy) returning a few hundred bytes per
  // file. Every path is confined exactly like readFile.
  defineOp('indexHeads', async (m) => {
    if (!indexHeadLib) throw fail('agent is out of date (index-head module missing). Update the agent', 'AGENT_OUTDATED');
    const rows = Array.isArray(m.rows) ? m.rows.slice(0, 1000) : [];
    const io = headIo();
    // One row at a time was costing the whole cold index. Measured on this
    // machine's own ~/.claude (154 Claude transcripts, 341 MB, plus 104 Codex
    // rollouts): the serial loop took 7.1 s for a 200-row batch, which is the
    // bulk of a 7.8 s first build, against the master's page-load budget for
    // one machine of 2.5 s (master.js HOST_DEADLINE_MS). Every request landing
    // in that window answered INDEXING with no rows at all. It is not a rare
    // window either: session-heads.js keys the disk cache on the agent's
    // VERSION, so each self-update throws the whole cache away and the next
    // dashboard load pays this again.
    //
    // mapLimit is the same helper, at the same default width, that the scan
    // layers already use for exactly this fan-out (lib/pool.js), including its
    // reason for having a cap at all, which is that a bare Promise.all over a
    // thousand transcripts is how a big machine hits EMFILE. Results come back
    // in input order, so the answer stays index-aligned with the batch the
    // master sent, which is the one property this op cannot lose.
    const heads = await mapLimit(rows, async (row) => {
      // Confinement is per ROW, not per batch: one bad path must not decide
      // anything about the others, and must never be read. A refused or
      // unreadable row is a null in place.
      if (!row || typeof row.path !== 'string' || !(await confined(row.path))) return null;
      try { return await indexHeadLib.readIndexHead(row, io); } catch { return null; }
    });
    return { heads };
  });

  // WHY the account's limit is being spent (the `/usage` breakdown), read off this
  // machine's own transcripts. Like `machineConfig` it takes NO argument at all:
  // the root is this agent's own, and there is nothing here for a master to name.
  // It reads a lot of disk and returns a few hundred bytes, which is the whole
  // reason it runs here.
  defineOp('usageBehaviour', async () => {
    if (!usageBehaviourLib) throw fail('agent is out of date (usage-behaviour module missing). Update the agent', 'AGENT_OUTDATED');
    return { data: await usageBehaviourLib.readUsageBehaviour(REAL_ROOTS[0]) };
  }, { onError: (e) => ({ error: e && (e.code || e.message), code: 'USAGE_FAILED' }) });

  // What the engine is CONFIGURED with (V3 §G + U2's viewer + U9's chain).
  // Everything it reads is inside a transcript ROOT, so this widens nothing — it
  // exists because a browser fetching each of these files over the tunnel would
  // cost dozens of round trips to draw one panel. The master names no path; the
  // root is this agent's own.
  defineOp('machineConfig', async () => {
    if (!machineConfigLib) throw fail('agent is out of date (machine-config module missing). Update the agent', 'AGENT_OUTDATED');
    return { claude: await machineConfigLib.readClaudeConfig(REAL_ROOTS[0]) };
  }, { onError: (e) => ({ error: e && (e.code || e.message), code: 'CONFIG_FAILED' }) });

  // ---- family 7: the watch, and the background shells ------------------------
  // The first two frames in this conversion that are not one-ask-one-answer, which
  // is the whole reason they were left this long. `watch` is family 'stream' and
  // `unwatch` is family 'none', and until the registry read `family` off the row it
  // could only have stamped both of them wrong: a terminal `ok` on a channel whose
  // reader is a per-event callback, and a reply to a frame the master never made a
  // pending entry for. Both would have arrived, been matched against nothing, and
  // been binned in silence, which is the exact failure this whole feature exists to
  // end. tests/agent-capability-watch.mjs and tests/agent-capability-shells.mjs.

  // Chokidar on a confined path, coalesced. The refusals go out on `fsEvent`, the
  // row's own reply type, and carry NO `ok`, because the master routes this type by
  // watch id to a callback rather than through `pending` (lib/cloud/transport.js
  // onFrame). A watch that cannot start says so on the same channel the events
  // would have used, which is the only channel its caller is listening to.
  // Both refusals carry `path` as well as `error`. The reader is a per-watch
  // callback that was handed a path when the watch was asked for, and telling it
  // only that "a path" was refused makes it guess which.
  defineOp('watch', async (m) => {
    if (!(await confined(m.path))) throw fail('path not permitted', null, { path: m.path });
    if (!chokidarLib) throw fail('watch unavailable', null, { path: m.path });
    const w = chokidarLib.watch(m.path, { ignoreInitial: true, followSymlinks: false });
    // Report WHICH file changed (chokidar's per-file path) - a directory watch is
    // useless to the master's per-session cursors otherwise. Falls back to the
    // watched root for older chokidar event shapes.
    //
    // Coalesced (feature 73): adds and changes are held WATCH_BATCH_MS and go
    // out as ONE frame carrying [path, size, mtimeMs] triples, stat'd
    // asynchronously at flush - replacing one blocking-statSync frame per CLI
    // write. Unlinks stay immediate: they carry no size worth batching, and
    // deleting a path also supersedes any change of it still waiting in the
    // window (the unlink is the later truth; a recreate lands in the NEXT
    // window, order preserved). The master accepts pairs, triples and the
    // single-event shape (lib/cloud/transport.js fans a batch out per entry),
    // so agents older than either change keep working through the fleet's
    // rollout window. The mtime is what stops a session row's stamp from
    // flipping to Date.now() on every write and again on every rebuild
    // (features/04 phase 4); a stat that fails sends the pair, size 0, which
    // the master reads exactly as it did before.
    const batch = { paths: new Set(), timer: null };
    watchBatches.set(m.id, batch);
    const flush = async () => {
      batch.timer = null;
      const paths = [...batch.paths];
      batch.paths.clear();
      if (!paths.length) return;
      const pairs = await Promise.all(paths.map(async (p) => {
        try { const st = await fsp.stat(p); return [p, st.size, st.mtimeMs]; } catch { return [p, 0]; }
      }));
      for (let at = 0; at < pairs.length; at += WATCH_BATCH_MAX) {
        send({ t: 'fsEvent', id: m.id, batch: pairs.slice(at, at + WATCH_BATCH_MAX) });
      }
    };
    const emit = (p) => {
      batch.paths.add(p || m.path);
      if (!batch.timer) {
        batch.timer = setTimeout(() => { flush().catch(() => {}); }, WATCH_BATCH_MS);
        if (batch.timer.unref) batch.timer.unref();
      }
    };
    w.on('add', emit).on('change', emit).on('unlink', (p) => {
      const fp = p || m.path;
      batch.paths.delete(fp);
      send({ t: 'fsEvent', id: m.id, path: fp, size: 0, unlink: true });
    });
    watchers.set(m.id, w);
  });

  // Cancels a watch by the id `watch` minted. Answers nothing at all: the master
  // stops routing that id the moment it sends this, so there is no reader left.
  // Dropping the batch timer matters as much as closing the watcher, because a
  // flush already scheduled would otherwise send one more frame for a watch the
  // master has stopped listening to.
  defineOp('unwatch', async (m) => {
    const w = watchers.get(m.id);
    if (w) { w.close(); watchers.delete(m.id); }
    const b = watchBatches.get(m.id);
    if (b) { if (b.timer) clearTimeout(b.timer); watchBatches.delete(m.id); }
  });

  // Which processes a shell host still owns, and what each writes to. The
  // master matches logPath against the output file the CLI named in its
  // tool_result, an exact key where the command string is a guess.
  defineOp('bgShells', async (m) => {
    if (!procTree) throw fail('agent needs updating', 'AGENT_OUTDATED');
    // `runId` names a CLI run on this box (agent/engine-runs.js), held as a shell
    // host. The registry answers only for a process it started, so the master can
    // never walk one this agent did not spawn.
    const pid = m.runId ? runs.livePid(String(m.runId)) : null;
    // Gone (exited on its own, or reaped): an empty list, not an error. The
    // master's reconcile treats it as "every shell here is finished".
    if (pid == null) return { pid: null, procs: [] };
    return { pid, procs: await procTree.list(pid) };
    // `e.message` and not the registry default's `e.code || e.message`, which is
    // what the hand-written catch here reported. Kept deliberately rather than
    // tidied into the default: proc-tree shells out to ps/wmic, so its failures
    // arrive as a spawn errno whose CODE ("ENOENT") says nothing a reader can act
    // on, where its MESSAGE names the command that was not there.
  }, { onError: (e) => ({ error: e && e.message }) });

  // Tail one background shell's output file. NOT part of readFile: that one
  // is confined to the transcript roots and must stay that way. This is its
  // own confinement (bgLogPathOk) over a different tree, and it is a read of
  // a file the CLI itself created for exactly this purpose.
  defineOp('bgShellLog', async (m) => {
    if (!bgLogPathOk(m.path)) throw fail('not a background shell log', 'DENIED');
    const st = await fsp.stat(m.path);
    // A rotated/recreated file is shorter than the cursor we hold. Restart
    // from 0 and SAY so, rather than silently serving a torn suffix.
    const want = Math.max(0, Math.min(Number(m.bytes) || 64 * 1024, 1024 * 1024));
    const truncated = Number(m.offset) > st.size;
    const from = truncated ? Math.max(0, st.size - want) : Math.max(0, Number(m.offset) || 0);
    const fh = await fsp.open(m.path, 'r');
    try {
      const len = Math.min(want, Math.max(0, st.size - from));
      const buf = Buffer.alloc(len);
      if (len) await fh.read(buf, 0, len, from);
      return { data: buf, offset: from, next: from + len, size: st.size, truncated, mtimeMs: st.mtimeMs };
    } finally { await fh.close(); }
  });

  // ---- family 8: what a provider says -----------------------------------------
  // The four frames that answer with something computed off a credential or a walk
  // of the whole machine rather than off a file the master named. They convert
  // together because their bodies are the same three lines every time (call the
  // lib, wrap the answer, report the message) and because injecting the four libs
  // is what makes any of them askable in a test at all.
  //
  // All four report `e.message`, never `e.code || e.message`. That is not an
  // oversight in the originals and it is not tidiable: a provider failure arrives
  // as an HTTP status or a spawn errno whose code names the transport, and the
  // sentence is the only part that names the problem. tests/agent-capability-providers.mjs.

  // Account usage limits, computed on THIS box (the subscription token stays local
  // only percentages go up to the master). Narrow and typed: declared `async ()`
  // rather than `async (m)` for the same reason usageBehaviour and machineConfig
  // are, which is that "the master cannot parameterise this" should be a fact about
  // the signature instead of a rule someone has to keep.
  defineOp('limits', async () => ({ data: await limitsMod().getLimits() }), justMessage);

  // Claude model catalog, computed on THIS box for the same reason as limits:
  // subscription credentials stay local to the agent machine.
  defineOp('models', async (m) => {
    if (m.engine && m.engine !== 'claude') throw fail(`engine not permitted: ${m.engine}`);
    return { models: await claudeModels() };
  }, {
    // `reason` is the whole point of the failure: "Failed to fetch models" on its
    // own sends the person to us, "this machine has no Claude login" sends them to
    // the fix. It rides to the browser through /api/models, and transport.js's
    // settle() carries it verbatim. `code` and `reason` are spelled null rather
    // than omitted because that is what the hand-written reply sent, and a key that
    // appears on one machine and not another is how a reader learns to guess.
    onError: (e) => ({ error: e && e.message, code: (e && e.code) || null, reason: (e && e.reason) || null }),
  });

  // Read-only health of the three CLIs on this box. No args: there is nothing to
  // parameterise and nothing to get wrong.
  defineOp('cliStatus', async () => ({ data: await cliStatusFn() }), justMessage);

  // Token spend for #/usage, computed on THIS box (the transcripts never leave it,
  // only the aggregated tokens go up to the master). Args are MASTER-FORWARDED and
  // validated HERE, not trusted: this is the one capability whose args come from
  // something other than a fixed enum ('models' above rejects a bad engine, and
  // 'cwdCheck' requires a path, the same way).
  //
  // Verified: an unvalidated NaN tzOffset reaching lib/usage.js's `new Date()`
  // throws `RangeError: Invalid time value`, and agent.js's uncaughtException
  // handler calls process.exit(1), so ONE malformed query string would otherwise
  // kill every live Claude/Codex session on this box. The registry catches now, so
  // that particular path is closed twice over, but the validation is still what
  // turns a crash into a sentence.
  //
  // Duplicated (not required) from lib/usage-query.js: the agent ships as flat
  // files off AGENT_FILES' manifest, and this check is six lines, not worth a new
  // manifest entry for. lib/usage.js ALSO validates internally
  // (assertValidDayString/assertValidTzOffset). That is intentional defense in
  // depth, not a substitute for this.
  defineOp('usage', async (m) => {
    const args = m.args && typeof m.args === 'object' ? m.args : {};
    const from = typeof args.from === 'string' ? args.from : '';
    const to = typeof args.to === 'string' ? args.to : '';
    const tzOffset = Number(args.tzOffset ?? 0);
    const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!DAY_RE.test(from) || !Number.isFinite(Date.parse(`${from}T00:00:00Z`))) throw new Error(`bad from: ${JSON.stringify(args.from)}`);
    if (!DAY_RE.test(to) || !Number.isFinite(Date.parse(`${to}T00:00:00Z`))) throw new Error(`bad to: ${JSON.stringify(args.to)}`);
    if (from > to) throw new Error('from must not be after to');
    const spanDays = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    if (spanDays > 366) throw new Error(`range too large: ${spanDays} days`);
    if (!Number.isFinite(tzOffset) || Math.abs(tzOffset) > 840) throw new Error(`bad tzOffset: ${JSON.stringify(args.tzOffset)}`);
    // projects: the sidebar-parity allowlist. master.js always sends an array (even
    // [] for "zero added projects"), never trusted as-is: same duplicated-not-
    // required reasoning as from/to/tzOffset above. undefined => no filter,
    // unchanged from before this arg existed.
    let projects;
    if (args.projects !== undefined) {
      // The raw string length must be checked BEFORE .split(','): splitting first
      // lets a huge comma-heavy frame allocate an enormous array up front, and an
      // OOM from that allocation is NOT catchable (V8 raises it as a fatal error),
      // taking down agent.js's whole process and killing every live chat on this
      // box. Same 20000-char cap lib/usage-query.js's parseProjects uses.
      const MAX_PROJECTS_STR_LEN = 20000;
      let list;
      if (Array.isArray(args.projects)) {
        list = args.projects;
      } else {
        const str = String(args.projects);
        if (str.length > MAX_PROJECTS_STR_LEN) throw new Error(`projects value too long: ${str.length} chars (max ${MAX_PROJECTS_STR_LEN})`);
        list = str.split(',').filter(Boolean);
      }
      if (list.length > 500) throw new Error(`too many projects: ${list.length}`);
      const SLUG_RE = /^[a-z0-9-]+$/;
      for (const p of list) {
        if (typeof p !== 'string' || !SLUG_RE.test(p)) throw new Error(`bad project slug: ${JSON.stringify(p)}`);
      }
      projects = list;
    }
    return { data: await usageMod().getUsage({ from, to, tzOffset, projects }) };
  }, justMessage);

  // ---- family 9: the three op ladders ----------------------------------------
  // One frame type, several ops, one lib behind each. They convert together
  // because they share a shape no other family has, and because that shape hid a
  // landmine: all three cases ended their ladder with NO return, so `git` fell
  // through into `accounts`, `accounts` into `codexAccounts`, and `codexAccounts`
  // into `spawn`. Unreachable today (handle() refuses an op no row declares, and a
  // frame naming no op at all is refused too, since none of these three has a
  // defaultOp) but it was one added op away from a chat's account panel starting an
  // engine. A handler cannot fall through into the next one, which is most of why
  // this family was worth converting rather than leaving alone.
  // tests/agent-capability-logins.mjs.

  // The end of a ladder, as a refusal rather than a fall-through. Reachable only if
  // someone adds an op to a row and forgets its branch, which is the case
  // tests/agent-protocol.mjs already fails the suite on; this is what that mistake
  // costs at runtime in the window before anyone runs the tests.
  const noBranch = (t, op) => fail(`agent is out of date (${t} here has no '${op}'). Update the agent`, 'AGENT_OUTDATED');

  // Feature 04 (cloud path): git diff / PR creation for a session, run where the
  // checkout actually lives. cwd is the session's PROJECT dir (like spawn's cwd) so
  // it is NOT confined to the transcript roots, because projects live wherever the
  // user codes and the master resolves cwd from the session's own head. Still
  // narrow: the ops are read-only reads and one explicit, browser-confirmed PR.
  defineOp('git', async (m) => {
    const payload = m.payload && typeof m.payload === 'object' ? m.payload : {};
    const cwd = String(payload.cwd || '');
    if (m.op === 'diff') {
      // light: summary only, no patches. file/from: one file's patch. An agent
      // older than this reads neither and answers the whole diff, which the
      // client accepts as it always did (the payload says `light` when it is).
      return { data: await diff.collectDiff(cwd, { light: payload.light === true, file: payload.file ? String(payload.file) : '', from: payload.from ? String(payload.from) : '' }) };
    }
    // Two git calls, no diff: cheap enough to ask on every chat open, which is the
    // point, because the transcript's own gitBranch is the PARENT checkout's inside
    // a worktree (see readBranch).
    if (m.op === 'branch') return { data: await diff.readBranch(cwd) };
    // Every checkout of this repo, so a new chat can be started in one. Read only,
    // and it names no path the master did not already send.
    if (m.op === 'worktrees') return { data: await diff.listWorktrees(cwd) };
    if (m.op === 'pr') return { data: await diff.createPr(cwd, { title: payload.title, body: payload.body }) };
    if (m.op === 'mcpServers') {
      if (!mcpConfig) throw fail('agent is out of date (mcp-config module missing). Update the agent', 'AGENT_OUTDATED');
      return { data: await mcpConfig.readMcpServers(cwd, payload.engine) };
    }
    throw noBranch('git', m.op);
    // `code` spelled null rather than omitted, as the hand-written catch did: git
    // shells out, so some of these failures carry an errno and some do not, and a
    // key that appears on one machine and not another is how a reader learns to
    // guess. The message is what names the problem either way.
  }, { onError: (e) => ({ error: e && e.message, code: (e && e.code) || null }) });

  // Switch which Claude Code account THIS box uses. See lib/accounts.js's header for
  // the full design.
  defineOp('accounts', async (m) => {
    if (!accounts) throw fail('agent is out of date (accounts module missing). Update the agent', 'AGENT_OUTDATED');
    const payload = m.payload && typeof m.payload === 'object' ? m.payload : {};
    if (m.op === 'list') return { data: await accounts.listAccounts() };
    // Usage windows for every SAVED account on this box, one frame for the whole
    // machine, because the panel opens once and wants every row at once. Lives on
    // this frame rather than 'limits' because 'limits' answers for the ACTIVE login
    // and takes no argument; this one is about the saved set, which is exactly what
    // accounts knows and limits.js does not.
    if (m.op === 'usage') return { data: await limitsMod().accountsUsage(accounts) };
    if (m.op === 'save') return { data: await accounts.saveCurrentAccount() };
    if (m.op === 'preflight') return { data: await accounts.preflightSwitch(String(payload.orgId || '')) };
    if (m.op === 'switch') {
      try {
        return { data: await accounts.switchAccount(String(payload.orgId || '')) };
      } catch (e) {
        // Carry the failed check list back so the cloud UI names the step that
        // stopped it. A refusal rather than the default failure body precisely
        // because of that extra field: transport.js's settle() reads `checks` off
        // the frame, and the registry's default would drop it.
        throw fail(e.message, null, { checks: e.checks || null });
      }
    }
    if (m.op === 'remove') return { data: { removed: accounts.removeAccount(String(payload.orgId || '')) } };
    if (m.op === 'login') { accounts.startLogin({ email: payload.email || null }); return { data: { started: true } }; }
    if (m.op === 'loginStatus') return { data: accounts.loginStatus() };
    if (m.op === 'loginCode') { accounts.submitLoginCode(String(payload.code || '')); return { data: { ok: true } }; }
    if (m.op === 'loginCancel') return { data: { cancelled: accounts.cancelLogin() } };
    throw noBranch('accounts', m.op);
  }, justMessage);

  // Switch which ChatGPT account THIS box uses. See lib/codex-accounts.js. Its own
  // frame type rather than an engine flag on 'accounts': a stale agent that predates
  // this feature must answer AGENT_OUTDATED for codex while still serving Claude
  // switching normally, and overloading one case would make it misreport one or the
  // other.
  defineOp('codexAccounts', async (m) => {
    // Spend a ChatGPT rate-limit reset credit. An op on THIS frame rather than a
    // frame of its own: a new reply type an older agent has never heard of goes
    // unanswered and the master waits out the full timeout, whereas an unknown op is
    // refused by name by the shared check in handle() and fails immediately. It
    // rides here because the grant is account-scoped, but it needs limits.js (which
    // owns the app-server spawn), not the codex accounts module, so it is answered
    // BEFORE that module's gate.
    if (m.op === 'resetCredit') {
      const p = m.payload && typeof m.payload === 'object' ? m.payload : {};
      return { data: await limitsMod().consumeResetCredit({ idempotencyKey: p.idempotencyKey, creditId: p.creditId || null }) };
    }
    if (!codexAccounts) throw fail('agent is out of date (codex accounts module missing). Update the agent', 'AGENT_OUTDATED');
    const payload = m.payload && typeof m.payload === 'object' ? m.payload : {};
    // Only the master can count Codex turns on this box (see the hook note at the
    // top of this file).
    const busy = { busy: payload.busy || 0 };
    if (m.op === 'list') return { data: codexAccounts.listAccounts() };
    // The ChatGPT twin, with the limitation baked into the reply rather than hidden:
    // only the active account can report windows. See codexAccountsUsage.
    if (m.op === 'usage') return { data: await limitsMod().codexAccountsUsage(codexAccounts) };
    if (m.op === 'save') return { data: codexAccounts.saveCurrentAccount() };
    if (m.op === 'preflight') return { data: await codexAccounts.preflightSwitch(String(payload.orgId || ''), busy) };
    if (m.op === 'switch') {
      try {
        return { data: await codexAccounts.switchAccount(String(payload.orgId || ''), busy) };
      } catch (e) {
        throw fail(e.message, null, { checks: e.checks || null });
      }
    }
    if (m.op === 'remove') return { data: { removed: codexAccounts.removeAccount(String(payload.orgId || '')) } };
    if (m.op === 'login') { codexAccounts.startLogin(); return { data: { started: true } }; }
    if (m.op === 'loginStatus') return { data: codexAccounts.loginStatus() };
    if (m.op === 'loginCancel') return { data: { cancelled: codexAccounts.cancelLogin() } };
    throw noBranch('codexAccounts', m.op);
  }, justMessage);

  // Validate the working folder up front so a bad path fails fast with a clear
  // message, instead of the CLI spawning, failing to chdir, and exiting opaquely.
  // Not a new capability: only the exact cwd we are about to run in is stat'ed. The
  // cwd is the session's project dir, NOT confined to the transcript roots, because
  // projects live anywhere the user codes; the engine is still allowlisted, and
  // permission prompts on the browser gate any tool the turn tries to run.
  function checkCwd(cwd, code = null) {
    let isDir = false;
    try { isDir = fs.statSync(cwd).isDirectory(); } catch {}
    if (!isDir) throw fail(`This folder no longer exists on disk: ${cwd} (it may have been deleted or the worktree removed)`, code);
    return cwd;
  }

  // The environment each engine is started with.
  //
  // HARD CONSTRAINT (non-negotiable): never let a grok child fall back to metered
  // billing. The grok CLI owns OIDC refresh from ~/.grok/auth.json itself, so both
  // metered-auth vars are stripped and a customer's box having either set cannot
  // leak into a cloud grok turn (tests/grok-env-strip.mjs).
  //
  // The claude child holds a permission prompt open and aborts any permission that
  // outlives its stream-close timeout ("Tool permission request failed: AbortError:
  // Stream closed"), so it needs a long one: the default (seconds) kills every
  // interactive tool, because a human takes longer than that to approve.
  //
  // CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING is how file checkpointing reaches the
  // CLI (the SDK sets exactly this env var for `enableFileCheckpointing`; there is
  // no flag), or /rewind stays dead for every cloud chat.
  //
  // CLAUDE_CODE_ENABLE_TODO_TOOLS keeps the task checklist the transcript renders.
  // Since 2.1.268 the CLI offers TodoWrite/TaskCreate only on older models, so a
  // chat on any current model wrote no checklist at all; this env var is the
  // documented opt-in. Only a default: a box that sets it either way keeps its own.
  function engineEnv(engine) {
    // EMIT_SESSION_STATE_EVENTS: the CLI's own idle is what ends a turn (lib/claude-events.js).
    if (engine === 'claude') return { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', ...process.env, CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '300000', CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
    if (engine === 'grok') {
      const env = { ...process.env };
      delete env.XAI_API_KEY;
      delete env.GROK_DEPLOYMENT_KEY;
      return env;
    }
    return process.env;
  }

  // ---- engine runs: the CLI's protocol read on this box --------------------------
  // agent/engine-runs.js owns the child, the adapter and the event log; these ops
  // are its door. The master sends the argv and the message content it has always
  // built, and gets engine events back instead of raw stdout. Runs outlive this
  // connection (the registry is module-level), subscriptions do not: park() drops
  // them and the master re-subscribes from the last seq it saw.
  const runFail = (e) => fail(e.message, e.code || 'RUN_FAILED');
  defineOp('engineRun', async (m) => {
    try {
      if (m.op === 'start') {
        if (m.engine !== 'claude' && m.engine !== 'codex' && m.engine !== 'grok') throw fail(`engine runs are not available for ${m.engine}`, 'BAD_ENGINE');
        const exe = engineExes[m.engine];
        if (!exe) throw fail(`engine not permitted: ${m.engine}`, 'BAD_ENGINE');
        const cwd = m.cwd && typeof m.cwd === 'string' ? checkCwd(m.cwd, 'BAD_CWD') : null;
        // Codex: a turn on a thread of the machine's one app-server. The master sends
        // the turn's input items and settings; the argv is the agent's own.
        if (m.engine === 'codex') {
          return runs.start({
            runId: typeof m.runId === 'string' ? m.runId : undefined,
            engine: 'codex',
            exe,
            env: engineEnv('codex'),
            cwd,
            content: m.content,
            sessionId: typeof m.sessionId === 'string' ? m.sessionId : null,
            turn: m.turn && typeof m.turn === 'object' ? m.turn : {},
            thread: m.thread && typeof m.thread === 'object' ? m.thread : {},
            collab: m.collab === 'plan' ? 'plan' : null,
            permissionMode: typeof m.permissionMode === 'string' ? m.permissionMode : null,
            model: typeof m.model === 'string' ? m.model : null,
          });
        }
        // Grok: a prompt on a session of the machine's one `grok agent stdio`. The
        // master sends ACP prompt blocks and the model/effort/mode to set first.
        if (m.engine === 'grok') {
          return runs.start({
            runId: typeof m.runId === 'string' ? m.runId : undefined,
            engine: 'grok',
            exe,
            env: engineEnv('grok'),
            home: os.homedir(),
            sessionsRoot: path.join(dirs.grokDir, 'sessions'),
            cwd,
            content: m.content,
            sessionId: typeof m.sessionId === 'string' ? m.sessionId : null,
            model: typeof m.model === 'string' ? m.model : null,
            effort: typeof m.effort === 'string' ? m.effort : null,
            modeId: typeof m.modeId === 'string' ? m.modeId : null,
            permissionMode: typeof m.permissionMode === 'string' ? m.permissionMode : null,
          });
        }
        return runs.start({
          runId: typeof m.runId === 'string' ? m.runId : undefined,
          engine: m.engine,
          exe,
          args: Array.isArray(m.args) ? m.args.map(String) : [],
          cwd,
          env: engineEnv(m.engine),
          content: m.content,
          thinking: m.thinking || null,
          sessionId: typeof m.sessionId === 'string' ? m.sessionId : null,
          resumed: !!m.resumed,
          permissionMode: typeof m.permissionMode === 'string' ? m.permissionMode : null,
          model: typeof m.model === 'string' ? m.model : null,
        });
      }
      if (m.op === 'answer') { runs.answer(String(m.runId), String(m.requestId), m.decision || { behavior: 'deny' }); return { ok: true }; }
      if (m.op === 'steer') { await runs.steer(String(m.runId), m.content); return { ok: true }; }
      if (m.op === 'submit') return runs.submit(String(m.runId), m.content, m.thinking || null);
      if (m.op === 'hold') return { held: runs.hold(String(m.runId)) };
      if (m.op === 'interrupt') { runs.interrupt(String(m.runId)); return { ok: true }; }
      if (m.op === 'control') return await runs.control(String(m.runId), m.request, Number(m.timeoutMs) || undefined);
      if (m.op === 'stop') return { stopped: runs.stop(String(m.runId)) };
      if (m.op === 'list') return { runs: runs.list(), servers: runs.servers() };
      if (m.op === 'recycle') return { recycled: runs.recycle(String(m.engine || '')) };
      // A call to a shared child outside a turn: Codex's model list and rate limits,
      // Grok's model catalogue (the pseudo-method 'modelState').
      if (m.op === 'rpc') {
        const exe = engineExes[m.engine];
        if (!exe) throw fail(`engine not permitted: ${m.engine}`, 'BAD_ENGINE');
        return await runs.rpc({ engine: m.engine, exe, env: engineEnv(m.engine), home: os.homedir(), method: String(m.method || ''), params: m.params, timeoutMs: m.timeoutMs });
      }
      throw noBranch('engineRun', m.op);
    } catch (e) {
      throw e && e.capRefusal ? e : runFail(e);
    }
  }, justMessage);

  // A run's events from `afterSeq` on: the missed ones at once, then live, token
  // deltas batched. Cancelled by engineUnsubscribe or by the link going away.
  defineOp('engineEvents', async (m) => {
    let off;
    try {
      off = runs.subscribe(String(m.runId), Number(m.afterSeq) || 0, (frame) => send({ t: 'engineEvent', id: m.id, ...frame }));
    } catch (e) {
      throw runFail(e);
    }
    engineSubs.set(m.id, off);
  });
  defineOp('engineUnsubscribe', async (m) => {
    const off = engineSubs.get(m.id);
    engineSubs.delete(m.id);
    if (off) off();
  });

  // A success reply, with its bulk bytes carried whichever way the ASKER asked for
  // (feature 06). Handlers return real Buffers in the fields agent-protocol.js
  // declares; this is the only place that knows those Buffers become either one
  // binary ws frame or base64 inside the JSON envelope.
  //
  // Per request, never a mode. `m.bin` is set only by a master that read this
  // agent's `wire` advertisement out of its hello, so during a fleet rollout
  // neither side can assume something the other has not agreed to. An agent that
  // quarantined a release keeps the base64 path forever and stays correct on it,
  // which is what scripts/relay-readpath-check.js asserts by running both arms
  // over the same file and comparing the bytes.
  function sendReply(m, obj) {
    const fields = protocol.byteFields(m.t);
    if (!fields.length) return send(obj);
    if (m.bin && fields.some((f) => Buffer.isBuffer(obj[f]))) return send(protocol.encodeBinaryFrame(obj, fields));
    const out = { ...obj };
    for (const f of fields) if (Buffer.isBuffer(out[f])) out[f] = out[f].toString('base64');
    return send(out);
  }

  async function handle(m) {
    // A frame on the OTHER key is not ours, and must fall straight through.
    // relay.js sends { type: 'welcome' } to EVERY agent version, and that is safe
    // only because a type-only frame has no `t` and so matches nothing here. The
    // same is true of anything either side starts sending on that key later: the
    // silence IS the forward-compatibility channel, and it is the one thing that
    // has never needed a version gate. See TYPE_FRAMES in agent-protocol.js.
    if (!m || typeof m.t !== 'string') return;

    const row = protocol.frame(m.t);

    // A capability this build does not have. Until this arm existed the frame was
    // dropped in silence: the master's promise sat there until transport.js gave up
    // 20 seconds later with AGENT_TIMEOUT, which reads to the person waiting like
    // the product is broken rather than like a machine needing an update. Answered
    // under the SAME `t` the master asked with, because that is the only type name
    // this build can know; an unlisted reply type is rejected by the master's own
    // default arm, so the caller learns at once either way.
    //
    // Only when there is an `id` to answer against: a fire-and-forget frame has
    // nothing to correlate a refusal with, and inventing a reply for one would put
    // an unmatched frame on a channel that has always been quiet.
    if (!row) {
      if (m.id != null) send({ t: m.t, id: m.id, ok: false, error: `agent is out of date (this machine cannot do '${m.t}'). Update the agent`, code: 'AGENT_OUTDATED' });
      return;
    }

    // One shared op check, in place of the four hand-written `unknown op: ${m.op}`
    // replies this used to end in. Those carried no code, so a refusal was
    // indistinguishable from a real failure and reached a user as a row reading
    // "unknown op: usage". A row that declares a defaultOp keeps its fall-through
    // for a frame naming no op; what is refused is a NAMED op this build lacks.
    if (row.ops && !protocol.opAllowed(m.t, m.op)) {
      if (m.id != null) send({ t: row.reply, id: m.id, ok: false, error: `agent is out of date (${m.t} here has no '${m.op}'). Update the agent`, code: 'AGENT_OUTDATED' });
      return;
    }

    // A converted op answers here. What is left in the switch below is what has
    // not been converted yet, and it shrinks: an op moves out of the switch only
    // once it has tests, because converting thirty untested things is gambling.
    const op = ops.get(m.t);
    if (op) {
      let out;
      try {
        out = await op.handler(m);
      } catch (e) {
        const body = e && e.capRefusal
          ? { error: e.message, ...(e.capCode ? { code: e.capCode } : {}), ...(e.capExtra || {}) }
          : (op.onError ? op.onError(e) : { error: e && (e.code || e.message) });
        // WHO hears about a failure is the row's business, not the handler's.
        //
        // 'none' has nobody to tell. The master minted no pending entry for it, so
        // a frame answering one would arrive uncorrelated on a channel that has
        // been quiet since the protocol existed. Logged instead, which is strictly
        // more than the switch did: `caps.handle(m)` is called in agent.js:594
        // with no catch, so an op that threw took the whole agent down with an
        // unhandled rejection. That was reachable, and this is what closes it.
        //
        // 'stream' carries no `ok` at all (the table's own words for the family),
        // so its refusal is the one frame its reader will ever get and it has to
        // look exactly like the frames that reader already handles. The master's
        // fsEvent arm hands it to the watch callback verbatim.
        if (op.family === 'none') return void logSwallowed(m.t, e);
        if (op.family === 'stream') return void send({ t: op.reply, id: m.id, ...body });
        return void send({ t: op.reply, id: m.id, ok: false, ...body });
      }
      // A reply-less op has already said everything it is ever going to say: a
      // stream op over its own id for as long as it lives, a 'none' op nothing at
      // all. There is no terminal frame to stamp, and stamping one would put an
      // unmatched frame on the wire.
      if (op.family === 'none' || op.family === 'stream') return;
      return void sendReply(m, { t: op.reply, id: m.id, ok: true, ...(out || {}) });
    }
  }

  // The connection died. Engine runs keep going (agent/engine-runs.js is module
  // level and outlives this connection); only this connection's subscriptions to
  // them end, and the master resubscribes from the last seq it saw. Watchers close
  // too: the master re-issues them on reconnect (ensureWatches), and a watcher has
  // no state worth keeping.
  function park() {
    for (const off of engineSubs.values()) off();
    engineSubs.clear();
    for (const w of watchers.values()) try { w.close(); } catch {}
    for (const b of watchBatches.values()) if (b.timer) clearTimeout(b.timer);
    watchers.clear(); watchBatches.clear();
  }

  // Real shutdown (the self-update exit path): nothing survives this process,
  // so nothing may outlive it — an orphaned engine's live-registry pid
  // view-only-locks its session until it happens to die.
  function destroy() {
    engineSubs.clear();
    runs.destroyAll();
    for (const w of watchers.values()) try { w.close(); } catch {}
    for (const b of watchBatches.values()) if (b.timer) clearTimeout(b.timer);
    watchers.clear(); watchBatches.clear();
  }

  // "busy" = an engine run is unfinished: a live turn self-update must not cut off.
  // `indexPeek`: the dial's catch-up walk, whose { epoch, gen } rides the hello
  // so a master already holding that generation asks nothing (agent.js).
  return { handle, park, destroy, roots: ROOTS, busy: () => runs.busy() > 0, engineRuns: () => runs.list(), engineServers: () => runs.servers(), indexPeek: () => (sessionIndex ? sessionIndex.refresh() : Promise.resolve(null)) };
}

// bgLogPathOk is exported for the same reason `confined` is: it is a security
// boundary, and a boundary that can only be exercised through a live WebSocket
// is a boundary nobody tests. See tests/bg-shell-confinement.mjs.
module.exports = { makeCapabilities, confined, bgLogPathOk, claudeEffortLevels, ROOTS, ENGINES };
