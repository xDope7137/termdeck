'use strict';

// Live output of a command that is still running (bugs.md B7).
//
// stream-json never carries partial Bash stdout: the CLI sends the call, then a
// `tool_progress` clock once a second, then the whole result when the command
// ends. A 40 second loop read as a frozen row. What the CLI DOES do is write a
// foreground command's output, as it runs, to a file of its own:
//
//   <tmp>/claude-<uid>/<cwd slug>/<sessionId>/tasks/<taskId>.output
//
// (Claude Code 2.1.289: the task output dir is join(realpath(tmp/claude-<uid>),
// slug, sessionId, 'tasks'), tmp being CLAUDE_CODE_TMPDIR or os.tmpdir(); the
// file is deleted when the command finishes.) And every `tool_progress` frame for
// a Bash or PowerShell call names that taskId next to the tool_use_id. So the
// agent knows which file is which call's output without asking anyone.
//
// NOT ON A PLAIN INSTALL (QA 2026-10-08 #5). Claude Code 2.1.294's stream-json
// normaliser drops bash_progress / powershell_progress, the frames that become
// those tool_progress lines, unless CLAUDE_CODE_REMOTE or CLAUDE_CODE_CONTAINER_ID
// is set (Anthropic's own hosted environments; the container id also goes out as
// an API header). So no task id reaches this module and nothing is tailed. Setting
// either variable to get it would pass a user's machine off as Anthropic's remote
// environment, which is not ours to do.
//
// So a plain install finds the file instead (QA 2026-10-12, CLI 2.1.296: the file
// is still written live and deleted on return, only its name never comes). When a
// top-level foreground shell call starts, the run notes which .output files its
// tasks dir already holds; the one new plain file that turns up after that is the
// call's. It binds only when nothing else could have made it: exactly one call is
// waiting for a file, no background shell of this run is still unnamed (its file
// lands in the same dir), and the run never started a sub-agent (whose commands
// write there too). Anything less certain shows nothing live, as before.
//
// This module tails that file for the run's own running call and hands the bytes
// to the run as `tool.output` events, which are sequenced and logged like every
// other run event, so a master that resubscribes from a seq after a link gap gets
// what it missed. Codex's app-server streams the same thing as
// item/commandExecution/outputDelta; its translator emits `tool.output` directly
// and this module only paces it.
//
// Confinement. Nothing here takes a path, or any part of one, from the master:
// the session id is the run's own and the task id comes off the CLI's stdout. Both
// are still validated to a strict shape, and the file must sit at exactly the
// layout above under this user's own scratch root, through no symlink, opened
// read-only with O_NOFOLLOW where the platform has it. Reads are size-capped
// (only the newest readBytes of a burst) and paced (one read per pollMs per call).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_RE = /^[a-z0-9]{4,40}$/i;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_SCAN = 5000;

const DEFAULTS = {
  pollMs: 500,       // one read, and at most one event, per call per this
  readBytes: 16384,  // a burst bigger than this is skipped to its newest bytes
  chunkChars: 16384, // the most text one tool.output event carries
  maxTails: 8,       // calls tailed at once in one run
  missTicks: 40,     // polls a file may stay unfound before the call is given up on
};

// os.tmpdir(), for an env that may not be this process's own (the CLI is spawned
// with the engine env, which is where its TMPDIR comes from).
function tmpdirOf(env, platform) {
  const strip = (p) => (p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p) ? p.slice(0, -1) : p);
  if (platform === 'win32') {
    const t = env.TEMP || env.TMP || (env.SystemRoot || env.windir ? `${env.SystemRoot || env.windir}\\temp` : null);
    return t ? strip(t) : os.tmpdir();
  }
  const t = env.TMPDIR || env.TMP || env.TEMP;
  return t ? strip(t) : '/tmp';
}

// The CLI's per-user scratch root: <CLAUDE_CODE_TMPDIR or tmp>/claude-<uid>. On
// Windows there is no uid and the CLI writes plain `claude` (seen on 2.1.296:
// %TEMP%\claude\<slug>\<sessionId>\tasks); `claude-0` is kept as a second guess.
function scratchRoots({ env = process.env, platform = process.platform, uid } = {}) {
  const base = env.CLAUDE_CODE_TMPDIR || tmpdirOf(env, platform);
  if (platform === 'win32') return [path.join(base, 'claude'), path.join(base, 'claude-0')];
  const id = uid === undefined ? (typeof process.getuid === 'function' ? process.getuid() : null) : uid;
  return [path.join(base, `claude-${id == null ? 0 : id}`)];
}
const scratchRoot = (opts) => scratchRoots(opts)[0];

