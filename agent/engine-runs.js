'use strict';

// Engine runs, owned by the machine they run on.
//
// The master used to drive each CLI across the tunnel: it spawned `claude` through
// the 'spawn' capability, read raw stdout over the socket and decided on its own
// what every frame meant. So a dropped link meant parking the child (park.js), and
// every turn-boundary rule had to survive a gap in the middle of the stream it was
// reading. Here the CLI, its protocol and those rules sit on the same box: the
// agent reads stdout itself, turns it into engine events (lib/engine-events.js via
// the adapter, lib/claude-events.js), and keeps a per-run log. The master
// subscribes from a sequence number. A link gap is just a subscriber going away;
// the run carries on and the next subscriber asks for everything after the last
// seq it saw.
//
// A PROCESS can serve more than one run. A turn that ends while its CLI still owns
// background shells keeps the CLI (killing it takes the shells with it), and the
// master may HOLD it as the chat's shell host. From there the CLI starts turns of
// its own when a shell finishes, and a user's follow-up can be submitted into it
// instead of starting a second CLI on the same transcript. Each of those turns is a
// run of its own, and the run before it says so with `run.continued`, so a reader
// follows the chain the same way it reads anything else.
//
// Codex is the other shape. Its CLI is a SERVER (`codex app-server`, JSON-RPC over
// stdio) that holds many threads at once, and the thread lock it takes on a
// rollout is the same whichever client asks, so one machine runs ONE of them for
// every Codex chat, the way Codex Desktop does. A Codex run is one turn on one
// thread of that shared child: its lines are routed to it by threadId, it ends on
// turn/completed, and the child outlives it. Stop interrupts the turn instead of
// killing anything, since the child is serving other chats. lib/codex-events.js is
// its translator; the approval policy stays on the master, which answers every
// approval the run raises.
//
// Grok has the same shape over a different protocol: ONE `grok agent stdio` (the
// Agent Client Protocol) per machine, a run is one session/prompt on one session,
// lines are routed by sessionId, and Stop is session/cancel. lib/grok-events.js is
// its translator. Codex and Grok runs are both `shared`: they own no process.
//
// Module-level singleton: capabilities are remade
// per connection, a run has to outlive one.

const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { createEventLog } = require('./engine-events');
const { createClaudeTranslator, turnStarting } = require('./claude-events');
const { createCodexTranslator } = require('./codex-events');
const { createGrokTranslator } = require('./grok-events');
// Guarded like capabilities.js guards it: an agent that pulled this file before
// proc-tree.js landed still runs turns, it only cannot reap a stopped exec.
let procTree; try { procTree = require('./proc-tree'); } catch { procTree = null; }

let AGENT_VERSION = '0.0.0';
try { AGENT_VERSION = require('./package.json').version; } catch {}

const DEFAULTS = {
  // A background Agent that never reports back stops holding the reap after this.
  asyncAgentMaxMs: 20 * 60 * 1000,
  // A steer whose second result frame never arrives stops holding the turn after this.
  steerMaxMs: 5 * 60 * 1000,
  // The CLI said idle with a frame of ours unanswered: how long it gets to start
  // it before its idle is believed. It goes idle only on an empty queue, so this
  // guards our counting, not a wait anyone should see.
  idleConfirmMs: 2000,
  // How long a resumed turn's CLI stays up for its follow-up suggestion.
  suggestionGraceMs: 5000,
  // A turn that ended holding shells keeps its CLI until the master says hold or
  // stop. This is the ceiling on waiting for either.
  undecidedMs: 60_000,
  controlTimeoutMs: 10_000,
  // No subscriber for this long and the run (or the shell host) is abandoned:
  // nobody can answer its approvals or read its output, and its transcript is on
  // disk regardless.
  orphanTtlMs: Number(process.env.TERMDECK_AGENT_RUN_ORPHAN_MS) || 240_000,
  // Off unless set: where each run's translator calls are taped (see taped()).
  tapeDir: process.env.TERMDECK_TAPE_DIR || null,
  // A finished run stays readable this long, so a master that reconnects just after
  // the finish still hears how the turn ended.
  retainFinishedMs: 120_000,
  killGraceMs: 8000,
  // Token deltas are held this long and sent as one frame. Anything else flushes at once.
  batchMs: 30,
  logLimit: 4000,
  // Codex: a JSON-RPC call's budget, and thread/resume's, which re-reads the whole
  // rollout (a 124 MB one was measured) and so gets a work budget, not a call one.
  codexRpcMs: 30_000,
  codexResumeMs: 5 * 60 * 1000,
  // turn/start's ack timed out: how long turn/started still has to show up before
  // the run is declared dead. A late ack says nothing about whether the turn runs.
  codexStartGraceMs: 30_000,
  // Grok: a control call's budget (initialize, session/load|new, set_model). A
  // timeout there means the child is wedged (a 6 h OIDC token wants a reauth nobody
  // can answer), so it is killed and the next turn spawns a fresh one. session/prompt
  // is a whole turn and has no budget at all.
  grokRpcMs: 20_000,
  // session/cancel has no ack: how long the prompt gets to settle before the child
  // is taken for wedged and killed.
  grokAbortWatchdogMs: 15_000,
};

// What the master may ask the shared Codex child outside a turn. Everything else
// goes through a run, where it is sequenced and logged.
const CODEX_RPC = new Set(['model/list', 'config/read', 'account/rateLimits/read', 'account/rateLimitResetCredit/consume']);
// default_mode_request_user_input is gated off by default; without it the model's
// request_user_input tool errors instead of asking.
const CODEX_ARGS = ['app-server', '-c', 'features.default_mode_request_user_input=true'];
const GROK_ARGS = ['agent', 'stdio'];
const isActiveWriterRefusal = (err) => /active writer/i.test(String((err && (err.message || err)) || ''));

const ADAPTERS = {
  claude: { translator: (opts) => createClaudeTranslator(opts), turnStarting },
};

// Reap the whole process tree, not just the direct child. The engine is often a
// grandchild of a shim or a shell, and a bare kill would orphan it: its
// live-registry pid then view-only-locks the session at turn end. Children are
// spawned detached on POSIX so each is a process-group leader; Windows has no
// groups and taskkill /T walks the tree instead.
function killTree(child, signal) {
  if (!child || child.pid == null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    } else {
      try { process.kill(-child.pid, signal); } // negative pid = the whole group (detached leader)
      catch { child.kill(signal); }             // not a group leader: best effort
    }
  } catch { try { child.kill(signal); } catch {} }
}

