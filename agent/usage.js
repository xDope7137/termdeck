'use strict';

// Usage & cost scanner for #/usage. Re-derives token spend from the Claude +
// Codex transcripts on disk — the only place the data exists, since neither
// engine persists a cost figure after the fact (see lib/pricing.js's header).
// `getUsage()` returns TOKENS ONLY; the client prices them with
// public/js/engines.js so this file carries zero pricing knowledge.
//
// One intra-repo require, ./claude-data, which is dependency-free and ships
// alongside this file; otherwise node stdlib only (fs, path, os, zlib). No
// readline: scanOneFile reads each file whole (fsp.readFile) then
// synchronously JSON.parses it line-by-line — see the ponytail note by
// scanOneFile's definition for what that costs and the upgrade path.
// This file ships verbatim to customer agent boxes via master.js's
// AGENT_FILES list (the lib/which.js precedent). A `require('./transcript')`
// here would work on this box and break silently on every customer box, so
// every record shape below is MIRRORED from lib/transcript.js in a comment
// pointing at the source of truth, never imported.
//
// Four landmines, all measured against the real ~/.claude (596MB, 766
// sessions) and ~/.codex (140 rollouts) on the dev box — see
// .claude/build/runs/2026-07-15-usage-cost/plan.md, "Empirical facts":
//
//   1. Subagent transcripts (<slug>/<sessionId>/subagents/agent-*.jsonl) are
//      100% isSidechain:true and are 4.8% of real spend. transcript.js
//      filters `!isSidechain` because it renders the main conversation
//      thread; this scanner must NOT reuse that filter, or it silently
//      undercounts every scan by ~5%. This file never reads `rec.isSidechain`
//      anywhere, on purpose — nothing here even has the option to filter on
//      it. See self-check (e), which fails hard if that filter comes back.
//
//   2. message.id repeats: once per assistant content block (Claude Code
//      writes one jsonl line per block), AND across files (forked/duplicated
//      sessions copy history verbatim — 144 turns measured living in 2-3
//      session files at once). Dedupe is a GLOBAL Set keyed by message.id,
//      across every file from every scan. Two DIFFERENT things are dedupe'd
//      here and must not be conflated (measured: 4,094 of 39,280 message ids
//      — 10.4% — carry DIFFERING usage across their repeated records, because
//      Claude Code persists a PROGRESSIVE snapshot as a turn streams, not a
//      fixed repeated value; one real id goes output 1 -> 2435):
//        - WHO OWNS the turn (attribution / fork-dedupe): the pinned winner
//          (earliest ts, tie-broken by the lexicographically smallest
//          sessionId) — unchanged, deterministic, guarded by self-checks
//          (b1)/(b2). Without a pinned tie-break the *session table* would
//          silently reattribute a forked turn's cost between two identical
//          requests.
//        - WHICH SNAPSHOT is correct (accuracy): the MAX per field across
//          every record sharing that id, computed independently of which
//          record won attribution. Booking the earliest-seen record (as this
//          file once did) books the partial snapshot instead of the final
//          one — measured 10.20% output undercount on the real corpus. Max is
//          used instead of "last" because it's order-independent (readdir's
//          recursive walk order is not guaranteed stable) — measured last-vs-
//          max differ by only 1,168 tokens on the whole corpus, so max costs
//          nothing and needs no walk-order assumption. See self-check (k).
//
//   3. Codex's token_count events carry a RUNNING TOTAL that is NOT safe to
//      sum as-is (duplicate events replay the previous total verbatim — 26%
//      of rollouts measured had at least one). Spend must be reconstructed as
//      a PER-FIELD delta (input_tokens, cached_input_tokens, output_tokens
//      tracked independently) against a HIGH-WATER MARK, not the previous
//      event's raw value: only 6 decrease events exist in the whole real
//      corpus, and 5 of them are stale/out-of-order events that alternate
//      with rising values, not resets. Measured ground truth for
//      input_tokens (peak + any post-reset growth) across all 142 rollouts is
//      705,376,394; treating every decrease as "reset = cur" (a per-field fix
//      this file once shipped) overcounts by +2.17% (720,667,974) because it
//      knocks the running mark down to the stale value and inflates the NEXT
//      delta too; even a plain max(0,cur-prev) clamp still overcounts by
//      +0.04% for the same reason. High-water-mark reproduces the ground
//      truth exactly. See fieldDelta() and self-check (c).
//
//      A SCALAR comparison across all three fields is a different, older bug
//      and still wrong and dangerous: a cache-shrink-while-input-grows
//      compaction (e.g. {input:1000,cached:800} -> {input:1200,cached:100})
//      looks like a "reset" when summed (1550 < 2000) and books the WHOLE new
//      input as fresh spend — a ~6x overcount on that field. Computed
//      per-field instead, the true fresh delta is +100, not +1200.
//
//   4. Claude's cache_creation_input_tokens IS THE AGGREGATE of
//      cache_creation.ephemeral_{1h,5m}_input_tokens, not a fourth bucket
//      alongside them. Measured: 39,235 records carry both the aggregate and
//      the breakdown, ZERO carry the aggregate without it, and 35 records
//      have agg != cc1h+cc5m (e.g. cc=9432, cc1h=5996, cc5m=0 — the breakdown
//      can be INCOMPLETE, so the aggregate stays authoritative for token
//      totals). cacheCreate is the field to sum for tokens; cc1h/cc5m are
//      emitted alongside it only for cost tiering (1h-cache vs 5m-cache price
//      differently) — summing cacheCreate + cc1h + cc5m double-counts by
//      ~2.9% of all tokens. This file never adds them together; see the
//      fields' own comments in scanClaudeText and self-check (l).
//
//   5. `projects` (added-project allowlist, follow-up to the shipped feature)
//      must agree with the SIDEBAR's notion of "project", which is NOT the
//      same derivation for both engines:
//        - Claude: the slug IS the directory name directly under claudeRoot
//          (`<slug>/<sessionId>.jsonl` and `<slug>/<sessionId>/subagents/*`).
//          A worktree gets its own directory with its own name, even though
//          its RECORDED cwd is often the parent repo — using slugForCwd(cwd)
//          here would silently fold an unadded worktree's spend into its
//          (added) parent's total. The dirname is authoritative; do not
//          "simplify" this to cwd. See self-check (p).
//        - Codex: rollouts have no slug in their path (they live at
//          sessions/YYYY/MM/DD/rollout-*, date-derived, never slug-derived —
//          see codex-data.js's header) — the slug is only knowable AFTER
//          reading that file's session_meta.cwd, via lib/claude-data.js's
//          slugForCwd(), the one the sidebar uses. See self-check (n).
//      Two different enforcement points, for two different reasons:
//        - Claude: skip the whole <slug> directory during the WALK when it's
//          not allowed — this is the "only gets" half of the ask and the big
//          speedup (an unadded project's files are never even stat'd).
//        - Codex: the walk can't skip by slug (no directory-per-project
//          layout), so a disallowed rollout is bailed out of AS SOON AS its
//          slug is known (right after its first session_meta), before the
//          expensive per-event delta-reconstruction loop runs.
//      Whichever half of the walk does the filtering, the RESULT is never
//      trusted alone: every turn (both engines) carries its own `slug`, and
//      collectTurns() re-filters on it from the (per-file) cache before
//      dedupe/aggregation — so a stale full cache entry from an earlier,
//      broader scan (or a differently-filtered concurrent call sharing the
//      same process-wide fileCache) can never leak an unadded project's
//      tokens into the response. See self-check (m).
//      A bailed Codex scan is deliberately NEVER written to fileCache (see
//      scanOneFile) — caching an early-exit "nothing here" would wrongly
//      serve that same empty result forever once the project is added (or a
//      future unfiltered call needs the real data). Redoing the bail is cheap
//      (it stops at the first session_meta line).
//
// ponytail: cache is in-memory only, no disk persistence, no mtime prefilter
// on the directory walk (that shortcut was cut in plan review — it traded a
// silent-undercount risk on NFS/FUSE stale stats for time the per-file
// mtime+size cache already saves). A cold scan of the real corpus above is
// ~2.4s; that's the ceiling until someone measures a real complaint. Upgrade
// path if it ever matters more than correctness: persist the fileCache Map to
// a json file, or tail-read from a byte offset instead of a full re-read.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { slugForCwd } = require('./claude-data');

// CLAUDE_CONFIG_DIR relocates Claude Code's whole data dir (SDK-supported var,
// mirrors CODEX_HOME below) — honour it so a customer who set it doesn't get an
// empty usage report.
const DEFAULT_CLAUDE_ROOT = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const DEFAULT_CODEX_ROOT = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');

const TRASH_DIR = '.termdeck-trash';

// Same filename convention codex-data.js parses (rollout-<localtime>-<uuid>.jsonl{,.zst}).
// Duplicated rather than required: codex-data.js does not ship to agents.
const ROLLOUT_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i;
const CODEX_TURN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ================= day bucketing — forward only, no inverse timezone math ================= */

// tzOffset follows Date.prototype.getTimezoneOffset()'s sign convention
// (minutes, inverted — IST = -330). Verified against the plan's worked
// examples: a 02:00Z turn -> local day D for IST; a 20:00Z turn -> D+1; an
// 18:00Z turn -> D. Callers compare day strings lexicographically
// (`day >= from && day <= to`) — ISO dates sort correctly as strings, so no
// inverse-timezone formula exists anywhere in this file. Known gap (documented,
// not fixed): a single scalar tzOffset mis-buckets turns near a DST transition
// for a host in a DST zone.
function dayKey(tsMs, tzOffsetMin) {
  return new Date(tsMs - tzOffsetMin * 60000).toISOString().slice(0, 10);
}

// Validate BEFORE any Date math touches these values. A non-finite tzOffset
// reaching `new Date(NaN - ...).toISOString()` throws `RangeError: Invalid
// time value` — and per the plan, agent/capabilities.js's uncaughtException
// handler calls process.exit(1), so one malformed query string must never
// reach that point. Reject here, at the one function every caller goes
// through, rather than trusting each of the three call sites (hub route,
// agent capability, self-check) to remember.
function assertValidDayString(s, label) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`usage: ${label} must be a YYYY-MM-DD date string, got ${JSON.stringify(s)}`);
  }
  if (!Number.isFinite(Date.parse(`${s}T00:00:00Z`))) {
    throw new Error(`usage: ${label} is not a valid calendar date: ${s}`);
  }
}

function assertValidTzOffset(tz) {
  if (!Number.isFinite(tz)) {
    throw new Error(`usage: tzOffset must be a finite number of minutes, got ${JSON.stringify(tz)}`);
  }
}

/* ================= per-field Codex delta reconstruction (fact 3) ================= */

// One field of one token_count event vs. the running HIGH-WATER MARK for
// that field (not simply "the previous event's value" — see below for why).
// Returns { delta, next } — next is the mark the caller must carry forward.
//   cur > prev   -> normal growth: delta = cur-prev, mark advances to cur.
//   cur === prev -> duplicate event (verbatim replay): delta 0, mark holds.
//   cur === 0 && prev > 0 -> GENUINE reset (measured: the only real corpus
//     example drops to EXACTLY zero): delta 0 (nothing to attribute on the
//     reset event itself — prior spend was already booked by earlier
//     deltas), mark resets to 0 so the NEXT event's growth is correct.
//   cur < prev, cur !== 0 -> STALE / out-of-order event (measured: 5 of the
//     6 real decrease events are this, alternating with rising values, not a
//     reset): delta 0, mark HELD at its high-water value. Booking `cur` here
//     (the once-shipped per-field "reset" rule) double-books nothing by
//     itself, but knocking the mark down to the stale value inflates the
//     NEXT delta — see the header's landmine 3 for the measured +2.17%.
function fieldDelta(cur, prev) {
  if (cur > prev) return { delta: Math.max(0, cur - prev), next: cur };
  if (cur === prev) return { delta: 0, next: prev };
  if (cur === 0) return { delta: 0, next: 0 };
  return { delta: 0, next: prev };
}

