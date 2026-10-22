'use strict';

// One agent per install. Found on a first-run walkthrough in a container with
// no service manager: re-running the install command started a second agent
// beside the first, both dialled in on the same token, the master turned one
// away, the two took turns being the one that was connected, and a Claude
// sign-in started on one received its code on the other.
//
// The rule is "the incumbent keeps running, a newcomer stands by". A second
// agent on the same install does not dial at all: it says so once in the log
// and waits, without an event loop or a socket, until the lock is free, then
// starts normally. That cannot turn into a fight whatever supervises the two
// (systemd, launchd, the Windows run.cmd loop, cron, a hand-started shell),
// because at no point do two of them try to displace each other. The other
// rule, "the newest kills the oldest", flaps forever as soon as each one has a
// supervisor that restarts it. The fresh install still wins, because the
// installer stops the running agent before it starts the new one.
//
// The lock is a small JSON file in the agent's home (beside agent.env, not in
// the code directory, so self-update never touches it). Whether its holder is
// still alive is the OS's answer: the pid exists and, where the OS says what a
// pid is running cheaply (Linux /proc, macOS ps), it is running agent.js. Where
// it cannot (Windows), a holder that has not refreshed the file for STALE_MS is
// treated as gone, so a reused pid cannot strand a standby forever.
//
// Two agents racing for a stale lock can both believe they won. The holder's
// heartbeat closes that: a holder that finds another live agent named in the
// file yields to it.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HEARTBEAT_MS = 30_000;
const STALE_MS = 10 * 60_000;
const STANDBY_POLL_MS = 2000;

const lockFile = (homeDir) => path.join(homeDir, 'agent.lock');

function readLock(file) {
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    return rec && Number.isInteger(rec.pid) && rec.pid > 0 ? rec : null;
  } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// What a pid is running, where the OS answers cheaply. null means "cannot tell".
function commandOf(pid) {
  if (process.platform === 'linux') {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return null; }
  }
  if (process.platform === 'darwin') {
    try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).trim() || null; } catch { return null; }
  }
  return null;
}

function holderLive(rec, file, now = Date.now()) {
  if (!rec || rec.pid === process.pid) return false;
  if (!pidAlive(rec.pid)) return false;
  const cmd = commandOf(rec.pid);
  if (cmd != null) return /agent\.js/.test(cmd);
  try { return now - fs.statSync(file).mtimeMs < STALE_MS; } catch { return false; }
}

// { held: true } or { held: false, holder }. A lock that cannot be written at all
// (read-only home, odd filesystem) is reported as held: refusing to run over a
// missing lock would turn a cosmetic problem into an offline machine.
function acquire(file, info = {}) {
  const body = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...info });
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return { held: true };
    } catch (e) {
      if (e.code !== 'EEXIST') return { held: true, unlocked: e.message };
    }
    const rec = readLock(file);
    if (rec && rec.pid === process.pid) return { held: true };
    if (holderLive(rec, file)) return { held: false, holder: rec };
    // Stale: replace it in one rename, then check we are the one it names.
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      continue;
    }
    const now = readLock(file);
    if (now && now.pid === process.pid) return { held: true };
  }
  const rec = readLock(file);
  return holderLive(rec, file) ? { held: false, holder: rec } : { held: true, unlocked: 'could not take the lock' };
}

// Block until this process holds the lock. Synchronous on purpose: it runs
// before the agent has started anything, and Atomics.wait sleeps the thread
// without an event loop, so a standby costs no CPU and holds no socket, timer
// or watcher that could do something on its behalf.
function waitForLock(file, info = {}, { onStandby = () => {}, pollMs = STANDBY_POLL_MS } = {}) {
  let r = acquire(file, info);
  if (r.held) return r;
  onStandby(r.holder);
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    Atomics.wait(cell, 0, 0, pollMs);
    r = acquire(file, info);
    if (r.held) return r;
  }
}

function release(file) {
  const rec = readLock(file);
  if (rec && rec.pid === process.pid) { try { fs.rmSync(file, { force: true }); } catch {} }
}

// While holding: refresh the file (the freshness Windows relies on), put it
// back if something removed it, and yield if another live agent now holds it.
function keep(file, info = {}, { onLost = () => {}, intervalMs = HEARTBEAT_MS } = {}) {
  const tick = () => {
    const rec = readLock(file);
    if (rec && rec.pid !== process.pid && holderLive(rec, file)) {
      clearInterval(timer);
      onLost(rec);
      return;
    }
    if (!rec || rec.pid !== process.pid) {
      try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...info })); } catch {}
      return;
    }
    const t = new Date();
    try { fs.utimesSync(file, t, t); } catch {}
  };
  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  process.on('exit', () => release(file));
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = { lockFile, readLock, acquire, waitForLock, release, keep };
