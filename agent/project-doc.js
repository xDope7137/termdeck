'use strict';

// The project's instruction file — CLAUDE.md, AGENTS.md — read AND written
// (FEATURE-UPDATES U5's editor, and V3 §B's `#` memory quick-add, which is the
// same capability with a smaller mouth).
//
// This is the SECOND write that lands outside the transcript roots, after
// `restore`, and it is drawn on exactly those terms. The master names a
// CONFINED transcript and an ENGINE — never a path, never a filename, never a
// cwd. The agent resolves the project root out of that transcript's own head
// (`lib/index-head.js`, one implementation) and the filename comes from fixed
// tables here, picked by what exists on disk (see docNameAt). A compromised
// master cannot aim this at a file of its choosing: the worst it can do is write
// the instruction file of a real session of a real project, which is the feature.
//
// WHY A WRITE AT ALL, when the file dock is deliberately read-only. The dock is
// a viewer for a whole checkout, and making a general file editor out of it
// would mean owning conflict resolution for every file in a customer's repo.
// This is one file per project whose whole purpose is to be edited by a person,
// and it is the one file you most want to fix from a phone when an agent keeps
// getting something wrong. Two ops, and the difference matters:
//
//   write  — replaces the file. Last-write-wins, so the caller sends back the
//            bytes it was shown and the UI says so.
//   append — adds a line. Never destructive, which is what makes `#` safe to
//            fire from the composer with no confirmation and no editor open.
//
// Shipped to agents by name (AGENT_FILES in master.js), so this module may only
// require SIBLINGS in lib/ — an installed agent has a flat directory. It
// requires none: node builtins only.

const fsp = require('fs/promises');
const path = require('path');

// The whole filename table. Not a parameter — a name from the request is a path
// from the request wearing a hat.
const DOC_BY_ENGINE = { claude: 'CLAUDE.md', codex: 'AGENTS.md', grok: 'AGENTS.md' };

// Big enough for any real instruction file (this repo's CLAUDE.md is ~25 KB);
// small enough that the tunnel is never asked to carry a mistake.
const MAX_BYTES = 256 * 1024;
// One appended note. A `#` line is a sentence, not a document.
const MAX_APPEND = 4 * 1024;

// Claude Code reads AGENTS.md in place of CLAUDE.md when the project has no
// CLAUDE file of its own (2.1.277, the default "claude-md-or-agents-md" mode of
// its built-in agents-md plugin; both lists below are that plugin's own
// CLAUDE_NAMES and AGENTS_NAMES, read off the 2.1.283 binary). So for a Claude
// chat in an AGENTS.md-only repo, CLAUDE.md is the WRONG file twice over: the
// editor shows an empty file while Claude follows AGENTS.md, and `#` creates a
// CLAUDE.md whose mere existence switches AGENTS.md off.
//
// Checked at the project root only, which is the plugin's rule too: it counts
// CLAUDE files at or below the session root, so a parent folder's CLAUDE.md and
// `~/.claude/CLAUDE.md` do not stop AGENTS.md loading. Not honoured: the
// plugin's `instructionFiles` option. Under its non-default "claude-md" mode an
// AGENTS.md-only repo gets no project file at all, and editing AGENTS.md there
// is merely ineffective, where creating CLAUDE.md in the default mode is
// destructive. Forward slashes because a name is also what the UI shows, and
// path.join normalises them on Windows anyway.
const CLAUDE_OWN = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
const CLAUDE_FALLBACK = ['AGENTS.md', '.claude/AGENTS.md'];

function docNameFor(engine) {
  return DOC_BY_ENGINE[engine] || DOC_BY_ENGINE.claude;
}

async function isFile(file) {
  try { return (await fsp.stat(file)).isFile(); } catch { return false; }
}

// The file this engine actually reads in `root`. Every candidate is a constant
// above, so what exists on disk picks between fixed names and never supplies one.
async function docNameAt(root, engine) {
  const name = docNameFor(engine);
  if (name !== DOC_BY_ENGINE.claude) return name;
  for (const own of CLAUDE_OWN) if (await isFile(path.join(root, own))) return name;
  for (const alt of CLAUDE_FALLBACK) if (await isFile(path.join(root, alt))) return alt;
  return name;
}

async function readDoc(root, engine) {
  const name = await docNameAt(root, engine);
  const file = path.join(root, name);
  let st;
  try { st = await fsp.stat(file); } catch { return { name, exists: false, content: '', bytes: 0 }; }
  if (!st.isFile()) return { name, exists: false, content: '', bytes: 0 };
  if (st.size > MAX_BYTES) return { name, exists: true, tooLarge: true, bytes: st.size, content: '' };
  return { name, exists: true, bytes: st.size, mtimeMs: st.mtimeMs, content: await fsp.readFile(file, 'utf8') };
}

// tmp + rename, the same idiom as the session-settings sidecar and the master's
// VAPID keys: a reader never sees a half-written file, and a crash mid-write
// leaves the previous one intact. This one is a file the CUSTOMER wrote, so
// leaving it half-replaced would be the worst failure available here.
async function writeDoc(root, engine, content) {
  const name = await docNameAt(root, engine);
  if (typeof content !== 'string') throw Object.assign(new Error('content must be a string'), { code: 'BAD_CONTENT' });
  const body = content.length > MAX_BYTES ? content.slice(0, MAX_BYTES) : content;
  const file = path.join(root, name);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(tmp, body, 'utf8');
    await fsp.rename(tmp, file);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* the tmp file is not worth a second failure */ }
    throw err;
  }
  const st = await fsp.stat(file);
  return { name, exists: true, bytes: st.size, mtimeMs: st.mtimeMs };
}

// Add one note. Read-modify-write rather than an O_APPEND open, because the
// spacing has to be right: a note glued onto the end of an unterminated line is
// a note that changed the meaning of the line above it.
async function appendDoc(root, engine, text) {
  const line = String(text == null ? '' : text).trim();
  if (!line) throw Object.assign(new Error('nothing to add'), { code: 'EMPTY' });
  const note = line.length > MAX_APPEND ? line.slice(0, MAX_APPEND) : line;
  const current = await readDoc(root, engine);
  if (current.tooLarge) throw Object.assign(new Error('That file is too large for Termdeck to edit'), { code: 'TOO_LARGE' });
  const prev = current.content || '';
  const sep = !prev ? '' : prev.endsWith('\n\n') ? '' : prev.endsWith('\n') ? '\n' : '\n\n';
  return writeDoc(root, engine, `${prev}${sep}${note}\n`);
}

module.exports = { readDoc, writeDoc, appendDoc, docNameFor, docNameAt, MAX_BYTES, MAX_APPEND };
