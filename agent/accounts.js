'use strict';

// Switch which Claude Code account (claude.ai login) this host uses for new
// turns. CLAUDE_CONFIG_DIR never changes — only .credentials.json moves — so
// session history, settings, and projects stay shared across accounts. This
// is exactly what running `claude auth logout` + `claude auth login` by hand
// gets you, just swapped instantly from a saved snapshot instead of redoing
// OAuth every time. Adding a brand-new account still goes through the CLI's
// real `claude auth login` (opens the OAuth page) since we can't fabricate a
// login — see startLogin().
//
// Shared verbatim by the hub (server.js, via this file directly) and the
// agent (agent/capabilities.js, via the agent/accounts.js stub → this file —
// see AGENT_FILES in agent/agent.js + master.js). Each side wires its own
// model/limits-cache invalidation through setInvalidateHooks() below instead
// of this module reaching into lib/models.js or agent/limits.js directly —
// neither is importable from both sides.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { resolveCli, interactiveSpawn, killTree } = require('./which');

let hooks = { invalidateModels: () => {}, invalidateClaude: () => {} };
function setInvalidateHooks(h) {
  hooks = { ...hooks, ...h };
}

// A box can have MORE THAN ONE Claude CLI, and then "which claude" stops being
// rhetorical. Measured on a customer's Windows VPS: an npm global
// (…\npm\claude.cmd) and a WinGet install (…\WinGet\Links\claude.exe), both on
// PATH. capabilities.js's resolveEngine walks PATH and found the npm .cmd — so
// that is what ran the turns and what cli-status reported. resolveCli below
// walks PATHEXT (.EXE before .CMD, deliberately: a .cmd cannot be spawned
// without a shell) and found the WinGet .exe — so THAT is what this module
// drove. Same machine, same question, two answers.
//
// It surfaced as a sign-in that hung forever with no diagnosis available: the
// binary being driven never printed its "Paste code here if prompted >" line,
// while the one the dashboard was describing (and the one the customer ran at
// their own console, which worked) did. Nothing in either payload could show
// that, because each half was internally consistent.
//
// So the agent hands us the binary it resolved (setClaudeExe, called from
// capabilities.js exactly where it already does the same for codex + limits.js
// — "so there is one answer to which codex on this box"). This default only
// applies where nobody tells us, which is the hub-less repo-run case and tests.
// resolveCli re-stats a remembered path and expires a remembered miss, so asking
// it on every read is how a CLI installed after the process started is found.
const resolvedClaudeExe = () =>
  resolveCli('claude', 'TERMDECK_CLAUDE_EXE', [path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')]);
const ownClaudeExe = () => resolvedClaudeExe() || 'claude';
let claudeExeSource = null;

// One answer to "which claude", set by whoever owns engine resolution on this
// box: a path, or a function returning one (the agent passes a function so a
// CLI installed after it started is driven here too, not only reported).
// Ignored if empty so a caller that resolved nothing cannot blank ours.
function setClaudeExe(exe) {
  if ((exe && typeof exe === 'string') || typeof exe === 'function') claudeExeSource = exe;
}
function claudeExe() {
  const set = typeof claudeExeSource === 'function' ? claudeExeSource() : claudeExeSource;
  return (set && typeof set === 'string') ? set : ownClaudeExe();
}
// Reported with the account list so a machine without Claude Code says so,
// instead of offering an Add account that can only fail with "spawn claude
// ENOENT" (a customer's Mac, 2026-10-05). Same rule as codexInstalled.
function claudeInstalled() {
  const exe = claudeExe();
  if (path.isAbsolute(exe)) {
    try { return fs.statSync(exe).isFile(); } catch { return false; }
  }
  return Boolean(resolvedClaudeExe());
}
const NOT_INSTALLED = 'Claude Code isn’t installed on this machine. Install it there (npm install -g @anthropic-ai/claude-code), then try again.';

// An npm global install ships claude.cmd, and Node won't spawn a .bat/.cmd
// without a shell (EINVAL, since the CVE-2024-27980 fix). shell:true routes it
// through cmd.exe — which joins argv UNQUOTED, so the path is pre-quoted here
// (`C:\Users\First Last\...`) and every arg below stays a literal.
// Functions, not constants: the claude binary is late-bound.
const winShim = () => process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudeExe());
const claudeCmd = () => (winShim() ? `"${claudeExe()}"` : claudeExe());
const shimOpts = () => (winShim() ? { shell: true } : {});

// ── Signing in is a CONVERSATION, and cmd.exe is not in it ───────────────────
// Everything else this module runs at the CLI is a question with an answer:
// `auth status --json`, one shot, exit code, done. A shell hop costs those
// nothing. `auth login` is the exception — we read a URL off its stdout and
// write a code back to its stdin, minutes later. On a Windows box whose CLI is
// an npm `.cmd` shim that hop swallows the conversation in both directions, so
// the spawn shape comes from which.js's interactiveSpawn (shared, because
// lib/codex-accounts.js sign-in has the identical problem and a second copy is
// how one of them would keep it).
const signInSpawn = () => interactiveSpawn(claudeExe());

// What the dashboard needs to decide whether to OFFER a remote sign-in at all.
// `remote:false` is a promise the UI keeps by saying "sign in on that machine
// once" instead of opening a modal that can only ever spin.
function signInSupport() {
  const { via, cmd, why } = signInSpawn();
  return {
    remote: via !== 'shell',
    via,
    // Which step of the fallback we landed on, when we did. Not shown to the
    // customer — the `reason` below is theirs; this one is for whoever has to
    // work out why a machine reports what it reports.
    why: why || null,
    // WHICH binary this module drives. It is not always the one cliStatus
    // reports: that one comes from capabilities.js's own resolver (.exe, then
    // .cmd, then bare) while this comes from resolveCli (PATHEXT order, then
    // ~/.local/bin, then a bare 'claude'). They disagreed on a real machine —
    // status said claude.cmd, this said "not a shim" — and an hour went into
    // inferring which was driving the sign-in. Now it says.
    exe: cmd,
    reason: via === 'shell'
      ? 'This machine’s Claude CLI is a Windows .cmd shim that can’t be driven from here — sign in once on the machine itself (run `claude`), and switching accounts from Termdeck will work after that.'
      : null,
  };
}

function credentialsPath() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(claudeDir, '.credentials.json');
}

