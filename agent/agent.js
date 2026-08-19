'use strict';

// Termdeck thin agent (Phase B seed). Dials OUT to the master and stays connected so the
// machine shows online. Holds no valuable code — the master runs the orchestration; this
// process's whole job (once B2 lands) is to serve narrow, typed capabilities over the socket:
// readFile/list/watch the two transcript roots, spawn the installed claude/codex CLI, relay
// stdio. For now: connect, say hello, keepalive, reconnect. Deps: ws only.
//
// Env: TERMDECK_AGENT_TOKEN (required, the agt_ token), TERMDECK_MASTER_URL (http(s)://host).

const os = require('os');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execSync } = require('child_process');

// Loaded here, above the heal block, because the most valuable thing this log ever
// records is a failed update — and that happens before anything else is loaded. It
// is also the one require up here that CANNOT be allowed to throw: falling back to
// the console costs us the file, while an exception costs the machine its rollback.
let log;
try { log = require('./log'); }
catch { log = { info: console.log, warn: console.warn, error: console.error, noteExit() {}, takeExitReason: () => null, isFirstRun: () => false }; }

// ---------------------------------------------------------------------------
// Self-healing update. This block runs BEFORE every other require on purpose:
// the files it may have to restore are exactly the ones a bad update makes
// unloadable, so a recovery path sitting below `require('./capabilities')` would
// never run on the box that needs it.
//
// The contract is that an update is NOT done when the files land — it is done
// when the new code completes a handshake with the master. Until then a marker
// file says an update is in flight, and two watchdogs undo it: a boot counter
// for code that crash-loops, and a timer for code that runs but can never hand
// its way back in. A version that fails that bar is quarantined so the same push
// can't be taken twice. Rolling back lands us on an agent too old to know what a
// quarantine is, so the master carries the other half of this — an exponential
// per-machine backoff (lib/cloud/relay.js) that bounds the retry no matter which
// version is running. Between them, no failure here needs hands on the box.
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(__dirname, '.update-state.json');
const ROLLBACK_DIR = path.join(__dirname, '.rollback');
const STAGING_DIR = path.join(__dirname, '.staging');
const QUARANTINE_FILE = path.join(__dirname, '.quarantine.json');
const HEAL_MAX_BOOTS = 3;           // boots with an unconfirmed update before we undo it
const HEAL_HANDSHAKE_MS = 5 * 60 * 1000; // ...or this long running without a welcome

const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v)); } catch {} };
const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };

const quarantine = {
  has: (version) => !!version && (readJson(QUARANTINE_FILE, {}).versions || []).includes(version),
  add(version, reason) {
    if (!version) return;
    const q = readJson(QUARANTINE_FILE, {});
    // Bounded: this is a breadcrumb trail for the master, not a ledger.
    q.versions = [...new Set([...(q.versions || []), version])].slice(-10);
    q.reason = reason;
    q.at = new Date().toISOString();
    writeJson(QUARANTINE_FILE, q);
  },
};

// Put back the exact set that was running before the swap. Deliberately no npm
// install: the restored package.json can only ask for a subset of what is already
// in node_modules, and a network step is the last thing a box that is already
// broken should depend on to recover.
function restoreFiles() {
  let files = [];
  try { files = fs.readdirSync(ROLLBACK_DIR); } catch { return false; }
  for (const f of files) {
    try { fs.copyFileSync(path.join(ROLLBACK_DIR, f), path.join(__dirname, f)); } catch {}
  }
  return files.length > 0;
}

// Undo an update that got as far as running and still didn't work. Exits non-zero
// so the supervisor install.sh registered (systemd Restart / launchd KeepAlive /
// the Windows restart loop) relaunches us on the restored files.
function undoUpdate(reason) {
  const st = readJson(STATE_FILE, null);
  const restored = restoreFiles();
  if (st && st.to) quarantine.add(st.to, reason);
  rmrf(STATE_FILE);
  const to = (st && st.to) || 'a new version';
  log.error(`Update to ${to} failed and was undone: ${reason}. Put back version ${(st && st.from) || 'the previous one'}${restored ? '' : ' (nothing to restore from)'}.`);
  log.info(`Termdeck will not retry ${to} on this machine. Restarting on the working version now.`);
  log.noteExit(`rolled back from ${to}`);
  process.exit(1);
}

