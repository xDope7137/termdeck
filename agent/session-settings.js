'use strict';

// Per-chat Termdeck preferences that live on the MACHINE, because nothing else
// remembers them.
//
// Two settings, and they are here for the same reason. The thinking dial
// (docs/SDK-SIGNALS.md §I) is a sticky preference the runner re-applies at every
// turn's init, held in the master's memory and nowhere else — so a master
// restart drops it to "Default" while the reader believes they turned thinking
// off, and a second device never knew about it at all. Run options (V3 §D:
// --add-dir, --allowedTools, --fallback-model, --autocompact) have exactly the
// same shape of problem: they are CLI flags chosen per chat, nothing on disk
// records them, and a flag that silently stops applying is worse than one that
// was never offered. The browser keeps per-chat copies in localStorage as
// hints, which covers one browser and no others.
//
// WHY A SIDECAR AND NOT A TRANSCRIPT RECORD. Renames take the other route —
// lib/session-title.js APPENDS a `custom-title` line to the chat's own jsonl —
// and that is safe precisely because `custom-title` is the CLI's OWN record
// type, one it already writes and reads. A thinking dial has no such record.
// Inventing a type and writing it into Claude Code's transcript would put bytes
// the CLI never wrote into the file it owns and resumes from, to save a sidecar.
// Not worth it for a preference. This file is Termdeck's, in a Termdeck-named
// file, and no reader of the transcript can trip over it.
//
// It still lives INSIDE a transcript root (the same reasoning as the agent's
// `.termdeck-trash` dir): a master that got compromised still cannot make the
// agent write outside `~/.claude`.
//
// The master never names the path — it names a session id and a typed value, and
// the agent resolves the file against its OWN roots. Same posture as `restore`
// and the title/tag ops.
//
// Shipped to agents by name (AGENT_FILES in master.js), so this module may only
// require SIBLINGS in lib/ — an installed agent has a flat directory.

const fsp = require('fs/promises');
const path = require('path');

const FILE = '.termdeck-session-settings.json';
const SCHEMA = 1;
// One small object per chat. Bounded because this file is read whole on every
// load: a fleet with thousands of chats must not turn a preference lookup into a
// megabyte parse. Oldest-written entries fall off first.
const MAX_SESSIONS = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isSessionId = (id) => typeof id === 'string' && UUID_RE.test(id);

const settingsPath = (root) => path.join(root, FILE);

// Every option that becomes a CLI FLAG is validated here and nowhere else,
// because the master hands these to a process on the customer's own machine.
// The rule is the same one the rest of the confined ops follow: the browser
// names a value, never a shape — anything that is not exactly what the flag
// takes is dropped rather than corrected, and a value that survives is one the
// CLI can be handed without further thought.
const MAX_DIRS = 16;
const MAX_TOOLS = 64;
const MAX_STR = 512;
// `auto`, or a token budget the flag documents as 100k–1M. A number outside
// that range is not clamped into it — it is dropped, because a clamp silently
// gives you a setting you did not ask for.
const AUTOCOMPACT_MIN = 100_000;
const AUTOCOMPACT_MAX = 1_000_000;

// A tool spec is `Edit` or `Bash(git *)`. No shell metacharacters, no newlines,
// nothing that could be read as a second argument.
const TOOL_RE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\([^()\n]{0,200}\))?$/;
// A model id, not a path and not a flag. The optional `[1m]` tail is Claude
// Code's own spelling for "run this model on its larger context window"
// (`claude-opus-5[1m]`), and without it here a 1M fallback model was accepted by
// the browser and then silently dropped on the way to argv — the flag would come
// back as whatever the bare spelling resolves to, at a fifth of the window the
// reader asked for. Anchored and fixed-length: the brackets are the only ones
// allowed, at the end, and nothing else about the character class changes.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}(?:\[1m\])?$/;

const strList = (v, max, test) => {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const raw of v) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    // A value that starts with `-` would be read by the CLI as another flag.
    if (!s || s.length > MAX_STR || s.startsWith('-')) continue;
    if (test && !test(s)) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
};