function accountsDir() {
  const dir = path.join(os.homedir(), '.termdeck', 'accounts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function slugFor(orgId, email) {
  return String(orgId || email || 'account').replace(/[^a-z0-9-]/gi, '_');
}

// `claude auth status --json` is the CLI's own identity check — reuses the
// exact source of truth the CLI itself trusts instead of re-deriving identity
// from the OAuth profile endpoint (which agent/limits.js already does, for a
// different purpose — usage %, not switching).
function authStatus() {
  return new Promise((resolve) => {
    execFile(claudeCmd(), ['auth', 'status', '--json'], { timeout: 10_000, ...shimOpts() }, (err, stdout) => {
      if (err) return resolve({ loggedIn: false });
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ loggedIn: false });
      }
    });
  });
}

function readLiveCredentials() {
  try {
    return fs.readFileSync(credentialsPath(), 'utf8');
  } catch {
    return null;
  }
}

// The CLI keeps the ACTIVE-account identity in the big JSON config (oauthAccount),
// separate from the tokens in .credentials.json. `claude auth status` reads identity
// from HERE, so swapping only the tokens leaves it reporting the old account and the
// switch never takes — the whole point of the two-file swap below.
function configJsonPath() {
  const base = process.env.CLAUDE_CONFIG_DIR;
  if (base) {
    const inDir = path.join(base, '.claude.json');
    if (fs.existsSync(inDir)) return inDir;
  }
  return path.join(os.homedir(), '.claude.json');
}

function readOAuthAccount() {
  try {
    return JSON.parse(fs.readFileSync(configJsonPath(), 'utf8')).oauthAccount || null;
  } catch {
    return null;
  }
}

// Point the CLI's active-account identity at `oauthAccount`. Returns false if the
// config can't be read, so callers leave it untouched rather than write a stub.
function writeOAuthAccount(oauthAccount) {
  if (!oauthAccount) return false;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(configJsonPath(), 'utf8'));
  } catch {
    return false;
  }
  cfg.oauthAccount = oauthAccount;
  atomicWrite(configJsonPath(), JSON.stringify(cfg, null, 2));
  return true;
}

// The oauthAccount to write when switching TO this snapshot. Snapshots saved before
// we captured it have none, so backfill by cloning the live identity and overriding
// the account-identifying fields — enough for `claude auth status` and token auth (the
// tokens carry the real grant). The exact accountUuid self-heals the next time that
// account is active and saved (saveCurrentAccount stores the real object).
function oauthAccountFor(entry) {
  if (entry.oauthAccount) return entry.oauthAccount;
  const live = readOAuthAccount();
  if (!live) return null;
  return {
    ...live,
    emailAddress: entry.email || live.emailAddress,
    organizationUuid: entry.orgId || live.organizationUuid,
    organizationName: entry.orgName || live.organizationName,
    organizationType: entry.subscriptionType === 'max' ? 'claude_max' : live.organizationType,
  };
}

function publicEntry(entry, active) {
  return { orgId: entry.orgId, email: entry.email, orgName: entry.orgName, subscriptionType: entry.subscriptionType, savedAt: entry.savedAt, active };
}

function readSavedEntries() {
  const dir = accountsDir();
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch {}
  }
  return out;
}

// Snapshots whatever is currently logged in. Called explicitly ("save this
// login") and automatically before every switch/login (the CLI refreshes
// tokens in place, so re-snapshotting keeps a saved account from going stale).
async function saveCurrentAccount() {
  const status = await authStatus();
  if (!status.loggedIn) throw new Error('Not logged in — nothing to save');
  const raw = readLiveCredentials();
  if (!raw) throw new Error('No credentials file found for the active login');
  // authStatus() and readLiveCredentials() read the same .credentials.json at two
  // moments. A token refresh in between is harmless (same account, newer token), but
  // an account SWAP would pair THIS identity with the OTHER account's tokens — a
  // mislabeled snapshot that later makes switchAccount() a silent no-op. Re-check the
  // identity didn't change before trusting the (identity, credentials) pairing.
  const recheck = await authStatus();
  if (!recheck.loggedIn || recheck.orgId !== status.orgId) throw new Error('The active login changed while saving — try again');
  const entry = {
    orgId: status.orgId || null,
    email: status.email || null,
    orgName: status.orgName || null,
    subscriptionType: status.subscriptionType || null,
    savedAt: Date.now(),
    credentials: raw,
    oauthAccount: readOAuthAccount(), // identity half of the login — restored on switch
  };
  atomicWrite(path.join(accountsDir(), `${slugFor(entry.orgId, entry.email)}.json`), JSON.stringify(entry, null, 2));
  return publicEntry(entry, true);
}

// The snapshot of the ACTIVE account is the one that rots, and it rots silently.
//
// Anthropic ROTATES the refresh token on every refresh (probeCredentials above
// reads `body.refresh_token` for exactly that reason) and the live CLI refreshes
// on its own schedule — so the copy frozen into a snapshot is invalidated by the
// CLI's very next refresh. The account you are signed into RIGHT NOW is
// therefore the one you can least switch back to, which is the opposite of what
// anyone would guess. Measured on two independent machines: the same account's
// snapshot probed `dead` on both while its LIVE login worked fine on one of them.
//
// The live file IS the truth for the active account, so the snapshot is simply
// kept equal to it. A string compare on every call and a write only when they
// differ, which after the first sync is approximately never.
//
// `savedAt` is deliberately NOT touched: it means "when you saved this account",
// it orders the list, and a sync is not a save.
function syncActiveSnapshot(status) {
  if (!status || !status.loggedIn || !status.orgId) return false;
  const entry = readSavedEntries().find((e) => e.orgId === status.orgId);
  if (!entry) return false; // not saved — nothing to keep fresh, and not our call to create one
  const raw = readLiveCredentials();
  if (!raw || entry.credentials === raw) return false;
  // Same pairing hazard saveCurrentAccount guards: identity and tokens are two
  // files read at two moments, and a swap in between would staple this identity
  // to the other account's tokens. Re-read the identity and bail if it moved.
  const who = readOAuthAccount();
  if (who && who.organizationUuid && who.organizationUuid !== status.orgId) return false;
  entry.credentials = raw;
  if (who) entry.oauthAccount = who;
  atomicWrite(path.join(accountsDir(), `${slugFor(entry.orgId, entry.email)}.json`), JSON.stringify(entry, null, 2));
  return true;
}

