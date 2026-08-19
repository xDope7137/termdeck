'use strict';

// Self-contained account-usage limits for the thin agent — NO lib/ deps (the
// agent ships only itself, agent.js + capabilities.js + this). The Claude
// subscription token never leaves the customer's box: we read it here, hit
// Anthropic's usage endpoint locally, and hand the master back only the
// (non-sensitive) percentages. Codex limits come from the app-server's own
// `account/rateLimits/read` RPC, run locally — no token leaves the box either.
// Grok limits come from cli-chat-proxy.grok.com/v1/billing with the
// OIDC token in ~/.grok/auth.json (same cred the CLI uses).
//
// This is now the ONLY normalizer: the hub's lib/limits.js that these functions
// were forked from is gone with the self-hosted local server, so the "keep the
// two copies in lockstep" problem is over. What survives it is the SHAPE — the
// { plan, account, limits: [{ key, label, percent, resetsAt, severity }] } the
// SPA widget (public/js/limits.js) renders and public/js/limits-live.js folds
// pushed engine events onto. `key` is the join between those two, so it is a
// vocabulary of ours and not whatever enum upstream happened to send
// (windowForClaude below).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const GROK_HOME = process.env.GROK_HOME || path.join(os.homedir(), '.grok');
const GROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

const CACHE_MS = 30 * 1000; // usage windows move slowly; the SPA polls every 60s
let cache = null; // { data, at } — Claude
let codexCache = null; // { data, at }
let grokCache = null; // { data, at }
let profileCache = null; // { profile: { account, plan, planMult }, at }
const PROFILE_TTL = 60 * 60 * 1000;

function parseNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTimestamp(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}

function getWindowNumber(win) {
  return parseNum(win.window_minutes) ?? parseNum(win.windowMinutes) ?? parseNum(win.windowDurationMins) ?? parseNum(win.windowDurationMinutes) ?? null;
}

// The field that answers decides the inversion, and every source is 0-100 —
// there is no "small number must be a fraction" guess, because 1 is a legal
// value on that scale and treating it as one rendered 1% used as 100% used.
const PERCENT_FIELDS = [
  ['used_percent', false],
  ['usedPercent', false],
  ['used_percentage', false],
  ['usedPercentage', false],
  ['percent', false],
  ['remaining_percent', true],
  ['remainingPercent', true],
];

function normalizePercent(win) {
  for (const [field, countsDown] of PERCENT_FIELDS) {
    const n = parseNum(win[field]);
    if (n == null) continue;
    return Math.max(0, Math.min(100, countsDown ? 100 - n : n));
  }
  return null;
}

// Bearer token for the subscription usage API + the plan tier, straight from the
// same file models.js reads. Env token wins (parity with lib/models.credential).
function claudeCred() {
  if (process.env.ANTHROPIC_AUTH_TOKEN) return { value: `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`, sub: null, tier: null };
  try {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const o = JSON.parse(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).claudeAiOauth;
    if (o && o.accessToken && (!o.expiresAt || o.expiresAt > Date.now())) {
      return { value: `Bearer ${o.accessToken}`, sub: o.subscriptionType || null, tier: o.rateLimitTier || null };
    }
  } catch {}
  return null;
}

// "default_claude_max_5x" → 5 (the ×N rate multiplier); null when absent.
function multFromTier(tier) {
  const m = /_(\d+)x$/.exec(tier || '');
  return m ? Number(m[1]) : null;
}

// A scoped weekly is keyed by model FAMILY, never by the display name verbatim.
// The name carries a version ("Claude Opus 4.6") that turns over while the window
// underneath it does not, and the CLI's own name for the same window in a pushed
// `rate_limit_event` is the bare family (`seven_day_opus`). The family is the one
// spelling both sides can reach.
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

function modelFamily(display) {
  const s = String(display || '').toLowerCase();
  return MODEL_FAMILIES.find((f) => s.includes(f)) || null;
}