// Boot watchdog #1: code that crash-loops never reaches the socket, so the only
// place left to count is the boot itself.
(function healOnBoot() {
  const st = readJson(STATE_FILE, null);
  if (!st || !st.pending) return;
  st.boots = (st.boots || 0) + 1;
  if (st.boots > HEAL_MAX_BOOTS) undoUpdate(`crash-loop: ${st.boots} boots with no handshake`);
  writeJson(STATE_FILE, st);
})();

let WebSocket, makeCapabilities, ROOTS, ENGINES, VERSION;
try {
  WebSocket = require('ws');
  ({ makeCapabilities, ROOTS, ENGINES } = require('./capabilities'));
  // Single source of truth — package.json is one of the files self-update re-downloads
  // alongside this one, so a hardcoded copy here always drifts out of sync with it.
  VERSION = require('./package.json').version;
} catch (e) {
  // A require that throws immediately after an update IS the update — a new
  // capabilities.js whose new dependency didn't land, say. Name it now instead of
  // burning the whole boot budget rediscovering it.
  if (readJson(STATE_FILE, null)) undoUpdate(`load failed: ${e.message}`);
  throw e;
}

// Defensive, like capabilities.js's tail-read require: an agent that pulled this
// agent.js from a manifest fetch that failed halfway has no persistence.js, and
// reporting how it was started is never worth refusing to boot over.
let persistenceLib; try { persistenceLib = require('./persistence'); } catch { persistenceLib = null; }
const PERSISTENCE = persistenceLib ? persistenceLib.detect() : null;
// The two Windows launcher files the scheduled task starts this agent through.
// Guarded for the same reason as persistence above, and no-ops off Windows.
let winLauncher; try { winLauncher = require('./win-launcher'); } catch { winLauncher = null; }

// The opening lines of every run: what is running, and what happened to the run
// before it. "It restarted" on its own is the least useful thing a log can say.
{
  const first = log.isFirstRun();
  const why = log.takeExitReason();
  log.info(`--- Termdeck agent starting — version ${VERSION}, ${os.platform()} ${os.arch()}, Node ${process.versions.node} ---`);
  if (persistenceLib) log.info(persistenceLib.describe(PERSISTENCE));
  if (first) log.info('First start on this machine after install.');
  else if (why) log.info(`Previous run stopped on purpose: ${why}.`);
  else log.warn('Previous run ended without stopping on purpose — the machine restarted, Termdeck was closed, or the agent crashed. It has been restarted automatically.');
  // Windows only: put run.cmd / run.vbs back if they have gone. The scheduled
  // task starts this agent THROUGH them and retries every 2 minutes, and
  // wscript.exe answers a missing script with a modal dialog — so losing one is
  // not a silent failure, it is a message box on the customer's desktop 720
  // times a day. See agent/win-launcher.js.
  if (winLauncher) winLauncher.watch(log);
}

const TOKEN = process.env.TERMDECK_AGENT_TOKEN;
const MASTER = (process.env.TERMDECK_MASTER_URL || 'http://127.0.0.1:4530')
  .replace(/^http/, 'ws')   // http→ws, https→wss
  .replace(/\/$/, '');
const MASTER_HTTP = MASTER.replace(/^ws/, 'http'); // for the plain-HTTP /download/agent/* endpoint

if (!TOKEN) { console.error('TERMDECK_AGENT_TOKEN is required'); process.exit(1); }

// This agent used to POST its own errors to Datadog's log intake. That is GONE:
// the agent runs on the customer's machine, so it was the one surface that sent
// anything off that box to a third party, and it is exactly the thing the
// trust-inversion design elsewhere in this file goes out of its way to avoid.
//
// Nothing is lost locally — all four of its call sites were paired with a
// log.error/log.warn on the very next line, and agent/log.js is what the
// customer hands us anyway (redacted, bounded, rotated).