/* ================= module-level cache: Map(absPath -> {mtimeMs, size, turns}) ================= */
//
// turns[] per file are RANGE-INDEPENDENT (no day/tzOffset baked in) — getUsage
// filters+aggregates from this in memory on every call, so a range switch or a
// second tab costs zero disk I/O once the corpus is warm. Invalidated on
// (mtimeMs, size) change.

const fileCache = new Map();
// Coalesces concurrent identical scans (same claudeRoot+codexRoot pair) into
// one promise. Two tabs cold-loading, or a reload while a scan is still
// running, must not stack a second full walk of a customer's disk on a
// single-threaded process that's also streaming live tokens. Keyed by the
// root pair, not by from/to/tzOffset — the underlying walk is range-
// independent, so any concurrent call with the same roots can share it.
const inflight = new Map();

function isUnder(p, root) {
  return p === root || p.startsWith(root + path.sep);
}

// Any `.termdeck-trash/` path segment, at any depth. The agent's trash op
// (agent/capabilities.js `mutate` -> `trash`) moves a session file WITHIN its
// transcript root, so without this a trashed session keeps counting forever
// under its new path.
function isInTrash(fullPath, root) {
  const rel = path.relative(root, fullPath);
  return rel.split(path.sep).includes(TRASH_DIR);
}

/* ================= Claude walk ================= */

// Top-level entries directly under <claudeRoot> are ALWAYS either a project
// slug directory or `.termdeck-trash` — never a session file (verified
// against agent/capabilities.js's `trash` mutation, which creates
// `.termdeck-trash` as a sibling of the slug dirs, inside the same root). That
// structural fact is what makes the allowlist skip a genuine "never even
// stat'd" optimization rather than a post-hoc filter: for a slug NOT in
// `allowedSlugs`, this function never calls readdir on that directory at all
// (see self-check (m), which proves this with a readdir spy, not just a
// totals assertion).
//
// Recurses <claudeRoot>/<slug>/** for every *.jsonl, taking BOTH
// <slug>/<sessionId>.jsonl (main thread) and
// <slug>/<sessionId>/subagents/agent-*.jsonl (subagent transcripts) with the
// exact same per-line filter — see landmine 1 above. They're always disjoint
// files (a subagent's assistant turns never also appear in the parent's own
// jsonl), so there is no double-count risk in treating them identically.
//
// allowedSlugs: a Set of LOWERCASED slugs, or null for no filter (today's
// behavior, unchanged). -> [{filePath, slug}]. pruneCache tells "filtered out
// this round" apart from "genuinely deleted" using this SAME allowedSlugs Set
// (see pruneCache's own comment) rather than a separate on-disk existence
// check — a slug directory merely still existing on disk is not enough to
// prove a particular file inside it wasn't deleted.
async function listClaudeFiles(root, allowedSlugs) {
  let topEntries;
  try {
    topEntries = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return []; // fresh install, no ~/.claude yet
    throw err;
  }
  const files = [];
  for (const top of topEntries) {
    if (!top.isDirectory()) continue; // a stray file directly under claudeRoot is never a session
    if (top.name === TRASH_DIR) continue; // never a project, regardless of allowlist
    const slug = top.name;
    if (allowedSlugs && !allowedSlugs.has(slug.toLowerCase())) continue; // THE skip — no readdir below this line for this slug
    const dirPath = path.join(root, slug);
    let nested;
    try {
      nested = await fsp.readdir(dirPath, { recursive: true, withFileTypes: true });
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) continue; // raced a delete between the two readdirs
      throw err;
    }
    for (const e of nested) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      // Dirent.parentPath doesn't exist before Node 20.12/21.4 — those
      // runtimes expose Dirent.path instead (the installer advertises Node
      // 18+, so this isn't a theoretical gap). e.path must be tried BEFORE
      // falling back to dirPath: dirPath is only correct for depth-0 entries
      // (a session's own .jsonl); a subagent file two directories deeper
      // (<sessionId>/subagents/agent-*.jsonl) would reconstruct to the wrong
      // path under dirPath alone, fail its stat, and be dropped silently —
      // see FIX 3 / self-check (r). Same fallback order as
      // agent/capabilities.js's listTree case.
      const full = path.join(e.parentPath || e.path || dirPath, e.name);
      if (isInTrash(full, root)) continue; // belt-and-suspenders; the top-level skip above already excludes the normal case
      files.push({ filePath: full, slug });
    }
  }
  return files;
}

// type==='assistant' && message.usage && message.model !== '<synthetic>' —
// deliberately NEVER checks rec.isSidechain (landmine 1). '<synthetic>' marks
// the session-limit placeholder Claude Code injects (measured: always
// zero-usage, so excluding it is a no-op either way, but the model check is
// cheap and matches transcript.js's own convention).
function scanClaudeText(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing-newline artifact, not a line
  const turns = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Torn final line (live write in progress — the normal case, since
      // opening #/usage during an active chat is expected) or mid-file
      // garbage. Either way: skip this line, keep the rest of the file.
      continue;
    }
    if (!rec || rec.type !== 'assistant' || !rec.message || typeof rec.message !== 'object') continue;
    const msg = rec.message;
    if (typeof msg.model !== 'string' || !msg.model || msg.model === '<synthetic>') continue;
    const u = msg.usage;
    if (!u || typeof u !== 'object') continue;
    const id = typeof msg.id === 'string' && msg.id ? msg.id : null;
    if (!id) continue; // can't dedupe safely without an id — drop rather than risk overcounting
    const sessionId = typeof rec.sessionId === 'string' && rec.sessionId ? rec.sessionId : null;
    if (!sessionId) continue; // sessions[] keys on this; an id-less record can't be attributed
    const ts = Date.parse(rec.timestamp);
    // An unparseable timestamp can't be day-bucketed honestly — booking it
    // into "now" would silently inflate today's total with old spend and
    // make output non-deterministic (re-running later buckets it elsewhere).
    // Drop it, same as the no-id case above, and surface the count in
    // meta.skipped instead of losing it silently.
    if (!Number.isFinite(ts)) { skipped++; continue; }
    const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
    turns.push({
      id,
      ts,
      engine: 'claude',
      model: msg.model,
      sessionId,
      project: typeof rec.cwd === 'string' && rec.cwd ? rec.cwd : null,
      fresh: u.input_tokens || 0, // Claude's input_tokens already excludes cache reads
      cacheRead: u.cache_read_input_tokens || 0,
      // cacheCreate IS THE AGGREGATE (landmine 4) — the field to sum for
      // token totals. cc1h/cc5m below are its breakdown by cache TTL, kept
      // ONLY for cost tiering (1h vs 5m cache writes price differently); they
      // can be an INCOMPLETE breakdown of the same aggregate (measured: 35
      // records have agg != cc1h+cc5m). NEVER add cacheCreate + cc1h + cc5m
      // together anywhere downstream — that's the whole bug (~2.9% token
      // inflation, measured). See self-check (l).
      cacheCreate: u.cache_creation_input_tokens || 0,
      cc1h: (cc && cc.ephemeral_1h_input_tokens) || 0, // breakdown only, not additive with cacheCreate
      cc5m: (cc && cc.ephemeral_5m_input_tokens) || 0, // breakdown only, not additive with cacheCreate
      output: u.output_tokens || 0,
    });
  }
  return { turns, skipped };
}

/* ================= Codex walk ================= */

// Cold rollouts are zstd-compressed in place. Duplicated from
// transcript.js's decodeRollout (can't require it — see header).
function decodeRollout(buf, name) {
  if (!name.endsWith('.zst')) return buf.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('compressed rollout needs Node >= 22.15 (zlib zstd support)');
  }
  return zlib.zstdDecompressSync(buf).toString('utf8');
}

// Recurse <codexRoot>/** for rollout-*.jsonl{,.zst}. When both a .jsonl and
// its .zst twin exist for the same session id, the .jsonl (warm copy) wins —
// same rule codex-data.js's scanRollouts applies.
async function listCodexFiles(root) {
  let entries;
  try {
    entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return []; // fresh install, no ~/.codex yet
    throw err;
  }
  const byId = new Map();
  for (const e of entries) {
    if (!e.isFile()) continue;
    // Same Dirent.parentPath / pre-20.12 fallback as listClaudeFiles above —
    // e.path (the pre-20.12 field) must be tried before the dirPath-style
    // last resort (`root`), or a nested rollout path is silently wrong.
    const full = path.join(e.parentPath || e.path || root, e.name);
    if (isInTrash(full, root)) continue;
    const m = ROLLOUT_RE.exec(e.name);
    if (!m) continue;
    const sessionId = m[1];
    const compressed = Boolean(m[2]);
    const prev = byId.get(sessionId);
    if (prev && !prev.compressed) continue; // .jsonl already won for this id
    byId.set(sessionId, { filePath: full, sessionId, compressed });
  }
  return [...byId.values()];
}