// Snapshot whatever is signed in, WITHOUT spawning the CLI — for the paths that
// cannot await one. Identity comes from the config's oauthAccount rather than
// `claude auth status`, which is the same object that file would have given us.
// Creates the entry when the account has never been saved; otherwise refreshes
// the one that exists, keeping its savedAt and anything it knows that the config
// does not.
function snapshotLiveLogin() {
  const raw = readLiveCredentials();
  const who = readOAuthAccount();
  if (!raw || !who || !who.organizationUuid) return false;
  const existing = readSavedEntries().find((e) => e.orgId === who.organizationUuid);
  let subscriptionType = (existing && existing.subscriptionType) || null;
  try {
    subscriptionType = (JSON.parse(raw).claudeAiOauth || {}).subscriptionType || subscriptionType;
  } catch {
    /* keep whatever the existing entry knew */
  }
  const entry = {
    orgId: who.organizationUuid,
    email: who.emailAddress || (existing && existing.email) || null,
    orgName: who.organizationName || (existing && existing.orgName) || null,
    subscriptionType,
    savedAt: existing ? existing.savedAt : Date.now(),
    credentials: raw,
    oauthAccount: who,
  };
  if (readLiveCredentials() !== raw) return false; // the login moved under us — write nothing
  atomicWrite(path.join(accountsDir(), `${slugFor(entry.orgId, entry.email)}.json`), JSON.stringify(entry, null, 2));
  return true;
}

async function listAccounts() {
  const status = await authStatus();
  // The heartbeat for the sync above: opening the accounts UI is the one moment
  // we are certain to be running, and it already paid for the authStatus call.
  try {
    syncActiveSnapshot(status);
  } catch {
    /* a snapshot we could not refresh is still the snapshot we had */
  }
  const accounts = readSavedEntries()
    .map((entry) => publicEntry(entry, Boolean(status.loggedIn && entry.orgId && entry.orgId === status.orgId)))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const active = status.loggedIn
    ? { orgId: status.orgId || null, email: status.email || null, orgName: status.orgName || null, subscriptionType: status.subscriptionType || null, saved: accounts.some((a) => a.active) }
    : null;
  return { accounts, active, available: claudeInstalled() };
}

// Pure: did the live login end up on the account we asked for? A stale or
// mislabeled snapshot can hold another account's tokens, so authStatus reports a
// different orgId (or none) — that must count as a failed switch, not a success.
// Exported for the self-check at the bottom of this file.
function switchTookEffect(status, orgId) {
  return !!(status && status.loggedIn && status.orgId === orgId);
}

// Pure: can this saved login still produce a working session? Once the refresh
// token has expired the CLI can't mint a new access token, so `claude -p` dies with
// "OAuth session expired and could not be refreshed" — but `claude auth status`
// still reports loggedIn:true (it reads identity from the local config, never the
// token), so switchTookEffect alone can't catch it. The snapshot records
// refreshTokenExpiresAt, so we detect the dead login offline BEFORE touching the
// live one. A missing/unparseable timestamp counts as usable — we only refuse when
// we can PROVE it's dead. ponytail: catches expired refresh tokens, not server-side
// *revoked* ones (needs a network call the shared thin agent can't cheaply make);
// the post-swap authStatus check and the runner's own auth error still backstop that
// rarer case.
function credentialsUsable(rawCredentials, now = Date.now()) {
  try {
    const exp = JSON.parse(rawCredentials).claudeAiOauth?.refreshTokenExpiresAt;
    return !(typeof exp === 'number' && exp <= now);
  } catch {
    return true;
  }
}

// Claude Code's own public OAuth client + token endpoint (same pair the CLI uses
// for its silent refresh). Verified against the live endpoint: a bogus refresh
// token comes back 400 {"error":"invalid_grant"}, so a revoked login is
// distinguishable from a network/endpoint problem.
const OAUTH_TOKEN_URL = 'https://claude.ai/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// The only check that catches a login revoked or signed out SERVER-side: mint a
// fresh access token from the snapshot's refresh token. Offline checks can't see
// that, `claude auth status` can't either (it reads local config), so without this
// a dead account overwrites the working one and every turn after it fails.
//
// On success we hand back the refreshed credentials and the caller MUST persist
// them: the server may rotate the refresh token, so throwing the response away
// would kill the very snapshot we were validating.
//
// Three-state on purpose. Only a clean `invalid_grant` counts as dead; a network
// error, a 5xx, or any unexpected shape is 'unknown' and never blocks a switch —
// a check that can't reach the internet must not lock you out of your own box.
async function probeCredentials(rawCredentials) {
  let obj;
  try {
    obj = JSON.parse(rawCredentials);
  } catch {
    return { state: 'unknown', detail: 'saved login is not readable' };
  }
  const oauth = obj.claudeAiOauth || {};
  if (!oauth.refreshToken) return { state: 'unknown', detail: 'saved login has no refresh token to check' };
  let res, body;
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: OAUTH_CLIENT_ID }),
      signal: AbortSignal.timeout(15_000),
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    return { state: 'unknown', detail: `could not reach Anthropic (${err.message})` };
  }
  if (res.ok && body.access_token) {
    obj.claudeAiOauth = {
      ...oauth,
      accessToken: body.access_token,
      refreshToken: body.refresh_token || oauth.refreshToken,
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    };
    return { state: 'ok', detail: 'token accepted by Anthropic', credentials: JSON.stringify(obj, null, 2) };
  }
  if (body && body.error === 'invalid_grant') return { state: 'dead', detail: 'Anthropic rejected this login — it was signed out or revoked' };
  return { state: 'unknown', detail: `Anthropic replied ${res.status}${body && body.error ? ` (${body.error})` : ''}` };
}

