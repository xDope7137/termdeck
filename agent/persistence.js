'use strict';

// "Will this agent still be here tomorrow?" — the question the installers could
// never answer for the owner, and the reason machines quietly stop existing.
//
// deploy/install.sh registers a systemd **user** unit. Without lingering,
// systemd-logind stops the whole user manager at logout, so the agent dies when
// the person closes their SSH session or logs out of the desktop — and the
// install printed a hint about `loginctl enable-linger` into a scrollback nobody
// reads, then said "installed" in green. Same shape on the generic fallback,
// which started the agent in the background and did not survive a reboot at all,
// and on Windows when Task Scheduler refuses the task. Three ways to end up with
// a machine the dashboard calls Offline and the owner calls installed.
//
// So the agent reports HOW it was started, and the master's machine card says
// what that means. This module produces the fact; public/js/settings/fleet/
// derive.js turns it into the sentence and the fix.
//
// Two sources, in order:
//   1. `~/.termdeck/persistence.json`, written by whichever installer branch ran.
//      Authoritative for WHICH supervisor, because only the installer knows what
//      it actually registered.
//   2. Environment inference, for agents installed before this shipped and for
//      hand-rolled setups. systemd sets INVOCATION_ID on every service it starts;
//      launchd sets XPC_SERVICE_NAME to the job label. Neither costs a spawn.
//
// Lingering is checked LIVE rather than trusted from the marker, because it is
// the one part a person changes later — and it is checked without spawning
// `loginctl`, which would put a process launch on the agent's boot path for a
// question answered by one stat.
//
// `linger: null` means "could not tell" and must never be rendered as "no", the
// same rule lib/doctor.js and readiness.js draw around `loggedIn: null`. A false
// alarm here tells someone their working install is broken.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_DIR = process.env.TERMDECK_HOME || path.join(os.homedir(), '.termdeck');
const MARKER_FILE = path.join(HOME_DIR, 'persistence.json');

// The modes an install can be in. The master validates against this exact list
// before storing anything (lib/cloud/relay.js) — an agent is a customer-run
// process, so its hello is input, not truth.
const MODES = [
  'systemd-user',    // systemd --user unit. Survives reboot; survives LOGOUT only with linger.
  'systemd-system',  // system unit. Survives both, needs root to install.
  'launchd',         // macOS LaunchAgent. Starts at login, restarts on exit.
  'schtask',         // Windows scheduled task, logon trigger + 2-minute watchdog.
  'crontab',         // @reboot line. Survives reboot; no supervision beyond run.cmd-style loops.
  'foreground',      // started by hand. Dies with the terminal, the session or the reboot.
  'unknown',         // nothing said so, and nothing to infer from.
];

const LINGER_DIR = '/var/lib/systemd/linger';

// Is this user's systemd manager kept alive after logout?
//
// systemd-logind's own record is a file per user in LINGER_DIR — `loginctl
// enable-linger` creates it, `disable-linger` removes it. Reading it directly is
// exact and free. The three-valued answer matters at the edges: the directory
// not existing means logind has never enabled it for anyone (a real `false`),
// but a directory we cannot stat means we do not know, and saying `false` there
// would flag a healthy machine.
function lingerEnabled(user) {
  if (process.platform !== 'linux' || !user) return null;
  try {
    if (fs.existsSync(path.join(LINGER_DIR, user))) return true;
  } catch { /* fall through to the readability probe */ }
  try {
    // The parent exists and we can list it, so the absence above is real.
    fs.accessSync('/var/lib/systemd', fs.constants.R_OK);
    return false;
  } catch {
    return null;
  }
}

function currentUser() {
  try { return os.userInfo().username || null; } catch { return process.env.USER || process.env.USERNAME || null; }
}

function readMarker() {
  try {
    const raw = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
    return raw && MODES.includes(raw.mode) ? raw : null;
  } catch { return null; }
}

