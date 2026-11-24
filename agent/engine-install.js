'use strict';

// Installing a coding CLI from the dashboard, and the PATH that finds it after.
//
// A machine card used to show a missing engine's `npm install -g` line as text
// and nothing else: the owner had to go to the machine to run it. This runs that
// same line here. The caller names an engine and nothing more. The package is
// looked up in PACKAGES below, so a master can only ever ask for one of these
// three official packages to be installed, never a package or a command of its
// own choosing (docs/security, "What the agent will do").
//
// npm is the one next to the Node running this agent: it is the npm the
// installer required, and its global bin is where that Node's own `bin` is on
// most installs (Homebrew, nvm, the nodejs.org pkg, Windows' %APPDATA%\npm aside).
// A global folder this user cannot write (a distro Node under /usr) fails with
// EACCES, so that case retries into ~/.local, whose bin the engine resolver
// already searches first.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  grok: '@xai-official/grok',
};

// Packages that put a different program on the same command name. An earlier
// Termdeck installed @vibe-kit/grok-cli, a community CLI with no `agent stdio`,
// so every Grok chat it started failed; both packages own `grok`, and npm will
// not overwrite a bin another package owns. Installing Grok removes it first.
const REPLACES = {
  grok: ['@vibe-kit/grok-cli'],
};

const TIMEOUT_MS = 10 * 60 * 1000;
const TAIL = 4000;

