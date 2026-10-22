'use strict';

// WHY a limit is being spent, not how much of it is left.
//
// agent/limits.js already answers "how much is left" — it reads the real usage
// windows and the sidebar draws them. That number tells you that you are at 31%
// of the week and nothing whatsoever about what put you there, which is the
// question anyone actually has when the answer is uncomfortable.
//
// Claude Code's own `/usage` answers it from the transcripts on the machine,
// and says so: "Approximate, based on local sessions on this machine". This
// computes the same class of answer from the same files. It is a QUESTION
// answered where the disk is (lib/index-head.js's rule): a browser pulling
// 268 MB of jsonl over the tunnel to count tokens would be absurd, and the
// answer is a few hundred bytes.
//
// APPROXIMATE, and the UI must keep saying so. It sees this machine's Claude
// transcripts — not other devices, not claude.ai, not another engine. The
// behaviours are independent characteristics of the same spend, not a
// partition of it: a request can be both large-context and parallel, so the
// shares do not add to 100 and must never be drawn as if they do.
//
// Shipped to agents by name (AGENT_FILES in master.js), so this module may only
// require SIBLINGS in lib/. It requires none: node builtins only.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// The windows `/usage` reports. Ordered longest last so one pass fills both.
const WINDOWS = [
  { id: '24h', label: 'Last 24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * 60 * 60 * 1000 },
];

// A request is "large context" past this. Matches the threshold Claude Code
// reports against, and it is the one that correlates with burning a window fast.
const BIG_CONTEXT_TOKENS = 150_000;
// Requests are bucketed this coarsely when counting how many chats were running
// at once. Finer than a turn, coarser than the gaps inside one.
const PARALLEL_BUCKET_MS = 5 * 60 * 1000;
// How many chats at once counts as "in parallel".
const PARALLEL_SESSIONS = 4;
// A session that dispatched at least this many subagents is subagent-heavy.
const SUBAGENT_HEAVY_CALLS = 3;
// Bounds. A machine with a year of history must not turn this into a scan of
// everything it has ever done, and the caller gets told when a bound bit.
const MAX_FILES = 600;
const MAX_BYTES = 1_500 * 1024 * 1024;
const MAX_LEADERS = 5;

// Everything a limit is charged for. Cache reads are cheaper per token but they
// are not free, and leaving them out understates a long chat by an order of
// magnitude — which is exactly the chat someone is trying to explain.
function billable(u) {
  if (!u || typeof u !== 'object') return 0;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens);
}

// What the model was handed to think about, which is the number the ">150k"
// line is about — the output it then wrote is not part of the context.
function contextSize(u) {
  if (!u || typeof u !== 'object') return 0;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
}

// `mcp__<server>__<tool>` is the only naming an MCP tool has, so the server is
// recoverable from the tool name alone and needs no config read.
function mcpServer(name) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(String(name || ''));
  return m ? m[1] : null;
}

async function listTranscripts(root, since) {
  const out = [];
  let dirs;
  try { dirs = await fsp.readdir(root, { withFileTypes: true }); } catch { return { files: [], truncated: false }; }
  let truncated = false;
  let bytes = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names;
    try { names = await fsp.readdir(path.join(root, d.name)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(root, d.name, name);
      let st;
      try { st = await fsp.stat(file); } catch { continue; }
      // The cheapest filter there is, and the one that matters most: a week's
      // window cannot contain a file nothing has written to in a week. On a
      // real machine this drops 1.2 GB of history to 268 MB.
      if (st.mtimeMs < since) continue;
      if (out.length >= MAX_FILES || bytes + st.size > MAX_BYTES) { truncated = true; continue; }
      bytes += st.size;
      out.push({ file, session: name.replace(/\.jsonl$/, '') });
    }
  }
  return { files: out, truncated };
}

// One transcript's usage records, as the summary needs them. Only the fields
// it reads are kept of a tool call's input: the input of a Write can be a
// whole file, and these records now outlive the request (the memo below).
function recordOf(line, entry, since) {
  // Cheap reject before the parse: most lines in these files are not the
  // record we want, and JSON.parse on all of them is the whole cost.
  if (line.length < 24 || line.indexOf('"assistant"') === -1) return null;
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  if (rec.type !== 'assistant' || !rec.message || !rec.message.usage) return null;
  const at = Date.parse(rec.timestamp || '');
  if (!Number.isFinite(at) || at < since) return null;
  const tools = Array.isArray(rec.message.content) ? rec.message.content.filter((b) => b && b.type === 'tool_use') : [];
  return {
    id: rec.message.id || null,
    at,
    session: rec.sessionId || entry.session,
    usage: rec.message.usage,
    tokens: billable(rec.message.usage),
    context: contextSize(rec.message.usage),
    content: tools.map((b) => {
      const input = b.input && typeof b.input === 'object' ? b.input : {};
      const kept = {};
      if (input.skill != null) kept.skill = input.skill;
      if (input.subagent_type != null) kept.subagent_type = input.subagent_type;
      return { type: 'tool_use', id: b.id, name: b.name, input: kept };
    }),
  };
}

