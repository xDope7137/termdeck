'use strict';

// The pure head/tail PARSERS for a session transcript: given bytes, what are this
// chat's cwd, title, first-prompt uuid?
//
// They live here, at the top of lib/, rather than in lib/cloud/remote-sessions.js
// where they grew up, for one reason: the AGENT runs them now. Building the
// session index used to mean streaming the raw bytes to the master and parsing
// them there — measured at 124 MB across 581 reads for 200 sessions on one real
// box, which is a minute over a home uplink. The parse is a few hundred bytes of
// answer about a file the agent already has open, so it belongs on the machine
// that holds the disk (same trade lib/tail-read.js documents for previews).
//
// Shipped to agents by name (AGENT_FILES in master.js), so this module may only
// require SIBLINGS in lib/ — an installed agent has a flat directory, and
// `require('../transcript')` would resolve to nothing there. That constraint is
// what keeps this file free of anything cloud-shaped.

const { isSyntheticUserText, codexTimestampMs } = require('./transcript');

// A GENERATED title can come back as a bare "continue" — the user typed `continue`
// to restart a stalled run and the summariser took that prompt at face value, so a
// chat about anything at all ends up called "Continue". It names nothing, which is
// the whole job of a title, so it is treated as no answer at all: the source that
// produced it is skipped and the next candidate down is used.
//
// For the bottom-up ai-title / last-prompt scans that next candidate is literally
// the PREVIOUS record of the same type — i.e. the title the chat already had on
// screen before the user typed `continue`, which is the wanted behaviour.
//
// An explicit user rename (custom-title) is exempt on purpose. A rename always wins
// (see claudeTailTitle below), and someone who types "continue" into
// the rename box meant to.
const JUNK_TITLES = new Set(['continue']);

function isUsableTitle(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  // Trailing punctuation only — "Continue." and "continue!" are the same non-answer.
  return !JUNK_TITLES.has(t.toLowerCase().replace(/[.!?…\s]+$/, ''));
}

// What one user record's text is worth, in the two ways claudeHead needs it:
//
//   real  — a human's own message, whatever it says. The fork-family uuid keys
//           on THIS, so "continue" counts (see firstUserUuid below).
//   title — what it is worth as a title, which "continue" is not.
//
// One function because the two answers share every rule that produces them, and
// because the salvage path below has to reach the same verdict from a half-read
// record as the parsed path does from a whole one.
function readUserText(text) {
  const none = { real: false, title: null };
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) return none;
  if (t.includes('<command-name>')) {
    // Slash command: title from its <command-args> (text after e.g. /build), skip if bare.
    const m = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const args = m ? m[1].trim() : '';
    if (!args) return none;
    return { real: true, title: isUsableTitle(args) ? args : null };
  }
  if (isSyntheticUserText(t) || t.startsWith('<local-command')) return none;
  return { real: true, title: isUsableTitle(t) ? t : null };
}

// ---- salvaging a title out of a HALF-READ first record ----
//
// The head probe is a BYTE cut, so its last line is usually half a record. That
// costs nothing until the half-read record is the chat's opening prompt, which
// is exactly what happens when that prompt carries an image: measured on a real
// transcript, line 3 was a 264,679-byte user record — 155 bytes of text and a
// 264 KB inline base64 png — against a 128 KB window. JSON.parse threw, the head
// yielded no title, and since Termdeck-started chats get no ai-title from the
// CLI (it writes none in stream-json mode) the chat rendered as "(untitled)".
//
// The text block sits in the first ~350 bytes of that record, so the answer was
// always inside the window we had already read. Raising HEAD_BYTES is not the
// fix — an image is however many megabytes it is — so this reads the title out
// of the partial instead, for zero extra I/O.
//
// Strict on purpose, because a WRONG title is worse than none:
//   * only the last line of a window that was cut (a complete file's last line
//     ends in a newline);
//   * only a real user record — not a sidechain, not isMeta;
//   * only when the FIRST content block is a text block. A user record can carry
//     tool_result blocks whose nested content is itself {"type":"text",...}, and
//     scanning past the first block would happily title a chat with a tool's
//     output.
// It also never sets firstUserUuid: `uuid` is a top-level field written AFTER
// `message`, so on a truncated line it is gone — and that uuid is the fork-family
// key (see below), where a guess repoints a whole fork family.
const FIRST_TEXT_BLOCK = '"content":[{"type":"text","text":"';