// A bearer token for ONE saved account, without switching to it.
//
// This is what makes per-account usage meters possible: the rate-limit endpoint
// takes a bearer and answers for whoever that bearer is, so a snapshot can speak
// for its own account while another account stays signed in. Nothing here touches
// the live login, and a caller must not use the token for anything but reading.
//
// Three-state for the same reason preflightSwitch is: only a clean invalid_grant
// is 'dead'. A network blip must read as 'unknown', because rendering "signed out"
// at someone whose wifi dropped is worse than rendering nothing.
//
// *** The rotated refresh token is written back BEFORE this returns. *** Anthropic
// rotates on every refresh, so a probe whose response we drop invalidates the very
// snapshot we were reading. Same rule, same reason, same atomicWrite as
// preflightSwitch. See probeCredentials's header.
//
// The 60s skew on the expiry is deliberate: a token with 3 seconds left passes a
// naive `expiresAt > now` and then 401s in the caller's hand.
const TOKEN_SKEW_MS = 60 * 1000;

async function accessTokenFor(orgId) {
  const entry = readSavedEntries().find((e) => e.orgId === orgId);
  if (!entry) return { state: 'unknown', detail: 'No saved login for that account on this machine.' };
  if (!credentialsUsable(entry.credentials)) return { state: 'dead', detail: 'This saved login expired.' };

  let oauth = null;
  try {
    oauth = JSON.parse(entry.credentials).claudeAiOauth || null;
  } catch {}
  if (!oauth || !oauth.refreshToken) return { state: 'unknown', detail: 'The saved login is missing its tokens.' };

  // Still good: no network, no rotation, no write. The common case on a panel
  // reopened within the hour.
  if (oauth.accessToken && Number(oauth.expiresAt) > Date.now() + TOKEN_SKEW_MS) {
    return { state: 'ok', token: `Bearer ${oauth.accessToken}` };
  }

  const probe = await probeCredentials(entry.credentials);
  if (probe.state === 'dead') return { state: 'dead', detail: probe.detail };
  if (probe.state !== 'ok' || !probe.credentials) return { state: 'unknown', detail: probe.detail };

  entry.credentials = probe.credentials;
  atomicWrite(path.join(accountsDir(), `${slugFor(entry.orgId, entry.email)}.json`), JSON.stringify(entry, null, 2));

  let refreshed = null;
  try {
    refreshed = JSON.parse(probe.credentials).claudeAiOauth || null;
  } catch {}
  if (!refreshed || !refreshed.accessToken) return { state: 'unknown', detail: 'The refreshed login had no access token.' };
  return { state: 'ok', token: `Bearer ${refreshed.accessToken}` };
}

// The saved accounts, identity only, WITHOUT spawning the CLI. listAccounts()
// answers the same question but pays for `claude auth status` to decide which one
// is active; a usage sweep already knows that from the list call the panel made.
function savedAccounts() {
  return readSavedEntries().map((e) => ({ orgId: e.orgId, email: e.email }));
}

// Claude sessions MID-TURN on this box right now — the pid registry, same
// liveness rule as lib/claude-data.js (a pid that answers signal 0), narrowed to
// the ones actually working. Swapping credentials under a running turn can break
// it mid-reply, so the switch says so out loud instead of yanking the tokens.
// An open-but-idle terminal is not a reason to warn; anything that isn't
// explicitly idle is (SDK-spawned entries carry no status field at all).
// Inlined rather than imported because this module ships standalone to agent
// boxes (agent/accounts.js) where lib/claude-data.js doesn't exist.
function busySessionCount() {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      let entry;
      try {
        entry = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        continue;
      }
      if (!entry.pid || entry.status === 'idle') continue;
      try {
        process.kill(entry.pid, 0);
        n++;
      } catch {}
    }
  } catch {}
  return n;
}

const check = (id, label, status, detail) => ({ id, label, status, detail });

// "6 Aug 2026". This runs on the USER'S MACHINE and the string it returns is
// rendered in a browser somewhere else, so the machine's locale must not get a
// vote: a headless agent under LANG=C would hand the UI "8/6/2026", which half
// the world reads as the 8th of June. An explicit locale and a spelled-out
// month make the same characters mean the same date to everybody. Day
// granularity only — a token expiry months out has no interesting hour, so
// there is no timezone to get wrong either.
const expiryDate = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? 'an unreadable date'
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

// Everything we can learn about a switch BEFORE touching the live login, as an
// ordered list the UI renders step by step. `fail` blocks the switch, `warn` is
// advisory (the caller decides), `ok` is clear. Also self-heals the snapshot: a
// successful probe writes the refreshed tokens back, so the switch lands on a
// token that's good for hours instead of one the CLI has to refresh itself.
async function preflightSwitch(orgId) {
  const checks = [];
  const target = readSavedEntries().find((e) => e.orgId === orgId);
  if (!target) return { ok: false, checks: [check('snapshot', 'Find the saved login', 'fail', 'No saved login for that account on this machine.')] };

  let oauth = null;
  try {
    oauth = JSON.parse(target.credentials).claudeAiOauth || null;
  } catch {}
  if (!oauth || !oauth.accessToken || !oauth.refreshToken) {
    checks.push(check('snapshot', 'Read the saved login', 'fail', 'The saved login is corrupt or missing its tokens. Remove it and add the account again.'));
    return { ok: false, checks };
  }
  checks.push(check('snapshot', 'Read the saved login', 'ok', target.email || target.orgName || orgId));

  if (!credentialsUsable(target.credentials)) {
    checks.push(check('expiry', 'Check the login has not expired', 'fail', 'This saved login expired. Remove it and sign in to that account again.'));
    return { ok: false, checks };
  }
  checks.push(check('expiry', 'Check the login has not expired', 'ok', oauth.refreshTokenExpiresAt ? `valid until ${expiryDate(oauth.refreshTokenExpiresAt)}` : 'no expiry recorded'));

  const probe = await probeCredentials(target.credentials);
  if (probe.state === 'dead') {
    checks.push(check('oauth', 'Verify the login with Anthropic', 'fail', `${probe.detail}. Remove it and sign in to that account again.`));
    return { ok: false, checks };
  }
  if (probe.state === 'ok' && probe.credentials) {
    // Persist first: the server may have rotated the refresh token, and dropping
    // the new one here would strand the account we just proved was fine.
    target.credentials = probe.credentials;
    atomicWrite(path.join(accountsDir(), `${slugFor(target.orgId, target.email)}.json`), JSON.stringify(target, null, 2));
  }
  checks.push(check('oauth', 'Verify the login with Anthropic', probe.state === 'ok' ? 'ok' : 'warn', probe.detail));

  const busy = busySessionCount();
  checks.push(
    busy
      ? check('busy', 'Check no chat is mid-reply', 'warn', `${busy} Claude session${busy === 1 ? ' is' : 's are'} generating on this machine. Switching now can break a reply in progress.`)
      : check('busy', 'Check no chat is mid-reply', 'ok', 'nothing is generating right now')
  );

  return { ok: true, checks };
}

