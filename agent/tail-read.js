'use strict';

// Read the TAIL of a transcript, not the whole thing.
//
// Every transcript surface that shows you "the last N messages" — a seed, the
// first window of an open, the window that rides `subscribed` — used to be
// served by parsing the entire jsonl. Measured on the cloud path: a 51 MB chat
// cost 2.8 s to open, because the master pulled all 51 MB across the tunnel and
// JSON.parsed every line of it to display fifteen messages.
//
// So: seek to (size - maxBytes), walk forward to the next line boundary, and
// hand back only what follows. The parser already knows how to start mid-file —
// that is exactly what a `?since` delta is — so the only thing the caller needs
// besides the bytes is WHERE they start, in lines. `startLine` is that, and it
// is what keeps the cursor exact: totalLines = startLine + (the tail parse's own
// totalLines), which is the same number a full parse would have produced. A
// cursor that is off by even one line silently corrupts every later `?since`
// splice, which is why this counts lines rather than estimating them.
//
// What a tail parse CANNOT know is anything derived from the whole file: the
// session's opening cwd, and cumulativeUsage (a running sum). Callers must not
// claim those from a tail — see `partial` in the transcript routes. Everything
// else the scanner reports is last-value-wins (model, effort, permissionMode,
// gitBranch, currentCwd, the last turn's usage), and the last value is in the
// tail by definition.
//
// The counting pass reads the file sequentially without holding it: ~50 ms for
// 51 MB on an SSD, versus the seconds of JSON.parse it replaces. It is local I/O
// on whichever box owns the file — on the cloud path that is the agent's disk,
// and only the tail ever crosses the tunnel.

const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const NL = 0x0a;

// Default tail budget. Big enough that fifteen messages fit even when a single
// agentic turn is enormous, small enough that it is a rounding error next to the
// files this exists for. A window that does not fill is the caller's cue to fall
// back to a full parse (see `whole`).
const TAIL_BYTES = 512 * 1024;

// One escalation, for the chat whose last fifteen messages do not fit in the
// budget: a single tool result can be most of a megabyte, and a preview that
// paints two messages because the other thirteen were big is a worse answer than
// one more read. Bounded, and it is the LAST word — falling all the way back to
// a full parse would hand exactly the biggest chats back their old cost, which
// is the thing this module exists to remove.
const TAIL_BYTES_MAX = 4 * 1024 * 1024;

// Did the tail come up short? Only meaningful for a partial read: a whole file
// with four messages in it has four messages, and no amount of reading changes
// that.
function tailUnderfilled({ messageCount, preview, whole }) {
  return !whole && preview > 0 && messageCount < preview;
}

// Count the newlines in a buffer.
function countNewlines(buf, from = 0, to = buf.length) {
  let n = 0;
  for (let i = buf.indexOf(NL, from); i !== -1 && i < to; i = buf.indexOf(NL, i + 1)) n += 1;
  return n;
}

// Where the tail starts, for bytes already in memory. Returns the index of the
// first byte AFTER the newline at or past `target`, and how many lines precede
// it. -1 means there is no line boundary in the tail — one enormous line, so
// there is nothing to slice and the caller takes the whole thing.
function tailCut(buf, maxBytes) {
  if (buf.length <= maxBytes) return { offset: 0, startLine: 0, whole: true };
  const target = buf.length - maxBytes;
  const nl = buf.indexOf(NL, target);
  if (nl === -1) return { offset: 0, startLine: 0, whole: true };
  return { offset: nl + 1, startLine: countNewlines(buf, 0, nl + 1), whole: false };
}

// In-memory twin of readTail, for a caller that already holds the bytes (the
// master's byte-cursor cache, a test). Same contract, no I/O.
function sliceTail(buf, maxBytes = TAIL_BYTES) {
  const cut = tailCut(buf, maxBytes);
  return { buf: cut.whole ? buf : buf.subarray(cut.offset), startLine: cut.startLine, whole: cut.whole };
}

// ---- line-count checkpoints (features/04 phase 9) ----
//
// Every tail read counts the lines above its cut, and that count used to start
// at byte 0 every time: a 50 MB chat re-read 50 MB of disk per open, per rung of
// the fill ladder, and once more for lineCountTo. A transcript only ever grows,
// so a count taken once stays true for as long as the bytes under it do.
//
// Per file, a few (offset, lines) pairs, each at a line start, each with the
// PROBE bytes just before it. A later count starts from the nearest pair at or
// below where it needs to reach, after re-reading the probe: bytes that moved
// (a rewrite, a truncation, a different file under the same name) fail the
// probe, every pair for the file is dropped, and the count starts at 0 again.
const CHECKPOINTS_PER_FILE = 4;
const CHECKPOINT_FILES = 256;
const PROBE_BYTES = 64;
const checkpoints = new Map(); // path -> [{ offset, lines, probe }], ascending offset