// Read the JSON string starting at `from` (the first byte INSIDE the quotes).
// The window can end mid-string, and a truncated title is still a title, so a
// missing closing quote is not a failure — a dangling escape the cut split in
// half is dropped and the rest is unescaped by JSON itself.
function readJsonString(text, from) {
  let i = from;
  for (; i < text.length; i++) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '"') break;
  }
  const safe = text.slice(from, Math.min(i, text.length)).replace(/\\u[0-9a-fA-F]{0,3}$/, '').replace(/\\$/, '');
  try { return JSON.parse(`"${safe}"`); } catch { return null; }
}

function salvagePartialUserText(line) {
  if (!line.includes('"type":"user"')) return null;
  if (line.includes('"isSidechain":true') || line.includes('"isMeta":true')) return null;
  const c = line.indexOf('"content":');
  if (c === -1) return null;
  if (line.startsWith(FIRST_TEXT_BLOCK, c)) return readJsonString(line, c + FIRST_TEXT_BLOCK.length);
  if (line.startsWith('"content":"', c)) return readJsonString(line, c + '"content":"'.length); // plain-string content
  return null;
}

// ---- the same salvage, for a CODEX rollout ----
//
// The byte cut is shared; what is not shared is how much of the window is gone
// before the human says anything. A rollout opens with a preamble the CLI keeps
// adding to — session_meta, three injected `developer` messages, a
// `<recommended_plugins>` user message, world_state, turn_context — and measured
// across 214 real rollouts on one box, the first HUMAN message started at a
// median of 29.7 KB in June, 37.0 KB in July and 56.2 KB in August. Against a
// 128 KB probe that leaves ~65 KB of headroom, and a pasted screenshot is 120 KB
// of base64 on its own: the opening prompt straddles the cut, JSON.parse throws,
// codexHead returns no title.
//
// Claude survives that (salvagePartialUserText above, written for the same
// image-bearing prompt) because it has FOUR more rungs under the head — the tail
// scan for custom-title / ai-title / last-prompt / last-command. Codex has NONE
// of them: that ladder is Claude records, `session_index.jsonl` only carries TUI
// renames (a chat started from the browser is never in it), and seedTitle writes
// Claude's ai-title. So a codex head miss is not a slow title, it is a permanent
// one — "(untitled) 019fff20" for the life of the chat. Hence this.
//
// Strict for the same reason and in the same shape: only the last line of a cut
// window, only a user-role message record, and only when the FIRST content block
// is a text block. Codex puts the text block first and the image after it
// (verified on the real record), so the answer was always inside the bytes we had
// already read — this costs no extra I/O.
//
// `input_text` is the current block type and `text` the older one; both are
// matched because a rollout on disk today may have been written by either.
const CODEX_TEXT_BLOCKS = ['"content":[{"type":"input_text","text":"', '"content":[{"type":"text","text":"'];

function salvagePartialCodexUserText(line) {
  if (!line.includes('"type":"response_item"')) return null;
  // A developer/assistant record can be cut the same way; only the human's counts.
  if (!line.includes('"role":"user"')) return null;
  const c = line.indexOf('"content":');
  if (c === -1) return null;
  for (const prefix of CODEX_TEXT_BLOCKS) {
    if (line.startsWith(prefix, c)) return readJsonString(line, c + prefix.length);
  }
  return null;
}

// Claude Code writes its own title into the transcript tail (a user custom-title always
// wins; otherwise its evolving ai-title summary), so the remote browse title tracks
// the CLI's title, not just the raw first prompt from the head.
function claudeTailTitle(text) {
  const lines = text.split(/\r?\n/);
  let custom = null, ai = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (!custom && rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) custom = rec.customTitle.trim();
    // A "continue" ai-title fails isUsableTitle, so the scan walks PAST it to the
    // previous one rather than stopping — that earlier record is the title the chat
    // was already showing.
    else if (!ai && rec.type === 'ai-title' && isUsableTitle(rec.aiTitle)) ai = rec.aiTitle.trim();
    if (custom) break;
  }
  return custom || ai || null;
}

// Only an explicit user-set title (custom-title), scanning the tail bottom-up (latest
// rename wins). Unlike claudeTailTitle this never returns the evolving ai-title, so
// callers keep the first human prompt as the title while still honouring a manual rename.
function claudeCustomTitle(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) return rec.customTitle.trim();
  }
  return null;
}

