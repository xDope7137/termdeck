'use strict';

// Feature 04 — Phone Diff & PR Review. Engine-agnostic git helpers: everything
// here operates purely on the git state of a session's cwd, so it serves Claude
// and Codex sessions identically (it's just git state in the checkout). server.js
// resolves a session -> cwd, then calls collectDiff()/createPr() here.
//
// Cloud/agent parity: lib/cloud/machine-host.js would expose the same two routes
// per machine (owner-scoped, confined to the transcript roots) and call straight
// into these functions on the agent host, because the git work must run where the
// checkout actually lives — never on the hub. This local-hub implementation is the
// reference; the agent path re-uses it verbatim.

const { execFile } = require('child_process');

const GIT_TIMEOUT_MS = 20_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const MAX_DIFF_BYTES = 400 * 1024; // cap the payload; the UI shows a "truncated" notice
const MAX_UNTRACKED = 40; // include new-file contents up to this many files
const NULL_DEV = process.platform === 'win32' ? 'NUL' : '/dev/null';

function run(cmd, args, cwd, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: opts.timeout || GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      // Resolve (never reject): git diff --no-index exits 1 when files differ,
      // which is the normal case — callers inspect .err only when they need to.
      resolve({ err: err || null, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const git = (cwd, args, opts) => run('git', args, cwd, opts);

let ghCache = null;
async function ghAvailable() {
  if (ghCache !== null) return ghCache;
  const r = await run('gh', ['--version'], undefined, { timeout: 5_000 });
  ghCache = !r.err;
  return ghCache;
}

async function repoRoot(cwd) {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.err ? null : r.stdout.trim() || null;
}

function emptySummary() {
  return { filesChanged: 0, additions: 0, deletions: 0, files: [], untracked: [] };
}

// `git diff --numstat` lines: "<added>\t<deleted>\t<path>" ("-" for binary files).
function parseNumstat(text) {
  const files = [];
  let additions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^(\S+)\t(\S+)\t(.+)$/.exec(line);
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    const add = binary ? null : parseInt(m[1], 10) || 0;
    const del = binary ? null : parseInt(m[2], 10) || 0;
    if (add) additions += add;
    if (del) deletions += del;
    files.push({ path: m[3], additions: add, deletions: del, binary });
  }
  return { files, additions, deletions };
}

// New (untracked) files never show in `git diff`; synthesize a proper +added
// diff for each via `git diff --no-index` against the null device so the agent's
// brand-new files are reviewable too. Bounded and platform-safe (NUL on Windows).
async function untrackedDiff(root, files) {
  const parts = [];
  for (const f of files.slice(0, MAX_UNTRACKED)) {
    const r = await git(root, ['diff', '--no-index', '--', NULL_DEV, f]);
    if (r.stdout) parts.push(r.stdout.replace(/\s+$/, ''));
  }
  return parts.join('\n');
}

// The session's uncommitted work. Runs `git diff` (unstaged) AND `git diff
// --staged` (staged) per the feature spec, then concatenates them into one
// unified-diff blob; numstat comes from `git diff HEAD` when HEAD exists so the
// file/line counts stay deduped even when a file is both staged and re-edited.
//
// `opts.light` skips every patch (unstaged, staged, untracked) and returns the
// summary alone: what the Files dock needs to badge its rows. The patch of one
// file is then a separate read (`opts.file`, see fileDiff), asked for when that
// file is opened, so a 223-file change set is not regenerated and shipped whole
// on every dock open.
async function collectDiff(cwd, opts = {}) {
  if (opts.file) return fileDiff(cwd, opts.file, opts.from);
  const light = !!opts.light;
  const root = await repoRoot(cwd);
  if (!root) {
    return {
      git: false,
      cwd,
      root: null,
      reason: 'Not a git repository',
      branch: null,
      summary: emptySummary(),
      diff: '',
      truncated: false,
      pr: { remote: false, gh: false },
    };
  }

  const [unstagedR, stagedR, untrackedR, branchR, remoteR, headR] = await Promise.all([
    light ? { stdout: '' } : git(root, ['diff']),
    light ? { stdout: '' } : git(root, ['diff', '--staged']),
    git(root, ['ls-files', '--others', '--exclude-standard']),
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['remote']),
    git(root, ['rev-parse', '--verify', 'HEAD']),
  ]);
  const hasHead = !headR.err;

  const numstatR = hasHead
    ? await git(root, ['diff', 'HEAD', '--numstat'])
    : await git(root, ['diff', '--staged', '--numstat']);
  const base = parseNumstat(numstatR.stdout);

  const untracked = untrackedR.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const untrackedText = untracked.length && !light ? await untrackedDiff(root, untracked) : '';

  let text = [stagedR.stdout, unstagedR.stdout, untrackedText]
    .map((s) => s.replace(/\s+$/, ''))
    .filter(Boolean)
    .join('\n');
  const truncated = Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES;
  if (truncated) text = text.slice(0, MAX_DIFF_BYTES);

  const summary = {
    filesChanged: base.files.length + untracked.length,
    additions: base.additions,
    deletions: base.deletions,
    files: base.files,
    untracked,
  };

  const [gh] = await Promise.all([ghAvailable()]);
  return {
    git: true,
    cwd,
    root,
    branch: branchR.err ? null : branchR.stdout.trim() || null,
    summary,
    diff: text,
    truncated,
    light,
    // Feature-detect: the UI hides PR actions unless a remote exists; `gh` gates
    // whether the create can
    // actually run, surfaced as a clean "unavailable" instead of a failure.
    pr: { remote: !!remoteR.stdout.trim(), gh },
  };
}

// One file's patch, in the same staged-then-unstaged-then-untracked order the
// whole diff concatenates them, so the client parses it with the same code.
// `--literal-pathspecs` because the name came off the wire: a file called
// `:(top)x` or `*.js` must mean itself. `from` is a rename's old path; without
// it git shows a staged rename as a bare add.
async function fileDiff(cwd, file, from) {
  const root = await repoRoot(cwd);
  if (!root) return { git: false, cwd, root: null, file, diff: '', truncated: false };
  const specs = ['--', String(file)];
  if (from) specs.push(String(from));
  const g = (args) => git(root, ['--literal-pathspecs', ...args]);
  const [staged, unstaged, others] = await Promise.all([
    g(['diff', '--staged', ...specs]),
    g(['diff', ...specs]),
    g(['ls-files', '--others', '--exclude-standard', '--', String(file)]),
  ]);
  const untrackedText = others.stdout.trim() ? await untrackedDiff(root, [String(file)]) : '';
  let text = [staged.stdout, unstaged.stdout, untrackedText]
    .map((s) => s.replace(/\s+$/, ''))
    .filter(Boolean)
    .join('\n');
  const truncated = Buffer.byteLength(text, 'utf8') > MAX_DIFF_BYTES;
  if (truncated) text = text.slice(0, MAX_DIFF_BYTES);
  return { git: true, cwd, root, file, diff: text, truncated };
}

// Create a PR via the `gh` CLI. Outward-facing, so this only ever runs from an
// explicit POST that the browser has confirmed — never automatically. Degrades
// cleanly: no git remote, or no `gh` installed, returns a typed error the UI
// shows rather than a 500. Uses gh's ambient auth — no secrets are handled here.
async function createPr(cwd, { title, body } = {}) {
  const root = await repoRoot(cwd);
  if (!root) return { ok: false, status: 400, code: 'NOT_GIT', error: 'Not a git repository' };

  const remoteR = await git(root, ['remote']);
  if (!remoteR.stdout.trim()) {
    return { ok: false, status: 400, code: 'NO_REMOTE', error: 'This repository has no git remote — cannot create a pull request' };
  }
  if (!(await ghAvailable())) {
    return { ok: false, status: 501, code: 'GH_UNAVAILABLE', error: 'GitHub CLI (gh) is not installed on this host' };
  }

  const args = ['pr', 'create', '--title', String(title || 'Termdeck changes').slice(0, 250), '--body', String(body || '')];
  const r = await run('gh', args, root, { timeout: 60_000 });
  if (r.err) {
    const msg = (r.stderr || r.stdout || 'gh pr create failed').trim().slice(0, 2000);
    return { ok: false, status: 400, code: 'GH_FAILED', error: msg };
  }
  const url = (r.stdout.match(/https?:\/\/\S+/) || [null])[0];
  return { ok: true, url, output: r.stdout.trim().slice(0, 2000) };
}

// WHICH BRANCH is this folder on — the two git calls out of collectDiff above,
// without the diff.
//
// It exists because the answer Termdeck was showing came from somewhere else and
// is wrong in the one place people look for it. Claude Code stamps `gitBranch`
// onto every transcript record, and inside a LINKED WORKTREE that field is the
// parent checkout's branch: verified on this repo's own box, a session whose cwd
// is `.claude/worktrees/iterative-enchanting-raven` — a worktree checked out on
// `worktree-iterative-enchanting-raven` — recorded `gitBranch: "main"` on all 171
// of its records. The header chip read "main" while the dock, which asks git,
// read the real branch one panel over.
//
// A branch chip that says `main` when you are not on main is worse than no chip:
// it is the one fact a customer checks before believing their work is isolated.
// So ask git, in the folder the chat is actually in, and cheaply enough that the
// answer can be fetched on open — no diff, no numstat, no `gh`.
async function readBranch(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return { git: false, cwd, root: null, branch: null };
  const r = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  // Detached HEAD answers the literal string "HEAD", which names no branch —
  // null, so the caller shows nothing rather than a chip reading "HEAD".
  const branch = r.err ? null : r.stdout.trim() || null;
  return { git: true, cwd, root, branch: branch === 'HEAD' ? null : branch };
}

// EVERY CHECKOUT of this repo — the main one and every linked worktree — so a new
// chat can be started in one instead of only in the folder that was picked.
//
// `git worktree list --porcelain` rather than a directory scan, and that is the
// point: a worktree is a git fact, not a folder shape. Claude Code's `--worktree`
// happens to put its own at <repo>/.claude/worktrees/<name>, but a customer's
// `git worktree add ../hotfix` is just as real, and a stale `.claude/worktrees/x`
// left behind after `git worktree remove` is not real at all. Only git knows.
//
// Porcelain is a stanza per checkout, blank-line separated, key-value lines:
//   worktree <abs path>          (always first)
//   HEAD <sha>                   (absent on a bare main)
//   branch refs/heads/<name>     OR  detached
//   bare                         (main only, when it is)
//   locked [<reason>]            — Claude locks the ones it makes: the reason
//                                  reads "claude session <name> (pid …)", which
//                                  is how the picker can say a checkout is in use.
//
// The FIRST stanza is always the main working tree; `main` is carried rather than
// inferred by the caller, because "which of these is the project itself" is the
// one thing the list is useless without.
function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  const push = () => { if (cur) out.push(cur); cur = null; };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line) { push(); continue; }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') {
      push();
      cur = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, lockReason: null, main: out.length === 0 };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value || null;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '') || null;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') { cur.locked = true; cur.lockReason = value || null; }
  }
  push();
  return out;
}

async function listWorktrees(cwd) {
  const root = await repoRoot(cwd);
  if (!root) return { git: false, cwd, root: null, worktrees: [] };
  const r = await git(root, ['worktree', 'list', '--porcelain']);
  // A git old enough not to know `--porcelain` here (pre-2.7) answers an error
  // rather than nothing. One checkout is the honest answer for that box: the
  // folder it was asked about, and no picker.
  if (r.err) return { git: true, cwd, root, worktrees: [] };
  return { git: true, cwd, root, worktrees: parseWorktreeList(r.stdout) };
}

// parseNumstat is exported for lib/git-checkpoint.js, which reads the same
// `--numstat` output between two checkpoint commits. ONE parser: a second copy
// would drift on the binary-file `-` case, which is the only interesting one.
module.exports = { collectDiff, createPr, repoRoot, readBranch, listWorktrees, parseWorktreeList, parseNumstat };
