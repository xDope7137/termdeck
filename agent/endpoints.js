'use strict';

// Which address this agent dials, and when it moves to another one.
//
// Why there is more than one: some ISPs route termdeck.io's Cloudflare addresses to a PoP
// on the far side of a bad peering link. Measured from an Airtel line in India, connects
// to the Cloudflare IPs averaged 410ms with 1.2s spikes and lost up to 42% of packets in
// bursts, while 1.1.1.1 and every Airtel hop stayed clean. That is enough to kill a
// WebSocket on a heartbeat timeout every few minutes, on a master that is perfectly
// healthy. Nobody can fix another company's peering, so the master names a second path
// (edge.termdeck.io, CloudFront in front of the same Cloudflare zone) and the agent moves
// between them on its own.
//
// The master lists the addresses on its welcome frame, primary first. The agent stays on
// the primary unless the link proves bad, moves to the next address when it does, and
// only goes back once the primary has looked healthy for five straight minutes, so a link
// that flaps does not drag the machine back and forth with it.
//
// No sockets, no timers, no files: agent.js owns all of that and asks this module what to
// do. The one piece of I/O is probe(), the bounded GET that checks an address is healthy.
// tests/edge-failover.mjs drives every rule here with a fake clock.

const num = (name, dflt) => Number(process.env[name]) || dflt;

// The agent's heartbeat cadence. Each heartbeat carries a number the master echoes back,
// which is what the link is judged by. Matches the master's own keepalive (relay.js).
const HEARTBEAT_MS = num('TERMDECK_AGENT_HEARTBEAT_MS', 10_000);
// Two heartbeats in a row with no echo: the path is losing frames, move.
const MISS_LIMIT = 2;
// ...or the median echo over the last minute is this slow. A healthy path to the nearest
// PoP answers in tens of milliseconds and the bad Airtel route in about 400; past 1.5s
// for a whole minute a chat is visibly stuttering.
const RTT_WINDOW = 6;
const RTT_HIGH_MS = num('TERMDECK_AGENT_RTT_HIGH_MS', 1500);
// Dials that fail on the path itself (no HTTP answer at all) before moving. Two, not one:
// the first dial after a laptop wakes routinely fails on DNS, and that says nothing about
// which address is better.
const DIAL_FAIL_LIMIT = 2;
// While on a fallback, how often to start checking the primary, how long it has to stay
// healthy before moving back, and how often to look during that window.
const FAILBACK_EVERY_MS = num('TERMDECK_AGENT_FAILBACK_EVERY_MS', 10 * 60_000);
const FAILBACK_TRIAL_MS = num('TERMDECK_AGENT_FAILBACK_TRIAL_MS', 5 * 60_000);
const PROBE_EVERY_MS = num('TERMDECK_AGENT_PROBE_EVERY_MS', 30_000);
// A probe is a plain GET of /healthz on the primary. It pays a fresh TLS handshake now
// and then, so it gets twice the heartbeat's budget.
const PROBE_TIMEOUT_MS = RTT_HIGH_MS * 2;

// The ordered dial list: what the master named (https or wss, either spelling), then the
// floors, each passed through `clean` (agent.js cleanOrigin, which refuses anything not
// on this install's own site) and deduplicated.
function endpointList(named, floors, clean) {
  const out = [];
  for (const raw of [...(Array.isArray(named) ? named : []), ...floors]) {
    const o = typeof raw === 'string' ? clean(raw.trim().replace(/^http/, 'ws')) : null;
    if (o && !out.includes(o)) out.push(o);
  }
  return out;
}

// Whether a dial that never reached a welcome failed on the PATH. An HTTP answer of any
// kind means the path works and something behind it said no (a 502 while the master
// restarts, a 401), and the other address leads to the same master. A clean close the
// master chose (1000, 1012, 1013, 4009) is the same. Everything else is a connect that was
// refused, reset or timed out, which is exactly what a bad route looks like.
function dialFailedOnPath({ welcomed, httpStatus, closeCode }) {
  if (welcomed || httpStatus != null) return false;
  return ![1000, 1012, 1013, 4009].includes(closeCode);
}

// Heartbeat bookkeeping for one socket.
class LinkHealth {
  constructor({ rttHighMs = RTT_HIGH_MS, window = RTT_WINDOW, missLimit = MISS_LIMIT } = {}) {
    this.rttHighMs = rttHighMs; this.window = window; this.missLimit = missLimit;
    this.n = 0; this.pending = null; this.misses = 0; this.samples = []; this.echoed = false;
  }

