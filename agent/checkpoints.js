'use strict';

// Checkpoint restore: the CLI snapshots edited files before each turn into
// ~/.claude/file-history/<sessionId>/<sha256(absPath)[:16]>@v<version>, holding the
// raw file content at that version. A file-history-snapshot record in the session
// jsonl maps { relPath -> { version } } for a checkpoint (keyed by messageId).
// Restoring writes each tracked file back to its checkpoint version.
//
// ponytail: this reverse-engineers undocumented CLI internals (the @v naming +
// sha256[:16] path hash, verified empirically). If a CLI update changes that,
// resolve() returns exists:false and restore refuses — it never guesses/clobbers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// Resolved here rather than imported from claude-data.js: this module is shipped
// FLAT to thin agents (AGENT_FILES in master.js), where claude-data.js — and the
// watcher stack behind it — does not exist. Same one line claude-data.js and
// agent/capabilities.js both compute, so all three roots follow CLAUDE_CONFIG_DIR
// together; a checkpoint would otherwise be looked for under the wrong tree.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

function backupPathFor(sessionId, absPath, version) {
  const hash = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
  return path.join(CLAUDE_DIR, 'file-history', sessionId, `${hash}@v${version}`);
}

// Find the snapshot for messageId (later records — snapshot updates — supersede)
// and resolve each tracked file to its backup. cwd resolves relative keys.
//
// `messageId` may be a LIST. One turn is one restore point in the UI, but the
// interactive TUI writes a separate checkpoint per edit, so rolling a prompt back
// means reading every checkpoint that turn produced and taking the EARLIEST
// backup of each file — the state before the prompt ran. Restoring only the first
// id would silently leave any file first touched later in the turn edited, under
// a button that says the whole prompt was rolled back. A single id resolves
// exactly as it always did.
function resolveCheckpoint(jsonlPath, sessionId, cwd, messageId) {
  const wanted = new Set((Array.isArray(messageId) ? messageId : [messageId]).filter((id) => typeof id === 'string' && id));
  if (!wanted.size) return null;
  let text;
  try {
    text = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return null;
  }
  // Two shapes, and BOTH have to be read.
  //
  //   file-history-snapshot — the whole tracked set for a checkpoint, keyed by
  //     messageId. Written populated by the interactive TUI.
  //   file-history-delta    — one record per file as it is backed up, pointing
  //     back at its checkpoint via snapshotMessageId. This is what the CLI
  //     actually emits under the SDK (verified 2.1.220): the snapshot is written
  //     at turn START, so it is EMPTY, and every file arrives as a delta after
  //     it. Reading only the snapshot found nothing to restore even though the
  //     backup blob was already on disk.
  //
  // A delta also carries realParentDir, which is the directory the file actually
  // lives in — authoritative, and the only correct answer for a worktree, where
  // the session's own cwd is not where the edit landed.
  // Each id is resolved on its own first. They cannot share a bucket: an id's
  // snapshot updates supersede that id's earlier snapshot, but across ids a
  // snapshot is a whole separate checkpoint — merging them as one made the
  // turn-opening EMPTY snapshot swallow every populated one after it.
  const byId = new Map(); // id -> { snap, deltas: Map<trackingPath, {version, dir}> }
  const bucket = (id) => {
    let b = byId.get(id);
    if (!b) byId.set(id, (b = { snap: null, deltas: new Map() }));
    return b;
  };
  let seenSnapshot = false;
  for (const line of text.split('\n')) {
    if (!cwd && line.includes('"cwd"')) {
      try {
        const r = JSON.parse(line);
        if (typeof r.cwd === 'string' && r.cwd) cwd = r.cwd;
      } catch {}
    }
    if (!line.includes('file-history-')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r.type === 'file-history-snapshot') {
      const mid = r.messageId || (r.snapshot && r.snapshot.messageId);
      if (wanted.has(mid) && r.snapshot && r.snapshot.trackedFileBackups) {
        bucket(mid).snap = r.snapshot; // later records — snapshot updates — supersede
        seenSnapshot = true;
      }
      continue;
    }
    if (r.type === 'file-history-delta') {
      const mid = r.snapshotMessageId || r.messageId;
      if (!wanted.has(mid) || !r.trackingPath || !r.backup) continue;
      // Lowest version for a path wins — a file edited twice in one turn is backed
      // up once per edit, and the checkpoint restores the state at turn start.
      const deltas = bucket(mid).deltas;
      const prior = deltas.get(r.trackingPath);
      if (prior && prior.version <= r.backup.version) continue;
      deltas.set(r.trackingPath, { version: r.backup.version, dir: r.backup.realParentDir || null });
    }
  }
  if (!byId.size) return null;

  const entries = new Map(); // relPath -> { version, dir }
  for (const { snap, deltas } of byId.values()) {
    const own = new Map();
    for (const [relPath, meta] of Object.entries((snap && snap.trackedFileBackups) || {})) {
      own.set(relPath, { version: meta && meta.version, dir: null });
    }
    // Deltas are the fresher record of the same checkpoint, so they win — and a
    // delta carries realParentDir, which a snapshot entry never does.
    for (const [relPath, meta] of deltas) own.set(relPath, meta);
    for (const [relPath, meta] of own) {
      const prior = entries.get(relPath);
      // Across the turn, the oldest backup of a file is the one that predates the
      // prompt. A dir is kept wherever it was found: only one of the checkpoints
      // may have been the delta that knows where the file really lives.
      if (!prior) entries.set(relPath, { ...meta });
      else if (prior.version == null || (meta.version != null && meta.version < prior.version)) {
        entries.set(relPath, { version: meta.version, dir: meta.dir || prior.dir || null });
      } else if (!prior.dir && meta.dir) prior.dir = meta.dir;
    }
  }
  if (!entries.size) return seenSnapshot ? [] : null;

  const out = [];
  for (const [relPath, meta] of entries) {
    const base = meta.dir || cwd || '';
    const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(base, relPath);
    const version = meta.version;
    const backupPath = version != null ? backupPathFor(sessionId, absPath, version) : null;
    out.push({ relPath, absPath, version, backupPath, exists: !!backupPath && fs.existsSync(backupPath) });
  }
  return out;
}

// dryRun: resolve + report only, no writes. Live: overwrite each tracked file
// whose backup exists; never touch files without a backup.
function restoreCheckpoint(jsonlPath, sessionId, cwd, messageId, { dryRun = false } = {}) {
  const files = resolveCheckpoint(jsonlPath, sessionId, cwd, messageId);
  if (!files) return { error: 'checkpoint not found' };
  const restored = [];
  const skipped = [];
  for (const f of files) {
    const entry = { relPath: f.relPath, absPath: f.absPath, version: f.version };
    if (!f.exists) {
      skipped.push({ ...entry, reason: 'no backup on disk' });
      continue;
    }
    if (!dryRun) {
      try {
        fs.writeFileSync(f.absPath, fs.readFileSync(f.backupPath));
      } catch (e) {
        skipped.push({ ...entry, reason: e.message });
        continue;
      }
    }
    restored.push(entry);
  }
  return { restored, skipped };
}

module.exports = { resolveCheckpoint, restoreCheckpoint, backupPathFor };
