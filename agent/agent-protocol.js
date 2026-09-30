'use strict';

// The master/agent wire protocol, written down once.
//
// Until this file existed the protocol was three hand-maintained lists that had to
// agree and nothing checked that they did: the request types lib/cloud/transport.js
// sends, the case labels agent/capabilities.js answers, and the reply types
// transport.js's onFrame accepts back. Neither switch has a default arm, so a frame
// missing from any of the three is DROPPED IN SILENCE. On the agent that means the
// request does nothing; on the master it means the answer is binned and the caller's
// promise hangs until _request gives up 20 seconds later with AGENT_TIMEOUT, with
// nothing in any log on either box.
//
// The mapping is not regular either, which is why it could not be held in anyone's
// head: readFile answers fileChunk, readTail answers tailChunk, watch answers a
// stream of fsEvent, engineEvents a stream of engineEvent. You used to learn those
// pairs by reading both files side by side.
//
// This module is the description. It is PURE: no fs, no env, no requires, no work at
// load. That is a hard requirement, not a preference. tests/agent-protocol.mjs
// imports it directly and checks it against both switch statements, and a module
// that did anything at load would make that fast static test into a slow one (see
// tests/agent-update-bounds.mjs's own header for what the alternative costs).
//
// It SHIPS to agent boxes as agent-protocol.js (AGENT_FILES in master.js and
// agent/agent.js), and the master reads it from the repo as
// require('../../agent/agent-protocol'). Placement follows ownership: the agent owns
// its contract, the master reads it. That is the same direction the `caps`
// advertisement points.
//
// Adding a capability: add a row here, add the case in capabilities.js, add the
// method in transport.js. The test names whichever of the three you forgot.

// ---------------------------------------------------------------------------
// The OTHER namespace, and why it has to stay unpoliced
// ---------------------------------------------------------------------------
// Two key names cross this socket. `t` is a capability frame and everything below
// governs it. `type` is the connection's own housekeeping and this module governs
// none of it.
//
// The split is load-bearing in a way that is easy to break. relay.js sends
// { type: 'welcome' } to EVERY agent version, including ones that shipped years
// before the frame existed, and it is safe precisely BECAUSE capabilities.js's
// switch has no default: agent.js hands anything that is not t:'update' or
// type:'welcome' to caps.handle(m), where a type-only frame has no m.t and matches
// no case, so it falls out doing nothing. The same is true of the agent's own
// heartbeat in the other direction. That silence is the forward-compatibility
// channel: it is how either side can start sending a new housekeeping frame without
// waiting for the fleet.
//
// So capabilities.handle()'s refusal arm fires ONLY when m.t is a present, unknown
// string. An arm that also caught type-frames would answer AGENT_OUTDATED to every
// welcome on every machine and close the one channel that never needed a version
// gate. tests/agent-capability-dispatch.mjs pins that silence.
const TYPE_FRAMES = {
  // master -> agent
  toAgent: ['welcome'],
  // agent -> master
  toMaster: ['hello', 'heartbeat'],
};

// One frame breaks the split above, and it is worth naming rather than tidying.
// relay.js's tunnel keepalive rides `t`, not `type`, and no capability answers it:
// Cloudflare fronts remote agents and does not count ping/pong CONTROL frames as
// activity, so the master has to put a real DATA frame on the wire every 30s or CF
// severs a working socket at ~100s. relay.js says "agent ignores unknown `t`" above
// it, and what actually makes that true is that it carries NO `id`.
//
// So the agent's refusal arm is conditioned on an id, not merely on an unknown `t`.
// Relax that and every machine answers 2,880 refusals a day to a frame nobody is
// waiting on. tests/agent-capability-dispatch.mjs pins the silence.
const UNANSWERED_FRAMES = ['keepalive'];