// The probe is the bytes before `offset` AND the file's identity: a file
// replaced by rename (a new inode) is another file even when the bytes near the
// count happen to agree.
async function readProbe(filePath, offset) {
  const len = Math.min(PROBE_BYTES, offset);
  const fd = await fsp.open(filePath, 'r');
  try {
    const st = await fd.stat();
    const buf = Buffer.alloc(Math.max(0, len));
    const { bytesRead } = len > 0 ? await fd.read(buf, 0, len, offset - len) : { bytesRead: 0 };
    return Buffer.concat([Buffer.from(`${st.dev}:${st.ino}:`), buf.subarray(0, bytesRead)]);
  } finally { await fd.close(); }
}

// The nearest trustworthy count at or below `offset` (and, when `maxLines` is
// given, at or below that many lines), or { offset: 0, lines: 0 }.
async function checkpointBelow(filePath, offset, maxLines = Infinity) {
  const list = checkpoints.get(filePath);
  if (!list) return { offset: 0, lines: 0 };
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const cp = list[i];
    if (cp.offset > offset || cp.lines > maxLines) continue;
    let probe;
    try { probe = await readProbe(filePath, cp.offset); } catch { probe = null; }
    if (probe && probe.equals(cp.probe)) return cp;
    checkpoints.delete(filePath); // the bytes under the counts moved: none of them hold
    return { offset: 0, lines: 0 };
  }
  return { offset: 0, lines: 0 };
}

async function noteCheckpoint(filePath, offset, lines) {
  if (!(offset > 0)) return;
  let probe;
  try { probe = await readProbe(filePath, offset); } catch { return; }
  const list = (checkpoints.get(filePath) || []).filter((cp) => cp.offset !== offset);
  list.push({ offset, lines, probe });
  list.sort((a, b) => a.offset - b.offset);
  while (list.length > CHECKPOINTS_PER_FILE) list.shift();
  checkpoints.delete(filePath); // re-insert: most recently used last
  checkpoints.set(filePath, list);
  while (checkpoints.size > CHECKPOINT_FILES) checkpoints.delete(checkpoints.keys().next().value);
}

// Sequential scan that counts newlines and stops caring once it has found the
// cut. Never holds more than one chunk of the file, and starts from the
// nearest checkpoint below the cut rather than from byte 0.
async function scanForCut(filePath, size, maxBytes) {
  const target = size - maxBytes;
  const from = await checkpointBelow(filePath, Math.max(0, target));
  const found = await new Promise((resolve, reject) => {
    let pos = from.offset;
    let lines = from.lines;
    let cutOffset = -1;
    let cutLine = 0;
    // A checkpoint sits exactly at a line start, so a cut AT it is its own line.
    if (from.offset > 0 && from.offset >= target) return resolve({ cutOffset: from.offset, cutLine: from.lines, lines: from.lines });
    const stream = fs.createReadStream(filePath, { start: from.offset });
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      for (let i = chunk.indexOf(NL); i !== -1; i = chunk.indexOf(NL, i + 1)) {
        lines += 1;
        // The first line boundary at or past the target is where the tail
        // begins; keep counting lines to it and then stop looking.
        if (cutOffset === -1 && pos + i >= target) { cutOffset = pos + i + 1; cutLine = lines; }
      }
      pos += chunk.length;
      // Everything after the cut is the tail — no reason to keep reading, the
      // positional read below fetches it in one go.
      if (cutOffset !== -1) stream.destroy();
    });
    stream.on('close', () => resolve({ cutOffset, cutLine, lines }));
    stream.on('end', () => resolve({ cutOffset, cutLine, lines }));
  });
  if (found.cutOffset > 0 && found.cutOffset < size) await noteCheckpoint(filePath, found.cutOffset, found.cutLine);
  return found;
}

// The biggest single record a window read will ship on its own. A jsonl line
// longer than the window used to make readTail and readBefore fall back to
// "everything", which on a 32 MB rollout was 30 MB in one frame (features/04
// phase 5, correction 10). Now a line up to this is the page by itself, and
// a longer one is skipped: the page is empty, the cut sits at the line's
// start, and paging carries on above it. The agent's own hard clamp.
const LINE_MAX = 8 * 1024 * 1024;

