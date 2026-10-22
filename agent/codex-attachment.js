'use strict';

// Which Codex threads are held by a live Codex process on this machine.
//
// A rollout lifecycle answers whether a TURN is running. It cannot answer
// whether the thread is still open in a TUI, Desktop, VS Code, or an app-server
// daemon after that turn finishes. Codex enforces that second fact with a
// process-held writer lock. This module reads the process/lock boundary where
// the machine lives and returns only thread ids and holder pids; no transcript
// bytes cross the agent tunnel.
//
// Modern Codex releases keep
//   $CODEX_HOME/thread-writer-locks/<thread-id>.lock
// open and exclusively locked for the whole time a thread is loaded. Older
// releases keep the rollout itself open instead. Linux and macOS can identify
// both from open file handles. Windows cannot enumerate handles with a stock
// Node API, so a short PowerShell helper attempts the same non-blocking
// LockFileEx call Codex uses and reports only files whose lock is held.

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;
const EXEC_TIMEOUT_MS = 8000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

function runFile(command, args, options = {}) {
  return new Promise((resolve) => {
    try {
      execFile(command, args, {
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        windowsHide: true,
        ...options,
      }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout || ''), error: error || null }));
    } catch (error) {
      resolve({ ok: false, stdout: '', error });
    }
  });
}

function cleanOpenPath(value) {
  const text = String(value || '').trim();
  return text.endsWith(' (deleted)') ? text.slice(0, -10) : text;
}

function under(root, target, pathmod = path) {
  const base = pathmod.resolve(root);
  const value = pathmod.resolve(cleanOpenPath(target));
  return value === base || value.startsWith(base + pathmod.sep);
}

// Returns { sessionId, exact }. A writer-lock handle is the exact ownership
// fact. A rollout handle is the legacy fallback used only when this Codex home
// has no writer-lock directory at all.
function sessionFromOpenPath(target, codexHome, { writerLocks = true, pathmod = path } = {}) {
  const value = cleanOpenPath(target);
  const lockDir = pathmod.join(codexHome, 'thread-writer-locks');
  if (under(lockDir, value, pathmod)) {
    const name = pathmod.basename(value);
    const id = name.endsWith('.lock') ? name.slice(0, -5) : '';
    return UUID_RE.test(id) ? { sessionId: id, exact: true } : null;
  }
  if (writerLocks) return null;
  const sessionsDir = pathmod.join(codexHome, 'sessions');
  if (!under(sessionsDir, value, pathmod)) return null;
  const match = ROLLOUT_RE.exec(pathmod.basename(value));
  return match ? { sessionId: match[1], exact: false } : null;
}

function sessionFromCommand(command) {
  const text = String(command || '');
  // A command-line id is only a positive fallback. `codex resume --last` and a
  // newly-created `codex` TUI carry no id, so absence never proves a thread free.
  const match = /(?:^|\s)(?:resume\s+|--thread(?:=|\s+))([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=\s|$)/i.exec(text);
  return match ? match[1] : null;
}

function codexProcess(command, executable = '') {
  const base = path.basename(String(executable || '')).toLowerCase();
  if (base === 'codex' || base === 'codex.exe') return true;
  const first = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(String(command || ''));
  const arg0 = first && (first[1] || first[2] || first[3]);
  const name = path.basename(String(arg0 || '')).toLowerCase();
  return name === 'codex' || name === 'codex.exe';
}

function parsePsRows(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid)) continue;
    rows.push({ pid, executable: match[2], command: match[3] || match[2] });
  }
  return rows;
}

// `-F pRn`: a `p` line opens a process, its `R` line names the parent, and
// each `n` line is one open file of it. The parent is optional so output from
// an lsof that ignores `R` still parses.
function parseLsof(text) {
  const rows = [];
  let pid = null;
  let ppid = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('p')) {
      const value = Number(line.slice(1));
      pid = Number.isFinite(value) ? value : null;
      ppid = null;
    } else if (line.startsWith('R') && pid != null) {
      const value = Number(line.slice(1));
      ppid = Number.isFinite(value) ? value : null;
    } else if (line.startsWith('n') && pid != null) {
      rows.push(ppid != null ? { pid, ppid, path: line.slice(1) } : { pid, path: line.slice(1) });
    }
  }
  return rows;
}