// Delta-reconstructs total_token_usage per landmine 3 (per-field, against a
// high-water mark — see fieldDelta above). Model comes from the most recent turn_context.model
// preceding each token_count event (session_meta carries no model; a
// mid-session model change was measured on this box). A duplicate event
// (all three field deltas zero) is dropped rather than pushed as a
// zero-token turn — see self-check (c).
// Copied Codex fork history is deduped globally by its preserved turn UUID
// and cumulative counters. The earliest surviving copy supplies the request's
// date and delta; see tests/usage-scanner.mjs for full and partial forks.
//
// allowedSlugsLower (landmine 5): a Set of lowercased slugs, or null/undefined
// for no filter. The instant the first session_meta gives us cwd -> slug, and
// that slug isn't wanted, this returns `{ turns: [], skipped: 0, slug,
// bailed: true }` — well before the (potentially long) per-event delta loop
// below ever runs. `bailed: true` tells the caller (scanOneFile) to NOT cache
// this result; see that function's comment for why. A rollout with no
// session_meta.cwd at all (slug stays null) is never bailed — we can't prove
// it's unwanted, and this file's own philosophy throughout is "never silently
// drop data we can't positively attribute" (see the ts-skip comments below).
// `resume`: the `state` a previous call over the lines ABOVE `text` returned,
// so an appended slice is scanned exactly as if the whole file had been
// (features/04 phase 9). Every variable the loop carries across lines is in it.
function scanCodexText(text, sessionId, allowedSlugsLower, resume = null) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const turns = [];
  let skipped = 0;
  let { cwd, slug, model, turnId, resetIdx, prevInput, prevCached, prevOutput, turnIdx } = resume || {
    cwd: null, slug: null, model: null, turnId: null, resetIdx: 0, prevInput: 0, prevCached: 0, prevOutput: 0, turnIdx: 0,
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // torn final line or mid-file garbage
    }
    if (!rec || typeof rec !== 'object') continue;

    if (rec.type === 'session_meta' && !cwd && rec.payload && typeof rec.payload.cwd === 'string') {
      cwd = rec.payload.cwd; // first session_meta is canonical
      slug = slugForCwd(cwd);
      if (allowedSlugsLower && !allowedSlugsLower.has(slug.toLowerCase())) {
        return { turns: [], skipped: 0, slug, bailed: true };
      }
    }
    if (rec.type === 'turn_context' && rec.payload) {
      if (typeof rec.payload.model === 'string' && rec.payload.model) model = rec.payload.model;
      // Forks copy turn IDs along with the parent history, even when the
      // recorder replaces every timestamp with the fork's creation time.
      // Only UUIDs are globally unique; legacy local IDs must stay scoped
      // to their session or two independent sessions can lose equal usage.
      const nextId = CODEX_TURN_ID_RE.test(rec.payload.turn_id || '') ? rec.payload.turn_id : null;
      if (turnId !== nextId) resetIdx = 0;
      turnId = nextId;
    }
    if (rec.type === 'event_msg' && rec.payload && rec.payload.type === 'task_started') {
      const nextId = CODEX_TURN_ID_RE.test(rec.payload.turn_id || '') ? rec.payload.turn_id : null;
      if (turnId !== nextId) resetIdx = 0;
      turnId = nextId;
    }
    if (rec.type !== 'event_msg' || !rec.payload || rec.payload.type !== 'token_count') continue;
    const info = rec.payload.info;
    const total = info && info.total_token_usage;
    if (!total || typeof total !== 'object') continue;

    const curInput = total.input_tokens || 0;
    const curCached = total.cached_input_tokens || 0;
    const curOutput = total.output_tokens || 0;
    if (curInput === 0 && curCached === 0 && curOutput === 0 && (prevInput || prevCached || prevOutput)) resetIdx++;
    const dInput = fieldDelta(curInput, prevInput);
    const dCached = fieldDelta(curCached, prevCached);
    const dOutput = fieldDelta(curOutput, prevOutput);
    const deltaInput = dInput.delta, deltaCached = dCached.delta, deltaOutput = dOutput.delta;
    // Carry forward the HIGH-WATER MARK returned by fieldDelta, never the raw
    // `cur` — that's precisely what the header's landmine 3 fix is about.
    prevInput = dInput.next;
    prevCached = dCached.next;
    prevOutput = dOutput.next;

    // codex input_tokens INCLUDES cached reads (unlike Claude) — normalize to
    // the same fresh/cacheRead split, computed on the DELTAS, never the totals.
    const fresh = Math.max(0, deltaInput - deltaCached);
    const cacheRead = deltaCached;
    if (fresh === 0 && cacheRead === 0 && deltaOutput === 0) continue; // duplicate event, no signal

    const ts = Date.parse(rec.timestamp);
    // Same reasoning as the Claude side: an unparseable timestamp can't be
    // day-bucketed honestly, and booking it under "now" would silently
    // inflate today's total with old spend and make output non-deterministic.
    // Drop it and count it in meta.skipped instead. prevInput/prevCached/
    // prevOutput above are already updated, so the NEXT event's delta is
    // still correct — only this one turn's contribution is lost.
    if (!Number.isFinite(ts)) { skipped++; continue; }
    turns.push({
      // One cumulative snapshot within a turn identifies a request across
      // copied fork history. Session-local indexes double-book that history
      // once per descendant. Keep them only for older logs without turn IDs;
      // unrelated sessions with equal token totals must still count separately.
      id: turnId ? JSON.stringify(['codex', turnId, resetIdx, curInput, curCached, curOutput]) : `${sessionId}:${turnIdx++}`,
      ts,
      engine: 'codex',
      model: model || 'unknown',
      sessionId,
      project: cwd,
      slug, // landmine 5 — slugForCwd(cwd), re-checked at aggregation regardless of any bail above
      fresh,
      cacheRead,
      cacheCreate: 0,
      cc1h: 0,
      cc5m: 0,
      output: deltaOutput,
    });
  }
  return { turns, skipped, slug, state: { cwd, slug, model, turnId, resetIdx, prevInput, prevCached, prevOutput, turnIdx } };
}

/* ================= scan + cache orchestration ================= */

// ponytail: this reads each file's FULL contents (fsp.readFile) then does a
// synchronous split('\n') + JSON.parse loop (scanClaudeText/scanCodexText) —
// no readline, no streaming. That blocks the event loop for the duration of
// one file's parse; every other file in the same scan (and every other
// request this process is serving) waits behind it. Fine at the measured
// scale (~2.4s cold for a 596MB/766-session corpus, spread across many
// files); the ceiling is a single very large transcript blocking the loop
// during its own parse. Upgrade path if that ever matters more than the
// simplicity of this file: chunked/streamed parsing with a yield between
// chunks (readline, or a manual byte-offset read loop). Out of scope here —
// do not re-architect this without a measured complaint.
// slugHint: the Claude directory-name slug (always given for kind==='claude',
// pre-resolved by listClaudeFiles — every turn out of one Claude file shares
// it, so it's stamped on after the parse rather than threaded through
// scanClaudeText). allowedSlugs: only consulted for kind==='codex', where the
// slug isn't knowable until mid-parse — see scanCodexText and landmine 5.
async function scanOneFile(filePath, kind, sessionIdHint, slugHint, allowedSlugs) {
  let st;
  try {
    // STAT BEFORE READ. Read-then-stat lets an append landing between
    // stream-end and the stat record an inflated (mtime,size) key against
    // stale, short content — the cache then hits forever and those tokens are
    // permanently lost with no error and no self-heal. Stat-then-read is
    // self-healing: later growth simply mismatches the cached key and
    // triggers a rescan on the next call.
    st = await fsp.stat(filePath);
  } catch {
    // Vanished between listing and stat. `vanished: true` tells the caller
    // NOT to mark this path as seen this round (FIX 5) — marking it
    // unconditionally would let a since-deleted file's stale cache entry
    // survive pruneCache forever, since it would never again fail to be
    // "seen" once wrongly marked so on this one race.
    return { turns: [], skipped: 0, unreadable: 0, cached: false, vanished: true };
  }
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return { turns: cached.turns, skipped: cached.skipped, unreadable: 0, cached: true };
  }
  let turns, skipped, bailed = false;
  let resumable = null; // what the next call needs to scan only what is appended
  try {
    if (kind === 'claude' || !filePath.endsWith('.zst')) {
      // Transcripts only grow. A file that grew past what the last scan read,
      // whose bytes just before that point are the ones it read (the probe),
      // is scanned from there; anything else is scanned whole. Only whole
      // lines are committed: an unterminated last record is scanned for this
      // answer and scanned again, whole, next time (features/04 phase 9).
      let from = 0;
      let base = null;
      if (cached && cached.resume && st.size > cached.size) {
        try { if ((await probeAt(filePath, cached.resume.offset)) === cached.resume.probe) { from = cached.resume.offset; base = cached.resume; } } catch {}
      }
      const buf = await readRange(filePath, from, st.size);
      const nl = buf.lastIndexOf(0x0a);
      const complete = nl === -1 ? '' : buf.subarray(0, nl + 1).toString('utf8');
      const tail = buf.subarray(nl + 1).toString('utf8');
      const offset = from + nl + 1;
      if (kind === 'claude') {
        const stamp = (list) => list.map((t) => ({ ...t, slug: slugHint })); // every turn in this file shares one slug
        const c = scanClaudeText(complete);
        const committed = (base ? base.committed : []).concat(stamp(c.turns));
        const committedSkipped = (base ? base.committedSkipped : 0) + c.skipped;
        const t = tail.trim() ? scanClaudeText(tail) : { turns: [], skipped: 0 };
        turns = t.turns.length ? committed.concat(stamp(t.turns)) : committed;
        skipped = committedSkipped + t.skipped;
        resumable = { offset, committed, committedSkipped };
      } else {
        const c = scanCodexText(complete, sessionIdHint, allowedSlugs, base ? base.state : null);
        if (c.bailed) {
          bailed = true;
        } else {
          const committed = (base ? base.committed : []).concat(c.turns);
          const committedSkipped = (base ? base.committedSkipped : 0) + c.skipped;
          const t = tail.trim() ? scanCodexText(tail, sessionIdHint, allowedSlugs, { ...c.state }) : { turns: [], skipped: 0 };
          if (t.bailed) bailed = true;
          turns = t.turns && t.turns.length ? committed.concat(t.turns) : committed;
          skipped = committedSkipped + (t.skipped || 0);
          resumable = { offset, committed, committedSkipped, state: c.state };
        }
      }
      if (resumable) resumable.probe = await probeAt(filePath, resumable.offset);
    } else {
      // A .zst rollout is compressed: there is no offset into it to resume
      // from, so it is decoded whole. Cold rollouts never grow, so this runs
      // once per file per process.
      const buf = await fsp.readFile(filePath);
      const result = scanCodexText(decodeRollout(buf, filePath), sessionIdHint, allowedSlugs);
      ({ turns, skipped } = result);
      bailed = Boolean(result.bailed);
    }
  } catch {
    // Read or decompress failed after a successful stat — most likely a
    // .jsonl.zst rollout on a Node build without zstd support (< 22.15;
    // decodeRollout throws rather than returning garbage), or a genuine
    // deleted-mid-race/unreadable file. This used to be swallowed silently,
    // substituting an empty file and reporting success with a quietly
    // shrunken total (FIX 4) — now it's counted as `unreadable` so the
    // caller can surface "N files unreadable" instead of lying. Still serve
    // the last-known-good cache rather than losing this file's history for
    // the current scan.
    return { turns: cached ? cached.turns : [], skipped: cached ? cached.skipped : 0, unreadable: 1, cached: Boolean(cached) };
  }
  if (bailed) {
    // Landmine 5: a bailed Codex scan only proves "not wanted under TODAY's
    // filter" — caching it would wrongly serve empty forever once the project
    // is added, or once a differently-filtered/unfiltered call needs the real
    // data (the process-wide fileCache is shared across every caller,
    // regardless of which filter each one happens to pass). Skip the
    // fileCache.set below entirely; redoing the bail next time is cheap (it
    // stops at the first session_meta line, before the expensive per-event
    // delta loop).
    return { turns: [], skipped: 0, unreadable: 0, cached: false };
  }
  fileCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, turns, skipped, resume: resumable });
  return { turns, skipped, unreadable: 0, cached: false };
}

async function readRange(filePath, from, to) {
  const len = Math.max(0, to - from);
  const fd = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = len ? await fd.read(buf, 0, len, from) : { bytesRead: 0 };
    return buf.subarray(0, bytesRead);
  } finally { await fd.close(); }
}

// The file's identity and the bytes just before `offset`: equal on a later
// call means the bytes a resumed scan skips are the ones it already counted.
async function probeAt(filePath, offset) {
  const fd = await fsp.open(filePath, 'r');
  try {
    const st = await fd.stat();
    const len = Math.min(64, offset);
    const buf = Buffer.alloc(Math.max(0, len));
    const { bytesRead } = len > 0 ? await fd.read(buf, 0, len, offset - len) : { bytesRead: 0 };
    return `${st.dev}:${st.ino}:${buf.subarray(0, bytesRead).toString('base64')}`;
  } finally { await fd.close(); }
}