// ---------------------------------------------------------------------------
// Self-update: two boxes, two clocks, one contract
// ---------------------------------------------------------------------------
// The agent bounds each phase of its own update and answers with a real message;
// the master's RPC timeout only has to OUTLAST the sum of those bounds, which makes
// it a backstop for a genuinely stuck agent rather than the thing that decides an
// update failed. Both halves live here because they are one contract: they were
// wrong about each other once (a Windows box spent 8m35s downloading while the
// master gave up at 90s and wrote "update timeout" over a machine that was still
// working, costing it a push try toward relay.js's HEAL_AFTER_TRIES), and a rule
// spread across two files is a rule nobody can see themselves breaking.
// tests/agent-update-bounds.mjs pins the arithmetic.
const UPDATE_BOUNDS = {
  fetchTimeoutMs: 15_000,   // one attempt at one file
  fetchAttempts: 3,         // a dropped tunnel is worth re-asking; a 404 is not
  fetchConcurrency: 6,      // 24 files strictly one after another was 83s on a healthy box
  downloadBudgetMs: 45_000, // manifest + every file + every retry
  npmTimeoutMs: 120_000,    // only when the dependency set moved
};

// transport.js's _request default, and the timeout of 24 of the 33 answering frames.
const DEFAULT_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------
// One row per frame the master can send. Fields, with the defaults define() fills
// in so a row spells only what is unusual about it:
//
//   name         the `t` the master sends. Also the case label in capabilities.js.
//   family       'request' (default) one ask, exactly one reply frame carrying `ok`
//                'stream'  many frames under the request's own id, no terminal ok
//                'none'    fire and forget, nothing comes back at all
//   reply        the type of the answering frame. Defaults to the row's own name,
//                which is true of 30 of the 33; null for family 'none'.
//   correlate    'minted'   (default) transport.js mints `id` and it becomes the key
//                'existing' `id` names a key an earlier frame minted (a watchId, a
//                           stream id), so this frame addresses something already alive
//                'none'     the frame carries no `id` at all
//   timeoutMs    how long the master waits before AGENT_TIMEOUT. null for families
//                that never build a pending entry.
//   opTimeoutMs  per-op override of the above, where a frame's ops differ enough in
//                cost that one number would be wrong for most of them.
//   agentBoundMs what the AGENT promises to finish or fail inside. Only `update` has
//                one; the test asserts timeoutMs strictly outlasts it.
//   ops          the legal `op` values for an op-carrying frame. A frame with ops
//                declared may refuse anything else by name instead of guessing.
//   defaultOp    what a frame that names NO op means. Three of the seven op ladders
//                end in a fall-through rather than a refusal (sessionSettings reads,
//                projectDoc reads, projectFiles lists), and that fall-through is the
//                read every one of their callers takes. Declaring it keeps an op-less
//                frame working while a NAMED op this build lacks is still refused.
//   codes        the NAMED error codes this frame can answer, over and above the
//                errno strings (ENOENT, EACCES, ...) that flow through from a catch.
//                AGENT_OUTDATED is answerable by ANY frame: capabilities.handle()
//                refuses an unknown frame, and an undeclared op, with it. This list
//                is only what a case answers itself, from a module-missing guard.
//   handler      'capabilities' (default) a case in agent/capabilities.js
//                'agent'        handled in agent/agent.js before caps.handle sees it
//   bytes        reply fields that carry BULK BYTES rather than JSON values. Three
//                rows have them and they are the whole read path. A handler returns
//                real Buffers in these fields; whether they cross the wire as base64
//                inside the JSON envelope or as one binary frame is decided per
//                request, by the codec at the bottom of this file. Nothing between
//                the handler and the caller sees the difference.
//   note         one line, for a reader of the table who has neither file open.
const TABLE = [
  // -- reads, confined to the transcript roots ------------------------------
  { name: 'stat', note: 'size + mtime of one confined file' },
  { name: 'list', note: 'one directory of the transcript roots' },
  { name: 'listTree', note: 'every transcript file under one root' },
  { name: 'indexScan', note: "the index's filtered walk, run agent-side" },
  { name: 'indexHeads', timeoutMs: 120_000, note: 'head/tail parse for a whole batch of files, one round trip' },
  { name: 'indexSync', timeoutMs: 120_000, codes: ['AGENT_OUTDATED'], note: "the machine's own session index, whole or as a delta since a generation" },
  { name: 'readFile', reply: 'fileChunk', bytes: ['data'], note: 'byte-range read; the master chunks at 8 MiB so one reply is one ws frame' },
  // Since features/04 phase 4 the request may carry `fillTo { preview, cap,
  // engine }` (widen the window locally until `preview` messages parse from it),
  // `totals` (one memoised whole-file META pass: cumulativeUsage, prLink, cwd,
  // usageId) and `turnHint` (the codex/grok turn in effect at the cut), and the
  // reply then carries `cutOffset`, `totals` and `lastTurnId`. An older agent
  // ignores the request fields and answers without the reply fields, which is
  // how the master tells the two apart: shape, never a version.
  { name: 'readTail', reply: 'tailChunk', bytes: ['data', 'head'], timeoutMs: 10_000, codes: ['AGENT_OUTDATED'], note: "a transcript's tail cut at a line boundary; short, it is on the paint path" },
  // The byte where jsonl line `line` starts, so a browser whose cursor token was
  // lost can still resume from its line count with one offset read instead of
  // the whole file (features/04 phase 4). `{ reset: true }` when the file has
  // fewer lines than asked for.
  { name: 'lineOffset', timeoutMs: 10_000, codes: ['AGENT_OUTDATED'], note: 'byte offset of a jsonl line, counted on the machine; { reset } when the file is shorter' },
  // One page of scroll-back, read where the file lives (features/04 phase 5):
  // the whole lines ending at `endOffset`, widened locally over the same
  // ladder readTail climbs until `fillTo.preview` messages parse from them.
  // Answers `cutOffset` (the byte the page starts at), `startLine`, `whole`
  // (nothing above it), and `lastTurnId` when `turnHint` asked for the
  // codex/grok turn in effect at the cut. The master's fallback on an older
  // agent is the whole file sliced at the same byte.
  { name: 'readBefore', bytes: ['data'], timeoutMs: 10_000, codes: ['AGENT_OUTDATED'], note: 'one page of scroll-back: the whole lines ending at a byte, cut at a line boundary and widened locally' },
  // The background shells a transcript records, scanned where the file lives:
  // a few hundred bytes cross the tunnel where the whole file used to.
  { name: 'bgShellScan', timeoutMs: 30_000, codes: ['AGENT_OUTDATED'], note: "scanBackgroundShells over one transcript, run agent-side; also { runs }, how each background Agent run ended" },

  // -- watching -------------------------------------------------------------
  // Batch entries are [path, size, mtimeMs] since features/04 phase 4; an
  // agent older than that sends [path, size] pairs and the master accepts both.
  { name: 'watch', family: 'stream', reply: 'fsEvent', note: 'chokidar on a confined path; coalesced [path, size, mtimeMs] batches' },
  { name: 'unwatch', family: 'none', correlate: 'existing', note: "cancels a watch by the id 'watch' minted" },

  // -- the write paths ------------------------------------------------------
  {
    name: 'mutate',
    ops: ['trash', 'duplicate', 'title', 'ai-title', 'tag'],
    codes: ['AGENT_OUTDATED'],
    note: 'the only writes inside the transcript roots: trash, duplicate, title/tag records',
  },
  { name: 'restore', timeoutMs: 60_000, codes: ['AGENT_OUTDATED'], note: '/rewind: the one write that lands outside the roots; 60 files means 120 disk ops' },
  // An attachment on its way to a CLI, written where the CLI can read it and
  // nowhere else: ~/.termdeck/uploads/<bucket>/<name>, one level deep, one file
  // per frame. The bytes ride base64 in the JSON envelope rather than as a
  // binary frame because this is the ONE bulk payload travelling master -> agent
  // and agent.js parses JSON on receive; a 10 MB file is ~13.4 MB of frame
  // against relay's 32 MB cap, which is why lib/upload-types.js caps it there.
  // 45s: a 13 MB frame over a domestic uplink is seconds, and a machine on a
  // hotel connection should fail as a sentence rather than as a timeout.
  {
    name: 'upload',
    timeoutMs: 45_000,
    codes: ['AGENT_OUTDATED', 'BAD_NAME', 'BAD_BUCKET', 'TOO_BIG', 'UNSUPPORTED_TYPE', 'WRITE_FAILED'],
    note: 'stage one attachment under ~/.termdeck/uploads for a CLI to read; never inside a project',
  },
  {
    name: 'sessionSettings',
    ops: ['get', 'set', 'setRunOptions'],
    defaultOp: 'get',
    codes: ['AGENT_OUTDATED'],
    note: "per-chat preferences on the machine (the thinking dial, run options)",
  },

  // -- a chat's project folder ----------------------------------------------
  {
    name: 'projectDoc',
    ops: ['read', 'write', 'append'],
    defaultOp: 'read',
    codes: ['AGENT_OUTDATED', 'NO_CWD', 'DENIED', 'DOC_FAILED'],
    note: "the project's instruction file; root resolved from the transcript's own head",
  },
  { name: 'commandCatalog', codes: ['AGENT_OUTDATED', 'DENIED', 'CATALOG_FAILED'], note: 'the slash commands this chat can type, with descriptions' },
  {
    name: 'projectFiles',
    ops: ['list', 'read'],
    defaultOp: 'list',
    codes: ['AGENT_OUTDATED', 'NO_CWD', 'HIDDEN_BLOCKED', 'DENIED', 'FILES_FAILED'],
    note: "read-only browsing of a chat's project folder, by relative path only",
  },
  {
    name: 'git',
    timeoutMs: 60_000,
    ops: ['diff', 'branch', 'worktrees', 'pr', 'mcpServers'],
    opTimeoutMs: { diff: 30_000, branch: 20_000, worktrees: 20_000, pr: 60_000, mcpServers: 20_000 },
    codes: ['AGENT_OUTDATED'],
    note: 'diff / branch / worktrees / PR, run where the checkout actually lives',
  },

  // -- the machine itself ---------------------------------------------------
  { name: 'machineConfig', codes: ['AGENT_OUTDATED', 'CONFIG_FAILED'], note: "the engine's own configuration, read off that box" },
  { name: 'usageBehaviour', timeoutMs: 60_000, codes: ['AGENT_OUTDATED', 'USAGE_FAILED'], note: 'WHY the limit is being spent; walks a week of transcripts' },
  { name: 'usage', timeoutMs: 30_000, note: 'tokens and cost for #/usage; a cold scan of a big ~/.claude runs long' },
  // 10s, not the 20s default it used to inherit by declaring nothing. This is a
  // local read of one credential file plus a little arithmetic; a machine that
  // has not answered in 10s is not slow, it is wedged or too old to know the
  // frame. /api/limits sits on the boot path and fans out with Promise.all, so
  // this number is the route's whole ceiling, paid once rather than per machine.
  { name: 'limits', timeoutMs: 10_000, note: 'rate-limit windows for the ACTIVE login; the token never leaves the box' },
  { name: 'models', timeoutMs: 15_000, note: 'the model list, computed locally; 15s so a lapsed token can refresh first' },
  { name: 'cliStatus', timeoutMs: 30_000, note: 'is each CLI installed and signed in; three version probes plus a catalog check' },
  { name: 'agentLog', note: "the tail of the agent's own log, for the owner to read" },
  { name: 'pidAliveMany', note: 'which of these pids are alive on that box, one frame for the whole set' },
  { name: 'codexAttached', timeoutMs: 10_000, codes: ['AGENT_OUTDATED'], note: 'Codex threads held by a live local client; ids and holder pids only' },
  { name: 'cwdCheck', timeoutMs: 10_000, codes: ['BAD_CWD'], note: 'does this folder exist on that box' },
  { name: 'fsList', timeoutMs: 10_000, codes: ['BAD_CWD', 'FS_LIST_FAILED'], note: 'folder picker: directory names only, and the one read outside the roots' },
  { name: 'fsMkdir', timeoutMs: 10_000, codes: ['BAD_CWD', 'BAD_NAME', 'EEXIST', 'MKDIR_FAILED'], note: 'folder picker: one mkdir of one named child' },

  // -- logins ---------------------------------------------------------------
  // preflight and switch additionally probe the provider over the network on top of
  // the local credential read, which is the whole of the difference in the leash.
  {
    name: 'accounts',
    timeoutMs: 15_000,
    ops: ['list', 'usage', 'save', 'preflight', 'switch', 'remove', 'login', 'loginStatus', 'loginCode', 'loginCancel'],
    opTimeoutMs: { usage: 30_000, preflight: 45_000, switch: 45_000 },
    codes: ['AGENT_OUTDATED'],
    note: 'which Claude login this box uses',
  },
  {
    name: 'codexAccounts',
    timeoutMs: 15_000,
    ops: ['list', 'usage', 'save', 'preflight', 'switch', 'remove', 'login', 'loginStatus', 'loginCancel', 'resetCredit'],
    opTimeoutMs: { usage: 30_000, preflight: 45_000, switch: 45_000 },
    codes: ['AGENT_OUTDATED'],
    note: 'which ChatGPT login this box uses',
  },

  // -- engine runs ----------------------------------------------------------
  // The agent runs every engine itself (agent/engine-runs.js). It used to spawn
  // them for the master too, stdio relayed over this socket and parked across a
  // gap; that process family is gone with the last engine that needed it.
  {
    name: 'engineRun',
    timeoutMs: 15_000,
    ops: ['start', 'answer', 'steer', 'submit', 'hold', 'interrupt', 'control', 'stop', 'list', 'rpc', 'recycle'],
    opTimeoutMs: { control: 20_000, rpc: 40_000 },
    codes: ['AGENT_OUTDATED', 'BAD_ENGINE', 'BAD_CWD', 'BAD_RUN', 'NO_RUN', 'BUSY', 'SPAWN_FAILED', 'RUN_FAILED', 'STEER_NOT_READY', 'STEER_FAILED', 'STEER_BUSY'],
    note: 'a turn run on the machine: the CLI read here, engine events back (agent/engine-runs.js)',
  },
  { name: 'engineEvents', family: 'stream', reply: 'engineEvent', note: "one run's engine events from a seq on: the missed ones, then live, deltas batched" },
  { name: 'engineUnsubscribe', family: 'none', correlate: 'existing', note: "cancels an engineEvents stream by the id it minted" },
  { name: 'killPid', codes: ['PID_NOT_OURS'], note: 'signal a pid under this agent, or a registered Claude CLI and its tree (taking a session over); any other pid is refused' },

  // -- background shells ----------------------------------------------------
  { name: 'bgShells', codes: ['AGENT_OUTDATED'], note: 'what a shell host still owns: pid, ppid, command, logPath' },
  { name: 'bgShellLog', bytes: ['data'], timeoutMs: 15_000, codes: ['DENIED'], note: "tail one shell's output file, under its own confinement rule" },

  // -- the agent's own code -------------------------------------------------
  {
    name: 'update',
    handler: 'agent',
    timeoutMs: 180_000,
    agentBoundMs: UPDATE_BOUNDS.downloadBudgetMs + UPDATE_BOUNDS.npmTimeoutMs,
    note: 're-download our own files and restart in place; the ONE RPC measured in minutes',
  },
];

