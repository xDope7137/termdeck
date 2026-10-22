'use strict';

// What the session index needs to know about one transcript: its cwd, its title,
// when a human last spoke in it, when it last moved at all, and (Claude only) the
// uuid of the first prompt that fork detection keys on.
//
// This is a PARSE, and it used to happen on the master — which meant the bytes
// came to it. Measured on a real box, one cold index of 200 sessions:
//
//   readFile:head        303 reads   43.84 MB
//   readFile:tail/widen  278 reads   80.38 MB
//                                   ------- 124 MB, ~67s over a home uplink
//
// 124 MB to learn 200 titles and 200 timestamps. The head probe reads up to 128 KB
// looking for a cwd that is almost always in the first 4 KB (measured: 165 of 200
// sessions), and the widening tail scan walks back through megabytes hunting the
// last user prompt. All of it to produce a few hundred bytes per file.
//
// So the parse moved to the machine that already holds the disk — the same trade
// lib/tail-read.js documents ("this is what stops a 51 MB chat from crossing the
// tunnel to show fifteen messages; the counting pass is local disk I/O").
//
// The reader is injected rather than assumed, and that is the whole point: there
// is ONE implementation of this logic, and it runs
//
//   * on the AGENT, against local fs (lib/cloud/machine-host.js asks for it by
//     name, agent/capabilities.js `indexHeads` serves it), and
//   * on the MASTER, against Transport, for an agent too old to have this file.
//
// A second copy on each side would be two title/cwd rules drifting apart, which
// is the failure the repo has already paid for elsewhere.
//
// Shipped to agents by name (AGENT_FILES in master.js), so this module may only
// require SIBLINGS in lib/ — an installed agent has a flat directory.

const { decodeRollout, lastClaudeUserInputAt, lastCodexUserInputAt, lastGrokUserInputAt, lastRecordAt, firstGrokUserInput } = require('./transcript');
const { cleanTitle, normalizeCwd } = require('./claude-data');
const { scanTailWidening, REVISIT_SLACK } = require('./tail-read');
const { codexOrigin, codexTurnState, claudeHead, codexHead, grokHead, claudeTailTitle, claudeCustomTitle, claudeTailCwd, projectCwd, claudeLastPrompt, claudeLastCommand, claudeLastCommandAt, codexLastPrompt, codexTailWorktree, codexTailLeavesBase } = require('./session-head');

// The index's own probe budget — deliberately not lib/tail-read.js's preview
// budget, which is sized to render messages rather than to answer two questions.
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;
const CODEX_LIFECYCLE_CHUNK_BYTES = 512 * 1024;
// The most a carried-forward prompt time makes us read of what grew since it
// was read: the widening ladder's own last-word ceiling.
const GROWTH_SCAN_MAX = 4 * 1024 * 1024;

// The title's own widening ladder. TAIL_BYTES above is already scanned inline,
// so this starts at the next rung up — same shape and the same last-word ceiling
// as lib/tail-read.js's LAST_PROMPT_WINDOWS, for the same reason: a chat with no
// title in its last 4 MB has no better answer available than "(untitled)".
const TITLE_WINDOWS = [512 * 1024, 4 * 1024 * 1024];

// Find the newest Codex lifecycle event in [floor, size), reading backwards in
// bounded chunks. The previous head cache supplies `floor`, so an ordinary
// append costs only what grew. A cold parse walks farther only until it finds
// the newest task_started/task_complete/turn_aborted record.
//
// Adjacent reads overlap by REVISIT_SLACK, which is much larger than a lifecycle
// record. That keeps a task event split at a chunk boundary visible without
// carrying an arbitrarily large response_item across reads. Memory therefore
// stays bounded even when one assistant or tool record spans many chunks.
async function scanCodexLifecycle(path, size, floor, read) {
  const lower = Math.max(0, Math.min(Number(floor) || 0, size));
  let end = Math.max(0, Number(size) || 0);
  while (end > lower) {
    const start = Math.max(lower, end - CODEX_LIFECYCLE_CHUNK_BYTES);
    const readStart = start > lower ? Math.max(lower, start - REVISIT_SLACK) : start;
    let chunk;
    try {
      chunk = await read(readStart, end - readStart);
    } catch {
      return undefined;
    }
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk || '');
    if (!chunk.length) return undefined;
    const hit = codexTurnState(chunk.toString('utf8'));
    if (hit) return hit;
    end = start;
  }
  return null;
}