// The session's cwd can change mid-conversation — e.g. Termdeck promotes a chat into a
// freshly created git worktree partway through — so the head-scanned cwd goes stale once
// that happens past HEAD_BYTES. Scan the tail bottom-up for the most recent CLI-authored
// record's cwd; Termdeck's own bookkeeping record types (attachment, queue-operation, ...)
// don't count, since they can carry an unrelated cwd (e.g. where a file was attached from,
// not the session's actual working directory).
function claudeTailCwd(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if ((rec.type === 'user' || rec.type === 'assistant' || rec.type === 'system') && typeof rec.cwd === 'string' && rec.cwd) return rec.cwd;
  }
  return null;
}

// Which folder a chat's PROJECT is, given the cwd it opened in (`home`, from the head)
// and the cwd on its newest record (`latest`, from claudeTailCwd above).
//
// Not simply `latest`, which is what this used to be. Claude Code stamps `cwd` on every
// record, and its Bash tool's shell keeps its directory between calls, so a single
// `cd server/app && grep ...` rewrites the chat's cwd for every record after it. Reading
// the newest value meant an agent's `cd` looked exactly like the chat MOVING: the file
// dock re-rooted onto whatever subdirectory a command happened to use, collapsing the
// tree and dropping the open file every time (one real 211-line transcript on this repo's
// own box did that 9 times, once per `cd`), and cwdFor() then spawned the next turn there.
//
// The only change worth calling a move is crossing a WORKTREE boundary, which is the case
// the tail cwd was read for to begin with. So the answer is always a project or a worktree
// ROOT, never a subdirectory of either:
//
//   <proj>              ->  <proj>/server/app            stay:  a cd inside the project
//   <proj>              ->  <proj>/.claude/worktrees/x   enter: that worktree
//   <proj>/.../wt/x     ->  <proj>/.../wt/x/server       stay:  still that worktree
//   <proj>/.../wt/x     ->  <proj>/anywhere              leave: the project it was cut from
//
// Same shape as codexTailWorktree below, one boundary rather than a command count: Claude
// records its cwd as a field, so this needs no inference, only a rule for which changes
// are real.
//
// Mirrored by public/js/worktree-fold.js's projectCwd, which answers the same question for
// the browser (main.js hands the dock that answer). The two MUST agree, and tests/project-cwd.mjs
// runs both copies over one table to prove it.
const WORKTREE_PARTS_RE = /^(.*?)([\\/]\.claude[\\/-]worktrees[\\/][^\\/]+)(?:[\\/]|$)/i;
// Trailing separators only. normalizeCwd() is the fuller rule but it lives in
// claude-data.js, which requires THIS file, and a cycle for a `//` nobody writes is a bad
// trade. readIndexHead normalises the answer on the way out anyway.
const stripEnd = (cwd) => String(cwd == null ? '' : cwd).replace(/[\\/]+$/, '');

// The repo and the worktree root for a path inside a worktree, or null anywhere else.
function worktreeParts(cwd) {
  const m = WORKTREE_PARTS_RE.exec(cwd);
  return m ? { base: m[1], root: m[1] + m[2] } : null;
}

function projectCwd(home, latest) {
  const a = stripEnd(home);
  const b = stripEnd(latest);
  if (!b) return a || null; // a record with no cwd never un-sets one
  const to = worktreeParts(b);
  if (!a) return to ? to.root : b; // nothing to compare against: take what we have
  const from = worktreeParts(a);
  // Both sides of the same boundary, or neither in a worktree at all: a plain cd.
  if ((from ? from.root : null) === (to ? to.root : null)) return a;
  if (to) return to.root;          // moved INTO a worktree
  return from.base || a;           // moved back OUT of one, to the repo it was cut from
}

// The raw last user prompt (last-prompt record), scanning the tail bottom-up. Last-resort
// title when the head first-prompt is lost — e.g. a huge image-bearing first message
// overflows HEAD_BYTES and its line won't parse — and the CLI wrote no custom/ai title.
function claudeLastPrompt(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'last-prompt' && isUsableTitle(rec.lastPrompt)) return rec.lastPrompt.trim();
  }
  return null;
}

