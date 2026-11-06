'use strict';

// A project's prompts, for Ctrl+R. Everything here runs on the agent, over files
// inside the transcript roots, and only the prompts cross the tunnel.
//
// TWO sources, and neither is enough alone.
//
//   * `history.jsonl` under the Claude dir is the CLI's own record, but its TUI is
//     the only thing that writes it: a chat driven as stream-json, which is every
//     chat started from the browser, leaves no line there (lib/session-title.js has
//     the measurement). It is also the only copy of an old terminal prompt once the
//     CLI has cleaned that transcript up. It holds every project on the machine, so
//     rows are filtered here and the rest never leave.
//   * The transcripts are the record of everything else, in all three engines. They
//     are read through lib/transcript.js so a prompt here is exactly what the viewer
//     and up-arrow call one. Codex is read from its rollouts rather than through the
//     app-server: this is a text search, nothing is drawn from it, and one thread
//     read per chat per search is not worth paying. Its own history.jsonl adds
//     nothing, being TUI-only too and a copy of what the rollouts hold.
//
// Only the two ends of each transcript: a chat can be hundreds of MB. Measured on one
// real project, 174 MB of chats held 52 prompts, most chats one to five of them, so a
// tail window alone loses the opening prompt of every long chat, which is the long
// one somebody wants to run again. Parsing is about 5 ms per MB, so the head is nearly
// free and the tail is measured in MB. What is still skipped is the middle of a very
// long chat, and the budget stops one request reading all of a big project. What a
// chat's prompts cost is memoised on its size and mtime, so a later search only
// re-reads what moved.
//
// Shipped to agents by name (AGENT_FILES in master.js), so it may only require
// siblings. It requires none; the parser is handed in.

const fsp = require('fs/promises');

const MAX_SOURCES = 30;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 4 * 1024 * 1024;
const BUDGET_BYTES = 96 * 1024 * 1024;
const HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_PROMPTS = 500;
// Recalled prompts are sent again, so one is whole or not at all: a long prompt is
// the reason to want this, and a cut one would send half of it.
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_REPLY_BYTES = 1024 * 1024;
const MEMO_FILES = 64;

// The CLI stores a big paste as a placeholder and keeps the words in pastedContents.
const PASTE_RE = /\[(?:Pasted text|\.\.\.Truncated text) #(\d+)[^\]]*\]/g;
const IMAGE_RE = /\[Image #\d+\]/g;

// One history.jsonl row as the text it stood for, or null when that cannot be
// rebuilt. A placeholder that goes back into the box would be sent as a literal.
function historyPrompt(rec) {
  const pasted = rec && typeof rec.pastedContents === 'object' && rec.pastedContents ? rec.pastedContents : {};
  let lost = false;
  const text = String((rec && rec.display) || '').replace(PASTE_RE, (_, id) => {
    const body = pasted[id] && pasted[id].content;
    if (typeof body === 'string') return body;
    lost = true;
    return '';
  }).replace(IMAGE_RE, '').trim();
  return lost || !text ? null : text;
}

function promptsFromHistory(text, isProject) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || !isProject(rec.project)) continue;
    const prompt = historyPrompt(rec);
    if (prompt) out.push({ text: prompt, at: Number(rec.timestamp) || 0 });
  }
  return out;
}

// Same test as public/js/transcript-view.js userPromptText, which is what seeds
// up-arrow: the text blocks of a user message, joined.
function promptsFromMessages(messages, fallbackAt = 0) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== 'user' || !Array.isArray(m.blocks)) continue;
    const text = m.blocks
      .filter((b) => b && b.kind === 'text' && typeof b.text === 'string')
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join('\n\n');
    if (text) out.push({ text, at: Date.parse(m.timestamp) || fallbackAt });
  }
  return out;
}