// Prune cache entries under `root` that weren't touched by the current walk
// (deleted/trashed/archived sessions) — otherwise the Map only grows across a
// months-long uptime.
//
// allowedSlugsLower (Claude only; null for codexRoot — see the doScanAll call
// sites): the EXACT allowlist Set this round's walk used, or null for no
// filter. THE INVARIANT this must preserve: an unseen entry is only proof of
// deletion when the walk actually WOULD have looked for it.
//   - allowedSlugsLower is null (no filter): the walk visits every slug
//     directory, so any unseen entry is genuinely gone -> prune.
//   - the entry's slug IS in allowedSlugsLower: listClaudeFiles' directory
//     skip does NOT apply to this slug — the walk descended into it and
//     listed whatever files remain there. An unseen entry under an ALLOWED
//     slug is therefore genuinely gone (deleted/trashed) -> prune.
//   - the entry's slug is NOT in allowedSlugsLower: the walk deliberately
//     skipped this slug's directory wholesale (never even readdir-ed it —
//     that's the whole point of the directory-level skip). "Unseen" here
//     means "we never looked", not "genuinely deleted" -> preserve, so
//     re-adding the project (or a future unfiltered call) can reuse the
//     cache instead of rescanning from cold.
// A PRIOR version of this check used "does the slug directory still exist on
// disk" instead of "is the slug in THIS round's allowlist" — that conflates
// "excluded by the allowlist" with "genuinely deleted" whenever an ALLOWED
// project's directory still exists (the common case: one session inside it
// got deleted, not the whole project), so a deleted session's stale entry
// survived in fileCache forever with no error. See self-check (q), which
// fails against that version.
function pruneCache(root, seen, allowedSlugsLower) {
  for (const key of fileCache.keys()) {
    if (!isUnder(key, root) || seen.has(key)) continue;
    if (allowedSlugsLower) {
      const rel = path.relative(root, key);
      const slug = rel.split(path.sep)[0];
      if (!allowedSlugsLower.has(slug.toLowerCase())) continue; // deliberately skipped this round — not proof of deletion
    }
    fileCache.delete(key);
  }
}

async function doScanAll(claudeRoot, codexRoot, allowedSlugs) {
  const claudeFiles = await listClaudeFiles(claudeRoot, allowedSlugs);
  const codexFiles = await listCodexFiles(codexRoot);
  const seen = new Set();
  let scannedFiles = 0, cachedFiles = 0, skippedTurns = 0, unreadableFiles = 0;

  for (const { filePath, slug } of claudeFiles) {
    const r = await scanOneFile(filePath, 'claude', null, slug, allowedSlugs);
    // Only mark `seen` once the file actually resolved (FIX 5) — a listing
    // that raced a delete/trash must not poison pruneCache into keeping a
    // now-gone file's stale turns forever.
    if (!r.vanished) {
      seen.add(filePath);
      if (r.cached) cachedFiles++; else scannedFiles++;
    }
    skippedTurns += r.skipped;
    unreadableFiles += r.unreadable;
  }
  for (const f of codexFiles) {
    const r = await scanOneFile(f.filePath, 'codex', f.sessionId, null, allowedSlugs);
    if (!r.vanished) {
      seen.add(f.filePath);
      if (r.cached) cachedFiles++; else scannedFiles++;
    }
    skippedTurns += r.skipped;
    unreadableFiles += r.unreadable;
  }

  pruneCache(claudeRoot, seen, allowedSlugs);
  pruneCache(codexRoot, seen, null); // codex has no directory-per-project layout to spare from pruning — see landmine 5
  return { scannedFiles, cachedFiles, skippedTurns, unreadableFiles };
}