// The LAST slash command the chat ran, e.g. "/clear" — the bottom rung, below every
// rung above it, and the answer to a chat that contains nothing else.
//
// `/clear` in the terminal starts a NEW session file whose entire content is the
// command and its empty output: on one real fleet, 25 of 25 untitled chats on one
// machine and 9 of 14 on the other were exactly that, plus `/plugin`, `/login`,
// `/chrome`, `/agents`. There is no prose in them to find, so no window and no
// widening can ever name them — but "(untitled) 5cd03f22" reads as a chat whose
// title BROKE, while "/clear" says what the row actually is.
//
// A bare command is deliberately not a title anywhere above this (readUserText
// drops it), so that a chat OPENING with `/resume` is named by the real prompt that
// follows instead. That rule is intact: this only ever runs when there is no real
// prompt anywhere. Bottom-up, so a chat that ran `/clear` then `/high-end-visual-design`
// is named by the latter — the same latest-wins the ai-title and last-prompt scans use.
const COMMAND_NAME_RE = /<command-name>\s*([^<]+?)\s*<\/command-name>/;

// The echo comes in TWO shapes, and reading only the first one is what put six
// chats on one real machine back to "(untitled)" after the rung above was built.
//
//   user   — `{type:'user', message:{content:'<command-name>…'}}`. A command the
//            model is asked to act on (`/build`, a plugin command).
//   system — `{type:'system', subtype:'local_command', content:'<command-name>…'}`.
//            A command the CLI answers by ITSELF: `/resume`, `/context`, `/clear`.
//
// Which shape a command takes is a property of the COMMAND, not of the CLI
// version — measured across this machine's 875 transcripts, 446 user-shaped and
// 18 system-shaped echoes are interleaved across the same versions (2.1.216 →
// 2.1.232). And the system-shaped ones are precisely the commands that make a
// STUB session: a file whose entire content is `/resume` and its empty output,
// which is the only kind of chat this rung ever has to name. So the rung that
// exists to title command-only chats was blind to every command that makes one.
//
// The system record's `content` is a plain string (the user record nests it under
// `message`), so the two are read apart and matched by the same regex.
function commandEchoText(rec) {
  if (rec.type === 'system') return typeof rec.content === 'string' ? rec.content : '';
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain || !rec.message) return '';
  const c = rec.message.content;
  return typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
}

// One walk, two answers — the NAME titles the chat, the TIMESTAMP sorts it (see
// claudeLastCommandAt). They must come off the same record or the row can be
// named by one command and ordered by another.
function lastCommandRecord(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const m = COMMAND_NAME_RE.exec(commandEchoText(rec));
    if (!m) continue;
    const name = m[1].trim();
    if (!name) continue;
    const at = Date.parse(rec.timestamp);
    return { name: name.startsWith('/') ? name : `/${name}`, at: Number.isNaN(at) ? null : at };
  }
  return null;
}

function claudeLastCommand(text) {
  const hit = lastCommandRecord(text);
  return hit ? hit.name : null;
}

// WHEN that command was run — the bottom rung of the SORT KEY ladder, exactly as
// claudeLastCommand is the bottom rung of the TITLE ladder, and for the same
// reason: a chat driven entirely by slash commands has no prose anywhere, so
// every rung above this one returns null forever.
//
// lastClaudeUserInputAt skips command echoes on purpose — running `/model` must
// not reorder a chat above one you actually spoke to more recently — but SKIPPING
// a record and having NO ANSWER are different claims, and conflating them is what
// made `lastUserAt` null for a chat whose only prompt was `/ui-ux-pro-max:banner-design
// make a cool hero design for …`. The row then reported "no user message ever",
// which the sidebar's "hide chats with no user message" filter believed: the chat
// vanished from the list — out of the ACTIVE tray, mid-turn, seconds after being
// created — and every chat that survived sorted by mtime instead of prompt time.
// 24 of 194 sessions on one fleet answered null, including two multi-megabyte ones.
//
// So the skip stays a PREFERENCE, not an erasure: prose still wins wherever it
// exists (callers run this only after the prose scan has come up empty at every
// window), and a command answers when nothing else can.
function claudeLastCommandAt(text) {
  const hit = lastCommandRecord(text);
  return hit ? hit.at : null;
}

