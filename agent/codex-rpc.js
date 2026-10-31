'use strict';

// A client for `codex app-server`: the JSON-RPC connection the native Codex harness
// is built on. Codex's own clients (the TUI, the IDE extension, Codex Desktop) speak
// this protocol to the same server, so everything here follows its definitions
// upstream (codex-rs/app-server-protocol) and the snapshot this repo pins
// (tests/fixtures/codex-protocol.json, scripts/codex-protocol.mjs).
//
// The wire is newline-delimited JSON, one message per line, in JSON-RPC 2.0's shapes
// without the `"jsonrpc"` member (rpc.rs upstream): a request has `id` and `method`,
// a notification has `method` only, a response has `id` and `result` or `error`.
// The server sends requests of its own (approvals, user input, elicitations) and
// waits on the reply, so a request nobody claims is answered with an error instead
// of leaving a turn blocked forever.
//
// Transport-agnostic: createCodexClient takes anything with write/onMessage/onClose,
// so the unit tests drive it with an in-memory pair and the agent with a child
// process (spawnCodexAppServer). No thread routing lives here; the harness above it
// decides whose a notification is (threadIdOf).

const MIN_CODEX_VERSION = '0.163.0';

const DEFAULT_TIMEOUT_MS = 30_000;

// JSON-RPC error codes the server uses (README upstream, "Shutdown admission errors").
const RPC = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
};

function codexError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

// `termdeck/0.163.0 (Ubuntu 24.4.0; x86_64) ...`: the server puts its own version
// after the client name it was given.
function versionFromUserAgent(userAgent) {
  const m = /^[^/\s]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(userAgent || ''));
  return m ? m[1] : null;
}

// `codex-cli 0.163.0`: what `codex --version` prints.
function versionFromCli(text) {
  const m = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(text || ''));
  return m ? m[1] : null;
}

// Can the native harness drive this codex? null when the version is unknown.
function meetsFloor(version, minVersion = MIN_CODEX_VERSION) {
  return version ? compareVersions(version, minVersion) >= 0 : null;
}

// -1, 0 or 1. A prerelease sorts before its release, as semver has it.
function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = null] = String(v).split('-', 2);
    return { nums: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

// The thread a message is about. Most carry `threadId`; thread/started and
// the thread/* responses carry the thread itself.
function threadIdOf(params) {
  if (!params || typeof params !== 'object') return null;
  if (typeof params.threadId === 'string' && params.threadId) return params.threadId;
  const t = params.thread;
  if (t && typeof t === 'object' && typeof t.id === 'string' && t.id) return t.id;
  return null;
}

// Newline-delimited JSON over a child's stdio. `stderr` keeps the last lines the
// server printed, which is the only explanation there is when it dies.
function lineTransport(child, { stderrLines = 50 } = {}) {
  const messageFns = [];
  const closeFns = [];
  const stderr = [];
  let closed = false;
  let buf = '';
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m && typeof m === 'object') for (const fn of messageFns) fn(m);
    }
  });
  if (child.stderr) {
    child.stderr.on('data', (d) => {
      stderr.push(String(d));
      if (stderr.length > stderrLines) stderr.shift();
    });
  }
  const gone = (code, error) => {
    if (closed) return;
    closed = true;
    const tail = stderr.join('').trim();
    const why = (error || `codex app-server exited${code != null ? ` (code ${code})` : ''}`)
      + (tail ? `\n\nstderr:\n${tail.slice(-2000)}` : '');
    for (const fn of closeFns) fn({ code, error: why });
  };
  child.on('exit', (code) => gone(code, null));
  child.on('error', (e) => gone(null, (e && e.message) || 'codex app-server failed'));
  return {
    pid: child.pid ?? null,
    write(msg) {
      if (closed) return false;
      try { child.stdin.write(JSON.stringify(msg) + '\n'); return true; } catch { return false; }
    },
    onMessage(fn) { messageFns.push(fn); },
    onClose(fn) { closeFns.push(fn); },
    get closed() { return closed; },
    stderrTail: () => stderr.join('').trim(),
    kill(signal = 'SIGTERM') { try { child.kill(signal); } catch {} },
  };
}