async function switchAccount(orgId) {
  // Full preflight first — a dead, corrupt, or revoked snapshot must never
  // overwrite the working login. Everything below only runs once it passes.
  const pre = await preflightSwitch(orgId);
  if (!pre.ok) {
    const failed = pre.checks.find((c) => c.status === 'fail');
    const err = new Error(failed ? failed.detail : 'Pre-switch checks failed');
    err.checks = pre.checks;
    throw err;
  }
  // Re-read: preflight may have written refreshed tokens into the snapshot.
  const target = readSavedEntries().find((e) => e.orgId === orgId);
  if (!target) throw new Error('Saved account not found');
  const prevCred = readLiveCredentials(); // roll back to these if the switch doesn't take
  const prevOAuth = readOAuthAccount();
  try {
    await saveCurrentAccount(); // best-effort: don't lose a refreshed token on the outgoing account
  } catch {}
  // Put the machine back on whatever was live before the swap. Both failure
  // paths need this: a write that throws partway, and a swap that wrote cleanly
  // but didn't take effect.
  const rollback = () => {
    try {
      if (prevCred != null) atomicWrite(credentialsPath(), prevCred);
      if (prevOAuth) writeOAuthAccount(prevOAuth);
      hooks.invalidateModels();
      hooks.invalidateClaude();
    } catch {
      // Nothing further to try — the error thrown by the caller says the
      // previous account may need re-adding.
    }
  };

  // A login is TWO files: the tokens (.credentials.json) and the identity (oauthAccount
  // in the CLI config). Swap both — writing only the tokens leaves `claude auth status`
  // on the old account, which is why switching used to silently no-op.
  //
  // Guarded, because these are two separate writes: if the second throws (disk
  // full, permissions) the tokens are already swapped and the identity is not,
  // which is precisely the mismatched state the verification below exists to
  // prevent — and an exception skips that verification entirely, so the machine
  // was left half-switched with no way back.
  try {
    atomicWrite(credentialsPath(), target.credentials);
    writeOAuthAccount(oauthAccountFor(target));
  } catch (writeErr) {
    rollback();
    const err = new Error(`Could not write the login files (${writeErr && writeErr.message}) — the machine is still on the previous account.`);
    err.checks = [...pre.checks, check('activate', 'Switch and confirm', 'fail', err.message)];
    throw err;
  }
  hooks.invalidateModels();
  hooks.invalidateClaude();
  // Verify the switch actually landed on `orgId`. Without this a stale/mislabeled
  // snapshot would overwrite the live login, report ok, and leave the box on the
  // previous account. On mismatch, restore BOTH files so we never strand a broken login.
  const status = await authStatus();
  if (!switchTookEffect(status, orgId)) {
    rollback();
    const err = new Error('That saved login didn’t activate — remove it and add the account again.');
    err.checks = [...pre.checks, check('activate', 'Switch and confirm', 'fail', err.message)];
    throw err;
  }
  return { ...(await listAccounts()), checks: [...pre.checks, check('activate', 'Switch and confirm', 'ok', 'the machine is now on this account')] };
}

function removeAccount(orgId) {
  const dir = accountsDir();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const full = path.join(dir, f);
    try {
      if (JSON.parse(fs.readFileSync(full, 'utf8')).orgId === orgId) {
        fs.unlinkSync(full);
        return true;
      }
    } catch {}
  }
  return false;
}