// What each transcript has already yielded, so a second read of the week
// costs what was appended since the first (features/04 phase 9) instead of
// every byte of every file again. `since` only ever moves forward, so a record
// that fell out of the window never comes back into it; the kept ones are
// filtered again on every read. A file that did not simply grow (the probe:
// identity plus the bytes before the old end) is read whole.
const SCAN_MEMO_MAX = 2000;
const PROBE_BYTES = 64;
const scanMemo = new Map(); // file -> { size, offset, probe, records }

async function probeAt(file, offset) {
  const fd = await fsp.open(file, 'r');
  try {
    const st = await fd.stat();
    const len = Math.min(PROBE_BYTES, offset);
    const buf = Buffer.alloc(Math.max(0, len));
    const { bytesRead } = len > 0 ? await fd.read(buf, 0, len, offset - len) : { bytesRead: 0 };
    return `${st.dev}:${st.ino}:${buf.subarray(0, bytesRead).toString('base64')}`;
  } finally { await fd.close(); }
}

// One pass over one transcript, from where the last pass stopped. Streamed
// rather than read whole: a single transcript can be 42 MB, and holding one in
// a string to count its tokens is how a thin agent on a small box gets itself
// OOM-killed.
async function scanFile(entry, since, sink) {
  let st;
  try { st = await fsp.stat(entry.file); } catch { return; }
  const hit = scanMemo.get(entry.file);
  let from = 0;
  let kept = [];
  if (hit && st.size >= hit.size) {
    let same = false;
    try { same = (await probeAt(entry.file, hit.offset)) === hit.probe; } catch {}
    if (same) { from = hit.offset; kept = hit.records.filter((r) => r.at >= since); }
  }
  const fresh = [];
  let offset = from;
  let rest = Buffer.alloc(0);
  if (st.size > from) {
    await new Promise((resolve) => {
      let stream;
      try { stream = fs.createReadStream(entry.file, { start: from, end: st.size - 1 }); } catch { return resolve(); }
      stream.on('error', () => resolve());
      stream.on('data', (chunk) => {
        const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        let at = 0;
        for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, at)) {
          const r = recordOf(buf.toString('utf8', at, nl).replace(/\r$/, ''), entry, since);
          if (r) fresh.push(r);
          at = nl + 1;
        }
        offset += at;
        rest = Buffer.from(buf.subarray(at));
      });
      stream.on('end', () => resolve());
    });
  }
  for (const r of kept) sink(r);
  for (const r of fresh) sink(r);
  // An unterminated last record counts for this answer and is read again,
  // whole, next time: it is never part of what the memo vouches for.
  const tail = rest.length ? recordOf(rest.toString('utf8'), entry, since) : null;
  if (tail) sink(tail);
  let probe;
  try { probe = await probeAt(entry.file, offset); } catch { return; }
  scanMemo.delete(entry.file);
  scanMemo.set(entry.file, { size: st.size, offset, probe, records: kept.concat(fresh) });
  while (scanMemo.size > SCAN_MEMO_MAX) scanMemo.delete(scanMemo.keys().next().value);
}

// Claude writes one assistant record per content block, with progressive usage
// snapshots, and forks can copy those records into another file. A message is
// one request: keep its largest counters and each tool call once before deriving
// request counts or token-weighted shares. Attribution uses the earliest record.
function collectRequest(byId, records, record) {
  if (!record.id) { records.push(record); return; }
  let request = byId.get(record.id);
  if (!request) {
    request = { ...record, usage: {}, content: [], tools: new Map() };
    byId.set(record.id, request);
    records.push(request);
  }
  if (record.at < request.at || (record.at === request.at && record.session < request.session)) {
    request.at = record.at;
    request.session = record.session;
  }
  for (const field of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']) {
    const value = Number(record.usage[field]);
    if (Number.isFinite(value)) request.usage[field] = Math.max(request.usage[field] || 0, value);
  }
  request.tokens = billable(request.usage);
  request.context = contextSize(request.usage);
  for (const [index, block] of record.content.entries()) {
    const key = block.id || JSON.stringify([index, block.name, block.input]);
    const existing = request.tools.get(key);
    if (existing) {
      // A later snapshot can complete the input of the same tool call.
      Object.assign(existing.input, block.input);
      continue;
    }
    const tool = { ...block, input: { ...block.input } };
    request.tools.set(key, tool);
    request.content.push(tool);
  }
}