// Key AND label off the SAME branches, from one function, because deriving them
// separately is what shipped a duplicate row. The key used to be `l.kind` taken
// raw — so the all-model weekly keyed 'weekly_all' while every other producer of
// this shape (demo.js, the browser specs, LIVE_WINDOW in
// public/js/limits-live.js) says 'weekly'. foldRateLimit matches a pushed event
// to a polled row BY KEY, missed, and appended a second "Weekly" row instead of
// merging into the first. Measured 2026-08-18 on a live Max 20x account.
//
// So the key is a stable vocabulary of our own, never the upstream enum: 'session',
// 'weekly', 'weekly_<family>'. `weekly_scoped` survives only as the fallback for a
// scoped window that names no model, and it must stay distinct from 'weekly' —
// collapsing the two would merge two genuinely different limits into one row.
function windowForClaude(l) {
  if (l.kind === 'session' || l.group === 'session') return { key: 'session', label: '5-hour' };
  if (l.kind === 'weekly_scoped') {
    const model = l.scope && l.scope.model && l.scope.model.display_name;
    const family = model ? modelFamily(model) : null;
    return { key: family ? `weekly_${family}` : 'weekly_scoped', label: model ? `Weekly · ${model}` : 'Weekly' };
  }
  if (l.group === 'weekly' || l.kind === 'weekly_all') return { key: 'weekly', label: 'Weekly' };
  const kind = l.kind || l.group || 'limit';
  return { key: kind, label: l.kind || 'limit' };
}

// Modern limits[] (kind/percent/resets_at) is richest; fall back to flat
// five_hour/seven_day. Every field nullable → graceful "unknown".
function normalizeClaude(body) {
  if (!body || typeof body !== 'object') return null;
  const out = [];
  if (Array.isArray(body.limits) && body.limits.length) {
    for (const l of body.limits) {
      if (l.percent == null) continue;
      const w = windowForClaude(l);
      out.push({ key: w.key, label: w.label, percent: l.percent, resetsAt: l.resets_at || null, severity: l.severity || 'normal' });
    }
  } else {
    if (body.five_hour) out.push({ key: 'session', label: '5-hour', percent: body.five_hour.utilization ?? null, resetsAt: body.five_hour.resets_at || null, severity: 'normal' });
    if (body.seven_day) out.push({ key: 'weekly', label: 'Weekly', percent: body.seven_day.utilization ?? null, resetsAt: body.seven_day.resets_at || null, severity: 'normal' });
  }
  return out.length ? { limits: out } : null;
}

// subscriptionType is 'max'/'pro'/… ; the SPA's prettyPlan keys on 'claude_max'
// etc., so prefix unless it already looks namespaced.
function planLabel(sub) {
  if (!sub) return 'claude';
  return sub.startsWith('claude_') ? sub : `claude_${sub}`;
}

// Account identity ({ id: uuid, email, name }) AND the plan, from the oauth
// /profile endpoint — one call for both. Not secret: no token, just who the
// account is. Long-cached, best-effort.
//
// The plan used to come from ~/.claude/.credentials.json instead, which the CLI
// writes at login and never rewrites — so the same machine reported one plan
// through the hub and a different one through the cloud master, and the cloud
// answer went stale the moment the user changed plan. The multi-machine usage
// panel shows this, so the mismatch was on screen. The credentials file stays
// as the fallback for when the profile call fails.
async function getClaudeProfile(cred) {
  if (profileCache && Date.now() - profileCache.at < PROFILE_TTL) return profileCache.profile;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', authorization: cred.value },
      signal: ctrl.signal,
    });
    if (!r.ok) return profileCache ? profileCache.profile : null;
    const body = await r.json();
    const acct = body.account || {};
    const org = body.organization || {};
    const account = acct.uuid ? { id: acct.uuid, email: acct.email || null, name: acct.display_name || acct.full_name || null } : null;
    const plan = org.organization_type || (acct.has_claude_max ? 'claude_max' : acct.has_claude_pro ? 'claude_pro' : null);
    const profile = { account, plan: plan || null, planMult: multFromTier(org.rate_limit_tier) };
    profileCache = { profile, at: Date.now() };
    return profile;
  } catch {
    return profileCache ? profileCache.profile : null;
  } finally {
    clearTimeout(timer);
  }
}