// Drives `claude auth login` and blocks until the OAuth callback lands. We
// capture the URL it prints via loginStatus() while the frontend polls, and the
// browser you sign in with is YOUR browser — the one the dashboard is open in.
//
// The CLI would otherwise pop a tab on whichever machine this runs on, which for
// a remote-control product is always the wrong screen: nobody is sitting at the
// agent box, and a customer signing in from their phone got a tab opened on a PC
// somewhere else. The CLI picks its opener as `settings.browser ?? $BROWSER ??
// <platform default>` (verified in the 2.1.220 binary), so naming an opener that
// cannot exist takes the choice away on every platform at once — the spawn fails
// with ENOENT and the CLI falls through to its own "Browser didn't open? Use the
// url below to sign in" path, which is exactly the flow we want. Child env only:
// nothing here touches the user's settings or their terminal.
const NO_BROWSER = { BROWSER: 'termdeck-no-browser' };
// Non-blocking: the frontend polls loginStatus() rather than holding a POST
// open for however long OAuth takes (a cloudflared-fronted deploy would time
// that request out well before a person finishes signing in).
// Terminal control bytes wrap the URL as an OSC-8 hyperlink; stop at the first
// one instead of swallowing the escape sequence into the "url".
function stripAnsi(s) {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// "Is the CLI ready for a code?" — and the honest answer is that HAVING THE URL
// already settles it. The CLI emits the link and the prompt in one write:
//
//   Opening browser to sign in…
//   If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…
//   Paste code here if prompted >
//
// so there is no window in which one arrived and the other is still coming. This
// was a phrase match alone, against the RAW accumulated buffer (unlike the
// rejection match one screen down, which strips first), and on a customer's
// Windows box it never fired: the URL made it up to the dashboard and the flag
// stayed false, which left the modal spinning on "Waiting for the machine to open
// the sign-in prompt…" beside a link that was ready to use. That trailing prompt
// carries no newline, so a pipe is within its rights to hold it — which makes the
// phrase a nice confirmation and a terrible gate.
//
// Kept as a named predicate so the self-check below can pin it without a CLI.
const PASTE_PROMPT = /paste\s+(?:the\s+)?code/i;
function awaitingCodeNow(out, hasUrl) {
  return Boolean(hasUrl) || PASTE_PROMPT.test(stripAnsi(String(out == null ? '' : out)));
}

// The CLI answers a wrong code by printing one line and going back to waiting —
// it does NOT exit, and it does NOT re-print its prompt. So a rejected paste is
// invisible unless we read it off the stream: the browser sat on "Signing in…"
// forever while the CLI was, in fact, still asking. Matched on the stripped
// chunk rather than the accumulated buffer, or the first rejection would stick
// for the rest of the flow.
const CODE_REJECTED = /(invalid code[^\n]*|code (?:has )?expired[^\n]*|too many attempts[^\n]*)/i;

// What the CLI says when a code does not work, which is `Login failed: Request
// failed with status code 400` — none of the wordings above. The whole output is
// the fallback, but it opens with the authorize URL, so a rejected paste used to
// reach the customer as 500 characters of query string with the one useful
// sentence at the end of it. Prefer the sentence.
const LOGIN_FAILED = /^.*login failed[^\n]*/im;
function loginFailureFrom(out) {
  const text = stripAnsi(String(out == null ? '' : out)).trim();
  const named = text.match(LOGIN_FAILED);
  return (named ? named[0].trim() : text.slice(-500)).trim();
}

// A person signing in on ANOTHER device — open the link on a phone, sign in,
// approve, copy the code back — routinely needs longer than the 3 minutes this
// used to allow, and when the timer fired the CLI died mid-flow: the code field
// disappeared out from under the paste, and a code submitted a second later
// answered "No login in progress". That is the whole of "I can't paste the
// code". Codex's twin already sits at 16 minutes for exactly this reason (see
// lib/codex-accounts.js). It is an IDLE timeout, not a total one — typing the
// code is a second act, so submitting one rearms the clock instead of racing
// what is left of it.
const LOGIN_IDLE_MS = 15 * 60 * 1000;

let loginChild = null;
let loginUrl = null;
let loginAwaitingCode = false;
let loginCodeError = null; // the CLI's own words for the last rejected code; cleared on the next submit
let loginExpiresAt = 0;
let loginRearm = null; // () => void — pushes the idle timer out; null between logins
let loginCancelled = false;
let loginResult = null; // { ok, account } | { ok: false, error, cancelled? } once settled; cleared on next startLogin
let loginVia = null; // which route startLogin took ('direct' | 'node' | 'shell'), for the status payload
let loginOut = ''; // the child's own output, ANSI-stripped and kept to the last LOGIN_TAIL bytes
const LOGIN_TAIL = 2000;

function loginStatus() {
  return {
    inProgress: Boolean(loginChild),
    url: loginUrl,
    awaitingCode: loginAwaitingCode,
    codeError: loginCodeError,
    expiresAt: loginChild ? loginExpiresAt : 0,
    result: loginResult,
    // How this login is being driven. A 'shell' login is the one that can hang
    // with nothing to show for it, so the dialog is told rather than left to
    // infer it from silence.
    via: loginVia,
    // The CLI's own last words, bounded and ANSI-stripped. A sign-in that goes
    // wrong on someone else's machine is otherwise diagnosed by guessing: every
    // field above is DERIVED from this text by a regex, so when one of those
    // regexes is the thing that is wrong, the payload agrees with itself and
    // says nothing. It is the CLI's stdout about the owner's own machine, shown
    // only to that owner (every accounts route is owner-scoped) — the same
    // bargain as agent/log.js, which exists to be handed to us.
    tail: loginOut ? loginOut.slice(-LOGIN_TAIL) : null,
  };
}

// What lands in the field is whatever the sign-in page put on the clipboard,
// and that is not always the bare code: a wrapped copy carries newlines, a
// double-click on the callback page can take the surrounding quotes, and people
// paste the whole callback URL (whose code is split across `code` and `state`,
// which the CLI wants rejoined with `#` — the exact shape the page displays).
// The code itself is base64url + `#` + state, so it can never legitimately
// contain whitespace and stripping it is safe rather than lossy.
function normalizeLoginCode(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (s.length > 4096) throw new Error('That does not look like a sign-in code');
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const code = u.searchParams.get('code');
      if (code) {
        const st = u.searchParams.get('state');
        s = st ? `${code}#${st}` : code;
      }
    } catch {
      /* not a URL after all — fall through and treat it as a code */
    }
  }
  s = s.replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '');
  if (!s) throw new Error('Paste the code from the sign-in page first');
  return s;
}