// {cwd,title} from a Claude jsonl head: cwd from the first record, title from the first
// real user message (skip slash-command / local-command-stdout wrappers).
function claudeHead(text) {
  let cwd = null, title = null, firstUserUuid = null;
  const lines = text.split('\n');
  // A window that does not end in a newline was cut mid-record; only its LAST
  // line can be that record.
  const cutAt = text.endsWith('\n') ? -1 : lines.length - 1;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (cwd && title) break;
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      if (li === cutAt && !title) title = readUserText(salvagePartialUserText(line)).title;
      continue;
    }
    if (!cwd && typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd;
    if (!title && rec.type === 'user' && !rec.isMeta && !rec.isSidechain && rec.message) {
      const c = rec.message.content;
      const txt = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
      const t = txt.trim();
      // firstUserUuid: fork-family key — sibling forks copy this record verbatim (see machine-host collapse)
      // firstUserUuid and title come apart here: the uuid must stay pinned to the
      // FIRST real user record whatever it says (sibling forks copy that record
      // verbatim — moving it would repoint the fork family), while a "continue"
      // prompt is skipped for TITLE purposes so the scan reaches the next one.
      // That is what readUserText's two answers are.
      const seen = readUserText(t);
      if (seen.real && !firstUserUuid) firstUserUuid = rec.uuid || null;
      if (seen.title) title = seen.title;
    }
  }
  return { cwd, title, firstUserUuid };
}

// TUI renames land in session_index.jsonl (thread_name), not the rollout itself — mirrors
// lib/codex-data.js's loadTitles so a rename made in the terminal shows up in the remote
// browse title instead of it being stuck on the first prompt forever.

// unlike them it parses a whole small JSON object, not a JSONL stream: grok's growing
// updates.jsonl carries no head metadata of its own (see lib/grok-data.js's
// readSummary — info.cwd/generated_title/session_summary are the source of truth).
// `text` here is the summary.json FILE CONTENT, not the transcript.
function grokHead(text) {
  let cwd = null, title = null;
  try {
    const raw = JSON.parse(text);
    const info = raw && typeof raw.info === 'object' && raw.info ? raw.info : {};
    cwd = typeof info.cwd === 'string' && info.cwd ? info.cwd : null;
    // Grok generates both of these, so both are subject to the "continue" rule.
    title = (isUsableTitle(raw.generated_title) && raw.generated_title) || (isUsableTitle(raw.session_summary) && raw.session_summary) || null;
  } catch {}
  return { cwd, title };
}

// Grok keeps no cross-session rename index (no session_index.jsonl equivalent —
// every title lives on the session's own summary.json, already covered by grokHead
// above; see lib/grok-data.js's loadTitles). Kept as a same-shaped async call so
// callers can treat all three engines uniformly instead of a per-engine branch.


// {cwd,title,subagentOf} from a Codex rollout head: cwd from first session_meta, title from
// first real user msg.
//
// subagentOf: codex collab WORKER threads (the CLI spawns them per sub-task) write their own
// rollout into the same sessions tree, and its FIRST session_meta carries `source` as an
// OBJECT — {"subagent":{"thread_spawn":{parent_thread_id,...}}} — where a user thread's is a
// plain string ("vscode", "cli", ...). A worker opens with a copy of the user's prompt, so it
// also inherits the parent's title — which is how one "Generate 5 logos" chat rendered as
// four sidebar rows (2026-08-03). Matched narrowly on the VERIFIED `subagent` key: an
// unknown future source shape must stay LISTED, because a duplicate row is benign and a
// sidebar that silently hides real chats is not.
function codexHead(text) {
  let cwd = null, title = null, subagentOf = null, sawMeta = false;
  const lines = text.split('\n');
  // A window that does not end in a newline was cut mid-record; only its LAST
  // line can be that record. Same rule claudeHead applies, and the reason the
  // salvage below can never look at a record we simply failed to understand.
  const cutAt = text.endsWith('\n') ? -1 : lines.length - 1;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (cwd && title) break;
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      if (li === cutAt && !title) {
        const t = salvagePartialCodexUserText(line);
        // The same two tests the parsed path applies below, so a salvaged prompt
        // is held to the rules a whole one is — "continue" is still not a title,
        // and an injected <recommended_plugins> block is still not the human.
        if (t && isUsableTitle(t) && !isSyntheticUserText(t)) title = t.trim();
      }
      continue;
    }
    const p = rec && rec.payload; if (!p) continue;
    if (rec.type === 'session_meta') {
      if (!sawMeta) { // FIRST meta is canonical — later ones are resume artifacts
        sawMeta = true;
        const sub = p.source && typeof p.source === 'object' && p.source.subagent;
        if (sub) {
          const parent = sub.thread_spawn && typeof sub.thread_spawn.parent_thread_id === 'string' && sub.thread_spawn.parent_thread_id;
          subagentOf = parent || 'unknown-parent';
        }
      }
      if (!cwd) cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : null;
    } else if (rec.type === 'response_item' && p.type === 'message' && p.role === 'user' && !title) {
      const t = (Array.isArray(p.content) ? p.content : []).map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
      if (isUsableTitle(t) && !isSyntheticUserText(t)) title = t.trim(); // "continue" keeps scanning
    }
  }
  return { cwd, title, subagentOf };
}

