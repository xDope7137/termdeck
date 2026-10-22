'use strict';

// Claude's half of the engine adapter: stream-json frames in, engine events out
// (lib/engine-events.js). Pure. It owns no process, no timer and no socket, so the
// same translator runs wherever the CLI does and the contract tests can feed it a
// recorded tape with nothing else running.
//
// It also owns the question that is hardest to get right on this engine, and that
// lib/cloud/remote-runner.js answered across the tunnel until this replaced it: when
// is the turn over? Three things make a result frame NOT the end (the incidents
// behind each are in that file's history, `git log -- lib/cloud/remote-runner.js`):
//
//   * owed: every user frame we write (the prompt, each steer) is answered by one
//     result WITHOUT an origin, and the turn is not over while one is owed. A steer
//     is priority 'now', which closes the running turn and answers in a new one, so
//     it costs one extra result frame.
//   * origin: a result for a turn the CLI dequeued by itself (a task notification,
//     an auto-continuation). Not ours while one of ours is still owed. With nothing
//     owed it is the only end the turn will get: a background Agent's notification
//     turn and a held shell host's reaction turn both close on one. Skipping it
//     unconditionally left chats 2d201c15 and 40451795 on "Responding" until the
//     20 minute ceiling.
//   * a background Agent still running inside this CLI: the turn has answered but
//     the process must not be reaped. The result is held until the agents report a
//     terminal status and a later result lands, or until the driver's ceiling
//     calls expire().
//
// All three are the fallback. When the CLI reports its own state
// (system/session_state_changed, which the agent asks for with
// CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS), `idle` ends the turn and results are only
// recorded. Measured on 2.1.283: idle lands right after the last result anyone is
// owed and never between a steer's two results or while a background Agent runs.
// Idle with a frame of ours unanswered gets the driver's short window
// (`confirmIdle`, then idleConfirmed()) to turn back to running first.
//
// The driver (spawn, stdin, the ceilings) calls:
//
//   frame(m)          one parsed stdout line -> { events, writes, ended, holding, control }
//   answer(id, d)     the user's decision on an approval -> { events, writes }
//   steer()           before writing a priority 'now' user frame
//   steerPending      a steer is written and the CLI has not taken it up yet
//   idleConfirmed(g)  the confirm window for `confirmIdle: g` ran out
//   abort()           the user pressed stop; the next finish reports 'aborted'
//   expire()          a ceiling fired; finish with whatever result we hold
//   exit({code, error})  the child is gone
//
// `writes` are frames the driver must put on the CLI's stdin, in order. `control` is
// the answer to a control_request the DRIVER issued, keyed by its request id.

const TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification']);
// lib/task-registry.js's TERMINAL set plus 'cancelled'. Erring toward "finished":
// wrongly calling a task alive pins a live CLI for the whole ceiling.
const TASK_TERMINAL = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled']);
const HOOK_SUBTYPES = new Set(['hook_started', 'hook_progress', 'hook_response']);
// "Output is being written to: <path>" is the only place a background shell's log
// path appears. Non-greedy to the extension so a Windows path with spaces survives.
const BG_LOG_RE = /Output is being written to:\s*(.+?\.output)\b/;
// The id, in the same text. Only a sub-agent's result needs it: the turn's own
// shells name it in tool_use_result.backgroundTaskId.
const BG_ID_RE = /running in background with ID:\s*([A-Za-z0-9_-]+)/;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function blockKindOf(block) {
  const t = block && block.type;
  if (t === 'text') return 'text';
  if (t === 'thinking' || t === 'redacted_thinking') return 'thinking';
  if (t === 'tool_use' || t === 'server_tool_use') return 'tool_use';
  return null;
}

// Result usage as the format names it. A turn the CLI stops itself (--max-budget-usd)
// reports every counter as 0, so a zeroed result falls back to the running tally of
// assistant-message usage rather than claiming a turn that cost money used nothing.
//
// `costUsd` is THIS turn's cost. The CLI's total_cost_usd is the PROCESS total, so on
// a process that stays up across turns it grows with every one (QA 2026-10-08: the
// seventh turn's chip read $0.12, its own share was $0.005). `prior` is the total the
// process had reached before this turn began.
function turnCost(result, prior) {
  const total = num(result && result.total_cost_usd);
  if (total === null) return null;
  return Math.max(0, total - (num(prior) || 0));
}