async function getClaudeLimits() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const cred = claudeCred();
  if (!cred || typeof fetch !== 'function') return cache ? cache.data : null; // no token / Node <18
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', authorization: cred.value },
      signal: ctrl.signal,
    });
    if (!r.ok) return cache ? cache.data : null;
    const data = normalizeClaude(await r.json());
    if (data) {
      // Live profile first, login-time credentials file only as the fallback —
      // see getClaudeProfile.
      const profile = await getClaudeProfile(cred);
      data.plan = (profile && profile.plan) || planLabel(cred.sub);
      data.planMult = (profile && profile.planMult != null) ? profile.planMult : multFromTier(cred.tier);
      data.account = profile ? profile.account : null;
      cache = { data, at: Date.now() };
    }
    return data;
  } catch {
    return cache ? cache.data : null; // network/abort — keep the last good reading
  } finally {
    clearTimeout(timer);
  }
}

// ---- Codex ----

// Accepts both spellings: the live RPC is camelCase (usedPercent,
// windowDurationMins, resetsAt), the older rollout block was snake_case.
// One free "wipe the current window" grant — a LEVER, not a budget. Distinct
// from `credits` (a spend balance) even though both arrive under that word.
// A spent grant stays in the list with a non-'available' status and an expired
// one is dead weight, so both are filtered here rather than in the view.
function normalizeResetCredits(rc) {
  if (!rc || typeof rc !== 'object') return null;
  const list = Array.isArray(rc.credits) ? rc.credits : [];
  const usable = list.filter((c) => {
    if (!c || typeof c !== 'object') return false;
    if (c.status != null && c.status !== 'available') return false;
    const exp = parseTimestamp(c.expires_at ?? c.expiresAt);
    return !(exp && exp < Date.now());
  });
  if (!usable.length) return null;
  const count = parseNum(rc.availableCount ?? rc.available_count) ?? usable.length;
  if (!count) return null;
  const next = usable[0];
  const expiresAt = parseTimestamp(next.expires_at ?? next.expiresAt);
  return {
    count,
    id: next.id ? String(next.id) : null,
    title: next.title ? String(next.title) : 'Rate limit reset',
    description: next.description ? String(next.description) : null,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
  };
}

// The spend balance riding in the window block. An account that never bought
// credits reports "0"/false; reporting nothing there means the view has no
// zero-state to special-case.
function normalizeSpendCredits(c) {
  if (!c || typeof c !== 'object') return null;
  const unlimited = c.unlimited === true;
  const hasCredits = c.hasCredits === true || c.has_credits === true;
  const raw = c.balance ?? c.balance_amount ?? null;
  const balance = raw == null ? null : String(raw);
  const numeric = balance == null ? null : parseNum(balance);
  if (!unlimited && !hasCredits && (numeric == null || numeric === 0)) return null;
  return { unlimited, hasCredits, balance };
}