// Inflight key includes the allowlist (sorted, so set-equal filters always
// collide on the same key regardless of array order): the WALK itself now
// depends on `projects` (Claude skips directories by it; Codex bails by it),
// so two concurrent calls with the SAME roots but DIFFERENT filters must NOT
// coalesce onto one promise — one of the two callers would silently get the
// other's (wrongly filtered, or wrongly unfiltered) result.
function scanAll(claudeRoot, codexRoot, allowedSlugs) {
  const key = JSON.stringify([claudeRoot, codexRoot, allowedSlugs ? [...allowedSlugs].sort() : null]);
  const running = inflight.get(key);
  if (running) return running;
  const p = doScanAll(claudeRoot, codexRoot, allowedSlugs).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Re-filters by `slug` regardless of what the walk already skipped/bailed —
// the AUTHORITATIVE gate (landmine 5). The process-wide fileCache can hold
// turns from an earlier broader/differently-filtered scan (or a concurrent
// call for a different allowlist sharing the same roots); without this
// re-check here, those cached-but-unwanted turns would leak straight into the
// response. allowedSlugs null => no filter, unchanged from before this
// feature. A turn with no slug (Codex rollout whose session_meta never named
// a cwd) is excluded under an active filter — we can't prove it's an added
// project, and the whole point of `projects` is "only what's ADDED" — but
// never excluded when there's no filter, so it still can't get silently
// lost from the unfiltered totals.
function collectTurns(claudeRoot, codexRoot, allowedSlugs) {
  const out = [];
  for (const [filePath, entry] of fileCache) {
    if (!(isUnder(filePath, claudeRoot) || isUnder(filePath, codexRoot))) continue;
    for (const t of entry.turns) {
      if (allowedSlugs && (!t.slug || !allowedSlugs.has(String(t.slug).toLowerCase()))) continue;
      out.push(t);
    }
  }
  return out;
}

/* ================= global dedupe (landmine 2) ================= */

// Deduped GLOBALLY across the entire corpus — independent of the requested
// date range — so the outcome never depends on from/to. Two concerns, kept
// separate on purpose (landmine 2):
//
//   ATTRIBUTION (who owns the turn): the pinned winner, earliest ts,
//   tie-broken by lexicographically smallest sessionId — UNCHANGED from
//   before this fix. Walk order is not guaranteed stable, so without a
//   pinned tie-break the *session table* would silently reattribute a
//   forked turn's cost between two identical requests, even though day/model
//   totals stayed correct — which is exactly what makes that bug easy to
//   miss. See self-checks (b1)/(b2), which construct the walk order and the
//   tie-break winner to disagree so only the real rule passes.
//
//   CLAUDE ACCURACY (which usage snapshot is correct): the MAX per field across
//   EVERY record sharing the id, regardless of which one won attribution.
//   Claude Code persists a progressive snapshot as a turn streams (measured:
//   10.4% of ids carry differing usage across their records) — picking the
//   pinned winner's OWN usage fields would book whichever snapshot happened
//   to be earliest, undercounting by a measured 10.2% on output. See
//   self-check (k), which fails hard if this reverts to earliest-wins.
//   CODEX ACCURACY: the earliest copy supplies the whole delta, since a
//   partial fork's first cumulative snapshot can include earlier requests.
function dedupeGlobal(turns) {
  const byId = new Map();
  for (const t of turns) {
    const entry = byId.get(t.id);
    if (!entry) {
      byId.set(t.id, {
        winner: t,
        fresh: t.fresh || 0,
        cacheRead: t.cacheRead || 0,
        cacheCreate: t.cacheCreate || 0,
        cc1h: t.cc1h || 0,
        cc5m: t.cc5m || 0,
        output: t.output || 0,
      });
      continue;
    }
    // A Codex fork may start part-way through the copied cumulative history,
    // making its first delta larger than the original request. Preserve the
    // earliest record's complete delta instead of applying Claude's maxima
    // rule, which is only for progressive snapshots of one API response.
    if (t.engine === 'codex') {
      if (t.ts < entry.winner.ts || (t.ts === entry.winner.ts && t.sessionId < entry.winner.sessionId)) {
        entry.winner = t;
        for (const field of ['fresh', 'cacheRead', 'cacheCreate', 'cc1h', 'cc5m', 'output']) entry[field] = t[field] || 0;
      }
      continue;
    }
    // Attribution: pinned winner rule, untouched by this fix.
    if (t.ts < entry.winner.ts || (t.ts === entry.winner.ts && t.sessionId < entry.winner.sessionId)) {
      entry.winner = t;
    }
    // Accuracy: max per field across every record, independent of attribution.
    if ((t.fresh || 0) > entry.fresh) entry.fresh = t.fresh;
    if ((t.cacheRead || 0) > entry.cacheRead) entry.cacheRead = t.cacheRead;
    if ((t.cacheCreate || 0) > entry.cacheCreate) entry.cacheCreate = t.cacheCreate;
    if ((t.cc1h || 0) > entry.cc1h) entry.cc1h = t.cc1h;
    if ((t.cc5m || 0) > entry.cc5m) entry.cc5m = t.cc5m;
    if ((t.output || 0) > entry.output) entry.output = t.output;
  }
  const out = [];
  for (const entry of byId.values()) {
    out.push({
      ...entry.winner,
      fresh: entry.fresh,
      cacheRead: entry.cacheRead,
      cacheCreate: entry.cacheCreate,
      cc1h: entry.cc1h,
      cc5m: entry.cc5m,
      output: entry.output,
    });
  }
  return out;
}

/* ================= aggregation ================= */

// One token bucket shape, reused for rows, sessions' byModel entries, and
// the session-level aggregate. `extra` carries the bucket's own identity
// fields (day/engine/model, or just model, or nothing).
function emptyBucket(extra) {
  return { turns: 0, fresh: 0, cacheRead: 0, cacheCreate: 0, cc1h: 0, cc5m: 0, output: 0, ...extra };
}

// Adds one turn's token fields into a running bucket. Also accepts another
// BUCKET as `src` (e.g. summing a session's byModel entries into the
// session's own aggregate) — a bucket already carries its own `turns` count,
// a raw turn does not, so a raw turn adds 1. One helper instead of the same
// six-field accumulate block hand-written three times over (FIX 7): called
// once per turn while building rows, once per turn while building each
// session's byModel bucket, and once per model while deriving the session
// aggregate from byModel below.
function addBucket(dst, src) {
  dst.turns += typeof src.turns === 'number' ? src.turns : 1;
  dst.fresh += src.fresh || 0;
  dst.cacheRead += src.cacheRead || 0;
  dst.cacheCreate += src.cacheCreate || 0;
  dst.cc1h += src.cc1h || 0;
  dst.cc5m += src.cc5m || 0;
  dst.output += src.output || 0;
}

function buildRows(turns) {
  const map = new Map();
  for (const t of turns) {
    const key = JSON.stringify([t.day, t.engine, t.model]);
    let row = map.get(key);
    if (!row) {
      row = emptyBucket({ day: t.day, engine: t.engine, model: t.model });
      map.set(key, row);
    }
    addBucket(row, t);
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

// byModelMap is an internal Map(model -> bucket), converted to the public
// `byModel[]` array (and `models[]`, derived from it) at the end of
// buildSessions. Insertion order == first-seen-in-turns order, same as the
// old `models[]` push-if-absent, so `models` stays byte-for-byte compatible
// with every existing reader (public/js/usage.js's baseModelId/title/
// priceSession[0] lookups).
function buildSessions(turns) {
  const map = new Map();
  for (const t of turns) {
    let s = map.get(t.sessionId);
    if (!s) {
      s = {
        sessionId: t.sessionId, engine: t.engine, project: null, slug: null,
        firstTs: t.ts, lastTs: t.ts,
        byModelMap: new Map(),
      };
      map.set(t.sessionId, s);
    }
    if (!s.project && t.project) s.project = t.project;
    // Sidebar-parity slug (landmine 5) — a whole session always resolves to
    // ONE slug (one Claude directory, or one Codex cwd), so first-seen is
    // sufficient; exposed for the frontend (rows[] don't need it — they're
    // already aggregated per day/engine/model, a coarser grain than project).
    if (!s.slug && t.slug) s.slug = t.slug;

    let mb = s.byModelMap.get(t.model);
    if (!mb) {
      mb = emptyBucket({ model: t.model });
      s.byModelMap.set(t.model, mb);
    }
    addBucket(mb, t);

    if (t.ts < s.firstTs) s.firstTs = t.ts;
    if (t.ts > s.lastTs) s.lastTs = t.ts;
  }
  const out = [...map.values()];
  for (const s of out) {
    s.firstTs = new Date(s.firstTs).toISOString();
    s.lastTs = new Date(s.lastTs).toISOString();
    s.byModel = [...s.byModelMap.values()];
    s.models = s.byModel.map((m) => m.model); // back-compat: same order/values as the old push-if-absent list
    delete s.byModelMap;

    // Session aggregate = sum of byModel, derived ONCE here (FIX 7) instead
    // of accumulated turn-by-turn in parallel with byModel above — two
    // tallies of the same numbers that could silently drift apart. This makes
    // self-check (j)'s reconciliation true by construction, not just by
    // careful hand-copying of the same six fields three times over.
    const agg = emptyBucket({});
    for (const mb of s.byModel) addBucket(agg, mb);
    Object.assign(s, agg);
  }
  // Recent activity first. Real cost-based sort is a client concern (pricing
  // is client-side, per the plan — this module returns tokens only).
  out.sort((a, b) => (a.lastTs < b.lastTs ? 1 : a.lastTs > b.lastTs ? -1 : 0));
  return out;
}

/* ================= public API ================= */

// -> { rows, sessions, meta }. claudeRoot/codexRoot are injectable (default
// ~/.claude/projects and $CODEX_HOME|~/.codex/sessions) so the self-check
// below can exercise the walk, the subagents/ recursion, and the .zst path
// end-to-end against a temp-dir fixture instead of whatever ~/.claude happens
// to exist on the machine running it (fails on CI otherwise).
//
// projects (landmine 5): array of LOWERCASED slugs — the sidebar-parity
// allowlist ("only projects the user has ADDED"). null/undefined/absent =>
// NO FILTER, today's behavior, unchanged (every self-check above this one in
// the file omits `projects` entirely and must keep passing as-is). An
// EXPLICIT EMPTY ARRAY is NOT the same as "no filter" — it means "zero added
// projects", so it correctly filters everything out (the real, verified
// state of the dev box this feature shipped on). Callers (server.js,
// master.js, agent/capabilities.js) derive this from the SAME ':'-keyed
// override store the sidebar/projects.js gates on, so the two views can never
// silently disagree about what's "added".
async function getUsage(opts = {}) {
  const {
    from, to, tzOffset = 0,
    claudeRoot = DEFAULT_CLAUDE_ROOT,
    codexRoot = DEFAULT_CODEX_ROOT,
    projects = null,
  } = opts || {};

  assertValidDayString(from, 'from');
  assertValidDayString(to, 'to');
  assertValidTzOffset(tzOffset);

  // Re-lowercase defensively rather than trusting the caller — a caller bug
  // upstream of this file would otherwise silently show/hide the wrong
  // projects, and this is the one gate every caller (hub, cloud master, agent
  // capability, self-check) funnels through.
  const allowedSlugs = Array.isArray(projects) ? new Set(projects.map((p) => String(p).toLowerCase())) : null;

  const t0 = Date.now();
  const { scannedFiles, cachedFiles, skippedTurns, unreadableFiles } = await scanAll(claudeRoot, codexRoot, allowedSlugs);

  const withDay = dedupeGlobal(collectTurns(claudeRoot, codexRoot, allowedSlugs)).map((t) => ({ ...t, day: dayKey(t.ts, tzOffset) }));
  const inRange = withDay.filter((t) => t.day >= from && t.day <= to);

  return {
    rows: buildRows(inRange),
    sessions: buildSessions(inRange),
    meta: {
      scannedFiles, cachedFiles, from, to, tzOffset,
      scanMs: Date.now() - t0,
      // skipped: turns dropped for an unparseable timestamp (see
      // scanClaudeText/scanCodexText) — visible rather than silently
      // absorbed into "today".
      skipped: skippedTurns,
      // unreadable: files that stat'd fine but failed to read/decompress
      // (FIX 4 — most commonly a .jsonl.zst rollout on a pre-22.15 Node),
      // visible rather than silently substituting an empty file.
      unreadable: unreadableFiles,
    },
  };
}

// Pure, exported, self-checked. perHost = [{ host, data: {rows,sessions} }, ...] — data is
// exactly what getUsage() returns for that host. Stamps every row/session
// with its host and otherwise just concatenates: rows key on
// (host, day, engine, model), NEVER on the bare (day, engine, model) triple,
// because two hosts legitimately have distinct sessions sharing a day+model —
// summing them together would misattribute spend across machines. See
// self-check (h).
function mergeUsage(perHost) {
  const rows = [];
  const sessions = [];
  const hosts = [];
  for (const entry of Array.isArray(perHost) ? perHost : []) {
    if (!entry || !entry.data) continue;
    const host = entry.host;
    if (!hosts.includes(host)) hosts.push(host);
    for (const r of Array.isArray(entry.data.rows) ? entry.data.rows : []) rows.push({ ...r, host });
    for (const s of Array.isArray(entry.data.sessions) ? entry.data.sessions : []) sessions.push({ ...s, host });
  }
  return { rows, sessions, hosts };
}

module.exports = { getUsage, mergeUsage };

/* ================= self-check: node lib/usage.js ================= */

if (require.main === module) {
  const assert = require('assert');
  const os2 = require('os');

  function mkClaudeFixture() {
    return fs.mkdtempSync(path.join(os2.tmpdir(), 'usage-claude-'));
  }
  function writeFile(p, lines) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  }
  function claudeAssistantLine({ sessionId, id, ts, model = 'claude-opus-4-8', input = 0, cacheRead = 0, cacheCreate = 0, cc1h = 0, cc5m = 0, output = 0, cwd = '/repo', isSidechain = false }) {
    const usage = { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, output_tokens: output };
    // Only attach the nested breakdown when a fixture actually asks for it —
    // omitting it entirely (cc1h/cc5m both 0) matches most real records and
    // exercises the `cc: null` branch in scanClaudeText too.
    if (cc1h || cc5m) usage.cache_creation = { ephemeral_1h_input_tokens: cc1h, ephemeral_5m_input_tokens: cc5m };
    return {
      type: 'assistant', isSidechain, sessionId, cwd, timestamp: ts,
      message: { id, model, usage },
    };
  }

  (function selfCheck() {
    // ---- (a) block-dedupe, (b) cross-file fork-dedupe, (e) subagent
    // inclusion, (f) torn last line, + trash exclusion — one combined fixture.
    // NOTE: S1 vs S2 below happens to win on BOTH first-seen-in-walk AND the
    // pinned-winner rule at once (S1 is walked first AND has the smaller
    // sessionId at an equal ts), so this fixture alone can't prove the
    // pinned-winner tie-break itself is implemented — a first-seen-wins bug
    // would pass it too. See (b1)/(b2) below, which construct the walk order
    // and the tie-break winner to DISAGREE, so only the real rule passes.
    (async () => {
      const root = mkClaudeFixture();
      const day = '2026-07-10';
      const ts = `${day}T10:00:00.000Z`;

      // S1 (winner: sessionId sorts smallest): message M1 split into 3 blocks
      // (same id, same usage, repeated per block — real disk behavior).
      const s1 = 'aaaaaaaa-0000-0000-0000-000000000001';
      const m1 = 'msg_M1';
      writeFile(path.join(root, 'slugA', `${s1}.jsonl`), [
        claudeAssistantLine({ sessionId: s1, id: m1, ts, input: 100, output: 111 }),
        claudeAssistantLine({ sessionId: s1, id: m1, ts, input: 100, output: 111 }),
        claudeAssistantLine({ sessionId: s1, id: m1, ts, input: 100, output: 111 }),
      ]);
      // S1's subagent transcript: 100% isSidechain, must still count (landmine 1).
      writeFile(path.join(root, 'slugA', s1, 'subagents', 'agent-1.jsonl'), [
        claudeAssistantLine({ sessionId: s1, id: 'msg_M2', ts: `${day}T10:05:00.000Z`, input: 50, output: 222, isSidechain: true }),
      ]);

      // S2 (loser: sortsAfter s1): a forked copy of M1 at the SAME timestamp —
      // must NOT double-count, and S2 must not appear in sessions[] at all.
      const s2 = 'bbbbbbbb-0000-0000-0000-000000000002';
      writeFile(path.join(root, 'slugA', `${s2}.jsonl`), [
        claudeAssistantLine({ sessionId: s2, id: m1, ts, input: 100, output: 111 }),
      ]);

      // S3: two real turns plus a torn final line (no trailing valid JSON).
      const s3 = 'cccccccc-0000-0000-0000-000000000003';
      const s3Path = path.join(root, 'slugB', `${s3}.jsonl`);
      fs.mkdirSync(path.dirname(s3Path), { recursive: true });
      fs.writeFileSync(
        s3Path,
        [
          JSON.stringify(claudeAssistantLine({ sessionId: s3, id: 'msg_M4', ts: `${day}T09:00:00.000Z`, output: 10 })),
          JSON.stringify(claudeAssistantLine({ sessionId: s3, id: 'msg_M5', ts: `${day}T09:01:00.000Z`, output: 20 })),
          '{"type":"assistant","message":{"id":"msg_M6","model":"claude-opus-4-8"', // torn
        ].join('\n'),
      );

      // Trashed session with absurd token counts — must be fully excluded.
      writeFile(path.join(root, '.termdeck-trash', 'trashed.jsonl'), [
        claudeAssistantLine({ sessionId: 'dddddddd-0000-0000-0000-000000000004', id: 'msg_TRASH', ts, output: 999999 }),
      ]);

      const nowhere = path.join(root, 'no-codex-here');
      const res = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: root, codexRoot: nowhere });

      const row = res.rows.find((r) => r.day === day && r.engine === 'claude' && r.model === 'claude-opus-4-8');
      assert.ok(row, 'expected a row for the fixture day/model');
      // (a) 3 blocks of M1 count once; (e) subagent M2 included; S3's M4+M5 counted;
      // fork S2's M1 duplicate does NOT add a second turn.
      assert.strictEqual(row.turns, 4, 'M1(1) + M2 subagent(1) + M4 + M5 = 4 turns, forks/blocks/trash excluded');
      assert.strictEqual(row.output, 111 + 222 + 10 + 20, '(a)+(e)+(f): exact totals, trash (999999) excluded');

      const sess1 = res.sessions.find((s) => s.sessionId === s1);
      assert.ok(sess1, 'S1 must be present');
      assert.strictEqual(sess1.turns, 2, 'S1 = main M1 + subagent M2');
      assert.strictEqual(sess1.output, 111 + 222, '(e) regression guard: subagent tokens included in S1 total');
      // (b) fork loser: S2 contributed nothing (its only line lost the tie-break —
      // see (b1)/(b2) for a fixture that actually discriminates the rule that decided this).
      assert.strictEqual(res.sessions.find((s) => s.sessionId === s2), undefined, '(b) fork loser must not appear in sessions[]');

      const sess3 = res.sessions.find((s) => s.sessionId === s3);
      assert.ok(sess3, 'S3 must be present');
      assert.strictEqual(sess3.turns, 2, '(f) torn final line skipped, valid lines still counted');
      assert.strictEqual(sess3.output, 30);

      fs.rmSync(root, { recursive: true, force: true });
    })()
      // (b1)/(b2) pinned-winner tie-break, exercised directly against
      // dedupeGlobal() rather than through a disk fixture: the real walk
      // order comes from fsp.readdir(root, {recursive:true}) (async), which
      // was measured to NOT match its own readdirSync's alphabetical order
      // (a slug0-before-slug1 fixture came back slug1-first under the async
      // call, on this exact box) — "walk order is not guaranteed stable" per
      // landmine 2's header is true even within a single run, so any
      // directory-naming trick to control "who's seen first" would make this
      // self-check flaky instead of a reliable regression guard. Calling
      // dedupeGlobal with an explicit turns array sidesteps that: array order
      // IS the walk order as far as the function under test is concerned,
      // deterministically, on every machine.
      //
      // (b1) ts half: two turns share an id at DIFFERENT timestamps AND
      // different usage (as real progressive snapshots do). The later-ts
      // turn is placed FIRST in the array (i.e. "seen first by the walk")
      // and must still LOSE ATTRIBUTION; a first-seen-wins bug would pick
      // it. Usage (output) is now a SEPARATE concern (FIX 1): it's the max
      // across every record sharing the id, independent of which record won
      // attribution — so it comes out 999 (the max), not 7 (whichever
      // record happened to win attribution) and not a first-seen value either.
      .then(() => {
        const id = 'msg_TSTIE';
        const seenFirstLaterTs = { id, ts: Date.parse('2026-07-13T12:00:00.000Z'), sessionId: 'sess-later', output: 999 };
        const seenSecondEarlierTs = { id, ts: Date.parse('2026-07-13T09:00:00.000Z'), sessionId: 'sess-earlier', output: 7 };
        const result = dedupeGlobal([seenFirstLaterTs, seenSecondEarlierTs]);
        assert.strictEqual(result.length, 1, '(b1) exactly one turn survives the shared id');
        assert.strictEqual(result[0].sessionId, 'sess-earlier', '(b1) ATTRIBUTION: earlier-ts turn must win even though it is seen second');
        assert.strictEqual(result[0].output, 999, '(b1) ACCURACY (FIX 1): usage is the max across every record, decoupled from which one won attribution');
      })
      // (b2) sessionId half: two turns share an id at the IDENTICAL ts. The
      // lexicographically LARGER sessionId is placed FIRST in the array and
      // must still LOSE ATTRIBUTION; a first-seen-wins bug would pick it.
      // Usage (output) is again the max across both records (FIX 1) — 999,
      // not 8 and not whichever record's own value happened to win.
      .then(() => {
        const id = 'msg_IDTIE';
        const ts = Date.parse('2026-07-13T11:00:00.000Z');
        const seenFirstLargerId = { id, ts, sessionId: 'zzzzzzzz-larger', output: 999 };
        const seenSecondSmallerId = { id, ts, sessionId: 'aaaaaaaa-smaller', output: 8 };
        const result = dedupeGlobal([seenFirstLargerId, seenSecondSmallerId]);
        assert.strictEqual(result.length, 1, '(b2) exactly one turn survives the shared id');
        assert.strictEqual(result[0].sessionId, 'aaaaaaaa-smaller', '(b2) ATTRIBUTION: smaller-sessionId turn must win even though it is seen second, at an identical ts');
        assert.strictEqual(result[0].output, 999, '(b2) ACCURACY (FIX 1): usage is the max across both records, decoupled from which one won attribution');
      })
      // (k) FIX 1: progressive usage snapshots. Claude Code persists a
      // partial usage snapshot on early lines of a streaming turn and
      // updates it as the turn completes — measured: 10.4% of message ids
      // (4,094 of 39,280) carry DIFFERING usage across their repeated
      // records. Booking the earliest record (the pre-fix behavior) captures
      // the partial snapshot -> a measured 10.20% output undercount on the
      // real corpus. This fixture goes output 1 -> 500 -> 2435 across three
      // records of the SAME message.id, and must book 2435 (the max) — never
      // 1 (earliest-wins, the regression this guards) and never 2936 (a naive
      // sum, which would be wrong too: these are snapshots, not increments).
      .then(async () => {
        const root = mkClaudeFixture();
        const day = '2026-07-16';
        const sid = 'ffffffff-1111-1111-1111-000000000007';
        const id = 'msg_012AJjkhnMdrCkfjvBP8xaCj'; // real id from the measured corpus
        writeFile(path.join(root, 'slugF', `${sid}.jsonl`), [
          claudeAssistantLine({ sessionId: sid, id, ts: `${day}T10:00:00.000Z`, output: 1 }),
          claudeAssistantLine({ sessionId: sid, id, ts: `${day}T10:00:01.000Z`, output: 500 }),
          claudeAssistantLine({ sessionId: sid, id, ts: `${day}T10:00:02.000Z`, output: 2435 }),
        ]);
        const nowhere = path.join(root, 'no-codex-here');
        const res = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: root, codexRoot: nowhere });
        const sess = res.sessions.find((s) => s.sessionId === sid);
        assert.ok(sess, '(k) progressive-snapshot session must be present');
        assert.strictEqual(sess.turns, 1, '(k) still exactly one deduped turn per message.id');
        assert.strictEqual(sess.output, 2435, '(k) books the MAX snapshot (2435) — not earliest-wins (1), not summed (2936)');
      })
      // (l) FIX 3: cache_creation_input_tokens IS THE AGGREGATE of
      // cache_creation.ephemeral_{1h,5m}_input_tokens — a breakdown of the
      // SAME tokens, not a fourth independent bucket. The existing fixtures
      // above never set cc1h/cc5m nonzero, which is exactly why a caller
      // summing cacheCreate+cc1h+cc5m slipped through undetected. Asserting
      // all three exactly (not just their sum) means a mutation that swaps
      // the 1h/5m field names, or drops the nested extraction entirely
      // (defaulting both to 0), fails this.
      .then(async () => {
        const root = mkClaudeFixture();
        const day = '2026-07-17';
        const sid = 'aaaaaaaa-2222-2222-2222-000000000008';
        writeFile(path.join(root, 'slugG', `${sid}.jsonl`), [
          claudeAssistantLine({ sessionId: sid, id: 'msg_CC1', ts: `${day}T10:00:00.000Z`, cacheCreate: 9432, cc1h: 5996, cc5m: 3436, output: 12 }),
        ]);
        const nowhere = path.join(root, 'no-codex-here');
        const res = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: root, codexRoot: nowhere });
        const sess = res.sessions.find((s) => s.sessionId === sid);
        assert.ok(sess, '(l) FIX3 fixture session must be present');
        assert.strictEqual(sess.cacheCreate, 9432, '(l) cacheCreate is the aggregate, extracted exactly');
        assert.strictEqual(sess.cc1h, 5996, '(l) cc1h extracted exactly, not swapped with cc5m');
        assert.strictEqual(sess.cc5m, 3436, '(l) cc5m extracted exactly, not swapped with cc1h');
        const row = res.rows.find((r) => r.day === day && r.model === 'claude-opus-4-8');
        assert.ok(row, '(l) row for the fixture day/model must exist');
        assert.strictEqual(row.cacheCreate, 9432, '(l) row aggregate matches, no cross-field summing');
      })
      // (d) local-day bucketing across a UTC midnight with a non-zero tzOffset.
      .then(async () => {
        const root = mkClaudeFixture();
        const sid = 'eeeeeeee-0000-0000-0000-000000000005';
        // 20:00Z on 07-14 -> 07-15 local for IST (tzOffset -330), per the plan's worked example.
        writeFile(path.join(root, 'slugC', `${sid}.jsonl`), [
          claudeAssistantLine({ sessionId: sid, id: 'msg_TZ', ts: '2026-07-14T20:00:00.000Z', output: 42 }),
        ]);
        const nowhere = path.join(root, 'no-codex-here');
        const ist = await getUsage({ from: '2026-07-15', to: '2026-07-15', tzOffset: -330, claudeRoot: root, codexRoot: nowhere });
        assert.strictEqual(ist.rows.reduce((n, r) => n + r.turns, 0), 1, '(d) IST buckets the 20:00Z turn onto 07-15');
        const utc = await getUsage({ from: '2026-07-15', to: '2026-07-15', tzOffset: 0, claudeRoot: root, codexRoot: nowhere });
        assert.strictEqual(utc.rows.reduce((n, r) => n + r.turns, 0), 0, '(d) UTC buckets the same turn onto 07-14 instead');
        fs.rmSync(root, { recursive: true, force: true });
      })
      // (c-direct) FIX 2: fieldDelta unit tests, direct against the function
      // (mirrors how (b1)/(b2) test dedupeGlobal directly rather than through
      // a disk fixture). Uses the EXACT measured stale-then-recover sequence
      // for input_tokens from the real corpus: 146361 -> 125072 -> 168311.
      // Only 6 decrease events exist in the whole corpus; 5 of them are this
      // shape (a stale/out-of-order event that alternates with rising
      // values), and only 1 is a genuine reset (drops to EXACTLY zero).
      .then(() => {
        let prev = 0;
        let r = fieldDelta(146361, prev); prev = r.next;
        assert.strictEqual(r.delta, 146361, '(c) baseline growth from 0 books in full');
        r = fieldDelta(125072, prev); prev = r.next;
        assert.strictEqual(r.delta, 0, '(c) stale/out-of-order decrease books zero, not the raw value');
        assert.strictEqual(prev, 146361, '(c) high-water mark is HELD, not knocked down to the stale value');
        r = fieldDelta(168311, prev); prev = r.next;
        assert.strictEqual(r.delta, 21950, '(c) recovery books only true growth past the held mark (168311-146361), NOT 43239 (168311-125072)');
        assert.strictEqual(prev, 168311);

        // Genuine reset: a field that actually drops to exactly zero.
        r = fieldDelta(0, prev); prev = r.next;
        assert.strictEqual(r.delta, 0, '(c) a genuine reset event itself books zero (nothing new to attribute)');
        assert.strictEqual(prev, 0, '(c) the mark resets to 0 so subsequent growth books correctly');
        r = fieldDelta(500, prev); prev = r.next;
        assert.strictEqual(r.delta, 500, '(c) growth after a genuine reset books from the reset mark, not the pre-reset high-water value');
      })
      // (c) Codex per-field delta reconstruction end-to-end through
      // scanCodexText/getUsage: baseline growth, a stale/out-of-order drop
      // that must be ignored WITHOUT corrupting the next delta, a genuine
      // zero-reset, correct post-reset growth, and the deltaCached>deltaInput
      // clamp (the older cache-shrinks-while-input-grows ~6x scalar-bug
      // guard). Deliberately keeps input/cached/output moving independently
      // so each landmine is attributable to one field at a time.
      .then(async () => {
        const root = mkClaudeFixture();
        const day = '2026-07-11';
        const uuid = '11111111-1111-1111-1111-111111111111';
        const rolloutPath = path.join(root, '2026', '07', '11', `rollout-2026-07-11T10-00-00-${uuid}.jsonl`);
        const tc = (total, ts) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total } } });
        const lines = [
          { timestamp: `${day}T10:00:00.000Z`, type: 'session_meta', payload: { cwd: '/repo' } },
          { timestamp: `${day}T10:00:01.000Z`, type: 'turn_context', payload: { model: 'gpt-5.5' } },
          tc({ input_tokens: 146361, cached_input_tokens: 500, output_tokens: 50 }, `${day}T10:00:02.000Z`), // E1 baseline
          tc({ input_tokens: 125072, cached_input_tokens: 500, output_tokens: 50 }, `${day}T10:00:03.000Z`), // E2 stale/out-of-order on input only -> ignored entirely
          tc({ input_tokens: 168311, cached_input_tokens: 500, output_tokens: 50 }, `${day}T10:00:04.000Z`), // E3 recovery: +21950, NOT +43239
          tc({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, `${day}T10:00:05.000Z`), // E4 genuine reset on all three fields
          tc({ input_tokens: 300, cached_input_tokens: 0, output_tokens: 20 }, `${day}T10:00:06.000Z`), // E5 growth after reset
          // E6: deltaCached(200) > deltaInput(10) in one event — a shape the
          // API doesn't promise can't happen. fieldDelta's own clamp only
          // floors each field at >=0 individually; it does NOT stop
          // deltaInput-deltaCached going negative in scanCodexText's `fresh`
          // line, so THAT subtraction needs its own Math.max(0, ...) clamp.
          // Drop it and this turn's fresh silently goes to -190.
          tc({ input_tokens: 310, cached_input_tokens: 200, output_tokens: 25 }, `${day}T10:00:07.000Z`),
          tc({ input_tokens: 310, cached_input_tokens: 200, output_tokens: 25 }, `${day}T10:00:08.000Z`), // E7 verbatim duplicate of E6 -> contributes nothing
        ];
        writeFile(rolloutPath, lines);

        const nowhere = path.join(root, 'no-claude-here');
        const res = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: nowhere, codexRoot: root });
        const sess = res.sessions.find((s) => s.sessionId === uuid);
        assert.ok(sess, 'codex session must be present');
        // E1 + E3 + E5 + E6 produce turns; E2 (stale), E4 (reset-to-zero, all
        // fields land exactly on 0 so nothing to attribute), and E7
        // (verbatim duplicate) all produce none. A revert to the old
        // "reset=cur" per-field semantics would additionally book E2 as a
        // spurious turn (fresh=125072) and inflate E3's delta to 43239 —
        // turns would be 5, not 4.
        assert.strictEqual(sess.turns, 4, '(c) baseline + recovery + post-reset growth + clamp-case; stale/reset/duplicate events contribute nothing');
        // E1 fresh=146361-500=145861. E3 fresh=21950 (not 43239). E5 fresh=300.
        // E6 fresh=max(0,10-200)=0 (clamped; unclamped would be -190, making
        // this total 167921 instead of 168111).
        assert.strictEqual(sess.fresh, 145861 + 21950 + 300 + 0, '(c) high-water-mark deltas + the deltaCached>deltaInput clamp, exact');
        assert.ok(sess.fresh >= 0, '(c) fresh must never go negative');
        assert.strictEqual(sess.cacheRead, 500 + 0 + 0 + 200, '(c) per-field cacheRead across all recorded events');
        assert.strictEqual(sess.output, 50 + 0 + 20 + 5, '(c) per-field output across all recorded events');
        assert.ok(sess.models.includes('gpt-5.5'), 'model attributed from turn_context');
        fs.rmSync(root, { recursive: true, force: true });
      })
      // (i) unparseable timestamp: dropped rather than silently booked into
      // "today" (which would inflate today's cost with old spend and make
      // output non-deterministic) — counted in meta.skipped instead. Covers
      // both engines, since scanClaudeText and scanCodexText each have their
      // own ts guard.
      .then(async () => {
        const root = mkClaudeFixture();
        const claudeRoot = path.join(root, 'claude');
        const codexRoot = path.join(root, 'codex');
        const day = '2026-07-12';
        const sid = 'ffffffff-0000-0000-0000-000000000006';
        writeFile(path.join(claudeRoot, 'slugD', `${sid}.jsonl`), [
          claudeAssistantLine({ sessionId: sid, id: 'msg_BADTS', ts: 'not-a-timestamp', output: 777 }),
          claudeAssistantLine({ sessionId: sid, id: 'msg_GOODTS', ts: `${day}T09:00:00.000Z`, output: 5 }),
        ]);

        const codexUuid = '22222222-2222-2222-2222-222222222222';
        const rolloutPath = path.join(codexRoot, '2026', '07', '12', `rollout-2026-07-12T09-00-00-${codexUuid}.jsonl`);
        writeFile(rolloutPath, [
          { timestamp: `${day}T09:00:00.000Z`, type: 'turn_context', payload: { model: 'gpt-5.5' } },
          { timestamp: 'also-not-a-timestamp', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 90 } } } },
        ]);

        const res = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot, codexRoot });
        assert.strictEqual(res.meta.skipped, 2, '(i) one bad-ts turn per engine counted in meta.skipped');
        const claudeSess = res.sessions.find((s) => s.sessionId === sid);
        assert.ok(claudeSess, 'claude session with the valid turn must still be present');
        assert.strictEqual(claudeSess.turns, 1, '(i) the bad-ts claude turn (777 output) never counted');
        assert.strictEqual(claudeSess.output, 5, '(i) only the good-ts turn contributes');
        assert.strictEqual(res.sessions.find((s) => s.sessionId === codexUuid), undefined, '(i) codex session with only a bad-ts turn contributes nothing, not booked under today');
        fs.rmSync(root, { recursive: true, force: true });
      })
      // (j) multi-model session: byModel[] splits per model AND sums back
      // exactly to the session's own aggregate buckets — this is the fixture
      // that lets public/js/usage.js price a mixed-model session (e.g. an
      // opus+sonnet chat) per-model instead of at the highest matching rate.
      // models[] must also stay byte-compatible (first-seen order, same ids).
      .then(async () => {
        const root = mkClaudeFixture();
        const sid = 'aaaaaaaa-1111-1111-1111-000000000009';
        const day = '2026-07-13';
        writeFile(path.join(root, 'slugE', `${sid}.jsonl`), [
          claudeAssistantLine({ sessionId: sid, id: 'msg_MM1', ts: `${day}T10:00:00.000Z`, model: 'claude-opus-4-8', input: 100, cacheRead: 50, output: 40 }),
          claudeAssistantLine({ sessionId: sid, id: 'msg_MM2', ts: `${day}T10:05:00.000Z`, model: 'claude-sonnet-5', input: 30, cacheRead: 10, output: 15 }),
          claudeAssistantLine({ sessionId: sid, id: 'msg_MM3', ts: `${day}T10:10:00.000Z`, model: 'claude-opus-4-8', input: 20, cacheRead: 5, output: 8 }),
        ]);
        const nowhere = path.join(root, 'no-codex-here');
        const res = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: root, codexRoot: nowhere });
        const sess = res.sessions.find((s) => s.sessionId === sid);
        assert.ok(sess, '(j) multi-model session must be present');
        assert.strictEqual(sess.byModel.length, 2, '(j) two distinct models -> two byModel buckets');
        assert.deepStrictEqual(sess.models, ['claude-opus-4-8', 'claude-sonnet-5'], '(j) models[] stays first-seen-order, back-compat shape');

        const opus = sess.byModel.find((m) => m.model === 'claude-opus-4-8');
        const sonnet = sess.byModel.find((m) => m.model === 'claude-sonnet-5');
        assert.ok(opus && sonnet, '(j) both models present as byModel entries');
        assert.strictEqual(opus.turns, 2, '(j) opus has 2 of the 3 turns');
        assert.strictEqual(sonnet.turns, 1, '(j) sonnet has 1 of the 3 turns');
        assert.strictEqual(opus.fresh, 120, '(j) opus fresh = 100 + 20');
        assert.strictEqual(sonnet.fresh, 30, '(j) sonnet fresh = 30');

        // The headline assertion: per-model buckets must sum back to the
        // session's own aggregate fields, for every bucket — a regression
        // here (e.g. a turn attributed to the wrong model, or a dropped
        // bucket) would silently break exact-pricing of the majority of the
        // range's tokens (measured: 31.6% of all tokens live in multi-model
        // sessions) while (a)-(i) above, all single-model fixtures, stay green.
        for (const field of ['turns', 'fresh', 'cacheRead', 'cacheCreate', 'cc1h', 'cc5m', 'output']) {
          const sum = sess.byModel.reduce((n, m) => n + m[field], 0);
          assert.strictEqual(sum, sess[field], `(j) byModel.${field} must sum to session.${field}`);
        }
        fs.rmSync(root, { recursive: true, force: true });
      })
      // (g) missing roots return empty rather than throwing.
      .then(async () => {
        const root = mkClaudeFixture();
        const missingClaude = path.join(root, 'does-not-exist-claude');
        const missingCodex = path.join(root, 'does-not-exist-codex');
        const res = await getUsage({ from: '2026-01-01', to: '2026-12-31', tzOffset: 0, claudeRoot: missingClaude, codexRoot: missingCodex });
        assert.deepStrictEqual(res.rows, []);
        assert.deepStrictEqual(res.sessions, []);
        fs.rmSync(root, { recursive: true, force: true });
      })
      // Boundary validation: bad tzOffset / bad date strings never reach Date math.
      .then(async () => {
        const root = mkClaudeFixture();
        await assert.rejects(() => getUsage({ from: '2026-01-01', to: '2026-01-31', tzOffset: NaN, claudeRoot: root, codexRoot: root }), /tzOffset/);
        await assert.rejects(() => getUsage({ from: 'not-a-date', to: '2026-01-31', tzOffset: 0, claudeRoot: root, codexRoot: root }), /from/);
        fs.rmSync(root, { recursive: true, force: true });
      })
      // (h) mergeUsage never merges two hosts' rows onto a bare (day, engine, model) key.
      .then(() => {
        const rowA = { day: '2026-07-01', engine: 'claude', model: 'claude-opus-4-8', turns: 1, fresh: 10, cacheRead: 0, cacheCreate: 0, cc1h: 0, cc5m: 0, output: 5 };
        const rowB = { day: '2026-07-01', engine: 'claude', model: 'claude-opus-4-8', turns: 1, fresh: 20, cacheRead: 0, cacheCreate: 0, cc1h: 0, cc5m: 0, output: 7 };
        const merged = mergeUsage([
          { host: 'ai', data: { rows: [rowA], sessions: [] } },
          { host: 'pc', data: { rows: [rowB], sessions: [] } },
        ]);
        assert.strictEqual(merged.rows.length, 2, '(h) same (day,engine,model) on two hosts stays two rows, never summed');
        assert.deepStrictEqual(merged.hosts, ['ai', 'pc']);
        const wanted = merged.rows.find((r) => r.host === 'ai');
        assert.strictEqual(wanted.fresh, 10, '(h) host rows keep their own values, not a cross-host sum (would be 30)');
        assert.strictEqual(merged.rows.find((r) => r.host === 'pc').fresh, 20);
      })
      // (m) landmine 5, Claude half: an allowlist excludes a non-added
      // project's turns entirely AND its directory is never even readdir-ed —
      // the "big speedup" (an unadded project's files aren't just excluded
      // from the total, they're never stat'd/parsed at all). The excluded
      // slug's file carries an absurd output value (same style as the trash
      // fixture in (a)) so a totals-only regression would still be caught;
      // the readdir spy separately proves the DIRECTORY skip itself, not just
      // the eventual filter.
      .then(async () => {
        const root = mkClaudeFixture();
        const day = '2026-07-18';
        const allowedSid = 'aaaaaaaa-3333-3333-3333-000000000010';
        const excludedSid = 'bbbbbbbb-3333-3333-3333-000000000011';
        writeFile(path.join(root, 'AllowedSlug', `${allowedSid}.jsonl`), [
          claudeAssistantLine({ sessionId: allowedSid, id: 'msg_ALLOW', ts: `${day}T10:00:00.000Z`, output: 7 }),
        ]);
        writeFile(path.join(root, 'ExcludedSlug', `${excludedSid}.jsonl`), [
          claudeAssistantLine({ sessionId: excludedSid, id: 'msg_EXCLUDE', ts: `${day}T10:00:00.000Z`, output: 999999 }),
        ]);

        const seenReaddirPaths = [];
        const origReaddir = fsp.readdir;
        fsp.readdir = (p, ...rest) => { seenReaddirPaths.push(String(p)); return origReaddir.call(fsp, p, ...rest); };
        let res;
        try {
          const nowhere = path.join(root, 'no-codex-here');
          res = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: root, codexRoot: nowhere, projects: ['allowedslug'] });
        } finally {
          fsp.readdir = origReaddir;
        }

        const row = res.rows.find((r) => r.day === day);
        assert.ok(row, '(m) allowed slug must produce a row');
        assert.strictEqual(row.output, 7, '(m) excluded slug (999999) contributes nothing to the total');
        assert.strictEqual(res.sessions.find((s) => s.sessionId === excludedSid), undefined, '(m) excluded session must not appear at all');
        const sess = res.sessions.find((s) => s.sessionId === allowedSid);
        assert.strictEqual(sess.slug, 'AllowedSlug', '(m) session carries its resolved slug (dirname), for the frontend');

        const excludedDir = path.join(root, 'ExcludedSlug');
        assert.ok(
          !seenReaddirPaths.some((p) => p === excludedDir || p.startsWith(excludedDir + path.sep)),
          '(m) the excluded slug directory must never be readdir-ed — this is the whole point of the directory-level skip'
        );
        fs.rmSync(root, { recursive: true, force: true });
      })
      // (n) landmine 5, Codex half: a rollout is filtered by
      // slugForCwd(session_meta.cwd) — Codex has no directory-per-project
      // layout, so this is the ONLY way to attribute a rollout to a project.
      // The excluded rollout also carries an absurd token count so a
      // regression that stops filtering would blow up the total, not just
      // silently keep it the same.
      .then(async () => {
        const root = mkClaudeFixture();
        const day = '2026-07-19';
        const tc = (total, ts) => ({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total } } });

        const uuidAllowed = '33333333-3333-3333-3333-000000000012';
        const cwdAllowed = '/home/user/allowed-project';
        const slugAllowed = slugForCwd(cwdAllowed);
        writeFile(path.join(root, '2026', '07', '19', `rollout-2026-07-19T10-00-00-${uuidAllowed}.jsonl`), [
          { timestamp: `${day}T10:00:00.000Z`, type: 'session_meta', payload: { cwd: cwdAllowed } },
          { timestamp: `${day}T10:00:01.000Z`, type: 'turn_context', payload: { model: 'gpt-5.5' } },
          tc({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 }, `${day}T10:00:02.000Z`),
        ]);

        const uuidExcluded = '44444444-4444-4444-4444-000000000013';
        const cwdExcluded = '/home/user/excluded-project';
        writeFile(path.join(root, '2026', '07', '19', `rollout-2026-07-19T11-00-00-${uuidExcluded}.jsonl`), [
          { timestamp: `${day}T11:00:00.000Z`, type: 'session_meta', payload: { cwd: cwdExcluded } },
          { timestamp: `${day}T11:00:01.000Z`, type: 'turn_context', payload: { model: 'gpt-5.5' } },
          tc({ input_tokens: 999999, cached_input_tokens: 0, output_tokens: 999999 }, `${day}T11:00:02.000Z`),
        ]);

        const nowhereClaude = path.join(root, 'no-claude-here');
        const res = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: nowhereClaude, codexRoot: root, projects: [slugAllowed.toLowerCase()] });
        assert.ok(res.sessions.find((s) => s.sessionId === uuidAllowed), '(n) allowed codex rollout present');
        assert.strictEqual(res.sessions.find((s) => s.sessionId === uuidExcluded), undefined, '(n) rollout filtered out via slugForCwd(cwd) must not appear');
        const row = res.rows.find((r) => r.day === day);
        assert.ok(row, '(n) row for the fixture day must exist');
        assert.strictEqual(row.output, 10, '(n) excluded rollout (999999 output) must not leak into the total');
        fs.rmSync(root, { recursive: true, force: true });
      })
      // (o) projects: null (or omitted entirely, as every fixture above this
      // one already does) still returns everything — the "no filter" default
      // must survive this feature landing, unchanged.
      .then(async () => {
        const root = mkClaudeFixture();
        const day = '2026-07-20';
        const sidA = '55555555-5555-5555-5555-000000000014';
        const sidB = '66666666-6666-6666-6666-000000000015';
        writeFile(path.join(root, 'ProjA', `${sidA}.jsonl`), [claudeAssistantLine({ sessionId: sidA, id: 'msg_A', ts: `${day}T10:00:00.000Z`, output: 3 })]);
        writeFile(path.join(root, 'ProjB', `${sidB}.jsonl`), [claudeAssistantLine({ sessionId: sidB, id: 'msg_B', ts: `${day}T10:00:00.000Z`, output: 4 })]);
        const nowhere = path.join(root, 'no-codex-here');
        const res = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: root, codexRoot: nowhere }); // projects omitted
        assert.ok(res.sessions.find((s) => s.sessionId === sidA), '(o) no projects filter -> project A still present');
        assert.ok(res.sessions.find((s) => s.sessionId === sidB), '(o) no projects filter -> project B still present');
        fs.rmSync(root, { recursive: true, force: true });
      })
      // (p) a worktree-style directory is NOT folded into its parent via a
      // shared cwd — the exact regression the plan calls out: Claude's slug
      // MUST be the directory name, never slugForCwd(cwd), or a worktree
      // (its own directory, but often a cwd that resolves to the PARENT repo)
      // would silently count as "added" just because the parent is.
      .then(async () => {
        const root = mkClaudeFixture();
        const day = '2026-07-21';
        const parentSlug = '-home-dev-code-acme-app';
        const worktreeSlug = '-home-dev-code-acme-app--claude-worktrees-feature-x';
        const sidParent = '77777777-7777-7777-7777-000000000016';
        const sidWorktree = '88888888-8888-8888-8888-000000000017';
        // The worktree's RECORDED cwd is the parent repo (per CLAUDE.md) —
        // if this file ever used slugForCwd(cwd) for Claude, both sessions
        // would resolve to the same "project" and the worktree would leak in.
        const sharedCwd = '/home/dev/code/acme-app';
        writeFile(path.join(root, parentSlug, `${sidParent}.jsonl`), [
          claudeAssistantLine({ sessionId: sidParent, id: 'msg_PARENT', ts: `${day}T10:00:00.000Z`, output: 11, cwd: sharedCwd }),
        ]);
        writeFile(path.join(root, worktreeSlug, `${sidWorktree}.jsonl`), [
          claudeAssistantLine({ sessionId: sidWorktree, id: 'msg_WT', ts: `${day}T10:00:00.000Z`, output: 22, cwd: sharedCwd }),
        ]);
        const nowhere = path.join(root, 'no-codex-here');
        // Only the PARENT's dirname is "added" — the worktree dir needs its OWN add.
        const res = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: root, codexRoot: nowhere, projects: [parentSlug.toLowerCase()] });
        assert.ok(res.sessions.find((s) => s.sessionId === sidParent), '(p) parent project (added) present');
        assert.strictEqual(res.sessions.find((s) => s.sessionId === sidWorktree), undefined, '(p) worktree dir NOT folded into its parent via shared cwd — it needs its own add');
        fs.rmSync(root, { recursive: true, force: true });
      })
      // (q) FIX 2 regression guard: deleting a session file INSIDE an ALLOWED
      // project between two scans must actually drop its tokens from the next
      // scan's totals. Two sessions (10 + 20 output) live under the SAME
      // added slug; both scans reuse the same module-level fileCache (exactly
      // like two real /api/usage calls against one long-lived process). A
      // pre-fix pruneCache (keyed on "does the slug directory still exist on
      // disk" instead of "is the slug in THIS round's allowlist") sees the
      // slug directory still there (session B survives inside it) and wrongly
      // preserves session A's stale cache entry forever — this fails against
      // that version (30/2 after delete, unchanged) and passes once pruneCache
      // is keyed on the actual allowlist (20/1 after delete).
      .then(async () => {
        const root = mkClaudeFixture();
        const day = '2026-07-22';
        const slug = 'proj-a';
        const sidA = '99999999-0000-0000-0000-000000000018';
        const sidB = '99999999-0000-0000-0000-000000000019';
        const pathA = path.join(root, slug, `${sidA}.jsonl`);
        const pathB = path.join(root, slug, `${sidB}.jsonl`);
        writeFile(pathA, [claudeAssistantLine({ sessionId: sidA, id: 'msg_QA', ts: `${day}T10:00:00.000Z`, output: 10 })]);
        writeFile(pathB, [claudeAssistantLine({ sessionId: sidB, id: 'msg_QB', ts: `${day}T10:00:00.000Z`, output: 20 })]);
        const nowhere = path.join(root, 'no-codex-here');

        const before = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: root, codexRoot: nowhere, projects: [slug] });
        const rowBefore = before.rows.find((r) => r.day === day);
        assert.ok(rowBefore, '(q) before delete: row for the fixture day must exist');
        assert.strictEqual(rowBefore.output, 30, '(q) before delete: both sessions counted (10 + 20)');
        assert.strictEqual(before.sessions.length, 2, '(q) before delete: two sessions');

        fs.unlinkSync(pathA);

        const after = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: root, codexRoot: nowhere, projects: [slug] });
        const rowAfter = after.rows.find((r) => r.day === day);
        assert.strictEqual(after.sessions.length, 1, '(q) after deleting session A, only session B remains');
        assert.strictEqual(rowAfter ? rowAfter.output : 0, 20, '(q) FIX 2: the deleted session\'s tokens (10) must not survive in fileCache forever');
        fs.rmSync(root, { recursive: true, force: true });
      })
      // (r) FIX 3: Dirent.parentPath doesn't exist before Node 20.12/21.4 —
      // those runtimes expose `e.path` instead (deploy/install.sh advertises
      // Node 18+, so this is a real gap, not theoretical). Simulates a
      // pre-parentPath Dirent by stripping `.parentPath` off every entry the
      // real recursive readdir returns and exposing `.path` in its place (the
      // exact shape those older runtimes hand back), proving the `e.path`
      // fallback actually gets exercised rather than just declared. A
      // subagent file (two directories deeper than the slug dir) is the
      // sharpest case: `dirPath` alone reconstructs the WRONG path for it, so
      // a fallback that stops at `e.parentPath || dirPath` silently drops the
      // subagent turn with no error — this fails against that version (only
      // the main turn's 5 tokens counted) and passes once `e.path` is tried
      // first.
      .then(async () => {
        const root = mkClaudeFixture();
        const day = '2026-07-23';
        const sid = 'aaaaaaaa-4444-4444-4444-000000000020';
        writeFile(path.join(root, 'slugH', `${sid}.jsonl`), [
          claudeAssistantLine({ sessionId: sid, id: 'msg_MAIN', ts: `${day}T10:00:00.000Z`, output: 5 }),
        ]);
        writeFile(path.join(root, 'slugH', sid, 'subagents', 'agent-1.jsonl'), [
          claudeAssistantLine({ sessionId: sid, id: 'msg_SUB', ts: `${day}T10:05:00.000Z`, output: 77, isSidechain: true }),
        ]);

        const origReaddir = fsp.readdir;
        fsp.readdir = async (p, opts) => {
          const ents = await origReaddir(p, opts);
          if (!opts || !opts.recursive) return ents; // only the recursive nested-listing call needs the pre-20.12 shape
          return ents.map((e) => ({
            name: e.name,
            isFile: () => e.isFile(),
            isDirectory: () => e.isDirectory(),
            path: e.parentPath, // pre-20.12 field name — no .parentPath on this object at all
          }));
        };
        let res;
        try {
          const nowhere = path.join(root, 'no-codex-here');
          res = await getUsage({ from: day, to: day, tzOffset: 0, claudeRoot: root, codexRoot: nowhere });
        } finally {
          fsp.readdir = origReaddir;
        }
        const sess = res.sessions.find((s) => s.sessionId === sid);
        assert.ok(sess, '(r) session must be present even without Dirent.parentPath');
        assert.strictEqual(sess.turns, 2, '(r) main turn + subagent turn both counted under the e.path fallback');
        assert.strictEqual(sess.output, 5 + 77, '(r) FIX 3: subagent tokens must survive on a pre-parentPath runtime, not be silently dropped');
        fs.rmSync(root, { recursive: true, force: true });
      })
      .then(() => console.log('usage self-check ok'))
      .catch((err) => {
        console.error(err);
        process.exitCode = 1;
      });
  })();
}