// The position of the last newline strictly before `pos`, or -1: a backward
// scan in bounded chunks, so finding where a giant line starts costs that
// line and nothing above it.
async function newlineBefore(fd, pos, chunkBytes = 1024 * 1024) {
  let end = pos;
  while (end > 0) {
    const start = Math.max(0, end - chunkBytes);
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await fd.read(buf, 0, end - start, start);
    const at = buf.lastIndexOf(NL, bytesRead - 1);
    if (at !== -1) return start + at;
    end = start;
  }
  return -1;
}

// How many newlines sit in [0, offset): the jsonl line index of the byte at
// `offset`, counted forwards in one sequential pass that stops there.
async function lineCountTo(filePath, offset) {
  if (!(offset > 0)) return 0;
  const from = await checkpointBelow(filePath, offset);
  if (from.offset === offset) return from.lines;
  const lines = await new Promise((resolve, reject) => {
    let n = from.lines;
    const stream = fs.createReadStream(filePath, { start: from.offset, end: offset - 1 });
    stream.on('error', reject);
    stream.on('data', (chunk) => { n += countNewlines(chunk); });
    stream.on('end', () => resolve(n));
  });
  await noteCheckpoint(filePath, offset, lines);
  return lines;
}

// Some metadata only exists at the TOP of a file. A Codex rollout records its
// model, effort and permission mode in session_meta/turn_context records at the
// head, so a tail read of one knows what was said and nothing about what said
// it — and the composer falls back to defaults.
//
// 128 KB, measured rather than guessed: across the eight largest real rollouts
// on one box the first `turn_context` sat between 34 KB and 84 KB in, because
// the session_meta and the opening instructions ahead of it are themselves tens
// of kilobytes. 64 KB — the obvious first guess, and what this shipped as — was
// right on that boundary and missed most of them. Read only for the engines that
// need it, and only on a partial read.
const HEAD_BYTES = 128 * 1024;

async function readHead(filePath, headBytes, size) {
  if (!(headBytes > 0)) return null;
  const fd = await fsp.open(filePath, 'r');
  try {
    const len = Math.min(headBytes, size);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fd.read(buf, 0, len, 0);
    // Cut at the last complete line: a half-record would just fail to parse.
    const last = buf.lastIndexOf(NL, bytesRead - 1);
    return last === -1 ? buf.subarray(0, bytesRead) : buf.subarray(0, last + 1);
  } finally {
    await fd.close();
  }
}

// The tail of `filePath` as bytes starting at a line boundary.
//
// Returns { buf, startLine, cutOffset, whole, size, mtimeMs, head }. `whole`
// means the file was small enough (or unsplittable) that this IS the whole
// file, so the caller can treat the parse as complete rather than partial.
// `cutOffset` is the byte `buf` starts at (0 for a whole read): it was always
// computed by scanForCut and, until features/04 phase 4, dropped here, which
// left the master re-deriving it from `size - buf.length`. `head` is the
// opening bytes when `headBytes` was asked for (readHead above).
async function readTail(filePath, maxBytes = TAIL_BYTES, { headBytes = 0 } = {}) {
  const st = await fsp.stat(filePath);
  if (st.size <= maxBytes) {
    // The whole file IS the head — no second read, and nothing is missing from it.
    return { buf: await fsp.readFile(filePath), startLine: 0, cutOffset: 0, whole: true, size: st.size, mtimeMs: st.mtimeMs, head: null };
  }
  let { cutOffset, cutLine, lines } = await scanForCut(filePath, st.size, maxBytes);
  const fd = await fsp.open(filePath, 'r');
  try {
    if (cutOffset === -1 || cutOffset >= st.size) {
      // One line longer than the budget (the cut landed at EOF, or nowhere).
      // That line alone is the tail when it fits the ceiling: the same rule
      // readBefore applies, and what used to ship the whole file behind one
      // giant last record. Past the ceiling the whole file still goes, as it
      // always did: a tail with nothing in it is no paint at all.
      const terminated = cutOffset !== -1;
      const lineStart = (await newlineBefore(fd, terminated ? st.size - 1 : st.size)) + 1;
      if (lineStart <= 0 || st.size - lineStart > LINE_MAX) {
        return { buf: await fsp.readFile(filePath), startLine: 0, cutOffset: 0, whole: true, size: st.size, mtimeMs: st.mtimeMs, head: null };
      }
      cutOffset = lineStart;
      cutLine = terminated ? lines - 1 : lines;
    }
    const head = await readHead(filePath, headBytes, st.size);
    const len = st.size - cutOffset;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fd.read(buf, 0, len, cutOffset);
    return { buf: buf.subarray(0, bytesRead), startLine: cutLine, cutOffset, whole: false, size: st.size, mtimeMs: st.mtimeMs, head };
  } finally {
    await fd.close();
  }
}