// Oldest first, which is how the composer's own list runs, with each prompt once at
// its newest. Filled from the newest end, so a cap costs the oldest prompts.
function mergePrompts(lists) {
  const all = lists.flat().sort((a, b) => b.at - a.at);
  const seen = new Set();
  const kept = [];
  let bytes = 0;
  let truncated = false;
  for (const p of all) {
    const key = p.text.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const size = Buffer.byteLength(p.text);
    if (size > MAX_PROMPT_BYTES) continue;
    if (kept.length >= MAX_PROMPTS || bytes + size > MAX_REPLY_BYTES) { truncated = true; break; }
    bytes += size;
    kept.push(p);
  }
  return { prompts: kept.reverse(), truncated };
}

// `len` bytes from `start`, trimmed to whole lines at whichever end was cut. Explicit
// length from a descriptor, like readCapped in lib/project-files.js.
async function readLines(fd, size, start, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fd.read(buf, 0, len, start);
  let text = buf.subarray(0, bytesRead).toString('utf8');
  if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  if (start + len < size) text = text.slice(0, text.lastIndexOf('\n') + 1);
  return text;
}

// The windows of a file: one if it fits, otherwise its head and its tail.
async function readWindows(file, size, headBytes, tailBytes) {
  const fd = await fsp.open(file, 'r');
  try {
    if (size <= headBytes + tailBytes) return [await readLines(fd, size, 0, size)];
    return [await readLines(fd, size, 0, headBytes), await readLines(fd, size, size - tailBytes, tailBytes)];
  } finally {
    await fd.close();
  }
}

// read({ sources, historyFile, isProject }) -> { prompts: [{ text, at }], truncated }.
// `sources` are { path, engine }, newest chat first, already confined by the caller,
// as `historyFile` is. `transcript` is lib/transcript.js.
function createPromptReader(transcript, { headBytes = HEAD_BYTES, tailBytes = TAIL_BYTES, budgetBytes = BUDGET_BYTES } = {}) {
  const memo = new Map(); // path -> { size, mtimeMs, prompts }
  const parse = (engine, text) => {
    if (engine === 'codex') return transcript.parseRolloutText(text);
    if (engine === 'grok') return transcript.parseGrokUpdatesText(text);
    return transcript.parseTranscriptText(text);
  };
  return async function read({ sources, historyFile = null, isProject = () => false }) {
    const lists = [];
    let left = budgetBytes;
    let short = false;
    for (const src of sources.slice(0, MAX_SOURCES)) {
      let st;
      try { st = await fsp.stat(src.path); } catch { continue; }
      const hit = memo.get(src.path);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) { lists.push(hit.prompts); continue; }
      if (left <= 0) { short = true; continue; }
      const tail = Math.min(tailBytes, left);
      left -= Math.min(st.size, headBytes + tail);
      const prompts = [];
      try {
        // Parsed apart: the two windows are not one conversation, and a turn must
        // not appear to run across the gap.
        for (const text of await readWindows(src.path, st.size, headBytes, tail)) {
          const parsed = parse(src.engine, text);
          prompts.push(...promptsFromMessages(parsed && parsed.messages, st.mtimeMs));
        }
      } catch { continue; } // one unreadable chat is not a reason to lose the others
      memo.delete(src.path);
      memo.set(src.path, { size: st.size, mtimeMs: st.mtimeMs, prompts });
      if (memo.size > MEMO_FILES) memo.delete(memo.keys().next().value);
      lists.push(prompts);
      // Parsing holds the only thread the live chats have, so it goes a file at a time.
      await new Promise((resume) => { setImmediate(resume); });
    }
    if (historyFile) {
      try {
        const st = await fsp.stat(historyFile);
        const len = Math.min(st.size, HISTORY_BYTES);
        const fd = await fsp.open(historyFile, 'r');
        try {
          lists.push(promptsFromHistory(await readLines(fd, st.size, st.size - len, len), isProject));
        } finally {
          await fd.close();
        }
      } catch { /* no terminal history on this box, which is an answer */ }
    }
    const merged = mergePrompts(lists);
    return { prompts: merged.prompts, truncated: merged.truncated || short };
  };
}

module.exports = {
  createPromptReader, promptsFromHistory, promptsFromMessages, mergePrompts, historyPrompt,
  MAX_SOURCES, MAX_PROMPTS, MAX_PROMPT_BYTES,
};
