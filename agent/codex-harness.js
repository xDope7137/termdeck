'use strict';

// The native Codex harness, agent side (docs/codex-native.md): ONE shared
// `codex app-server` per machine, as Codex Desktop runs it, spoken to through
// lib/codex-rpc.js, with lib/codex-turn.js following each turn. Everything Codex
// says about a run's thread leaves as Codex's own notifications (codex.event) and
// the master draws Codex's model; nothing on this path is shaped like Claude.
//
// What lives here, and why it cannot live in the pure follower:
//
//   * thread routing. The server holds every thread on the machine. A run owns the
//     thread it is a turn on, and every SUB-AGENT thread working for it: a worker
//     is a thread of its own, and the server names its parent on thread/started
//     (thread.parentThreadId), on the parent's collabAgentToolCall item
//     (receiverThreadIds), on 0.160's subAgentActivity item, or, for a worker
//     whose spawn this agent never saw (it started before an agent restart), only
//     in its own record, which thread/read is asked for once before its request is
//     refused. Workers can spawn workers, so the owner is found by walking up.
//   * the turn driver: thread/resume or thread/start, then turn/start, or
//     thread/compact/start for /compact, or review/start for /review; the Modes
//     table; the start-ack grace; Stop before there is a turn id to stop.
//   * the processes. Stop on a shared server ends the TURN, and the server lets the
//     command it was running carry on (it is a child of the server, not of the
//     turn), so those are killed by the command lines the engine reported.
//   * the `codex` capability ops and the `codexWatch` stream: one app-server call
//     each, params whitelisted, results passed through.
//
// Ships flat to agents (AGENT_FILES in master.js), so it requires siblings only.
// Module-agnostic about the run registry: agent/engine-runs.js owns runs, their
// sequenced logs and subscribers, and hands each start a sink to emit into.

const { createCodexClient, spawnCodexAppServer, threadIdOf } = require('./codex-rpc');
const { createCodexTurn, CARDS } = require('./codex-turn');

let AGENT_VERSION = '0.0.0';
try { AGENT_VERSION = require('./package.json').version; } catch {}

const DEFAULTS = {
  // A JSON-RPC call's budget, and thread/resume's, which re-reads the whole rollout
  // (a 124 MB one was measured) and so gets a work budget, not a call one.
  rpcMs: 30_000,
  resumeMs: 5 * 60 * 1000,
  injectMs: 3000, // a stopped turn's partial reply (keepPartial)
  // turn/start's ack timed out: how long turn/started still has to show up before
  // the run is declared dead. A late ack says nothing about whether the turn runs.
  startGraceMs: 30_000,
  // recycle: how long the outgoing server gets to deliver its interrupts.
  recycleKillMs: 500,
  // Sub-agent threads remembered per server, oldest forgotten first.
  parentsMax: 2000,
  // thread/list paging for listThreads().
  listPageSize: 100,
  listMax: 2000,
};

// default_mode_request_user_input is gated off by default; without it the model's
// request_user_input tool errors instead of asking.
const CONFIG = { 'features.default_mode_request_user_input': true };

// docs/codex-native.md, Modes. The policy is per turn, so a switch reaches Codex on
// the next turn/start; there is no mid-turn auto-allow.
const MODES = {
  'read-only': { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' }, plan: false },
  plan: { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' }, plan: true },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' }, plan: false },
  'full-access': { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, plan: false },
};

// What codexWatch carries: the server's news that is about no run.
const WATCH_METHODS = new Set([
  'thread/started', 'thread/status/changed', 'thread/name/updated', 'thread/archived', 'thread/unarchived',
  'thread/deleted', 'account/updated', 'account/rateLimits/updated', 'skills/changed', 'mcpServer/startupStatus/updated',
]);

// Every source kind, for listThreads: thread/list defaults to the interactive ones,
// and the session index has always listed exec runs and sub-agents too (a worker
// row is how the sidebar keeps it off the list, lib/index-head.js subagentOf).
const ALL_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];

// config/read is the whole of ~/.codex/config.toml, MCP server env values and
// bearer tokens included. The master asks it for the one field a turn with no
// effort runs at (lib/codex-settings.js configuredEffort), so that field is all
// that leaves this machine, as on the legacy harness (agent/engine-runs.js
// codexRpcResult).
function effortOnly(result) {
  const c = result && result.config;
  return { config: c && c.model_reasoning_effort != null ? { model_reasoning_effort: c.model_reasoning_effort } : {} };
}