// ---------------------------------------------------------------------------
// Normalisation and lookups
// ---------------------------------------------------------------------------
function define(row) {
  const family = row.family || 'request';
  return Object.freeze({
    name: row.name,
    family,
    reply: family === 'none' ? null : (row.reply || row.name),
    correlate: row.correlate || 'minted',
    timeoutMs: row.timeoutMs === undefined
      ? (family === 'request' ? DEFAULT_TIMEOUT_MS : null)
      : row.timeoutMs,
    opTimeoutMs: Object.freeze({ ...(row.opTimeoutMs || {}) }),
    agentBoundMs: row.agentBoundMs ?? null,
    ops: row.ops ? Object.freeze([...row.ops]) : null,
    defaultOp: row.defaultOp || null,
    codes: Object.freeze(row.codes ? [...row.codes] : []),
    handler: row.handler || 'capabilities',
    bytes: Object.freeze(row.bytes ? [...row.bytes] : []),
    note: row.note || '',
  });
}

const FRAMES = Object.freeze(TABLE.map(define));
const BY_NAME = new Map(FRAMES.map((r) => [r.name, r]));

const frame = (name) => BY_NAME.get(name) || null;

// Every capability frame this build answers, which is exactly what the agent
// advertises as `caps` in its hello. An agent that predates the field sends none,
// and a missing `caps` means "assume supported and let the refusal say otherwise".
// Never version arithmetic: twelve of the thirteen gates this replaces were written
// [0, 0, N] against an agent line that moved to 0.1.x long ago, so they gated
// nothing at all and nobody could see it.
const opNames = () => FRAMES.map((r) => r.name);