// `row`: { path, engine, zst, sizeBytes, prevAt, prevActivityAt, noPromptBelow, noTitleBelow }
//   prevAt         — the lastUserAt we already had for this path, at an older
//                    mtime. Carried FORWARD so an append that pushes the last
//                    prompt out of the tail window doesn't lose it.
//   prevActivityAt : the same carry-forward for lastActivityAt. A tail that holds
//                    no whole record (one image-bearing message bigger than the
//                    window) must not answer "never", because the row would fall
//                    back to the mtime this field exists to distrust.
//   noPromptBelow  — how far a previous widening scan already searched without
//                    finding a prompt, so a growing turn re-reads only what it added.
//   noTitleBelow   — the same negative cache for the TITLE scan below.
// `io`:  { readFile(path, offset, len) -> Buffer, readAll(path) -> Buffer, path }
//
// Never throws: an unreadable file yields what the caller already knew.
async function readIndexHead(row, io) {
  const P = io.path;
  const prevAt = row.prevAt || null;
  const prevActivityAt = row.prevActivityAt || null;
  // Set wherever a tail chunk is in hand: one bottom-up pass over bytes the
  // title/prompt scans already paid for, so this costs a parse and no I/O.
  let lastActivityAt = null;
  let origin = null;
  let codexTurn = null;
  const readText = async (path, offset, len) => (await io.readFile(path, offset, len)).toString('utf8');
  const readTailText = async (path, size) => {
    const len = Math.min(size, TAIL_BYTES);
    return readText(path, size - len, len);
  };

  try {
    if (row.engine === 'grok') {
      // cwd/title live in the session dir's summary.json sibling, not
      // updates.jsonl itself (grok's growing transcript carries no head
      // metadata — see lib/grok-data.js's readSummary). Tolerant of a
      // brand-new session whose summary.json hasn't been flushed yet.
      let h = { cwd: null, title: null };
      try {
        h = grokHead(await readText(P.join(P.dirname(row.path), 'summary.json'), 0, HEAD_BYTES));
      } catch {}
      // summary.json is the ONLY title grok has, and a session that ended before it
      // was summarised carries neither generated_title nor session_summary — two
      // real chats on one fleet, both with a perfectly good opening prompt sitting
      // in updates.jsonl. Claude reads its head for exactly this; so does grok now.
      if (!h.title) {
        try {
          h.title = firstGrokUserInput(await readText(row.path, 0, HEAD_BYTES));
        } catch {}
      }
      let lastUserAt = null;
      try {
        const tailText = await readTailText(row.path, row.sizeBytes);
        lastUserAt = lastGrokUserInputAt(tailText);
        lastActivityAt = lastRecordAt(tailText, 'grok');
      } catch {}
      return {
        cwd: h.cwd ? normalizeCwd(h.cwd) : null, // one folder, one project slug
        title: h.title ? cleanTitle(h.title) : null,
        titleKind: null, // Claude-only (see the main return) — grok's title is its own file
        lastUserAt: lastUserAt || prevAt,
        lastActivityAt: lastActivityAt || prevActivityAt,
        firstUserUuid: null,
        noPromptBelow: null,
        noTitleBelow: null,
      };
    }

    const text =
      row.engine === 'codex' && row.zst
        ? decodeRollout(await io.readAll(row.path), row.path) // .zst has no partial read
        : await readText(row.path, 0, HEAD_BYTES);
    const h = row.engine === 'codex' ? codexHead(text) : claudeHead(text);
    let lastUserAt = null;
    // The sort key's bottom rung, held aside while the prose scan widens — see
    // claudeLastCommandAt. Only ever applied once every window above has declined.
    let commandAt = null;
    let noTitleBelow = row.noTitleBelow ?? null;
    // WHICH rung answered. Only 'custom'/'ai' mean the title is a durable record
    // on disk; the rest are re-derived from a window on every rebuild, and are
    // what lib/cloud/machine-host.js's seedTitle offers to make durable.
    let titleKind = null;
    if (row.engine === 'claude') {
      // Titles live in the tail, not the head. A user-set custom title always wins;
      // under it the CLI's own ai-title outranks the head's first human prompt, so a
      // chat is titled by what it is ABOUT rather than by its truncated opening line.
      // Same precedence as lib/session-head.js claudeTailTitle; keep them in step.
      if (h.title) titleKind = 'head';
      try {
        const tailText = await readTailText(row.path, row.sizeBytes);
        const custom = claudeCustomTitle(tailText);
        if (custom) { h.title = custom; titleKind = 'custom'; }
        // claudeTailTitle returns custom||ai and custom is already null here, so this
        // is the ai-title. The head prompt is the next rung and can be missing outright
        // (a huge image-bearing first message overflows HEAD_BYTES); last-prompt is the
        // floor for a session the CLI never titled.
        else {
          const ai = claudeTailTitle(tailText);
          if (ai) { h.title = ai; titleKind = 'ai'; }
          else if (!h.title) {
            const prompt = claudeLastPrompt(tailText);
            if (prompt) { h.title = prompt; titleKind = 'prompt'; }
            else {
              // Bottom rung: a chat with no prose in it at all is named by the
              // command that made it — see claudeLastCommand. A `/clear` stub has
              // nothing else, and every rung above this one has already declined.
              const cmd = claudeLastCommand(tailText);
              if (cmd) { h.title = cmd; titleKind = 'command'; }
            }
          }
        }
        // A chat's cwd can change mid-conversation (promoted into a fresh worktree)
        // past HEAD_BYTES, and the tail is the only place that shows it. But NOT
        // every change is a move: an agent's `cd` into a subdirectory rewrites the
        // cwd on every record after it, and reading that as a relocation is what
        // sent the file dock chasing the agent around the checkout. projectCwd is
        // the rule for which ones count, and it answers with a project or worktree
        // ROOT either way, which is what spawning and resuming want too.
        h.cwd = projectCwd(h.cwd, claudeTailCwd(tailText));
        lastUserAt = lastClaudeUserInputAt(tailText);
        lastActivityAt = lastRecordAt(tailText, 'claude');
        // No prose in the small tail: remember the bottom rung now, because a
        // file under TAIL_BYTES never reaches the widening block below and a
        // `/clear` stub is exactly that — 2 KB, and nothing but the command.
        if (lastUserAt == null) commandAt = claudeLastCommandAt(tailText);
      } catch {}
      // Every rung came up empty, so this chat is about to render as
      // "(untitled) 220437ef" — measured on a real 4.6 MB transcript. The tail
      // window is the reason: the CLI had written no ai-title (it writes none
      // for a Termdeck-started chat), and the last six prompts in the final
      // 64 KB were all literally "continue", which JUNK_TITLES drops on purpose.
      // The chat's real last prompt sat 305 KB up.
      //
      // So widen, exactly like the lastUserAt scan below it — a title is worth
      // one more read for the same reason a sort key is. Only when there is NO
      // title at all: a chat that already resolved one keeps the cheap path, and
      // custom/ai still outrank a prompt WITHIN the widened window.
      if (!h.title && !row.zst && row.sizeBytes > TAIL_BYTES) {
        const found = await scanTailWidening(
          row.sizeBytes,
          async (offset, length) => readText(row.path, offset, length),
          (text) => {
            const custom = claudeCustomTitle(text);
            if (custom) return { kind: 'custom', title: custom };
            const ai = claudeTailTitle(text); // custom is null by here, so this is the ai-title
            if (ai) return { kind: 'ai', title: ai };
            const prompt = claudeLastPrompt(text);
            if (prompt) return { kind: 'prompt', title: prompt };
            const cmd = claudeLastCommand(text);
            return cmd ? { kind: 'command', title: cmd } : null;
          },
          { windows: TITLE_WINDOWS, knownEmptyBelow: noTitleBelow },
        );
        if (found) { h.title = found.title; titleKind = found.kind; }
        // Unanswerable even at the ceiling: remember how far we read, so the
        // next append re-scans only what it added rather than 4 MB per rebuild.
        else noTitleBelow = row.sizeBytes;
      }
    } else {
      // zst decoded above is the whole file; a warm rollout needs a tail read
      // for the last prompt (the head has only the first one).
      let rolloutTail = text;
      if (!row.zst && row.sizeBytes > HEAD_BYTES) {
        try {
          rolloutTail = await readTailText(row.path, row.sizeBytes);
        } catch {}
      }
      lastUserAt = lastCodexUserInputAt(rolloutTail);
      lastActivityAt = lastRecordAt(rolloutTail, 'codex');
      origin = codexOrigin(text);
      if (row.zst || row.sizeBytes <= HEAD_BYTES) {
        codexTurn = codexTurnState(rolloutTail);
      } else {
        const hasPrevious = Object.prototype.hasOwnProperty.call(row, 'prevCodexTurn')
          && Number.isFinite(row.prevSizeBytes) && row.prevSizeBytes >= 0
          && row.prevSizeBytes <= row.sizeBytes;
        const floor = hasPrevious ? Math.max(0, row.prevSizeBytes - REVISIT_SLACK) : 0;
        const scanned = await scanCodexLifecycle(
          row.path,
          row.sizeBytes,
          floor,
          (offset, length) => io.readFile(row.path, offset, length),
        );
        // undefined is a failed read, so let the outer catch preserve the prior
        // answer instead of turning a tunnel hiccup into an idle verdict.
        if (scanned === undefined) throw new Error('Codex lifecycle read failed');
        const previous = hasPrevious ? row.prevCodexTurn : null;
        codexTurn = !scanned ? previous
          : previous && previous.at > scanned.at ? previous : scanned;
      }
      // The head probe found no prompt, so look where Claude looks — see
      // codexLastPrompt for why this rung had to exist. A rollout's preamble
      // grows every release, and past the head budget codexHead's answer is
      // null FOREVER: no tail title record, no session_index entry for a
      // browser-started chat, no seedTitle. The bytes are already in hand.
      if (!h.title) h.title = codexLastPrompt(rolloutTail);
      // Still nothing, and the file is bigger than what we just read: widen the
      // same way the Claude title scan does, on the same ladder and against the
      // same negative cache, so a chat whose only prompt sits between the head
      // probe and the tail window is still named. A zst rollout decoded whole
      // above has already been searched end to end.
      if (!h.title && !row.zst && row.sizeBytes > TAIL_BYTES) {
        const found = await scanTailWidening(
          row.sizeBytes,
          async (offset, length) => readText(row.path, offset, length),
          (t) => codexLastPrompt(t),
          { windows: TITLE_WINDOWS, knownEmptyBelow: noTitleBelow },
        );
        if (found) h.title = found;
        // Unanswerable even at the ceiling: remember how far we read, so the next
        // append re-scans only what it added rather than 4 MB per rebuild.
        else noTitleBelow = row.sizeBytes;
      }
      // Has the chat moved itself into a worktree? codexTailWorktree explains the
      // inference and its guards. The cwd it returns is what the chat is actually
      // working in, so it wins over the head's the way claudeTailCwd does above —
      // it is what the sidebar groups by, what the files dock lists, and what
      // thread/resume is handed on the next turn.
      //
      // Gated on io.isDir, and that is the fourth guard: a worktree the model made
      // and then removed must not become a cwd every later turn fails on. Only the
      // AGENT can answer it — the master's fallback io reads through the tunnel,
      // whose `stat` returns {size,mtimeMs} and is confined to the transcript roots,
      // so it could neither tell a directory from a file nor look at a project path.
      // No answer means no promotion, which leaves the chat exactly where it was.
      //
      // io.worktreesOf (agent only, like isDir) names the repo's other checkouts,
      // so a sibling `git worktree add ../x` can be followed too. Asked only when
      // the tail works outside the chat's folder: it is a git spawn.
      if (h.cwd && typeof io.isDir === 'function') {
        let roots = null;
        if (typeof io.worktreesOf === 'function' && codexTailLeavesBase(rolloutTail, h.cwd)) {
          roots = await io.worktreesOf(h.cwd).catch(() => null);
        }
        const moved = codexTailWorktree(rolloutTail, h.cwd, roots);
        // worktreeOf: the folder the chat was started in, which is the PROJECT it
        // belongs to. A sibling checkout (`git worktree add ../x`) slugs to a name
        // that says nothing about its repo, so without this the chat surfaced as a
        // project of its own that nobody had added, hidden by the sidebar's gate
        // (public/js/worktree-fold.js foldWorktreeProjects reads it).
        if (moved && await io.isDir(moved)) { h.worktreeOf = h.cwd; h.cwd = moved; }
      }
    }
    // The tail held no prompt, but we carried one forward. That carried value
    // is only proof for the bytes that existed when it was read: a prompt
    // appended since, then pushed out of the tail by a long turn, sits between
    // the old size and the tail window, and trusting prevAt there pinned a
    // chat to a prompt hours old (QA 2026-10-08: a 19:12 prompt read back as
    // 18:12). So read what grew since prevAt, capped at the ladder's ceiling.
    // A prevAt with no recorded size cannot say what it covered: widen fully.
    if (lastUserAt == null && prevAt != null && !row.zst && row.sizeBytes > TAIL_BYTES) {
      const prevSize = Number.isFinite(row.prevSizeBytes) && row.prevSizeBytes >= 0
        && row.prevSizeBytes <= row.sizeBytes ? row.prevSizeBytes : null;
      if (prevSize == null || prevSize < row.sizeBytes - TAIL_BYTES) {
        const floor = prevSize == null ? null : Math.max(prevSize, row.sizeBytes - GROWTH_SCAN_MAX);
        const grown = await scanTailWidening(
          row.sizeBytes,
          async (offset, length) => readText(row.path, offset, length),
          row.engine !== 'claude' ? lastCodexUserInputAt : lastClaudeUserInputAt,
          { knownEmptyBelow: floor },
        );
        if (grown != null) lastUserAt = grown;
      }
    }
    // A floor: a transcript only grows, so a carried prompt time never moves
    // back. A file that shrank was rewritten, and only fills a gap with it.
    const shrank = Number.isFinite(row.prevSizeBytes) && row.prevSizeBytes > row.sizeBytes;
    if (prevAt != null && (lastUserAt == null || (!shrank && lastUserAt < prevAt))) lastUserAt = prevAt;
    // Nothing in the small tail and nothing carried forward: widen rather
    // than let the chat fall back to sorting by mtime (see the note on
    // scanTailWidening — a 64 KB window was wrong on 27% of transcripts).
    // Guarded on prevAt so a growing live turn re-reads nothing: only a
    // session we have never resolved pays for the bigger windows.
    let noPromptBelow = row.noPromptBelow ?? null;
    if (lastUserAt == null && !row.zst && row.sizeBytes > TAIL_BYTES) {
      // Claude's scan collects the bottom rung as it goes and keeps WIDENING —
      // returning a command here would stop the ladder and hand back the `/model`
      // you just ran in place of the prose prompt sitting one window further up.
      const scan = row.engine !== 'claude' ? lastCodexUserInputAt : (text) => {
        const at = lastClaudeUserInputAt(text);
        if (at != null) return at;
        commandAt = commandAt ?? claudeLastCommandAt(text);
        return null;
      };
      lastUserAt = await scanTailWidening(
        row.sizeBytes,
        async (offset, length) => readText(row.path, offset, length),
        scan,
        { knownEmptyBelow: noPromptBelow },
      );
      // Unanswerable even at the ceiling: remember how far we got, so the next
      // append re-reads only what it added rather than the whole file again.
      if (lastUserAt == null) noPromptBelow = row.sizeBytes;
    }
    // Below prevAt (a real prose answer we already held) and below every window:
    // a chat that has only ever been driven by slash commands still knows when it
    // was last driven, and must never report "no user message ever".
    if (lastUserAt == null) lastUserAt = commandAt;
    // Last rung: the HEAD chunk, which we already read and paid for at the top of
    // this function. It holds the chat's OPENING prompt, and for a chat that has
    // reached this line that is usually the only prompt there ever was.
    //
    // The ladder above tops out at 4 MB (scanTailWidening's last-word ceiling),
    // which was sized against Claude transcripts. A codex rollout carrying images
    // is a different animal: measured on one box, 20 of 91 codex chats answer null
    // here against 14 of 221 Claude ones, on rollouts of 17, 48 and 94 MB whose
    // last prompt sits 8 to 94 MB above the end. Every one of those rows then has
    // to be placed by something that is not a prompt, and the sidebar put them at
    // positions 294-313 of 313: chats worked in that morning, filed below chats
    // abandoned in July.
    //
    // A floor, never an over-claim: the real answer is at or after the first
    // prompt, so a chat placed by this sorts too LOW rather than jumping a queue
    // it has not earned. Grok returns above this line and has its own head.
    //
    // Skipped where the reads above already covered those bytes. A .zst decoded
    // whole, a rollout inside the head probe and a jsonl inside the tail window
    // have all been read, so a 90 MB decompressed rollout is not scanned end to
    // end a second time to
    // reach the answer it already gave.
    const headCovered = row.engine === 'codex'
      ? row.zst || row.sizeBytes <= HEAD_BYTES
      : row.sizeBytes <= TAIL_BYTES;
    if (lastUserAt == null && !headCovered) {
      lastUserAt = row.engine === 'codex' ? lastCodexUserInputAt(text) : lastClaudeUserInputAt(text);
    }
    return {
      // A cwd recorded with a trailing separator slugs to its own project dir for
      // the codex/grok grouping, and shows as a second copy of the same folder
      // next to the Claude one. Normalise once, here.
      cwd: h.cwd ? normalizeCwd(h.cwd) : null,
      title: h.title ? cleanTitle(h.title) : null,
      // Which rung answered — 'custom' | 'ai' | 'head' | 'prompt' | null, and
      // CLAUDE-only (it is the only engine with a title record to write). The key
      // being PRESENT is what says this parse could answer the question at all;
      // an agent too old to send it must read as unknown, never as "no record on
      // disk", or the master would append a title to a chat that already has one.
      titleKind,
      lastUserAt,
      // The row's displayed "3h ago". Additive: an agent too old to send it
      // leaves the key absent and the browser falls back to the mtime, which is
      // exactly what every row used to show.
      lastActivityAt: lastActivityAt || prevActivityAt,
      ...(row.engine === 'codex' ? { origin, codexTurn } : {}),
      firstUserUuid: row.engine === 'claude' ? h.firstUserUuid || null : null,
      // Codex collab workers announce their parent in the head (see codexHead) —
      // the index uses this to keep them off the session LIST. Additive: an old
      // master ignores it, and an old agent's answers simply lack it.
      subagentOf: row.engine === 'codex' ? h.subagentOf || null : null,
      // Set only when the cwd above was followed into a worktree. Additive.
      ...(row.engine === 'codex' && h.worktreeOf ? { worktreeOf: h.worktreeOf } : {}),
      noPromptBelow,
      noTitleBelow,
    };
  } catch {
    return { cwd: null, title: null, lastUserAt: prevAt, lastActivityAt: prevActivityAt, firstUserUuid: null, noPromptBelow: row.noPromptBelow ?? null, noTitleBelow: row.noTitleBelow ?? null, failed: true };
  }
}

module.exports = { readIndexHead, scanCodexLifecycle, HEAD_BYTES, TAIL_BYTES, CODEX_LIFECYCLE_CHUNK_BYTES };
