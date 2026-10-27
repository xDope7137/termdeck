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
// The master lists the addresses on its welcome frame, primary first. The agent times
// every one of them before it dials and takes the fastest, then times them again every
// few minutes while connected. It moves to another address when that one is clearly
// faster two rounds running (so one lucky sample never drags a machine across), and at
// once when the link in use goes bad. A failing address is skipped for the next fastest
// one not yet tried, and once every address has failed the round starts over: there is
// always somewhere to dial, and home is always on the list.
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
// How often every address is timed while connected, and how soon a round that found a
// faster one is repeated to confirm it. Measured from an Airtel line: termdeck.io via
// Cloudflare Marseille answered /healthz in ~250ms, edge.termdeck.io via CloudFront
// Mumbai anywhere from 300 to 850ms, sample to sample. Hence a median, and two rounds.
const ROUTE_EVERY_MS = num('TERMDECK_AGENT_ROUTE_EVERY_MS', 5 * 60_000);
const ROUTE_CONFIRM_MS = num('TERMDECK_AGENT_ROUTE_CONFIRM_MS', 60_000);
const ROUTE_ROUNDS = 2;
// Timed requests per address, after one untimed one that pays for DNS and TLS.
const ROUTE_SAMPLES = 3;
// "Clearly faster": this many ms quicker AND under this share of the one in use. Below
// that the difference is noise and not worth a reconnect.
const SWITCH_MIN_MS = num('TERMDECK_AGENT_SWITCH_MIN_MS', 50);
const SWITCH_RATIO = 0.8;
// How long the agent waits on timing before its first dial. Whatever has not answered by
// then counts as unreachable for that pick.
const ROUTE_START_MS = num('TERMDECK_AGENT_ROUTE_START_MS', 5_000);
// A probe is a plain GET of /healthz. The untimed first one pays a fresh TLS handshake,
// so it gets twice this.
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

// Fastest first by the latest timings. Anything unmeasured or unreachable goes after every
// address that answered, and ties keep the master's order, so a tie goes to the primary.
function ranked(list, rtts) {
  const ms = (o) => (rtts && Number.isFinite(rtts[o]) ? rtts[o] : Infinity);
  return list.map((o, i) => ({ o, i })).sort((a, b) => ms(a.o) - ms(b.o) || a.i - b.i).map((x) => x.o);
}

// Where one round of timings says to be: the fastest address when it is clearly faster
// than `current`, or when `current` did not answer at all. Null means stay.
function better(list, current, rtts, { minMs = SWITCH_MIN_MS, ratio = SWITCH_RATIO } = {}) {
  const best = ranked(list, rtts)[0];
  if (!best || best === current || !Number.isFinite(rtts[best])) return null;
  const now = rtts[current];
  if (!Number.isFinite(now)) return best;
  return now - rtts[best] >= minMs && rtts[best] <= now * ratio ? best : null;
}

// Where in the list this agent is, and which addresses have failed it since the last
// welcome.
class Endpoints {
  constructor(list, active) {
    this.list = list;
    this.idx = Math.max(0, list.indexOf(active));
    this.fails = 0;
    this.rtts = {};
    this.tried = new Set();
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
    this.tried.clear();
  }
  // Fresh timings, and the fastest address to dial by them.
  timed(rtts) { this.rtts = { ...rtts }; return ranked(this.list, this.rtts)[0]; }
  use(origin) {
    const i = this.list.indexOf(origin);
    if (i >= 0) { this.idx = i; this.fails = 0; }
  }
  // A dial failed on the path. True when that was the one that moves us.
  dialFailed() {
    if (++this.fails < DIAL_FAIL_LIMIT) return false;
    return this.next();
  }
  // The master answered on this address, so every address is worth trying again.
  dialOk() { this.fails = 0; this.tried.clear(); }
  // The address in use let us down: go to the fastest one that has not, and when every
  // one has, start the round again from the fastest of the others. Never stuck.
  next() {
    if (this.list.length < 2) return false;
    this.tried.add(this.current);
    let left = ranked(this.list, this.rtts).filter((o) => !this.tried.has(o));
    if (!left.length) {
      this.tried = new Set([this.current]);
      left = ranked(this.list, this.rtts).filter((o) => o !== this.current);
    }
    this.idx = this.list.indexOf(left[0]);
    this.fails = 0;
    return true;
  }
}

// Moving for speed. Each round of timings votes for an address through better(); the
// agent moves once the same one has won ROUTE_ROUNDS rounds in a row. A round that says
// stay, or names someone else, starts the count over.
class Reroute {
  constructor({ rounds = ROUTE_ROUNDS } = {}) { this.rounds = rounds; this.reset(); }
  reset() { this.lead = null; this.wins = 0; }
  // True while a round has found a faster address that still needs confirming.
  get pending() { return this.wins > 0; }
  vote(winner) {
    if (!winner) { this.reset(); return null; }
    if (winner !== this.lead) { this.lead = winner; this.wins = 0; }
    if (++this.wins < this.rounds) return null;
    this.reset();
    return winner;
  }
}

// One GET of /healthz on an http(s) origin: the milliseconds it took, or null when it did
// not answer 200 inside the budget. Bounded like agent.js's update download, so a probe
// can never hang the way a dial can.
async function timed(httpOrigin, timeoutMs = PROBE_TIMEOUT_MS) {
  const started = Date.now();
  try {
    const res = await fetch(`${httpOrigin}/healthz`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    try { await res.arrayBuffer(); } catch { /* the status is the answer */ }
    const ms = Date.now() - started;
    return res.status === 200 && ms <= timeoutMs ? ms : null;
  } catch { return null; }
}
const probe = async (httpOrigin, timeoutMs) => (await timed(httpOrigin, timeoutMs)) != null;

// An address's round trip to the master: one request to open the connection, then the
// median of ROUTE_SAMPLES on the warm one, which is what a socket on it would see. Null
// when any of them fails, because a route that drops one request in four is a bad route.
async function latency(httpOrigin, { samples = ROUTE_SAMPLES, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  if (await timed(httpOrigin, timeoutMs * 2) == null) return null;
  const t = [];
  for (let i = 0; i < samples; i++) {
    const ms = await timed(httpOrigin, timeoutMs);
    if (ms == null) return null;
    t.push(ms);
  }
  return t.sort((a, b) => a - b)[Math.floor(t.length / 2)];
}

// Every address timed at once, as { origin: ms | null }. With `deadlineMs`, whatever has
// not finished by then is null, so a dead address cannot hold up a dial.
async function measure(origins, toHttp, { deadlineMs = 0, ...opts } = {}) {
  const out = Object.fromEntries(origins.map((o) => [o, null]));
  const all = Promise.all(origins.map(async (o) => { out[o] = await latency(toHttp(o), opts); }));
  if (!deadlineMs) await all;
  else {
    // Not unref'd: before the first dial this timer can be the only thing keeping the
    // process alive, and an address that never answers must not end it.
    let t;
    await Promise.race([all, new Promise((r) => { t = setTimeout(r, deadlineMs); })]);
    clearTimeout(t);
  }
  return { ...out };
}

module.exports = {
  HEARTBEAT_MS, RTT_HIGH_MS, PROBE_TIMEOUT_MS, DIAL_FAIL_LIMIT, ROUTE_EVERY_MS, ROUTE_CONFIRM_MS, ROUTE_START_MS,
  endpointList, dialFailedOnPath, LinkHealth, Endpoints, Reroute, ranked, better, timed, probe, latency, measure,
};