// Accepts either LAYER: the full `account/rateLimits/read` envelope
// ({ rateLimits, rateLimitsByLimitId, rateLimitResetCredits }) or a bare window
// block. Reset credits only exist on the envelope — reading `.rateLimits` and
// discarding the rest is what hid the grant entirely.
function normalizeCodex(payload) {
  if (!payload) return null;
  const rl = payload.rateLimits || payload.rate_limits || payload;
  if (!rl || typeof rl !== 'object') return null;
  const out = [];
  const win = (w, fallback) => {
    if (!w) return null;
    const percent = normalizePercent(w);
    if (percent == null) return null;
    const minutes = getWindowNumber(w);
    const reset = parseTimestamp(w.resets_at ?? w.resetsAt ?? w.reset_at ?? w.resetAt ?? w.expires_at ?? w.expiresAt);
    // a window whose reset already passed no longer applies — drop it rather
    // than show a stale reading as current.
    if (reset && reset < Date.now()) return null;
    const label = labelForWindow(minutes, fallback);
    // Key follows the WINDOW, never the primary/secondary slot it arrived in:
    // codex now ships the weekly window as `primary` with `secondary: null`.
    return { key: label, label, percent, resetsAt: reset ? new Date(reset).toISOString() : null, severity: 'normal' };
  };
  const p = win(rl.primary, '5-hour');
  const s = win(rl.secondary, 'Weekly');
  if (p) out.push(p);
  if (s && !(p && s.key === p.key)) out.push(s);
  if (!out.length) return null;
  const data = { plan: rl.plan_type || rl.planType || 'codex', limits: out };
  // Beside `limits`, never inside it: a grant is a lever you pull once, not a
  // usage window, and the SPA draws `limits` as meter rows. Putting it there
  // would render it as a fourth bar with a percentage it does not have.
  const resets = normalizeResetCredits(payload.rateLimitResetCredits || payload.rate_limit_reset_credits);
  if (resets) data.resetCredits = resets;
  const spend = normalizeSpendCredits(rl.credits);
  if (spend) data.spendCredits = spend;
  return data;
}

function labelForWindow(minutes, fallback) {
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return 'Weekly';
  if (minutes) return `${Math.round(minutes / 60)}-hour`;
  return fallback;
}

// Codex account identity from ~/.codex/auth.json — the ChatGPT account_id plus
// the email claim inside the id_token JWT payload (never the token bytes).
// Best-effort: null when signed out / API-key mode / unreadable.
function codexAccount() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'auth.json'), 'utf8'));
    const tokens = (o && o.tokens) || {};
    const id = tokens.account_id || null;
    let email = null;
    if (tokens.id_token && typeof tokens.id_token === 'string') {
      try {
        const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
        email = claims.email || null;
      } catch {}
    }
    if (!id && !email) return null;
    return { id: id || `codex:${email}`, email };
  } catch {
    return null;
  }
}

// Live account usage from the `account/rateLimits/read` app-server RPC — the
// same call the codex TUI makes. Replaces a scan of rollout files, which was
// wrong twice over: rollouts carry NO account identity, so a reading written
// under one account was labelled with whichever account is active now, and the
// freshest reading on disk can be days stale (measured: disk 88%, live 33%).
//
// Short-lived child on purpose. The hub goes through codex-runner's long-lived
// app-server, but the agent has none of its own — on the cloud path that child
// belongs to the master. Spawned, asked, killed, then cached for CACHE_MS so a
// 60s poll costs one process a minute.
//
// Params must be ABSENT, not {}: the method takes unit and a map is rejected
// with "invalid type: map, expected unit" (measured, codex-cli 0.145.0).
let codexExe = null; // injected by capabilities.js so the binary is resolved once
function setCodexExe(exe) {
  codexExe = exe || null;
}

const RPC_TIMEOUT_MS = 20_000;

// Our child must never be the one that refreshes ~/.codex/auth.json. On the
// cloud path the MASTER already owns a long-lived app-server on this box (it
// spawned it through the 'spawn' capability), and two app-servers refreshing at
// once would replay a spent refresh token — OpenAI's reuse detection then burns
// the whole family, measured (lib/codex-accounts.js note 3). Measured too: a
// rateLimits read leaves auth.json byte-identical while the access token is
// valid, and codex issues those ~10 days out. So we only ask while the token is
// comfortably live, and let the reading go stale rather than race a refresh.
const REFRESH_MARGIN_MS = 30 * 60 * 1000;

function accessTokenLiveFor() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(CODEX_HOME, 'auth.json'), 'utf8'));
    const tok = (o && o.tokens && o.tokens.access_token) || null;
    if (!tok) return null;
    const claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(claims.exp) ? claims.exp * 1000 - Date.now() : null;
  } catch {
    return null; // opaque token / unreadable — unknowable, so don't block on it
  }
}