// The contract tapes (tests/engine-tapes.mjs). With cfg.tapeDir set, every call the
// driver makes on a run's translator, its arguments and the events it returned, is
// appended to <tapeDir>/<engine>-<runId>.jsonl. The translators are pure, so replaying
// those calls into a fresh translator must give the same events; that is what lets a
// recorded session stand in for the CLI. scripts/record-tapes.js is the only caller.
const TAPE_QUERIES = new Set(['liveShells', 'pendingApprovals']);
function taped(tr, dir, engine, runId, opts) {
  if (!dir) return tr;
  const file = require('path').join(dir, `${engine}-${runId}.jsonl`);
  const out = (o) => { try { require('fs').appendFileSync(file, JSON.stringify(o) + '\n'); } catch {} };
  out({ tape: 1, engine, opts });
  return new Proxy(tr, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function' || TAPE_QUERIES.has(prop)) return v;
      return (...args) => {
        const line = { call: prop, args: JSON.parse(JSON.stringify(args)) };
        const r = v.apply(target, args);
        if (r && Array.isArray(r.events)) line.events = r.events;
        out(line);
        return r;
      };
    },
  });
}

const refuse = (message, code) => Object.assign(new Error(message), { code });

function createRunRegistry(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const spawnFn = cfg.spawn || spawn;
  const kill = cfg.killTree || killTree;
  const reapCommands = cfg.reapCommands || (procTree && procTree.reapCommands) || null;
  const now = cfg.now || Date.now;
  const runs = new Map(); // runId -> run

  function timer(fn, ms) {
    const t = setTimeout(fn, ms);
    if (t.unref) t.unref();
    return t;
  }
  const rid = () => 'c' + randomUUID().slice(0, 12);

  // Best-effort, not a security boundary: grok's OIDC token is a JWT, claude's stderr can echo an API key,, and a 403 line
  // has been seen echoing request context. stderr reaches the browser as an error.
  const redact = (text) => String(text)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED]');

  function start(spec) {
    if (spec && spec.engine === 'codex') return startCodex(spec);
    if (spec && spec.engine === 'grok') return startGrok(spec);
    const { engine, exe, args = [], cwd = null, env = process.env, content, thinking = null, sessionId = null, resumed = false, permissionMode = null, model = null } = spec;
    const adapter = ADAPTERS[engine];
    if (!adapter) throw refuse(`no run adapter for engine ${engine}`, 'BAD_ENGINE');
    if (!Array.isArray(content) || !content.length) throw refuse('a run needs message content', 'BAD_RUN');
    const runId = spec.runId || randomUUID();
    if (runs.has(runId)) throw refuse(`run ${runId} already exists`, 'BAD_RUN');

    let child;
    try {
      child = spawnFn(exe, args, { cwd: cwd || undefined, env, shell: /\.(cmd|bat)$/i.test(exe), detached: process.platform !== 'win32' });
    } catch (e) {
      throw refuse(e.message, 'SPAWN_FAILED');
    }
    const proc = {
      engine,
      adapter,
      child,
      pid: child.pid ?? null,
      cwd,
      model,
      permissionMode,
      current: null,       // the run this process is serving, or last served
      held: false,         // the master holds it as a shell host
      exited: false,
      controls: new Map(), // our control_request id -> { resolve, timer }
      timers: { kill: null, undecided: null },
    };
    child.stdin.on('error', () => {}); // EPIPE from a child that already went: its exit says the rest
    const run = newRun(proc, { runId, sessionId, resumed });

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        route(proc, m);
      }
    });
    // Drained so a chatty CLI cannot block on a full pipe, and the tail kept: a CLI
    // that dies before its first frame (bad flag, broken install, auth) says why
    // only here, and without it the turn failed as a bare "exited with code 1".
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
    const onGone = (code, error) => {
      if (proc.exited) return;
      proc.exited = true;
      const cur = proc.current;
      const tail = stderrTail.trim();
      if (!error && code && tail) error = redact(`claude exited with code ${code} before finishing the turn: ${tail}`);
      apply(cur, cur.tr.exit({ code, error }));
      for (const id of [...proc.controls.keys()]) settleControl(proc, id, { ok: false, response: null });
      for (const t of Object.values(proc.timers)) clearTimeout(t);
      for (const r of runs.values()) if (r.proc === proc) { clearTimeout(r.timers.suggestion); clearTimeout(r.timers.orphan); scheduleRetain(r); }
    };
    child.on('exit', (code) => onGone(code, null));
    child.on('error', (e) => onGone(null, e && e.message));

    writePrompt(proc, content, thinking);
    return { runId, pid: proc.pid };
  }

  function newRun(proc, { runId = randomUUID(), sessionId = null, resumed = true, shells = [], selfStarted = false } = {}) {
    const trOpts = { sessionId, resumed, permissionMode: proc.permissionMode, shells, selfStarted };
    const run = {
      runId,
      proc,
      tr: taped(proc.adapter.translator(trOpts), cfg.tapeDir, proc.engine, runId, trOpts),
      log: createEventLog({ runId, sessionId, limit: cfg.logLimit, now }),
      subs: new Set(),
      finishedAt: null,
      nextRunId: null,
      timers: { async: null, steer: null, idle: null, suggestion: null, orphan: null, retain: null },
      startedAt: now(),
    };
    runs.set(runId, run);
    proc.current = run;
    const started = { type: 'run.started', engine: proc.engine };
    if (proc.model) started.model = proc.model;
    if (proc.cwd) started.cwd = proc.cwd;
    if (proc.permissionMode) started.permissionMode = proc.permissionMode;
    push(run, started);
    if (Number.isFinite(proc.pid)) push(run, { type: 'run.process', pid: proc.pid });
    armOrphan(run);
    return run;
  }

  // The process goes on to another turn. The finished run points at it, so anyone
  // reading the old one follows along.
  function continueOn(proc, selfStarted) {
    const prev = proc.current;
    clearTimeout(prev.timers.suggestion);
    clearTimeout(proc.timers.undecided);
    const run = newRun(proc, { sessionId: prev.log.sessionId, shells: prev.tr.liveShells(), selfStarted });
    prev.nextRunId = run.runId;
    push(prev, { type: 'run.continued', nextRunId: run.runId });
    scheduleRetain(prev);
    return run;
  }

  function route(proc, m) {
    let run = proc.current;
    if (run.finishedAt && proc.adapter.turnStarting(m)) run = continueOn(proc, true); // the CLI began this one itself
    apply(run, run.tr.frame(m));
  }

  function write(proc, frame) {
    if (proc.exited) return false;
    try { proc.child.stdin.write(JSON.stringify(frame) + '\n'); return true; } catch { return false; }
  }

  // The thinking dial goes out AHEAD of the prompt: the turn is fixed the moment
  // the user frame lands, so a dial that arrives later has nothing to apply to
  // (measured on chat fa7b341e, 2026-08-19: a dial sent at init applied to nothing).
  function writePrompt(proc, content, thinking) {
    if (thinking) {
      write(proc, { type: 'control_request', request_id: rid(), request: { subtype: 'set_max_thinking_tokens', max_thinking_tokens: thinking.maxTokens ?? null, thinking_display: thinking.display ?? null } });
    }
    return write(proc, { type: 'user', message: { role: 'user', content } });
  }

  // Stamp one event into the log and hand it to every subscriber.
  function push(run, payload) {
    let ev;
    try {
      ev = run.log.append(payload);
    } catch {
      return; // after the finish, only the AFTER_FINISH types are the run's news
    }
    for (const sub of run.subs) deliver(sub, ev);
  }

  function deliver(sub, ev) {
    sub.pending.push(ev);
    if (ev.type === 'block.delta') {
      if (!sub.timer) sub.timer = timer(() => flush(sub), cfg.batchMs);
      return;
    }
    flush(sub);
  }

  function flush(sub) {
    clearTimeout(sub.timer);
    sub.timer = null;
    if (!sub.pending.length) return;
    const events = sub.pending;
    sub.pending = [];
    sub.sink({ runId: sub.runId, events });
  }

  function apply(run, r) {
    for (const f of r.writes) write(run.proc, f);
    for (const e of r.events) push(run, e);
    if (r.control) settleControl(run.proc, r.control.requestId, { ok: r.control.ok, response: r.control.response });
    if (r.holding) {
      clearTimeout(run.timers.async);
      run.timers.async = timer(() => apply(run, run.tr.expire()), cfg.asyncAgentMaxMs);
    }
    if (r.confirmIdle) {
      const gen = r.confirmIdle;
      clearTimeout(run.timers.idle);
      run.timers.idle = timer(() => apply(run, run.tr.idleConfirmed(gen)), cfg.idleConfirmMs);
    }
    if (r.ended) onFinished(run);
  }

  function onFinished(run) {
    if (run.finishedAt) return;
    run.finishedAt = now();
    clearTimeout(run.timers.async);
    clearTimeout(run.timers.steer);
    clearTimeout(run.timers.idle);
    const proc = run.proc;
    if (proc.exited) return scheduleRetain(run);
    // A held host keeps its CLI until the master releases it.
    if (proc.held) return armOrphan(run);
    // A CLI still owning background shells is kept (killing it takes its whole
    // process group, shells included), and so is one whose shell ended during the
    // turn: it owes the chat a turn about it. The master decides which with hold or
    // stop; the ceiling is for a master that never says.
    if (run.tr.liveShells().length || run.tr.shellEndedDuringTurn) {
      proc.timers.undecided = timer(() => { if (!proc.held) reap(proc); }, cfg.undecidedMs);
      return;
    }
    if (run.tr.awaitingSuggestion) {
      run.timers.suggestion = timer(() => { if (proc.current === run && !proc.held) reap(proc); }, cfg.suggestionGraceMs);
      return;
    }
    reap(proc);
  }

  function reap(proc) {
    if (proc.exited) return;
    for (const r of runs.values()) if (r.proc === proc) clearTimeout(r.timers.suggestion);
    clearTimeout(proc.timers.undecided);
    try { proc.child.stdin.end(); } catch {}
    kill(proc.child, 'SIGTERM');
    clearTimeout(proc.timers.kill);
    proc.timers.kill = timer(() => { if (!proc.exited) kill(proc.child, 'SIGKILL'); }, cfg.killGraceMs);
  }

  // A run leaves the registry once it is finished and nothing more can happen on
  // it: its process is gone, or has moved on to the next run.
  function scheduleRetain(run) {
    if (!run.finishedAt || !(run.shared || run.proc.exited || run.proc.current !== run)) return;
    clearTimeout(run.timers.retain);
    run.timers.retain = timer(() => {
      for (const sub of run.subs) flush(sub);
      runs.delete(run.runId);
    }, cfg.retainFinishedMs);
  }

  // Nobody listening to a run that is still going, or to a held host, for the TTL:
  // stop it. A finished run on a CLI the master has not held needs no watch; its
  // own timers end it.
  function armOrphan(run) {
    clearTimeout(run.timers.orphan);
    if (run.shared) {
      // Nobody can answer this turn's approvals or read it: interrupt the turn. The
      // shared child stays, it is serving other chats.
      if (run.subs.size || run.finishedAt) return;
      run.timers.orphan = timer(() => { if (!run.subs.size && !run.finishedAt) sharedInterrupt(run); }, cfg.orphanTtlMs);
      return;
    }
    const watched = () => !run.subs.size && run.proc.current === run && !run.proc.exited && (!run.finishedAt || run.proc.held);
    if (!watched()) return;
    run.timers.orphan = timer(() => {
      if (!watched()) return;
      run.tr.abort();
      reap(run.proc);
    }, cfg.orphanTtlMs);
  }

  function settleControl(proc, requestId, value) {
    const entry = proc.controls.get(requestId);
    if (!entry) return;
    proc.controls.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(value);
  }


  /* ---------------- Codex: one shared app-server, a run per turn ---------------- */

  let codex = null; // { child, pid, exited, pending, nextId, init, serverInfo, threads, collab, stderr }

  function codexServer(spec) {
    if (codex && !codex.exited) return codex;
    let child;
    try {
      child = spawnFn(spec.exe, CODEX_ARGS, { env: spec.env || process.env, shell: /\.(cmd|bat)$/i.test(spec.exe), detached: process.platform !== 'win32' });
    } catch (e) {
      throw refuse(e.message, 'SPAWN_FAILED');
    }
    const server = {
      engine: 'codex',
      child,
      pid: child.pid ?? null,
      exited: false,
      pending: new Map(),   // our rpc id -> { resolve, reject, timer }
      nextId: 1,
      init: null,
      serverInfo: null,
      threads: new Map(),   // threadId -> the run serving that thread's current turn
      collab: new Set(),    // threads left in the `plan` collaboration mode (sticky on the thread)
      stderr: [],
    };
    codex = server;
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        codexRoute(server, m);
      }
    });
    child.stderr.on('data', (d) => {
      server.stderr.push(String(d));
      if (server.stderr.length > 50) server.stderr.shift();
    });
    const onGone = (code, error) => {
      if (server.exited) return;
      server.exited = true;
      if (codex === server) codex = null;
      const tail = server.stderr.join('').trim();
      const why = (error || `codex app-server exited${code != null ? ` (code ${code})` : ''}`) + (tail ? `\n\nstderr:\n${tail.slice(-2000)}` : '');
      for (const [, p] of server.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(why), { code: 'CODEX_EXITED' })); }
      server.pending.clear();
      for (const run of runs.values()) {
        if (run.proc === server && !run.finishedAt) codexApply(run, run.tr.exit({ error: why }));
      }
    };
    child.on('exit', (code) => onGone(code, null));
    child.on('error', (e) => onGone(null, e && e.message));
    server.init = codexRequest(server, 'initialize', {
      clientInfo: { name: 'termdeck', version: AGENT_VERSION },
      // experimentalApi unlocks turn/start.collaborationMode, which is plan mode.
      capabilities: { experimentalApi: true },
    }).then((res) => {
      server.serverInfo = res || {};
      codexWrite(server, { jsonrpc: '2.0', method: 'initialized', params: {} });
      return server.serverInfo;
    });
    server.init.catch(() => {});
    return server;
  }

  function codexWrite(server, msg) {
    if (server.exited) return false;
    try { server.child.stdin.write(JSON.stringify(msg) + '\n'); return true; } catch { return false; }
  }

  function codexRequest(server, method, params, timeoutMs = cfg.codexRpcMs) {
    const id = server.nextId++;
    return new Promise((resolve, reject) => {
      const t = timer(() => {
        server.pending.delete(id);
        reject(Object.assign(new Error(`codex ${method} timed out`), { code: 'CODEX_RPC_TIMEOUT' }));
      }, timeoutMs);
      server.pending.set(id, { resolve, reject, timer: t });
      const msg = { jsonrpc: '2.0', id, method };
      if (params !== undefined) msg.params = params;
      if (!codexWrite(server, msg)) {
        clearTimeout(t);
        server.pending.delete(id);
        reject(Object.assign(new Error('codex app-server is not running'), { code: 'CODEX_DOWN' }));
      }
    });
  }

  // Does this build say it supports a capability? null when it says nothing.
  function codexHas(server, name) {
    const info = server.serverInfo || {};
    const caps = info.capabilities || (info.serverInfo && info.serverInfo.capabilities);
    if (!caps || typeof caps !== 'object' || !(name in caps)) return null;
    return !!caps[name];
  }

  function codexRoute(server, m) {
    if (m.id !== undefined && !m.method) {
      const p = server.pending.get(m.id);
      if (!p) return;
      server.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || 'codex error'), { code: 'CODEX_RPC', data: m.error.data }));
      else p.resolve(m.result);
      return;
    }
    const params = m.params || {};
    const threadId = params.threadId || params.thread_id || null;
    const run = threadId ? server.threads.get(threadId) : null;
    if (m.method && m.id !== undefined) {
      if (!run || run.finishedAt) {
        codexWrite(server, { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'No active Termdeck run for this thread' } });
        return;
      }
      if (m.method === 'item/commandExecution/requestApproval' && params.itemId && params.command) run.execs.set(params.itemId, params.command);
      codexApply(run, run.tr.request(m.method, params, m.id));
      return;
    }
    if (!m.method || !run || run.finishedAt) return;
    const item = params.item;
    if (item && item.type === 'commandExecution' && item.id) {
      if (m.method === 'item/started' && item.command) run.execs.set(item.id, item.command);
      else if (m.method === 'item/completed') run.execs.delete(item.id);
    }
    codexApply(run, run.tr.notification(m.method, params));
    if (m.method === 'turn/started') {
      clearTimeout(run.timers.startAck);
      // Stop landed before there was a turn id to interrupt. Now there is.
      if (run.abortRequested) codexInterrupt(run);
    }
  }

  function codexApply(run, r) {
    for (const w of r.writes) codexWrite(run.proc, w);
    for (const e of r.events) push(run, e);
    if (r.ended) codexFinished(run);
  }

  function codexFinished(run) {
    if (run.finishedAt) return;
    run.finishedAt = now();
    clearTimeout(run.timers.startAck);
    clearTimeout(run.timers.orphan);
    const server = run.proc;
    if (run.threadId && server.threads.get(run.threadId) === run) server.threads.delete(run.threadId);
    scheduleRetain(run);
  }

  function codexFail(run, message, detail = null) {
    if (run.finishedAt) return;
    codexApply(run, run.tr.fail(message, detail));
  }

  function codexInterrupt(run) {
    run.abortRequested = true;
    run.tr.abort();
    if (run.finishedAt || run.proc.exited) return;
    const turnId = run.tr.turnId;
    if (!turnId) return; // turn/started fires it (codexRoute), or prepare sees the flag first
    reapExecs(run);
    codexRequest(run.proc, 'turn/interrupt', { threadId: run.threadId, turnId }).catch(() => {});
  }

  // Stop on a shared server ends the TURN, and the server lets the command it was
  // running carry on (it is a child of the server, not of the turn). Kill those,
  // by the command lines the engine reported, and nothing else under the server.
  // Taken before the interrupt goes out: the server's own item/completed for the
  // exec would otherwise empty the list first. See proc-tree.js reapCommands.
  function reapExecs(run) {
    if (!reapCommands || !run.execs || !run.execs.size) return;
    const pid = run.proc && run.proc.pid;
    if (!Number.isFinite(pid)) return;
    const commands = [...run.execs.values()];
    run.execs.clear();
    Promise.resolve().then(() => reapCommands(pid, commands)).catch(() => {});
  }

  // spec: { runId?, exe, env, sessionId (a thread id, or null for a new chat), cwd,
  //   content (the turn's UserInput array), turn (turn/start settings: approvalPolicy,
  //   sandboxPolicy, model, effort, summary), thread (thread/start settings:
  //   approvalPolicy, sandbox), collab ('plan' or null), permissionMode, model }
  function startCodex(spec) {
    const { content, sessionId = null, cwd = null, permissionMode = null, model = null } = spec;
    if (!Array.isArray(content) || !content.length) throw refuse('a run needs message content', 'BAD_RUN');
    if (!spec.exe) throw refuse('codex is not installed on this machine', 'BAD_ENGINE');
    const runId = spec.runId || randomUUID();
    if (runs.has(runId)) throw refuse(`run ${runId} already exists`, 'BAD_RUN');
    if (sessionId && codex && !codex.exited) {
      const busyRun = codex.threads.get(sessionId);
      if (busyRun && !busyRun.finishedAt) throw refuse('A turn is already running for this session', 'BUSY');
    }
    const server = codexServer(spec);
    const run = {
      runId,
      proc: server,
      shared: true,
      codex: true,
      threadId: sessionId,
      execs: new Map(), // itemId -> command line of an exec in flight (reapExecs)
      tr: taped(createCodexTranslator({ threadId: sessionId }), cfg.tapeDir, 'codex', runId, { threadId: sessionId }),
      log: createEventLog({ runId, sessionId, limit: cfg.logLimit, now }),
      subs: new Set(),
      finishedAt: null,
      nextRunId: null,
      abortRequested: false,
      timers: { orphan: null, retain: null, startAck: null },
      startedAt: now(),
    };
    runs.set(runId, run);
    // Claimed at once, so a second start on the same thread is refused while this
    // one is still resuming.
    if (sessionId) server.threads.set(sessionId, run);
    const started = { type: 'run.started', engine: 'codex' };
    if (model) started.model = model;
    if (cwd) started.cwd = cwd;
    if (permissionMode) started.permissionMode = permissionMode;
    push(run, started);
    if (Number.isFinite(server.pid)) push(run, { type: 'run.process', pid: server.pid });
    armOrphan(run);
    codexPrepare(run, spec).catch((e) => codexFail(run, (e && e.message) || 'Codex could not start the turn'));
    return { runId, pid: server.pid };
  }

  async function codexPrepare(run, spec) {
    const server = run.proc;
    const { cwd = null, content } = spec;
    const turn = spec.turn || {};
    await server.init;
    let threadId = run.threadId;
    let threadModel = null;
    let transcriptPath = null;
    if (threadId) {
      // Resume EVERY turn, not only the first: it re-reads the rollout, so turns a
      // terminal appended in between are picked up.
      try {
        const res = await codexRequest(server, 'thread/resume', { threadId, cwd }, cfg.codexResumeMs);
        threadModel = (res && res.model) || null;
      } catch (e) {
        if (isActiveWriterRefusal(e)) return codexFail(run, 'Another Codex client is writing this chat. It unlocks when that turn ends.', { code: 'SESSION_ATTACHED' });
        throw e;
      }
    } else {
      const th = spec.thread || {};
      const res = await codexRequest(server, 'thread/start', { cwd, approvalPolicy: th.approvalPolicy, sandbox: th.sandbox });
      const thread = (res && res.thread) || {};
      if (!thread.id) return codexFail(run, 'thread/start returned no thread id', { code: 'CODEX_RPC' });
      threadId = thread.id;
      transcriptPath = thread.path || null;
      threadModel = (res && res.model) || null;
      run.threadId = threadId;
      server.threads.set(threadId, run);
    }
    if (run.abortRequested) return codexFail(run, 'Stopped before the turn began');

    const params = { threadId, input: content };
    for (const k of ['approvalPolicy', 'sandboxPolicy', 'model', 'effort', 'summary']) {
      if (turn[k] != null) params[k] = turn[k];
    }
    // The cwd again, on the turn. thread/resume's cwd does not move a thread this
    // shared app-server already has loaded, so a chat the index followed into a
    // worktree it made (lib/session-head.js codexTailWorktree) kept running every
    // later turn in the base repo. turn/start's cwd is "this turn and subsequent
    // turns" (codex app-server schema, 0.158).
    if (cwd) params.cwd = cwd;
    // Plan mode rides turn/start.collaborationMode and needs a model. The mode is
    // STICKY on the thread, so leaving plan has to reset it to 'default' explicitly
    // or the next turn stays in plan and the model will not act.
    const settingsModel = params.model || threadModel;
    if (spec.collab === 'plan') {
      if (!settingsModel) return codexFail(run, 'Codex plan mode requires a resolved model; pick a specific model and try again', { code: 'CODEX_PLAN_MODEL_REQUIRED' });
      if (codexHas(server, 'experimentalApi') === false) {
        const v = (server.serverInfo && server.serverInfo.serverInfo && server.serverInfo.serverInfo.version) || 'unknown version';
        return codexFail(run, `This codex build (${v}) does not offer the experimental API plan mode needs; pick another mode, or update codex`, { code: 'CODEX_NO_PLAN_MODE' });
      }
      params.collaborationMode = { mode: 'plan', settings: { model: settingsModel, ...(params.effort ? { reasoning_effort: params.effort } : {}) } };
      server.collab.add(threadId);
    } else if (server.collab.has(threadId) && settingsModel) {
      params.collaborationMode = { mode: 'default', settings: { model: settingsModel } };
      server.collab.delete(threadId);
    }

    codexApply(run, run.tr.bound(threadId, { cwd, transcriptPath }));
    if (settingsModel) push(run, { type: 'session.info', model: settingsModel, ...(cwd ? { cwd } : {}) });

    try {
      await codexRequest(server, 'turn/start', params);
    } catch (e) {
      if (run.finishedAt) return undefined;
      // A late ack is not a refusal: the turn usually runs. Give turn/started a
      // window before calling it dead (KNOWN-BUGS #22).
      if (e && e.code === 'CODEX_RPC_TIMEOUT' && !run.tr.turnId) {
        run.timers.startAck = timer(() => { if (!run.tr.turnId) codexFail(run, e.message); }, cfg.codexStartGraceMs);
        return undefined;
      }
      if (!run.tr.turnId) return codexFail(run, (e && e.message) || 'turn/start failed');
    }
    return undefined;
  }

  // turn/steer: a message into the running turn. Refused while there is no turn id
  // yet, and when the model or effort changed (the master checks that; turn/steer
  // carries neither).
  async function codexSteer(run, content) {
    if (run.finishedAt || run.proc.exited) throw refuse('the turn is over', 'NO_RUN');
    if (!run.tr.turnId) throw refuse('Codex turn is not ready for steering yet', 'STEER_NOT_READY');
    try {
      await codexRequest(run.proc, 'turn/steer', { threadId: run.threadId, expectedTurnId: run.tr.turnId, input: content });
    } catch (e) {
      throw refuse((e && e.message) || 'turn/steer failed', run.finishedAt ? 'NO_RUN' : 'STEER_FAILED');
    }
  }

  // A call to the shared child outside any turn: the model list, the account's
  // rate limits. Spawns it if nothing has yet.
  async function rpc(spec) {
    const { method, params, timeoutMs } = spec;
    if (spec.engine === 'grok') return grokRpc(spec);
    if (spec.engine !== 'codex') throw refuse(`no rpc for engine ${spec.engine}`, 'BAD_ENGINE');
    if (!CODEX_RPC.has(method)) throw refuse(`codex ${method} is not allowed here`, 'BAD_RUN');
    if (!spec.exe) throw refuse('codex is not installed on this machine', 'BAD_ENGINE');
    const server = codexServer(spec);
    await server.init;
    const result = await codexRequest(server, method, params, Number(timeoutMs) || cfg.codexRpcMs);
    return { result: result === undefined ? null : result, pid: server.pid };
  }

  // Drop the shared Codex child so the next turn spawns one on whatever login is on
  // disk now (an account switch rewrote auth.json; a running app-server read the old
  // one when it started). Running turns are interrupted first, then it goes.
  function recycle(engine) {
    if (engine === 'grok') return grokRecycle();
    if (engine !== 'codex' || !codex || codex.exited) return false;
    const server = codex;
    codex = null; // the next start spawns a fresh one even while this one winds down
    for (const run of runs.values()) if (run.proc === server && !run.finishedAt) codexInterrupt(run);
    timer(() => { if (!server.exited) kill(server.child, 'SIGTERM'); }, 500);
    return true;
  }

  /* ---------------- Grok: one shared `grok agent stdio`, a run per prompt ---------------- */

  let grok = null; // { child, pid, exited, pending, nextId, init, modelState, sessions, stderr }

  function grokServer(spec) {
    if (grok && !grok.exited) return grok;
    let child;
    try {
      // spec.env comes without XAI_API_KEY / GROK_DEPLOYMENT_KEY (capabilities.js
      // engineEnv): turns run on the CLI's own subscription login, never metered.
      child = spawnFn(spec.exe, GROK_ARGS, { cwd: spec.home || undefined, env: spec.env || process.env, shell: /\.(cmd|bat)$/i.test(spec.exe), detached: process.platform !== 'win32' });
    } catch (e) {
      throw refuse(e.message, 'SPAWN_FAILED');
    }
    const server = {
      engine: 'grok',
      child,
      pid: child.pid ?? null,
      exited: false,
      pending: new Map(),  // our rpc id -> { resolve, reject, timer }
      nextId: 1,
      init: null,
      modelState: null,    // initialize's _meta.modelState: the only model catalogue grok has
      sessions: new Map(), // sessionId -> the run serving that session's current prompt
      stderr: [],
    };
    grok = server;
    child.stdin.on('error', () => {});
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        grokRoute(server, m);
      }
    });
    child.stderr.on('data', (d) => {
      server.stderr.push(redact(d));
      if (server.stderr.length > 50) server.stderr.shift();
    });
    const onGone = (code, error) => {
      if (server.exited) return;
      server.exited = true;
      if (grok === server) grok = null;
      const tail = server.stderr.join('').trim();
      const why = redact((error || `grok agent stdio exited${code != null ? ` (code ${code})` : ''}`) + (tail ? `\n\nstderr:\n${tail.slice(-2000)}` : ''));
      for (const [, p] of server.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(why), { code: 'GROK_EXITED' })); }
      server.pending.clear();
      for (const run of runs.values()) {
        if (run.proc === server && !run.finishedAt) grokApply(run, run.tr.exit({ error: why }));
      }
    };
    child.on('exit', (code) => onGone(code, null));
    child.on('error', (e) => onGone(null, e && e.message));
    // No `initialized` notification follows on this surface: session/new right after
    // initialize's answer works every time.
    server.init = grokRequest(server, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }).then((res) => {
      server.modelState = (res && res._meta && res._meta.modelState) || null;
      return res;
    });
    server.init.catch(() => {});
    return server;
  }

  function grokWrite(server, msg) {
    if (server.exited) return false;
    try { server.child.stdin.write(JSON.stringify(msg) + '\n'); return true; } catch { return false; }
  }

  // timeoutMs null = no budget (session/prompt only). A control call that times out
  // kills the child: one wedged session must not hold every other grok chat.
  function grokRequest(server, method, params, timeoutMs = cfg.grokRpcMs) {
    const id = server.nextId++;
    return new Promise((resolve, reject) => {
      const t = timeoutMs ? timer(() => {
        server.pending.delete(id);
        reject(Object.assign(new Error(`grok ${method} timed out after ${timeoutMs}ms`), { code: 'GROK_RPC_TIMEOUT' }));
        if (!server.exited) kill(server.child, 'SIGKILL');
      }, timeoutMs) : null;
      server.pending.set(id, { resolve, reject, timer: t });
      if (!grokWrite(server, { jsonrpc: '2.0', id, method, params })) {
        clearTimeout(t);
        server.pending.delete(id);
        reject(Object.assign(new Error('grok agent stdio is not running'), { code: 'GROK_DOWN' }));
      }
    });
  }

  const grokErr = (e) => {
    if (!e) return 'unknown error';
    const dataCode = e.data && e.data.code;
    return redact(dataCode ? `${e.message} (${dataCode})` : e.message);
  };

  function grokRoute(server, m) {
    if (m.id !== undefined && !m.method) {
      const p = server.pending.get(m.id);
      if (!p) return;
      server.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || 'grok error'), { code: 'GROK_RPC', data: m.error.data }));
      else p.resolve(m.result);
      return;
    }
    const params = m.params || {};
    const run = params.sessionId ? server.sessions.get(params.sessionId) : null;
    if (m.method && m.id !== undefined) {
      if (!run || run.finishedAt) {
        grokWrite(server, { jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'No active Termdeck run for this session' } });
        return;
      }
      grokApply(run, run.tr.request(m.method, params, m.id));
      return;
    }
    if (!m.method || !run || run.finishedAt) return;
    grokTrackExec(run, params.update);
    grokApply(run, run.tr.notification(m));
  }

  // ACP names a shell call kind 'execute' and carries its command in rawInput.
  function grokTrackExec(run, update) {
    if (!update || !update.toolCallId) return;
    const id = update.toolCallId;
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const raw = update.rawInput && typeof update.rawInput === 'object' ? update.rawInput : null;
      const command = raw && (raw.command || raw.cmd);
      if (command && (update.kind === 'execute' || run.execs.has(id))) run.execs.set(id, Array.isArray(command) ? command.join(' ') : String(command));
      if (['completed', 'failed', 'error', 'cancelled'].includes(update.status)) run.execs.delete(id);
    }
  }

  function grokApply(run, r) {
    for (const w of r.writes) grokWrite(run.proc, w);
    for (const e of r.events) push(run, e);
    if (r.ended) grokFinished(run);
  }

  function grokFinished(run) {
    if (run.finishedAt) return;
    run.finishedAt = now();
    clearTimeout(run.timers.orphan);
    clearTimeout(run.timers.watchdog);
    const server = run.proc;
    if (run.sessionKey && server.sessions.get(run.sessionKey) === run) server.sessions.delete(run.sessionKey);
    scheduleRetain(run);
  }

  function grokFail(run, message, detail = null) {
    if (run.finishedAt) return;
    grokApply(run, run.tr.fail(message, detail));
  }

  // session/cancel is a notification: the prompt then resolves with stopReason
  // cancelled. If it does not settle, the child is taken for wedged.
  function grokInterrupt(run) {
    run.abortRequested = true;
    run.tr.abort();
    if (run.finishedAt || run.proc.exited) return;
    if (!run.sessionKey || !run.prompting) return; // prepare sees the flag before the prompt goes out
    reapExecs(run);
    grokWrite(run.proc, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: run.sessionKey } });
    clearTimeout(run.timers.watchdog);
    run.timers.watchdog = timer(() => {
      if (!run.finishedAt && !run.proc.exited) kill(run.proc.child, 'SIGKILL');
    }, cfg.grokAbortWatchdogMs);
  }

  function sharedInterrupt(run) {
    return run.grok ? grokInterrupt(run) : codexInterrupt(run);
  }

  // Grok's one out-of-turn read: the model catalogue initialize answered with.
  // ACP has no model list call, so this is it, spawning the child if need be.
  async function grokRpc(spec) {
    if (spec.method !== 'modelState') throw refuse(`grok ${spec.method} is not allowed here`, 'BAD_RUN');
    if (!spec.exe) throw refuse('grok is not installed on this machine', 'BAD_ENGINE');
    const server = grokServer(spec);
    await server.init;
    return { result: server.modelState || null, pid: server.pid };
  }

  // Same as Codex's: a login switch is only read by a fresh child.
  function grokRecycle() {
    if (!grok || grok.exited) return false;
    const server = grok;
    grok = null;
    for (const run of runs.values()) if (run.proc === server && !run.finishedAt) grokInterrupt(run);
    timer(() => { if (!server.exited) kill(server.child, 'SIGTERM'); }, 500);
    return true;
  }

  // grok's session/new answers no path, so the session's folder is looked up under
  // the sessions root: <root>/<group>/<sessionId>/updates.jsonl.
  function grokSessionDir(root, sessionId) {
    if (!root || !sessionId) return null;
    const fs = require('fs');
    const path = require('path');
    let groups = [];
    try { groups = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
    for (const g of groups) {
      if (!g.isDirectory()) continue;
      const dir = path.join(root, g.name, sessionId);
      try { if (fs.statSync(dir).isDirectory()) return dir; } catch {}
    }
    return null;
  }

  // signals.json is what the CLI's own /context meter is built from.
  function grokSignals(dir) {
    if (!dir) return null;
    try {
      const raw = JSON.parse(require('fs').readFileSync(require('path').join(dir, 'signals.json'), 'utf8'));
      const n = (v) => (Number.isFinite(v) ? v : null);
      return { contextTokensUsed: n(raw.contextTokensUsed), contextWindowTokens: n(raw.contextWindowTokens) };
    } catch {
      return null;
    }
  }

  function grokContextWindow(modelState, modelId) {
    const list = (modelState && modelState.availableModels) || [];
    const window = (m) => (m && m._meta && Number.isFinite(m._meta.totalContextTokens) ? m._meta.totalContextTokens : null);
    if (modelId) {
      const hit = list.find((m) => m.modelId === modelId);
      if (window(hit) != null) return window(hit);
    }
    if (list.length === 1 && window(list[0]) != null) return window(list[0]);
    return null;
  }

  // spec: { runId?, exe, env, home, sessionsRoot, sessionId (or null for a new chat),
  //   cwd, content (the ACP prompt blocks), model, effort, modeId, permissionMode }
  function startGrok(spec) {
    const { content, sessionId = null, cwd = null, permissionMode = null, model = null } = spec;
    if (!Array.isArray(content) || !content.length) throw refuse('a run needs message content', 'BAD_RUN');
    if (!spec.exe) throw refuse('grok is not installed on this machine', 'BAD_ENGINE');
    const runId = spec.runId || randomUUID();
    if (runs.has(runId)) throw refuse(`run ${runId} already exists`, 'BAD_RUN');
    if (sessionId && grok && !grok.exited) {
      const busyRun = grok.sessions.get(sessionId);
      if (busyRun && !busyRun.finishedAt) throw refuse('A turn is already running for this session', 'BUSY');
    }
    const server = grokServer(spec);
    const run = {
      runId,
      proc: server,
      shared: true,
      grok: true,
      sessionKey: sessionId,
      execs: new Map(), // toolCallId -> command line of an execute call in flight (reapExecs)
      prompting: false,
      tr: taped(createGrokTranslator({ sessionId }), cfg.tapeDir, 'grok', runId, { sessionId }),
      log: createEventLog({ runId, sessionId, limit: cfg.logLimit, now }),
      subs: new Set(),
      finishedAt: null,
      nextRunId: null,
      abortRequested: false,
      timers: { orphan: null, retain: null, watchdog: null },
      startedAt: now(),
    };
    runs.set(runId, run);
    if (sessionId) server.sessions.set(sessionId, run);
    const started = { type: 'run.started', engine: 'grok' };
    if (model) started.model = model;
    if (cwd) started.cwd = cwd;
    if (permissionMode) started.permissionMode = permissionMode;
    push(run, started);
    if (Number.isFinite(server.pid)) push(run, { type: 'run.process', pid: server.pid });
    armOrphan(run);
    grokPrepare(run, spec).catch((e) => grokFail(run, (e && e.message) || 'Grok could not start the turn'));
    return { runId, pid: server.pid };
  }

  async function grokPrepare(run, spec) {
    const server = run.proc;
    const { cwd = null, content, model = null, effort = null, modeId = null } = spec;
    await server.init;
    let sessionId = run.sessionKey;
    let res;
    if (sessionId) {
      // Load EVERY turn: it re-reads the session folder, so turns a terminal
      // appended in between are picked up. A missing folder is a clean error.
      try {
        res = await grokRequest(server, 'session/load', { sessionId, cwd, mcpServers: [] });
      } catch (e) {
        return grokFail(run, `Could not load grok session: ${grokErr(e)}`, { code: 'GROK_LOAD_FAILED' });
      }
    } else {
      try {
        res = await grokRequest(server, 'session/new', { cwd, mcpServers: [] });
      } catch (e) {
        return grokFail(run, `Could not start grok session: ${grokErr(e)}`, { code: 'GROK_NEW_FAILED' });
      }
      sessionId = res && res.sessionId;
      if (!sessionId) return grokFail(run, 'session/new returned no sessionId', { code: 'GROK_RPC' });
      run.sessionKey = sessionId;
      server.sessions.set(sessionId, run);
    }
    const threadModel = (res && res.models && res.models.currentModelId) || null;
    if (run.abortRequested) return grokFail(run, 'Stopped before the turn began');

    // Both best-effort: a refusal means the turn runs on grok's own default, not
    // that it fails. session/set_mode changes nothing on current builds (the master
    // enforces the mode on each approval) and is sent in case a later one listens.
    if (model || effort) {
      const modelId = model || threadModel;
      if (modelId) {
        try { await grokRequest(server, 'session/set_model', { sessionId, modelId, ...(effort ? { reasoningEffort: effort } : {}) }); } catch {}
      }
    }
    if (modeId) {
      try { await grokRequest(server, 'session/set_mode', { sessionId, modeId }); } catch {}
    }
    if (run.abortRequested) return grokFail(run, 'Stopped before the turn began');

    const dir = grokSessionDir(spec.sessionsRoot, sessionId);
    const usedModel = model || threadModel;
    grokApply(run, run.tr.bound(sessionId, {
      cwd,
      transcriptPath: dir ? require('path').join(dir, 'updates.jsonl') : null,
      window: grokContextWindow(server.modelState, usedModel),
    }));
    if (usedModel) push(run, { type: 'session.info', model: usedModel, ...(cwd ? { cwd } : {}) });
    run.prompting = true;
    grokApply(run, run.tr.prompting());
    grokRequest(server, 'session/prompt', { sessionId, prompt: content }, null)
      .then((result) => grokApply(run, run.tr.promptResolved(result, { signals: grokSignals(dir) })))
      .catch((e) => grokFail(run, grokErr(e)));
    return undefined;
  }

  // The shared children and their pids: the master tells its own app-server apart
  // from a terminal's by this when it reads who holds a thread.
  const servers = () => ({
    codex: codex && !codex.exited ? { pid: codex.pid, threads: [...codex.threads.keys()] } : null,
    grok: grok && !grok.exited ? { pid: grok.pid, sessions: [...grok.sessions.keys()] } : null,
  });

  function need(runId) {
    const run = runs.get(runId);
    if (!run) throw refuse(`no such run ${runId}`, 'NO_RUN');
    return run;
  }

  // Replay everything after `afterSeq`, then stream live. A reader further behind
  // than the log holds is told so with `gap`, and rereads the transcript.
  function subscribe(runId, afterSeq, sink) {
    const run = need(runId);
    const sub = { runId, sink, pending: [], timer: null };
    const missed = run.log.since(Number(afterSeq) || 0);
    if (missed === null) sink({ runId, gap: true, seq: run.log.seq });
    else if (missed.length) sink({ runId, events: missed });
    run.subs.add(sub);
    clearTimeout(run.timers.orphan);
    return () => {
      if (!run.subs.delete(sub)) return;
      flush(sub);
      armOrphan(run);
    };
  }

  function answer(runId, requestId, decision) {
    const run = need(runId);
    if (run.codex) return codexApply(run, run.tr.answer(requestId, decision));
    if (run.grok) return grokApply(run, run.tr.answer(requestId, decision));
    apply(run, run.tr.answer(requestId, decision));
  }

  function steer(runId, content) {
    const run = need(runId);
    if (run.codex) return codexSteer(run, content);
    // ACP has no mid-turn input: the master queues the message for the next turn.
    if (run.grok) throw refuse('Grok cannot take a message mid-turn', 'STEER_UNSUPPORTED');
    if (run.finishedAt || run.proc.exited) throw refuse('the turn is over', 'NO_RUN');
    // priority 'now' would abort the running sub-agents and discard their work
    // (lib/claude-events.js agentCalls). The master queues on this code instead.
    if (run.tr.agentCallsInFlight) throw refuse('a sub-agent is running; the message waits for the turn', 'STEER_BUSY');
    run.tr.steer();
    clearTimeout(run.timers.steer);
    run.timers.steer = timer(() => apply(run, run.tr.expire()), cfg.steerMaxMs);
    write(run.proc, { type: 'user', priority: 'now', message: { role: 'user', content } });
  }

  // A user's follow-up, written into a CLI whose last turn is over (a shell host)
  // instead of starting a second CLI on the same transcript. Answers the new run.
  function submit(runId, content, thinking = null) {
    if (need(runId).shared) throw refuse('a shared-child turn starts with start, on its session', 'BAD_ENGINE');
    const proc = need(runId).proc;
    if (proc.exited) throw refuse('the CLI holding this chat is gone', 'NO_RUN');
    if (!proc.current.finishedAt) throw refuse('a turn is already running on this CLI', 'BUSY');
    if (!Array.isArray(content) || !content.length) throw refuse('a run needs message content', 'BAD_RUN');
    const run = continueOn(proc, false);
    if (!writePrompt(proc, content, thinking)) throw refuse('the CLI holding this chat is gone', 'NO_RUN');
    return { runId: run.runId, pid: proc.pid };
  }

  // The master keeps this CLI as the chat's shell host: it is not reaped when its
  // turn ends, only when the master releases it (stop) or stops listening (TTL).
  function hold(runId) {
    const run = need(runId);
    if (run.shared) return null;
    const proc = run.proc;
    if (proc.exited) return null;
    proc.held = true;
    clearTimeout(proc.timers.undecided);
    clearTimeout(run.timers.suggestion);
    armOrphan(proc.current);
    return { pid: proc.pid };
  }

  function interrupt(runId) {
    const run = need(runId);
    if (run.shared) return sharedInterrupt(run);
    run.tr.abort();
    write(run.proc, { type: 'control_request', request_id: rid(), request: { subtype: 'interrupt' } });
  }

  function control(runId, request, timeoutMs = cfg.controlTimeoutMs) {
    if (need(runId).shared) return Promise.resolve({ ok: false, response: null });
    const proc = need(runId).proc;
    return new Promise((resolve) => {
      if (proc.exited) return resolve({ ok: false, response: null });
      const requestId = rid();
      proc.controls.set(requestId, { resolve, timer: timer(() => settleControl(proc, requestId, { ok: false, response: null }), timeoutMs) });
      if (request && request.subtype === 'set_permission_mode' && typeof request.mode === 'string') proc.permissionMode = request.mode;
      if (request && request.subtype === 'set_model') proc.model = request.model || null;
      if (!write(proc, { type: 'control_request', request_id: requestId, request })) settleControl(proc, requestId, { ok: false, response: null });
    });
  }

  // Stop the turn and the CLI. A finished turn on a CLI nobody holds is already on
  // its way out (reaped, or waiting out the suggestion window), so there is nothing
  // to do for it.
  function stop(runId) {
    const run = runs.get(runId);
    if (!run) return false;
    if (run.shared) {
      if (run.finishedAt || run.proc.exited) return false;
      sharedInterrupt(run);
      return true;
    }
    const proc = run.proc;
    if (proc.exited) return false;
    const cur = proc.current;
    if (cur.finishedAt && !proc.held && cur.timers.suggestion) return true;
    if (!cur.finishedAt) cur.tr.abort();
    proc.held = false;
    reap(proc);
    return true;
  }

  // The pid of a live CLI a run belongs to, for the shell reconciler.
  function livePid(runId) {
    const run = runs.get(runId);
    if (run && run.shared) return null; // a Codex or Grok run owns no process of its own
    return run && !run.proc.exited ? run.proc.pid : null;
  }

  function list() {
    return [...runs.values()].map((run) => ({
      runId: run.runId,
      engine: run.proc.engine,
      sessionId: run.log.sessionId,
      seq: run.log.seq,
      pid: run.proc.pid,
      finished: !!run.finishedAt,
      exited: run.proc.exited,
      current: run.shared ? !run.finishedAt : run.proc.current === run,
      held: !!run.proc.held,
      nextRunId: run.nextRunId,
      pendingApprovals: run.tr.pendingApprovals(),
      liveShells: run.shared ? 0 : run.tr.liveShells().length,
      startedAt: run.startedAt,
    }));
  }

  // Unfinished turns, for self-update's busy() gate.
  const busy = () => [...runs.values()].filter((r) => !r.finishedAt && !r.proc.exited).length;

  // Process shutdown: nothing may outlive the agent, or an orphaned CLI's pid
  // view-only-locks its session.
  function destroyAll() {
    const procs = new Set();
    for (const run of runs.values()) {
      for (const t of Object.values(run.timers)) clearTimeout(t);
      procs.add(run.proc);
    }
    for (const proc of procs) {
      for (const t of Object.values(proc.timers || {})) clearTimeout(t);
      if (!proc.exited) kill(proc.child, 'SIGKILL');
    }
    if (codex && !codex.exited) kill(codex.child, 'SIGKILL');
    if (grok && !grok.exited) kill(grok.child, 'SIGKILL');
    runs.clear();
  }

  return { start, subscribe, answer, steer, submit, hold, interrupt, control, stop, rpc, recycle, servers, livePid, list, busy, destroyAll, get size() { return runs.size; } };
}

const registry = createRunRegistry();

module.exports = { createRunRegistry, registry, DEFAULTS, killTree };