function isRealDir(p, fsi) {
  try { const st = fsi.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
}

// Where the task's output file is, or null. The file itself may not exist yet;
// that is the caller's to poll for. Exported for tests/live-output.mjs.
function resolveTaskOutput({ taskId, ...where } = {}) {
  if (typeof taskId !== 'string' || !TASK_RE.test(taskId)) return null;
  const r = resolveTasksDir(where);
  return r && { ...r, file: path.join(r.tasksDir, `${taskId}.output`) };
}

// The task ids of the plain .output files in a tasks dir (a sub-agent's is a
// symlink and is left out), or null when the dir cannot be read.
function listOutputs(tasksDir, fsi = fs) {
  let ents;
  try { ents = fsi.readdirSync(tasksDir, { withFileTypes: true }); } catch { return null; }
  const ids = new Set();
  for (const d of ents.slice(0, MAX_SCAN)) {
    const m = /^(.+)\.output$/.exec(d.name);
    if (m && TASK_RE.test(m[1]) && d.isFile() && !d.isSymbolicLink()) ids.add(m[1]);
  }
  return ids;
}

// The session's tasks dir under this user's scratch root, or null.
function resolveTasksDir({ sessionId, cwd = null, env = process.env, platform = process.platform, uid, fsImpl = fs } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return null;
  for (const candidate of scratchRoots({ env, platform, uid })) {
    let root;
    try { root = fsImpl.realpathSync(candidate); } catch { continue; }
    if (!isRealDir(root, fsImpl)) continue;
    const r = tasksUnder(root, { sessionId, cwd, fsImpl });
    if (r) return r;
  }
  return null;
}

function tasksUnder(root, { sessionId, cwd, fsImpl }) {
  const tasksIn = (slug) => {
    if (!slug || slug === '.' || slug === '..' || /[\\/]/.test(slug)) return null;
    const proj = path.join(root, slug);
    const sess = path.join(proj, sessionId);
    const tasks = path.join(sess, 'tasks');
    return isRealDir(proj, fsImpl) && isRealDir(sess, fsImpl) && isRealDir(tasks, fsImpl) ? tasks : null;
  };
  // The CLI's slug is the cwd with every non-alphanumeric as '-'. A run in a
  // worktree, or a cwd long enough to be hashed, lands elsewhere, so a miss scans
  // the root's own directories for the session instead of guessing further.
  let tasks = typeof cwd === 'string' && cwd ? tasksIn(cwd.replace(/[^a-zA-Z0-9]/g, '-')) : null;
  if (!tasks) {
    let names = [];
    try {
      names = fsImpl.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.isSymbolicLink())
        .slice(0, MAX_SCAN)
        .map((d) => d.name);
    } catch { return null; }
    for (const n of names) { tasks = tasksIn(n); if (tasks) break; }
  }
  if (!tasks) return null;
  return { root, tasksDir: tasks };
}

// Open the output file read-only, refusing anything but a plain file at exactly
// that path. Where O_NOFOLLOW is missing (Windows) the lstat before and the fstat
// after must name the same file. Returns an fd, or null with `why` set.
function openOutput(file, fsi = fs) {
  let before;
  try { before = fsi.lstatSync(file); } catch (e) { return { fd: null, why: e && e.code === 'ENOENT' ? 'missing' : 'error' }; }
  if (before.isSymbolicLink() || !before.isFile()) return { fd: null, why: 'refused' };
  let fd;
  try { fd = fsi.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); } catch (e) {
    return { fd: null, why: e && e.code === 'ENOENT' ? 'missing' : 'refused' };
  }
  try {
    const after = fsi.fstatSync(fd);
    if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev) { fsi.closeSync(fd); return { fd: null, why: 'refused' }; }
  } catch { try { fsi.closeSync(fd); } catch {} return { fd: null, why: 'error' }; }
  return { fd, why: null };
}