// An unexpected stop, said plainly and in the customer's own log — this is the
// line that turns "it just died" into something reportable. The stack stays out
// of it (internals are ours, not theirs); the message is enough to act on.
process.on('uncaughtException', (err) => {
  log.error(`Agent stopped unexpectedly: ${err && err.message}. It will restart automatically in a few seconds.`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log.error(`Agent stopped unexpectedly: ${err && err.message}. It will restart automatically in a few seconds.`);
  process.exit(1);
});

// Re-fetch our own 3 files from the master (same files install.sh already trusts and
// downloaded), npm install, then exit — the OS-level supervisor that install.sh registered
// (systemd Restart=always / launchd KeepAlive / the Windows restart-loop cmd) relaunches us
// with the new code. Not generic exec: the source is fixed (the master we already dialed)
// and the file set is fixed — this doesn't widen the "narrow typed capability" boundary in
// capabilities.js. Refuses while a Termdeck-owned claude/codex turn is running so a live
// session started by Termdeck isn't cut off. A terminal-held session can keep running:
// the master passes force=true when it knows Termdeck itself does not own an active turn.
const AGENT_FILES = ['agent.js', 'capabilities.js', 'park.js', 'proc-tree.js', 'log.js', 'persistence.js', 'win-launcher.js', 'limits.js', 'usage.js', 'which.js', 'diff.js', 'mcp-config.js', 'accounts.js', 'codex-accounts.js', 'session-title.js', 'tail-read.js', 'checkpoints.js', 'index-head.js', 'session-settings.js', 'session-head.js', 'transcript.js', 'claude-data.js', 'pool.js', 'project-files.js', 'machine-config.js', 'command-catalog.js', 'usage-behaviour.js', 'project-doc.js', 'package.json'];

// Compile-check before anything is installed. A truncated download, an HTML error
// page from the tunnel, a 200 with an empty body — all of them used to be written
// straight over a working file and only surface as a crash-loop at the next
// restart, which is a time bomb rather than a failed update.
function validate(file, body) {
  if (!body || !body.trim()) throw new Error(`${file}: empty response`);
  // Name the file: this string is what the master logs as "self-update declined",
  // and a bare "Unexpected end of input" doesn't tell us which of twelve broke.
  try {
    if (file.endsWith('.json')) JSON.parse(body);
    else new vm.Script(body, { filename: file });
  } catch (e) { throw new Error(`${file}: ${e.message}`); }
}
const depsOf = (src) => { try { return JSON.stringify(JSON.parse(src).dependencies || {}); } catch { return null; } };

// Deliberately OUTSIDE the pure region below, so a test can hand that region an
// instant one and not spend the real backoff proving the retry happens.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Bounds on the download half of an update ────────────────────────────────
// The fetches below used to carry no timeout at all. Measured on a customer's
// Windows VPS: `Downloading 24 files…` sat there for 8m35s and only ended when
// undici finally surfaced `terminated` — while the master had given up at its
// own 90s update RPC and written `self-update declined: update timeout` into the
// log. That reason names nothing (whose file? which failure?), and it costs the
// machine a push try: three of them and healthOf() flips the machine to
// `update-failing` and asks its owner to run a repair, over what was one dropped
// connection. The same run showed the healthy path is not far off the cliff
// either — a box that took the update needed 83s of that 90s window, because 24
// files were fetched strictly one after another.
//
// So the whole phase is bounded and the budget is set from the master's window,
// not from taste: download + a deps install must fit inside transport.js's
// UPDATE_TIMEOUT_MS with room to spare, so that what the master records is this
// agent's own error message instead of silence. tests/agent-update-bounds.mjs
// pins the two sides together.
//
// Everything between the two markers below is PURE — it reads no module state and
// touches no disk, so tests/agent-update-retry.mjs lifts the region out and runs it
// against a fake fetch. That is the only way it gets tested at all: this file dials
// the master and exits on a missing token the moment it is required, and the retry
// logic is exactly the code that only ever runs on a link nobody can reproduce. Keep
// the region free of requires, `caps`, `log` beyond warnings, and module globals.
// ── update-bounds:begin ──
const UPDATE_FETCH_TIMEOUT_MS = 15_000;    // one attempt at one file
const UPDATE_FETCH_ATTEMPTS = 3;           // a dropped tunnel is worth re-asking; a 404 is not
const UPDATE_FETCH_CONCURRENCY = 6;        // 24 files serially was 83s on a healthy box
const UPDATE_DOWNLOAD_BUDGET_MS = 45_000;  // manifest + every file + every retry
const UPDATE_NPM_TIMEOUT_MS = 120_000;     // only when the dependency set moved

// The ONE place this file talks HTTP. Everything an update pulls goes through
// here so there is no second, unbounded path to grow back later.
//
// Retries a timeout, a dropped connection and a 5xx — all three are what a flaky
// tunnel looks like from this side. Never retries a 4xx: a 404 for a file this
// master does not serve is not going to answer differently on the second ask,
// and burning the budget on it only delays naming it.
async function fetchUpdateFile(url, deadline, label) {
  // The string a support reader sees when nothing was even tried. It has to say
  // the budget ran out, or a file that was never asked for reads like a file that
  // was asked for and stayed silent.
  let last = 'not fetched — the download budget ran out first';
  for (let attempt = 1; attempt <= UPDATE_FETCH_ATTEMPTS; attempt++) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    // Whichever runs out first: this file's own patience, or what is left of the
    // whole download's budget.
    const wait = Math.min(UPDATE_FETCH_TIMEOUT_MS, left);
    try {
      // Built per attempt: an AbortSignal.timeout starts counting the moment it
      // is created, so one hoisted signal would hand attempt 3 a spent clock.
      const res = await fetch(url, { signal: AbortSignal.timeout(wait) });
      if (!res.ok) {
        if (res.status < 500) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.text();
    } catch (e) {
      // TimeoutError is what AbortSignal.timeout throws; its own message says
      // nothing about how long it waited, and that number is the whole point.
      // `wait`, not the constant: near the end of the budget the real wait is
      // shorter, and a log that rounds it up to 15s sends the reader hunting for
      // a stall that never happened.
      last = e && e.name === 'TimeoutError' ? `no answer within ${Math.max(1, Math.round(wait / 1000))}s` : (e && e.message) || String(e);
      if (e && e.fatal) break;
      if (attempt < UPDATE_FETCH_ATTEMPTS) {
        log.warn(`${label}: ${last} — retrying (attempt ${attempt + 1} of ${UPDATE_FETCH_ATTEMPTS}).`);
        await sleep(Math.min(1000 * attempt, Math.max(0, deadline - Date.now())));
      }
    }
  }
  throw new Error(`${label}: ${last}`);
}

// Fetch the set with a small amount of concurrency, into memory. Staging to disk
// stays the caller's job (and stays whole-set-then-swap) — this only shortens the
// wall clock. Bounded rather than Promise.all over 24: the machines that need
// this most are the ones on a link that a 24-way fan-out would simply drown.
async function fetchAll(files, deadline, load) {
  const out = new Map();
  let failure = null;
  let next = 0;
  const worker = async () => {
    while (failure === null) {
      const i = next++;
      if (i >= files.length) return;
      try { out.set(files[i], await load(files[i])); }
      catch (e) { if (failure === null) failure = e; return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPDATE_FETCH_CONCURRENCY, files.length) }, worker));
  if (failure) throw failure;
  return out;
}
// ── update-bounds:end ──

