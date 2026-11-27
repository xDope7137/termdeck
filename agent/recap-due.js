'use strict';

// When Claude's "recap" is owed to a chat that was left alone in Termdeck, and
// the record it is written as. Pure: no fs, no spawn. Ships to agent boxes as
// recap-due.js (AGENT_FILES in master.js); the master reads the timing half.
//
// The terminal does this by itself. After a turn ends and the terminal loses
// focus, the CLI waits, asks the model for a recap in under 40 words, and writes
// it into the transcript as a `system` / `away_summary` record, so the person
// finds it when they come back. Termdeck runs the CLI headless, one process per
// turn, and a headless CLI has no focus to lose, so it never writes one. These
// are the CLI's own rules (2.1.332, its away-summary scheduler), copied so a
// chat in the browser gets the recap the same chat would get in a terminal:
//
//   * wait 3 minutes after the turn ends, or 80% of the prompt cache's life if
//     that is shorter, and only while the person is away;
//   * skip once the cache is 90% of the way to expiring: the recap is cheap only
//     because it reads the chat from the cache;
//   * skip while background agents are still running;
//   * at least 3 user messages in the chat, and 2 more since the last recap;
//   * never two recaps in a row;
//   * off when the person turned recaps off (settings `awaySummaryEnabled:
//     false`, or CLAUDE_CODE_ENABLE_AWAY_SUMMARY=0 on the machine).
//
// The words come from the CLI's own `/recap`, run on a throwaway fork of the
// session that writes nothing (agent/capabilities.js, the `recap` op).

const DELAY_MS = 180_000;
const CACHE_TTL_5M = 300_000;
const CACHE_TTL_1H = 3_600_000;
const MIN_PROMPTS = 3;
const MIN_PROMPTS_SINCE = 2;
const TEXT_MAX = 400;

// The CLI's "user message" for these counts: a user record that is not meta,
// not a compaction summary and not virtual. Tool results count too; the CLI's
// own count does not leave them out, and copying it is the point.
function isUserMessage(rec) {
  return !!rec && rec.type === 'user' && !rec.isMeta && !rec.isCompactSummary && !rec.isVirtual && !rec.isSidechain;
}

// The records the CLI holds as the conversation: everything else in the file
// (titles, cost-state, queue bookkeeping) is not a message and cannot be "last".
function isConversation(rec) {
  return !!rec && !rec.isSidechain && (rec.type === 'user' || rec.type === 'assistant' || rec.type === 'system');
}

const isRecap = (rec) => !!rec && rec.type === 'system' && rec.subtype === 'away_summary';

// Records, oldest first. `partial` says the list is only the file's tail: the
// counts can then only be lower than the truth, so a tail that already passes
// passes for the whole file, and one that has no recap in it but enough
// messages also passes (any older recap has at least as many messages since).
function recapDue(records, { partial = false } = {}) {
  const list = (records || []).filter(isConversation);
  if (!list.length) return { due: false, reason: 'empty' };
  if (isRecap(list[list.length - 1])) return { due: false, reason: 'recap-last' };
  let total = 0;
  let since = 0;
  let sawRecap = false;
  for (const rec of list) {
    if (isRecap(rec)) { sawRecap = true; since = 0; continue; }
    if (isUserMessage(rec)) { total += 1; since += 1; }
  }
  if (total < MIN_PROMPTS) return partial ? { due: true, reason: 'tail-short' } : { due: false, reason: 'too-few-messages' };
  if (sawRecap && since < MIN_PROMPTS_SINCE) return { due: false, reason: 'recap-recent' };
  return { due: true, reason: 'due' };
}