// The widening ladder a tail read climbs when its window did not fill
// (features/04 phase 4). The master used to run this escalation itself, one
// tunnel round trip per rung, 512 KiB then 4 MiB; run where the file lives it
// starts smaller and every rung is local disk. The same rungs lastUserAt's
// scan uses, for the same reason: 64 KiB answers most chats, and only a chat
// whose last messages are enormous ever reads the bigger windows.
const FILL_WINDOWS = [64 * 1024, TAIL_BYTES, TAIL_BYTES_MAX];

// readTail, widened locally until `filled(tail)` says the window is enough or
// the ladder runs out. `windows` is climbed in order and clamped to `cap`; a
// rung no larger than the last is skipped, and a whole-file read ends the
// climb because no wider window exists. Returns the LAST read, which is the
// smallest one that filled, or the widest one tried.
//
// `transform` (stripImagePayloads, below) rewrites each read before it is
// judged, and then `cap` bounds what the transform LEAVES, not what was read:
// the ladder may climb to `rawCap` on disk while the bytes that will cross the
// tunnel are still under `cap`. A read whose transformed size reaches `cap`
// ends the climb the way the cap always did.
async function readTailFilled(filePath, { windows = FILL_WINDOWS, cap = TAIL_BYTES_MAX, headBytes = 0, filled, transform = null, rawCap = cap } = {}) {
  let last = null;
  let prev = 0;
  for (const want of windows) {
    const maxBytes = Math.min(want, transform ? Math.max(cap, rawCap) : cap);
    if (maxBytes <= prev) continue;
    prev = maxBytes;
    last = await readTail(filePath, maxBytes, { headBytes });
    if (transform) last = transform(last);
    if (last.whole || !filled || filled(last)) return last;
    if (transform && last.buf.length >= cap) return last;
  }
  return last;
}

// ---- pictures out of a tail (stripImages) ----
//
// A tool result's picture is base64 inside its jsonl line: a Claude image
// source's `"data":"..."` next to `"media_type":"image/..."`, or a Codex
// `"data:image/...;base64,..."` URL. Codex's image generator also writes each
// picture it makes, bare, as the `"result"` of an `image_gen` item_completed
// event, which no parser reads: measured on a chat of thumbnails, 6.4 of the
// last 16 MB. One generated picture is megabytes, so a
// tail of a chat that makes pictures was mostly picture: measured, a Codex
// chat's 4 MiB tail held ONE message, and every open sent those 4 MiB over the
// tunnel for a picture the browser fetches by URL anyway.
//
// So a payload of at least `minLen` base64 characters is cut out and replaced
// by a stub, `!tdimg<i>`, which no base64 alphabet contains. The line stays
// valid JSON and parses to the same message, whose picture now reads
// `data:image/png;base64,!tdimg<i>`. `strips[i]` says where it was: `offset`
// and `len` in the INPUT buffer (the bytes the master fetches when the picture
// is asked for), `at` in the OUTPUT buffer (where the stub starts, so a
// position in the output maps back to the file exactly), and `hash`, the
// sha256 of the payload, which is the picture's URL. Nothing else moves.
const IMG_STUB = '!tdimg';
const B64 = new Uint8Array(256);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=') B64[c.charCodeAt(0)] = 1;
const QUOTE = 0x22;
const CODEX_MARK = Buffer.from(';base64,');
const CLAUDE_MARK = Buffer.from('"data":"');
const GEN_MARK = Buffer.from('"result":"');
const GEN_KIND = '"kind":"image_gen.';
// How far back a Claude payload's media type may sit in its own source object.
const MEDIA_LOOKBACK = 160;

function payloadAt(buf, start, minLen) {
  let i = start;
  while (i < buf.length && B64[buf[i]]) i += 1;
  // A payload ends at its closing quote; anything else (an escape, a cut line)
  // is not one we can lift out whole.
  if (i >= buf.length || buf[i] !== QUOTE) return 0;
  return i - start >= minLen ? i - start : 0;
}