// ── "It will be applied when the machine is idle" ─────────────────────────────
//
// That sentence was in the log and nothing kept it. The master pushes a
// self-update on HELLO and only on hello (lib/cloud/relay.js), the agent declines
// while a turn is running, and the next attempt is therefore the next reconnect —
// which on a machine somebody is actually using lands mid-turn too. Measured on
// one box: postponed at 21:27, 00:39, 00:55, 05:22, 07:32, 07:53, 08:04, stuck on
// 0.0.85 → 0.0.88 for a day with three releases queued behind it.
//
// The failure is invisible in exactly the wrong way. The master ships a fix, the
// deploy goes green, and the machines that need it most — the busy ones — are the
// last to get it, or never do. It cost a whole release cycle here: the Codex title
// parse runs ON the agent, so a fix that was correct, tested and deployed still
// showed "(untitled)" because the parser on that disk was three versions old.
//
// So the promise gets a keeper. The declined request is remembered and retried
// once the machine goes quiet, on a cheap timer — `busy()` is a counter read, and
// this only ticks while an update is actually owed.
// Lifted out and evaluated by tests/agent-update-idle.mjs, same seam and same
// rule as the update-bounds region above: keep it free of `require`, so a
// dependency creeping in fails there as a ReferenceError rather than quietly
// going untested. `selfUpdate` is a forward reference on purpose — the test
// substitutes a recorder for it.
// ── update-idle:begin ──
const UPDATE_IDLE_RETRY_MS = 30_000;
let postponed = null; // { ws, caps, req } — the update this machine still owes

function retryUpdateWhenIdle(ws, caps, req) {
  // Only the newest request survives: the master converges to ONE version, and
  // retrying a superseded one would install something already out of date.
  postponed = { ws, caps, req: { ...req, id: null } }; // no id — the master's promise already rejected
  if (retryUpdateWhenIdle.timer) return;
  retryUpdateWhenIdle.timer = setInterval(() => {
    const owed = postponed;
    if (!owed) return;
    if (owed.caps.busy()) return; // still working — the whole point is not to cut a turn off
    postponed = null;
    clearInterval(retryUpdateWhenIdle.timer);
    retryUpdateWhenIdle.timer = null;
    log.info('This machine is idle now — applying the update that was postponed.');
    selfUpdate(owed.ws, owed.caps, owed.req);
  }, UPDATE_IDLE_RETRY_MS);
  // Never hold the process open for this: an agent whose only remaining work is a
  // pending update should still be able to exit.
  retryUpdateWhenIdle.timer.unref?.();
}
// ── update-idle:end ──