// What started us, when the installer left no marker. Cheap signals only.
function inferMode() {
  // systemd sets this on every unit it starts, user or system alike.
  if (process.env.INVOCATION_ID) {
    let root = false;
    try { root = typeof process.getuid === 'function' && process.getuid() === 0; } catch {}
    return root ? 'systemd-system' : 'systemd-user';
  }
  // launchd sets XPC_SERVICE_NAME to the job's label. A plain login shell gets
  // the literal '0', which is the one value that means "not a launchd job".
  const xpc = process.env.XPC_SERVICE_NAME;
  if (process.platform === 'darwin' && xpc && xpc !== '0') return 'launchd';
  // Windows scheduled tasks are indistinguishable from a hand-started process
  // without asking schtasks, and a spawn on the boot path is not worth it —
  // install.ps1 writes the marker instead.
  if (process.platform === 'win32') return 'unknown';
  return 'foreground';
}

// The fact, as it rides the hello frame. Small on purpose: the master stores it,
// the browser derives the sentence, and nothing here decides what it means.
function detect() {
  const marker = readMarker();
  const mode = marker ? marker.mode : inferMode();
  const linger = mode === 'systemd-user' ? lingerEnabled(currentUser()) : null;
  return { mode, linger, source: marker ? 'installer' : 'inferred' };
}

// One line for the boot log, in the words the owner would use — agent/log.js is
// written to be handed to us, and "which supervisor" is the first thing support
// asks. Never claims a weakness it only inferred.
function describe(state) {
  const p = state || detect();
  switch (p.mode) {
    case 'systemd-user':
      if (p.linger === false) {
        return 'Started by systemd (user service). It will NOT survive you logging out. Run `sudo loginctl enable-linger $USER` to fix that.';
      }
      return `Started by systemd (user service)${p.linger === true ? ', lingering enabled, so it survives logout' : ''}.`;
    case 'systemd-system': return 'Started by systemd (system service).';
    case 'launchd': return 'Started by launchd at login.';
    case 'schtask': return 'Started by the Windows scheduled task.';
    case 'crontab': return 'Started by a @reboot cron entry.';
    case 'foreground': return 'Started in the foreground, so it will NOT come back after a restart. Re-run the installer to register it properly.';
    default: return 'Started by something this agent could not identify; it may not come back after a restart.';
  }
}