function stripImagePayloads(buf, minLen) {
  const cuts = [];
  for (const mark of [CODEX_MARK, CLAUDE_MARK, GEN_MARK]) {
    let at = buf.indexOf(mark);
    while (at !== -1) {
      const start = at + mark.length;
      let ok = false;
      if (mark === CODEX_MARK) {
        const back = buf.lastIndexOf('"data:image/', at);
        ok = back !== -1 && at - back < 64;
      } else if (mark === GEN_MARK) {
        // Same line, earlier: the item says what it is before its result.
        const kind = buf.lastIndexOf(GEN_KIND, at);
        ok = kind !== -1 && buf.lastIndexOf(NL, at) < kind;
      } else {
        const back = buf.lastIndexOf('"media_type":"image/', at);
        ok = back !== -1 && at - back < MEDIA_LOOKBACK && buf.lastIndexOf('{', at) < back;
      }
      const len = ok ? payloadAt(buf, start, minLen) : 0;
      if (len) cuts.push({ offset: start, len });
      at = buf.indexOf(mark, start + Math.max(len, 1));
    }
  }
  if (!cuts.length) return { buf, strips: [] };
  cuts.sort((a, b) => a.offset - b.offset);
  const parts = [];
  const strips = [];
  let from = 0;
  let out = 0;
  for (const c of cuts) {
    const stub = Buffer.from(`${IMG_STUB}${strips.length}`);
    parts.push(buf.subarray(from, c.offset), stub);
    out += c.offset - from;
    strips.push({
      at: out,
      stub: stub.length,
      offset: c.offset,
      len: c.len,
      hash: crypto.createHash('sha256').update(buf.subarray(c.offset, c.offset + c.len)).digest('hex').slice(0, 32),
    });
    out += stub.length;
    from = c.offset + c.len;
  }
  parts.push(buf.subarray(from));
  return { buf: Buffer.concat(parts), strips };
}

// A position in a stripped buffer, back in the original's bytes. Only ever
// asked about line boundaries, which no stub is inside.
function unstripPos(strips, pos) {
  let raw = pos;
  for (const s of strips || []) {
    if (s.at + s.stub > pos) break;
    raw += s.len - s.stub;
  }
  return raw;
}

// ---- the backwards page (features/04 phase 5) ----
//
// A page of scroll-back is the whole lines ENDING at `endOffset` (exclusive),
// as many of them as `maxBytes` holds from a line boundary: the mirror image
// of readTail, which reads the whole lines ending at EOF. Same shape back,
// same meaning: `cutOffset` is the byte the page starts at, `startLine` its
// jsonl line index, `whole` when the page reaches the file's first byte and
// there is nothing above it to page to.
//
// `endOffset` is a line start the caller was handed by an earlier read (the
// head token), never a guess: the byte before it is a newline, or it is 0.
// One line longer than the budget reads back to the file's start, as readTail
// reads a whole file in the same case; the ladder below is what keeps that
// from being the common answer.

// The byte where line `line` of `buf` starts: the byte after its `line`-th
// newline, or buf.length when it has fewer lines than that.
function offsetOfLine(buf, line) {
  const want = Math.max(0, Math.floor(line) || 0);
  if (want === 0) return 0;
  let at = -1;
  for (let n = 0; n < want; n += 1) {
    at = buf.indexOf(NL, at + 1);
    if (at === -1) return buf.length;
  }
  return at + 1;
}

// The cut for a page ending at `end` over bytes in hand: the mirror image of
// tailCut. The window [end - maxBytes, end) is the page when a line starts
// inside it; when none does, the line ending at `end` is longer than the
// window, and it is the page by itself up to `lineMax` and skipped past it
// (`skippedBytes`, an empty page whose cut is that line's start). Never the
// whole prefix: that was the 30 MB frame. `single` marks a page the ladder
// cannot widen, because no wider window changes a one-line answer.
function cutBefore(buf, end, maxBytes, lineMax = LINE_MAX) {
  if (end <= maxBytes) return { cutOffset: 0, skippedBytes: 0, single: false };
  const target = end - maxBytes;
  const nl = buf.indexOf(NL, target);
  if (nl !== -1 && nl + 1 < end) return { cutOffset: nl + 1, skippedBytes: 0, single: false };
  const lineStart = buf.lastIndexOf(NL, target - 1) + 1;
  if (end - lineStart <= lineMax) return { cutOffset: lineStart, skippedBytes: 0, single: true };
  return { cutOffset: lineStart, skippedBytes: end - lineStart, single: true };
}