function usageEvent(result, tally, prior) {
  const u = (result && result.usage) || {};
  const zeroed = !u.input_tokens && !u.output_tokens;
  const src = zeroed && tally ? tally : u;
  const ev = {
    type: 'usage',
    inputTokens: num(src.input_tokens),
    outputTokens: num(src.output_tokens),
    cacheReadTokens: num(src.cache_read_input_tokens),
    cacheWriteTokens: num(src.cache_creation_input_tokens),
    costUsd: turnCost(result, prior),
  };
  for (const k of Object.keys(ev)) if (ev[k] === null) delete ev[k];
  return ev;
}

function addUsage(tally, u) {
  const out = { ...(tally || {}) };
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (num(u[k]) !== null) out[k] = (out[k] || 0) + u[k];
  }
  return out;
}

function retryMessage(m) {
  const err = m.error && typeof m.error === 'object' ? m.error : null;
  const detail = str(err && (err.message || err.error)) || str(m.error);
  const attempt = num(m.attempt);
  const max = num(m.max_retries ?? m.maxRetries);
  const count = attempt !== null ? ` (attempt ${attempt}${max !== null ? ` of ${max}` : ''})` : '';
  return `Retrying the API request${count}${detail ? `: ${detail}` : ''}`;
}

// A frame that means the CLI has started a turn, seen on a process whose last turn
// is over. Only a positive signal counts: bookkeeping about shells it still holds
// (task frames), a trailing suggestion and a result for a turn it dequeued itself
// all arrive on an idle process without a turn beginning, and starting a phantom
// run for one of them would lock the chat against its user.
function turnStarting(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.type === 'system') return m.subtype === 'init' || m.subtype === 'status' || m.subtype === 'api_retry' || HOOK_SUBTYPES.has(m.subtype);
  if (m.type === 'control_request') return !!(m.request && m.request.subtype === 'can_use_tool');
  return ['stream_event', 'assistant', 'user', 'tool_progress', 'tool_use_summary', 'rate_limit_event'].includes(m.type);
}