// The prompt cache's life for a turn, from the usage it reported: a turn that
// wrote 1 hour cache entries keeps them an hour, one that wrote 5 minute entries
// five minutes. A turn that only READ the cache says nothing either way, so the
// chat's last known answer stands (`fallback`), else the short one. Reads both
// the CLI's raw usage and the master's run-complete summary of it.
function cacheTtlMs(usage, fallback = null) {
  const u = usage || {};
  const cc = u.cache_creation || u.cacheCreation || {};
  const oneHour = Number(cc.ephemeral_1h_input_tokens ?? cc.ephemeral1hInputTokens ?? u.cacheCreate1h) || 0;
  const fiveMin = Number(cc.ephemeral_5m_input_tokens ?? cc.ephemeral5mInputTokens ?? u.cacheCreate5m) || 0;
  if (oneHour > 0) return CACHE_TTL_1H;
  if (fiveMin > 0) return CACHE_TTL_5M;
  return fallback || CACHE_TTL_5M;
}

function delayMs(ttlMs) {
  return Math.min(DELAY_MS, Math.round((ttlMs || CACHE_TTL_5M) * 0.8));
}

// Still worth asking: the cache the recap reads from has not gone stale.
function cacheFresh(turnEndedAt, ttlMs, now = Date.now()) {
  return now - turnEndedAt <= (ttlMs || CACHE_TTL_5M) * 0.9;
}

// The CLI's switch, read the CLI's way: the env var wins either way, then
// `awaySummaryEnabled: false` in settings turns it off. Default on.
function recapsEnabled(settings, env = {}) {
  const v = env.CLAUDE_CODE_ENABLE_AWAY_SUMMARY;
  if (v !== undefined && v !== '') {
    if (/^(0|false|no|off)$/i.test(String(v).trim())) return false;
    if (/^(1|true|yes|on)$/i.test(String(v).trim())) return true;
  }
  return !(settings && settings.awaySummaryEnabled === false);
}

// What `/recap` says when it has no recap to give. These are answers, not
// recaps, and are never written into a chat.
const NOT_A_RECAP = [
  /^Nothing to recap yet/i,
  /^Couldn't generate a recap/i,
  /^Recap cancelled/i,
  /^\/recap only runs when you ask for it yourself/i,
  /^Unknown (skill|command)/i,
];
function cleanRecap(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || NOT_A_RECAP.some((re) => re.test(t))) return '';
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1).trimEnd()}…` : t;
}

// The record, shaped as the CLI writes its own (2.1.332): parented on the last
// message so the CLI's next --resume reads it as part of the chain, and carrying
// the session's cwd, version and branch from that message.
function awaySummaryRecord({ text, last, sessionId, uuid, now = new Date() }) {
  const rec = {
    parentUuid: (last && last.uuid) || null,
    isSidechain: false,
    type: 'system',
    subtype: 'away_summary',
    content: text,
    timestamp: now.toISOString(),
    uuid,
    isMeta: false,
    userType: 'external',
    entrypoint: (last && last.entrypoint) || 'sdk-cli',
    sessionId,
  };
  if (last && last.cwd) rec.cwd = last.cwd;
  if (last && last.version) rec.version = last.version;
  if (last && last.gitBranch) rec.gitBranch = last.gitBranch;
  return rec;
}

// The message the record hangs off: the last conversation record with a uuid.
function lastMessage(records) {
  for (let i = (records || []).length - 1; i >= 0; i--) {
    const r = records[i];
    if (isConversation(r) && r.uuid) return r;
  }
  return null;
}

// The model the chat last answered with, so the recap reads the same cache.
function lastModel(records) {
  for (let i = (records || []).length - 1; i >= 0; i--) {
    const r = records[i];
    const m = r && r.type === 'assistant' && !r.isSidechain && r.message && r.message.model;
    if (typeof m === 'string' && m && !m.startsWith('<')) return m;
  }
  return null;
}

module.exports = {
  recapDue, cacheTtlMs, delayMs, cacheFresh, recapsEnabled, cleanRecap,
  awaySummaryRecord, lastMessage, lastModel,
  DELAY_MS, CACHE_TTL_5M, CACHE_TTL_1H, TEXT_MAX,
};