// Is this the installed agent, or a copy started from somewhere else: a repo
// checkout, a worktree, a test? Only <home>/agent is what the installer registered.
// A Windows agent run from C:\...\termdeck-v2\.claude\worktrees\p00-m0\agent wrote
// run.cmd and run.vbs into that worktree, and its run.cmd sources the real
// agent.env.cmd, so anything that ran it put a second agent on the machine token.
// agent.js keeps every install-maintenance step to the copy this says is installed.
function installCopy({ dir = __dirname, home = HOME_DIR, platform = process.platform } = {}) {
  const P = platform === 'win32' ? path.win32 : path;
  const norm = (p) => {
    let r = P.resolve(p);
    try { r = fs.realpathSync(r); } catch { /* not there: compare as given */ }
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  const installedDir = P.join(home, 'agent');
  return { installed: norm(dir) === norm(installedDir), dir, installedDir };
}

// The machine tokens the installed agent runs on, read from the files the installers
// write: agent.env (install.sh) and agent.env.cmd (install.ps1). A copy that is not
// the installed one and dials with one of these takes the machine's single slot on
// the master, which turns the installed agent away for up to half an hour per try.
function installedTokens({ homes = [HOME_DIR, path.join(os.homedir(), '.termdeck')], readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const out = new Set();
  for (const home of new Set(homes)) {
    for (const name of ['agent.env', 'agent.env.cmd']) {
      let text;
      try { text = readFile(path.join(home, name)); } catch { continue; }
      for (const m of String(text).matchAll(/TERMDECK_AGENT_TOKEN=["']?(agt_[A-Za-z0-9_-]+)/g)) out.add(m[1]);
    }
  }
  return out;
}

// macOS: keep the Mac from idle-sleeping while a chat is running on it.
//
// A Mac left alone mid-turn went to sleep, the agent froze, and the turn died as
// "Machine disconnected". The master log shows the pattern on every Mac agent:
// a connect during a Power Nap wake, then "no pong within 60s" exactly 90s
// later, then nothing for an hour. `caffeinate -i` holds an idle-sleep
// assertion, the same one a download in progress takes; `-w` ties it to this
// agent's pid, so it can never outlive us. The display may still sleep, and
// closing the lid still sleeps the Mac: that is the owner's call, not ours.
// Released as soon as nothing is running, so an idle Mac sleeps as it always did.
function keepAwake({ busy, platform = process.platform, spawnFn = require('child_process').spawn, every = 5000, setIntervalFn = setInterval, pid = process.pid } = {}) {
  if (platform !== 'darwin') return { tick: () => {}, held: () => false, stop: () => {} };
  let child = null;
  let broken = false; // no caffeinate on this box: stop trying rather than spawn every tick
  const release = () => { if (child) { try { child.kill(); } catch {} child = null; } };
  function tick() {
    let want = false;
    try { want = busy() > 0; } catch {}
    if (want && !child && !broken) {
      try {
        const c = spawnFn('/usr/bin/caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' });
        child = c;
        c.on('error', () => { broken = true; if (child === c) child = null; });
        c.on('exit', () => { if (child === c) child = null; });
      } catch { broken = true; child = null; }
    } else if (!want) {
      release();
    }
  }
  const timer = setIntervalFn(tick, every);
  if (timer && timer.unref) timer.unref();
  return { tick, held: () => !!child, stop: () => { clearInterval(timer); release(); } };
}

// Linux systemd user unit: a chat's OOM-killed child must not stop the agent.
//
// Everything a chat runs (claude, codex, their linters and builds) lives in this
// unit's cgroup. With systemd's default OOMPolicy=stop, the kernel killing one
// runaway child (tsgolint at 13 GB, on the owner's own box) fails the WHOLE unit:
// the agent and every other running chat die with it, Restart=always brings it
// back, the chat retries the same lint, and the machine crash-loops.
// deploy/install.sh now writes OOMPolicy=continue into the unit; installs from
// before that get it as a drop-in here, so nobody has to re-run the installer.
// Only when /proc/self/cgroup proves we ARE termdeck-agent.service, so a
// hand-rolled unit under another name is left alone.
const UNIT_NAME = 'termdeck-agent.service';
const OOM_DROP_IN = '# Written by the Termdeck agent (agent/persistence.js ensureOomPolicy).\n[Service]\nOOMPolicy=continue\n';
function ensureOomPolicy({
  state,
  platform = process.platform,
  configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  readFile = (f) => fs.readFileSync(f, 'utf8'),
  writeFile = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); },
  spawnFn = require('child_process').spawn,
} = {}) {
  if (platform !== 'linux' || !state || state.mode !== 'systemd-user') return 'skipped';
  let cgroup = '';
  try { cgroup = readFile('/proc/self/cgroup'); } catch { return 'skipped'; }
  if (!cgroup.includes(`/${UNIT_NAME}`)) return 'skipped';
  const file = path.join(configHome, 'systemd', 'user', `${UNIT_NAME}.d`, 'oom-policy.conf');
  try { if (readFile(file) === OOM_DROP_IN) return 'present'; } catch {}
  try { writeFile(file, OOM_DROP_IN); } catch { return 'failed'; }
  // daemon-reload applies it to the running unit; no restart needed.
  try {
    const c = spawnFn('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    if (c && c.on) c.on('error', () => {});
  } catch {}
  return 'written';
}

module.exports = { detect, describe, lingerEnabled, inferMode, MODES, keepAwake, ensureOomPolicy, installCopy, installedTokens };
