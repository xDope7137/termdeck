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
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(p.join(env.APPDATA, 'npm'));
  } else {
    dirs.push(p.join(home, '.local', 'bin'));
    if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  return dirs;
}

// Appended, never prepended: a PATH someone set on purpose keeps its order.
function widenPath(env = process.env, opts = {}) {
  const platform = opts.platform || process.platform;
  const key = platform === 'win32' ? (Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path') : 'PATH';
  const sep = platform === 'win32' ? ';' : ':';
  const have = String(env[key] || '').split(sep).filter(Boolean);
  const norm = (d) => (platform === 'win32' ? d.toLowerCase().replace(/\\+$/, '') : d.replace(/\/+$/, ''));
  const seen = new Set(have.map(norm));
  const add = binDirs({ ...opts, platform, env }).filter((d) => !seen.has(norm(d)) && (seen.add(norm(d)), true));
  if (add.length) env[key] = [...have, ...add].join(sep);
  return add;
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

module.exports = { PACKAGES, REPLACES, binDirs, widenPath, npmCommand, createInstaller, permissionDenied };