// The LAST human prompt in a rollout, scanning the tail bottom-up — Codex's
// version of claudeLastPrompt, and the rung it has been missing.
//
// Claude has six rungs under a head miss (custom-title, ai-title, last-prompt,
// last-command, the widening ladder, and a seeded ai-title on disk). Codex has
// had exactly ONE: codexHead, against a 128 KB probe. `session_index.jsonl`
// carries TUI renames only, so a browser-started chat is never in it, and
// seedTitle writes a Claude record. A head miss is therefore not a slow title —
// it is a permanent one, "(untitled) 019fbdae" for the life of the chat.
//
// And the probe's headroom is closing on its own. The CLI keeps adding to the
// preamble a rollout opens with (session_meta, injected `developer` messages,
// <recommended_plugins>, world_state, turn_context), and measured across 214 real
// rollouts on one box the first HUMAN message starts at a median of 34 KB in
// June, 42 KB in July and 64 KB in August, p90 80 KB. Verified by construction:
// a 100 KB preamble still titles, a 130 KB one returns null forever. Nothing on
// that curve needs to break for this to start biting — it just keeps growing.
//
// Bottom-up like every other tail scan, so it answers "the last thing you said
// here", which is what claudeLastPrompt means one engine over. Same two tests
// codexHead applies to a head prompt, so a rung further down can never accept a
// title the rung above it would have refused.
function codexLastPrompt(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; } // the tail may cut line 0 in half
    const p = rec && rec.payload;
    if (rec.type !== 'response_item' || !p || p.type !== 'message' || p.role !== 'user') continue;
    const t = (Array.isArray(p.content) ? p.content : []).map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
    if (isUsableTitle(t) && !isSyntheticUserText(t)) return t.trim();
  }
  return null;
}

// Has a Codex chat moved itself into a git worktree? Returns the worktree path, or null.
//
// Codex has no EnterWorktree and no --worktree: a thread's cwd is fixed at thread/start, and
// codexHead above reads it from the first session_meta and never revisits it. But the MODEL
// can still make a worktree — it just runs `git worktree add` like any other command — and
// then works inside it, because every Codex shell call carries its own `workdir`. The thread
// stays rooted where it began while the edits happen somewhere else, so Termdeck files the
// chat under the base project and the files dock lists the base repo's files. It works, and
// every location we show is wrong.
//
// This is the missing half. `thread/resume` takes a cwd (agent/engine-runs.js already sends
// one every turn), so once we know where the chat is really working we can follow it.
//
// It is INFERENCE, not a record — Codex never states "I moved". Three guards keep the
// inference narrow, because being wrong here resumes someone's chat in the wrong directory:
//
//  1. SHAPE. Only <baseCwd>/.claude/worktrees/<name>, the same layout the dock detects and
//     Claude's own CLI creates, or a checkout `git worktree list` names for this repo (the
//     `roots` the agent passes). An arbitrary `cd /tmp` can never move a chat, however many
//     commands run there.
//  2. RECENCY. The most recent workdir decides, so a chat that goes back to the base repo
//     comes back with it. Self-correcting rather than sticky.
//  3. REPETITION. The winner must appear at least twice. One `ls` inside a worktree the model
//     was merely inspecting is not a move.
//
// Every Codex shell shape records the directory under the same key, verified against 80 real
// rollouts: `function_call:exec_command` and `function_call:shell_command` carry it in their
// JSON `arguments`, and code-mode's `custom_tool_call:exec` in the JS `input` it wraps around
// the same call. One regex over the argument STRING covers all three; scanning only these
// record types is what keeps a workdir quoted in command OUTPUT from counting as a move.
//
// The key is quoted OR bare. Codex 0.158's code-mode writes a JS object literal,
// `tools.exec_command({cmd:"...",workdir:"/repo/.claude/worktrees/x"})`, and a regex that
// wanted `"workdir"` missed every one of those: the chat made its worktree, worked there,
// and the header, sidebar and dock went on naming the base repo. 73 of the last 200 rollouts
// on one real box had only that spelling. `\b` keeps `my_workdir:` out, and a `workdir:`
// inside a command string is followed by `\"`, not `"`, so it still cannot match.
const WORKDIR_RE = /(?:"workdir"|\bworkdir)\s*:\s*"((?:[^"\\]|\\.)*)"/g;
// <base>/.claude/worktrees/<name>, plus anything below it. Commands run wherever the
// work is — `npm test` from the worktree's own server/ subdir is still that worktree —
// so a directory INSIDE one resolves to the worktree it belongs to, and both count as
// the same place. The capture is what the chat's cwd becomes: the worktree ROOT, which
// is what a thread's cwd means, never whichever subdirectory a command happened to use.
const CODEX_WORKTREE_TAIL = /^([\\/]\.claude[\\/]worktrees[\\/][^\\/]+)(?:[\\/]|$)/;