// Every `t` the AGENT may send back. transport.js's onFrame must dispatch each of
// these and nothing else: an unlisted arrival is binned, and a listed one with no
// row behind it is a dead arm left by a rename.
const replyTypes = () => {
  const out = [];
  for (const r of FRAMES) if (r.reply) out.push(r.reply);
  return [...new Set(out)];
};

// How long the master waits on one frame, honouring a per-op override.
function timeoutFor(name, op = null) {
  const r = frame(name);
  if (!r) return DEFAULT_TIMEOUT_MS;
  if (op && Object.prototype.hasOwnProperty.call(r.opTimeoutMs, op)) return r.opTimeoutMs[op];
  return r.timeoutMs == null ? DEFAULT_TIMEOUT_MS : r.timeoutMs;
}

// Is this op legal on this frame? A frame that declares no ops takes none, so it
// answers true and the caller carries on: absence of a list is not a refusal.
// A frame that names no op means its defaultOp, which is how the three fall-through
// ladders keep working while a NAMED op the build does not have is still refused.
function opAllowed(name, op) {
  const r = frame(name);
  if (!r || !r.ops) return true;
  return r.ops.includes(op == null ? r.defaultOp : op);
}

// ---------------------------------------------------------------------------
// Bulk bytes, as bytes (feature 06)
// ---------------------------------------------------------------------------
// Every bulk reply used to be base64 inside the JSON envelope, and the comment at
// the top of lib/cloud/transport.js had named this seam since it was written. The
// reason it is worth taking is NOT the +33% expansion, which deflate would mostly
// pay back. It is that base64 destroys byte alignment: LZ77's match finder sees a
// different encoding of the same repeated string at each of four phases and misses
// matches it would otherwise take. Measured on a 256 KB transcript tail with
// deflate level 6 on both arms: 121 KB against 76 KB, so 37% AFTER compression,
// plus 61% off the encode. On the master's side the decode was a JSON.parse of a
// multi-megabyte string plus a base64 decode, both synchronous, on the only thread
// the process has.
//
// The format is ONE frame, and that is a deliberate departure from the plan, which
// sketched a JSON envelope followed by a separate binary frame correlated by a
// request id in its header. That design invents a correlation problem and then
// solves it. Putting the envelope IN the binary frame's header has neither half:
// no pending envelope to hold, no assumption about frame ordering, and two
// interleaved reads that cannot be confused because each arrives whole.
//
//   [u32be headerLen][utf8 JSON header][payload bytes, concatenated]
//
// The header is the reply envelope with its byte fields lifted out and listed in
// `__b` as [name, byteLength], in payload order. Everything downstream of decode
// sees exactly the message it saw before, Buffers included, so no caller on either
// side changes.
//
// The header stays JSON on purpose. It is a few dozen bytes; hand-packing it would
// buy nothing measurable and would cost the one property that matters here, which
// is that a person can print a frame and read it.
//
// Negotiation is PER REQUEST, not a mode. The agent advertises `wire` in its hello,
// the master reads it and sets `bin` on the frames it asks with, and the agent
// answers binary only when asked. An old master never sets it; a new master never
// sets it for an agent that did not advertise. There is no window during a fleet
// rollout where one side assumes something the other has not agreed to, which
// matters because editing agent/ ships to every machine at once.
const WIRE = Object.freeze(['binary']);