  // Before each heartbeat goes out. `queued` is the socket's bufferedAmount: a heartbeat
  // sent behind a megabyte of transcript waits for it, so it is neither timed nor counted
  // as missed. Returns the number to put on the frame.
  beat(now, queued) {
    const p = this.pending;
    if (p && !p.answered && !p.skip) this.misses += 1;
    this.pending = { n: ++this.n, at: now, skip: queued > 0, answered: false };
    return this.n;
  }

  // The master echoed heartbeat `n`. Returns the round trip, or null when there is none
  // worth recording (stale, duplicate, or a heartbeat that was queued).
  echo(n, now) {
    this.echoed = true;
    const p = this.pending;
    if (!p || p.n !== n || p.answered) return null;
    p.answered = true;
    this.misses = 0;
    if (p.skip) return null;
    const rtt = now - p.at;
    this.samples.push(rtt);
    if (this.samples.length > this.window) this.samples.shift();
    return rtt;
  }

  // Median of the recent round trips, or null before the first one.
  rtt() {
    if (!this.samples.length) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  // null while the link is fine, else why it is not. Nothing is judged until one echo has
  // arrived: a master older than the echo never sends one, and silence from it is not loss.
  verdict() {
    if (!this.echoed) return null;
    if (this.misses >= this.missLimit) return 'missed';
    if (this.samples.length >= this.window && this.rtt() > this.rttHighMs) return 'slow';
    return null;
  }
}

// Where in the list this agent is.
class Endpoints {
  constructor(list, active) {
    this.list = list;
    this.idx = Math.max(0, list.indexOf(active));
    this.fails = 0;
  }
  get current() { return this.list[this.idx]; }
  get primary() { return this.list[0]; }
  get onFallback() { return this.idx > 0; }

  // A welcome named a different list. Stay where we are if it is still on it.
  reset(list) {
    const cur = this.current;
    this.list = list;
    this.idx = Math.max(0, list.indexOf(cur));
    this.fails = 0;
  }
  // A dial failed on the path. True when that was the one that moves us.
  dialFailed() {
    if (++this.fails < DIAL_FAIL_LIMIT) return false;
    return this.next();
  }
  dialOk() { this.fails = 0; }
  next() {
    if (this.list.length < 2) return false;
    this.idx = (this.idx + 1) % this.list.length;
    this.fails = 0;
    return true;
  }
  home() { this.idx = 0; this.fails = 0; }
}

// The road back to the primary. Every FAILBACK_EVERY_MS a trial starts: the primary is
// probed every PROBE_EVERY_MS, and once it has answered every probe for FAILBACK_TRIAL_MS
// the agent moves back. One bad probe ends the trial and the next starts a full interval
// later.
class Failback {
  constructor({ every = FAILBACK_EVERY_MS, trial = FAILBACK_TRIAL_MS, probeEvery = PROBE_EVERY_MS } = {}) {
    this.every = every; this.trial = trial; this.probeEvery = probeEvery;
    this.nextAt = 0; this.trialFrom = 0;
  }
  start(now) { this.nextAt = now + this.every; this.trialFrom = 0; }
  // One probe's outcome. Returns 'failback' when it is time to move.
  result(ok, now) {
    if (!ok) { this.start(now); return 'wait'; }
    if (!this.trialFrom) this.trialFrom = now;
    if (now - this.trialFrom >= this.trial) return 'failback';
    this.nextAt = now + this.probeEvery;
    return 'wait';
  }
}

// One GET of /healthz on an http(s) origin. True when it answered 200 inside the budget.
// Bounded like agent.js's update download, so a probe can never hang the way a dial can.
async function probe(httpOrigin, timeoutMs = PROBE_TIMEOUT_MS) {
  const started = Date.now();
  try {
    const res = await fetch(`${httpOrigin}/healthz`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    try { await res.arrayBuffer(); } catch { /* the status is the answer */ }
    return res.status === 200 && Date.now() - started <= timeoutMs;
  } catch { return false; }
}

module.exports = {
  HEARTBEAT_MS, RTT_HIGH_MS, PROBE_TIMEOUT_MS, DIAL_FAIL_LIMIT,
  endpointList, dialFailedOnPath, LinkHealth, Endpoints, Failback, probe,
};
