'use strict';

// Titles and tags the TERMINAL also sees (docs/SDK-SIGNALS.md §E).
//
// Termdeck's renames have always been LOCAL: `lib/overrides.js` keeps them in
// `~/.termdeck/overrides.json`, so a chat renamed in the web UI still showed its
// old generated title in `claude --resume`. The CLI has its own mechanism, and
// Termdeck was already reading the result of it — `lib/claude-data.js` and
// `lib/cloud/remote-sessions.js` both scan the transcript tail for a
// `custom-title` record — it just never WROTE one.
//
// So this is a small module by design: the whole feature is appending one JSON
// line to a file whose path we already resolve. The SDK exports `renameSession`/
// `tagSession`, and both do exactly this (verified in the 0.3.198 bundle), but
// the thin agent has no SDK — only `ws` and `chokidar` — and a second
// implementation on that side is precisely how the two paths drift. One module,
// shipped to the agent the way `lib/accounts.js` already is.
//
// THE RECORD IS APPEND-ONLY, and that is not an implementation detail. The
// transcript is the source of truth for the whole app; rewriting it to "update"
// a title would race every reader (the watcher's incremental parse, the parse
// cache keyed on size+mtime, a live CLI holding the same file). Readers already
// take the LAST such record, so a rename is another line and nothing else.

const fsp = require('fs/promises');
const crypto = require('crypto');

const MAX_TITLE = 200;
// The CLI validates this and Termdeck must too, on both sides: an id that is not
// a uuid means we are about to append to a path built from unvalidated input.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isSessionId = (id) => typeof id === 'string' && UUID_RE.test(id);

// Shape verified against the SDK bundle's own writer, field for field. The
// reader in lib/claude-data.js keys on `type` + `customTitle`, so those two are
// the contract; `uuid`/`timestamp` are what every other record in the file
// carries and are here so a title line is not the odd one out to any parser.
function titleRecord(sessionId, title) {
  const clean = String(title == null ? '' : title).trim().slice(0, MAX_TITLE);
  if (!isSessionId(sessionId)) throw Object.assign(new Error('Invalid session id'), { code: 'BAD_SESSION_ID' });
  if (!clean) throw Object.assign(new Error('Title must not be empty'), { code: 'BAD_TITLE' });
  return { type: 'custom-title', customTitle: clean, sessionId, uuid: crypto.randomUUID(), timestamp: new Date().toISOString() };
}

// The CLI's OWN title record, and the reason Termdeck writes one at all: the CLI
// only ever writes `ai-title` from its interactive TUI. A chat started from the
// browser is driven as `--input-format stream-json`, and that path writes none —
// measured across one real project dir, 104 of 104 transcripts whose first record
// is Termdeck's `queue-operation` have not a single ai-title line in them, while
// 75 of 101 terminal-started ones do. `~/.claude/history.jsonl` is written by the
// same TUI, so it is empty for those chats too.
//
// With no record anywhere, the title of every browser-started chat is re-derived
// from a WINDOW on each index rebuild — the head's first prompt, or the tail's
// last one — and both windows can miss (see lib/index-head.js). So Termdeck
// writes the record the CLI didn't, once, and the chat is titled on disk from
// then on: in the sidebar, in the board, and in `claude --resume` too.
//
// Deliberately `ai-title` and not `custom-title`: this is a DERIVED title, and it
// must keep losing to a human's rename. Readers take the last such record, so a
// CLI that later writes its own supersedes ours with no special case.
function aiTitleRecord(sessionId, title) {
  // A title is one line by definition; a pasted prompt is not. Collapse rather
  // than truncate at the newline, or a multi-line prompt titles as its first word.
  const clean = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (!isSessionId(sessionId)) throw Object.assign(new Error('Invalid session id'), { code: 'BAD_SESSION_ID' });
  if (!clean) throw Object.assign(new Error('Title must not be empty'), { code: 'BAD_TITLE' });
  return { type: 'ai-title', aiTitle: clean, sessionId, uuid: crypto.randomUUID(), timestamp: new Date().toISOString() };
}

// `null` clears, and clearing writes an EMPTY tag rather than deleting anything
// — same append-only reasoning as above, and the same thing the CLI does.
function tagRecord(sessionId, tag) {
  if (!isSessionId(sessionId)) throw Object.assign(new Error('Invalid session id'), { code: 'BAD_SESSION_ID' });
  const clean = tag == null ? '' : String(tag).trim().slice(0, MAX_TITLE);
  return { type: 'tag', tag: clean, sessionId, uuid: crypto.randomUUID(), timestamp: new Date().toISOString() };
}

// One line, appended. `flag: 'a'` is the whole safety story: a concurrent CLI
// writing its own records to the same file interleaves with us instead of
// losing to us, which a read-modify-write would not.
async function appendRecord(filePath, record) {
  await fsp.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}

module.exports = { titleRecord, aiTitleRecord, tagRecord, appendRecord, isSessionId, MAX_TITLE };
