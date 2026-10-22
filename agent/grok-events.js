'use strict';

// Grok's half of the engine adapter: `grok agent stdio` (the Agent Client Protocol,
// JSON-RPC 2.0 over stdio) in, engine events out (lib/engine-events.js). Pure, like
// lib/codex-events.js: no process, no timer, no socket.
//
// One translator follows ONE TURN on one session. The stdio child is shared by every
// session on the machine (agent/engine-runs.js routes each line to the run whose
// sessionId it names).
//
// Protocol facts, spike-verified against grok 0.2.101 to 0.2.112:
//
//  - Every streaming frame is a notification whose params carry `update`, and the
//    outer method is not reliable (session/update live, turn_completed on
//    _x.ai/session_notification, _x.ai/session/update on disk). So it is read the
//    way lib/transcript.js parseGrokUpdatesText reads the disk: branch on
//    params.update.sessionUpdate, ignore the method. xAI admin notifications carry
//    no `update` and fall through.
//  - params._meta.promptId is the turn id (transcript.js grokPromptId), the same key
//    the disk parser builds the bubble from, so `turn:<promptId>` reconciles.
//  - params._meta.totalTokens is the context occupancy. usage.inputTokens is a SUM
//    over model calls and never the occupancy.
//  - session/prompt is a long request that resolves at turn end with
//    {stopReason, _meta:{usage, modelId, totalTokens}}; the driver hands that to
//    promptResolved(). turn_completed carries the same stop_reason a beat earlier,
//    plus agent_result, grok's own summary of the turn.
//  - session/request_permission (agent -> client, has an id) is the approval:
//    {toolCall:{toolCallId, kind, title, rawInput}, options:[{optionId, kind}]}.
//    The reply echoes an OFFERED optionId verbatim; an optionId that was not offered
//    makes grok abort the whole turn, so pickOption only ever returns a real one and
//    otherwise the reply is `cancelled`.
//
// The driver calls:
//
//   bound(sessionId, { cwd, transcriptPath })   the session is loaded or created
//   prompting()                                 session/prompt went out -> run.status running
//   notification(msg)                           one frame for this session -> { events }
//   request(method, params, rpcId)              one server request -> { events, writes }
//   answer(requestId, decision)                 the master's decision -> { events, writes }
//   promptResolved(result, { signals })         session/prompt came back -> the finish
//   abort() / fail(message, detail) / exit({ code, error })
//
// Whether an approval is allowed by the chat's mode, a policy or a person is the
// master's call (lib/cloud/agent-grok-runner.js); every one is raised as an event.

const { inputPreview, grokPromptId, TERMINAL_TOOL_STATUSES } = require('./transcript');

// toolCall.kind -> Termdeck's tool vocabulary, so risk scoring and policies read a
// Grok call like the other two engines' calls. The master's mode decision reads it
// too: Read and Edit are what a mode may wave through.
function approvalToolName(toolCall) {
  if (toolCall.kind === 'execute') return 'Bash';
  if (toolCall.kind === 'edit' || toolCall.kind === 'write') return 'Edit';
  if (toolCall.kind === 'read') return 'Read';
  const meta = toolCall._meta && toolCall._meta['x.ai/tool'];
  return (meta && (meta.label || meta.name)) || toolCall.title || 'tool';
}

// A real optionId from the ones grok offered, or null (the reply is then cancelled).
// scope 'session' prefers the *_always variant when offered.
function pickOption(options, wantAllow, scope) {
  const list = Array.isArray(options) ? options : [];
  const prefix = wantAllow ? 'allow_' : 'reject_';
  const preferred = scope === 'session' ? `${prefix}always` : `${prefix}once`;
  return list.find((o) => o && o.kind === preferred) || list.find((o) => o && typeof o.kind === 'string' && o.kind.startsWith(prefix)) || null;
}