// The `codex` capability (docs/codex-native.md): one op, one app-server call, and
// only the listed params cross. `fixed` is set whatever the master sent. `null`
// params: the method takes none at all. `result`, when set, is what of the
// answer may leave the machine.
const OPS = {
  threads: { method: 'thread/list', params: ['cursor', 'limit', 'sortKey', 'sortDirection', 'cwd', 'archived', 'searchTerm', 'sourceKinds', 'useStateDbOnly', 'parentThreadId'] },
  // excludeTurns in the design; the read's own spelling is includeTurns.
  thread: { method: 'thread/read', params: ['threadId'], fixed: { includeTurns: false }, need: ['threadId'] },
  // itemsView over the design's list: a turn page defaults to the summary view
  // (user and agent messages only), and the SPA draws every item.
  turns: { method: 'thread/turns/list', params: ['threadId', 'cursor', 'limit', 'sortDirection', 'itemsView'], need: ['threadId'] },
  items: { method: 'thread/items/list', params: ['threadId', 'turnId', 'cursor', 'limit'], need: ['threadId'] },
  rename: { method: 'thread/name/set', params: ['threadId', 'name'], need: ['threadId', 'name'] },
  fork: { method: 'thread/fork', params: ['threadId', 'lastTurnId'], fixed: { excludeTurns: true }, need: ['threadId'] },
  revert: { method: 'thread/revert', params: ['threadId', 'beforeTurnId'], need: ['threadId', 'beforeTurnId'] },
  archive: { method: 'thread/archive', params: ['threadId'], need: ['threadId'] },
  unarchive: { method: 'thread/unarchive', params: ['threadId'], need: ['threadId'] },
  models: { method: 'model/list', params: [] },
  mcpStatus: { method: 'mcpServerStatus/list', params: [] },
  skills: { method: 'skills/list', params: ['cwds'] },
  rateLimits: { method: 'account/rateLimits/read', params: null },
  account: { method: 'account/read', params: [] },
  config: { method: 'config/read', params: [], result: effortOnly },
};
const OP_NAMES = [...Object.keys(OPS), 'info'];

const refuse = (message, code) => Object.assign(new Error(message), { code });
const isActiveWriterRefusal = (err) => /active writer/i.test(String((err && (err.message || err)) || ''));
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

function opParams(row, payload) {
  if (row.params === null) return undefined;
  const p = payload && typeof payload === 'object' ? payload : {};
  const out = {};
  for (const k of row.params) if (p[k] !== undefined) out[k] = p[k];
  for (const k of row.need || []) {
    if (typeof out[k] !== 'string' || !out[k]) throw refuse(`codex ${row.method} needs ${k}`, 'BAD_RUN');
  }
  if (out.cwds !== undefined && !(Array.isArray(out.cwds) && out.cwds.every((c) => typeof c === 'string'))) throw refuse('codex skills/list cwds must be strings', 'BAD_RUN');
  return { ...out, ...(row.fixed || {}) };
}

// A worker's parent, off its own record: parentThreadId, or the thread_spawn its
// source names (`subagent` in the protocol, `subAgent` in some older rollouts).
function parentOf(thread) {
  const t = thread || {};
  const src = t.source && typeof t.source === 'object' ? (t.source.subagent || t.source.subAgent) : null;
  const spawn = src && typeof src === 'object' ? src.thread_spawn : null;
  return {
    parent: t.parentThreadId || (spawn && spawn.parent_thread_id) || null,
    meta: { nickname: t.agentNickname || (spawn && spawn.agent_nickname) || null, role: t.agentRole || (spawn && spawn.agent_role) || null, agentPath: (spawn && spawn.agent_path) || null },
  };
}