// The folders an engine installed by this machine's npm can land in. launchd
// starts the agent with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so on a Mac with
// Homebrew's Node a CLI installed with `npm install -g` was invisible to the
// agent ("Not installed" on a machine that had it), and one that was found could
// not start either: its `#!/usr/bin/env node` found no node.
function binDirs({ platform = process.platform, execPath = process.execPath, env = process.env, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = [p.dirname(execPath)];
  const add = (...list) => dirs.push(...list.filter((d) => d && p.isAbsolute(d)));
  const prefix = npmPrefix({ p, env, home });
  if (platform === 'win32') {
    if (env.APPDATA) add(p.join(env.APPDATA, 'npm'));
    add(prefix);
    if (env.LOCALAPPDATA) add(p.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'), p.join(env.LOCALAPPDATA, 'pnpm'), p.join(env.LOCALAPPDATA, 'Volta', 'bin'), p.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
    add(env.PNPM_HOME, p.join(home, '.local', 'bin'), p.join(home, '.bun', 'bin'), p.join(home, 'scoop', 'shims'));
  } else {
    add(p.join(home, '.local', 'bin'));
    if (platform === 'darwin') add('/opt/homebrew/bin', '/usr/local/bin');
    if (prefix) add(p.join(prefix, 'bin'));
    add(...['.npm-global', '.npm-packages', '.volta', '.bun', '.cargo', '.yarn', '.n'].map((d) => p.join(home, d, 'bin')));
    add(env.PNPM_HOME, p.join(home, platform === 'darwin' ? 'Library/pnpm' : '.local/share/pnpm'));
    add(p.join(home, '.asdf', 'shims'), p.join(home, '.local', 'share', 'mise', 'shims'), p.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin'), p.join(home, 'bin'));
    add(...versionedBins(home, env, p));
    add(p.join(home, '.linuxbrew', 'bin'));
    if (platform === 'linux') add('/home/linuxbrew/.linuxbrew/bin', '/usr/local/bin', '/snap/bin');
  }
  return dirs;
}

// Where `npm install -g` puts things when the user moved it: the environment,
// else ~/.npmrc's `prefix`. The service never sees the shell line that usually
// goes with it (`export PATH=~/.npm-global/bin:$PATH`).
function npmPrefix({ p = path, env = process.env, home = os.homedir() } = {}) {
  let v = env.npm_config_prefix || env.NPM_CONFIG_PREFIX || '';
  if (!v) {
    try {
      for (const line of fs.readFileSync(p.join(home, '.npmrc'), 'utf8').split(/\r?\n/)) {
        const m = /^\s*prefix\s*=\s*(.+?)\s*$/.exec(line);
        if (m) v = m[1].replace(/^(["'])(.*)\1$/, '$2');
      }
    } catch {}
  }
  v = v.replace(/^~(?=[\\/]|$)/, () => home).replace(/\$\{(\w+)\}/g, (_, k) => (k === 'HOME' ? home : env[k] || ''));
  return v && p.isAbsolute(v) ? v : null;
}

// One bin per installed Node under nvm and fnm, newest first: a global CLI lives
// with the Node version that installed it. Only versions that hold an engine.
function versionedBins(home, env, p) {
  const out = [];
  const roots = [
    [env.NVM_DIR || p.join(home, '.nvm'), 'versions/node', 'bin'],
    [env.FNM_DIR || p.join(home, '.local/share/fnm'), 'node-versions', 'installation/bin'],
    [p.join(home, 'Library/Application Support/fnm'), 'node-versions', 'installation/bin'],
  ];
  for (const [root, mid, tail] of roots) {
    let names;
    try { names = fs.readdirSync(p.join(root, mid)); } catch { continue; }
    names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const n of names) {
      const bin = p.join(root, mid, n, tail);
      if (Object.keys(PACKAGES).some((k) => isFile(p.join(bin, k)))) out.push(bin);
    }
  }
  return out;
}

function isFile(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }

// Appended, never prepended: a PATH someone set on purpose keeps its order.
function widenPath(env = process.env, opts = {}) {
  const platform = opts.platform || process.platform;
  const key = platform === 'win32' ? (Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path') : 'PATH';
  const sep = platform === 'win32' ? ';' : ':';
  const have = String(env[key] || '').split(sep).filter(Boolean);
  const norm = (d) => (platform === 'win32' ? d.toLowerCase().replace(/\\+$/, '') : d.replace(/\/+$/, ''));
  const seen = new Set(have.map(norm));
  const add = (opts.dirs || binDirs({ ...opts, platform, env })).filter((d) => !seen.has(norm(d)) && (seen.add(norm(d)), true));
  if (add.length) env[key] = [...have, ...add].join(sep);
  return add;
}

// ── Whatever the fixed folders missed ───────────────────────────────────────
// No list of folders is complete, so the rest is asked of the machine: the PATH
// the user's own shell builds (their profile and rc files; on Windows the registry
// and the PowerShell profile), and the engines running right now. Asynchronous,
// time-boxed, and run only while an engine is still missing.
const MARK = '__TERMDECK_PATH__';

function ask(file, args, { timeoutMs = 8000, spawnFn = spawn, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    let out = '';
    let done = false;
    const posix = process.platform !== 'win32';
    const end = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out);
    };
    const timer = setTimeout(() => {
      try { if (posix) process.kill(-child.pid, 'SIGKILL'); else child.kill(); } catch { try { child.kill('SIGKILL'); } catch {} }
      end();
    }, timeoutMs);
    // Its own session on POSIX: an interactive shell must not touch a terminal the
    // agent was started from, and the kill above takes whatever its rc file started.
    try { child = spawnFn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: posix, windowsHide: true, env }); } catch { return end(); }
    child.stdout.on('data', (d) => { if (out.length < 4e6) out += d; });
    child.on('error', end);
    // exit, not close: a daemon the rc file left behind may hold the pipe open.
    child.on('exit', () => setTimeout(end, 100));
  });
}

function between(out) {
  const a = out.indexOf(MARK);
  const b = a < 0 ? -1 : out.indexOf(MARK, a + MARK.length);
  return b < 0 ? '' : out.slice(a + MARK.length, b);
}

const isWsl = () => process.platform === 'linux' && /microsoft/i.test(os.release());

// Absolute folders that exist. WSL's shell PATH also lists Windows' own folders,
// whose CLIs belong to the Windows side and cannot run a chat here. fnm hands each
// shell a throwaway link, so the folder behind it is kept instead.
function usableDirs(list, { wsl = isWsl() } = {}) {
  const out = [];
  for (let d of list) {
    d = d.trim().replace(/^"(.*)"$/, '$1');
    if (!d || !path.isAbsolute(d) || (wsl && /^\/mnt\/[a-z](\/|$)/i.test(d))) continue;
    try {
      if (/fnm_multishells/.test(d)) d = fs.realpathSync(d);
      if (fs.statSync(d).isDirectory()) out.push(d);
    } catch {}
  }
  return out;
}

async function shellDirs({ interactive = false, shell = null, ...opts } = {}) {
  if (process.platform === 'win32') {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `'${MARK}' + [Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + $env:Path + '${MARK}'`;
    return usableDirs(between(await ask(ps, ['-NoLogo', '-NonInteractive', ...(interactive ? [] : ['-NoProfile']), '-Command', `[Console]::Out.Write(${script})`], opts)).split(';'));
  }
  let sh = shell || process.env.SHELL;
  if (!sh) { try { sh = os.userInfo().shell; } catch {} }
  if (!sh || !path.isAbsolute(sh) || /\/(nologin|false)$/.test(sh)) sh = '/bin/sh';
  // `env` rather than $PATH: fish and others keep PATH as a list of their own.
  const cmd = `echo ${MARK}; /usr/bin/env; echo ${MARK}`;
  const csh = /csh$/.test(sh); // csh takes -l only on its own
  const out = between(await ask(sh, [interactive ? (csh ? '-ic' : '-ilc') : (csh ? '-c' : '-lc'), cmd], { ...opts, env: { ...process.env, TERM: 'dumb', TERMDECK_RESOLVING_PATH: '1' } }));
  const m = /^PATH=(.*)$/m.exec(out);
  return m ? usableDirs(m[1].split(':')) : [];
}

// The folders of engines this user is running now, which is proof of where they
// are. Only this user's own processes: another account's program is never run.
async function runningDirs(kinds, opts = {}) {
  const want = (f) => f && path.isAbsolute(f) && kinds.includes(path.basename(f)) && isFile(f);
  const dirs = [];
  if (process.platform === 'linux') {
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch {}
    const uid = process.getuid();
    for (const pid of pids) {
      try {
        if (fs.statSync(`/proc/${pid}`).uid !== uid) continue;
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, 2);
        let exe = null;
        try { exe = fs.readlinkSync(`/proc/${pid}/exe`); } catch {}
        // argv first: it names the launcher the user has, the exe what is inside it.
        const hit = [...argv, exe].find(want);
        if (hit) dirs.push(path.dirname(hit));
      } catch {}
    }
  } else if (process.platform !== 'win32') {
    const out = await ask('/bin/ps', ['-x', '-U', String(process.getuid()), '-o', 'comm='], opts);
    for (const line of out.split('\n')) if (want(line.trim())) dirs.push(path.dirname(line.trim()));
  }
  return usableDirs([...new Set(dirs)]);
}