// Returns the canonical object, or null for "no options at all" — which is
// stored as a REMOVAL, so clearing them does not leave a row asserting defaults.
function normalizeRunOptions(opts) {
  if (!opts || typeof opts !== 'object') return null;
  const addDirs = strList(opts.addDirs, MAX_DIRS);
  const allowedTools = strList(opts.allowedTools, MAX_TOOLS, (s) => TOOL_RE.test(s));
  const disallowedTools = strList(opts.disallowedTools, MAX_TOOLS, (s) => TOOL_RE.test(s));
  const fm = typeof opts.fallbackModel === 'string' ? opts.fallbackModel.trim() : '';
  const fallbackModel = fm && MODEL_RE.test(fm) ? fm : null;
  let autoCompact = null;
  if (opts.autoCompact === 'auto') autoCompact = 'auto';
  else {
    const n = Number(opts.autoCompact);
    if (Number.isFinite(n) && n >= AUTOCOMPACT_MIN && n <= AUTOCOMPACT_MAX) autoCompact = Math.floor(n);
  }
  if (!addDirs.length && !allowedTools.length && !disallowedTools.length && !fallbackModel && autoCompact == null) return null;
  return { addDirs, allowedTools, disallowedTools, fallbackModel, autoCompact };
}

// The CLI flags a normalized run-options object becomes. ONE translation, shared
// by whichever transport spawns the child, so the flags cannot drift from the
// validation above them.
function runOptionFlags(opts) {
  const v = normalizeRunOptions(opts);
  if (!v) return [];
  const args = [];
  for (const dir of v.addDirs) args.push('--add-dir', dir);
  if (v.allowedTools.length) args.push('--allowedTools', ...v.allowedTools);
  if (v.disallowedTools.length) args.push('--disallowedTools', ...v.disallowedTools);
  if (v.fallbackModel) args.push('--fallback-model', v.fallbackModel);
  if (v.autoCompact != null) args.push('--autocompact', String(v.autoCompact));
  return args;
}

// The one value shape, validated identically wherever it is set. `null` for both
// fields means "no preference" and is stored as a REMOVAL rather than an entry,
// so clearing the dial does not leave a row asserting defaults.
function normalizeThinking(thinking) {
  if (!thinking || typeof thinking !== 'object') return null;
  const display = thinking.display === 'summarized' || thinking.display === 'omitted' ? thinking.display : null;
  const n = Number(thinking.maxTokens);
  const maxTokens = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  if (display == null && maxTokens == null) return null;
  return { display, maxTokens };
}

// The mode a plan was approved into, per ExitPlanMode call (features/02 3.6b).
// Not a preference but the same kind of fact: the CLI writes the same "User has
// approved your plan" whichever mode was picked, and the mode switch that
// follows is a control message it never records (a bypass is not even the
// CLI's own mode: the runner keeps the child off it and emulates it), so after
// a reload nothing on disk says which. Keyed by the call's tool_use id, which is
// how the transcript names the row. Bounded per chat, newest kept.
const PLAN_MODES = new Set(['default', 'acceptEdits', 'auto', 'bypassPermissions']);
const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_PLAN_MODES = 32;

function normalizePlanModes(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const kept = Object.entries(map).filter(([id, mode]) => TOOL_USE_ID_RE.test(id) && PLAN_MODES.has(mode));
  if (!kept.length) return null;
  return Object.fromEntries(kept.slice(-MAX_PLAN_MODES));
}

// Read the sidecar. Every failure is a MISS, not an error: the preference is a
// nicety and the chat has to open without it. A file we cannot parse is left
// alone rather than deleted — it is the user's machine, and a truncated write we
// did not cause is not ours to throw away.
async function readSettings(root) {
  let raw;
  try {
    raw = await fsp.readFile(settingsPath(root), 'utf8');
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || parsed.v !== SCHEMA || !parsed.sessions || typeof parsed.sessions !== 'object') return {};
  const out = {};
  for (const [id, entry] of Object.entries(parsed.sessions)) {
    if (!isSessionId(id) || !entry || typeof entry !== 'object') continue;
    const thinking = normalizeThinking(entry.thinking);
    const runOptions = normalizeRunOptions(entry.runOptions);
    const planModes = normalizePlanModes(entry.planModes);
    // A row with none is not a row: it is what a cleared setting leaves
    // behind, and keeping it would make "no preference" and "default" two
    // different states with the same meaning.
    if (thinking || runOptions || planModes) out[id] = { thinking, runOptions, ...(planModes ? { planModes } : {}), at: Number(entry.at) || 0 };
  }
  return out;
}