const BINARY_MAGIC = 'TDB1';

// Which reply fields of this frame carry bulk bytes. Unknown frame: none, because
// the receive path asks this about whatever arrives.
function byteFields(name) {
  const r = frame(name);
  return r ? r.bytes : [];
}

// Does asking with this frame lead to bytes coming back?
function carriesBytes(name) {
  const r = frame(name);
  return !!(r && r.bytes.length);
}

/**
 * A reply, as one binary ws frame. `fields` names the keys to lift out; a key that
 * is absent or not a Buffer is left in the header untouched, which is how
 * readTail's `head: null` stays null instead of becoming an empty Buffer.
 */
function encodeBinaryFrame(obj, fields) {
  const header = {};
  const payloads = [];
  const b = [];
  for (const [k, v] of Object.entries(obj)) {
    if (fields.includes(k) && Buffer.isBuffer(v)) { b.push([k, v.length]); payloads.push(v); }
    else header[k] = v;
  }
  header.__b = b;
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length, 0);
  return Buffer.concat([Buffer.from(BINARY_MAGIC, 'ascii'), len, head, ...payloads]);
}

/**
 * The inverse, or null for anything this build did not write. Null rather than a
 * throw: this runs on every binary arrival on a socket either side may one day put
 * something else on, and an exception here lands on the master's only thread.
 */
function decodeBinaryFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf.toString('ascii', 0, 4) !== BINARY_MAGIC) return null;
  const headLen = buf.readUInt32BE(4);
  if (headLen > buf.length - 8) return null;
  let header;
  try { header = JSON.parse(buf.toString('utf8', 8, 8 + headLen)); } catch { return null; }
  if (!header || !Array.isArray(header.__b)) return null;
  const out = { ...header };
  delete out.__b;
  let at = 8 + headLen;
  for (const pair of header.__b) {
    if (!Array.isArray(pair) || typeof pair[0] !== 'string' || !Number.isInteger(pair[1]) || pair[1] < 0) return null;
    if (at + pair[1] > buf.length) return null;
    // Copied, not a view: the ws receive buffer is pooled, and a Buffer the master
    // holds for the length of a chunked read must not alias bytes the next frame
    // will overwrite.
    out[pair[0]] = Buffer.from(buf.subarray(at, at + pair[1]));
    at += pair[1];
  }
  return at === buf.length ? out : null;
}

module.exports = {
  WIRE,
  byteFields,
  carriesBytes,
  encodeBinaryFrame,
  decodeBinaryFrame,
  FRAMES,
  TYPE_FRAMES,
  UNANSWERED_FRAMES,
  UPDATE_BOUNDS,
  DEFAULT_TIMEOUT_MS,
  frame,
  opNames,
  replyTypes,
  timeoutFor,
  opAllowed,
};