// Is `dir` the folder `root` or inside it? Separator-blind, so a Windows workdir
// (`C:\\r\\x`) matches the forward-slash path `git worktree list` prints.
const sameSep = (p) => p.replace(/\\/g, '/');
function within(dir, root) {
  const d = sameSep(dir);
  const r = sameSep(root).replace(/\/+$/, '');
  return d === r || d.startsWith(`${r}/`);
}

// Where `dir` puts the chat: a worktree root of this repo, `null` for the base repo
// itself, or `undefined` for somewhere that says nothing about where it lives.
//
// `roots` are the repo's other checkouts as `git worktree list` names them (the
// agent's io.worktreesOf). Without them only the .claude/worktrees shape is known,
// and a `git worktree add ../hotfix` the chat then worked in was never followed
// (features/bugs.md B4). A folder outside the repo that is not one of its
// worktrees used to count as "back in the base repo", so a hop into an unknown
// sibling snapped a followed chat back to a folder it was not in either (B14).
// It now says nothing, and the newest command that does decides.
function worktreeRootFor(dir, base, roots) {
  if (roots) {
    for (const root of roots) if (within(dir, root) && !within(base, root)) return root.replace(/[\\/]+$/, '');
  }
  if (!within(dir, base)) return undefined;
  const m = CODEX_WORKTREE_TAIL.exec(dir.slice(base.length));
  return m ? base + m[1] : null;
}

function codexTailWorktree(text, baseCwd, roots = null) {
  const base = typeof baseCwd === 'string' ? baseCwd.replace(/[\\/]+$/, '') : '';
  if (!base) return null;
  const lines = text.split(/\r?\n/);
  let seenNewest = false; // NOT `latest !== null` — the newest workdir is very often the
  let latest = null;      // base repo, which maps to null, and that answer is the point.
  const counts = new Map(); // worktree root -> commands run in it
  let turnCwd = null;       // the newest turn_context's cwd: where Codex last ran a turn
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const p = rec && rec.payload;
    if (rec && rec.type === 'turn_context') {
      if (turnCwd === null && p && typeof p.cwd === 'string') turnCwd = p.cwd.replace(/[\\/]+$/, '');
      continue;
    }
    if (!p || (p.type !== 'function_call' && p.type !== 'custom_tool_call')) continue;
    const args = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : '';
    if (!args) continue;
    // One record can hold several calls; the LAST one in it is the most recent.
    const found = [...args.matchAll(WORKDIR_RE)].map((m) => m[1]);
    for (let k = found.length - 1; k >= 0; k--) {
      let dir;
      try { dir = JSON.parse(`"${found[k]}"`); } catch { dir = found[k]; }
      dir = String(dir || '').replace(/[\\/]+$/, '');
      if (!dir) continue;
      const root = worktreeRootFor(dir, base, roots);
      if (root === undefined) continue; // not this repo: no say in where the chat lives
      // Guard 2, RECENCY: the most recent command decides. If the chat went back to
      // the base repo, `latest` is null and it comes back with it — the inference is
      // self-correcting rather than sticky.
      if (!seenNewest) { seenNewest = true; latest = root; }
      if (root) counts.set(root, (counts.get(root) || 0) + 1);
    }
    // The newest workdir has been seen; keep scanning only to count it.
  }
  // No command in the tail said anything about this repo: a long reply, or a turn spent
  // in another repo's folders, pushed the commands that moved the chat out of the window.
  // The newest turn_context then answers. It is a record, not inference: the cwd Codex was
  // resumed in, which is the folder this chat was last followed into. Without it the chat
  // fell back to session_meta's cwd, the base repo (B14 again, from the window's edge).
  if (!seenNewest) {
    const root = turnCwd ? worktreeRootFor(turnCwd, base, roots) : null;
    return root || null;
  }
  // Guard 1 (shape) is worktreeRootFor; guard 3 is the count: one command in a
  // worktree is a look, not a move.
  if (!latest || (counts.get(latest) || 0) < 2) return null;
  return latest;
}