// One run's tails and its pending text, driven by the run registry. `emit(run, ev)`
// pushes a finished event into the run's log.
function createLiveOutput(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const fsi = cfg.fs || fs;
  const setT = cfg.setTimeout || setTimeout;
  const clearT = cfg.clearTimeout || clearTimeout;
  const states = new WeakMap(); // run -> { tails, pend, timer, ctx }

  function stateOf(run) {
    let s = states.get(run);
    if (!s) {
      s = {
        tails: new Map(), over: new Set(), pend: new Map(), timer: null, ctx: null,
        // For finding a file by its arrival (see the header): ids already bound,
        // background shells' ids, background calls not yet named, and whether a
        // sub-agent ever ran in this run.
        claimed: new Set(), shells: new Set(), bgCalls: new Set(), subAgents: false,
      };
      states.set(run, s);
    }
    return s;
  }

  const where = (s) => ({
    sessionId: s.ctx && s.ctx.sessionId ? s.ctx.sessionId() : null,
    cwd: s.ctx && s.ctx.cwd,
    env: (s.ctx && s.ctx.env) || cfg.env || process.env,
    platform: cfg.platform || process.platform,
    uid: cfg.uid,
    fsImpl: fsi,
  });

  // Bind the one call waiting for a file to the one new file, when nothing else
  // could have made it. Returns nothing; a call left unbound is tried next poll.
  function discover(s) {
    if (s.subAgents || s.bgCalls.size) return;
    const waiting = [...s.tails.values()].filter((t) => !t.taskId);
    if (waiting.length !== 1) return;
    const t = waiting[0];
    const r = resolveTasksDir(where(s));
    const ids = r && listOutputs(r.tasksDir, fsi);
    if (!ids) return;
    const fresh = [...ids].filter((id) => !t.before.has(id) && !s.claimed.has(id) && !s.shells.has(id));
    if (fresh.length !== 1) return;
    t.taskId = fresh[0];
    s.claimed.add(t.taskId);
  }

  function add(s, id, text, skipped = 0, blockIndex = null) {
    if (!text && !skipped) return;
    const p = s.pend.get(id) || { text: '', skipped: 0, blockIndex: null };
    p.text += text || '';
    p.skipped += skipped;
    if (blockIndex != null) p.blockIndex = blockIndex;
    // Pending text is capped too: a burst between two flushes keeps its newest end.
    if (p.text.length > cfg.chunkChars) {
      p.skipped += Buffer.byteLength(p.text.slice(0, p.text.length - cfg.chunkChars));
      p.text = p.text.slice(-cfg.chunkChars);
    }
    s.pend.set(id, p);
  }

  function flush(run, s, only = null) {
    for (const [id, p] of [...s.pend]) {
      if (only !== null && id !== only) continue;
      s.pend.delete(id);
      if (!p.text && !p.skipped) continue;
      const ev = { type: 'tool.output', toolCallId: id, text: p.text };
      if (p.skipped) ev.skipped = p.skipped;
      if (p.blockIndex != null) ev.blockIndex = p.blockIndex;
      cfg.emit(run, ev);
    }
  }

  // Read what the file gained since the last look. Returns false once the tail is
  // over (the file came and went, or never came).
  function read(s, id, t) {
    // A call found by arrival has no file yet while its command waits on a prompt
    // or is starting, so it waits as long as the call does.
    if (!t.taskId) return true;
    if (!t.file) {
      const r = resolveTaskOutput({ taskId: t.taskId, ...where(s) });
      if (!r) return ++t.misses <= cfg.missTicks;
      t.file = r.file;
    }
    const { fd, why } = openOutput(t.file, fsi);
    if (fd === null) {
      if (why === 'refused') return false;
      return t.seen ? false : ++t.misses <= cfg.missTicks;
    }
    t.seen = true;
    try {
      const size = fsi.fstatSync(fd).size;
      if (size < t.offset) { t.offset = 0; t.decoder = new StringDecoder('utf8'); }
      let from = t.offset;
      let skipped = 0;
      if (size - from > cfg.readBytes) {
        skipped = size - cfg.readBytes - from;
        from = size - cfg.readBytes;
        t.decoder = new StringDecoder('utf8');
      }
      const len = size - from;
      if (len > 0 || skipped) {
        const buf = Buffer.alloc(len);
        let got = 0;
        while (got < len) {
          const n = fsi.readSync(fd, buf, got, len - got, from + got);
          if (!n) break;
          got += n;
        }
        t.offset = from + got;
        add(s, id, t.decoder.write(buf.subarray(0, got)), skipped);
      }
    } catch {
      return false;
    } finally {
      try { fsi.closeSync(fd); } catch {}
    }
    return true;
  }

  // A call is tailed once: one that ended, or was given up on, is not picked up
  // again by the progress frames still on their way.
  function end(s, id) {
    s.tails.delete(id);
    s.bgCalls.delete(id);
    s.over.add(id);
    if (s.over.size > 256) s.over.delete(s.over.values().next().value);
  }

  function tick(run) {
    const s = stateOf(run);
    s.timer = null;
    discover(s);
    for (const [id, t] of [...s.tails]) if (!read(s, id, t)) end(s, id);
    flush(run, s);
    arm(run, s);
  }

  function arm(run, s) {
    if (s.timer || (!s.tails.size && !s.pend.size)) return;
    s.timer = setT(() => tick(run), cfg.pollMs);
    if (s.timer && s.timer.unref) s.timer.unref();
  }

  function stop(run) {
    const s = states.get(run);
    if (!s) return;
    for (const [id, t] of [...s.tails]) { read(s, id, t); end(s, id); }
    flush(run, s);
    if (s.timer) clearT(s.timer);
    s.timer = null;
  }

  // Look at an event on its way into the run's log. True means it was taken here
  // (a `tool.output`, which goes out paced). Anything this flushes is emitted
  // BEFORE the event itself, so a call's output never lands after its finish.
  //
  // ctx: { engine, sessionId: () => string|null, cwd, env }
  function intercept(run, ev, ctx) {
    if (!ev || typeof ev !== 'object') return false;
    const s = stateOf(run);
    if (ctx) s.ctx = ctx;
    switch (ev.type) {
      case 'tool.output':
        if (typeof ev.toolCallId !== 'string' || typeof ev.text !== 'string') return true;
        add(s, ev.toolCallId, ev.text, Number(ev.skipped) || 0, Number.isInteger(ev.blockIndex) ? ev.blockIndex : null);
        arm(run, s);
        return true;
      case 'tool.started':
        if (!s.ctx || s.ctx.engine !== 'claude') return false;
        if (ev.toolName === 'Agent' || ev.toolName === 'Task') s.subAgents = true;
        else if (SHELL_TOOLS.has(ev.toolName) && ev.input && ev.input.run_in_background) s.bgCalls.add(ev.toolCallId);
        else if (SHELL_TOOLS.has(ev.toolName) && !s.subAgents && !s.tails.has(ev.toolCallId) && !s.over.has(ev.toolCallId) && s.tails.size < cfg.maxTails) {
          const r = resolveTasksDir(where(s));
          const before = (r && listOutputs(r.tasksDir, fsi)) || new Set();
          s.tails.set(ev.toolCallId, { taskId: null, before, file: null, offset: 0, decoder: new StringDecoder('utf8'), seen: false, misses: 0 });
          arm(run, s);
        }
        return false;
      case 'shell.started':
        if (typeof ev.shellId === 'string') s.shells.add(ev.shellId);
        return false;
      case 'tool.progress': {
        // A call already waiting by arrival takes the CLI's own name for its file.
        const waiting = s.tails.get(ev.toolCallId);
        if (waiting && !waiting.taskId && typeof ev.taskId === 'string' && TASK_RE.test(ev.taskId)) {
          waiting.taskId = ev.taskId;
          s.claimed.add(ev.taskId);
        }
        // The run's own call only: a sub-agent's commands are not on this run's rows.
        if (s.ctx && s.ctx.engine === 'claude' && !ev.parentToolCallId && typeof ev.taskId === 'string'
          && SHELL_TOOLS.has(ev.toolName) && !s.tails.has(ev.toolCallId) && !s.over.has(ev.toolCallId) && s.tails.size < cfg.maxTails
          && TASK_RE.test(ev.taskId)) {
          s.tails.set(ev.toolCallId, { taskId: ev.taskId, file: null, offset: 0, decoder: new StringDecoder('utf8'), seen: false, misses: 0 });
          if (!read(s, ev.toolCallId, s.tails.get(ev.toolCallId))) end(s, ev.toolCallId);
          flush(run, s, ev.toolCallId);
          arm(run, s);
        }
        return false;
      }
      case 'tool.finished': {
        const t = s.tails.get(ev.toolCallId);
        if (t) read(s, ev.toolCallId, t);
        end(s, ev.toolCallId);
        flush(run, s, ev.toolCallId);
        return false;
      }
      case 'run.finished':
        stop(run);
        return false;
      default:
        return false;
    }
  }

  return { intercept, stop, tailing: (run) => (states.get(run) ? states.get(run).tails.size : 0) };
}

module.exports = { createLiveOutput, resolveTaskOutput, resolveTasksDir, listOutputs, openOutput, scratchRoot, scratchRoots, tmpdirOf, SHELL_TOOLS, DEFAULTS };