// In-memory twin of readBefore, for a caller that already holds the bytes (the
// master's whole-file fallback on an old agent, a test). Same contract, no I/O.
function sliceBefore(buf, endOffset, maxBytes, { lineMax = LINE_MAX } = {}) {
  const end = Math.max(0, Math.min(Math.floor(endOffset) || 0, buf.length));
  const cut = cutBefore(buf, end, maxBytes, lineMax);
  const pageEnd = cut.skippedBytes ? cut.cutOffset : end;
  return {
    buf: buf.subarray(cut.cutOffset, pageEnd),
    startLine: countNewlines(buf, 0, cut.cutOffset),
    cutOffset: cut.cutOffset,
    whole: cut.cutOffset === 0,
    size: buf.length,
    skippedBytes: cut.skippedBytes,
    single: cut.single,
  };
}

// sliceBefore climbed over `windows` until `filled(page)` or the ladder runs
// out: readBeforeFilled's arithmetic over bytes already in hand.
function sliceBeforeFilled(buf, endOffset, { windows = FILL_WINDOWS, cap = TAIL_BYTES_MAX, lineMax = LINE_MAX, filled } = {}) {
  let last = null;
  let prev = 0;
  for (const want of windows) {
    const maxBytes = Math.min(want, cap);
    if (maxBytes <= prev) continue;
    prev = maxBytes;
    last = sliceBefore(buf, endOffset, maxBytes, { lineMax });
    if (last.whole || last.single || !filled || filled(last)) return last;
  }
  return last;
}

// The whole lines of `filePath` ending at `endOffset`, at most `maxBytes` of
// them, from a line boundary. Returns { buf, startLine, cutOffset, whole,
// size, mtimeMs, skippedBytes }. The cut is found BACKWARDS from the page's
// end (one read of the window, then newlineBefore for the giant-line case),
// so a page costs its own bytes on this disk too, not a scan from byte 0;
// `startLine` is one forward count of the prefix, which is the only way to
// an exact line index and is the cheap half (~50 ms per 50 MB, sequential).
// `countLines: false` leaves it 0 for a caller that counts once itself.
async function readBefore(filePath, endOffset, maxBytes = TAIL_BYTES, { lineMax = LINE_MAX, countLines = true } = {}) {
  const st = await fsp.stat(filePath);
  const end = Math.max(0, Math.min(Math.floor(endOffset) || 0, st.size));
  const fd = await fsp.open(filePath, 'r');
  try {
    const readAt = async (from, to) => {
      const buf = Buffer.alloc(Math.max(0, to - from));
      const { bytesRead } = buf.length > 0 ? await fd.read(buf, 0, buf.length, from) : { bytesRead: 0 };
      return buf.subarray(0, bytesRead);
    };
    const done = async (buf, cutOffset, skippedBytes, single) => ({
      buf,
      startLine: countLines ? await lineCountTo(filePath, cutOffset) : 0,
      cutOffset,
      whole: cutOffset === 0,
      size: st.size,
      mtimeMs: st.mtimeMs,
      skippedBytes,
      single,
    });
    if (end <= maxBytes) return done(await readAt(0, end), 0, 0, false);
    const target = end - maxBytes;
    const window = await readAt(target, end);
    const nl = window.indexOf(NL);
    if (nl !== -1 && target + nl + 1 < end) return done(window.subarray(nl + 1), target + nl + 1, 0, false);
    // No line starts inside the window: the line ending here is longer than
    // it. Its start is the last newline above the window.
    const lineStart = (await newlineBefore(fd, target)) + 1;
    if (end - lineStart <= lineMax) return done(await readAt(lineStart, end), lineStart, 0, true);
    return done(Buffer.alloc(0), lineStart, end - lineStart, true);
  } finally {
    await fd.close();
  }
}

// readBefore, widened locally until `filled(page)` says the page is enough or
// the ladder runs out; the same climb readTailFilled makes, for the same
// reason. Returns the LAST read: the smallest one that filled, or the widest.
// A one-line page ends the climb (no wider window changes it), and the line
// count is taken once, for the page that is returned.
// `transform` and `rawCap` as readTailFilled's: the page may widen on disk
// while what it will SEND is still under `cap`.
async function readBeforeFilled(filePath, endOffset, { windows = FILL_WINDOWS, cap = TAIL_BYTES_MAX, lineMax = LINE_MAX, filled, transform = null, rawCap = cap } = {}) {
  let last = null;
  let prev = 0;
  for (const want of windows) {
    const maxBytes = Math.min(want, transform ? Math.max(cap, rawCap) : cap);
    if (maxBytes <= prev) continue;
    prev = maxBytes;
    last = await readBefore(filePath, endOffset, maxBytes, { lineMax, countLines: false });
    if (transform) last = transform(last);
    // One line longer than the window is final for raw bytes: widening would
    // send more than the cap. Stripped, that line was a picture and is a few
    // bytes now, so the next rung brings the lines above it in.
    if (last.whole || (last.single && !transform) || !filled || filled(last)) break;
    if (transform && last.buf.length >= cap) break;
  }
  if (last) last.startLine = await lineCountTo(filePath, last.cutOffset);
  return last;
}