// One shared server per machine, as Codex Desktop runs it. `config` entries become
// `-c key=value` overrides, which is how the CLI takes them.
function spawnCodexAppServer(exe, { env = process.env, config = {}, spawnFn = require('child_process').spawn } = {}) {
  const args = ['app-server'];
  for (const [k, v] of Object.entries(config)) args.push('-c', `${k}=${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
  const child = spawnFn(exe, args, {
    env,
    shell: /\.(cmd|bat)$/i.test(exe),
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  return { child, transport: lineTransport(child) };
}

function createCodexClient({
  transport,
  clientInfo = { name: 'termdeck', version: '0.0.0' },
  capabilities = {},
  minVersion = MIN_CODEX_VERSION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  timers = { setTimeout, clearTimeout },
} = {}) {
  if (!transport) throw new Error('createCodexClient needs a transport');
  const pending = new Map(); // our id -> { method, resolve, reject, timer }
  const notificationFns = new Set();
  const requestFns = new Set();
  const closeFns = new Set();
  let nextId = 1;
  let closed = null; // { code, error } once the server is gone
  let info = null;
  let ready = null;

  function send(msg) {
    return !closed && transport.write(msg);
  }

  function settle(id, fn, value) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    timers.clearTimeout(p.timer);
    p[fn](value);
  }

  function rawRequest(method, params, opts = {}) {
    if (closed) return Promise.reject(codexError(closed.error, 'CODEX_EXITED', { method }));
    const id = nextId++;
    const ms = Number(opts.timeoutMs) || timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        pending.delete(id);
        reject(codexError(`codex ${method} timed out`, 'CODEX_RPC_TIMEOUT', { method }));
      }, ms);
      pending.set(id, { method, resolve, reject, timer });
      const msg = { id, method };
      if (params !== undefined) msg.params = params;
      if (!send(msg)) {
        timers.clearTimeout(timer);
        pending.delete(id);
        reject(codexError('codex app-server is not running', 'CODEX_DOWN', { method }));
      }
    });
  }

  function onServerRequest(m) {
    const params = m.params || {};
    for (const fn of requestFns) {
      try {
        if (fn(m.id, m.method, params, m) === true) return;
      } catch {}
    }
    send({ id: m.id, error: { code: RPC.methodNotFound, message: `Termdeck does not handle ${m.method}` } });
  }

  transport.onMessage((m) => {
    if (m.method === undefined && m.id !== undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      if (m.error) {
        const e = m.error || {};
        settle(m.id, 'reject', codexError(e.message || `codex ${p.method} failed`, 'CODEX_RPC', { rpcCode: e.code ?? null, data: e.data ?? null, method: p.method }));
      } else {
        settle(m.id, 'resolve', m.result);
      }
      return;
    }
    if (typeof m.method !== 'string') return;
    if (m.id !== undefined) return onServerRequest(m);
    const params = m.params || {};
    for (const fn of notificationFns) {
      try { fn(m.method, params, m); } catch {}
    }
  });

  transport.onClose((why) => {
    if (closed) return;
    closed = why || { code: null, error: 'codex app-server exited' };
    for (const [id] of pending) settle(id, 'reject', codexError(closed.error, 'CODEX_EXITED'));
    for (const fn of closeFns) {
      try { fn(closed); } catch {}
    }
  });

  // initialize, then `initialized`, once. Every request waits on it, so a caller
  // never has to know whether the server is up yet.
  function start() {
    if (ready) return ready;
    ready = rawRequest('initialize', {
      clientInfo,
      // experimentalApi unlocks plan mode (turn/start.collaborationMode) and the
      // approval fields the card is built from (availableDecisions).
      capabilities: { experimentalApi: true, ...capabilities },
    }).then((res) => {
      const r = res || {};
      const version = versionFromUserAgent(r.userAgent);
      info = {
        userAgent: r.userAgent || null,
        version,
        codexHome: r.codexHome || null,
        platformFamily: r.platformFamily || null,
        platformOs: r.platformOs || null,
      };
      if (minVersion && (!version || compareVersions(version, minVersion) < 0)) {
        throw codexError(`codex ${version || '(unknown version)'} is older than ${minVersion}, which Termdeck needs; update codex`, 'CODEX_TOO_OLD', { version, minVersion });
      }
      send({ method: 'initialized' });
      return info;
    });
    ready.catch(() => {});
    return ready;
  }

  return {
    start,
    async request(method, params, opts) {
      await start();
      return rawRequest(method, params, opts);
    },
    notify(method, params) {
      const msg = { method };
      if (params !== undefined) msg.params = params;
      return send(msg);
    },
    respond(id, result) {
      return send({ id, result: result === undefined ? {} : result });
    },
    respondError(id, { code = -32000, message = 'Refused by Termdeck', data } = {}) {
      const error = { code, message };
      if (data !== undefined) error.data = data;
      return send({ id, error });
    },
    // fn(method, params, raw). Returns an unsubscribe.
    onNotification(fn) { notificationFns.add(fn); return () => notificationFns.delete(fn); },
    // fn(id, method, params, raw) returns true when it took the request; the first
    // that does answers it. Returns an unsubscribe.
    onRequest(fn) { requestFns.add(fn); return () => requestFns.delete(fn); },
    onClose(fn) { closeFns.add(fn); return () => closeFns.delete(fn); },
    get info() { return info; },
    get closed() { return closed; },
    get pid() { return transport.pid ?? null; },
    pendingCount: () => pending.size,
  };
}

module.exports = {
  MIN_CODEX_VERSION,
  RPC,
  codexError,
  versionFromUserAgent,
  versionFromCli,
  meetsFloor,
  compareVersions,
  threadIdOf,
  lineTransport,
  spawnCodexAppServer,
  createCodexClient,
};