// Does the tail run anything outside the chat's own folder? Only then is it worth
// asking git for the repo's worktrees (a spawn on the user's box) before
// codexTailWorktree: inside the folder, the .claude/worktrees shape already answers.
function codexTailLeavesBase(text, baseCwd) {
  const base = typeof baseCwd === 'string' ? baseCwd.replace(/[\\/]+$/, '') : '';
  if (!base) return false;
  for (const line of String(text).split(/\r?\n/)) {
    const turn = line.includes('"turn_context"');
    if (!turn && !line.includes('workdir')) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const p = rec && rec.payload;
    if (turn && rec && rec.type === 'turn_context') {
      // A turn resumed in a sibling checkout: codexTailWorktree's fallback needs the list.
      if (p && typeof p.cwd === 'string' && p.cwd && !within(p.cwd, base)) return true;
      continue;
    }
    if (!p || (p.type !== 'function_call' && p.type !== 'custom_tool_call')) continue;
    const args = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : '';
    for (const m of args.matchAll(WORKDIR_RE)) {
      let dir;
      try { dir = JSON.parse(`"${m[1]}"`); } catch { dir = m[1]; }
      if (dir && !within(String(dir), base)) return true;
    }
  }
  return false;
}

// List a machine's sessions (all three engines) via the tunnel. Stashes an id->path index on
// the transport so a subsequent readSession doesn't re-walk. roots = [claudeRoot, codexRoot,
// grokRoot] — grokRoot is already GROK_HOME/sessions (the agent's own confinement root, see
// agent/capabilities.js), not the whole grok home, so it's used directly with no further join.

// Creation provenance is immutable; it is not the current writer. Only label
// sources the provider actually exposes, leaving older/unknown rollouts unknown.
function codexOrigin(text) {
  for (const line of String(text).split(/\r?\n/)) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'session_meta') continue;
    const p = rec.payload || {};
    if (p.originator === 'termdeck') return 'termdeck';
    if (p.source === 'cli') return 'cli';
    if (p.source === 'vscode') return 'external';
    return null;
  }
  return null;
}

// A terminal event is stronger evidence than a fresh file mtime. Tail scans
// tolerate partial records, and carry their last verdict across assistant deltas.
function codexTurnState(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    let rec; try { rec = JSON.parse(lines[i]); } catch { continue; }
    if (rec.type !== 'event_msg') continue;
    const type = rec.payload?.type;
    if (!['task_started', 'task_complete', 'turn_aborted'].includes(type)) continue;
    const at = codexTimestampMs(rec.timestamp);
    if (at == null) continue;
    return {
      active: type === 'task_started',
      at,
      outcome: type === 'task_started' ? 'running'
        : type === 'turn_aborted' ? 'interrupted' : 'completed',
    };
  }
  return null;
}

module.exports = {
  codexOrigin, codexTurnState,
  claudeHead, codexHead, grokHead,
  claudeTailTitle, claudeCustomTitle, claudeTailCwd, projectCwd, claudeLastPrompt, claudeLastCommand, claudeLastCommandAt,
  codexLastPrompt, codexTailWorktree, codexTailLeavesBase,
  isUsableTitle, readUserText, salvagePartialUserText, salvagePartialCodexUserText,
};