// Where jsonl line `line` starts, counted on this disk: the byte after the
// `line`-th newline. `{ offset, nlOwed }` with nlOwed false when that many
// terminated lines exist; nlOwed true when the file holds exactly `line - 1`
// terminated lines plus an unterminated tail, which the parser counts as a
// line whose newline is still owed (transcript.byteCursorFor's first case);
// `{ reset: true }` when the file has fewer lines than that. Sequential, holds
// one chunk, and stops at the newline it was looking for rather than reading
// to EOF. The caller's boundary check is what catches a rewritten file: this
// only counts.
async function lineOffset(filePath, line) {
  const st = await fsp.stat(filePath);
  const want = Math.max(0, Math.floor(line) || 0);
  // A checkpoint is a line start with a known count, so one at `want` lines IS
  // the answer, and one below it is where the count resumes.
  const from = want > 0 ? await checkpointBelow(filePath, st.size, want) : { offset: 0, lines: 0 };
  if (want > 0 && from.offset > 0 && from.lines === want) return { offset: from.offset, nlOwed: false, size: st.size, mtimeMs: st.mtimeMs };
  return new Promise((resolve, reject) => {
    if (want === 0) return resolve({ offset: 0, nlOwed: false, size: st.size, mtimeMs: st.mtimeMs });
    let pos = from.offset;
    let lines = from.lines;
    let found = -1;
    let lastByte = from.offset > 0 ? NL : -1;
    const stream = fs.createReadStream(filePath, { start: from.offset });
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      for (let i = chunk.indexOf(NL); i !== -1; i = chunk.indexOf(NL, i + 1)) {
        lines += 1;
        if (lines === want) { found = pos + i + 1; stream.destroy(); return; }
      }
      pos += chunk.length;
      if (chunk.length) lastByte = chunk[chunk.length - 1];
    });
    const done = () => {
      if (found !== -1) return resolve({ offset: found, nlOwed: false, size: st.size, mtimeMs: st.mtimeMs });
      // Exactly one short, with bytes after the last newline: the unterminated
      // line the parser already counted. Its newline is owed, and the resume
      // point is the end of what was read.
      if (lines === want - 1 && pos > 0 && lastByte !== NL) {
        return resolve({ offset: pos, nlOwed: true, size: st.size, mtimeMs: st.mtimeMs });
      }
      resolve({ reset: true, size: st.size, mtimeMs: st.mtimeMs });
    };
    stream.on('close', done);
    stream.on('end', done);
  });
}

// Scan BACKWARDS from `endOffset` over whole lines, newest first, until
// `match(line)` returns a non-null value, in bounded chunks so a 50 MB rollout
// never sits in memory. A line is examined only once its start is known, so a
// record straddling a chunk boundary is carried into the next read rather than
// split. Returns the match, or null once the file's first line has been seen.
async function scanBackLines(filePath, endOffset, match, chunkBytes = 1024 * 1024) {
  if (!(endOffset > 0)) return null;
  const fd = await fsp.open(filePath, 'r');
  try {
    let end = endOffset;
    let carry = Buffer.alloc(0); // the partial first line of the previous chunk
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const len = end - start;
      const buf = Buffer.alloc(len + carry.length);
      const { bytesRead } = await fd.read(buf, 0, len, start);
      carry.copy(buf, bytesRead);
      const whole = buf.subarray(0, bytesRead + carry.length);
      // Lines whose start is inside this chunk begin after its first newline;
      // at the file's start every byte is a line start.
      const firstNL = start > 0 ? whole.indexOf(NL) : -1;
      if (start > 0 && firstNL === -1) { carry = Buffer.from(whole); end = start; continue; }
      const region = start > 0 ? whole.subarray(firstNL + 1) : whole;
      const lines = region.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (!lines[i]) continue;
        const hit = match(lines[i]);
        if (hit != null) return hit;
      }
      carry = start > 0 ? Buffer.from(whole.subarray(0, firstNL + 1)) : Buffer.alloc(0);
      end = start;
    }
    return null;
  } finally {
    await fd.close();
  }
}