function startLogin({ email } = {}) {
  if (loginChild) throw new Error('A login is already in progress');
  if (!claudeInstalled()) throw Object.assign(new Error(NOT_INSTALLED), { code: 'NOT_INSTALLED' });
  const args = ['auth', 'login'];
  // The one arg here that isn't a literal, and on a Windows shim it reaches
  // cmd.exe's parser — so it has to look like an email before it goes anywhere.
  if (email && !/^[^\s@"'`&|<>^%()]+@[^\s@"'`&|<>^%()]+$/.test(email)) throw new Error('Invalid email');
  if (email) args.push('--email', email);
  // Snapshot the OUTGOING login before the CLI overwrites it. A successful
  // `claude auth login` replaces .credentials.json outright, so without this the
  // account that was signed in is only recoverable from a snapshot taken at some
  // earlier point — which, per syncActiveSnapshot's note, the CLI's own token
  // rotation has very likely already killed. That is exactly how a machine ends
  // up with a saved account it cannot switch back to. switchAccount has done
  // this for its outgoing account all along; this path had not.
  try {
    snapshotLiveLogin();
  } catch {
    /* nothing signed in, or unwritable — never block a sign-in over it */
  }
  loginUrl = null;
  loginAwaitingCode = false;
  loginCodeError = null;
  loginCancelled = false;
  loginResult = null;
  // The one spawn in this file that must reach the CLI directly — see signInSpawn.
  let route = signInSpawn();
  let child = spawn(route.cmd, [...route.prefix, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...NO_BROWSER }, ...route.opts });
  loginVia = route.via;
  loginChild = child;
  let out = '';
  loginOut = '';
  const onData = (chunk) => {
    out += chunk;
    // Bounded as it arrives, not on read: a CLI that decides to redraw a spinner
    // for fifteen minutes must not be able to grow this without limit.
    loginOut = (loginOut + stripAnsi(String(chunk))).slice(-LOGIN_TAIL);
    if (!loginUrl) {
      const m = out.match(/https?:\/\/[^\s\x00-\x1f]+/);
      if (m) loginUrl = m[0];
    }
    if (!loginAwaitingCode && awaitingCodeNow(out, loginUrl)) loginAwaitingCode = true;
    const rejected = stripAnsi(String(chunk)).match(CODE_REJECTED);
    if (rejected) loginCodeError = rejected[1].trim();
  };
  let timer = null;
  const rearm = () => {
    clearTimeout(timer);
    loginExpiresAt = Date.now() + LOGIN_IDLE_MS;
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
    }, LOGIN_IDLE_MS);
  };
  rearm();
  loginRearm = rearm;
  const settle = (result) => {
    clearTimeout(timer);
    loginChild = null;
    loginAwaitingCode = false;
    loginRearm = null;
    loginExpiresAt = 0;
    loginResult = result;
  };
  // A route we CHOSE can be wrong about this box — the shim bypass names a
  // binary out of a batch file, and a machine is allowed to disagree. When that
  // spawn never starts, the sign-in has not failed; our shortcut has. So we fall
  // back ONCE to the shell route, which is exactly what this code did before the
  // bypass existed. This is also why nothing pre-checks the target with
  // existsSync any more: the spawn is the only test that asks the real question,
  // and it is now allowed to answer.
  let retried = false;
  const wire = (c) => {
    c.stdout.on('data', onData);
    c.stderr.on('data', onData);
    c.on('exit', async (code) => {
      if (c !== child) return; // a superseded child's exit is not this login's
      if (loginCancelled) return settle({ ok: false, cancelled: true });
      if (code !== 0) return settle({ ok: false, error: loginFailureFrom(out) || `login exited with code ${code}` });
      try {
        const account = await saveCurrentAccount();
        hooks.invalidateModels();
        hooks.invalidateClaude();
        settle({ ok: true, account });
      } catch (err) {
        settle({ ok: false, error: err.message });
      }
    });
    c.on('error', (err) => {
      if (c !== child) return;
      if (!retried && route.via !== 'shell' && winShim()) {
        retried = true;
        loginVia = 'shell';
        try {
          child = spawn(claudeCmd(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...NO_BROWSER }, ...shimOpts() });
        } catch (e) {
          return settle({ ok: false, error: e.message });
        }
        route = { via: 'shell', why: `${route.via} spawn failed: ${err.code || err.message}` };
        loginChild = child;
        wire(child);
        return;
      }
      settle({ ok: false, error: err && err.code === 'ENOENT' ? NOT_INSTALLED : err.message });
    });
  };
  wire(child);
}

// Forwards the code pasted from the OAuth callback page to the waiting CLI
// prompt — the CLI has no local listener to catch that redirect itself.
function submitLoginCode(code) {
  if (!loginChild) throw new Error('That sign-in expired — start a new one');
  const clean = normalizeLoginCode(code); // throws BEFORE the clock is rearmed
  loginCodeError = null;
  if (loginRearm) loginRearm();
  loginChild.stdin.write(`${clean}\n`);
  return { submitted: true };
}

function cancelLogin() {
  if (!loginChild) return false;
  loginCancelled = true;
  // killTree, not kill(): on the shell fallback route the child IS cmd.exe with
  // the real CLI underneath, and killing the parent leaves an orphaned
  // `auth login` holding the sign-in the person just cancelled.
  killTree(loginChild);
  return true;
}

module.exports = {
  setInvalidateHooks,
  authStatus,
  listAccounts,
  saveCurrentAccount,
  switchAccount,
  preflightSwitch,
  accessTokenFor,
  savedAccounts,
  switchTookEffect,
  credentialsUsable,
  removeAccount,
  startLogin,
  syncActiveSnapshot,
  snapshotLiveLogin,
  submitLoginCode,
  cancelLogin,
  loginStatus,
  signInSupport,
  setClaudeExe,
};

