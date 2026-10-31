'use strict';

// The one event format every engine adapter speaks. Claude (stream-json), Codex
// (app-server JSON-RPC) and Grok (ACP) each translate their own protocol into these
// events, and nothing downstream of an adapter branches on the engine again.
//
// Today the three runners each emit their own dialect ('stream-delta',
// 'permission-request', 'run-complete' ... with payloads that differ per engine, see
// lib/cloud/agent-codex-runner.js and the onEvent surface of lib/cloud/agent-claude-turn.js). This file
// is the target those converge on as each adapter moves to the agent. It is pure: no
// I/O, no engine knowledge, safe to require on both the master and the agent.
//
// Envelope, stamped by createEventLog().append():
//
//   { v, seq, at, runId, sessionId, type, ...payload }
//
//   seq        per-run, strictly increasing from 1. A reader that saw seq N asks for
//              everything after N on reconnect instead of re-reading the transcript.
//   runId      always present. A new chat has no sessionId until the engine names it,
//              so the run is the stable key and 'session.bound' supplies the id.
//   sessionId  null until bound, then carried on every later event.

const VERSION = 1;

const RUN_STATUS = ['running', 'awaiting-permission', 'compacting', 'idle'];
const FINISH_STATUS = ['ok', 'error', 'aborted'];
const BLOCK_KINDS = ['text', 'thinking', 'tool_use'];
const APPROVAL_OUTCOMES = ['allow', 'deny', 'answered', 'timeout', 'cancelled', 'run-ended'];
const NOTICE_LEVELS = ['info', 'warn', 'error'];
const COMPACTION_PHASES = ['running', 'end'];
// What may follow run.finished: the engine's follow-up suggestion, the background
// shells the run left running (a shell host keeps reporting on them), and the
// pointer to the next turn on the same process.
const AFTER_FINISH = new Set(['suggestion', 'shell.started', 'shell.stopped', 'task.updated', 'run.continued']);