// Widens PATH until `missing()` is empty or there is nowhere left to look. One
// search at a time; the shell is asked again at most every 15 minutes unless
// `force` (the owner pressed Recheck), since it runs the user's own startup files.
const SHELL_EVERY_MS = 15 * 60 * 1000;
function createFinder({ missing, env = process.env, widen = widenPath, shell = shellDirs, running = runningDirs, now = Date.now } = {}) {
  let busy = null;
  let shellAt = -Infinity;
  async function search(force) {
    if (!missing().length) return;
    widen(env);
    if (missing().length && (force || now() - shellAt >= SHELL_EVERY_MS)) {
      shellAt = now();
      for (const interactive of [false, true]) {
        if (!missing().length) break;
        widen(env, { dirs: await shell({ interactive }) });
      }
    }
    const left = missing();
    if (left.length) widen(env, { dirs: await running(left) });
  }
  return (force = false) => (busy = busy || search(force).catch(() => {}).finally(() => { busy = null; }));
}

function npmCommand({ platform = process.platform, execPath = process.execPath } = {}) {
  const dir = path.dirname(execPath);
  const local = path.join(dir, platform === 'win32' ? 'npm.cmd' : 'npm');
  try { if (fs.statSync(local).isFile()) return local; } catch {}
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

const permissionDenied = (text) => /\bEACCES\b|\bEPERM\b|permission denied/i.test(text);

function createInstaller({ spawnFn = spawn, npm = npmCommand, shim = null, onInstalled = () => {}, timeoutMs = TIMEOUT_MS, home = os.homedir(), platform = process.platform } = {}) {
  let current = null; // { engine, child, startedAt, tail }
  let last = null;    // { engine, ok, error, finishedAt, prefix }

  function run(engine, args, done) {
    const exe = npm();
    let file = exe;
    let argv = args;
    let opts = { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_yes: 'true', npm_config_fund: 'false', npm_config_audit: 'false' } };
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(exe) && shim) {
      const s = shim(exe, args);
      file = s.file;
      argv = s.args;
      opts = { ...opts, windowsVerbatimArguments: s.verbatim, windowsHide: true };
    }
    let child;
    try { child = spawnFn(file, argv, opts); } catch (e) { return done({ ok: false, text: e.message, code: e.code }); }
    current.child = child;
    let text = '';
    const take = (d) => {
      text = (text + d).slice(-TAIL);
      current.tail = text;
    };
    if (child.stdout) child.stdout.on('data', take);
    if (child.stderr) child.stderr.on('data', take);
    const timer = setTimeout(() => { try { child.kill(); } catch {} take('\nTimed out after 10 minutes.'); }, timeoutMs);
    if (timer.unref) timer.unref();
    let settled = false;
    const end = (r) => { if (settled) return; settled = true; clearTimeout(timer); done(r); };
    child.on('error', (e) => end({ ok: false, text: `${text}\n${e.message}`, code: e.code }));
    child.on('exit', (code) => end({ ok: code === 0, text, code }));
  }

  function finish(engine, r, prefix) {
    const why = String(r.text || '').trim().split('\n').filter(Boolean).slice(-6).join('\n');
    last = {
      engine,
      ok: r.ok,
      error: r.ok ? null : (r.code === 'ENOENT' ? 'npm was not found on this machine. Install Node.js (it includes npm), then try again.' : (why || `npm exited with code ${r.code}`)),
      finishedAt: Date.now(),
      prefix: prefix || null,
    };
    current = null;
    if (r.ok) { try { onInstalled(engine); } catch {} }
  }

  function start(engine) {
    const pkg = PACKAGES[engine];
    if (!pkg) throw Object.assign(new Error(`Unknown engine: ${engine}`), { code: 'BAD_ENGINE' });
    if (current) throw Object.assign(new Error(`Already installing ${current.engine}`), { code: 'BUSY' });
    current = { engine, child: null, startedAt: Date.now(), tail: '' };
    last = null;
    const install = () => run(engine, ['install', '-g', pkg], (r) => {
      if (r.ok || platform === 'win32' || !permissionDenied(r.text)) return finish(engine, r);
      const prefix = path.join(home, '.local');
      current.tail = '';
      run(engine, ['install', '-g', '--prefix', prefix, pkg], (r2) => finish(engine, r2, prefix));
    });
    // Removing what is not there succeeds, and a removal that fails is not this
    // install's verdict: the install that follows says whether it worked. The
    // ~/.local prefix is where a permission-denied install of it went.
    const old = REPLACES[engine] || [];
    if (!old.length) install();
    else {
      run(engine, ['uninstall', '-g', ...old], () => {
        if (platform === 'win32') return install();
        run(engine, ['uninstall', '-g', '--prefix', path.join(home, '.local'), ...old], () => install());
      });
    }
    return { started: true, engine };
  }

  function status() {
    if (current) return { inProgress: true, engine: current.engine, startedAt: current.startedAt, tail: current.tail.slice(-800) };
    return { inProgress: false, ...(last ? { engine: last.engine, result: { ok: last.ok, error: last.error, prefix: last.prefix } } : {}) };
  }

  return { start, status };
}

module.exports = { PACKAGES, REPLACES, binDirs, npmPrefix, widenPath, usableDirs, shellDirs, runningDirs, createFinder, npmCommand, createInstaller, permissionDenied };