// `shells`: shell.started payloads a previous turn on the same process left
// running, so this turn recognises their endings. `priorCostUsd`: the process's
// total_cost_usd when this turn began (the previous translator's processCostUsd),
// so the turn reports its own cost and not the running total.
function createClaudeTranslator({ sessionId = null, resumed = false, permissionMode = null, shells = [], selfStarted = false, priorCostUsd = 0 } = {}) {
  let sid = sessionId;
  let processCost = num(priorCostUsd) || 0; // the latest total_cost_usd seen on this process
  let inflight = null;           // { messageId, blocks: [] } for the streaming message
  let messageSeq = 0;
  let tally = null;              // running assistant usage, see usageEvent
  let lastResult = null;
  let ended = false;
  let aborted = false;
  let owed = selfStarted ? 0 : 1; // user frames written minus the origin-less results that answered them
  // Steers written that the CLI has not taken up yet. A priority 'now' frame waits
  // for the running turn to close (one result frame, of any origin) and is then
  // the next turn, so each result takes one off. See steerPending.
  let queued = 0;
  let engineReportsState = false;
  let stateGen = 0;
  let lastSeen = null; // the latest result frame of any origin, for an end on idle
  let suggestionSeen = false;
  let awaitingSuggestion = false;
  const liveAgents = new Set();  // agentId / tool_use_id of every background Agent still running
  // tool_use_id of every FOREGROUND Agent call this turn is waiting on. A priority
  // 'now' steer aborts those: each comes back "[Request interrupted by user for tool
  // use]", its finished work is thrown away and the model relaunches it from zero
  // (chats a62e1315, 9daac53e). The driver refuses a steer while any is open, so the
  // message queues behind the turn instead.
  const agentCalls = new Set();
  const bgPendingStarts = new Map(); // tool_use_id -> { command, description }
  const bgShells = new Map(shells.filter((s) => s && s.shellId).map((s) => [s.shellId, s])); // shellId -> shell.started payload
  let shellEnded = false; // a shell ended while this turn ran: the CLI owes a turn about it
  const approvals = new Map();       // CLI request_id -> original input
  const approvalTools = new Map();   // CLI request_id -> the tool_use_id it asks about
  const openCalls = new Map();       // tool_use_id -> tool name, for calls with no result yet (binds a request the CLI did not tag)

  const out = () => ({ events: [], writes: [], ended: false, holding: false, control: null, confirmIdle: null });

  function finishFrom(res, r) {
    ended = true;
    r.ended = true;
    if (res) r.events.push(usageEvent(res, tally, priorCostUsd));
    const ok = res && res.subtype === 'success' && !res.is_error;
    const finished = { type: 'run.finished', status: aborted ? 'aborted' : ok ? 'ok' : 'error' };
    // An API refusal arrives as subtype 'success' with is_error, and its reason is
    // in result, not in errors: the subtype would name it "success".
    if (!ok && res) finished.error = str(Array.isArray(res.errors) ? res.errors.join('; ') : null) || (res.subtype === 'success' && res.is_error && str(res.result)) || res.subtype || 'error';
    else if (!ok && !aborted) finished.error = 'Claude stopped answering before it finished the turn';
    if (num(res && res.duration_ms) !== null) finished.durationMs = res.duration_ms;
    const cost = turnCost(res, priorCostUsd);
    if (cost !== null) finished.costUsd = cost;
    if (num(res && res.num_turns) !== null) finished.numTurns = res.num_turns;
    if (ok && str(res.result)) finished.lastMessage = res.result;
    // The engine's own closing frame, for the master's result normalisers
    // (lib/result-fields.js, the budget-stop check) until they move here too.
    // turn_cost_usd is ours, not the CLI's: the master reads it before the
    // process-wide total_cost_usd (MachineHost.finishTurn). Only a later turn on
    // the process needs it; on its first the total IS the turn's cost.
    if (res) finished.detail = cost !== null && num(priorCostUsd) > 0 ? { ...res, turn_cost_usd: cost } : res;
    r.events.push(finished);
    return r;
  }

  function onStream(ev, r) {
    switch (ev.type) {
      case 'message_start': {
        const id = str(ev.message && ev.message.id) || `m${++messageSeq}`;
        inflight = { messageId: id, blocks: [] };
        r.events.push({ type: 'message.started', messageId: id });
        break;
      }
      case 'content_block_start': {
        if (!inflight) {
          inflight = { messageId: `m${++messageSeq}`, blocks: [] };
          r.events.push({ type: 'message.started', messageId: inflight.messageId });
        }
        const kind = blockKindOf(ev.content_block);
        if (kind) inflight.blocks[ev.index] = { kind, toolName: str(ev.content_block.name) };
        break;
      }
      case 'content_block_delta': {
        const block = inflight && inflight.blocks[ev.index];
        const d = ev.delta || {};
        const delta = d.text || d.thinking || d.partial_json || '';
        if (!block || !delta) break;
        const e = { type: 'block.delta', messageId: inflight.messageId, blockIndex: ev.index, kind: block.kind, delta };
        if (block.toolName) e.toolName = block.toolName;
        r.events.push(e);
        break;
      }
      case 'content_block_stop':
        if (inflight && inflight.blocks[ev.index]) {
          r.events.push({ type: 'block.stopped', messageId: inflight.messageId, blockIndex: ev.index });
        }
        break;
      case 'message_stop':
        if (inflight) r.events.push({ type: 'message.stopped', messageId: inflight.messageId });
        inflight = null;
        break;
      default:
        break;
    }
  }

  // A permission request is withdrawn: the card waiting in the browser is a
  // question nobody is asking any more, and an answer to it must not be written.
  function withdraw(requestId, r) {
    if (!approvals.has(requestId)) return;
    approvals.delete(requestId);
    approvalTools.delete(requestId);
    r.events.push({ type: 'approval.resolved', requestId: String(requestId), outcome: 'cancelled' });
    if (!approvals.size && !ended) r.events.push({ type: 'run.status', status: 'running' });
  }

  function onUser(m, r) {
    const content = m.message.content;
    for (const b of content) {
      if (b && b.type === 'tool_result' && str(b.tool_use_id)) {
        agentCalls.delete(b.tool_use_id);
        openCalls.delete(b.tool_use_id);
        r.events.push({ type: 'tool.finished', toolCallId: b.tool_use_id, ok: !b.is_error });
        // The tool call a pending request asks about already has its result, so
        // the request is moot. A steer mid-turn aborts a pending ExitPlanMode
        // this way ("Tool permission request aborted"), and the model then asks
        // again with a revised plan: without this the first plan's card stayed
        // up beside the second, and approving it answered nothing yet still
        // flipped the chat's mode. control_cancel_request covers it when the
        // CLI sends one; this covers it when the result is all there is.
        for (const [requestId, toolUseId] of approvalTools) {
          if (toolUseId === b.tool_use_id) withdraw(requestId, r);
        }
      }
    }
    const tr = m.tool_use_result;
    // A background shell a SUB-AGENT started. Its result carries no
    // tool_use_result, only the text naming the id and the log. It is this CLI's
    // shell all the same: reap the CLI and it dies, and the sub-agent that promised
    // to report on it never can (measured on 2.1.283; chat c8b064fb ended "[killed]").
    if (m.parent_tool_use_id && !(tr && tr.backgroundTaskId)) {
      for (const b of content) {
        if (!b || b.type !== 'tool_result' || !bgPendingStarts.has(b.tool_use_id)) continue;
        const text = typeof b.content === 'string' ? b.content : '';
        const id = (BG_ID_RE.exec(text) || [])[1];
        if (!id) continue;
        const start = bgPendingStarts.get(b.tool_use_id);
        bgPendingStarts.delete(b.tool_use_id);
        const shell = { type: 'shell.started', shellId: id, command: start.command };
        if (start.description) shell.description = start.description;
        const logPath = (BG_LOG_RE.exec(text) || [])[1];
        if (logPath) shell.logPath = logPath;
        bgShells.set(id, shell);
        r.events.push(shell);
      }
    }
    if (!tr || typeof tr !== 'object') return;
    // Launching a background Agent holds the turn; see the header.
    if (tr.isAsync) {
      const block = content.find((b) => b && b.type === 'tool_result');
      const id = str(tr.agentId) || (block && str(block.tool_use_id));
      if (id) liveAgents.add(id);
    }
    // SendMessage to a finished agent RESUMES it: it runs in the background again,
    // as a child of this CLI, and reports back through a task_notification under
    // its old task_id exactly as a launch does. Reaping the turn on its result
    // would kill it mid-run (bugs.md B45).
    if (str(tr.resumedAgentId)) liveAgents.add(str(tr.resumedAgentId));
    // TaskStop naming a shell it stopped.
    if (tr.task_id && tr.task_type === 'local_bash') {
      if (bgShells.delete(tr.task_id)) r.events.push({ type: 'shell.stopped', shellId: tr.task_id });
      return;
    }
    if (!tr.backgroundTaskId) return;
    // A background shell announces its command in the tool_use and its id and log
    // path in the result, so the two are paired here.
    const block = content.find((b) => b && b.type === 'tool_result' && bgPendingStarts.has(b.tool_use_id));
    const start = block ? bgPendingStarts.get(block.tool_use_id) : null;
    if (block) bgPendingStarts.delete(block.tool_use_id);
    const text = block && typeof block.content === 'string' ? block.content : '';
    const shell = { type: 'shell.started', shellId: String(tr.backgroundTaskId), command: (start && start.command) || '' };
    if (start && start.description) shell.description = start.description;
    const logPath = (BG_LOG_RE.exec(text) || [])[1];
    if (logPath) shell.logPath = logPath;
    bgShells.set(shell.shellId, shell);
    r.events.push(shell);
  }

  function onResult(m, r) {
    // Whichever turn this result closes, it is not waiting on a tool any more.
    agentCalls.clear();
    if (num(m.total_cost_usd) !== null) processCost = Math.max(processCost, m.total_cost_usd);
    const ours = !(m.origin && m.origin.kind);
    if (ours && owed > 0) owed -= 1;
    if (queued > 0) queued -= 1;
    lastSeen = m;
    suggestionSeen = false;
    // The engine will say idle once this was the last result anyone is owed.
    if (engineReportsState) { if (!owed) lastResult = m; return r; }
    // Not ours, while one of ours is owed: a turn the CLI dequeued by itself.
    // Measured live on 2.1.283: such a turn closes on
    // `origin: {kind: 'task-notification'}` and nothing after it.
    if (!ours && owed > 0) return r;
    // A steer's first result frame is the turn it closed; its own is still coming.
    if (owed > 0) return r;
    lastResult = m;
    if (liveAgents.size) { r.holding = true; return r; }
    // The CLI suppresses a follow-up suggestion on the first turn, in plan mode and
    // after a failure, so only the other cases are worth holding the reap for.
    awaitingSuggestion = resumed && permissionMode !== 'plan' && m.subtype === 'success';
    return finishFrom(m, r);
  }

  function frame(m) {
    const r = out();
    if (!m || typeof m !== 'object') return r;
    if (m.type === 'system' && m.subtype === 'init') {
      const newId = str(m.session_id);
      if (newId && newId !== sid) {
        sid = newId;
        const bound = { type: 'session.bound', sessionId: newId };
        if (str(m.cwd)) bound.cwd = m.cwd;
        r.events.push(bound);
      }
      const info = { type: 'session.info' };
      if (str(m.cwd)) info.cwd = m.cwd;
      if (str(m.model)) info.model = m.model;
      if (str(m.permissionMode)) info.permissionMode = m.permissionMode;
      if (Array.isArray(m.slash_commands)) info.slashCommands = m.slash_commands;
      if (Array.isArray(m.mcp_servers)) info.mcpServers = m.mcp_servers;
      r.events.push(info, { type: 'run.status', status: 'running' });
    } else if (m.type === 'stream_event' && m.event) {
      onStream(m.event, r);
    } else if (m.type === 'assistant' && m.message) {
      if (m.message.usage) tally = addUsage(tally, m.message.usage);
      for (const b of m.message.content || []) {
        if (!b || b.type !== 'tool_use') continue;
        if (b.name === 'Bash' && b.input && b.input.run_in_background && b.id) {
          bgPendingStarts.set(b.id, { command: String(b.input.command || ''), description: str(b.input.description) });
        }
        // A sub-agent's own calls carry its parent's id; only the turn's own count.
        if ((b.name === 'Agent' || b.name === 'Task') && b.id && !m.parent_tool_use_id && !(b.input && b.input.run_in_background)) {
          agentCalls.add(b.id);
        }
        if (str(b.id)) openCalls.set(b.id, String(b.name || 'tool'));
        const e = { type: 'tool.started', toolCallId: str(b.id) || `t${++messageSeq}`, toolName: String(b.name || 'tool') };
        if (b.input !== undefined) e.input = b.input;
        r.events.push(e);
      }
    } else if (m.type === 'user' && m.message && Array.isArray(m.message.content)) {
      onUser(m, r);
    } else if (m.type === 'system' && m.subtype === 'status') {
      if (m.status === 'compacting') {
        r.events.push({ type: 'compaction', phase: 'running' }, { type: 'run.status', status: 'compacting' });
      } else if (m.compact_result) {
        const e = { type: 'compaction', phase: 'end', result: m.compact_result };
        if (str(m.compact_error)) e.error = m.compact_error;
        r.events.push(e, { type: 'run.status', status: 'running' });
      }
    } else if (m.type === 'rate_limit_event' && m.rate_limit_info && typeof m.rate_limit_info === 'object') {
      r.events.push({ type: 'limit.updated', info: m.rate_limit_info });
    } else if (m.type === 'tool_progress') {
      if (str(m.tool_use_id)) {
        const e = { type: 'tool.progress', toolCallId: m.tool_use_id };
        if (str(m.tool_name)) e.toolName = m.tool_name;
        if (str(m.parent_tool_use_id)) e.parentToolCallId = m.parent_tool_use_id;
        if (str(m.task_id)) e.taskId = m.task_id;
        if (num(m.elapsed_time_seconds) !== null) e.elapsedMs = Math.round(m.elapsed_time_seconds * 1000);
        r.events.push(e);
      }
    } else if (m.type === 'system' && TASK_SUBTYPES.has(m.subtype)) {
      const status = str(m.status) || str(m.patch && m.patch.status);
      if (status && TASK_TERMINAL.has(status)) {
        const id = str(m.task_id);
        const toolId = str(m.tool_use_id);
        if (id) liveAgents.delete(id);
        if (toolId) liveAgents.delete(toolId);
        // The only frame that says a background shell ended while the turn runs.
        if (id && bgShells.delete(id)) {
          if (!ended) shellEnded = true;
          r.events.push({ type: 'shell.stopped', shellId: id, status });
        }
      }
      r.events.push({ type: 'task.updated', subtype: m.subtype, detail: m });
    } else if (m.type === 'system' && m.subtype === 'api_retry') {
      r.events.push({ type: 'notice', level: 'warn', code: 'api_retry', message: retryMessage(m), detail: m });
    } else if (m.type === 'tool_use_summary') {
      r.events.push({ type: 'tool.summary', detail: m });
    } else if (m.type === 'system' && HOOK_SUBTYPES.has(m.subtype)) {
      r.events.push({ type: 'hook.updated', detail: m });
    } else if (m.type === 'system' && m.subtype === 'memory_recall') {
      r.events.push({ type: 'memory.recalled', detail: m });
    } else if (m.type === 'system' && m.subtype === 'files_persisted') {
      r.events.push({ type: 'files.persisted', detail: m });
    } else if (m.type === 'system' && m.subtype === 'session_state_changed' && str(m.state)) {
      r.events.push({ type: 'engine.state', state: m.state });
      engineReportsState = true;
      stateGen += 1;
      if (m.state === 'idle' && !ended && lastSeen) {
        if (owed > 0) r.confirmIdle = stateGen;
        else endOnIdle(r);
      }
    } else if (m.type === 'control_response' && m.response) {
      const resp = m.response;
      const ok = resp.subtype === 'success';
      r.control = { requestId: resp.request_id, ok, response: ok ? resp.response ?? null : null };
    } else if (m.type === 'control_request' && m.request && m.request.subtype === 'can_use_tool') {
      approvals.set(m.request_id, m.request.input);
      // Which tool call this asks about. The CLI names it on newer builds; on
      // older ones, and only for the two interactive tools (which always ask,
      // and one at a time), it is the earliest unanswered call of that tool
      // this turn not already claimed. Guessing for Bash would be wrong: a
      // parallel call a rule allowed never asks, and its result would withdraw
      // a sibling's live card.
      let toolUseId = str(m.request.tool_use_id) ? m.request.tool_use_id : null;
      if (!toolUseId && (m.request.tool_name === 'ExitPlanMode' || m.request.tool_name === 'AskUserQuestion')) {
        const claimed = new Set(approvalTools.values());
        for (const [id, name] of openCalls) {
          if (name === m.request.tool_name && !claimed.has(id)) { toolUseId = id; break; }
        }
      }
      if (toolUseId) approvalTools.set(m.request_id, toolUseId);
      const e = { type: 'approval.requested', requestId: String(m.request_id), toolName: String(m.request.tool_name || 'tool') };
      // The call it asks about, so the master can file the answer against the
      // row (a plan's approved mode, features/02 3.6b).
      if (toolUseId) e.toolUseId = toolUseId;
      if (m.request.input !== undefined) e.input = m.request.input;
      if (Array.isArray(m.request.permission_suggestions)) e.suggestions = m.request.permission_suggestions;
      r.events.push(e, { type: 'run.status', status: 'awaiting-permission' });
    } else if (m.type === 'control_cancel_request' && m.request_id) {
      // The CLI withdrew a permission request it had asked us. It does this when
      // a PermissionRequest hook in the user's own settings answered first: the
      // tool has already run (or been refused), so the card waiting in the
      // browser is a question nobody is asking any more. Unanswered here, it
      // sat live until the turn ended and a click on it did nothing.
      withdraw(m.request_id, r);
    } else if (m.type === 'control_request' && m.request_id) {
      // Anything else the CLI asks its host is answered at once: it sets no deadline
      // of its own, so an unanswered request is a hung turn. `cancel` is the CLI's own
      // answer to an MCP elicitation when no host can ask.
      const subtype = m.request && m.request.subtype;
      r.writes.push({
        type: 'control_response',
        response: subtype === 'elicitation'
          ? { subtype: 'success', request_id: m.request_id, response: { action: 'cancel' } }
          : { subtype: 'error', request_id: m.request_id, error: `Unsupported control request subtype: ${subtype}` },
      });
    } else if (m.type === 'result') {
      onResult(m, r);
    } else if (m.type === 'prompt_suggestion' && str(m.suggestion)) {
      awaitingSuggestion = false;
      suggestionSeen = true;
      r.events.push({ type: 'suggestion', text: m.suggestion });
    }
    return r;
  }

  // decision: { behavior: 'allow', updatedInput?, updatedPermissions? } | { behavior: 'deny', message? }
  // outcome overrides the recorded outcome for a deny that was not the user's
  // choice (a timeout, the run ending).
  function answer(requestId, decision, outcome = null) {
    const r = out();
    if (!approvals.has(requestId)) return r;
    const input = approvals.get(requestId);
    approvals.delete(requestId);
    approvalTools.delete(requestId);
    const allow = decision && decision.behavior === 'allow';
    const response = allow
      ? { behavior: 'allow', updatedInput: decision.updatedInput || input, ...(decision.updatedPermissions ? { updatedPermissions: decision.updatedPermissions } : {}) }
      : { behavior: 'deny', message: (decision && decision.message) || 'denied' };
    r.writes.push({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    r.events.push({ type: 'approval.resolved', requestId: String(requestId), outcome: outcome || (allow ? 'allow' : 'deny') });
    if (!approvals.size && !ended) r.events.push({ type: 'run.status', status: 'running' });
    return r;
  }

  function settlePending(outcome, r) {
    approvalTools.clear();
    for (const id of [...approvals.keys()]) {
      approvals.delete(id);
      r.events.push({ type: 'approval.resolved', requestId: String(id), outcome });
    }
  }

  // The engine is idle: nothing running, nothing queued, no background Agent left.
  // That is the end of the turn, whatever our own counting says.
  function endOnIdle(r) {
    owed = 0;
    queued = 0;
    liveAgents.clear();
    agentCalls.clear();
    openCalls.clear();
    lastResult = lastSeen;
    awaitingSuggestion = resumed && permissionMode !== 'plan' && lastSeen.subtype === 'success' && !suggestionSeen;
    return finishFrom(lastSeen, r);
  }

  function idleConfirmed(gen) {
    const r = out();
    if (ended || gen !== stateGen || !lastSeen) return r;
    return endOnIdle(r);
  }

  function expire() {
    const r = out();
    if (ended) return r;
    liveAgents.clear();
    owed = 0;
    queued = 0;
    settlePending('run-ended', r);
    // A steer's own result never came: the one that closed the turn it cut into
    // is still the answer the user saw.
    return finishFrom(lastResult || lastSeen, r);
  }

  // A CLI that dies after its result frame still completed the turn: report the
  // result held, not the exit. lastResult is only set by a frame that could end a
  // turn, so this cannot mask a genuinely interrupted one.
  function exit({ code = null, error = null } = {}) {
    const r = out();
    settlePending('run-ended', r);
    if (ended) return r;
    if (lastResult) return finishFrom(lastResult, r);
    ended = true;
    r.ended = true;
    const e = { type: 'run.finished', status: aborted ? 'aborted' : 'error' };
    if (!aborted) e.error = str(error) || `claude exited${code !== null ? ` with code ${code}` : ''} before finishing the turn`;
    r.events.push(e);
    return r;
  }

  return {
    frame,
    answer,
    expire,
    exit,
    idleConfirmed,
    steer() { owed += 1; queued += 1; },
    abort() { aborted = true; },
    get sessionId() { return sid; },
    get ended() { return ended; },
    get awaitingSuggestion() { return awaitingSuggestion; },
    get liveAgents() { return liveAgents.size; },
    get agentCallsInFlight() { return agentCalls.size; },
    // A steer is written but the CLI has not started it. An interrupt now closes
    // the running turn and the CLI then takes the queued message up as its next
    // turn: the stopped chat goes on running what the user just took back (bugs.md
    // B13). The driver kills the CLI instead of interrupting it (engine-runs.js).
    get steerPending() { return !ended && queued > 0; },
    get shellEndedDuringTurn() { return shellEnded; },
    // The process's running total, for the next turn's priorCostUsd.
    get processCostUsd() { return processCost; },
    liveShells: () => [...bgShells.values()],
    pendingApprovals: () => [...approvals.keys()],
  };
}

// What Claude can do is declared with the other engines in lib/engine-capabilities.js.

module.exports = { createClaudeTranslator, blockKindOf, turnStarting };
