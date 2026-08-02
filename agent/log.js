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

const HOME_DIR = process.env.TERMDECK_HOME || path.join(os.homedir(), '.termdeck');
const LOG_DIR = path.join(HOME_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'agent.log');
const PREV_FILE = `${LOG_FILE}.1`;
// One rotation, one old file. A log that eats the disk is worse than a short one,
// and everything anyone has ever needed is near the end.
const MAX_BYTES = 1024 * 1024;
// The marker that turns "it restarted" into "it restarted BECAUSE". Written on a
// deliberate exit, read and cleared on the next boot; its absence is itself the
// answer (something killed us).
const EXIT_FILE = path.join(LOG_DIR, 'last-exit');

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
  try {
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
const isFirstRun = () => !fs.existsSync(LOG_FILE) && !fs.existsSync(PREV_FILE);

// Why we are about to stop. Written just before a deliberate exit.
function noteExit(reason) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(EXIT_FILE, String(reason));
  } catch {}
}

// ...and read back once, on the way up. Cleared so the NEXT unexplained restart
// is reported as one.
function takeExitReason() {
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
  const cap = Math.max(1024, Math.min(bytes, 512 * 1024));
  let text = readTail(LOG_FILE, cap);
  if (text.length < cap) text = readTail(PREV_FILE, cap - text.length) + text;
  // A partial first line reads as corruption; drop it.
  const nl = text.indexOf('\n');
  if (text.length >= cap && nl > -1) text = text.slice(nl + 1);
  return text;
}

module.exports = { info, warn, error, tail, noteExit, takeExitReason, isFirstRun, redact, LOG_FILE, LOG_DIR };