// Field specs: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any' | an enum
// array. A trailing '?' on the name marks it optional; optional fields may be null.
const TYPES = {
  // A turn began. engine names the adapter that produced the stream.
  'run.started': { engine: 'string', 'model?': 'string', 'cwd?': 'string', 'permissionMode?': 'string' },
  // The engine named the chat. Fires once per new chat, and again only if the engine
  // moves the run to a different id (a fork or a rekey). transcriptPath is where the
  // engine writes the chat on the machine, when the engine says (Codex's thread/start
  // does; Claude's path follows from the cwd and the id).
  'session.bound': { sessionId: 'string', 'cwd?': 'string', 'transcriptPath?': 'string' },
  // What the engine reported about itself at the start of a turn.
  'session.info': { 'cwd?': 'string', 'model?': 'string', 'permissionMode?': 'string', 'slashCommands?': 'array', 'mcpServers?': 'array' },
  // The OS process serving the run, so the owner can tell its own child from a
  // second writer and reap it by a pid it can prove is its own.
  'run.process': { pid: 'number' },
  'run.status': { status: RUN_STATUS },
  // The engine's own idle/running/requires_action verdict, where it gives one.
  'engine.state': { state: 'string' },
  'compaction': { phase: COMPACTION_PHASES, 'result?': 'any', 'error?': 'string' },

  // Streaming. One assistant message holds ordered blocks; deltas append to a block.
  'message.started': { messageId: 'string' },
  'block.delta': { messageId: 'string', blockIndex: 'number', kind: BLOCK_KINDS, delta: 'string', 'toolName?': 'string' },
  'block.stopped': { messageId: 'string', blockIndex: 'number' },
  'message.stopped': { messageId: 'string' },

  // A tool call the engine is executing, independent of how its input streamed.
  'tool.started': { toolCallId: 'string', toolName: 'string', 'input?': 'any', 'preview?': 'string' },
  'tool.progress': {
    toolCallId: 'string', 'toolName?': 'string', 'parentToolCallId?': 'string', 'taskId?': 'string',
    'preview?': 'string', 'elapsedMs?': 'number',
  },
  'tool.finished': { toolCallId: 'string', ok: 'boolean', 'preview?': 'string' },
  // What a running command has printed since the last one of these, for showing it
  // before the result lands (bugs.md B7). `skipped` counts bytes left out ahead of
  // `text` (a burst is cut to its newest end); `blockIndex` is the streamed block
  // the call drew, where the engine streams one (Codex).
  'tool.output': { toolCallId: 'string', text: 'string', 'skipped?': 'number', 'blockIndex?': 'number' },

  // The engine is blocked until someone answers. questions is set for ask-the-user
  // prompts; timeoutAt is epoch ms, null when the request waits forever.
  // anchor { messageId, blockIndex } is the call's own live row; likeRule
  // { key, label } is the "like this, for this turn" rule the request offers,
  // and turnRule the key of one a person already granted this turn (Codex,
  // lib/codex-events.js commandRule). toolUseId is the call it asks about, where
  // the engine names one (Claude). `codex` is the native harness's server request
  // as Codex sent it ({ method, params }) and `decisions` the answers that request
  // offers (its availableDecisions, or the method's default set), so the card is
  // drawn from Codex's own vocabulary and the agent can refuse anything else
  // (lib/codex-turn.js).
  'approval.requested': {
    requestId: 'string', toolName: 'string', 'input?': 'any', 'preview?': 'string', 'description?': 'string',
    'risk?': 'string', 'questions?': 'array', 'timeoutAt?': 'number', 'suggestions?': 'array',
    'anchor?': 'object', 'likeRule?': 'object', 'turnRule?': 'string', 'toolUseId?': 'string',
    'codex?': 'object', 'decisions?': 'array',
  },
  'approval.resolved': { requestId: 'string', outcome: APPROVAL_OUTCOMES },
  // A question the engine asked without stopping for it (Codex's
  // request_user_input_async): nothing to answer here, the reply is a message.
  // Carried so the person hears of it; questions are [{ question, options }].
  'question.async': { callId: 'string', questions: 'array' },

  // Token counts as the engine reports them. costUsd is null for engines that only
  // expose tokens (Codex, Grok); consumers must not treat null as zero. `total` is
  // the session's running sum in the same field names, where the engine keeps one
  // (Codex does; Claude's result already is the turn's sum).
  'usage': {
    'inputTokens?': 'number', 'outputTokens?': 'number', 'cacheReadTokens?': 'number',
    'cacheWriteTokens?': 'number', 'contextTokens?': 'number', 'contextWindow?': 'number',
    'costUsd?': 'number', 'total?': 'object',
  },
  'limit.updated': { info: 'object' },
  // Anything the engine wants the user to see that is not part of the answer: a retry,
  // an overload, a deprecation. code is a stable slug, message is display text.
  'notice': { level: NOTICE_LEVELS, code: 'string', message: 'string', 'detail?': 'object' },
  'suggestion': { text: 'string' },

  // A shell the engine left running in the background. It can outlive the turn.
  'shell.started': { shellId: 'string', command: 'string', 'description?': 'string', 'logPath?': 'string' },
  'shell.stopped': { shellId: 'string', 'status?': 'string' },

  // Engine frames that the master still folds through its own registries
  // (tasks, hooks, tool summaries, memory recall, persisted files, and the turn's
  // closing frame on run.finished). They carry the
  // engine's frame as `detail` until that folding moves into the adapters too;
  // until then these are the one place engine-specific shapes cross the format.
  'task.updated': { subtype: 'string', detail: 'object' },
  'hook.updated': { detail: 'object' },
  'tool.summary': { detail: 'object' },
  'memory.recalled': { detail: 'object' },
  'files.persisted': { detail: 'object' },

  // The process that served this run went on to another turn: one it started by
  // itself (a shell it was holding finished) or one a user submitted into it. That
  // turn is its own run; a reader follows it by subscribing to nextRunId.
  'run.continued': { nextRunId: 'string' },

  // The native Codex harness (docs/codex-native.md): one `codex app-server`
  // notification for the run's thread or one of its sub-agent threads, exactly as
  // Codex sent it, so the browser draws Codex's own Turn/ThreadItem model rather
  // than a translation of it. Any string in params over 256 KiB is cut and the
  // params carry `truncated: true` (lib/codex-turn.js capParams). A Codex run
  // emits these and the generic lifecycle around them, never message.* / block.*
  // / tool.* / task.updated.
  'codex.event': { method: 'string', params: 'object' },

  // Always the last event of a run's turn. Only AFTER_FINISH types may follow it.
  // A suggestion is one: the engine offers it after the turn is over, and holding
  // the finish back for it would leave a finished answer next to a running spinner.
  'run.finished': {
    status: FINISH_STATUS, 'error?': 'string', 'durationMs?': 'number',
    'costUsd?': 'number', 'numTurns?': 'number', 'lastMessage?': 'string', 'detail?': 'object',
  },
};

const ENVELOPE = new Set(['v', 'seq', 'at', 'runId', 'sessionId', 'type']);