// One app-server, one RPC, then killed. `params === undefined` sends the method
// with NO params member, which some methods require (account/rateLimits/read
// takes unit and rejects a map).
//
// Resolves { ok: true, result } or { ok: false, error }. Read callers only care
// about the result and treat every failure as "no reading"; the consume path
// must be able to tell "it said no" from "we never reached it", because one of
// those is safe to retry and the other spends a one-time grant.
function codexRpc(method, params) {
  if (!codexExe) return Promise.resolve({ ok: false, error: 'codex executable not found' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(codexExe, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(v);
    };
    const fail = (error) => finish({ ok: false, error });
    const timer = setTimeout(() => fail('codex app-server timed out'), RPC_TIMEOUT_MS);
    timer.unref();
    child.on('error', (e) => fail(e.message));
    child.on('exit', () => fail('codex app-server exited'));
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch (e) { fail(e.message); } };
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          const req = { jsonrpc: '2.0', id: 2, method };
          if (params !== undefined) req.params = params;
          send(req);
        } else if (msg.id === 2) {
          if (msg.error) return finish({ ok: false, error: msg.error.message || 'codex rejected the request' });
          finish({ ok: true, result: msg.result || null });
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'termdeck-agent', version: '1' }, capabilities: {} } });
  });
}

// The WHOLE response — { rateLimits, rateLimitsByLimitId, rateLimitResetCredits }.
// Taking only `.rateLimits` here is what hid the reset-credit grant.
async function readCodexRateLimits() {
  const r = await codexRpc('account/rateLimits/read', undefined);
  return r.ok ? r.result : null;
}

// Spend one rate-limit reset credit on THIS box's ChatGPT login. IRREVERSIBLE,
// so it runs only from an explicit user action relayed by the master, never
// from a poll. Errors are thrown, not swallowed: a failed spend must surface as
// a failure, since the caller cannot tell from a null whether it went through.
// Outcome: 'reset' | 'nothingToReset' | 'alreadyRedeemed'.
async function consumeResetCredit({ idempotencyKey, creditId = null } = {}) {
  if (!idempotencyKey) throw new Error('idempotencyKey is required');
  const params = { idempotencyKey: String(idempotencyKey) };
  if (creditId) params.creditId = String(creditId);
  const r = await codexRpc('account/rateLimitResetCredit/consume', params);
  if (!r.ok) throw new Error(r.error || 'codex rejected the request');
  invalidateCodexCache(); // the windows just moved; don't serve the 30s-stale copy
  return { outcome: (r.result && r.result.outcome) || null };
}

async function getCodexLimits() {
  if (codexCache && Date.now() - codexCache.at < CACHE_MS) return codexCache.data;
  // Signed out: the RPC would only error, so don't pay for a spawn to find out.
  const account = codexAccount();
  if (!account) return null;
  // Token about to turn over: stand down so the process that owns turns does
  // the refresh, not us. `null` means we couldn't read an expiry at all, which
  // is not evidence of a refresh — proceed rather than go permanently dark.
  const liveFor = accessTokenLiveFor();
  if (liveFor != null && liveFor < REFRESH_MARGIN_MS) return codexCache ? codexCache.data : null;
  let data;
  try {
    data = normalizeCodex(await readCodexRateLimits());
  } catch {
    return codexCache ? codexCache.data : null;
  }
  if (!data) return codexCache ? codexCache.data : null;
  // Safe to pair: the app-server read this same auth.json when it spawned a
  // moment ago, so the reading and the identity are the same account.
  data.account = account;
  codexCache = { data, at: Date.now() };
  return data;
}

// Dropped after an account switch — without it the cache serves the OLD
// account's percentages under the NEW account's name until it ages out.
function invalidateCodexCache() {
  codexCache = null;
}

// ---- Grok ----

function grokAuthEntry() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(GROK_HOME, 'auth.json'), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return Object.values(raw).find((e) => e && (e.key || e.access_token)) || null;
  } catch {
    return null;
  }
}

function grokAccount() {
  const e = grokAuthEntry();
  if (!e) return null;
  const id = e.user_id || e.principal_id || null;
  const email = typeof e.email === 'string' ? e.email : null;
  const name = [e.first_name, e.last_name].filter((s) => typeof s === 'string' && s).join(' ') || null;
  if (!id && !email) return null;
  return { id: id || `grok:${email}`, email, name };
}