// Merge one session's value in and write the whole file back.
//
// tmp + rename, so a reader never sees a half-written file and a crash mid-write
// leaves the previous one intact — the same idiom the master uses for its VAPID
// keys, and for the same reason: losing this file silently is worse than not
// having written it.
//
// Writes to one file run ONE AT A TIME. Each is a read-modify-write of the
// whole file, and two in flight together (a thinking change landing while a
// run-options one is still writing) raced twice over: the later one's read
// missed the earlier one's change, and both shared one tmp name, so a short
// body written over a longer one kept the longer one's tail and the rename
// published it. The file then failed to parse and every chat's settings read
// as empty. A queue per file fixes the lost update; a tmp name per write fixes
// the torn file even across two processes.
const writeQueues = new Map(); // settings file -> tail of its write chain
let tmpSeq = 0;

function writeSetting(root, sessionId, key, raw, opts) {
  if (!isSessionId(sessionId)) return Promise.reject(Object.assign(new Error('Invalid session id'), { code: 'BAD_SESSION_ID' }));
  if (key !== 'thinking' && key !== 'runOptions' && key !== 'planMode') return Promise.reject(Object.assign(new Error('Unknown setting'), { code: 'BAD_SETTING' }));
  if (key === 'planMode' && !(raw && TOOL_USE_ID_RE.test(raw.toolUseId) && PLAN_MODES.has(raw.mode))) {
    return Promise.reject(Object.assign(new Error('Invalid plan mode'), { code: 'BAD_SETTING' }));
  }
  const file = settingsPath(root);
  const prior = writeQueues.get(file) || Promise.resolve();
  const mine = prior.catch(() => {}).then(() => writeSettingNow(root, sessionId, key, raw, opts));
  const tail = mine.catch(() => {});
  writeQueues.set(file, tail);
  tail.then(() => { if (writeQueues.get(file) === tail) writeQueues.delete(file); });
  return mine;
}

async function writeSettingNow(root, sessionId, key, raw, { now = Date.now() } = {}) {
  const sessions = await readSettings(root);
  const prev = sessions[sessionId] || { thinking: null, runOptions: null };
  let value;
  let next;
  if (key === 'planMode') {
    // One call's answer merged into the chat's map, never a whole map from the
    // caller: two approvals in flight cannot drop each other's entry. A
    // re-written id moves to the end, so the cap drops the oldest.
    const map = { ...(prev.planModes || {}) };
    delete map[raw.toolUseId];
    map[raw.toolUseId] = raw.mode;
    value = { toolUseId: raw.toolUseId, mode: raw.mode };
    next = { ...prev, planModes: normalizePlanModes(map), at: now };
  } else {
    value = key === 'thinking' ? normalizeThinking(raw) : normalizeRunOptions(raw);
    next = { ...prev, [key]: value, at: now };
  }
  if (!next.planModes) delete next.planModes;
  // Clearing the LAST setting removes the row; clearing one of two keeps the
  // other. Merging rather than replacing is what stops a thinking write from
  // silently discarding this chat's run options.
  if (next.thinking || next.runOptions || next.planModes) sessions[sessionId] = next;
  else delete sessions[sessionId];

  const entries = Object.entries(sessions).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_SESSIONS);
  const body = JSON.stringify({ v: SCHEMA, sessions: Object.fromEntries(entries) });
  const file = settingsPath(root);
  tmpSeq += 1;
  const tmp = `${file}.${process.pid}.${tmpSeq}.tmp`;
  try {
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* the tmp file is not worth a second failure */ }
    throw err;
  }
  return value;
}

// The original single-purpose entry point, kept because both AGENT_FILES
// manifests and the agent's own op speak it.
const writeThinking = (root, sessionId, thinking, opts) => writeSetting(root, sessionId, 'thinking', thinking, opts);
const writeRunOptions = (root, sessionId, runOptions, opts) => writeSetting(root, sessionId, 'runOptions', runOptions, opts);
const writePlanMode = (root, sessionId, toolUseId, mode, opts) => writeSetting(root, sessionId, 'planMode', { toolUseId, mode }, opts);

module.exports = {
  readSettings, writeSetting, writeThinking, writeRunOptions, writePlanMode,
  normalizeThinking, normalizeRunOptions, normalizePlanModes, runOptionFlags,
  isSessionId, settingsPath, FILE, SCHEMA, MAX_SESSIONS,
  AUTOCOMPACT_MIN, AUTOCOMPACT_MAX, MAX_DIRS, MAX_TOOLS, MAX_PLAN_MODES,
};
