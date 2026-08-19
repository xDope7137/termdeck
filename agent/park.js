'use strict';

// Park, don't kill (LIVE-DEPLOY Phase 2). A socket close used to SIGKILL every
// CLI child on this machine — a master deploy restart, a Cloudflare idle drop,
// even a single missed pong murdered healthy in-flight turns. The link and the
// child have independent lifetimes: this registry keeps children alive across a
// dead link, buffers their output for a bounded window, and reaps them only when
// nobody comes back for them.
//
// Distributed to agent boxes under the name park.js (see AGENT_FILES in
// master.js), required by capabilities.js. Module-level singleton on purpose:
// capabilities are remade per connection (their `send` closes over one socket),
// but a parked child must survive INTO the next connection.
//
// The rolling `tail` is the piece that makes replay parseable. The master
// line-splits the stdout stream itself, and its reassembly buffer dies with the
// old process mid-line — so a park buffer that starts at an arbitrary chunk
// boundary replays a torn first line, and the frame it tears could be the
// `result`. The tail (bytes since the last '\n' we forwarded) is maintained
// ALWAYS, so the buffer can be seeded from a line boundary at the instant of
// parking. Overflow REAPS rather than truncates: a child whose buffered stream
// stopped being complete can never be re-attached honestly, and its transcript
// is on the user's disk regardless — the buffer only ever carries aliveness.
//
// Nothing here parses CLI args or stream content. `meta` is opaque master
// context (sessionId/slug/kind), echoed back in the hello inventory so the
// master can re-key survivors against its own ledger (Phase 3).

const { spawn } = require('child_process');

const DEFAULTS = {
  ttlMs: Number(process.env.TERMDECK_AGENT_PARK_TTL_MS) || 180_000, // no re-attach in 3 min → reap
  capBytes: Number(process.env.TERMDECK_AGENT_PARK_CAP_BYTES) || 8 * 1024 * 1024,
  tailCapBytes: 4 * 1024 * 1024, // a single line beyond this can't seed a boundary
  killGraceMs: 8_000,            // SIGTERM → SIGKILL escalation
  retainExitedMs: 60_000,        // keep a finished child's buffer this long after it exits parked
};

// Reap the whole process tree, not just the direct child (moved here from
// capabilities.js — one copy, both callers). The engine is often a grandchild
// of a shim/shell, and a bare kill would orphan it — its live-registry pid then
// view-only-locks the session at turn end.
function killTree(child, signal) {
  if (!child || child.pid == null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F']);
    } else {
      try { process.kill(-child.pid, signal); } // negative pid = the whole group (detached leader)
      catch { child.kill(signal); }             // not a group leader — best effort
    }
  } catch { try { child.kill(signal); } catch {} }
}