function normalizeGrok(body) {
  if (!body || typeof body !== 'object') return null;
  const c = body.config;
  if (!c || typeof c !== 'object') return null;
  const out = [];
  const creditPct = parseNum(c.creditUsagePercent);
  if (creditPct != null) {
    const period = c.currentPeriod && typeof c.currentPeriod === 'object' ? c.currentPeriod : {};
    const periodType = typeof period.type === 'string' ? period.type : '';
    const label =
      periodType === 'USAGE_PERIOD_TYPE_WEEKLY'
        ? 'Weekly'
        : periodType === 'USAGE_PERIOD_TYPE_MONTHLY'
          ? 'Monthly'
          : 'Credits';
    const key = periodType === 'USAGE_PERIOD_TYPE_WEEKLY' ? 'weekly' : periodType === 'USAGE_PERIOD_TYPE_MONTHLY' ? 'monthly' : 'credits';
    const end = period.end || c.billingPeriodEnd || null;
    out.push({
      key,
      label,
      percent: Math.max(0, Math.min(100, creditPct)),
      resetsAt: typeof end === 'string' ? end : null,
      severity: 'normal',
    });
    if (Array.isArray(c.productUsage)) {
      for (const p of c.productUsage) {
        if (!p || p.product !== 'GrokBuild') continue;
        const pp = parseNum(p.usagePercent);
        if (pp == null || Math.abs(pp - creditPct) < 0.05) continue;
        out.push({
          key: 'grok-build',
          label: 'Grok Build',
          percent: Math.max(0, Math.min(100, pp)),
          resetsAt: typeof end === 'string' ? end : null,
          severity: 'normal',
        });
      }
    }
  } else {
    const used = c.used && parseNum(c.used.val);
    const limit = c.monthlyLimit && parseNum(c.monthlyLimit.val);
    if (used != null && limit != null && limit > 0) {
      out.push({
        key: 'monthly',
        label: 'Monthly',
        percent: Math.max(0, Math.min(100, (used / limit) * 100)),
        resetsAt: typeof c.billingPeriodEnd === 'string' ? c.billingPeriodEnd : null,
        severity: 'normal',
      });
    }
  }
  if (!out.length) return null;
  return { plan: creditPct != null ? 'SuperGrok' : 'grok', limits: out };
}

async function getGrokLimits() {
  if (grokCache && Date.now() - grokCache.at < CACHE_MS) return grokCache.data;
  const entry = grokAuthEntry();
  const token = entry && (entry.key || entry.access_token);
  if (!token || typeof token !== 'string') return grokCache ? grokCache.data : null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(GROK_BILLING_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) return grokCache ? grokCache.data : null;
    const data = normalizeGrok(await r.json());
    if (data) {
      data.account = grokAccount();
      grokCache = { data, at: Date.now() };
    }
    return data;
  } catch {
    return grokCache ? grokCache.data : null;
  } finally {
    clearTimeout(timer);
  }
}

async function getLimits() {
  const [claude, codex, grok] = await Promise.all([getClaudeLimits(), getCodexLimits(), getGrokLimits()]);
  return { claude, codex, grok };
}

// Called after an account switch/login (see accounts.js's setInvalidateHooks,
// wired in capabilities.js) so the next 'limits'/'models' capability reply
// reflects the new account instead of a stale cached one.
function invalidateClaudeCache() {
  cache = null;
  profileCache = null;
}

module.exports = { getLimits, normalizeClaude, planLabel, normalizeCodex, normalizeGrok, consumeResetCredit, invalidateClaudeCache, invalidateCodexCache, setCodexExe };