function permissionReply(options, rpcId, decision) {
  const d = decision || {};
  const opt = d.cancelled || d.timedOut ? null : pickOption(options, d.behavior === 'allow', d.scope);
  const outcome = opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' };
  return { jsonrpc: '2.0', id: rpcId, result: { outcome } };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// agent_result and chunk contents are the engine's own shapes; flatten to text.
function textOf(raw) {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return '';
  const parts = Array.isArray(raw) ? raw : Array.isArray(raw.content) ? raw.content : [raw];
  return parts.map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join(' ');
}

const chunkText = (content) => (content && content.type === 'text' && typeof content.text === 'string' ? content.text : '');

function createGrokTranslator({ sessionId = null } = {}) {
  let sid = sessionId;
  let turnId = null;
  let messageId = null;
  let started = false;
  let ended = false;
  let aborted = false;
  let usage = null;           // turn_completed.usage, or session/prompt's _meta.usage
  let contextTokens = null;   // params._meta.totalTokens, the occupancy
  let sentContext = null;
  let contextWindow = null;
  let agentResult = null;
  let stopReason = null;
  const blocks = [];          // { index, kind, toolName, text, stopped }
  const toolBlocks = new Map(); // toolCallId -> block index
  const pending = new Map();  // requestId -> { options, rpcId }

  const out = (events = [], writes = [], extra = {}) => ({ events, writes, ended: false, ...extra });

  function openMessage(events) {
    if (messageId) return;
    messageId = turnId ? `turn:${turnId}` : `turn:pending:${sid || 'new'}`;
    events.push({ type: 'message.started', messageId });
  }

  function stopBlock(events, b) {
    if (!b || b.stopped) return;
    b.stopped = true;
    events.push({ type: 'block.stopped', messageId, blockIndex: b.index });
  }

  function delta(events, block, text) {
    if (!text) return;
    block.text += text;
    const ev = { type: 'block.delta', messageId, blockIndex: block.index, kind: block.kind, delta: text };
    if (block.toolName) ev.toolName = block.toolName;
    events.push(ev);
  }

  // Consecutive chunks of one kind grow one block, the live twin of the disk
  // parser's pushMergeable. Anything else arriving closes the open one.
  function pushText(events, kind, text) {
    if (!text) return;
    openMessage(events);
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && !last.toolName && !last.stopped) return delta(events, last, text);
    stopBlock(events, last);
    const block = { index: blocks.length, kind, toolName: null, text: '', stopped: false };
    blocks.push(block);
    return delta(events, block, text);
  }

  function toolCall(events, update) {
    const id = update.toolCallId;
    if (!id) return null;
    openMessage(events);
    stopBlock(events, blocks[blocks.length - 1]);
    // The name matches transcript.js grokToolUseBlock (title || 'tool'): the live
    // bubble reconciles into the settled block the disk parser builds.
    const toolName = update.title || 'tool';
    const block = { index: blocks.length, kind: 'tool_use', toolName, text: '', stopped: false };
    blocks.push(block);
    toolBlocks.set(id, block.index);
    const preview = inputPreview(update.title, update.rawInput || {});
    delta(events, block, preview);
    const ev = { type: 'tool.started', toolCallId: String(id), toolName };
    if (preview) ev.preview = preview;
    events.push(ev);
    return block;
  }

  function usageEvent(final) {
    const u = usage || {};
    const ev = { type: 'usage' };
    const put = (k, v) => { if (v != null) ev[k] = v; };
    put('inputTokens', num(u.inputTokens));
    put('outputTokens', num(u.outputTokens));
    put('cacheReadTokens', num(u.cachedReadTokens));
    put('contextTokens', contextTokens);
    put('contextWindow', contextWindow);
    const calls = num(u.modelCalls) ?? num(u.numTurns);
    if (final && calls != null) ev.total = { modelCalls: calls };
    return Object.keys(ev).length > 1 ? ev : null;
  }

  function settleAll(events, writes, outcome) {
    for (const [requestId, p] of pending) {
      writes.push(permissionReply(p.options, p.rpcId, { cancelled: true }));
      events.push({ type: 'approval.resolved', requestId, outcome });
    }
    pending.clear();
  }

  function lastMessage() {
    const own = textOf(agentResult).trim();
    if (own) return own;
    const text = blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n').trim();
    return text || null;
  }

  function finish(events, writes, status, error) {
    if (ended) return;
    ended = true;
    settleAll(events, writes, 'run-ended');
    for (const b of blocks) stopBlock(events, b);
    if (messageId) events.push({ type: 'message.stopped', messageId });
    const u = usageEvent(true);
    if (u) events.push(u);
    const fin = { type: 'run.finished', status };
    if (status === 'error') fin.error = error || 'Grok turn failed';
    const last = status === 'ok' ? lastMessage() : null;
    if (last) fin.lastMessage = last;
    const detail = {};
    if (turnId) detail.turnId = turnId;
    if (stopReason) detail.stopReason = stopReason;
    if (Object.keys(detail).length) fin.detail = detail;
    events.push(fin);
  }

  function bound(id, { cwd = null, transcriptPath = null, window = null } = {}) {
    sid = id;
    if (num(window) != null) contextWindow = window;
    const ev = { type: 'session.bound', sessionId: id };
    if (cwd) ev.cwd = cwd;
    if (transcriptPath) ev.transcriptPath = transcriptPath;
    return out([ev]);
  }

  function prompting() {
    if (started || ended) return out();
    started = true;
    return out([{ type: 'run.status', status: 'running' }]);
  }

  function notification(msg) {
    const events = [];
    const params = msg && msg.params;
    const update = params && params.update;
    // Nothing before prompting() is this turn: session/load answers by replaying the
    // chat's earlier turns as these same frames, and taking them would open the
    // bubble under an old prompt's id and swallow this turn's message.started.
    if (ended || !started || !update || typeof update.sessionUpdate !== 'string') return out();
    const pid = grokPromptId(msg);
    if (pid && pid !== turnId) turnId = pid;
    const meta = params._meta;
    if (meta && num(meta.totalTokens) != null) contextTokens = meta.totalTokens;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        pushText(events, 'text', chunkText(update.content));
        break;
      case 'agent_thought_chunk':
        pushText(events, 'thinking', chunkText(update.content));
        break;
      case 'tool_call':
        toolCall(events, update);
        break;
      case 'tool_call_update': {
        const id = update.toolCallId;
        if (!id) break;
        // An update with no tool_call seen this turn gets a stub, so its status lands.
        let idx = toolBlocks.get(id);
        if (idx === undefined) { toolCall(events, update); idx = toolBlocks.get(id); }
        const block = blocks[idx];
        const status = typeof update.status === 'string' ? update.status : '';
        if (block && TERMINAL_TOOL_STATUSES.has(status) && !block.stopped) {
          stopBlock(events, block);
          events.push({ type: 'tool.finished', toolCallId: String(id), ok: status === 'completed' });
        }
        break;
      }
      case 'turn_completed':
        if (update.usage && typeof update.usage === 'object') usage = update.usage;
        if (update.agent_result != null) agentResult = update.agent_result;
        if (typeof update.stop_reason === 'string' && update.stop_reason) stopReason = update.stop_reason;
        break;
      default:
        break; // user_message_chunk (our own prompt echoed), available_commands_update, ...
    }
    // Occupancy moves once per model call; the snapshot a browser attaches to reads it.
    if (contextTokens != null && contextTokens !== sentContext && !ended) {
      sentContext = contextTokens;
      const u = usageEvent(false);
      if (u) events.push(u);
    }
    return out(events);
  }

  function request(method, params = {}, rpcId) {
    if (method !== 'session/request_permission') {
      // fs.readTextFile/writeTextFile were declared false at initialize; anything
      // arriving as a request is refused rather than left hanging grok's wait loop.
      return out([], [{ jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: `Termdeck does not handle ${method}` } }]);
    }
    const options = Array.isArray(params.options) ? params.options : [];
    if (ended) return out([], [permissionReply(options, rpcId, { cancelled: true })]);
    const tc = params.toolCall || {};
    const requestId = `grok-${rpcId}`;
    pending.set(requestId, { options, rpcId });
    const ev = {
      type: 'approval.requested',
      requestId,
      toolName: approvalToolName(tc),
      input: tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {},
    };
    if (tc.title) ev.preview = String(tc.title);
    return out([ev, { type: 'run.status', status: 'awaiting-permission' }]);
  }

  function answer(requestId, decision) {
    const p = pending.get(requestId);
    if (!p) return out(); // already settled: a second copy of an answer is harmless
    pending.delete(requestId);
    const d = decision || {};
    const outcome = d.timedOut ? 'timeout' : d.cancelled ? 'cancelled' : d.behavior === 'allow' ? 'allow' : 'deny';
    const events = [{ type: 'approval.resolved', requestId, outcome }];
    if (!pending.size && !ended) events.push({ type: 'run.status', status: 'running' });
    return out(events, [permissionReply(p.options, p.rpcId, d)]);
  }

  // session/prompt came back: that is the end of the turn. Its own stopReason is the
  // verdict; turn_completed's is the fallback for a response that omits it, or an
  // ordinary finished turn would read as `unknown` and be reported as a failure.
  function promptResolved(result, { signals = null } = {}) {
    const events = [];
    const writes = [];
    if (ended) return out([], [], { ended: true });
    const meta = (result && result._meta) || {};
    if (meta.usage && typeof meta.usage === 'object') usage = meta.usage;
    if (num(meta.totalTokens) != null) contextTokens = meta.totalTokens;
    // signals.json is what the CLI's own /context meter reads. It lags the last
    // frame a beat while it is written, so the higher of the two wins.
    if (signals) {
      if (num(signals.contextWindowTokens) != null) contextWindow = signals.contextWindowTokens;
      if (num(signals.contextTokensUsed) != null) contextTokens = contextTokens != null ? Math.max(contextTokens, signals.contextTokensUsed) : signals.contextTokensUsed;
    }
    if (typeof meta.modelId === 'string' && meta.modelId) events.push({ type: 'session.info', model: meta.modelId });
    const reason = (result && result.stopReason) || stopReason || null;
    stopReason = reason;
    const status = aborted || reason === 'cancelled' ? 'aborted' : reason === 'end_turn' ? 'ok' : 'error';
    finish(events, writes, status, status === 'error' ? `grok turn ended with stopReason=${reason || 'unknown'}` : null);
    return out(events, writes, { ended: true });
  }

  function abort() {
    aborted = true;
  }

  function fail(message, detail = null) {
    const events = [];
    const writes = [];
    if (!ended) {
      finish(events, writes, aborted ? 'aborted' : 'error', message);
      const fin = events[events.length - 1];
      if (detail) fin.detail = { ...(fin.detail || {}), ...detail };
    }
    return out(events, writes, { ended: true });
  }

  function exit({ code = null, error = null } = {}) {
    const r = fail(error || `grok agent stdio exited${code != null ? ` (code ${code})` : ''}`);
    r.writes = []; // nobody is left to read these replies
    return r;
  }

  return {
    bound,
    prompting,
    notification,
    request,
    answer,
    promptResolved,
    abort,
    fail,
    exit,
    get sessionId() { return sid; },
    get turnId() { return turnId; },
    get started() { return started; },
    get ended() { return ended; },
    pendingApprovals: () => pending.size,
  };
}

module.exports = { approvalToolName, pickOption, createGrokTranslator };