function createRegistry(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const kill = cfg.killTree || killTree;
  let gen = 0;
  const live = new Set();    // entries bound to the current connection
  const parked = new Map();  // key -> entry, survivors awaiting re-attach or TTL

  const unref = (t) => { if (t && t.unref) t.unref(); return t; };

  function newGeneration() {
    gen += 1;
    return gen;
  }

  // Called by capabilities on spawn. `persistent` mirrors the busy() exclusion:
  // the codex app-server / grok stdio child are infrastructure, not turns.
  // `sink` is the CURRENT connection's send — stored on the entry (not captured
  // in the stream handlers) because attach() swaps it for the next connection's.
  function track({ procId, child, engine, meta = null, persistent = false, sink = () => {} }) {
    const e = {
      sink,
      key: `g${gen}-${procId}`,
      procId,
      child,
      engine,
      meta: meta && typeof meta === 'object' ? meta : null,
      persistent,
      // How many turns the master says are running INSIDE this child. Only a
      // persistent one can have any: the codex app-server and the grok stdio
      // child multiplex every turn on the machine through one process, so their
      // mere existence says nothing about whether work is in flight — see
      // setTurnCount and the busy gate below.
      turns: 0,
      // 'turn' (default) or 'shell-host'. A shell host is a CLI whose turn is
      // OVER but which still owns live background shells in its process group —
      // parked deliberately and indefinitely rather than as a survivor waiting
      // to be re-adopted. See parkAsShellHost below for the three rules it
      // changes: no TTL, not busy, and named as such in the inventory.
      role: 'turn',
      startedAt: Date.now(),
      tail: Buffer.alloc(0),
      tailPoisoned: false,
      tornStart: false,
      parked: false,
      buf: [],          // [{t:'stdout'|'stderr', data:<base64>}] — replay frames, in arrival order
      bufBytes: 0,
      overflow: false,
      exited: null,     // {code, signal, error?} — recorded even while parked
      ttlTimer: null,
      escTimer: null,
    };
    live.add(e);
    return e;
  }

  // stdout only — stderr is logs, never line-critical for the master's parser.
  function updateTail(e, chunk) {
    const nl = chunk.lastIndexOf(10);
    if (nl >= 0) {
      e.tail = Buffer.from(chunk.subarray(nl + 1));
      e.tailPoisoned = false;
    } else {
      e.tail = Buffer.concat([e.tail, chunk]);
    }
    if (e.tail.length > cfg.tailCapBytes) {
      e.tail = Buffer.alloc(0);
      e.tailPoisoned = true;
    }
  }

  function pushBuf(e, stream, chunk) {
    e.buf.push({ t: stream, data: chunk.toString('base64') });
    e.bufBytes += chunk.length;
    if (e.bufBytes > cfg.capBytes && !e.exited && !e.overflow) {
      // A stream we stopped keeping whole is worse than a dead one — the
      // transcript is on disk; only re-attachability is lost. SIGKILL: the cap
      // means the gap is long or the child is roaring; either way, done waiting.
      e.overflow = true;
      kill(e.child, 'SIGKILL');
    }
  }

  // The per-chunk data handler capabilities wires at spawn. Routes to e.sink —
  // the current owner's send, swapped by attach() — never a captured closure,
  // which would belong to whichever socket happened to exist at spawn time.
  // A socket stops being OPEN the instant the peer starts closing, but `close`
  // (and park()) only fires once the handshake finishes — so there is a window,
  // milliseconds wide on a LAN and longer through a tunnel, where the entry is
  // still "live" and every chunk the sink is handed goes nowhere. It is not sent
  // and it is not buffered: it is GONE. Found live 2026-08-04 by restarting the
  // master twice inside one turn — the CLI's `result` frame landed in that window
  // on the second restart, so the turn could never end: the child stayed alive,
  // the master reported `running` forever, and the browser sat at "responding"
  // through a finished generation. A failed send is therefore a park signal, and
  // the chunk that could not be sent is the first thing buffered.
  //
  // Ordering matters: the tail is only advanced for chunks the master ACTUALLY
  // received, so seeding the buffer from it and then appending this chunk leaves
  // the replay whole and line-aligned.
  function onData(e, stream, chunk) {
    if (!e.parked) {
      const sent = e.sink({ t: stream, id: e.procId, data: chunk.toString('base64') });
      if (sent !== false) {
        if (stream === 'stdout') updateTail(e, chunk);
        return;
      }
      parkOne(e);
    }
    pushBuf(e, stream, chunk);
  }

  function onExit(e, exited) {
    e.exited = exited;
    clearTimeout(e.escTimer);
    if (!e.parked) {
      live.delete(e);
      e.sink({ t: 'exit', id: e.procId, code: exited.code, signal: exited.signal, ...(exited.error ? { error: exited.error } : {}) });
      return;
    }
    // Exited while parked: the buffer now ends with the child's final frames
    // (result included) — the HAPPY case for a gap. Keep it briefly for a
    // Phase-3 master to collect, then let go.
    clearTimeout(e.ttlTimer);
    e.ttlTimer = unref(setTimeout(() => parked.delete(e.key), cfg.retainExitedMs));
  }

  function reap(e) {
    if (e.exited) { parked.delete(e.key); return; }
    kill(e.child, 'SIGTERM');
    e.escTimer = unref(setTimeout(() => { if (!e.exited) kill(e.child, 'SIGKILL'); }, cfg.killGraceMs));
    // Entry removal rides the exit event (onExit's parked branch).
  }

  // Park ONE entry: buffer seeded at the tail's line boundary, TTL armed.
  // Idempotent — a send-failure park (onData) and the close-event park that
  // follows it must not seed the tail twice. Timers are unref'd: a parked child
  // must never be what keeps the agent process alive.
  function parkOne(e) {
    if (e.parked) return;
    e.parked = true;
    if (!e.exited) {
      if (e.tailPoisoned) e.tornStart = true;
      else if (e.tail.length) pushBuf(e, 'stdout', e.tail);
      e.tail = Buffer.alloc(0);
      // A shell host gets NO TTL. The TTL means "nobody re-attached in three
      // minutes, so this survivor is abandoned" — but a shell host is not
      // waiting to be re-attached, it is holding a dev server the user asked to
      // keep running. Arming it here would kill every background shell three
      // minutes after the turn that started it, which is the bug this whole
      // role exists to fix. It ends by reapNow() (the user, or the master when
      // the last shell exits) or by destroyAll() on self-update.
      if (e.role !== 'shell-host') e.ttlTimer = unref(setTimeout(() => reap(e), cfg.ttlMs));
    }
    live.delete(e);
    parked.set(e.key, e);
  }

  // Park a LIVE child as a shell host: its turn is done, but background shells
  // it spawned are still running inside its process group, so reaping it would
  // take them with it (killTree signals the group). The master calls this from
  // finishTurn instead of stop() when the turn ends holding live shells.
  // Returns the inventory key, which is how everything afterwards names it.
  // `meta` is merged, not replaced: the spawn-time meta names a session only when
  // the chat already existed, so a host born on a brand-new chat would otherwise
  // be unadoptable after a link gap — the master could see it in the inventory and
  // still not know whose shells it holds.
  function parkAsShellHost(procId, meta = null) {
    for (const e of live) {
      if (e.procId !== procId) continue;
      if (e.exited) return null; // nothing to hold — the CLI already died
      e.role = 'shell-host';
      if (meta && typeof meta === 'object') e.meta = { ...(e.meta || {}), ...meta };
      parkOne(e);
      return e.key;
    }
    return null;
  }

  // The host's own pid, so the master can ask proc-tree for its descendants.
  // Null once it has exited or been reaped — the caller treats that as "no
  // shells left to find".
  function parkedPid(key) {
    const e = parked.get(key);
    return e && e.child && !e.exited ? e.child.pid ?? null : null;
  }

  // The connection died — park everything still live.
  function parkAll() {
    for (const e of [...live]) parkOne(e);
    live.clear();
  }

  // Re-attach (LIVE-DEPLOY Phase 3): a new master claims a parked survivor by
  // its inventory key. The entry moves back to live under the NEW procId and the
  // NEW connection's sink, the buffer replays first (synchronously — no data
  // event can interleave mid-loop, so buffered-then-live ordering holds), and an
  // exited child's final frames end with its exit frame — the runner sees the
  // stream it would have seen with no gap at all, minus what was consumed
  // before the tail's line boundary.
  function attach(key, procId, sink) {
    const e = parked.get(key);
    if (!e) return null;
    clearTimeout(e.ttlTimer);
    clearTimeout(e.escTimer);
    parked.delete(key);
    e.procId = procId;
    e.sink = sink;
    e.parked = false;
    const frames = e.buf;
    e.buf = [];
    e.bufBytes = 0;
    for (const f of frames) sink({ t: f.t, id: procId, data: f.data });
    if (e.exited) {
      sink({ t: 'exit', id: procId, code: e.exited.code, signal: e.exited.signal, ...(e.exited.error ? { error: e.exited.error } : {}) });
      return e;
    }
    live.add(e);
    return e;
  }

  // The master looked at the inventory and disowned this child ("in inventory
  // only → reap it — never adopt a child you can't name"). Immediate, not TTL.
  function reapNow(key) {
    const e = parked.get(key);
    if (!e) return false;
    clearTimeout(e.ttlTimer);
    clearTimeout(e.escTimer);
    parked.delete(key);
    if (!e.exited) kill(e.child, 'SIGKILL');
    return true;
  }

  // Real shutdown (self-update's exit path) — nothing survives this process, so
  // nothing may outlive it either: an orphaned engine's live-registry pid
  // view-only-locks its session until someone notices.
  function destroyAll() {
    for (const e of [...live, ...parked.values()]) {
      clearTimeout(e.ttlTimer);
      clearTimeout(e.escTimer);
      if (!e.exited) kill(e.child, 'SIGKILL');
    }
    live.clear();
    parked.clear();
  }

  // What the hello frame reports: survivors a Phase-3 master can re-attach,
  // exited entries whose buffers still hold their final frames. Old masters
  // ignore the field entirely.
  function inventory() {
    return [...parked.values()].map((e) => ({
      id: e.key,
      engine: e.engine,
      startedAt: e.startedAt,
      meta: e.meta,
      persistent: e.persistent,
      // Named so the master's re-attach join can tell a shell host from a
      // survivor. Without it the join reaps every one of them on the next hello
      // ("never adopt a child you can't name") — a shell host has no ledger row,
      // because its turn already finished.
      role: e.role,
      // The survivor's OS pid. The master's only proof that a live-registry
      // entry belongs to a child it started is a pid it can name, and a
      // restarted master has no memory of the spawn — so a re-attach that
      // cannot name the pid leaves the session view-only-locked against our own
      // process and unreapable. Null once it has exited (nothing left to claim).
      pid: e.child && !e.exited ? e.child.pid ?? null : null,
      buffered: e.bufBytes,
      tornStart: e.tornStart || undefined,
      overflow: e.overflow || undefined,
      exited: e.exited || undefined,
    }));
  }

  // The master telling us a persistent child has N turns running inside it.
  // Absolute, never a delta: a lost frame heals on the next one, where a missed
  // decrement would wedge the busy gate until the TTL. Sent on every turn start
  // and end, and again after a re-attach — see lib/cloud/transport.js `turns`.
  function setTurnCount(procId, n) {
    for (const e of live) {
      if (e.procId !== procId) continue;
      e.turns = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      return true;
    }
    return false;
  }

  // A turn is running (live or parked-awaiting-reattach) — the self-update
  // busy gate. Parked turns count: updating now would orphan a child a master
  // may be seconds from re-adopting, and the TTL bounds the delay anyway.
  //
  // A persistent child counts only while a turn is actually running inside it.
  // Excluding it outright (what this did until the count existed) meant a Codex
  // chat was invisible here: the app-server is spawned once and reused, so
  // busy() read 0 with a turn mid-flight, the agent accepted a self-update, and
  // destroyAll() SIGKILLed the turn. Counting the CHILD instead would be the
  // other bug — one idle app-server would block every update forever.
  //
  // A shell host is excluded outright, because it is not a turn and is the one
  // entry here with no bound on its lifetime: counting it would block
  // self-update for as long as the user keeps a dev server running — forever,
  // in practice. destroyAll() still kills it when an update does go ahead, so
  // nothing is orphaned by the exclusion.
  const isTurn = (e) => !e.exited && e.role !== 'shell-host' && (!e.persistent || e.turns > 0);

  function turnBusy() {
    let n = 0;
    for (const e of live) if (isTurn(e)) n += 1;
    for (const e of parked.values()) if (isTurn(e)) n += 1;
    return n;
  }

  return { newGeneration, track, onData, onExit, attach, reapNow, parkAll, destroyAll, inventory, turnBusy, setTurnCount, parkAsShellHost, parkedPid, _live: live, _parked: parked };
}

// The one registry the agent actually runs on.
const registry = createRegistry();

module.exports = { createRegistry, registry, killTree };