function typeOk(value, spec) {
  if (Array.isArray(spec)) return spec.includes(value);
  switch (spec) {
    case 'any': return value !== undefined;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return typeof value === spec;
  }
}

// Returns a list of problems, empty when the payload is valid. Checks the payload
// only (type plus its fields), so an adapter can validate before the log stamps it.
// Unknown fields are an error: a field one engine sneaks in is a field the UI will
// start depending on, and then the format is per-engine again.
function payloadProblems(ev) {
  if (!ev || typeof ev !== 'object') return ['event is not an object'];
  const spec = TYPES[ev.type];
  if (!spec) return [`unknown type ${JSON.stringify(ev.type)}`];
  const problems = [];
  const known = new Set();
  for (const [rawName, fieldSpec] of Object.entries(spec)) {
    const optional = rawName.endsWith('?');
    const name = optional ? rawName.slice(0, -1) : rawName;
    known.add(name);
    const value = ev[name];
    if (value === undefined || value === null) {
      if (!optional) problems.push(`${ev.type}: missing ${name}`);
      continue;
    }
    if (!typeOk(value, fieldSpec)) problems.push(`${ev.type}: bad ${name} ${JSON.stringify(value)}`);
  }
  for (const key of Object.keys(ev)) {
    if (!known.has(key) && !ENVELOPE.has(key)) problems.push(`${ev.type}: unknown field ${key}`);
  }
  return problems;
}

// Full check of a stamped event: payload plus envelope.
function eventProblems(ev) {
  const problems = payloadProblems(ev);
  if (!ev || typeof ev !== 'object') return problems;
  if (ev.v !== VERSION) problems.push(`bad v ${JSON.stringify(ev.v)}`);
  if (!Number.isInteger(ev.seq) || ev.seq < 1) problems.push(`bad seq ${JSON.stringify(ev.seq)}`);
  if (!typeOk(ev.at, 'number')) problems.push(`bad at ${JSON.stringify(ev.at)}`);
  if (typeof ev.runId !== 'string' || !ev.runId) problems.push('missing runId');
  if (ev.sessionId !== null && typeof ev.sessionId !== 'string') problems.push(`bad sessionId ${JSON.stringify(ev.sessionId)}`);
  return problems;
}

// One run's ordered stream. append() stamps the envelope, validates, and keeps the
// last `limit` events so a reader that reconnects can catch up with since(seq).
// since() returns null when the reader has fallen further behind than the buffer
// holds; the caller then falls back to the transcript on disk, which is the truth.
//
// Not every event is worth the same to a reader that comes back late. Token deltas
// and tool progress ticks are the bulk of a long turn (a ten minute one streams
// well past 4000 deltas) and the one part it can do without: the text lands in the
// transcript with its message, and a progress tick is superseded by the next. So a
// full buffer drops those first, and a reader is only told `gap` when an event it
// cannot do without is gone. Before this, the oldest event went whatever it was,
// and a master that restarted under a long turn (every deploy) replayed from seq 0,
// heard `gap`, and ended a turn that was still running.
// A command's live output is the same kind of thing: its result replaces it.
const DROPPABLE = new Set(['block.delta', 'tool.progress', 'tool.output']);
// A native Codex run's streaming is the same bulk under one type: every
// `item/.../delta` (agent text, reasoning, plan, command and patch output) and
// the MCP progress ticks are superseded by the item/completed that carries the
// item whole, so those are the droppable codex.events. The item lifecycle and
// everything else are kept.
const CODEX_STREAMING = /^item\/.+(?:\/delta|Delta|\/progress)$/;
const droppable = (ev) => DROPPABLE.has(ev.type) || (ev.type === 'codex.event' && CODEX_STREAMING.test(ev.method));