// Share of TOKENS, not of requests: the question is what spent the window, and
// one 200k-context request spends what forty small ones do.
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function leaders(map, total) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LEADERS)
    .map(([name, tokens]) => ({ name, pct: pct(tokens, total) }))
    .filter((r) => r.pct > 0);
}

function summarise(records, window) {
  const total = records.reduce((n, r) => n + r.tokens, 0);
  if (!records.length || total <= 0) {
    return { id: window.id, label: window.label, requests: records.length, sessions: 0, tokens: total, empty: true };
  }

  // How many DISTINCT chats were live in each bucket. Built first because the
  // parallel share needs the whole picture before any one request can be judged.
  const bucketSessions = new Map();
  for (const r of records) {
    const b = Math.floor(r.at / PARALLEL_BUCKET_MS);
    if (!bucketSessions.has(b)) bucketSessions.set(b, new Set());
    bucketSessions.get(b).add(r.session);
  }

  // Attribution is per SESSION, not per record.
  //
  // The record that calls a skill or dispatches a subagent is almost free — the
  // spend is everything that happens afterwards because of it, and for a
  // subagent that lands in a different transcript entirely. Charging the tool
  // block's own record made every leader round to 0% and the lists came back
  // empty on a machine that had plainly used them. Crediting the session that
  // reached for it is both honest and what "your usage came from" means.
  const perSession = new Map(); // session -> { tokens, subagents, skills:Set, agents:Set, mcp:Set }
  let bigContext = 0;
  let parallel = 0;

  for (const r of records) {
    if (r.context >= BIG_CONTEXT_TOKENS) bigContext += r.tokens;
    if ((bucketSessions.get(Math.floor(r.at / PARALLEL_BUCKET_MS)) || new Set()).size >= PARALLEL_SESSIONS) parallel += r.tokens;

    let s = perSession.get(r.session);
    if (!s) { s = { tokens: 0, subagents: 0, skills: new Set(), agents: new Set(), mcp: new Set() }; perSession.set(r.session, s); }
    s.tokens += r.tokens;

    for (const block of r.content) {
      if (!block || block.type !== 'tool_use') continue;
      const name = String(block.name || '');
      const input = block.input && typeof block.input === 'object' ? block.input : {};
      if (name === 'Skill' && input.skill) s.skills.add(String(input.skill));
      // `Agent` is the current tool; `Task` is what older transcripts on the
      // same disk still call it, and this reads both rather than losing a week.
      if (name === 'Agent' || name === 'Task') {
        s.subagents += 1;
        s.agents.add(String(input.subagent_type || 'general-purpose'));
      }
      const server = mcpServer(name);
      if (server) s.mcp.add(server);
    }
  }

  const skills = new Map();
  const subagents = new Map();
  const mcp = new Map();
  let subagentHeavy = 0;
  const credit = (map, keys, tokens) => { for (const k of keys) map.set(k, (map.get(k) || 0) + tokens); };
  for (const s of perSession.values()) {
    if (s.subagents >= SUBAGENT_HEAVY_CALLS) subagentHeavy += s.tokens;
    credit(skills, s.skills, s.tokens);
    credit(subagents, s.agents, s.tokens);
    credit(mcp, s.mcp, s.tokens);
  }

  return {
    id: window.id,
    label: window.label,
    requests: records.length,
    sessions: perSession.size,
    tokens: total,
    empty: false,
    // Independent characteristics of the same spend, NOT a partition of it —
    // a request can be counted by more than one of these. See the header.
    bigContextPct: pct(bigContext, total),
    parallelPct: pct(parallel, total),
    subagentPct: pct(subagentHeavy, total),
    skills: leaders(skills, total),
    subagents: leaders(subagents, total),
    mcp: leaders(mcp, total),
  };
}

// `root` is the agent's own Claude directory — a transcript root it already
// watches. No path comes from the master, exactly like machine-config.js.
async function readUsageBehaviour(root, now = Date.now()) {
  const longest = WINDOWS[WINDOWS.length - 1].ms;
  const since = now - longest;
  const { files, truncated } = await listTranscripts(path.join(root, 'projects'), since);

  const records = [];
  const byId = new Map();
  for (const entry of files) await scanFile(entry, since, (r) => collectRequest(byId, records, r));

  return {
    at: now,
    truncated,
    files: files.length,
    thresholds: { bigContextTokens: BIG_CONTEXT_TOKENS, parallelSessions: PARALLEL_SESSIONS, subagentCalls: SUBAGENT_HEAVY_CALLS },
    windows: WINDOWS.map((w) => summarise(records.filter((r) => r.at >= now - w.ms), w)),
  };
}

module.exports = {
  readUsageBehaviour,
  billable,
  contextSize,
  mcpServer,
  summarise,
  WINDOWS,
};
