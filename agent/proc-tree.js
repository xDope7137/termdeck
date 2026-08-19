'use strict';

// Enumerate a process subtree on THIS box, and map each process to the file its
// stdout is pointed at. Both halves exist for background shells: the CLI tells us
// a shell exists and what it runs, but never its pid — and a pid is what "stop
// this one shell" needs.
//
// Matching on the command string alone is a guess: two `npm run dev` shells in one
// chat are indistinguishable, and a command that the shell rewrites (a login shell
// re-execing, a wrapper) stops matching at all. So the primary key is the stdout
// TARGET: Claude redirects each background shell's stdout to
// <tasks>/<backgroundTaskId>.output, so readlink of fd 1 names the shell exactly.
// Command matching is the fallback for platforms that can't cheaply read fd 1.
//
// Distributed to agent boxes as proc-tree.js (see AGENT_FILES in master.js) and
// required defensively by capabilities.js — an agent that pulled a new
// capabilities.js before this file landed answers AGENT_OUTDATED rather than
// crash-looping on require.
//
// No dependencies and no niche tools: /proc on Linux, `ps` on other POSIX,
// PowerShell on Windows. All three ship with the OS.

const fs = require('fs');
const { execFile } = require('child_process');

const EXEC_TIMEOUT_MS = 5000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

function run(cmd, args) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (out) => { if (!done) { done = true; resolve(out); } };
    try {
      execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER, windowsHide: true },
        (err, stdout) => finish(err && !stdout ? '' : String(stdout || '')));
    } catch { finish(''); }
  });
}

// ---------------------------------------------------------------- process list

// /proc/<pid>/stat is "pid (comm) state ppid ...", and comm is an arbitrary
// program name that may itself contain spaces and parentheses ("(sd-pam)"). Only
// the LAST ')' reliably ends it — splitting on whitespace from the left puts the
// state field where ppid should be for any such process.
function linuxRow(pid) {
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const after = stat.slice(close + 2).split(' ');
  const ppid = Number(after[1]);
  if (!Number.isFinite(ppid)) return null;
  let command = '';
  try {
    // NUL-separated argv; a kernel thread has an empty cmdline, which is fine —
    // it can never be a background shell and command is only used for display.
    command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0+$/, '').split('\0').join(' ');
  } catch { /* exited between readdir and read — treated as command-less */ }
  return { pid, ppid, command };
}

function linuxSnapshot() {
  let names = [];
  try { names = fs.readdirSync('/proc'); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const row = linuxRow(Number(name));
    if (row) out.push(row);
  }
  return out;
}

async function psSnapshot() {
  // `=` empty headers: no header line to skip and no locale-dependent column
  // widths to parse. args is last so it may contain spaces.
  const text = await run('ps', ['-eo', 'pid=,ppid=,args=']);
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
  }
  return out;
}

async function windowsSnapshot() {
  // ConvertTo-Json emits a bare object (not an array) for a single result, so the
  // parse below normalises. wmic is deprecated and absent on newer Windows, hence CIM.
  const text = await run('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
  ]);
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out = [];
  for (const r of rows) {
    if (!r || typeof r.ProcessId !== 'number') continue;
    out.push({ pid: r.ProcessId, ppid: Number(r.ParentProcessId) || 0, command: String(r.CommandLine || '') });
  }
  return out;
}

async function snapshot() {
  if (process.platform === 'linux') return linuxSnapshot();
  if (process.platform === 'win32') return windowsSnapshot();
  return psSnapshot();
}

// ------------------------------------------------------------------ stdout target

// The exact key. Linux exposes it as a symlink; macOS needs lsof (-F n = one
// field per line, prefixed by its letter, so no column parsing).
async function stdoutTarget(pid) {
  if (process.platform === 'linux') {
    try { return fs.readlinkSync(`/proc/${pid}/fd/1`); } catch { return null; }
  }
  if (process.platform === 'win32') return null; // no cheap fd→path map; command match covers it
  const text = await run('lsof', ['-a', '-p', String(pid), '-d', '1', '-Fn']);
  for (const line of text.split('\n')) if (line.startsWith('n')) return line.slice(1).trim();
  return null;
}

// ------------------------------------------------------------------------ tree

// Every descendant of rootPid, rootPid itself excluded. Walks the child index
// breadth-first with a visited set, so a ppid cycle (pid reuse mid-snapshot) can
// never spin.
function descendants(rows, rootPid) {
  const byParent = new Map();
  for (const r of rows) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const child of byParent.get(queue.shift()) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

// The whole answer for one host: its descendants, each with the file its stdout
// points at where that is knowable. Callers match `logPath` first and fall back
// to `command`.
async function list(rootPid) {
  if (typeof rootPid !== 'number' || !Number.isFinite(rootPid)) return [];
  const kids = descendants(await snapshot(), rootPid);
  return Promise.all(kids.map(async (k) => ({ ...k, logPath: await stdoutTarget(k.pid) })));
}

module.exports = { list, descendants, snapshot, stdoutTarget };