// opts: { spawn, kill(child, signal), reapCommands(pid, commands, { others }), timers, ...DEFAULTS }
function createCodexHarness(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const spawnFn = cfg.spawn || require('child_process').spawn;
  const kill = cfg.kill || ((child, signal) => { try { child.kill(signal); } catch {} });
  const reapCommands = cfg.reapCommands || null;
  const timers = cfg.timers || { setTimeout, clearTimeout };
  const timer = (fn, ms) => {
    const t = timers.setTimeout(fn, ms);
    if (t && t.unref) t.unref();
    return t;
  };

  let server = null;         // the current shared server
  const runs = new Set();    // live runs, on whichever server they started on
  const watchers = new Set(); // codexWatch subscribers: WATCH_METHODS only
  const listeners = new Set(); // onNotification subscribers: everything no run owns
  let defaultSpec = typeof cfg.defaultSpec === 'function' ? cfg.defaultSpec : null; // useSpec()

  function spawnServer(spec) {
    if (!spec || !spec.exe) throw refuse('codex is not installed on this machine', 'BAD_ENGINE');
    let spawned;
    try {
      spawned = spawnCodexAppServer(spec.exe, { env: spec.env || process.env, config: CONFIG, spawnFn });
    } catch (e) {
      throw refuse(e.message, 'SPAWN_FAILED');
    }
    const client = createCodexClient({ transport: spawned.transport, clientInfo: { name: 'termdeck', version: AGENT_VERSION }, timeoutMs: cfg.rpcMs, timers });
    const srv = {
      child: spawned.child,
      transport: spawned.transport,
      client,
      pid: spawned.child.pid ?? null,
      exited: false,
      retiring: false,
      threads: new Map(), // threadId -> the run serving that thread's current turn
      parents: new Map(), // sub-agent threadId -> the thread that spawned it
      meta: new Map(),    // sub-agent threadId -> { nickname, role, agentPath }
      read: new Set(),    // sub-agent threads already looked up by thread/read
      collab: new Set(),  // threads this server left in the plan collaboration mode
    };
    client.onNotification((method, params) => route(srv, method, params));
    client.onRequest((id, method, params) => routeRequest(srv, id, method, params, false));
    client.onClose((why) => gone(srv, why));
    client.start().catch(() => {}); // a refusal (too old) surfaces on the first request
    return srv;
  }

  function ensureServer(spec) {
    if (server && !server.exited && !server.retiring) return server;
    server = spawnServer(spec);
    return server;
  }

  /* ---------------- routing ---------------- */

  function ownerOf(srv, threadId) {
    let id = threadId;
    for (let depth = 0; depth < 16 && id; depth++) {
      const run = srv.threads.get(id);
      if (run) return run.finished ? null : run;
      id = srv.parents.get(id);
    }
    return null;
  }

  // `meta` when the link came with the worker's record (thread/started); without
  // it the record is read once, for the name its card says it by.
  function link(srv, child, parent, meta = null) {
    if (!child || !parent || child === parent || typeof child !== 'string' || typeof parent !== 'string') return;
    srv.parents.delete(child);
    srv.parents.set(child, parent);
    while (srv.parents.size > cfg.parentsMax) srv.parents.delete(srv.parents.keys().next().value);
    if (meta) {
      srv.meta.set(child, meta);
      srv.read.add(child);
    }
    const run = ownerOf(srv, child);
    if (!run) return;
    if (srv.meta.has(child)) run.turn.subagentMeta(child, srv.meta.get(child));
    if (srv.read.has(child)) return;
    srv.read.add(child);
    srv.client.request('thread/read', { threadId: child, includeTurns: false }, { timeoutMs: cfg.rpcMs })
      .then((res) => {
        const m = { ...(srv.meta.get(child) || {}), ...clean(parentOf(res && res.thread).meta) };
        srv.meta.set(child, m);
        const owner = ownerOf(srv, child);
        if (owner) owner.turn.subagentMeta(child, m);
      })
      .catch(() => {});
  }

  function learn(srv, method, params, threadId) {
    if (method === 'thread/started' && params.thread && params.thread.parentThreadId) {
      link(srv, params.thread.id, params.thread.parentThreadId, parentOf(params.thread).meta);
    }
    const item = params.item;
    if (!item || typeof item !== 'object') return;
    if (item.type === 'collabAgentToolCall' && Array.isArray(item.receiverThreadIds)) {
      for (const r of item.receiverThreadIds) link(srv, r, item.senderThreadId || threadId);
    } else if (item.type === 'subAgentActivity' && typeof item.agentThreadId === 'string' && item.agentThreadId) {
      // The path names the task, not the worker; its nickname is still read once.
      if (item.agentPath) srv.meta.set(item.agentThreadId, { ...(srv.meta.get(item.agentThreadId) || {}), agentPath: item.agentPath });
      link(srv, item.agentThreadId, threadId);
    }
  }

  function route(srv, method, params) {
    const p = params || {};
    const threadId = threadIdOf(p);
    learn(srv, method, p, threadId);
    const run = threadId ? ownerOf(srv, threadId) : null;
    if (!run) {
      // A retiring server's news is about the login it was started on, which a
      // recycle just replaced: an account/updated from it would be the old account.
      if (srv.retiring) return;
      if (WATCH_METHODS.has(method)) {
        for (const fn of watchers) { try { fn(method, p); } catch {} }
      }
      for (const fn of listeners) { try { fn(method, p); } catch {} }
      return;
    }
    const item = p.item;
    if (item && item.type === 'commandExecution' && item.id) {
      // A unified exec keeps its item open until the process exits, past the call
      // that started it, so this tracks the process.
      if (method === 'item/started') noteExec(run, item.id, item.command);
      else if (method === 'item/completed') run.execs.delete(item.id);
    }
    const ownTurn = threadId === run.threadId;
    if (ownTurn && method === 'turn/completed' && !run.partialKept && keepPartial(srv, run, p)) return;
    apply(run, run.turn.notification(method, p));
    if (ownTurn && method === 'turn/started') {
      timers.clearTimeout(run.timers.startAck);
      // Stop landed before there was a turn id to interrupt. Now there is.
      if (run.abortRequested) interrupt(run);
    }
  }

  function routeRequest(srv, id, method, params, retried) {
    if (!CARDS[method]) return false; // codex-rpc refuses it: nobody here answers it
    const p = params || {};
    const threadId = threadIdOf(p);
    const run = threadId ? ownerOf(srv, threadId) : null;
    if (!run) {
      if (threadId && !retried) {
        // A worker whose spawn this agent never saw: ask the server whose it is
        // before refusing it.
        adopt(srv, threadId).then(() => routeRequest(srv, id, method, p, true));
        return true;
      }
      srv.client.respondError(id, { code: -32000, message: 'No active Termdeck run for this thread' });
      return true;
    }
    if (method === 'item/commandExecution/requestApproval' && p.itemId) noteExec(run, p.itemId, p.command);
    apply(run, run.turn.request(id, method, p));
    return true;
  }

  function adopt(srv, threadId) {
    return srv.client.request('thread/read', { threadId, includeTurns: false }, { timeoutMs: cfg.rpcMs })
      .then((res) => {
        const { parent, meta } = parentOf(res && res.thread);
        link(srv, threadId, parent, meta);
      })
      .catch(() => {});
  }

  // A stopped turn's half-written reply. Codex writes an agentMessage to the
  // rollout only when the item completes, and an interrupted one never does, so
  // the words the user watched arrive vanished on the next history read and never
  // came back (QA 2026-10-08, 5.1). thread/inject_items appends them to the
  // thread's history the way Codex writes everything else, so the rollout stays
  // the one source and the model sees what it had said. The turn's end waits for
  // the answer, briefly, so the next turn cannot start in between.
  function keepPartial(srv, run, params) {
    run.partialKept = true;
    const turn = params.turn || {};
    if (!(run.abortRequested || turn.status === 'interrupted') || !run.threadId) return false;
    const text = run.turn.unfinishedText();
    if (!text) return false;
    srv.client.request('thread/inject_items', {
      threadId: run.threadId,
      items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    }, { timeoutMs: cfg.injectMs }).catch(() => {}).then(() => route(srv, 'turn/completed', params));
    return true;
  }

  function gone(srv, why) {
    if (srv.exited) return;
    srv.exited = true;
    if (server === srv) server = null;
    for (const fn of srv.onExit || []) { try { fn(); } catch {} }
    const error = (why && why.error) || 'codex app-server exited';
    for (const run of [...runs]) if (run.server === srv && !run.finished) apply(run, run.turn.exit({ error }));
  }

  /* ---------------- runs ---------------- */

  function write(srv, reply) {
    if (srv.exited) return;
    if (reply.error) srv.client.respondError(reply.id, reply.error);
    else srv.client.respond(reply.id, reply.result);
  }

  function apply(run, r) {
    for (const reply of r.replies) write(run.server, reply);
    if (r.events.length) run.sink.emit(r.events);
    if (r.ended) finish(run);
  }

  function finish(run) {
    if (run.finished) return;
    run.finished = true;
    timers.clearTimeout(run.timers.startAck);
    if (run.threadId && run.server.threads.get(run.threadId) === run) run.server.threads.delete(run.threadId);
    runs.delete(run);
    try { run.sink.finished(); } catch {}
  }

  function failRun(run, message, detail = null) {
    if (run.finished) return;
    apply(run, run.turn.fail(message, detail));
  }

  // One item can carry more than one command line: its approval and its start, or
  // the several approvals of a zsh-exec-bridge item. Keep every one of them.
  function noteExec(run, id, command) {
    if (!id || !command) return;
    const line = Array.isArray(command) ? command.join(' ') : String(command);
    const list = run.execs.get(id) || [];
    if (!list.includes(line)) list.push(line);
    run.execs.set(id, list);
  }

  // Taken before the interrupt goes out: the server's own item/completed for the
  // exec would otherwise empty the list first. Other runs on the same server pass
  // what they have in flight as `others`, so the same script running in two chats
  // is left alone rather than killed in both. See proc-tree.js reapCommands.
  function reapExecs(run) {
    if (!reapCommands || !run.execs.size) return;
    const pid = run.server.pid;
    if (!Number.isFinite(pid)) return;
    const commands = [...run.execs.values()].flat();
    run.execs.clear();
    const others = [];
    for (const r of runs) if (r !== run && r.server === run.server && !r.finished) others.push(...[...r.execs.values()].flat());
    Promise.resolve().then(() => reapCommands(pid, commands, { others })).catch(() => {});
  }

  function modeOf(spec) {
    const m = MODES[spec.permissionMode] || null;
    const th = spec.thread && typeof spec.thread === 'object' ? spec.thread : {};
    const tu = spec.turn && typeof spec.turn === 'object' ? spec.turn : {};
    return {
      approvalPolicy: m ? m.approvalPolicy : (tu.approvalPolicy ?? th.approvalPolicy ?? null),
      sandbox: m ? m.sandbox : (th.sandbox ?? null),
      sandboxPolicy: m ? m.sandboxPolicy : (tu.sandboxPolicy ?? null),
      plan: (m ? m.plan : false) || spec.collab === 'plan',
    };
  }

  // spec: { exe, env, sessionId (a thread id, or null for a new chat), cwd,
  //   content (the turn's UserInput array), permissionMode (a Modes row), model,
  //   effort, turn ({ model, effort, summary } and, without a known mode,
  //   approvalPolicy / sandboxPolicy), thread ({ approvalPolicy, sandbox }),
  //   collab ('plan'), compact (true: /compact), review (true or { target }: /review) }
  // sink: { emit(events), finished() }
  function start(spec, sink) {
    const content = spec && spec.content;
    const sessionId = typeof spec.sessionId === 'string' && spec.sessionId ? spec.sessionId : null;
    const special = !!(spec.compact || spec.review);
    if (!special && (!Array.isArray(content) || !content.length)) throw refuse('a run needs message content', 'BAD_RUN');
    if (special && !sessionId) throw refuse(spec.compact ? 'a new chat has nothing to compact' : 'a new chat has nothing to review', 'BAD_RUN');
    if (sessionId && server && !server.exited && !server.retiring) {
      const busy = server.threads.get(sessionId);
      if (busy && !busy.finished) throw refuse('A turn is already running for this session', 'BUSY');
    }
    const srv = ensureServer(spec);
    const run = {
      server: srv,
      sink,
      threadId: sessionId,
      turn: createCodexTurn({ threadId: sessionId }),
      execs: new Map(), // itemId -> command lines of an exec in flight (noteExec, reapExecs)
      abortRequested: false,
      partialKept: false,
      finished: false,
      timers: { startAck: null },
    };
    runs.add(run);
    // Claimed at once, so a second start on the same thread is refused while this
    // one is still resuming.
    if (sessionId) srv.threads.set(sessionId, run);
    prepare(run, spec).catch((e) => failRun(run, (e && e.message) || 'Codex could not start the turn', e && e.code ? { code: e.code } : null));
    return handle(run);
  }

  async function prepare(run, spec) {
    const srv = run.server;
    const cwd = typeof spec.cwd === 'string' && spec.cwd ? spec.cwd : null;
    const mode = modeOf(spec);
    const tu = spec.turn && typeof spec.turn === 'object' ? spec.turn : {};
    try {
      await srv.client.start();
    } catch (e) {
      return failRun(run, (e && e.message) || 'codex app-server did not start', { code: (e && e.code) || 'CODEX_DOWN' });
    }
    let threadId = run.threadId;
    let threadModel = null;
    let transcriptPath = null;
    let collabNow = null;
    if (threadId) {
      // Resume EVERY turn, not only the first: it re-reads the rollout, so turns a
      // terminal appended in between are picked up. excludeTurns: the history is
      // read page by page (thread/turns/list), never as the resume's answer.
      let res;
      try {
        res = await srv.client.request('thread/resume', clean({ threadId, cwd, approvalPolicy: mode.approvalPolicy, sandbox: mode.sandbox, excludeTurns: true }), { timeoutMs: cfg.resumeMs });
      } catch (e) {
        if (isActiveWriterRefusal(e)) return failRun(run, 'Another Codex client is writing this chat. It unlocks when that turn ends.', { code: 'SESSION_ATTACHED' });
        throw e;
      }
      threadModel = (res && res.model) || null;
      transcriptPath = (res && res.thread && res.thread.path) || null;
      collabNow = res && res.collaborationMode && res.collaborationMode.mode;
    } else {
      const res = await srv.client.request('thread/start', clean({ cwd, approvalPolicy: mode.approvalPolicy, sandbox: mode.sandbox }));
      const thread = (res && res.thread) || {};
      if (!thread.id) return failRun(run, 'thread/start returned no thread id', { code: 'CODEX_RPC' });
      threadId = thread.id;
      transcriptPath = thread.path || null;
      threadModel = (res && res.model) || null;
      run.threadId = threadId;
      if (run.finished) return undefined;
      srv.threads.set(threadId, run);
    }
    if (run.finished) return undefined;
    if (run.abortRequested) return failRun(run, 'Stopped before the turn began');

    apply(run, run.turn.bound(threadId, { cwd, transcriptPath }));
    const model = tu.model || spec.model || threadModel || null;
    if (model) run.sink.emit([{ type: 'session.info', model, ...(cwd ? { cwd } : {}) }]);

    // `/compact`: the app-server's own compaction, run as a turn of its own
    // (turn/started, a contextCompaction item, turn/completed).
    if (spec.compact) return send(run, 'thread/compact/start', { threadId }, 'compact');
    // `/review`: Codex's reviewer on the same thread, delivered inline.
    if (spec.review) {
      const target = spec.review && typeof spec.review === 'object' && spec.review.target && typeof spec.review.target === 'object'
        ? spec.review.target : { type: 'uncommittedChanges' };
      return send(run, 'review/start', { threadId, target, delivery: 'inline' }, 'review');
    }

    const params = clean({
      threadId,
      input: spec.content,
      approvalPolicy: mode.approvalPolicy,
      sandboxPolicy: mode.sandboxPolicy,
      model: tu.model || spec.model || undefined,
      effort: tu.effort || spec.effort || undefined,
      summary: tu.summary || 'auto',
      // The cwd again, on the turn. thread/resume's cwd does not move a thread this
      // shared server already has loaded, and turn/start's cwd is "this turn and
      // subsequent turns".
      cwd,
    });
    // Plan mode rides turn/start.collaborationMode (experimental, which the client
    // always opts into) and needs a model. The mode is STICKY on the thread, so
    // leaving plan resets it to default explicitly, or the next turn stays in plan
    // and the model will not act. thread/resume says which mode the thread is in.
    const settingsModel = params.model || threadModel;
    const settings = () => ({ model: settingsModel, reasoning_effort: params.effort || null, developer_instructions: null });
    if (mode.plan) {
      if (!settingsModel) return failRun(run, 'Codex plan mode requires a resolved model; pick a specific model and try again', { code: 'CODEX_PLAN_MODEL_REQUIRED' });
      params.collaborationMode = { mode: 'plan', settings: settings() };
      srv.collab.add(threadId);
    } else if ((collabNow === 'plan' || srv.collab.has(threadId)
      // The master keeps its own record of the plan turns it sent, which outlives
      // a recycled server (lib/cloud/codex-native-runner.js startFields).
      || (tu.collaborationMode && tu.collaborationMode.mode === 'default')) && settingsModel) {
      params.collaborationMode = { mode: 'default', settings: settings() };
      srv.collab.delete(threadId);
    }
    return send(run, 'turn/start', params, 'turn');
  }

  // The call that starts the turn, with the ack's two failure shapes: a refusal
  // ends the run, a timeout gives turn/started a window first (KNOWN-BUGS #22).
  async function send(run, method, params, what) {
    let res;
    try {
      res = await run.server.client.request(method, params);
    } catch (e) {
      if (run.finished) return undefined;
      if (e && e.code === 'CODEX_RPC_TIMEOUT' && !run.turn.turnId) {
        run.timers.startAck = timer(() => { if (!run.turn.turnId) failRun(run, e.message); }, cfg.startGraceMs);
        return undefined;
      }
      if (run.turn.turnId) return undefined;
      const why = (e && e.message) || `${method} failed`;
      if (what === 'compact' && /method not found|unknown (?:variant|method)/i.test(why)) return failRun(run, `This codex build cannot compact on request (${why}); update codex`);
      return failRun(run, why, { code: (e && e.code) || 'CODEX_RPC' });
    }
    if (run.finished) return undefined;
    apply(run, run.turn.acknowledged(res && res.turn));
    if (run.abortRequested && run.turn.turnId) interrupt(run);
    return undefined;
  }

  // turn/steer: a message into the running turn, refused while there is no turn id
  // yet. turn/steer carries no model or effort; the master checks those first.
  async function steer(run, content) {
    if (run.finished || run.server.exited) throw refuse('the turn is over', 'NO_RUN');
    if (!run.turn.turnId) throw refuse('Codex turn is not ready for steering yet', 'STEER_NOT_READY');
    if (!Array.isArray(content) || !content.length) throw refuse('a steer needs message content', 'BAD_RUN');
    try {
      await run.server.client.request('turn/steer', { threadId: run.threadId, expectedTurnId: run.turn.turnId, input: content });
    } catch (e) {
      throw refuse((e && e.message) || 'turn/steer failed', run.finished ? 'NO_RUN' : 'STEER_FAILED');
    }
  }

  // Stop: the turn, its live sub-agent turns, and the commands they left running.
  // The server stays; it serves other chats.
  function interrupt(run) {
    run.abortRequested = true;
    run.turn.abort();
    if (run.finished || run.server.exited) return;
    const turnId = run.turn.turnId;
    if (!turnId) return; // turn/started or the ack fires it, or prepare sees the flag first
    reapExecs(run);
    const req = (threadId, id) => run.server.client.request('turn/interrupt', { threadId, turnId: id }).catch(() => {});
    req(run.threadId, turnId);
    for (const [threadId, childTurn] of run.turn.subagentTurns()) req(threadId, childTurn);
  }

  function answer(run, requestId, decision) {
    if (run.finished) return;
    apply(run, run.turn.answer(String(requestId), decision));
  }

  // The face a run shows the registry.
  function handle(run) {
    return {
      get threadId() { return run.threadId; },
      get turnId() { return run.turn.turnId; },
      get pid() { return run.server.pid; },
      get exited() { return run.server.exited; },
      get finished() { return run.finished; },
      pendingApprovals: () => run.turn.pendingApprovals(),
      steer: (content) => steer(run, content),
      interrupt: () => interrupt(run),
      answer: (requestId, decision) => answer(run, requestId, decision),
    };
  }

  /* ---------------- outside any run ---------------- */

  // One call on the shared server, outside any turn. `spec` (exe, env) names the
  // codex to spawn if none is up; without one, the spec useSpec() registered, which
  // is how agent/limits.js, lib/codex-accounts.js and the Extensions page reach the
  // same server without knowing which binary it is.
  async function request(method, params, { timeoutMs = null } = {}, spec = null) {
    const use = spec || (defaultSpec ? defaultSpec() : null);
    const srv = ensureServer(use);
    return srv.client.request(method, params, timeoutMs ? { timeoutMs } : undefined);
  }

  // The `codex` capability: one whitelisted call, its result as Codex gave it.
  async function op(name, payload, spec, { timeoutMs = null } = {}) {
    if (name === 'info') return info(spec);
    const row = Object.prototype.hasOwnProperty.call(OPS, name) ? OPS[name] : null;
    if (!row) throw refuse(`codex has no op '${name}'`, 'BAD_RUN');
    const params = opParams(row, payload);
    const result = await request(row.method, params, { timeoutMs }, spec);
    if (row.result) return row.result(result);
    return result === undefined ? null : result;
  }

  async function info(spec) {
    const srv = ensureServer(spec);
    const i = await srv.client.start();
    const loadedThreads = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const res = await srv.client.request('thread/loaded/list', clean({ cursor, limit: 200 }));
      for (const id of (res && Array.isArray(res.data) ? res.data : [])) loadedThreads.push(id);
      cursor = res && res.nextCursor;
      if (!cursor) break;
    }
    return { pid: srv.pid, version: (i && i.version) || null, codexHome: (i && i.codexHome) || null, loadedThreads };
  }

  // Thread records for the session index (lib/session-index.js codexThreads),
  // newest first, every source kind, paged until `limit` or the end.
  async function listThreads({ limit = cfg.listMax, sortKey = 'updated_at', archived = false } = {}, spec) {
    const want = Math.max(1, Math.min(Number(limit) || cfg.listMax, cfg.listMax));
    const out = [];
    let cursor = null;
    for (let page = 0; page < 100 && out.length < want; page++) {
      const res = await request('thread/list', clean({ cursor, limit: Math.min(cfg.listPageSize, want - out.length), sortKey, archived, sourceKinds: ALL_SOURCE_KINDS }), {}, spec);
      const data = res && Array.isArray(res.data) ? res.data : [];
      out.push(...data);
      cursor = res && res.nextCursor;
      if (!cursor || !data.length) break;
    }
    return out.slice(0, want);
  }

  // codexWatch: fn(method, params) for the server's news that is about no run,
  // from this server and every one after it. Never spawns one: a watch with no
  // server running hears nothing until a run or an op starts it.
  function watch(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
  }

  // The same, unfiltered: every notification no run owns (account/login/completed
  // for a device-code sign-in, account/rateLimits/updated for the limits cache).
  // For the agent's own modules; the wire gets watch(), which is the list above.
  function onNotification(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // How request() spawns when its caller names no codex: () => { exe, env }.
  function useSpec(fn) {
    defaultSpec = typeof fn === 'function' ? fn : null;
  }

  // Drop the shared server so the next turn spawns one on whatever login is on disk
  // now (an account switch rewrote auth.json; a running app-server read the old one
  // when it started). Running turns are interrupted first, then it goes.
  //
  // A promise of whether there was one to drop, settled once the old process is
  // gone (or SIGKILLed past its grace): a server that is still alive can still
  // refresh the old login's tokens into the auth.json the switch just wrote, so a
  // caller that awaits this knows its next request is the fresh server's alone.
  // `server` is cleared at once, so nothing started meanwhile lands on the old one.
  function recycle() {
    const srv = server;
    if (!srv || srv.exited) return Promise.resolve(false);
    server = null; // the next start spawns a fresh one even while this one winds down
    srv.retiring = true;
    return new Promise((resolve) => {
      let done = false;
      const settle = () => { if (!done) { done = true; resolve(true); } };
      (srv.onExit = srv.onExit || []).push(settle);
      for (const run of runs) if (run.server === srv && !run.finished) interrupt(run);
      timer(() => { if (!srv.exited) kill(srv.child, 'SIGTERM'); }, cfg.recycleKillMs);
      timer(() => { if (!srv.exited) kill(srv.child, 'SIGKILL'); }, cfg.recycleKillMs + 2000);
      // An exit the client never reports (a kill that cannot land) must not hold
      // an account switch forever.
      timer(settle, cfg.recycleKillMs + 4000);
    });
  }

  // Process shutdown: nothing may outlive the agent.
  function shutdown() {
    for (const run of runs) timers.clearTimeout(run.timers.startAck);
    const srv = server;
    server = null;
    if (srv && !srv.exited) kill(srv.child, 'SIGKILL');
  }

  // The shared server and the threads it is running turns on: the master tells its
  // own app-server apart from a terminal's by this when it reads who holds a thread.
  function servers() {
    const srv = server;
    if (!srv || srv.exited) return null;
    const info = srv.client.info;
    return { pid: srv.pid, threads: [...srv.threads.keys()], native: true, version: (info && info.version) || null };
  }

  return {
    start,
    op,
    request,
    info,
    listThreads,
    watch,
    onNotification,
    useSpec,
    recycle,
    shutdown,
    servers,
    busy: () => [...runs].filter((r) => !r.finished).length,
  };
}

module.exports = { createCodexHarness, DEFAULTS, MODES, WATCH_METHODS, OP_NAMES, ALL_SOURCE_KINDS };