// ponytail self-check: node agent/limits.js — asserts the parser without network.
if (require.main === module) {
  const assert = require('assert');
  const modern = normalizeClaude({ limits: [{ kind: 'session', percent: 42, resets_at: '2026-07-04T12:00:00Z' }, { kind: 'weekly_all', group: 'weekly', percent: 71 }] });
  assert.deepStrictEqual(modern.limits.map((l) => [l.label, l.percent]), [['5-hour', 42], ['Weekly', 71]]);
  const flat = normalizeClaude({ five_hour: { utilization: 10, resets_at: 'x' }, seven_day: { utilization: 90 } });
  assert.deepStrictEqual(flat.limits.map((l) => [l.label, l.percent]), [['5-hour', 10], ['Weekly', 90]]);
  assert.strictEqual(normalizeClaude({ limits: [] }), null);

  // The KEY vocabulary, which is what public/js/limits-live.js folds a pushed
  // `rate_limit_event` onto. The modern path used to key the all-model weekly
  // 'weekly_all' while the flat path keyed the same window 'weekly'; the fold
  // looks for 'weekly', missed, and appended a phantom second "Weekly" row.
  assert.deepStrictEqual(modern.limits.map((l) => l.key), ['session', 'weekly'], 'the modern path keys the weekly the same as the flat one');
  assert.deepStrictEqual(flat.limits.map((l) => l.key), ['session', 'weekly'], 'and the flat path has not moved');

  // The real /api/oauth/usage payload, captured 2026-08-18 from a Max 20x account.
  const live3 = normalizeClaude({
    limits: [
      { kind: 'session', group: 'session', percent: 40, severity: 'normal', resets_at: '2026-08-18T14:40:00Z', scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: 89, severity: 'warning', resets_at: '2026-08-18T14:00:00Z', scope: null },
      { kind: 'weekly_scoped', group: 'weekly', percent: 52, severity: 'normal', resets_at: '2026-08-18T14:00:00Z', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
    ],
  });
  assert.deepStrictEqual(
    live3.limits.map((l) => [l.key, l.label]),
    [['session', '5-hour'], ['weekly', 'Weekly'], ['weekly_fable', 'Weekly · Fable']],
    'three windows, three distinct keys — no two rows may share one',
  );
  assert.strictEqual(new Set(live3.limits.map((l) => l.key)).size, 3);
  // Keyed by FAMILY, so a version bump in the display name does not roll the
  // window over — and so `seven_day_opus` from the CLI lands on it.
  const scoped = (display) => normalizeClaude({ limits: [{ kind: 'weekly_scoped', group: 'weekly', percent: 5, scope: { model: { display_name: display } } }] }).limits[0];
  assert.strictEqual(scoped('Claude Opus 4.6').key, 'weekly_opus');
  assert.strictEqual(scoped('Claude Opus 4.6').label, 'Weekly · Claude Opus 4.6', 'the label keeps the full name the API gave');
  assert.strictEqual(scoped('Sonnet 5').key, 'weekly_sonnet');
  assert.strictEqual(scoped('Fable').key, 'weekly_fable');
  // A scoped window naming no model keeps a key of its own: folding it into
  // 'weekly' would merge two genuinely different limits onto one row.
  const nameless = normalizeClaude({ limits: [{ kind: 'weekly_all', group: 'weekly', percent: 7 }, { kind: 'weekly_scoped', group: 'weekly', percent: 3, scope: null }] });
  assert.deepStrictEqual(nameless.limits.map((l) => l.key), ['weekly', 'weekly_scoped']);
  assert.strictEqual(planLabel('max'), 'claude_max');
  assert.strictEqual(planLabel('claude_pro'), 'claude_pro');
  assert.strictEqual(multFromTier('default_claude_max_5x'), 5);
  assert.strictEqual(multFromTier('default_claude_max_20x'), 20);
  assert.strictEqual(multFromTier(null), null);

  const codex = normalizeCodex({ plan_type: 'plus', primary: { used_percent: 12, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 }, secondary: { used_percent: 55, window_minutes: 10080, resets_at: Date.now() / 1000 + 3600 } });
  assert.deepStrictEqual(codex.limits.map((l) => [l.label, l.percent]), [['5-hour', 12], ['Weekly', 55]]);
  const codexCamel = normalizeCodex({
    primary: { usedPercent: 0.05, windowMinutes: 300, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
    secondary: { remainingPercent: 75, windowDurationMinutes: 10080, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  // 0.05 stays 0.05. This expected 5 until now — a leftover from the "0 < n <= 1
  // must be a fraction, scale it up" guess that normalizePercent dropped on both
  // sides of the fork: every source here is on a 0-100 scale, 1 is a legal value
  // on it, and scaling turned a genuine 1% into a 100% "you are out of quota" bar.
  assert.deepStrictEqual(codexCamel.limits.map((l) => [l.label, l.percent]), [['5-hour', 0.05], ['Weekly', 25]]);
  assert.strictEqual(normalizeCodex({ primary: { used_percent: 5, window_minutes: 300, resets_at: Date.now() / 1000 - 3600 } }), null); // expired window dropped
  assert.strictEqual(normalizeCodex(null), null);
  // The live `account/rateLimits/read` shape: the WEEKLY window arrives as
  // `primary` with `secondary: null`. Naming the key off the slot instead of the
  // window is what shipped a 10080-minute window labelled key '5-hour'.
  const live = normalizeCodex({
    planType: 'plus',
    primary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
    secondary: null,
  });
  assert.deepStrictEqual(live.limits.map((l) => [l.key, l.label, l.percent]), [['Weekly', 'Weekly', 34]]);
  assert.strictEqual(live.plan, 'plus');
  // Both slots carrying the same window must not render the row twice.
  const dupe = normalizeCodex({
    primary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
    secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 },
  });
  assert.strictEqual(dupe.limits.length, 1, 'a repeated window collapses');

  // The full account/rateLimits/read envelope. Reading only `.rateLimits` off it
  // is what hid the reset grant entirely, so these assert the whole shape.
  const soonSec = Math.floor(Date.now() / 1000) + 86400;
  const envelope = normalizeCodex({
    rateLimits: { planType: 'plus', primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: soonSec }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: '0' } },
    rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'RateLimitResetCredit_abc', status: 'available', title: 'Full reset', description: 'one free reset', expiresAt: soonSec }] },
  });
  assert.deepStrictEqual(envelope.limits.map((l) => l.key), ['Weekly'], 'envelope still yields windows');
  assert.strictEqual(envelope.resetCredits.count, 1);
  assert.strictEqual(envelope.resetCredits.id, 'RateLimitResetCredit_abc');
  assert.ok(!('spendCredits' in envelope), 'a $0 balance with no credits reports nothing');
  const spentGrant = normalizeCodex({ rateLimits: { primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: soonSec } }, rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'x', status: 'redeemed' }] } });
  assert.ok(!spentGrant.resetCredits, 'a redeemed grant is not offered');
  const paidCredits = normalizeCodex({ rateLimits: { primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: soonSec }, credits: { hasCredits: true, unlimited: false, balance: '12.40' } } });
  assert.deepStrictEqual(paidCredits.spendCredits, { unlimited: false, hasCredits: true, balance: '12.40' });

  const grokCredits = normalizeGrok({
    config: {
      creditUsagePercent: 15,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-07-16T00:00:00Z', end: '2026-07-23T00:00:00Z' },
      productUsage: [{ product: 'GrokBuild', usagePercent: 15 }],
    },
  });
  assert.strictEqual(grokCredits.plan, 'SuperGrok');
  assert.deepStrictEqual(grokCredits.limits.map((l) => [l.label, l.percent]), [['Weekly', 15]]);
  const grokMonthly = normalizeGrok({ config: { monthlyLimit: { val: 15000 }, used: { val: 1500 }, billingPeriodEnd: '2026-08-01T00:00:00Z' } });
  assert.strictEqual(grokMonthly.plan, 'grok');
  assert.deepStrictEqual(grokMonthly.limits.map((l) => [l.label, Math.round(l.percent)]), [['Monthly', 10]]);
  assert.strictEqual(normalizeGrok(null), null);
  console.log('ok');
}