async function selfUpdate(ws, caps, req) {
  const id = req && req.id;
  const force = !!(req && req.force);
  const target = (req && req.version) || null;
  // No id means this is the idle retry firing, not the master asking: there is no
  // pending promise on the other side to answer.
  const ack = (ok, error) => { if (id && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'update', id, ok, error })); };
  log.info(`Update available from Termdeck: version ${target || 'newer'} (this machine is on ${VERSION}).`);
  if (caps.busy() && !force) {
    log.info(`Update postponed — a chat is running on this machine right now. It will be applied within ${Math.round(UPDATE_IDLE_RETRY_MS / 1000)}s of this machine going idle.`);
    retryUpdateWhenIdle(ws, caps, req);
    return void ack(false, 'busy: a Termdeck-held session is running on this machine');
  }
  // force is the operator's override for both gates — a machine that quarantined a
  // version must still be reachable from the master without anyone touching it.
  if (!force && quarantine.has(target)) {
    log.warn(`Update to ${target} refused — that version already failed to start on this machine, so it will not be tried again. Termdeck will send a different version.`);
    return void ack(false, `quarantined: ${target} already failed to come up here`);
  }
  let swapped = false;
  try {
    // One clock over the whole network phase, started before the manifest: a
    // per-file bound alone still lets 24 slow-but-not-timing-out files add up
    // past the master's window, which is the case that produced no reason at all.
    const deadline = Date.now() + UPDATE_DOWNLOAD_BUDGET_MS;
    const startedAt = Date.now();

    // Pull the file list from the master, not our own baked-in AGENT_FILES: a stale agent's
    // list can't name modules added after it shipped, so it would fetch a new capabilities.js
    // without its new deps and crash-loop on require. Fall back to the local list if an older
    // master has no manifest yet — and note the fallback is also what a TIMED-OUT manifest
    // lands on, which is right: this agent's own list is a worse answer than the master's,
    // but it is a far better one than failing the update outright.
    let files = AGENT_FILES;
    try {
      const list = JSON.parse(await fetchUpdateFile(`${MASTER_HTTP}/download/agent/manifest.json`, deadline, 'manifest.json'));
      if (Array.isArray(list) && list.length) files = list;
    } catch (e) {
      log.warn(`Could not read the file list from Termdeck (${e.message}) — using the list this version shipped with.`);
    }

    // Stage + validate the WHOLE set before touching the running install. The old
    // loop wrote each file as it arrived, so a 502 on file 7 of 12 left a half-new
    // agent on disk that kept running fine and then crash-looped at the next restart.
    log.info(`Downloading ${files.length} files for version ${target || 'the update'}…`);
    rmrf(STAGING_DIR);
    fs.mkdirSync(STAGING_DIR, { recursive: true });
    const bodies = await fetchAll(files, deadline, async (file) => {
      // The list is the master's, but it lands in a path join — keep it a plain filename.
      if (!/^[\w-]+\.(js|json)$/.test(file)) throw new Error(`${file}: refusing odd filename`);
      const body = await fetchUpdateFile(`${MASTER_HTTP}/download/agent/${file}`, deadline, file);
      validate(file, body);
      return body;
    });
    // Written only once every file is in hand and has compiled, so a staging dir
    // never holds a partial set for the swap loop below to copy out of.
    for (const file of files) fs.writeFileSync(path.join(STAGING_DIR, file), bodies.get(file));
    log.info(`Downloaded ${files.length} files in ${Math.round((Date.now() - startedAt) / 1000)}s.`);

    // Snapshot what is running now, so a rollback restores a coherent set rather
    // than whatever the last partial write left behind.
    rmrf(ROLLBACK_DIR);
    fs.mkdirSync(ROLLBACK_DIR, { recursive: true });
    for (const file of files) {
      try { fs.copyFileSync(path.join(__dirname, file), path.join(ROLLBACK_DIR, file)); } catch {} // a file we don't have yet has nothing to restore
    }

    const before = (() => { try { return depsOf(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')); } catch { return null; } })();
    swapped = true;
    for (const file of files) fs.copyFileSync(path.join(STAGING_DIR, file), path.join(__dirname, file));
    const after = depsOf(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    // Only when the dependency set actually moved. Most updates are code-only, and a
    // network step in the middle of a swap is a failure mode we can simply not have.
    // execSync (shell) so Windows resolves npm.cmd; a static command string avoids the
    // args-array-with-shell pattern Node deprecates (DEP0190) — no interpolation, no injection.
    if (before !== after) {
      log.info('Dependencies changed — installing them (this can take a minute)…');
      // Bounded like the download, and for the same reason: an npm that never
      // returns (a dead registry, a Windows AV scanning every extracted file)
      // held the master's update RPC open past its timeout, so a swap that had
      // already happened was recorded as "update timeout". SIGTERM on expiry,
      // which lands in the catch below and restores the previous files.
      execSync('npm install --omit=dev', { cwd: __dirname, stdio: 'ignore', timeout: UPDATE_NPM_TIMEOUT_MS });
    }

    // The marker that makes this reversible. Cleared only by the master's welcome.
    writeJson(STATE_FILE, { pending: true, from: VERSION, to: target, at: new Date().toISOString(), boots: 0 });
    ack(true);
  } catch (e) {
    // Restore but do NOT quarantine: this version never ran, so a transient 502 must
    // not blacklist a release that is probably fine.
    if (swapped) restoreFiles();
    log.warn(`Update to ${target || 'the new version'} could not be installed: ${e.message}. This machine is still running ${VERSION} and nothing was changed. Termdeck will try again shortly.`);
    return void ack(false, e.message);
  } finally {
    rmrf(STAGING_DIR);
  }
  log.info(`Update to ${target || 'the new version'} installed. Restarting the agent now to apply it — this machine will be offline for a few seconds.`);
  log.noteExit(`applying update to ${target || 'a new version'}`);
  // Destroy children before exiting — process.exit never fires ws close, so
  // without this the persistent codex/grok children were orphaned on every
  // update ("one idle orphan per redial", remote-codex-runner.js) and a
  // force:true update could orphan a live TURN whose registry pid then
  // view-only-locks its session. The busy() gate (which counts parked turns
  // too) keeps the normal path away from turn children entirely.
  setTimeout(() => { try { caps.destroy(); } catch {} process.exit(0); }, 200); // let the ack flush before the supervisor restarts us
}

let backoff = 1000;
// A refusal is not a dropped packet. `close` treats every ending alike and doubles to a
// 30s ceiling, which is right for a Cloudflare idle-drop and wrong for an answer the
// master is going to keep giving: one machine whose row had been deleted redialled every
// 30s for 22 hours and wrote 1,290 of the master's 2,838 ops_events rows — 45% of the
// entire admin error feed, from a single orphaned agent, which is exactly the condition
// under which a real incident goes unnoticed. So an authoritative HTTP rejection gets its
// own, far wider ceiling. It still retries, because a token re-added in the dashboard has
// to heal without anyone logging into the box; it just stops being a flood.
// One knob, because the first wait after a refusal and the ceiling it climbs to are the
// same decision at two ends. Env-overridable for exactly the reason DEAD_AFTER_MS is:
// a check has to be able to exercise the real path in milliseconds rather than half-hours.
const BACKOFF_MAX = 30_000;
const AUTH_BACKOFF_MS = Number(process.env.TERMDECK_AGENT_AUTH_BACKOFF_MS) || 60_000;
const AUTH_BACKOFF_MAX = AUTH_BACKOFF_MS * 30;
let backoffMax = BACKOFF_MAX;

function dial() {
  const ws = new WebSocket(MASTER + '/agent', {
    headers: { Authorization: `Bearer ${TOKEN}` },
    // Offer permessage-deflate so transcript/listTree frames compress on the wire.
    // threshold skips tiny control frames; master negotiates no-context-takeover.
    perMessageDeflate: { threshold: 1024 },
  });

  // Returns whether the frame actually went out. park.js needs the answer: a
  // send into a closing socket is a DROPPED frame (see its onData), and the
  // chunk has to be buffered instead of lost.
  const caps = makeCapabilities((obj) => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  });

  let heartbeat = null;
  let deadCheck = null;
  // Last time the master proved it was still there. A dropped link does NOT
  // always close the socket: the master can terminate its side (or the path can
  // die mid-flight) and this socket stays in readyState OPEN, sending heartbeats
  // into nothing, until Windows' TCP stack finally gives up — minutes, measured:
  // one machine took 71s to come back and another 6 minutes, with the box itself
  // perfectly healthy and every chat on it dark the whole time. public/js/ws.js
  // has carried this exact watchdog for the browser for the same reason
  // (KNOWN-BUGS #28); the agent simply never got it. The master beats every 30s
  // (ping + a `keepalive` data frame, lib/cloud/relay.js), so silence well past
  // two of those is a dead pipe, not a quiet one.
  const DEAD_AFTER_MS = Number(process.env.TERMDECK_AGENT_DEAD_MS) || 75_000;
  let lastFrameAt = Date.now();
  // Both endings land here and exactly one fires per dial — which is not automatic once
  // `unexpected-response` has a listener (see below), hence the guard.
  let redialled = false;
  const redial = () => {
    if (redialled) return;
    redialled = true;
    // NOT unref'd: the reconnect timer is what keeps the process alive between a
    // dropped socket and the redial. With the socket closed and caps disposed there
    // are no other handles, so an unref'd timer would let Node exit cleanly (code 0)
    // — the agent would die on the first disconnect (e.g. a master restart) instead
    // of reconnecting, and Restart=on-failure wouldn't bring back a clean exit.
    setTimeout(dial, backoff);
    backoff = Math.min(backoff * 2, backoffMax);
  };

  ws.on('open', () => {
    backoff = 1000;
    // A machine that was refused and has since been re-authorised must go straight back
    // to fast reconnects, or it would keep the half-hour ceiling for the rest of its life.
    backoffMax = BACKOFF_MAX;
    lastFrameAt = Date.now();
    deadCheck = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastFrameAt < DEAD_AFTER_MS) return;
      log.warn(`No word from Termdeck for ${Math.round((Date.now() - lastFrameAt) / 1000)}s — treating this connection as dead and reconnecting.`);
      try { ws.terminate(); } catch {} // terminate, not close: a half-open socket never completes a closing handshake
    }, Math.max(1000, Math.round(DEAD_AFTER_MS / 5)));
    // codex/grok flags gate the master's new-chat engine picker (the read layer works regardless).
    // quarantine rides along so a machine that rejected a release says so in the
    // master's log — the whole point is that nobody has to ask the customer.
    // `procs` = parked survivors of the previous connection (LIVE-DEPLOY Phase 2):
    // children that kept running across the gap, plus recently-exited ones whose
    // buffers still hold their final frames. Masters before Phase 3 ignore it.
    // `persistence` = how this agent was started, so the machine card can say
    // "stops when you log out" instead of the owner finding out at logout.
    ws.send(JSON.stringify({ type: 'hello', platform: os.platform(), version: VERSION, roots: ROOTS, codex: fs.existsSync(ENGINES.codex), grok: fs.existsSync(ENGINES.grok), procs: caps.parkedInventory(), persistence: PERSISTENCE || undefined, quarantine: readJson(QUARANTINE_FILE, null) || undefined }));
    log.info(`Connected to Termdeck (${MASTER_HTTP}). This machine is now online.`);
    // Keep the tunnel warm in the agent→master direction. Cloudflare (which fronts the
    // master for remote agents) idle-drops a WebSocket at ~100s and does NOT count WS
    // ping/pong CONTROL frames as activity — only DATA frames. Without this the only
    // agent→master traffic between capability calls is pongs, so CF severs the socket
    // on a fixed cycle. A 25s data frame (< CF's window) prevents it. The master
    // ignores unknown `type` (see lib/cloud/relay.js).
    heartbeat = setInterval(() => {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' })); } catch {}
    }, 25000);
  });
  // Capability requests from the master (readFile/stat/watch/spawn). ws auto-responds to
  // server pings with pong at the protocol level; the heartbeat above covers the tunnel.
  // Anything at all from the master proves the pipe: a keepalive, a capability
  // request, even a frame we cannot parse. Unlike a browser, we can see the
  // protocol-level ping too, so that counts as well.
  ws.on('ping', () => { lastFrameAt = Date.now(); });
  ws.on('message', (buf) => {
    lastFrameAt = Date.now();
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (m.t === 'update') return void selfUpdate(ws, caps, m);
    // The master accepted us. THIS is what makes an update permanent — not the
    // files landing, not the process starting. Cleared regardless of whether our
    // version matches what the master now wants: we are demonstrably healthy, and
    // closing a version gap is the master's job (it will just push again).
    if (m.type === 'welcome') {
      if (readJson(STATE_FILE, null)) {
        log.info(`Update to version ${VERSION} confirmed by Termdeck — it is now the version this machine keeps.`);
        rmrf(STATE_FILE);
      }
      return;
    }
    caps.handle(m);
  });
  ws.on('close', (code, reason) => {
    clearInterval(heartbeat);
    clearInterval(deadCheck);
    // PARK, don't kill (LIVE-DEPLOY Phase 2). This close fires for a master
    // deploy restart, a Cloudflare idle drop, a missed pong — none of which say
    // anything about the health of the children. They keep running, output
    // buffered from a line boundary, and the registry's TTL reaps any child no
    // master comes back for (agent/park.js).
    caps.park();
    // Codes worth naming, because they are the ones customers see and they mean
    // very different things: 1001/1006 is the network or Cloudflare dropping an
    // idle tunnel (routine, reconnects), 1000 is usually Termdeck restarting for
    // a deploy, 4001 would be the machine's access being revoked.
    const why = code === 1000 ? 'Termdeck restarted (usually a Termdeck update being released)'
      : code === 1001 || code === 1006 ? 'the network connection dropped'
      : code === 1012 || code === 1013 ? 'Termdeck asked it to reconnect'
      : `connection closed (code ${code || 'unknown'})`;
    const detail = String(reason || '').trim();
    log.info(`Disconnected from Termdeck — ${why}${detail ? `: ${detail}` : ''}. Reconnecting in ${Math.round(backoff / 1000)}s. Chats on this machine are paused until it reconnects.`);
    redial();
  });
  // ws emits this INSTEAD of error+close when the upgrade is answered with a plain HTTP
  // response, and ONLY when a listener is attached — websocket.js guards abortHandshake
  // behind `!websocket.emit('unexpected-response', …)`, and emit() is falsy exactly when
  // nothing was listening. Attaching this therefore takes ownership of the entire failure
  // path: no 'error', no 'close', so the drain, the destroy and the redial are all ours.
  // Leaving that last part out would not read as a bug here — it would silently stop the
  // agent reconnecting at all, on every machine, for every transient 5xx.
  ws.on('unexpected-response', (req, res) => {
    const status = res.statusCode;
    res.resume();                       // drain, or the socket is held open by an unread body
    try { req.destroy(); } catch {}
    caps.park();                        // symmetry with close: never kill children over a link answer
    // 401 = this token is not in the master's machines table (revoked, or the machine was
    // deleted and re-added, which mints a new one); 402 = the owner's plan no longer covers
    // this machine. Both are the master's considered answer rather than a transport
    // failure, and neither changes on the timescale of a reconnect.
    if (status === 401 || status === 402) {
      const first = backoffMax !== AUTH_BACKOFF_MAX;
      backoffMax = AUTH_BACKOFF_MAX;
      backoff = Math.max(backoff, AUTH_BACKOFF_MS);
      const fix = status === 401
        ? 'Termdeck does not recognise this machine\'s token — it was most likely removed, or re-added under another account, in the dashboard. Re-run the install command from termdeck.io/cloud to reconnect this machine.'
        : 'This machine is over the plan limit for its account. Upgrade the plan or remove another machine and it will reconnect on its own.';
      // Loud once, then quiet. This repeats until a person acts, and the agent log is the
      // thing we ask customers to send us — it has to carry the fix, not 2,000 copies of
      // the symptom.
      const every = backoffMax >= 60_000 ? `${Math.round(backoffMax / 60_000)} min` : `${Math.round(backoffMax / 1000)}s`;
      if (first) log.warn(`Termdeck refused this machine (HTTP ${status}). ${fix}`);
      else log.info(`Still refused by Termdeck (HTTP ${status}). Retrying every ${every} until it is fixed.`);
    } else {
      log.warn(`Termdeck answered this connection with HTTP ${status}. Reconnecting in ${Math.round(backoff / 1000)}s.`);
    }
    redial();
  });
  ws.on('error', (e) => {
    // Not fatal on its own — a close always follows, and that line carries the
    // reconnect. Logged because a repeated one here is the tell for a proxy or
    // firewall between this machine and Termdeck.
    log.warn(`Connection problem: ${e.message}. Will keep retrying.`);
  });
}

dial();

// Boot watchdog #2: code that runs but can never hand-shake. The boot counter
// above can't see this one — the process is perfectly happy, it just never gets
// accepted (a capability surface the master won't talk to, a socket that dials
// and dies). unref'd so it is never the reason we stay alive.
if (readJson(STATE_FILE, null)) {
  setTimeout(() => {
    if (readJson(STATE_FILE, null)) undoUpdate(`could not reach Termdeck for ${Math.round(HEAL_HANDSHAKE_MS / 60000)} minutes after updating`);
  }, HEAL_HANDSHAKE_MS).unref();
}
