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
const { spawn, execFile } = require('child_process');
const { randomUUID } = require('crypto');
// Park-don't-kill (LIVE-DEPLOY Phase 2): children survive socket closes in a
// module-level registry — capabilities are remade per connection, parked
// children must not be. killTree lives there now (one copy, both callers).
const { registry: parkRegistry, killTree } = require('./park');
const diffLib = require('./diff'); // stub → ../lib/diff (repo run); shipped as diff.js on installed agents
// Tail reads — how the master gets "the last fifteen messages" without pulling
// the whole transcript across the tunnel. Guarded like the readers below: an
// agent that pulled a new capabilities.js before tail-read.js landed still
// boots, and the master falls back to the whole-file read it used before.
let tailReadLib; try { tailReadLib = require('./tail-read'); } catch { tailReadLib = null; }
// The session index's head/tail parse, run agent-side so the bytes stay here.
// Guarded like the rest: a missing module degrades `indexHeads` to AGENT_OUTDATED
// and the master falls back to reading the file itself, rather than crash-looping.
let indexHeadLib; try { indexHeadLib = require('./index-head'); } catch { indexHeadLib = null; }
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
// ChatGPT (Codex) account switching — same deal one engine over. Note there is
// deliberately NO reloadCodex hook here: the `codex app-server` child runs on
// this box but was spawned through the 'spawn' capability by the MASTER's
// RemoteCodexRunner, which owns its stdin and its lifetime. This process cannot
// see it, so recycling it after a switch is machine-host.js's job (and the
// in-flight turn count it passes in for the same reason).
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

// CLAUDE_CONFIG_DIR relocates Claude Code's whole data dir (SDK-supported var).
// The confinement root MUST follow it — an agent that reads from the configured
// dir but confines to the hardcoded default would authorise nothing and refuse
// its own reads (or worse, authorise the wrong tree). Unset ⇒ today's ~/.claude.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
// Grok's ~/.grok holds auth.json (the OIDC access + refresh token) directly at its
// root — unlike CLAUDE_DIR/CODEX_HOME (whole-home roots, no bare secret file at the
// top level), granting the whole dir would make that token readable over the tunnel.
// Confine grok to ITS SESSIONS SUBTREE ONLY, the one thing the master actually needs
// to render transcripts (mirrors lib/grok-data.js's SESSIONS_DIR).
const GROK_DIR = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
const GROK_SESSIONS_ROOT = path.join(GROK_DIR, 'sessions');

const ROOTS = [
  CLAUDE_DIR,
  process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  GROK_SESSIONS_ROOT,
];
// Resolve the roots' own symlinks once at startup so the prefix check compares real paths.
const REAL_ROOTS = ROOTS.map((r) => { try { return fs.realpathSync(r); } catch { return path.resolve(r); } });

const within = (rp) => REAL_ROOTS.some((r) => rp === r || rp.startsWith(r + path.sep));
const rootOf = (rp) => REAL_ROOTS.find((r) => rp === r || rp.startsWith(r + path.sep));

// Defense in depth (on top of the root scoping above, not instead of it): refuse these
// basenames outright even if some future root ever widened to cover them — auth.json
// (grok's OIDC token) and .credentials.json (Claude's OAuth token, which already sits
// INSIDE the whole-home CLAUDE_DIR root today) must never cross the tunnel as a plain
// file read, however a root gets misconfigured.
const DENYLIST_BASENAMES = new Set(['auth.json', '.credentials.json']);

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
// `upTo` turns the same machinery into a FORK (SDK-SIGNALS §F): keep everything
// through the record with that uuid and drop the rest. Mirrors server.js's copy
// exactly — an unknown uuid THROWS rather than cloning the whole conversation,
// because a "branch from here" that quietly branched from the end is a copy the
// user would only catch by reading it.
function rewriteDuplicateTranscript(content, oldSessionId, newId, newCwd, upTo) {
  let lines = content.split('\n');
  let records = lines.map((line) => {
    if (!line.trim()) return undefined;
    try { return JSON.parse(line); } catch { return undefined; }
  });
  if (upTo) {
    const cut = records.findIndex((rec) => rec && rec.uuid === upTo);
    if (cut < 0) throw Object.assign(new Error('fork point not in transcript'), { code: 'BAD_FORK_POINT' });
    lines = lines.slice(0, cut + 1);
    records = records.slice(0, cut + 1);
  }
  const uuidMap = new Map();
  for (const rec of records) {
    if (rec && typeof rec.uuid === 'string' && RECORD_UUID_RE.test(rec.uuid)) uuidMap.set(rec.uuid, randomUUID());
  }
  return records
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
}