// ponytail self-check: node lib/accounts.js — pins the switch-verification predicate
// (the bug this fixes) without touching the CLI or filesystem.
if (require.main === module) {
  const assert = require('assert');
  assert.strictEqual(switchTookEffect({ loggedIn: true, orgId: 'A' }, 'A'), true, 'matching account = switched');
  assert.strictEqual(switchTookEffect({ loggedIn: true, orgId: 'B' }, 'A'), false, 'wrong account (mislabeled snapshot) = not switched');
  assert.strictEqual(switchTookEffect({ loggedIn: false }, 'A'), false, 'logged out = not switched');
  assert.strictEqual(switchTookEffect(null, 'A'), false, 'no status = not switched');
  const cred = (exp) => JSON.stringify({ claudeAiOauth: exp === undefined ? {} : { refreshTokenExpiresAt: exp } });
  const now = Date.now();
  assert.strictEqual(credentialsUsable(cred(now + 60_000), now), true, 'live refresh token = usable');
  assert.strictEqual(credentialsUsable(cred(now - 60_000), now), false, 'expired refresh token = unusable');
  assert.strictEqual(credentialsUsable(cred(undefined), now), true, 'no expiry field = usable (cannot prove dead)');
  assert.strictEqual(credentialsUsable('not json', now), true, 'unparseable = usable (do not block on a guess)');

  // awaitingCodeNow: the URL settles it, the phrase only confirms. The false
  // case here is the bug — a Windows box whose prompt line never came through
  // left the modal spinning on "Waiting for the machine…" next to a live link.
  const REAL = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true\nPaste code here if prompted > ';
  assert.strictEqual(awaitingCodeNow(REAL, 'https://claude.com/x'), true, 'the CLI\'s real output = ready');
  assert.strictEqual(awaitingCodeNow('', 'https://claude.com/x'), true, 'a URL alone is enough — the phrase may never arrive');
  assert.strictEqual(awaitingCodeNow(REAL, null), true, 'the phrase alone is enough — an old agent may have no URL yet');
  assert.strictEqual(awaitingCodeNow('Opening browser to sign in…', null), false, 'neither = not ready');
  assert.strictEqual(awaitingCodeNow('', null), false, 'nothing at all = not ready');
  assert.strictEqual(awaitingCodeNow('\x1b[1mPaste code\x1b[0m here if prompted > ', null), true, 'styled prompt still counts — match on the stripped text');
  assert.strictEqual(awaitingCodeNow('Paste the code here', null), true, 'the other wording the CLI could reasonably use');
  assert.strictEqual(awaitingCodeNow(null, null), false, 'no output yet must not throw');

  // setClaudeExe: whoever owns engine resolution on the box gets the last word,
  // because two resolvers picking two different installs is the bug this exists
  // for. An empty answer must NOT blank a good one.
  const beforeSet = signInSupport().exe;
  setClaudeExe('');
  assert.strictEqual(signInSupport().exe, beforeSet, 'an empty path is not an answer');
  setClaudeExe(null);
  assert.strictEqual(signInSupport().exe, beforeSet, 'and neither is null');
  setClaudeExe(path.join('C', 'somewhere', 'claude'));
  assert.strictEqual(signInSupport().exe, path.join('C', 'somewhere', 'claude'), 'a real path wins');
  setClaudeExe(beforeSet); // leave the module as we found it

  // signInSupport on this box (POSIX in CI): not a shim, so a remote sign-in is
  // offered and no reason is invented for it.
  const support = signInSupport();
  assert.strictEqual(typeof support.remote, 'boolean', 'the UI gates on this, so it is always a boolean');
  if (process.platform !== 'win32') {
    assert.strictEqual(support.remote, true, 'no .cmd shim off Windows — never block the sign-in here');
    assert.strictEqual(support.via, 'direct');
    assert.strictEqual(support.reason, null, 'a reason with nothing wrong is a scare');
  }

  // probeCredentials: the three states, with fetch stubbed so this stays offline.
  const realFetch = global.fetch;
  const stub = (impl) => { global.fetch = impl; };
  const live = JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r', scopes: ['user:inference'] } });
  (async () => {
    stub(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'new', refresh_token: 'r2', expires_in: 3600 }) }));
    const good = await probeCredentials(live);
    assert.strictEqual(good.state, 'ok', 'accepted refresh = ok');
    const rolled = JSON.parse(good.credentials).claudeAiOauth;
    assert.strictEqual(rolled.accessToken, 'new', 'refreshed access token is kept');
    assert.strictEqual(rolled.refreshToken, 'r2', 'rotated refresh token is kept — dropping it would kill the account');
    assert.deepStrictEqual(rolled.scopes, ['user:inference'], 'untouched fields survive the merge');

    stub(async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }));
    assert.strictEqual((await probeCredentials(live)).state, 'dead', 'invalid_grant = revoked login');

    stub(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    assert.strictEqual((await probeCredentials(live)).state, 'unknown', '5xx = unknown, must not block a switch');

    stub(async () => { throw new Error('offline'); });
    assert.strictEqual((await probeCredentials(live)).state, 'unknown', 'network error = unknown, must not block a switch');
    assert.strictEqual((await probeCredentials('not json')).state, 'unknown', 'unparseable snapshot = unknown');

    global.fetch = realFetch;

    // busySessionCount: an idle terminal must not warn; a mid-turn one must.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'td-accounts-'));
    fs.mkdirSync(path.join(tmp, 'sessions'));
    const seed = (name, obj) => fs.writeFileSync(path.join(tmp, 'sessions', name), JSON.stringify(obj));
    seed('idle.json', { pid: process.pid, status: 'idle' });
    seed('dead.json', { pid: 0x7ffffffe, status: 'busy' }); // a pid that no longer exists
    seed('junk.json', 'not json');
    const prevDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmp;
    assert.strictEqual(busySessionCount(), 0, 'idle + dead + junk = nothing generating');
    seed('busy.json', { pid: process.pid, status: 'busy' });
    seed('sdk.json', { pid: process.pid }); // SDK entries carry no status — count them
    assert.strictEqual(busySessionCount(), 2, 'a live busy session and a live SDK session both count');
    if (prevDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevDir;
    fs.rmSync(tmp, { recursive: true, force: true });

    const missing = await preflightSwitch('no-such-org');
    assert.strictEqual(missing.ok, false, 'unknown account fails preflight');
    assert.strictEqual(missing.checks[0].status, 'fail', 'and says which step failed');

    // normalizeLoginCode: everything that actually lands in the paste field.
    const N = normalizeLoginCode;
    assert.strictEqual(N('  abc#def  '), 'abc#def', 'surrounding whitespace is trimmed');
    assert.strictEqual(N('abc\n#def'), 'abc#def', 'a wrapped copy is rejoined — the code never contains whitespace');
    assert.strictEqual(N('"abc#def"'), 'abc#def', 'quotes taken by a double-click are dropped');
    assert.strictEqual(
      N('https://platform.claude.com/oauth/code/callback?code=AAA&state=BBB'),
      'AAA#BBB',
      'the whole callback URL resolves to the code the page displays'
    );
    assert.strictEqual(N('https://platform.claude.com/oauth/code/callback?code=AAA'), 'AAA', 'state is optional');
    assert.strictEqual(N('https://example.com/nothing'), 'https://example.com/nothing', 'a URL with no code is left alone, not emptied');
    assert.throws(() => N('   '), /Paste the code/, 'an empty paste says what to do, it does not reach the CLI');
    assert.throws(() => N('x'.repeat(5000)), /sign-in code/, 'a runaway paste is refused');
    assert.strictEqual(CODE_REJECTED.test('Invalid code. Please make sure the full code was copied.\n'), true, "the CLI's own rejection line is recognised");
    assert.strictEqual(CODE_REJECTED.test('Paste code here if prompted > '), false, 'and the prompt itself is not');
    assert.throws(() => submitLoginCode('abc'), /expired/, 'a code with no login behind it says so in words a person can act on');

    console.log('✓ accounts self-check: switch verification + expired-login + oauth-probe + paste-code predicates hold');
  })();
}