// ---- escalating tail scan, for "when did I last type here?" ----
//
// `lastUserAt` is the sidebar's sort key, and it is read off the tail because
// the answer is almost always the last few lines. Almost. A fixed 64 KB window
// was measured WRONG on 16 of 60 recent transcripts on one box (27%): one long
// agentic turn — a big tool result, a wall of file content — pushes the prompt
// that started it clean out of the window, the scan returns null, and the chat
// falls back to sorting by mtime. Worst case measured was a 12-hour error: the
// chat last typed in at 19:28 sorted as though it were 07:25 the next morning,
// because that is when the ENGINE last wrote to it.
//
// So escalate instead of giving up. 64 KB answers the common case for free;
// the two larger windows only ever get read for a chat the small one missed.
// Caps at 4 MB — the same last-word ceiling readTail uses, for the same reason:
// falling all the way back to a full parse hands the biggest chats back the
// cost this module exists to remove, and a chat with no prompt in its last
// 4 MB has no better answer available than its mtime.
const LAST_PROMPT_WINDOWS = [64 * 1024, 512 * 1024, 4 * 1024 * 1024];

// Overlap kept when re-scanning a file we have already given up on once, so a
// prompt record straddling the old boundary is not lost between two passes. A
// prompt can be a large paste, so this is generous rather than exact — it is
// read once per append, not per refresh.
const REVISIT_SLACK = 64 * 1024;

// Scan backwards from the end of a file, widening the window until `scan` finds
// something. The caller owns the I/O — `read(offset, length) => Promise<string>`
// — because the two callers read from different places: the hub from its own
// disk, the master from an agent across the tunnel.
//
// Each step re-reads the bytes the previous one covered. That is deliberate: the
// windows are cheap next to the correctness, and stitching partial buffers would
// mean tracking a line boundary across reads for no gain on the 73% that never
// escalate at all.
//
// `knownEmptyBelow` is the negative-result cache, and it is what keeps a chat we
// can NEVER answer from costing the full ladder forever. Measured on one box:
// 2 of 752 sessions have their last prompt past the 4 MB ceiling (one turn wrote
// 6.9 MB after it), so the scan finds nothing no matter how far it reads. Without
// this, every append re-ran 64 KB + 512 KB + 4 MB against the same bytes — on the
// cloud path, 4.6 MB across the tunnel per refresh, for the whole of a long turn.
//
// If we searched down to offset X last time and found nothing, everything below X
// is still empty — the only bytes that can hold a new prompt are the ones appended
// since. So the reach shrinks to (what is new) + slack, and the work becomes
// proportional to what was WRITTEN rather than to the file's size.
async function scanTailWidening(size, read, scan, opts = LAST_PROMPT_WINDOWS) {
  const { windows = LAST_PROMPT_WINDOWS, knownEmptyBelow = null } =
    Array.isArray(opts) ? { windows: opts } : (opts || {});
  // With a negative cache there is nothing to escalate THROUGH: everything below
  // the mark is known empty, so the answer can only be in the bytes appended
  // since. Read exactly those in one pass. Climbing the ladder here would re-read
  // ground we have already ruled out to reach the same conclusion.
  const ladder = knownEmptyBelow == null
    ? windows
    : [Math.max(0, size - knownEmptyBelow) + REVISIT_SLACK];
  let prevLen = 0;
  for (const want of ladder) {
    const len = Math.min(size, want);
    if (len <= prevLen) break; // window stopped growing — the whole file is already covered
    let text;
    try {
      text = await read(size - len, len);
    } catch {
      return null; // unreadable (EBUSY, tunnel hiccup) — caller keeps its previous value
    }
    const hit = scan(text);
    if (hit != null) return hit;
    prevLen = len;
    if (len >= size) break; // read the whole file and still nothing — no bigger window exists
  }
  return null;
}

module.exports = {
  HEAD_BYTES,
  readTail, readTailFilled, FILL_WINDOWS, lineOffset, scanBackLines,
  stripImagePayloads, unstripPos, IMG_STUB,
  readBefore, readBeforeFilled, sliceBefore, sliceBeforeFilled, offsetOfLine, lineCountTo, LINE_MAX,
  sliceTail, tailCut, countNewlines, tailUnderfilled,
  scanTailWidening, TAIL_BYTES, TAIL_BYTES_MAX, LAST_PROMPT_WINDOWS, REVISIT_SLACK,
};
