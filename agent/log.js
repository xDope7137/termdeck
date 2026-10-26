'use strict';

// The agent's own log, written where the person who owns the machine can read it
// and send it to us. It answers the questions a customer actually gets asked:
// what version am I on, did it update, when did it lose the connection and why,
// and was that restart something Termdeck did on purpose or something going wrong.
//
// Two rules make it safe to hand over. The machine token is redacted on the way IN
// rather than left to every caller to remember — one future log of an error object
// is all it would take otherwise. And nothing the agent *serves* is ever written
// here: no transcript contents, no prompts, no file bodies, no chat titles. Versions,
// timings and connection state only, all of which the owner can already see.

const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

// A test that never set TERMDECK_HOME used to land here on the real machine's log:
// tests/agent-capability-watch.mjs throws "close blew up" on purpose, and 259 copies
// of its stack trace sat in a real agent.log, shown in Settings, Machines, Logs. So
// a test process with no home of its own gets no file at all, only stdout. `live`
// is the one tier that runs against the real home on purpose (test.mjs).
function isTestRun(env = process.env, execArgv = process.execArgv) {
  if (env.TERMDECK_TEST_TIER === 'live') return false;
  return env.NODE_ENV === 'test' || !!env.NODE_TEST_CONTEXT || !!env.TERMDECK_TEST_TIER || execArgv.includes('--test');
}
const DISK = !!process.env.TERMDECK_HOME || !isTestRun();

const HOME_DIR = process.env.TERMDECK_HOME || path.join(os.homedir(), '.termdeck');
const LOG_DIR = path.join(HOME_DIR, 'logs');
const LOG_FILE = DISK ? path.join(LOG_DIR, 'agent.log') : null;
const PREV_FILE = DISK ? `${LOG_FILE}.1` : null;
// One rotation, one old file. A log that eats the disk is worse than a short one,
// and everything anyone has ever needed is near the end.
const MAX_BYTES = 1024 * 1024;
// The marker that turns "it restarted" into "it restarted BECAUSE". Written on a
// deliberate exit, read and cleared on the next boot; its absence is itself the
// answer (something killed us).
const EXIT_FILE = DISK ? path.join(LOG_DIR, 'last-exit') : null;

const redact = (s) => String(s).replace(/agt_[A-Za-z0-9_-]+/g, 'agt_***');

function rotate() {
  try {
    if (fs.statSync(LOG_FILE).size < MAX_BYTES) return;
    try { fs.rmSync(PREV_FILE, { force: true }); } catch {}
    fs.renameSync(LOG_FILE, PREV_FILE);
  } catch { /* no file yet, or a locked rename on Windows — never block the agent */ }
}

function write(level, message) {
  const line = `${new Date().toISOString()}  ${level.padEnd(5)}  ${redact(message)}\n`;
  if (DISK) try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotate();
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* a log that throws would take the agent with it */ }
  // Still to stdout: systemd and launchd capture it, and `node agent.js` in a
  // terminal has always behaved this way.
  try { process.stdout.write(line); } catch {}
}

const info = (m) => write('INFO', m);
const warn = (m) => write('WARN', m);
const error = (m) => write('ERROR', m);

// Has this machine ever logged anything? Distinguishes a first-ever start from a
// restart with no exit marker, which otherwise reads as a crash.
const isFirstRun = () => DISK && !fs.existsSync(LOG_FILE) && !fs.existsSync(PREV_FILE);

// Why we are about to stop. Written just before a deliberate exit.
function noteExit(reason) {
  if (DISK) try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(EXIT_FILE, String(reason));
  } catch {}
}

// ...and read back once, on the way up. Cleared so the NEXT unexplained restart
// is reported as one.
function takeExitReason() {
  if (!DISK) return null;
  try {
    const reason = fs.readFileSync(EXIT_FILE, 'utf8').trim();
    fs.rmSync(EXIT_FILE, { force: true });
    return reason || null;
  } catch { return null; }
}

const readTail = (file, bytes) => {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(Math.min(size, bytes));
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
};

// The end of the log, for the dashboard. A tail rather than the whole file because
// this crosses the tunnel on the customer's own uplink. Reaches back into the
// rotated file when the current one is short — otherwise a rotation seconds before
// someone asks would hand them an empty page.
function tail(bytes = 64 * 1024) {
  if (!DISK) return '';
  const cap = Math.max(1024, Math.min(bytes, 512 * 1024));
  let text = readTail(LOG_FILE, cap);
  if (text.length < cap) text = readTail(PREV_FILE, cap - text.length) + text;
  // A partial first line reads as corruption; drop it.
  const nl = text.indexOf('\n');
  if (text.length >= cap && nl > -1) text = text.slice(nl + 1);
  return text;
}

// A cause for any thrown value, never an empty string. "Connection problem: ." was a
// real line, eight times in one log: Node's dual-stack connect fails with an
// AggregateError whose message is empty, and plenty of socket errors carry only a
// code. The message when there is one, then the inner errors, the code, the name,
// and a short inspect as the last resort.
function describeError(e) {
  if (e === null || e === undefined) return 'unknown error';
  if (typeof e !== 'object') return String(e).trim() || 'unknown error';
  const message = String(e.message || '').trim();
  const code = e.code ? String(e.code) : '';
  if (message) return code && !message.includes(code) ? `${message} (${code})` : message;
  const inner = Array.isArray(e.errors) ? [...new Set(e.errors.map(describeError))].join('; ') : '';
  if (inner || code) return inner || code;
  const name = String(e.name || '');
  if (name && name !== 'Error') return name;
  const own = Object.keys(e);
  if (own.length) return `${name || 'Error'} ${util.inspect(Object.fromEntries(own.map((k) => [k, e[k]])), { depth: 1, breakLength: Infinity })}`.slice(0, 200);
  return `${name || 'Error'} with no message`;
}

// The last line in the log that carries a timestamp. Stack-trace lines do not, so
// this walks back past them to the line they belong to.
function lastEntry(text = tail(16 * 1024)) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i].match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+([A-Z]+)\s+(.*)$/);
    if (m && Number.isFinite(Date.parse(m[1]))) return { at: Date.parse(m[1]), level: m[2], message: m[3] };
  }
  return null;
}

// Why the previous run ended, when it left no exit marker. About half of all starts
// on one machine read "ended without stopping on purpose", which lumps a reboot in
// with a crash. The previous run's last line against the OS boot time splits them:
// a line from before the boot means the machine went down under it. A crash that got
// as far as the handlers in agent.js leaves its own ERROR line, which says so outright.
// Read it BEFORE this run writes anything, or the last line is our own.
//
// os.uptime() rather than asking WMI for LastBootUpTime: the same answer without a
// process spawn on the boot path. Windows Fast Startup resumes the kernel instead of
// booting it, so there a shutdown and power-on reads as the machine having stayed up;
// the "died" wording says that.
function previousRunEnd({ last = lastEntry(), bootedAt = Date.now() - os.uptime() * 1000 } = {}) {
  if (!last) return { kind: 'unknown' };
  if (last.level === 'ERROR' && /^Agent stopped unexpectedly/.test(last.message)) return { kind: 'crashed', lastAt: last.at, bootedAt };
  return { kind: last.at < bootedAt ? 'rebooted' : 'died', lastAt: last.at, bootedAt };
}

module.exports = { info, warn, error, tail, noteExit, takeExitReason, isFirstRun, redact, describeError, lastEntry, previousRunEnd, isTestRun, LOG_FILE };