// Containment mirrors resolveTranscriptPath but resolves SYMLINKS too (path.resolve only
// collapses `..`): realpath the target so a symlink inside a root that points outside can't
// smuggle an out-of-root read. For a path that doesn't exist yet (e.g. watch-before-create)
// resolve the parent and re-append the basename. Fail closed on any resolve error.
async function confined(p) {
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

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ENGINES = {
  claude: resolveEngine('claude', 'TERMDECK_CLAUDE_EXE'),
  codex: resolveEngine('codex', 'TERMDECK_CODEX_EXE', [path.join(CODEX_HOME, 'packages', 'standalone', 'current', 'bin')]),
  // Mirrors lib/grok-runner.js's own resolveGrokExe() candidate order (env override,
  // ~/.local/bin, ~/.grok/bin, PATH) so the agent finds the same binary the hub would.
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
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
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
function claudeModelsOrThrow(reason) {
  if (claudeModelCache) return claudeModelCache.models;
  const err = new Error('Failed to fetch models');
  err.code = 'MODELS_UNAVAILABLE';
  err.reason = reason;
  throw err;
}

async function getClaudeModels() {
  if (claudeModelCache && Date.now() - claudeModelCache.at < MODEL_CACHE_MS) return claudeModelCache.models;
  const cred = await claudeModelCred();
  if (!cred || typeof fetch !== 'function') {
    return claudeModelsOrThrow(cred ? 'no fetch available' : 'this machine has no Claude login — run `claude` on it and sign in');
  }
  const headers = { 'anthropic-version': '2023-06-01', [cred.header]: cred.value };
  if (cred.oauth) headers['anthropic-beta'] = 'oauth-2025-04-20';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${anthropicBase()}/v1/models?limit=100`, { headers, signal: ctrl.signal });
    if (!r.ok) {
      // 401/403 on a box that HAS a credential is a login problem, not a network
      // one, and saying so is the difference between a fix and a support ticket.
      const why =
        r.status === 401 || r.status === 403
          ? cred.stale
            ? 'the Claude login on this machine has gone stale — run `claude` on it once to refresh it, and sign in again if it asks'
            : `the Claude login on this machine was rejected (${r.status} from ${cred.how})`
          : `the model list request failed (${r.status})`;
      return claudeModelsOrThrow(why);
    }
    const body = await r.json();
    const fetched = (body.data || []).map((m) => {
      const caps = m.capabilities || null;
      return {
        id: m.id,
        label: (m.display_name || m.id).replace(/^Claude /, ''),
        thinking: caps && caps.thinking ? !!caps.thinking.supported : null,
        effortLevels: caps && caps.effort ? EFFORT_LEVELS.filter((l) => caps.effort[l] && caps.effort[l].supported) : null,
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
function runVersion(exe) {
  return new Promise((resolve) => {
    if (!exe) return resolve(null);
    const win = process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe);
    execFile(win ? `"${exe}"` : exe, ['--version'], { timeout: 8000, ...(win ? { shell: true } : {}) }, (err, stdout) => {
      if (err) return resolve(null);
      const line = String(stdout || '').trim().split('\n')[0] || '';
      resolve(line.slice(0, 80) || null);
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

async function claudeLogin() {
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
      const [version, auth] = await Promise.all([
        present ? runVersion(exe) : Promise.resolve(null),
        engine === 'claude' ? claudeLogin() : engine === 'codex' ? codexLogin() : Promise.resolve(grokLogin()),
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
      // Claude's catalog is the one the browser fetches through this agent, so the
      // status page answers "why is my model picker empty?" without a second trip.
      if (engine === 'claude' && present) {
        try {
          const models = await getClaudeModels();
          row.models = { ok: true, count: models.length };
        } catch (e) {
          row.models = { ok: false, reason: e.reason || e.message };
        }
      }
      return row;
    })
  );
  return { engines, checkedAt: Date.now() };
}

function makeCapabilities(send) {
  const watchers = new Map(); // watchId -> chokidar watcher
  const procs = new Map();    // procId -> child process
  const persistentProcs = new Set(); // subset of procs that outlive a turn (the codex app-server, the grok agent-stdio child) — "busy" only while the master says a turn is running inside one
  // Children born on this connection get generation-scoped park keys, so a NEW
  // master's procIds (a fresh Transport counts from 1 again) can never collide
  // with a parked survivor of the old one.
  parkRegistry.newGeneration();

  async function handle(m) {
    switch (m && m.t) {
      case 'stat': {
        if (!(await confined(m.path))) return send({ t: 'stat', id: m.id, ok: false, error: 'path not permitted' });
        try { const s = await fsp.stat(m.path); send({ t: 'stat', id: m.id, ok: true, size: s.size, mtimeMs: s.mtimeMs }); }
        catch (e) { send({ t: 'stat', id: m.id, ok: false, error: e.code || e.message }); }
        return;
      }
      case 'list': {
        if (!(await confined(m.path))) return send({ t: 'list', id: m.id, ok: false, error: 'path not permitted' });
        try {
          const ents = await fsp.readdir(m.path, { withFileTypes: true });
          const entries = [];
          for (const e of ents) {
            let size = 0, mtimeMs = 0;
            if (e.isFile()) { try { const s = await fsp.stat(path.join(m.path, e.name)); size = s.size; mtimeMs = s.mtimeMs; } catch {} }
            entries.push({ name: e.name, dir: e.isDirectory(), size, mtimeMs });
          }
          send({ t: 'list', id: m.id, ok: true, entries });
        } catch (e) { send({ t: 'list', id: m.id, ok: false, error: e.code || e.message }); }
        return;
      }
      // The session index's own walk. Same tree `listTree` returns, minus the
      // files the master was always going to throw away, and in a compact shape.
      //
      // WHY: the master rebuilds its index whenever a transcript changes — which,
      // on a box you are actually working on, is constantly — and each rebuild
      // re-fetched the WHOLE tree. Measured on a real box: 2,675 entries / 790 KB
      // per rebuild, of which ~755 were sessions and the rest were subagent
      // transcripts and sidecars the master discards on arrival. That 790 KB is
      // an uplink round trip on a home connection, and it showed up as a flat
      // ~2.3s added to /api/sessions every time the index was dirty.
      //
      // The filter here is deliberately COARSE and structural. The master still
      // owns the exact shape rules (UUID_JSONL / ROLLOUT_RE / the grok id regex)
      // and re-checks every row this returns — all this does is refuse to put a
      // file on the wire that could not possibly be a session. Keeping it
      // structural rather than a second copy of the master's regexes is what
      // stops the two from drifting.
      case 'indexScan': {
        if (!(await confined(m.path))) return send({ t: 'indexScan', id: m.id, ok: false, error: 'path not permitted' });
        try {
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
          send({ t: 'indexScan', id: m.id, ok: true, root, sep: path.sep, files, truncated });
        } catch (e) { send({ t: 'indexScan', id: m.id, ok: false, error: e.code || e.message }); }
        return;
      }
      // Parse the index's head/tail metadata HERE, where the disk is, and send
      // back the answer instead of the bytes. The master used to stream 124 MB
      // across 581 reads to index 200 sessions; this is the same parse (one
      // shared module, lib/index-head.js — never a second copy) returning a few
      // hundred bytes per file. Every path is confined exactly like readFile.
      case 'indexHeads': {
        if (!indexHeadLib) return send({ t: 'indexHeads', id: m.id, ok: false, error: 'agent is out of date (index-head module missing) — update the agent', code: 'AGENT_OUTDATED' });
        try {
          const rows = Array.isArray(m.rows) ? m.rows.slice(0, 1000) : [];
          const io = headIo();
          const heads = [];
          for (const row of rows) {
            // Confinement is per ROW, not per batch: one bad path must not
            // decide anything about the others, and must never be read.
            if (!row || typeof row.path !== 'string' || !(await confined(row.path))) { heads.push(null); continue; }
            try { heads.push(await indexHeadLib.readIndexHead(row, io)); } catch { heads.push(null); }
          }
          send({ t: 'indexHeads', id: m.id, ok: true, heads });
        } catch (e) { send({ t: 'indexHeads', id: m.id, ok: false, error: e.code || e.message }); }
        return;
      }
      // Per-chat Termdeck preferences that live on THIS machine (the thinking
      // dial today). The master's copy is in memory only, so a master restart
      // used to drop the dial to "Default" while the reader believed thinking
      // was off, and a second device never knew about it at all.
      //
      // The master names a SESSION ID and a typed value — never a path. The file
      // is resolved here against our own CLAUDE_DIR root and built by the same
      // module the master validates with, so this cannot be steered into writing
      // somewhere else or writing something else.
      case 'sessionSettings': {
        if (!sessionSettingsLib) return send({ t: 'sessionSettings', id: m.id, ok: false, error: 'agent is out of date (session-settings module missing) — update the agent', code: 'AGENT_OUTDATED' });
        try {
          const root = REAL_ROOTS[0]; // CLAUDE_DIR — the thinking dial is a Claude setting
          if (m.op === 'set') {
            const value = await sessionSettingsLib.writeThinking(root, m.sessionId, m.thinking ?? null);
            return send({ t: 'sessionSettings', id: m.id, ok: true, thinking: value });
          }
          if (m.op === 'setRunOptions') {
            // Validation is the shared module's, run HERE as well as on the
            // master: these values become argv for a process on this box, and a
            // master is not the thing that gets to decide that.
            if (!sessionSettingsLib.writeRunOptions) return send({ t: 'sessionSettings', id: m.id, ok: false, error: 'agent is out of date (run options unsupported) — update the agent', code: 'AGENT_OUTDATED' });
            const value = await sessionSettingsLib.writeRunOptions(root, m.sessionId, m.runOptions ?? null);
            return send({ t: 'sessionSettings', id: m.id, ok: true, runOptions: value });
          }
          return send({ t: 'sessionSettings', id: m.id, ok: true, settings: await sessionSettingsLib.readSettings(root) });
        } catch (e) { send({ t: 'sessionSettings', id: m.id, ok: false, error: e.code || e.message }); }
        return;
      }
      case 'listTree': {
        // Recursive file walk (one round trip vs one-per-dir). Files only, capped. Confined.
        if (!(await confined(m.path))) return send({ t: 'listTree', id: m.id, ok: false, error: 'path not permitted' });
        try {
          const ents = await fsp.readdir(m.path, { recursive: true, withFileTypes: true });
          const files = [];
          for (const e of ents) {
            if (!e.isFile()) continue;
            const full = path.join(e.parentPath || m.path, e.name);
            let st; try { st = await fsp.stat(full); } catch { continue; }
            files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
            if (files.length >= 4000) break; // ponytail: cap the payload; enrich w/ agent-side index if a fleet outgrows it
          }
          send({ t: 'listTree', id: m.id, ok: true, files });
        } catch (e) { send({ t: 'listTree', id: m.id, ok: false, error: e.code || e.message }); }
        return;
      }
      case 'readFile': {
        if (!(await confined(m.path))) return send({ t: 'fileChunk', id: m.id, ok: false, error: 'path not permitted' });
        try {
          const fd = await fsp.open(m.path, 'r');
          try {
            const st = await fd.stat();
            const offset = m.offset || 0;
            const len = m.len == null ? Math.max(0, st.size - offset) : m.len;
            const buf = Buffer.alloc(Math.max(0, len));
            const { bytesRead } = len > 0 ? await fd.read(buf, 0, len, offset) : { bytesRead: 0 };
            send({ t: 'fileChunk', id: m.id, ok: true, data: buf.subarray(0, bytesRead).toString('base64'), size: st.size, eof: offset + bytesRead >= st.size });
          } finally { await fd.close(); }
        } catch (e) { send({ t: 'fileChunk', id: m.id, ok: false, error: e.code || e.message }); }
        return;
      }
      // The last bytes of a transcript, from a line boundary, plus how many
      // lines precede them. Same confinement as readFile — it IS a readFile,
      // with the offset chosen here because only this side can see the file
      // cheaply. This is what stops a 51 MB chat from crossing the tunnel to
      // show fifteen messages; the counting pass is local disk I/O.
      case 'readTail': {
        if (!(await confined(m.path))) return send({ t: 'tailChunk', id: m.id, ok: false, error: 'path not permitted' });
        if (!tailReadLib) return send({ t: 'tailChunk', id: m.id, ok: false, error: 'agent outdated: tail-read.js missing', code: 'AGENT_OUTDATED' });
        try {
          const maxBytes = Math.max(4096, Math.min(8 * 1024 * 1024, m.maxBytes || tailReadLib.TAIL_BYTES));
          // headBytes: some engines write model/effort/permission mode ONCE at
          // the top of the rollout, so the master asks for the opening records
          // too. Bounded here as well — this is a capability, not a file server.
          const headBytes = Math.max(0, Math.min(256 * 1024, m.headBytes || 0));
          const tail = await tailReadLib.readTail(m.path, maxBytes, { headBytes });
          send({
            t: 'tailChunk',
            id: m.id,
            ok: true,
            data: tail.buf.toString('base64'),
            head: tail.head ? tail.head.toString('base64') : null,
            startLine: tail.startLine,
            whole: tail.whole,
            size: tail.size,
            mtimeMs: tail.mtimeMs,
          });
        } catch (e) { send({ t: 'tailChunk', id: m.id, ok: false, error: e.code || e.message }); }
        return;
      }
      case 'watch': {
        if (!(await confined(m.path))) return send({ t: 'fsEvent', id: m.id, path: m.path, error: 'path not permitted' });
        if (!chokidar) return send({ t: 'fsEvent', id: m.id, path: m.path, error: 'watch unavailable' });
        const w = chokidar.watch(m.path, { ignoreInitial: true, followSymlinks: false });
        // Report WHICH file changed (chokidar's per-file path) — a directory watch is
        // useless to the master's per-session cursors otherwise. Falls back to the
        // watched root for older chokidar event shapes.
        const emit = (p) => { const fp = p || m.path; let size = 0; try { size = fs.statSync(fp).size; } catch {} send({ t: 'fsEvent', id: m.id, path: fp, size }); };
        w.on('add', emit).on('change', emit).on('unlink', (p) => send({ t: 'fsEvent', id: m.id, path: p || m.path, size: 0, unlink: true }));
        watchers.set(m.id, w);
        return;
      }
      case 'unwatch': { const w = watchers.get(m.id); if (w) { w.close(); watchers.delete(m.id); } return; }
      case 'mutate': {
        // The agent's ONLY write path, and it stays inside the trust boundary: every
        // target is confined() to a transcript root, and 'trash' moves into a hidden
        // dir INSIDE that same root (never ~/.termdeck or anywhere else) so a master
        // compromise still can't write outside .claude/.codex.
        if (!(await confined(m.path))) return send({ t: 'mutate', id: m.id, ok: false, error: 'path not permitted' });
        try {
          if (m.op === 'trash') {
            const rp = await fsp.realpath(m.path);
            const root = rootOf(rp);
            if (!root) return send({ t: 'mutate', id: m.id, ok: false, error: 'path not permitted' });
            const trashDir = path.join(root, '.termdeck-trash');
            await fsp.mkdir(trashDir, { recursive: true });
            await moveFile(rp, path.join(trashDir, `${Date.now()}-${path.basename(rp)}`));
            return send({ t: 'mutate', id: m.id, ok: true });
          }
          if (m.op === 'duplicate') {
            // Claude-only (plain .jsonl). The master picks newId; the destination is
            // computed HERE (same dir, using this box's own path rules) so a Windows
            // agent doesn't get a POSIX-joined path from the master. An optional newCwd
            // moves the clone into THAT folder's own project dir (same slug rule the CLI
            // itself uses) — mirrors the 'spawn' cwd check: an existing folder, or a clear
            // error, not a silent wrong-directory clone.
            if (typeof m.newId !== 'string' || !/^[0-9a-f-]{36}$/i.test(m.newId)) return send({ t: 'mutate', id: m.id, ok: false, error: 'bad newId' });
            const rp = await fsp.realpath(m.path);
            let dst = path.join(path.dirname(rp), `${m.newId}.jsonl`);
            const newCwd = typeof m.newCwd === 'string' && m.newCwd.trim() ? m.newCwd.trim() : null;
            if (newCwd) {
              let isDir = false;
              try { isDir = fs.statSync(newCwd).isDirectory(); } catch {}
              if (!isDir) return send({ t: 'mutate', id: m.id, ok: false, error: 'bad cwd' });
              const destDir = path.join(CLAUDE_DIR, 'projects', newCwd.replace(/[^A-Za-z0-9]/g, '-'));
              if (!(await confined(destDir))) return send({ t: 'mutate', id: m.id, ok: false, error: 'dst not permitted' });
              await fsp.mkdir(destDir, { recursive: true });
              dst = path.join(destDir, `${m.newId}.jsonl`);
            }
            if (!(await confined(dst))) return send({ t: 'mutate', id: m.id, ok: false, error: 'dst not permitted' });
            // Validated here as well as master-side: this decides how much of a
            // customer's transcript the clone keeps.
            const upTo = typeof m.upTo === 'string' && /^[0-9a-f-]{36}$/i.test(m.upTo) ? m.upTo : null;
            const out = rewriteDuplicateTranscript(await fsp.readFile(rp, 'utf8'), m.oldId, m.newId, newCwd, upTo);
            await fsp.writeFile(dst, out);
            return send({ t: 'mutate', id: m.id, ok: true });
          }
          if (m.op === 'title' || m.op === 'tag' || m.op === 'ai-title') {
            // A title/tag the TERMINAL also sees (SDK-SIGNALS §E). Narrow and
            // typed on purpose, exactly like `limits` and `models` below: the
            // master names the session and the string, never the record, so this
            // cannot be used to append arbitrary JSON into a transcript. The
            // record is built HERE by the same module the hub uses, so the two
            // paths cannot write different bytes.
            const rp = await fsp.realpath(m.path);
            if (!(await confined(rp))) return send({ t: 'mutate', id: m.id, ok: false, error: 'path not permitted' });
            const sessionTitle = require('./session-title');
            // `ai-title` is the DERIVED title Termdeck writes for a chat the CLI
            // never titled (see lib/session-title.js). Guarded on its own: an
            // agent that pulled this capabilities.js before session-title.js
            // must say so rather than throw, exactly like the module guards up top.
            if (m.op === 'ai-title' && typeof sessionTitle.aiTitleRecord !== 'function') {
              return send({ t: 'mutate', id: m.id, ok: false, error: 'agent is out of date (ai-title unsupported) — update the agent', code: 'AGENT_OUTDATED' });
            }
            const record = m.op === 'title'
              ? sessionTitle.titleRecord(m.sessionId, m.title)
              : m.op === 'ai-title'
              ? sessionTitle.aiTitleRecord(m.sessionId, m.title)
              : sessionTitle.tagRecord(m.sessionId, m.tag ?? null);
            await sessionTitle.appendRecord(rp, record);
            return send({ t: 'mutate', id: m.id, ok: true });
          }
          return send({ t: 'mutate', id: m.id, ok: false, error: `unknown op: ${m.op}` });
        } catch (e) {
          send({ t: 'mutate', id: m.id, ok: false, error: e.code || e.message });
        }
        return;
      }
      case 'restore': {
        // /rewind on the cloud path. This is the one capability that writes OUTSIDE
        // the transcript roots — it has to, the files it rolls back are the
        // customer's own checkout — so the trust boundary is drawn differently and
        // has to hold on its own terms: the master names a TRANSCRIPT (confined,
        // like every other path it may name) and a list of checkpoint ids, and
        // nothing else. Which files exist, where they live and what bytes go into
        // them are all read HERE, from this box's own transcript records and its own
        // ~/.claude/file-history blobs. There is no path and no content in the
        // request, so a compromised master cannot use this to write a file of its
        // choosing anywhere — the worst it can do is roll a real checkpoint of a
        // real session back, which is the feature.
        try {
          if (!checkpointsLib) return send({ t: 'restore', id: m.id, ok: false, error: 'agent is out of date (checkpoints module missing) — update the agent', code: 'AGENT_OUTDATED' });
          if (!(await confined(m.path))) return send({ t: 'restore', id: m.id, ok: false, error: 'path not permitted' });
          const rp = await fsp.realpath(m.path);
          if (typeof m.sessionId !== 'string' || !RECORD_UUID_RE.test(m.sessionId)) return send({ t: 'restore', id: m.id, ok: false, error: 'bad sessionId' });
          // The ids index the backup blobs under file-history/<sessionId>/, so a
          // junk one can only fail to resolve — but they are validated anyway, on
          // both sides, exactly like `upTo` on duplicate.
          const ids = (Array.isArray(m.messageIds) ? m.messageIds : []).filter((x) => typeof x === 'string' && RECORD_UUID_RE.test(x));
          if (!ids.length) return send({ t: 'restore', id: m.id, ok: false, error: 'messageIds required' });
          if (ids.length > 500) return send({ t: 'restore', id: m.id, ok: false, error: 'too many checkpoints' });
          // cwd is deliberately NOT taken from the request: resolveCheckpoint reads
          // it out of the transcript itself, and a delta's realParentDir wins over
          // even that. The master never gets to say where a file lands.
          const data = checkpointsLib.restoreCheckpoint(rp, m.sessionId, null, ids, { dryRun: !!m.dryRun });
          if (data && data.error) return send({ t: 'restore', id: m.id, ok: false, error: data.error, status: 404 });
          return send({ t: 'restore', id: m.id, ok: true, data });
        } catch (e) {
          send({ t: 'restore', id: m.id, ok: false, error: e.code || e.message });
        }
        return;
      }
      case 'projectDoc': {
        // The project's instruction file, read and written (U5's editor, and
        // V3 §B's `#`). The SECOND write outside the transcript roots after
        // `restore`, and drawn on the same terms as `projectFiles` one direction
        // over: the master names a CONFINED transcript and an engine, never a
        // path and never a filename. The root is resolved HERE out of that
        // transcript's own head, and the filename comes from a fixed table in
        // the shared module — a name from the request would be a path from the
        // request wearing a hat.
        //
        // Nothing throws out of this case: an uncaught rejection here takes the
        // agent down and view-only-locks every live chat on the box.
        try {
          if (!projectDocLib || !indexHeadLib) return send({ t: 'projectDoc', id: m.id, ok: false, error: 'agent is out of date (project-doc module missing) — update the agent', code: 'AGENT_OUTDATED' });
          if (!(await confined(m.path))) return send({ t: 'projectDoc', id: m.id, ok: false, error: 'path not permitted' });
          const rp = await fsp.realpath(m.path);
          const engine = m.engine === 'codex' || m.engine === 'grok' ? m.engine : 'claude';
          let sizeBytes = 0;
          try { sizeBytes = (await fsp.stat(rp)).size; } catch {}
          const head = await indexHeadLib.readIndexHead({ path: rp, engine, zst: rp.endsWith('.zst'), sizeBytes }, headIo());
          if (!head || !head.cwd) return send({ t: 'projectDoc', id: m.id, ok: false, error: 'This chat has no project folder on disk yet', code: 'NO_CWD' });
          let root;
          try { root = await fsp.realpath(head.cwd); } catch { return send({ t: 'projectDoc', id: m.id, ok: false, error: `Project folder is missing: ${head.cwd}`, code: 'NO_CWD' }); }

          if (m.op === 'write') {
            const r = await projectDocLib.writeDoc(root, engine, typeof m.content === 'string' ? m.content : '');
            return send({ t: 'projectDoc', id: m.id, ok: true, doc: { ...r, content: typeof m.content === 'string' ? m.content : '' } });
          }
          if (m.op === 'append') {
            const r = await projectDocLib.appendDoc(root, engine, m.text);
            return send({ t: 'projectDoc', id: m.id, ok: true, doc: await projectDocLib.readDoc(root, engine), wrote: r.bytes });
          }
          return send({ t: 'projectDoc', id: m.id, ok: true, doc: await projectDocLib.readDoc(root, engine) });
        } catch (e) {
          const denied = e.code === 'EACCES' || e.code === 'EPERM';
          send({ t: 'projectDoc', id: m.id, ok: false, error: denied ? 'Permission denied' : (e.message || e.code), code: denied ? 'DENIED' : (e.code || 'DOC_FAILED') });
        }
        return;
      }
      case 'commandCatalog': {
        // What this chat can type after a slash, and what each one does. Drawn
        // on `projectDoc`'s terms exactly: the master names a CONFINED
        // transcript and an engine, never a cwd — the project root is resolved
        // HERE out of that transcript's own head.
        //
        // Unlike projectDoc, a chat with NO cwd is not an error. The user's own
        // commands are still a real answer, and a palette that refuses to open
        // because a folder was renamed is worse than one missing a few rows.
        //
        // The grok tier reads ~/.grok/{commands,skills}, which are outside this
        // agent's roots on purpose — see the note in lib/command-catalog.js.
        // Nothing throws out of this case: an uncaught rejection takes the agent
        // down and view-only-locks every live chat on the box.
        try {
          if (!commandCatalogLib || !indexHeadLib) return send({ t: 'commandCatalog', id: m.id, ok: false, error: 'agent is out of date (command-catalog module missing) — update the agent', code: 'AGENT_OUTDATED' });
          const engine = m.engine === 'codex' || m.engine === 'grok' ? m.engine : 'claude';
          let cwd = null;
          if (typeof m.path === 'string' && m.path) {
            if (!(await confined(m.path))) return send({ t: 'commandCatalog', id: m.id, ok: false, error: 'path not permitted' });
            const rp = await fsp.realpath(m.path);
            let sizeBytes = 0;
            try { sizeBytes = (await fsp.stat(rp)).size; } catch {}
            try {
              const head = await indexHeadLib.readIndexHead({ path: rp, engine, zst: rp.endsWith('.zst'), sizeBytes }, headIo());
              if (head && head.cwd) cwd = await fsp.realpath(head.cwd);
            } catch { cwd = null; }
          } else if (typeof m.cwd === 'string' && m.cwd) {
            // The new-chat page: no transcript exists yet to resolve a project
            // root from. Like the 'git' capability's cwd ops, this is NOT
            // confined to the transcript roots — projects live wherever the
            // user codes, and the master only ever sends back a path this SAME
            // browser session chose through the folder picker.
            try { cwd = await fsp.realpath(m.cwd); } catch { cwd = null; }
          }
          const data = await commandCatalogLib.readCatalog({
            engine,
            cwd,
            claudeDir: REAL_ROOTS[0],
            codexHome: REAL_ROOTS[1],
            grokDir: GROK_DIR,
          });
          return send({ t: 'commandCatalog', id: m.id, ok: true, data });
        } catch (e) {
          const denied = e.code === 'EACCES' || e.code === 'EPERM';
          send({ t: 'commandCatalog', id: m.id, ok: false, error: denied ? 'Permission denied' : (e.message || e.code), code: denied ? 'DENIED' : (e.code || 'CATALOG_FAILED') });
        }
        return;
      }
      case 'usageBehaviour': {
        // WHY the account's limit is being spent (the `/usage` breakdown), read
        // off this machine's own transcripts. Like `machineConfig` it takes NO
        // argument at all: the root is this agent's own, and there is nothing
        // here for a master to name. It reads a lot of disk and returns a few
        // hundred bytes, which is the whole reason it runs here.
        if (!usageBehaviourLib) return send({ t: 'usageBehaviour', id: m.id, ok: false, error: 'agent is out of date (usage-behaviour module missing) — update the agent', code: 'AGENT_OUTDATED' });
        try {
          send({ t: 'usageBehaviour', id: m.id, ok: true, data: await usageBehaviourLib.readUsageBehaviour(REAL_ROOTS[0]) });
        } catch (e) {
          send({ t: 'usageBehaviour', id: m.id, ok: false, error: e.code || e.message, code: 'USAGE_FAILED' });
        }
        return;
      }
      case 'machineConfig': {
        // What the engine is CONFIGURED with (V3 §G + U2's viewer + U9's chain).
        // Everything it reads is inside a transcript ROOT, so this widens
        // nothing — it exists because a browser fetching each of these files
        // over the tunnel would cost dozens of round trips to draw one panel.
        // The master names no path; the root is this agent's own.
        if (!machineConfigLib) return send({ t: 'machineConfig', id: m.id, ok: false, error: 'agent is out of date (machine-config module missing) — update the agent', code: 'AGENT_OUTDATED' });
        try {
          send({ t: 'machineConfig', id: m.id, ok: true, claude: await machineConfigLib.readClaudeConfig(REAL_ROOTS[0]) });
        } catch (e) {
          send({ t: 'machineConfig', id: m.id, ok: false, error: e.code || e.message, code: 'CONFIG_FAILED' });
        }
        return;
      }
      case 'projectFiles': {
        // Read-only browsing of a chat's PROJECT folder. Like `restore` this
        // reaches outside the transcript roots — it has to, the files are the
        // customer's own checkout — so it is drawn on the same terms, one
        // direction over: the master names a TRANSCRIPT (confined, like every
        // other path it may name) and a RELATIVE path, and nothing else. Where
        // the project root IS gets read HERE, out of that transcript's own head,
        // by the same lib/index-head.js parse the session index uses. There is no
        // cwd and no absolute path in the request, so a compromised master cannot
        // aim this at a folder of its choosing — the worst it can do is read a
        // real project of a real session, which is the feature.
        //
        // `includeHidden` IS a master-named flag, and that is an accepted
        // widening documented like fsList's: it comes from a per-project toggle
        // the OWNER set in Settings, the master is the only side that holds that
        // preference, and it can only ever widen within a root already resolved
        // from the customer's own transcript. It cannot name a different root.
        //
        // Nothing throws out of this case (see the `usage` case's warning): an
        // uncaught rejection here takes the agent down and view-only-locks every
        // live chat on the box.
        try {
          if (!projectFilesLib || !indexHeadLib) return send({ t: 'projectFiles', id: m.id, ok: false, error: 'agent is out of date (project-files module missing) — update the agent', code: 'AGENT_OUTDATED' });
          // The string test first, before a single fs call — see validateRelPath.
          const v = projectFilesLib.validateRelPath(m.relPath);
          if (v.error) return send({ t: 'projectFiles', id: m.id, ok: false, error: v.error, code: v.code });
          if (!(await confined(m.path))) return send({ t: 'projectFiles', id: m.id, ok: false, error: 'path not permitted' });
          const rp = await fsp.realpath(m.path);
          const engine = m.engine === 'codex' || m.engine === 'grok' ? m.engine : 'claude';
          let sizeBytes = 0;
          try { sizeBytes = (await fsp.stat(rp)).size; } catch {}
          const head = await indexHeadLib.readIndexHead({ path: rp, engine, zst: rp.endsWith('.zst'), sizeBytes }, headIo());
          if (!head || !head.cwd) return send({ t: 'projectFiles', id: m.id, ok: false, error: 'This chat has no project folder on disk yet', code: 'NO_CWD' });
          let root;
          try { root = await fsp.realpath(head.cwd); } catch { return send({ t: 'projectFiles', id: m.id, ok: false, error: `Project folder is missing: ${head.cwd}`, code: 'NO_CWD' }); }

          // Policy runs on every segment, so `.git/config` is refused by its
          // first rather than by a rule about its last. Skipped entirely when the
          // owner has opted in — and skipped for a read that NAMES AN IMAGE.
          //
          // That last exemption is narrow and it is policy, not confinement:
          // resolveTarget below is the confinement and it runs either way. The
          // policy exists so a file tree opened on a phone cannot casually
          // surface a private key; a picture is not one, and it cannot be made
          // into one — readFileCapped decides the media type from a CLOSED
          // extension list that shares no member with the secret-shaped names, so
          // an exempted read can only ever come back as an <img>. Without it
          // every screenshot an agent takes into a dot-directory (`.claude/…`,
          // where this project's own worktrees live) is a file the person who
          // asked for it is refused, and the message that links it renders a
          // broken image.
          //
          // The name is only half of it: a symlink called `shot.png` is whatever
          // it points at. So an exempted path is re-checked against the RESOLVED
          // file below, and a hidden path that names no image is still refused
          // before anything touches disk.
          const refuseHidden = (seg) => send({ t: 'projectFiles', id: m.id, ok: false, error: `Hidden and sensitive files are turned off for this project (${seg})`, code: 'HIDDEN_BLOCKED' });
          const asked = m.includeHidden ? null : projectFilesLib.hiddenSegment(v.segments);
          if (asked && !(m.op === 'read' && projectFilesLib.imageTypeFor(m.relPath))) return refuseHidden(asked);

          const r = await projectFilesLib.resolveTarget(root, v.segments);
          if (r.error) return send({ t: 'projectFiles', id: m.id, ok: false, error: r.error, code: r.code });

          // …and again on the file the path RESOLVED to, which is the half that
          // holds. A name is not evidence: `shot.png` may be a symlink to `.env`,
          // and `notes.md` may be one to `.aws/credentials` — neither has a
          // hidden segment to refuse, so a policy that only ever reads the
          // REQUEST is one any project can walk straight past. Containment is
          // already settled above (resolveTarget realpaths and re-compares); this
          // is the policy catching up to it, on the same terms readFileCapped
          // uses to decide what the file IS.
          if (!m.includeHidden) {
            const real = path.relative(root, r.target).split(path.sep).filter(Boolean);
            const hidden = projectFilesLib.hiddenSegment(real);
            if (hidden && !(m.op === 'read' && projectFilesLib.imageTypeFor(r.target))) return refuseHidden(hidden);
          }

          // Every read below uses r.target — the RESOLVED path — never the
          // request string. Same TOCTOU rule as restore/mutate.
          if (m.op === 'read') {
            const data = await projectFilesLib.readFileCapped(r.target);
            if (data.error) return send({ t: 'projectFiles', id: m.id, ok: false, error: data.error, code: data.code });
            return send({ t: 'projectFiles', id: m.id, ok: true, name: path.basename(r.target), ...data });
          }
          const listing = await projectFilesLib.listDir(root, r.target, { includeHidden: !!m.includeHidden });
          return send({ t: 'projectFiles', id: m.id, ok: true, root, sep: path.sep, ...listing });
        } catch (e) {
          const denied = e && (e.code === 'EACCES' || e.code === 'EPERM');
          send({ t: 'projectFiles', id: m.id, ok: false, error: denied ? 'Permission denied' : (e.code || e.message), code: denied ? 'DENIED' : 'FILES_FAILED' });
        }
        return;
      }
      case 'pidAliveMany': {
        // Liveness only (signal 0, never delivered) — feeds the master's view-only
        // computation for the Claude live registry. EPERM = alive but not ours.
        const alive = (Array.isArray(m.pids) ? m.pids : []).filter((pid) => {
          if (typeof pid !== 'number') return false;
          try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
        });
        send({ t: 'pidAliveMany', id: m.id, ok: true, alive });
        return;
      }
      case 'agentLog': {
        // The agent's own log, tailed back to its owner's dashboard. Deliberately
        // NOT part of the readFile capability: that one is confined to the transcript
        // roots and must stay that way — this is one fixed file, no path parameter,
        // and nothing the agent serves is written into it (agent/log.js).
        try {
          const logLib = require('./log');
          send({ t: 'agentLog', id: m.id, ok: true, text: logLib.tail(Number(m.bytes) || 64 * 1024), file: logLib.LOG_FILE });
        } catch (e) { send({ t: 'agentLog', id: m.id, ok: false, error: e.message }); }
        return;
      }
      case 'limits': {
        // Account usage limits, computed on THIS box (the subscription token
        // stays local — only percentages go up to the master). Narrow + typed:
        // the master can't parameterize the endpoint, only ask for "the limits".
        try { send({ t: 'limits', id: m.id, ok: true, data: await require('./limits').getLimits() }); }
        catch (e) { send({ t: 'limits', id: m.id, ok: false, error: e.message }); }
        return;
      }
      case 'models': {
        // Claude model catalog, computed on THIS box for the same reason as
        // limits: subscription credentials stay local to the agent machine.
        if (m.engine && m.engine !== 'claude') return send({ t: 'models', id: m.id, ok: false, error: `engine not permitted: ${m.engine}` });
        try { send({ t: 'models', id: m.id, ok: true, models: await getClaudeModels() }); }
        // `reason` is the whole point of the failure: "Failed to fetch models" on
        // its own sends the person to us, "this machine has no Claude login" sends
        // them to the fix. Rides to the browser through /api/models.
        catch (e) { send({ t: 'models', id: m.id, ok: false, error: e.message, code: e.code || null, reason: e.reason || null }); }
        return;
      }
      case 'cliStatus': {
        // Read-only health of the three CLIs on this box. No args — there is
        // nothing to parameterise and nothing to get wrong.
        try { send({ t: 'cliStatus', id: m.id, ok: true, data: await cliStatus() }); }
        catch (e) { send({ t: 'cliStatus', id: m.id, ok: false, error: e.message }); }
        return;
      }
      case 'usage': {
        // Token spend for #/usage, computed on THIS box (the transcripts never
        // leave it — only the aggregated tokens go up to the master). Args are
        // MASTER-FORWARDED and validated HERE, not trusted: this is the first
        // capability whose args come from something other than a fixed enum
        // ('models'/'cwdCheck' above reject a bad engine / require a path the
        // same way). Verified: an unvalidated NaN tzOffset reaching lib/usage.js's
        // `new Date()` throws `RangeError: Invalid time value`, and agent.js's
        // uncaughtException handler calls process.exit(1) — so ONE malformed
        // query string would otherwise kill every live Claude/Codex session on
        // this box. Duplicated (not required) from lib/usage-query.js: the agent
        // ships as flat files off AGENT_FILES' manifest, and this check is six
        // lines — not worth a new manifest entry for. lib/usage.js ALSO validates
        // internally (assertValidDayString/assertValidTzOffset) — that's
        // intentional defense in depth, not a substitute for this: it's what
        // stops the RangeError above from ever reaching new Date() unguarded, but
        // this outer try/catch is what stops it from taking the process down.
        try {
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
          // projects: the sidebar-parity allowlist (follow-up to the shipped
          // feature) — master.js always sends an array (even [] for "zero
          // added projects"), never trusted as-is: same duplicated-not-required
          // reasoning as from/to/tzOffset above (lib/usage-query.js isn't in
          // AGENT_FILES). undefined => no filter, unchanged from before this arg existed.
          let projects;
          if (args.projects !== undefined) {
            // FIX 4: the raw string length must be checked BEFORE .split(',') —
            // splitting first lets a huge comma-heavy frame allocate an enormous
            // array up front, and an OOM from that allocation is NOT catchable
            // by this try/catch (V8 raises it as a fatal error), taking down
            // agent.js's whole process (its uncaughtException handler calls
            // process.exit(1)) and killing every live chat on this box. Same
            // 20000-char cap lib/usage-query.js's parseProjects uses (that file
            // already checks length before split — mirrored here, not required,
            // per the 'usage' case's header comment on why this duplicates
            // rather than imports it).
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
          const data = await require('./usage').getUsage({ from, to, tzOffset, projects });
          send({ t: 'usage', id: m.id, ok: true, data });
        } catch (e) {
          send({ t: 'usage', id: m.id, ok: false, error: e.message });
        }
        return;
      }
      case 'cwdCheck': {
        // Boolean-only validation for a user-supplied project folder. This does
        // not list or read the directory; it mirrors the spawn-time cwd stat.
        const cwd = typeof m.path === 'string' ? m.path : '';
        if (!cwd) return send({ t: 'cwdCheck', id: m.id, ok: false, error: 'Folder is required', code: 'BAD_CWD' });
        try {
          const st = await fsp.stat(cwd);
          if (!st.isDirectory()) return send({ t: 'cwdCheck', id: m.id, ok: false, error: `Not a folder: ${cwd}`, code: 'BAD_CWD' });
          send({ t: 'cwdCheck', id: m.id, ok: true, cwd });
        } catch {
          send({ t: 'cwdCheck', id: m.id, ok: false, error: `Folder does not exist: ${cwd}`, code: 'BAD_CWD' });
        }
        return;
      }
      case 'fsList': {
        // Folder picker (Settings → Projects → "Add folder"). DELIBERATELY OUTSIDE
        // the ROOTS confinement — the whole point is choosing a project folder,
        // which by definition is not under .claude/.codex. It stays narrow in the
        // other two axes instead: DIRECTORY NAMES ONLY (no file names, no
        // contents, no sizes — readFile is still root-confined and always will
        // be), and read-only. 'spawn' already takes an arbitrary cwd and 'cwdCheck'
        // already stats an arbitrary path, so the master could already probe a
        // path it guessed; this lets it enumerate rather than guess. That IS a
        // real widening — a master compromise can now map the customer's
        // directory tree — accepted knowingly so the cloud picker matches the
        // hub's. It still cannot read a single byte of any file it finds.
        const dir = typeof m.path === 'string' && m.path.trim() ? path.resolve(m.path.trim()) : os.homedir();
        try {
          if (!(await fsp.stat(dir)).isDirectory()) return send({ t: 'fsList', id: m.id, ok: false, error: `Not a folder: ${dir}`, code: 'BAD_CWD' });
        } catch {
          return send({ t: 'fsList', id: m.id, ok: false, error: `Folder does not exist: ${dir}`, code: 'BAD_CWD' });
        }
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
          send({ t: 'fsList', id: m.id, ok: true, path: dir, parent: parent === dir ? null : parent, home: os.homedir(), sep: path.sep, entries, truncated });
        } catch (e) {
          const denied = e.code === 'EACCES' || e.code === 'EPERM';
          send({ t: 'fsList', id: m.id, ok: false, error: denied ? `Permission denied: ${dir}` : (e.code || e.message), code: 'FS_LIST_FAILED' });
        }
        return;
      }
      case 'fsMkdir': {
        // The agent's only write outside a transcript root, and it is one mkdir of
        // one NAMED CHILD under an existing parent: a separator in the name is
        // rejected, so there is no path to traverse with, and mkdir is
        // non-recursive so a wrong parent errors instead of being conjured up.
        // It creates an EMPTY directory and nothing else — no file ever gets
        // written through this, and nothing existing can be touched (EEXIST).
        const parent = typeof m.parent === 'string' ? m.parent.trim() : '';
        const name = typeof m.name === 'string' ? m.name.trim() : '';
        if (!parent) return send({ t: 'fsMkdir', id: m.id, ok: false, error: 'Parent folder is required', code: 'BAD_CWD' });
        if (!name || name === '.' || name === '..' || name.length > 100 || /[\\/:*?"<>|\x00-\x1f]/.test(name)) {
          return send({ t: 'fsMkdir', id: m.id, ok: false, error: 'That name has characters a folder can’t contain.', code: 'BAD_NAME' });
        }
        const dir = path.join(parent, name);
        if (path.dirname(path.resolve(dir)) !== path.resolve(parent)) {
          return send({ t: 'fsMkdir', id: m.id, ok: false, error: 'That name has characters a folder can’t contain.', code: 'BAD_NAME' });
        }
        try {
          await fsp.mkdir(dir);
          send({ t: 'fsMkdir', id: m.id, ok: true, path: dir });
        } catch (e) {
          if (e.code === 'EEXIST') return send({ t: 'fsMkdir', id: m.id, ok: false, error: `“${name}” already exists here.`, code: 'EEXIST' });
          const denied = e.code === 'EACCES' || e.code === 'EPERM';
          send({
            t: 'fsMkdir', id: m.id, ok: false, code: 'MKDIR_FAILED',
            error: e.code === 'ENOENT' ? `Folder does not exist: ${parent}` : denied ? `Permission denied: ${parent}` : (e.code || e.message),
          });
        }
        return;
      }
      case 'git': {
        // Feature 04 (cloud path) — git diff / PR creation for a session, run where
        // the checkout actually lives. cwd is the session's PROJECT dir (like spawn's
        // cwd) so it is NOT confined to the transcript roots — projects live wherever
        // the user codes; the master resolves cwd from the session's own head. Still
        // narrow: the only ops are read-only diff and an explicit, browser-confirmed PR.
        try {
          const payload = m.payload && typeof m.payload === 'object' ? m.payload : {};
          const cwd = String(payload.cwd || '');
          if (m.op === 'diff') return send({ t: 'git', id: m.id, ok: true, data: await diffLib.collectDiff(cwd) });
          // Two git calls, no diff — cheap enough to ask on every chat open, which
          // is the point: the transcript's own gitBranch is the PARENT checkout's
          // inside a worktree (see readBranch).
          if (m.op === 'branch') return send({ t: 'git', id: m.id, ok: true, data: await diffLib.readBranch(cwd) });
          // Every checkout of this repo, so a new chat can be started in one. Read
          // only, and it names no path the master did not already send.
          if (m.op === 'worktrees') return send({ t: 'git', id: m.id, ok: true, data: await diffLib.listWorktrees(cwd) });
          if (m.op === 'pr') return send({ t: 'git', id: m.id, ok: true, data: await diffLib.createPr(cwd, { title: payload.title, body: payload.body }) });
          if (m.op === 'mcpServers') {
            if (!mcpConfigLib) return send({ t: 'git', id: m.id, ok: false, error: 'agent is out of date (mcp-config module missing) — update the agent', code: 'AGENT_OUTDATED' });
            return send({ t: 'git', id: m.id, ok: true, data: await mcpConfigLib.readMcpServers(cwd, payload.engine) });
          }
          return send({ t: 'git', id: m.id, ok: false, error: `unknown op: ${m.op}` });
        } catch (e) {
          return send({ t: 'git', id: m.id, ok: false, error: e.message, code: e.code || null });
        }
      }
      case 'accounts': {
        // Switch which Claude Code account THIS box uses — see lib/accounts.js's
        // header for the full design. Same op-ladder shape as 'git':
        // one frame type, several ops, each op's own try/catch surfaced as {ok:false}.
        if (!accountsLib) return send({ t: 'accounts', id: m.id, ok: false, error: 'agent is out of date (accounts module missing) — update the agent', code: 'AGENT_OUTDATED' });
        const payload = m.payload && typeof m.payload === 'object' ? m.payload : {};
        try {
          if (m.op === 'list') return send({ t: 'accounts', id: m.id, ok: true, data: await accountsLib.listAccounts() });
          if (m.op === 'save') return send({ t: 'accounts', id: m.id, ok: true, data: await accountsLib.saveCurrentAccount() });
          if (m.op === 'preflight') return send({ t: 'accounts', id: m.id, ok: true, data: await accountsLib.preflightSwitch(String(payload.orgId || '')) });
          if (m.op === 'switch') {
            try {
              return send({ t: 'accounts', id: m.id, ok: true, data: await accountsLib.switchAccount(String(payload.orgId || '')) });
            } catch (e) {
              // Carry the failed check list back so the cloud UI names the step that stopped it.
              return send({ t: 'accounts', id: m.id, ok: false, error: e.message, checks: e.checks || null });
            }
          }
          if (m.op === 'remove') return send({ t: 'accounts', id: m.id, ok: true, data: { removed: accountsLib.removeAccount(String(payload.orgId || '')) } });
          if (m.op === 'login') { accountsLib.startLogin({ email: payload.email || null }); return send({ t: 'accounts', id: m.id, ok: true, data: { started: true } }); }
          if (m.op === 'loginStatus') return send({ t: 'accounts', id: m.id, ok: true, data: accountsLib.loginStatus() });
          if (m.op === 'loginCode') { accountsLib.submitLoginCode(String(payload.code || '')); return send({ t: 'accounts', id: m.id, ok: true, data: { ok: true } }); }
          if (m.op === 'loginCancel') return send({ t: 'accounts', id: m.id, ok: true, data: { cancelled: accountsLib.cancelLogin() } });
          return send({ t: 'accounts', id: m.id, ok: false, error: `unknown op: ${m.op}` });
        } catch (e) {
          return send({ t: 'accounts', id: m.id, ok: false, error: e.message });
        }
      }
      case 'codexAccounts': {
        // Switch which ChatGPT account THIS box uses — see lib/codex-accounts.js.
        // Its own frame type rather than an engine flag on 'accounts': a stale
        // agent that predates this feature must answer AGENT_OUTDATED for codex
        // while still serving Claude switching normally, and overloading one
        // case would make it misreport one or the other.
        // Spend a ChatGPT rate-limit reset credit. An op on THIS frame rather
        // than a frame of its own: a new reply type an older agent has never
        // heard of goes unanswered and the master waits out the full timeout,
        // whereas an unknown op falls through to the `unknown op` reply below
        // and fails immediately. It rides here because the grant is account-
        // scoped, but it needs limits.js (which owns the app-server spawn), not
        // codexAccountsLib — so it is answered BEFORE that module's gate.
        if (m.op === 'resetCredit') {
          const p = m.payload && typeof m.payload === 'object' ? m.payload : {};
          try {
            const out = await require('./limits').consumeResetCredit({ idempotencyKey: p.idempotencyKey, creditId: p.creditId || null });
            return send({ t: 'codexAccounts', id: m.id, ok: true, data: out });
          } catch (e) {
            return send({ t: 'codexAccounts', id: m.id, ok: false, error: e.message });
          }
        }
        if (!codexAccountsLib) return send({ t: 'codexAccounts', id: m.id, ok: false, error: 'agent is out of date (codex accounts module missing) — update the agent', code: 'AGENT_OUTDATED' });
        const payload = m.payload && typeof m.payload === 'object' ? m.payload : {};
        // Only the master can count Codex turns on this box (see the hook note above).
        const busy = { busy: payload.busy || 0 };
        try {
          if (m.op === 'list') return send({ t: 'codexAccounts', id: m.id, ok: true, data: codexAccountsLib.listAccounts() });
          if (m.op === 'save') return send({ t: 'codexAccounts', id: m.id, ok: true, data: codexAccountsLib.saveCurrentAccount() });
          if (m.op === 'preflight') return send({ t: 'codexAccounts', id: m.id, ok: true, data: await codexAccountsLib.preflightSwitch(String(payload.orgId || ''), busy) });
          if (m.op === 'switch') {
            try {
              return send({ t: 'codexAccounts', id: m.id, ok: true, data: await codexAccountsLib.switchAccount(String(payload.orgId || ''), busy) });
            } catch (e) {
              // Carry the failed check list back so the cloud UI names the step that stopped it.
              return send({ t: 'codexAccounts', id: m.id, ok: false, error: e.message, checks: e.checks || null });
            }
          }
          if (m.op === 'remove') return send({ t: 'codexAccounts', id: m.id, ok: true, data: { removed: codexAccountsLib.removeAccount(String(payload.orgId || '')) } });
          if (m.op === 'login') { codexAccountsLib.startLogin(); return send({ t: 'codexAccounts', id: m.id, ok: true, data: { started: true } }); }
          if (m.op === 'loginStatus') return send({ t: 'codexAccounts', id: m.id, ok: true, data: codexAccountsLib.loginStatus() });
          if (m.op === 'loginCancel') return send({ t: 'codexAccounts', id: m.id, ok: true, data: { cancelled: codexAccountsLib.cancelLogin() } });
          return send({ t: 'codexAccounts', id: m.id, ok: false, error: `unknown op: ${m.op}` });
        } catch (e) {
          return send({ t: 'codexAccounts', id: m.id, ok: false, error: e.message });
        }
      }
      case 'spawn': {
        const exe = ENGINES[m.engine];
        if (!exe) return send({ t: 'exit', id: m.id, code: null, signal: null, error: `engine not permitted: ${m.engine}` });
        // cwd = the session's project dir (NOT confined to the transcript roots — projects live
        // anywhere the user codes). The engine is still allowlisted; permission prompts on the
        // browser gate any tool the turn tries to run.
        // A Windows .cmd/.bat shim (e.g. npm-global `codex.cmd`) can't be exec'd directly —
        // needs a shell, same as the self-update npm fix. Standalone .exe (preferred by
        // resolveEngine) spawns without it. ponytail: shell+spaced-path is fragile; a codex
        // under "Program Files" wants TERMDECK_CODEX_EXE instead.
        // detached (POSIX) makes the child a process-group leader so killTree() can signal the
        // whole group — the engine is often a grandchild of a shim/shell, and a bare kill would
        // orphan it (then its live-registry pid view-only-locks the session forever). Windows
        // uses taskkill /T instead, so no detached there.
        // HARD CONSTRAINT (non-negotiable, mirrors grok-runner.js's local ensureChild):
        // never let a grok child fall back to metered billing. The grok CLI owns OIDC
        // refresh from ~/.grok/auth.json itself; strip both metered-auth vars so a
        // customer's agent box having either set can't leak into a cloud grok turn.
        // The claude child holds the --permission-prompt-tool prompt open and aborts any
        // permission that outlives its stream-close timeout ("Tool permission request
        // failed: AbortError: Stream closed"), so it needs the long timeout lib/runner.js
        // already sets on the hub path. Default (~seconds) kills every interactive tool
        // because a human takes longer than that to approve.
        // CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING is how the option reaches the
        // CLI — the SDK sets exactly this env var for `enableFileCheckpointing`
        // (there is no CLI flag), and lib/runner.js gets it via the SDK option.
        // The cloud path spawns the CLI itself, so it has to set it directly or
        // /rewind stays dead for every cloud chat while working on the hub.
        const env = m.engine === 'grok' ? { ...process.env }
          : m.engine === 'claude'
            ? { ...process.env, CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '300000', CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true' }
          : process.env;
        if (m.engine === 'grok') {
          delete env.XAI_API_KEY;
          delete env.GROK_DEPLOYMENT_KEY;
        }
        const opts = { env, shell: /\.(cmd|bat)$/i.test(exe), detached: process.platform !== 'win32' };
        if (m.cwd && typeof m.cwd === 'string') {
          // Validate the working folder up front so a bad path fails fast with a clear
          // message, instead of the CLI spawning, failing to chdir, and exiting opaquely.
          // Not a new capability: we only stat the exact cwd we're about to spawn in.
          let isDir = false;
          try { isDir = fs.statSync(m.cwd).isDirectory(); } catch {}
          if (!isDir) return send({ t: 'exit', id: m.id, code: null, signal: null, error: `This folder no longer exists on disk: ${m.cwd} (it may have been deleted or the worktree removed)` });
          opts.cwd = m.cwd;
        }
        let child;
        try { child = spawn(exe, Array.isArray(m.args) ? m.args : [], opts); }
        catch (e) { return send({ t: 'exit', id: m.id, code: null, signal: null, error: e.message }); }
        procs.set(m.id, child);
        // The codex app-server and the grok `agent stdio` child are each spawned ONCE and
        // reused across turns (see remote-codex-runner.js / remote-grok-runner.js). Counting
        // either as "busy" outright would block self-update forever once that engine is loaded,
        // so they are tracked as persistent and busy() reads the master's turn count for them
        // instead (case 'turns' below). Per-turn claude CLIs always count.
        if (m.engine === 'codex' && Array.isArray(m.args) && m.args[0] === 'app-server') persistentProcs.add(m.id);
        if (m.engine === 'grok' && Array.isArray(m.args) && m.args[0] === 'agent' && m.args[1] === 'stdio') persistentProcs.add(m.id);
        // Everything stdio routes through the park registry (LIVE-DEPLOY Phase 2):
        // while this connection lives it forwards straight to `send` and maintains
        // the line-boundary tail; after park() it buffers instead. The handlers
        // capture the ENTRY, not the id — a parked child outlives this connection's
        // maps. m.meta is opaque master context, echoed back in the hello inventory.
        const entry = parkRegistry.track({ procId: m.id, child, engine: m.engine, meta: m.meta, persistent: persistentProcs.has(m.id), sink: send });
        // Tell the master which pid this child got. It is the only proof of
        // ownership that exists: the Claude CLI writes a live-registry entry for
        // the session, and the master's composer lock and orphan reaper both
        // decide "ours or a second writer" by comparing pids. The master used to
        // LEARN the pid by catching a registry poll mid-turn, which misses a
        // short turn entirely and leaves the leftover CLI locking its own chat.
        // Sent before any stdout, so ownership is known from the first frame.
        send({ t: 'pid', id: m.id, pid: child.pid ?? null });
        child.stdout.on('data', (d) => parkRegistry.onData(entry, 'stdout', d));
        child.stderr.on('data', (d) => parkRegistry.onData(entry, 'stderr', d));
        child.on('exit', (code, signal) => { procs.delete(m.id); persistentProcs.delete(m.id); parkRegistry.onExit(entry, { code, signal }); });
        child.on('error', (e) => { procs.delete(m.id); persistentProcs.delete(m.id); parkRegistry.onExit(entry, { code: null, signal: null, error: e.message }); });
        return;
      }
      // Re-attach a parked survivor (LIVE-DEPLOY Phase 3): the master names the
      // inventory key its ledger vouches for and the new procId to stream under.
      // Replay + live stream ride the normal stdout/stderr/exit frames, so the
      // master-side runner needs no special read path. An unknown key answers
      // with an exit frame — the master treats it like a child that died.
      case 'attach': {
        const entry = parkRegistry.attach(String(m.parkId || ''), m.id, send);
        if (!entry) return send({ t: 'exit', id: m.id, code: null, signal: null, error: 'not parked' });
        if (!entry.exited) {
          procs.set(m.id, entry.child);
          if (entry.persistent) persistentProcs.add(m.id);
          entry.child.once('exit', () => { procs.delete(m.id); persistentProcs.delete(m.id); });
          // Re-state the pid under the NEW procId, same as a spawn: the master
          // that picks this survivor up may never have seen it started.
          send({ t: 'pid', id: m.id, pid: entry.child.pid ?? null });
        }
        return;
      }
      // The master saw the inventory and disowned this child — reap immediately
      // rather than letting it burn its TTL against a session lock.
      case 'reap': {
        parkRegistry.reapNow(String(m.parkId || ''));
        return;
      }
      case 'stdin': { const c = procs.get(m.id); if (c && c.stdin.writable) c.stdin.write(Buffer.from(m.data || '', 'base64')); return; }
      case 'kill': { const c = procs.get(m.id); if (c) killTree(c, m.signal || 'SIGTERM'); return; }
      case 'killPid': {
        // Direct signal to an arbitrary system pid (not one we spawned) — used by "take
        // over" to end an idle terminal `claude` holding the same session. The master
        // already verified this pid via the live registry + pidAliveMany before asking.
        if (typeof m.pid !== 'number') return send({ t: 'killPid', id: m.id, ok: false, error: 'bad pid' });
        try { process.kill(m.pid, m.signal || 'SIGTERM'); }
        catch (e) { if (e.code !== 'ESRCH') return send({ t: 'killPid', id: m.id, ok: false, error: e.message }); }
        send({ t: 'killPid', id: m.id, ok: true });
        return;
      }
      case 'parkShellHost': {
        // The turn is over but this CLI still owns live background shells in its
        // process group, so the master is declining to reap it. Move it to the
        // parked map with role 'shell-host' — no TTL, not busy, named in the
        // inventory (agent/park.js). The reply's parkId is how every later op
        // (bgShells, reap) refers to it.
        const parkId = parkRegistry.parkAsShellHost(m.id, m.meta);
        if (!parkId) return send({ t: 'parkShellHost', id: m.id, ok: false, error: 'no live child for that id', code: 'NO_CHILD' });
        procs.delete(m.id);
        send({ t: 'parkShellHost', id: m.id, ok: true, parkId });
        return;
      }
      case 'turns': {
        // How many turns the master is running inside a persistent child (the
        // codex app-server, the grok stdio child). It is the ONLY way this
        // process can know: that child is spawned once and reused, so it is
        // alive whether or not anything is happening in it. Without the count a
        // Codex turn was invisible to busy() and self-update killed it mid-turn.
        parkRegistry.setTurnCount(m.id, Number(m.n) || 0);
        return;
      }
      case 'bgShells': {
        // Which processes a shell host still owns, and what each writes to. The
        // master matches logPath against the output file the CLI named in its
        // tool_result — an exact key, where the command string is a guess.
        if (!procTreeLib) return send({ t: 'bgShells', id: m.id, ok: false, error: 'agent needs updating', code: 'AGENT_OUTDATED' });
        const pid = parkRegistry.parkedPid(String(m.parkId || ''));
        // Gone (exited on its own, or reaped) — an empty list, not an error: the
        // master's reconcile treats it as "every shell here is finished".
        if (pid == null) return send({ t: 'bgShells', id: m.id, ok: true, pid: null, procs: [] });
        try { send({ t: 'bgShells', id: m.id, ok: true, pid, procs: await procTreeLib.list(pid) }); }
        catch (e) { send({ t: 'bgShells', id: m.id, ok: false, error: e.message }); }
        return;
      }
      case 'bgShellLog': {
        // Tail one background shell's output file. NOT part of readFile: that one
        // is confined to the transcript roots and must stay that way. This is its
        // own confinement (bgLogPathOk) over a different tree, and it is a read of
        // a file the CLI itself created for exactly this purpose.
        if (!bgLogPathOk(m.path)) return send({ t: 'bgShellLog', id: m.id, ok: false, error: 'not a background shell log', code: 'DENIED' });
        try {
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
            send({ t: 'bgShellLog', id: m.id, ok: true, data: buf.toString('base64'), offset: from, next: from + len, size: st.size, truncated, mtimeMs: st.mtimeMs });
          } finally { await fh.close(); }
        } catch (e) { send({ t: 'bgShellLog', id: m.id, ok: false, error: e.code || e.message }); }
        return;
      }
    }
  }

  // The connection died — PARK, don't kill (LIVE-DEPLOY Phase 2). Children keep
  // running with their output buffered from a line boundary; the registry's TTL
  // reaps any nobody re-attaches. Watchers still close — the master re-issues
  // them on reconnect (ensureWatches), and a watcher has no state worth keeping.
  function park() {
    for (const w of watchers.values()) try { w.close(); } catch {}
    parkRegistry.parkAll();
    watchers.clear(); procs.clear(); persistentProcs.clear();
  }

  // Real shutdown (the self-update exit path): nothing survives this process,
  // so nothing may outlive it — an orphaned engine's live-registry pid
  // view-only-locks its session until it happens to die.
  function destroy() {
    for (const w of watchers.values()) try { w.close(); } catch {}
    parkRegistry.destroyAll();
    watchers.clear(); procs.clear(); persistentProcs.clear();
  }

  // "busy" = a per-turn engine is running OR parked awaiting re-attach (a live
  // session that self-update must not cut off — parked turns count because an
  // agent restart would orphan a child the master may be seconds from
  // re-adopting; the park TTL bounds the extra wait). Persistent codex/grok
  // children are infrastructure, not turns — excluded, or self-update would be
  // permanently refused on any machine that has used those engines.
  // ponytail: when remote codex WRITE turns land, gate update on the master's real run state too.
  return { handle, park, destroy, busy: () => parkRegistry.turnBusy() > 0, parkedInventory: () => parkRegistry.inventory() };
}

// bgLogPathOk is exported for the same reason `confined` is: it is a security
// boundary, and a boundary that can only be exercised through a live WebSocket
// is a boundary nobody tests. See tests/bg-shell-confinement.mjs.
module.exports = { makeCapabilities, confined, bgLogPathOk, ROOTS, ENGINES };
