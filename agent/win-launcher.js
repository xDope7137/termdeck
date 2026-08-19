'use strict';

// The two Windows launcher files, and putting them back when they go missing.
//
// On Windows the agent is started by a scheduled task, `TermdeckAgent`, whose
// action is `wscript.exe "%USERPROFILE%\.termdeck\agent\run.vbs"`. That task has
// a REPEATING trigger — every 2 minutes, for 3650 days — because a watchdog is
// the only thing that brings the agent back after it is killed (deploy/install.ps1
// explains why AtLogOn alone does not).
//
// Which means a missing run.vbs is not a quiet failure. `wscript.exe` answers a
// path it cannot find with a MODAL DIALOG — "Can not find script file …" — and
// the trigger fires again two minutes later, and again, and again. A customer
// whose agent files were half-removed gets that box on their desktop roughly 720
// times a day, forever, and nothing about it says Termdeck.
//
// Two files can go, and neither is downloaded by the self-updater: the manifest
// is .js/.json only (agent.js `validate` refuses anything else), so an update
// never rewrites them and never notices they are gone.
//
//   run.cmd  — sources the token env and runs `node agent.js` in a restart loop.
//   run.vbs  — the windowless shim. `wscript` with intWindowStyle 0 never creates
//              a console at all, which is the whole reason it exists; cmd.exe as
//              the task action leaves a terminal on the desktop forever.
//
// So the agent checks for them while it runs and writes back whichever is gone.
// It can only help a machine whose agent is still alive — the common case,
// because the shim's job is finished the moment node is up, so it can vanish
// underneath a perfectly healthy agent and only the WATCHDOG notices. A machine
// whose agent is actually down needs the installer re-run, and nothing in here
// can change that.
//
// Bounded on purpose (see REPAIR_LIMIT): if a file keeps coming back missing,
// something is removing it deliberately — antivirus is the likely one, since a
// .vbs under a user profile launched by a scheduled task is the shape of every
// VBScript dropper ever written — and rewriting it in a loop would fight a
// scanner and produce an alert per round. Say so once and stop.

const fs = require('fs');
const os = require('os');
const path = require('path');

// deploy/install.ps1 writes these with `Set-Content -Encoding ASCII`, which is
// CRLF. A .cmd with bare LF endings is a class of Windows bug nobody enjoys
// finding, so the line ending is stated rather than inherited from this file.
const CRLF = '\r\n';

const AGENT_DIR = __dirname;
const HOME = os.homedir();
const ENV_CMD = path.join(HOME, '.termdeck', 'agent.env.cmd');
const RUN_CMD = path.join(AGENT_DIR, 'run.cmd');
const RUN_VBS = path.join(AGENT_DIR, 'run.vbs');

// Byte-for-byte the installer's, including the reasons its comments give:
// `ping` rather than `timeout` (timeout reads the console and fails outright once
// this runs windowless with no usable stdin), stdout discarded because
// agent/log.js already writes every line to the log file, stderr appended so a
// crash Node prints before our handler runs survives in the same folder.
function runCmdText() {
  return [
    '@echo off',
    `call "${ENV_CMD}"`,
    `cd /d "${AGENT_DIR}"`,
    `if not exist "${path.join(HOME, '.termdeck', 'logs')}" mkdir "${path.join(HOME, '.termdeck', 'logs')}"`,
    ':loop',
    `node agent.js >nul 2>>"${path.join(HOME, '.termdeck', 'logs', 'agent-crash.log')}"`,
    'ping -n 4 127.0.0.1 >nul',
    'goto loop',
    '',
  ].join(CRLF);
}

// Three properties matter here and all three are load-bearing:
//   the path is QUOTED  — %USERPROFILE% has a space on plenty of machines;
//   window style 0      — no console, which is the only reason this file exists;
//   bWaitOnReturn True  — the shim must block for the life of the agent. If it
//                         returned immediately the task would complete, and
//                         MultipleInstances=IgnoreNew would stop suppressing
//                         anything: the 2-minute watchdog would start a SECOND
//                         agent every 2 minutes.
function runVbsText() {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${RUN_CMD.replace(/"/g, '""')}""", 0, True`,
    '',
  ].join(CRLF);
}

const FILES = [
  { path: RUN_CMD, name: 'run.cmd', text: runCmdText },
  { path: RUN_VBS, name: 'run.vbs', text: runVbsText },
];

// How many times we will put a file back in one run of the agent. Not zero,
// because a one-off deletion is exactly what this exists to survive; not
// unbounded, because a scanner that keeps eating the file would otherwise get a
// fresh copy to alert on every hour, forever.
const REPAIR_LIMIT = 3;
let repairs = 0;
let gaveUp = false;

// Returns the names it had to rewrite. Never throws: this runs on the boot path
// and on a timer, and an agent that is otherwise working must not die because a
// launcher file could not be written.
function ensure(log) {
  if (process.platform !== 'win32' || gaveUp) return [];
  const written = [];
  for (const f of FILES) {
    try {
      if (fs.existsSync(f.path)) continue;
      if (repairs >= REPAIR_LIMIT) {
        gaveUp = true;
        log?.warn?.(
          `${f.name} keeps disappearing from ${AGENT_DIR}. Something on this machine is removing it — antivirus is the usual culprit for a .vbs — so Termdeck has stopped putting it back. Until it is allowed to stay, Windows will show "Can not find script file" every couple of minutes and the agent will not restart itself.`
        );
        return written;
      }
      fs.writeFileSync(f.path, f.text(), 'ascii');
      repairs += 1;
      written.push(f.name);
    } catch (e) {
      log?.warn?.(`Could not restore ${f.name}: ${e.message}`);
    }
  }
  if (written.length) {
    log?.info?.(
      `Restored ${written.join(' and ')} — ${written.length === 1 ? 'it was' : 'they were'} missing from ${AGENT_DIR}. Windows starts this agent through them, so without ${written.length === 1 ? 'it' : 'them'} it would not have come back after a restart.`
    );
  }
  return written;
}

// Hourly, not on a tight loop: the file only matters when the watchdog fires or
// the machine reboots, and two existsSync calls an hour is a cost worth nothing.
// unref'd so it never holds the process open.
const CHECK_MS = 60 * 60_000;

function watch(log) {
  if (process.platform !== 'win32') return null;
  ensure(log);
  const t = setInterval(() => ensure(log), CHECK_MS);
  t.unref?.();
  return t;
}

module.exports = { ensure, watch, runCmdText, runVbsText, RUN_CMD, RUN_VBS, REPAIR_LIMIT, CHECK_MS };