// `ppid` rides along when the scan could read it. The npm install of Codex is a
// node shim that spawns the native binary, and the native child is the one
// holding the writer lock, so the pid Termdeck spawned is the HOLDER'S PARENT.
// Without it the runner cannot recognise its own app-server and locks its own
// chat view-only the moment a turn ends.
function addSession(map, sessionId, pid, source, ppid = null) {
  if (!UUID_RE.test(String(sessionId || ''))) return;
  const next = { sessionId: String(sessionId), pid: Number.isFinite(pid) ? pid : null, source };
  if (Number.isFinite(ppid)) next.ppid = ppid;
  const prev = map.get(next.sessionId);
  // Exact writer-lock evidence wins over the old rollout-fd fallback. Otherwise
  // keep the first stable holder seen in this snapshot.
  if (!prev || (prev.source !== 'writer-lock' && source === 'writer-lock')) map.set(next.sessionId, next);
}

async function hasDirectory(dir, io = fsp) {
  try {
    const stat = await io.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function scanLinux(codexHome, { io = fsp } = {}) {
  let procNames;
  try {
    procNames = (await io.readdir('/proc')).filter((name) => /^\d+$/.test(String(name)));
  } catch {
    return { known: false, sessions: [] };
  }
  const lockDir = path.posix.join(codexHome, 'thread-writer-locks');
  const writerLocks = await hasDirectory(lockDir, io);
  const found = new Map();
  await Promise.all(procNames.map(async (name) => {
    const pid = Number(name);
    try {
      const comm = (await io.readFile(`/proc/${name}/comm`, 'utf8')).trim();
      let command = '';
      try { command = (await io.readFile(`/proc/${name}/cmdline`, 'utf8')).replace(/\0+/g, ' '); } catch {}
      if (!codexProcess(command, comm)) return;
      // Field 4 of /proc/<pid>/stat, read after the last ')' because the comm
      // field before it may itself contain spaces and parentheses.
      let ppid = null;
      try {
        const stat = await io.readFile(`/proc/${name}/stat`, 'utf8');
        const value = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        if (Number.isFinite(value)) ppid = value;
      } catch {}
      let sawHandle = false;
      for (const fd of await io.readdir(`/proc/${name}/fd`)) {
        let target;
        try { target = await io.readlink(`/proc/${name}/fd/${fd}`); } catch { continue; }
        const ref = sessionFromOpenPath(target, codexHome, { writerLocks, pathmod: path.posix });
        if (!ref) continue;
        sawHandle = true;
        addSession(found, ref.sessionId, pid, ref.exact ? 'writer-lock' : 'rollout-fd', ppid);
      }
      if (!sawHandle) {
        const sessionId = sessionFromCommand(command);
        if (sessionId) addSession(found, sessionId, pid, 'command', ppid);
      }
    } catch {
      // Processes can exit between /proc reads. One vanished row says nothing
      // about the rest of the snapshot.
    }
  }));
  return { known: true, sessions: [...found.values()] };
}

async function scanMac(codexHome, { run = runFile, io = fsp } = {}) {
  const processResult = await run('ps', ['-axo', 'pid=,comm=,args=']);
  if (!processResult.ok && !processResult.stdout) return { known: false, sessions: [] };
  const processes = parsePsRows(processResult.stdout).filter((row) => codexProcess(row.command, row.executable));
  const found = new Map();
  for (const row of processes) {
    const sessionId = sessionFromCommand(row.command);
    if (sessionId) addSession(found, sessionId, row.pid, 'command');
  }
  if (!processes.length) return { known: true, sessions: [...found.values()] };

  const lockDir = path.posix.join(codexHome, 'thread-writer-locks');
  const writerLocks = await hasDirectory(lockDir, io);
  const handles = await run('lsof', ['-n', '-P', '-a', '-p', processes.map((row) => row.pid).join(','), '-F', 'pRn']);
  // lsof exits 1 when its filtered result is empty, so stdout is accepted even
  // with a non-zero code. No stdout plus an execution error means only the
  // command-line positives above are known.
  const exitedNormally = handles.error && typeof handles.error.code === 'number';
  const handleScanWorked = handles.ok || !!handles.stdout || exitedNormally;
  if (!handleScanWorked) return { known: false, sessions: [...found.values()] };
  for (const row of parseLsof(handles.stdout)) {
    const ref = sessionFromOpenPath(row.path, codexHome, { writerLocks, pathmod: path.posix });
    if (ref) addSession(found, ref.sessionId, row.pid, ref.exact ? 'writer-lock' : 'rollout-fd', row.ppid);
  }
  return { known: true, sessions: [...found.values()] };
}

const WINDOWS_LOCK_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class TermdeckCodexWriterLock {
  [StructLayout(LayoutKind.Sequential)]
  public struct Overlapped {
    public UIntPtr Internal;
    public UIntPtr InternalHigh;
    public uint Offset;
    public uint OffsetHigh;
    public IntPtr EventHandle;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool LockFileEx(SafeFileHandle file, uint flags, uint reserved, uint low, uint high, ref Overlapped overlapped);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool UnlockFileEx(SafeFileHandle file, uint reserved, uint low, uint high, ref Overlapped overlapped);

  public static bool IsHeld(string fileName) {
    using (FileStream stream = new FileStream(fileName, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete)) {
      Overlapped overlapped = new Overlapped();
      bool acquired = LockFileEx(stream.SafeFileHandle, 3, 0, UInt32.MaxValue, UInt32.MaxValue, ref overlapped);
      if (acquired) {
        UnlockFileEx(stream.SafeFileHandle, 0, UInt32.MaxValue, UInt32.MaxValue, ref overlapped);
        return false;
      }
      return Marshal.GetLastWin32Error() == 33;
    }
  }
}
'@
Get-ChildItem -LiteralPath $env:TERMDECK_CODEX_WRITER_LOCK_DIR -Filter '*.lock' -File | ForEach-Object {
  if ([TermdeckCodexWriterLock]::IsHeld($_.FullName)) { $_.BaseName }
}
`;

async function scanWindows(codexHome, { run = runFile, io = fsp } = {}) {
  const lockDir = path.win32.join(codexHome, 'thread-writer-locks');
  if (!(await hasDirectory(lockDir, io))) return { known: false, sessions: [] };
  const encoded = Buffer.from(WINDOWS_LOCK_PROBE, 'utf16le').toString('base64');
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, TERMDECK_CODEX_WRITER_LOCK_DIR: lockDir },
  });
  if (!result.ok) return { known: false, sessions: [] };
  const found = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const sessionId = line.trim();
    if (UUID_RE.test(sessionId)) addSession(found, sessionId, null, 'writer-lock');
  }
  return { known: true, sessions: [...found.values()] };
}

async function scanCodexAttachments({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  platform = process.platform,
  run = runFile,
  io = fsp,
} = {}) {
  let home = codexHome;
  try { home = await io.realpath(codexHome); } catch { home = path.resolve(codexHome); }
  if (platform === 'linux') return scanLinux(home, { io });
  if (platform === 'darwin') return scanMac(home, { run, io });
  if (platform === 'win32') return scanWindows(home, { run, io });
  return { known: false, sessions: [] };
}

module.exports = {
  UUID_RE,
  WINDOWS_LOCK_PROBE,
  codexProcess,
  parseLsof,
  parsePsRows,
  scanCodexAttachments,
  scanLinux,
  scanMac,
  scanWindows,
  sessionFromCommand,
  sessionFromOpenPath,
};