function createEventLog({ runId, sessionId = null, limit = 2000, now = Date.now } = {}) {
  if (typeof runId !== 'string' || !runId) throw new TypeError('createEventLog needs a runId');
  let seq = 0;
  let finished = false;
  let boundId = sessionId;
  // Two queues, each in seq order: what a late reader needs, and what it can lose.
  const kept = [];
  const drops = [];
  let lostThrough = 0; // the newest evicted event from `kept`: a reader before it has a hole

  function append(payload) {
    if (finished && !AFTER_FINISH.has(payload && payload.type)) throw new Error(`run ${runId} already finished, cannot append ${payload && payload.type}`);
    const problems = payloadProblems(payload);
    if (problems.length) throw new TypeError(`invalid engine event: ${problems.join('; ')}`);
    if (payload.type === 'session.bound') boundId = payload.sessionId;
    const ev = { ...payload, v: VERSION, seq: ++seq, at: now(), runId, sessionId: boundId };
    (droppable(ev) ? drops : kept).push(ev);
    if (kept.length + drops.length > limit) {
      if (drops.length) drops.shift();
      else lostThrough = kept.shift().seq;
    }
    if (ev.type === 'run.finished') finished = true;
    return ev;
  }

  // The first index in a seq-ordered queue past `afterSeq`.
  const after = (q, afterSeq) => {
    let lo = 0;
    let hi = q.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (q[mid].seq <= afterSeq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  function since(afterSeq = 0) {
    if (afterSeq >= seq) return [];
    if (afterSeq < lostThrough) return null;
    const out = [];
    let i = after(kept, afterSeq);
    let j = after(drops, afterSeq);
    while (i < kept.length || j < drops.length) {
      if (j >= drops.length || (i < kept.length && kept[i].seq < drops[j].seq)) out.push(kept[i++]);
      else out.push(drops[j++]);
    }
    return out;
  }

  return {
    append,
    since,
    get seq() { return seq; },
    get sessionId() { return boundId; },
    get finished() { return finished; },
  };
}

// What an engine can do, declared by its adapter so the UI shows controls from data
// instead of engine-name checks. Every key is required: an adapter that forgets one
// fails here, not as a silently missing button.
const CAPABILITY_SPEC = {
  steer: 'boolean',        // accepts a message mid-turn without aborting it
  resume: 'boolean',       // continues an existing session by id
  fork: 'boolean',         // branches a session into a new one
  planMode: 'boolean',     // has a plan-then-approve mode
  images: 'boolean',       // accepts image attachments
  files: 'boolean',        // accepts file attachments by path
  costUsd: 'boolean',      // reports dollar cost, not only tokens
  effort: 'boolean',       // takes a reasoning effort; the levels come per model, with the model list
  permissionModes: 'array',
  midTurn: ['takes-over', 'joins-turn', 'after-turn'], // where a mid-turn message lands
  worktree: 'boolean',     // its own CLI can start a chat in a git worktree
  thinkingDisplay: 'boolean', // the live session takes a show-thinking setting
  contextBreakdown: 'boolean', // answers "what is filling the context window"
  compactAt: 'fraction?',  // offers /compact, hot past this share of the window; null = no /compact
  rewind: 'boolean',       // restores files to a checkpoint
  mcpStatus: 'boolean',    // reports MCP server connection status
  backgroundShells: 'boolean', // runs shells that outlive the turn
  slashCommandList: 'boolean', // reports the slash commands a session has
  // How the master tells that another client is writing this chat. Three mechanisms,
  // not a yes/no: a registry of live CLI pids, the app-server saying a client is
  // attached, or a transcript that keeps growing under nobody Termdeck started.
  controlDetection: ['pidRegistry', 'appServerAttach', 'mtimeHeuristic'],
  // What a usage frame means: one model call's usage, summed across the turn
  // ('additive'), or the turn's running total so far ('snapshot').
  usageReport: ['additive', 'snapshot'],
  occupancySegments: 'boolean', // usage splits the context window's occupancy into parts
};

const fractionOrNull = (v) => v === null || (typeof v === 'number' && v > 0 && v < 1);

function capabilityProblems(caps) {
  if (!caps || typeof caps !== 'object') return ['capabilities is not an object'];
  const problems = [];
  for (const [name, spec] of Object.entries(CAPABILITY_SPEC)) {
    if (!(name in caps)) problems.push(`missing ${name}`);
    else if (spec === 'fraction?' ? !fractionOrNull(caps[name]) : !typeOk(caps[name], spec)) problems.push(`bad ${name} ${JSON.stringify(caps[name])}`);
    else if (spec === 'array' && !caps[name].every((x) => typeof x === 'string')) problems.push(`${name} must hold strings`);
  }
  for (const key of Object.keys(caps)) {
    if (!(key in CAPABILITY_SPEC)) problems.push(`unknown capability ${key}`);
  }
  // The two ways of saying "takes a message mid-turn" must agree.
  if (typeof caps.steer === 'boolean' && CAPABILITY_SPEC.midTurn.includes(caps.midTurn)
    && caps.steer !== (caps.midTurn !== 'after-turn')) problems.push('steer disagrees with midTurn');
  return problems;
}

module.exports = {
  VERSION,
  TYPES,
  payloadProblems,
  eventProblems,
  capabilityProblems,
  createEventLog,
  droppable,
};
