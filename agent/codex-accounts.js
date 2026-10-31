'use strict';

// Switch which ChatGPT (Codex CLI) account this host uses for new turns.
//
// Mirrors lib/accounts.js deliberately: same exported surface, same
// snapshot-then-swap shape, same preflight/probe/rollback contract, same
// "never overwrite a working login with a dead one" rule. That is what lets
// server.js, master.js, agent/capabilities.js and the Accounts settings page
// drive both engines through one vocabulary — including the `orgId` name on
// every route and public entry, which here carries the ChatGPT account id.
// Read lib/accounts.js first; only the differences are explained below.
//
// Four things differ from Claude, and every one of them is load-bearing:
//
//  1. ONE FILE. A Codex login is entirely $CODEX_HOME/auth.json — tokens AND
//     identity. There is no second file holding the active account the way
//     Claude splits tokens (.credentials.json) from identity (oauthAccount in
//     .claude.json), so the swap is a single atomic write and there is no
//     identity backfill to get wrong.
//  2. IDENTITY COMES FROM THE JWT, NOT THE CLI. `codex login status` prints
//     "Logged in using ChatGPT" and nothing else — no --json, no email, no
//     account id (verified against codex-cli 0.145.0). The id_token already in
//     auth.json carries all of it in its claims, so we decode that instead of
//     shelling out: cheaper, synchronous, and strictly more informative. It
//     also removes Claude's save-time race entirely — identity and tokens come
//     from the SAME read of the SAME file, so they cannot be mispaired.
//  3. SWITCHING MUST RECYCLE THE APP-SERVER. agent/engine-runs.js keeps ONE
//     long-lived `codex app-server` child that read auth.json when it spawned
//     and holds the tokens in memory. Writing a new auth.json underneath it
//     changes nothing for that process — every turn would keep running on the
//     OLD account until something else happened to restart it. The master asks
//     the agent to recycle it (engineRun 'recycle') so the next turn respawns it
//     on the new login. Miss
//     this and the switch reports success and silently does not take.
//  4. THE BUSY CHECK IS A FACT, NOT A HEURISTIC — and it is the CALLER's fact.
//     Because of (3) a switch taken mid-turn DEFINITELY ends that turn: we are
//     the ones killing the child. There is no Codex pid registry to infer from
//     either (see CLAUDE.md), so preflightSwitch/switchAccount take the count
//     as a `busy` option instead of trying to discover it. That is not just
//     tidiness: the turns are started and counted by the master
//     (lib/cloud/agent-codex-runner.js), so the caller passes the number in.
//
// Shipped to agent boxes exactly like lib/accounts.js: AGENT_FILES in master.js
// distributes this file, agent/codex-accounts.js re-exports it, and each side
// wires its own cache invalidation through setInvalidateHooks().

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { resolveCli, interactiveSpawn, killTree } = require('./which');

let hooks = { invalidateModels: () => {}, reloadCodex: () => {}, accountChanged: () => {} };
function setInvalidateHooks(h) {
  hooks = { ...hooks, ...h };
}

/* ---------- the native path: the agent's one shared app-server ---------- */

// On an agent running the native Codex harness (agent/codex-harness.js), the
// machine has ONE long-lived `codex app-server` and it is the agent's. Then the
// questions this module used to answer by hand have a native answer:
//
//   who is signed in      account/read, from the process that holds the tokens
//   add an account        account/login/start { type: 'chatgptDeviceCode' },
//                         finished by account/login/completed, stopped by
//                         account/login/cancel. No CLI is spawned and no output is
//                         scraped, so the Windows .cmd shim limit goes with it.
//
// What has NO native equivalent stays as it is: Codex keeps one login, so the
// saved snapshots, the switch-by-swapping-auth.json, and the refresh-token probe
// of a snapshot that is not signed in are all still ours. After a switch the
// shared server has to be recycled (note 3) and is then asked, with account/read,
// who it is now on; that answer, not the file we just wrote, decides the switch.
//
//   codexRpc(method, params, { timeoutMs }) -> Promise<result>, throws on error
//   onCodexNotification(fn(method, params)) -> unsubscribe   (the login needs it)
//
// With nothing injected every function below behaves exactly as before.
let native = null; // { rpc, onNotification }
const RPC_TIMEOUT_MS = 20_000;

function setCodexNative({ codexRpc = null, onCodexNotification = null } = {}) {
  native = typeof codexRpc === 'function'
    ? { rpc: codexRpc, onNotification: typeof onCodexNotification === 'function' ? onCodexNotification : null }
    : null;
}

// Same resolution as agent/capabilities.js so "the CLI Termdeck runs turns with"
// and "the CLI Termdeck signs in with" can never be two different binaries.
// Asked on every read, not once: resolveCli re-stats a remembered path and
// expires a remembered miss, so a Codex installed after the process started is
// found without a restart.
const resolvedCodexExe = () => resolveCli('codex', 'TERMDECK_CODEX_EXE', [path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')]);
let codexExeSource = null;

// One answer to "which codex" on this box. The comment above says this module
// resolves the same way the turn runner does — but "the same way" is not the
// same as "the same answer", and on Claude's side those two orders picked two
// DIFFERENT binaries on a machine with both an npm global and a native install:
// turns ran on one, sign-in was driven on the other, and the sign-in hung with
// every payload internally consistent. capabilities.js already hands its
// resolved binary to limits.js for exactly this reason; this is the third
// caller. Ignored if empty so a caller that resolved nothing cannot blank ours.
// A path, or a function returning one (the agent's live resolver).
function setCodexExe(exe) {
  if ((exe && typeof exe === 'string') || typeof exe === 'function') codexExeSource = exe;
}
function codexExe() {
  const set = typeof codexExeSource === 'function' ? codexExeSource() : codexExeSource;
  return (set && typeof set === 'string') ? set : (resolvedCodexExe() || 'codex');
}
// Reported to the UI so a machine without Codex says so, instead of offering an
// Add account button that can only fail with ENOENT. Answered by the machine
// itself, which is the only honest source — the hub, the master and a tunnelled
// agent all get it through the same listAccounts() payload.
// Live for the same reason as codexExe(): an absolute path counts when it is a
// file, a bare name (nothing found, or a bare env override) when PATH has it.
function codexInstalled() {
  const exe = codexExe();
  if (path.isAbsolute(exe)) {
    try { return fs.statSync(exe).isFile(); } catch { return false; }
  }
  return Boolean(resolvedCodexExe());
}
// Same npm-shim rule as lib/accounts.js: Node won't spawn a .cmd without a
// shell, and cmd.exe joins argv unquoted so the path is pre-quoted. Every arg
// this module passes is a literal.
// Functions, not constants: the codex binary is late-bound now.
const winShim = () => process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexExe());
const shimOpts = () => (winShim() ? { shell: true } : {});
// Whether this box can be driven through a sign-in from the dashboard at all —
// same shape and same reasons as lib/accounts.js signInSupport.
function signInSupport() {
  // The native sign-in is a request to a server already running, so there is no
  // console for a .cmd shim to hold and every machine can be driven from here.
  if (native && native.onNotification) return { remote: true, via: 'app-server', why: null, exe: codexExe(), reason: null };
  const { via, cmd, why } = interactiveSpawn(codexExe());
  return {
    remote: via !== 'shell',
    via,
    why: why || null,
    exe: cmd,
    reason: via === 'shell'
      ? 'This machine’s Codex CLI is a Windows .cmd shim that can’t be driven from here — sign in once on the machine itself (run `codex login`), and switching accounts from Termdeck will work after that.'
      : null,
  };
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function credentialsPath() {
  return path.join(codexHome(), 'auth.json');
}

function accountsDir() {
  // Its own directory, never mixed with lib/accounts.js's ~/.termdeck/accounts:
  // the two use the same slug space (an email) and a collision would let one
  // engine's snapshot overwrite the other's.
  const dir = path.join(os.homedir(), '.termdeck', 'codex-accounts');
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

/* ---------- identity, read straight out of the id_token ---------- */

// Where the ChatGPT-specific claims hang off the OpenAI id_token. Namespaced
// URI, not a bare key — that is the OIDC convention for custom claims.
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

function decodeJwtClaims(jwt) {
  try {
    const payload = String(jwt).split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null; // not a JWT, truncated, or not JSON — caller treats as no identity
  }
}

// An API-key login has no account id anywhere, so derive a stable one from the
// key itself: two different keys must be two different rows, and the id must
// never be the key (it ends up in URLs and the DOM).
function apiKeyId(key) {
  return `apikey-${crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12)}`;
}

// Pure: auth.json text -> who it belongs to, or null if it is nobody's.
// `orgId` is the ChatGPT account id — named orgId, not accountId, so the whole
// route/UI layer is shared with Claude verbatim (see the header).
function identityFrom(rawCredentials) {
  let obj;
  try {
    obj = JSON.parse(rawCredentials);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const tokens = obj.tokens && typeof obj.tokens === 'object' ? obj.tokens : {};
  const claims = decodeJwtClaims(tokens.id_token) || {};
  const claimed = claims[OPENAI_AUTH_CLAIM];
  const auth = claimed && typeof claimed === 'object' ? claimed : {};
  // Prefer the signed claim over the loose copy beside it; fall back to the copy
  // so a login whose id_token we cannot decode is still switchable.
  const accountId = auth.chatgpt_account_id || tokens.account_id || null;
  if (accountId) {
    const orgs = Array.isArray(auth.organizations) ? auth.organizations : [];
    const org = orgs.find((o) => o && o.is_default) || orgs[0] || null;
    return {
      orgId: accountId,
      email: claims.email || null,
      orgName: (org && org.title) || claims.name || null,
      subscriptionType: auth.chatgpt_plan_type || null,
      authMode: 'chatgpt',
    };
  }
  // ChatGPT logins carry "OPENAI_API_KEY": null, so this only fires for a real
  // `codex login --with-api-key`. Checked second for exactly that reason.
  if (obj.OPENAI_API_KEY) {
    return { orgId: apiKeyId(obj.OPENAI_API_KEY), email: null, orgName: 'OpenAI API key', subscriptionType: 'api key', authMode: 'apikey' };
  }
  return null;
}

function readLiveCredentials() {
  try {
    return fs.readFileSync(credentialsPath(), 'utf8');
  } catch {
    return null;
  }
}

// Synchronous on purpose — unlike Claude's, this reads a file instead of
// spawning `claude auth status`. Callers still `await` it; awaiting a plain
// value keeps both modules interchangeable at every call site.
//
// On the native path it is a Promise (account/read is a round trip), which is
// why every caller has to `await` it. Same for listAccounts.
function authStatus() {
  if (native) return nativeAuthStatus();
  return diskAuthStatus();
}

function diskAuthStatus() {
  const raw = readLiveCredentials();
  const ident = raw ? identityFrom(raw) : null;
  return ident ? { loggedIn: true, ...ident } : { loggedIn: false };
}

// Pure: an account/read answer -> the status shape above. The server is the
// authority on WHETHER someone is signed in, their email and their plan; the
// account id comes from its workspace routing. auth.json is still read, but only
// for what the server does not say (the org title, an API key's stable id) and
// only when it is the same account, so a file the server has not picked up yet
// can never put one account's name on another's login.
function statusFromAccountRead(read, disk) {
  const a = read && read.account;
  if (!a || typeof a !== 'object') return { loggedIn: false };
  if (a.type === 'chatgpt') {
    const routed = read.workspaceRouting && read.workspaceRouting.chatgptAccountId;
    const fromDisk = disk && disk.authMode === 'chatgpt' ? disk : null;
    const orgId = routed || (fromDisk ? fromDisk.orgId : null) || (a.email ? `codex:${a.email}` : null);
    const same = fromDisk && fromDisk.orgId === orgId ? fromDisk : null;
    return {
      loggedIn: true,
      orgId,
      email: a.email || (same ? same.email : null),
      orgName: same ? same.orgName : null,
      subscriptionType: a.planType || (same ? same.subscriptionType : null),
      authMode: 'chatgpt',
    };
  }
  if (a.type === 'apiKey') {
    if (disk && disk.authMode === 'apikey') return { loggedIn: true, ...disk };
    return { loggedIn: true, orgId: 'apikey', email: null, orgName: 'OpenAI API key', subscriptionType: 'api key', authMode: 'apikey' };
  }
  // Amazon Bedrock, and whatever Codex adds next: signed in, but not a login this
  // module can snapshot or switch. Reported so the page does not say "signed out".
  const kind = String(a.type || 'unknown');
  return { loggedIn: true, orgId: kind, email: null, orgName: kind === 'amazonBedrock' ? 'Amazon Bedrock' : kind, subscriptionType: null, authMode: kind };
}

// A server that cannot answer is not "signed out": fall back to the file, which
// is what the answer was before there was a server to ask.
async function nativeAuthStatus() {
  const raw = readLiveCredentials();
  const disk = raw ? identityFrom(raw) : null;
  let read;
  try {
    read = await native.rpc('account/read', {}, { timeoutMs: RPC_TIMEOUT_MS });
  } catch {
    return disk ? { loggedIn: true, ...disk } : { loggedIn: false };
  }
  return statusFromAccountRead(read, disk);
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

function writeEntry(entry) {
  atomicWrite(path.join(accountsDir(), `${slugFor(entry.orgId, entry.email)}.json`), JSON.stringify(entry, null, 2));
}

// Snapshots whatever is currently logged in. Called explicitly ("save this
// login") and automatically before every switch/login — the CLI refreshes
// tokens in place, so re-snapshotting keeps a saved account from going stale.
// The whole file is stored verbatim, including auth_mode and OPENAI_API_KEY, so
// switching between an API-key login and a ChatGPT login restores both halves.
function saveCurrentAccount() {
  const raw = readLiveCredentials();
  if (!raw) throw new Error('Not signed in to Codex — nothing to save');
  const ident = identityFrom(raw);
  if (!ident) throw new Error('The Codex login on this machine is unreadable — sign in again');
  const entry = { ...ident, savedAt: Date.now(), credentials: raw };
  writeEntry(entry);
  return publicEntry(entry, true);
}

function listAccounts() {
  if (native) return nativeAuthStatus().then(accountsFor);
  return accountsFor(diskAuthStatus());
}

function accountsFor(status) {
  const accounts = readSavedEntries()
    .map((entry) => publicEntry(entry, Boolean(status.loggedIn && entry.orgId && entry.orgId === status.orgId)))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const active = status.loggedIn
    ? { orgId: status.orgId, email: status.email, orgName: status.orgName, subscriptionType: status.subscriptionType, saved: accounts.some((a) => a.active) }
    : null;
  // Saved snapshots are still listed on a machine without Codex — they are ours,
  // not the CLI's, and hiding them would look like data loss after an uninstall.
  return { accounts, active, available: codexInstalled() };
}

// Pure: did the live login end up on the account we asked for? Same predicate
// as Claude's — a mislabeled snapshot holding another account's tokens must
// count as a failed switch, not a success.
function switchTookEffect(status, orgId) {
  return !!(status && status.loggedIn && status.orgId === orgId);
}

// Pure: is there enough in this snapshot for Codex to authenticate at all?
//
// Deliberately NOT the same test as Claude's. Codex records no
// refreshTokenExpiresAt — nothing in auth.json says when the refresh token
// dies — and `last_refresh` is a "when did we last refresh" stamp, not an
// expiry, so any staleness rule built on it would be invented. The only thing
// provable offline is whether the file has credentials in it at all; the real
// liveness answer comes from probeCredentials(). Unparseable is FALSE here
// (unlike Claude's, where an unreadable file might still be a valid shape we
// failed to model) because Codex cannot read it either — that is proof, not a
// guess.
function credentialsUsable(rawCredentials) {
  let obj;
  try {
    obj = JSON.parse(rawCredentials);
  } catch {
    return false;
  }
  if (!obj || typeof obj !== 'object') return false;
  if (obj.tokens && obj.tokens.refresh_token) return true; // ChatGPT login
  if (obj.OPENAI_API_KEY) return true; // `codex login --with-api-key`
  return false;
}

// Codex CLI's own OAuth client + token endpoint. Measured live 2026-07-26
// against codex-cli 0.145.0's auth.json:
//   - a good refresh token returns 200 {access_token, id_token, refresh_token,
//     expires_in, scope, earliest_refresh_at, oai_is} and ROTATES the refresh
//     token;
//   - a bogus one returns 401 {"error":{"code":"token_expired", ...}} — nested
//     under `error`, not the flat OAuth `"error":"invalid_grant"` Claude sends;
//   - back-to-back refreshes both succeed, so `earliest_refresh_at` is advisory
//     and preflight probing on every switch is safe.
//
// *** PERSISTING THE ROTATED TOKEN IS MANDATORY, NOT TIDINESS. *** OpenAI does
// refresh-token REUSE DETECTION: presenting a token that has already been
// exchanged invalidates the entire family, including the newest one. Measured
// the hard way — refreshing twice and then replaying the original token killed
// a working login outright, after which `codex exec` failed with
// "refresh token was revoked. Please log out and sign in again." So a probe
// whose rotated token we drop does not leave a stale-but-usable snapshot; the
// NEXT probe of that snapshot destroys the account's login. Every caller of
// probeCredentials must write `credentials` back before doing anything else,
// and nothing else may ever re-send a token we have already spent.
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// Pull the error code out of either shape the endpoint uses.
function errorCodeOf(body) {
  if (!body || typeof body !== 'object') return null;
  if (typeof body.error === 'string') return body.error;
  if (body.error && typeof body.error === 'object') return body.error.code || body.error.type || null;
  return null;
}
// Only these mean "this login is gone". Anything else — a 5xx, a timeout, a
// shape we do not recognise — is 'unknown' and must never block a switch: a
// check that cannot reach the internet must not lock you out of your own box.
//
// refresh_token_invalidated is the reuse-detection verdict described above, and
// it is fatal despite sounding procedural: with the family burned, Codex itself
// refuses the login ("refresh token was revoked. Please log out and sign in
// again"). Observed on a real account, not inferred.
const DEAD_CODES = new Set(['invalid_grant', 'token_expired', 'refresh_token_invalidated']);

// The only check that catches a login revoked or signed out SERVER-side: mint a
// fresh token from the snapshot's refresh token. Three-state, exactly like
// lib/accounts.js's. On success the caller MUST persist the returned
// credentials — the refresh token rotates (measured), so throwing the response
// away would leave the snapshot one step behind every time.
async function probeCredentials(rawCredentials) {
  let obj;
  try {
    obj = JSON.parse(rawCredentials);
  } catch {
    return { state: 'unknown', detail: 'saved login is not readable' };
  }
  const tokens = obj.tokens && typeof obj.tokens === 'object' ? obj.tokens : {};
  if (!tokens.refresh_token) return { state: 'unknown', detail: 'saved login has no refresh token to check' };
  let res, body;
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: OAUTH_CLIENT_ID, scope: 'openid profile email' }),
      signal: AbortSignal.timeout(15_000),
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    return { state: 'unknown', detail: `could not reach OpenAI (${err.message})` };
  }
  if (res.ok && body.access_token && body.id_token) {
    const next = {
      ...obj,
      tokens: { ...tokens, id_token: body.id_token, access_token: body.access_token, refresh_token: body.refresh_token || tokens.refresh_token },
      last_refresh: new Date().toISOString(),
    };
    return { state: 'ok', detail: 'token accepted by OpenAI', credentials: JSON.stringify(next, null, 2) };
  }
  const code = errorCodeOf(body);
  if (DEAD_CODES.has(code)) return { state: 'dead', detail: 'OpenAI rejected this login — it was signed out or revoked' };
  return { state: 'unknown', detail: `OpenAI replied ${res.status}${code ? ` (${code})` : ''}` };
}

// Pure: normalise whatever the caller reported into a count we can phrase.
// Anything absent, negative, or not a number means "nothing running" — the
// caller is the only one who can know (note 4), and a bad value must not
// invent a warning that blocks a switch.
function busyCount(busy) {
  const n = Number(busy);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const check = (id, label, status, detail) => ({ id, label, status, detail });

// Everything we can learn about a switch BEFORE touching the live login, as an
// ordered list the UI renders step by step. `fail` blocks, `warn` is advisory
// (the caller decides), `ok` is clear. Also self-heals the snapshot: a
// successful probe writes the refreshed tokens back.
//
// Two checks Claude emits are absent by design rather than stubbed:
//   - no `expiry` step, because nothing in auth.json records one (see
//     credentialsUsable) and a check that always says "no expiry recorded" is
//     noise dressed as reassurance;
//   - no `oauth` step for an API-key login, because there is no token endpoint
//     to ask. Reporting `ok` there would claim a verification we never did.
// The UI renders whatever list comes back, so a shorter list costs nothing.
//
// `busy` is how many Codex turns the CALLER has in flight on this machine —
// see note 4. It is a parameter and not something this module discovers.
async function preflightSwitch(orgId, { busy = 0 } = {}) {
  const checks = [];
  const target = readSavedEntries().find((e) => e.orgId === orgId);
  if (!target) return { ok: false, checks: [check('snapshot', 'Find the saved login', 'fail', 'No saved ChatGPT login for that account on this machine.')] };

  if (!credentialsUsable(target.credentials)) {
    checks.push(check('snapshot', 'Read the saved login', 'fail', 'The saved login is corrupt or missing its tokens. Remove it and add the account again.'));
    return { ok: false, checks };
  }
  checks.push(check('snapshot', 'Read the saved login', 'ok', target.email || target.orgName || orgId));

  if (target.authMode !== 'apikey') {
    const probe = await probeCredentials(target.credentials);
    if (probe.state === 'dead') {
      checks.push(check('oauth', 'Verify the login with OpenAI', 'fail', `${probe.detail}. Remove it and sign in to that account again.`));
      return { ok: false, checks };
    }
    if (probe.state === 'ok' && probe.credentials) {
      // Persist first: the refresh token rotates, and dropping the new one here
      // would strand the account we just proved was fine.
      target.credentials = probe.credentials;
      writeEntry(target);
    }
    checks.push(check('oauth', 'Verify the login with OpenAI', probe.state === 'ok' ? 'ok' : 'warn', probe.detail));
  }

  // Not "can break" like Claude's — switching kills the shared app-server
  // child (see note 3), so a turn in flight ends. Say so plainly.
  const n = busyCount(busy);
  checks.push(
    n
      ? check('busy', 'Check no chat is mid-reply', 'warn', `${n} Codex chat${n === 1 ? ' is' : 's are'} generating on this machine. Switching restarts Codex here, which will end ${n === 1 ? 'it' : 'them'}.`)
      : check('busy', 'Check no chat is mid-reply', 'ok', 'nothing is generating right now')
  );

  return { ok: true, checks };
}

async function switchAccount(orgId, { busy = 0 } = {}) {
  // Full preflight first — a corrupt or revoked snapshot must never overwrite
  // the working login. Everything below only runs once it passes.
  const pre = await preflightSwitch(orgId, { busy });
  if (!pre.ok) {
    const failed = pre.checks.find((c) => c.status === 'fail');
    const err = new Error(failed ? failed.detail : 'Pre-switch checks failed');
    err.checks = pre.checks;
    throw err;
  }
  // Re-read: preflight may have written refreshed tokens into the snapshot.
  const target = readSavedEntries().find((e) => e.orgId === orgId);
  if (!target) throw new Error('Saved account not found');
  const prevCred = readLiveCredentials(); // roll back to this if the switch doesn't take
  try {
    saveCurrentAccount(); // best-effort: don't lose a refreshed token on the outgoing account
  } catch {}

  atomicWrite(credentialsPath(), target.credentials);
  hooks.invalidateModels();
  // note 3: without this the running app-server keeps the old login. On the
  // native path the hook recycles the agent's own shared server and is awaited:
  // the account/read below has to reach the NEW process, or it would confirm the
  // old account's identity from memory and roll back a switch that took.
  await hooks.reloadCodex();

  const status = await authStatus();
  if (!switchTookEffect(status, orgId)) {
    if (prevCred != null) atomicWrite(credentialsPath(), prevCred);
    hooks.invalidateModels();
    await hooks.reloadCodex();
    const err = new Error('That saved login didn’t activate — remove it and add the account again.');
    err.checks = [...pre.checks, check('activate', 'Switch and confirm', 'fail', err.message)];
    throw err;
  }
  hooks.accountChanged();
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

/* ---------- adding an account: the device-code flow ---------- */

// Terminal control bytes wrap both the URL and the code in colour, so strip
// before matching rather than trying to out-regex the escapes.
function stripAnsi(s) {
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// Codex's plain `codex login` spins a callback listener on localhost:1455 of
// the machine running the CLI, so it only completes when the browser is on that
// same box — useless for a remote agent or the cloud dashboard, and a trap for
// anyone browsing the hub from their phone. `--device-auth` prints a URL and a
// one-time code and polls, which works from any device, so it is the only flow
// we drive. Verified against codex-cli 0.145.0, including that it starts the
// flow directly when a login already exists (no "already signed in" prompt) —
// and that it DELETES auth.json up front rather than on success, which is why
// startLogin() snapshots and can roll back. See there.
//
// Note the direction is the OPPOSITE of Claude's: there the CLI prints a URL
// and we paste a code back INTO it, so lib/accounts.js has submitLoginCode().
// Here the code goes from us to the browser and the CLI polls on its own —
// there is nothing to submit, so no such function exists and no route offers one.
const DEVICE_CODE_LINE = /^\s*([A-Z0-9]{3,8}-[A-Z0-9]{3,8})\s*$/m;

let loginChild = null;
let loginUrl = null;
let loginUserCode = null;
let loginCancelled = false;
let loginResult = null; // { ok, account } | { ok: false, error, cancelled? } once settled; cleared on next startLogin

let loginFlow = null; // the native flow in progress: { loginId, cancelled, done, early, unsub, timer }

function loginStatus() {
  return { inProgress: Boolean(loginChild || loginFlow), url: loginUrl, userCode: loginUserCode, result: loginResult };
}

// The code itself expires in 15 minutes, so a 3-minute cap (Claude's) would
// kill a flow that is still perfectly valid. 16 outlives the code.
const LOGIN_TIMEOUT_MS = 16 * 60 * 1000;

// `codex login` DELETES auth.json the instant it starts, before the person has
// typed anything (measured: auth.json is gone while the device code is still
// on screen). So merely clicking "Add account" signs this machine out, and
// cancelling would strand it that way. Two different losses to prevent:
//
//   - the flow FAILS: put the bytes we had straight back (restorePrevious).
//   - the flow SUCCEEDS: the outgoing login is overwritten by the new one, so
//     an account that was never saved is simply gone. Snapshot it first.
//
// But only when it is not already saved. Re-snapshotting unconditionally would
// overwrite a good stored snapshot with whatever is live, and "live" is not
// the same as "working": a spent refresh token still parses, still yields an
// identity, and would happily replace the last switchable copy of that account
// with a dead one. Keeping tokens fresh is switchAccount's job (it re-saves the
// outgoing account) and preflight's (it persists the rotated token); neither
// needs this path to do it too.
//
// The app-server's device flow does not delete the file up front (upstream
// account_processor.rs), but a successful one still overwrites it, so the native
// path takes the same snapshot and keeps the same restore as a backstop.
// Returns the bytes that were live.
function snapshotOutgoing() {
  const prevCred = readLiveCredentials();
  try {
    const live = identityFrom(prevCred || '');
    if (live && !readSavedEntries().some((e) => e.orgId === live.orgId)) saveCurrentAccount();
  } catch {
    /* nothing signed in, or unreadable — nothing to preserve */
  }
  return prevCred;
}

// Codex's own words for why a login could not start ("ChatGPT login is
// disabled. Use API key login instead.", "failed to request device code: ..."),
// clipped. They name the problem and carry no credential.
const loginError = (e, fallback) => String((e && e.message) || e || fallback).trim().slice(0, 500) || fallback;

// The device code over the shared app-server. Same contract as the CLI flow
// below: synchronous to call (capabilities.js answers `{ started: true }` at
// once), url and userCode arrive on loginStatus() a moment later, and `result`
// settles once. The flow belongs to the server, not to a child of ours, so a
// cancel is a request and a timeout is a cancel.
function startNativeLogin() {
  const prevCred = snapshotOutgoing();
  // Held for the flow's life: an injection replaced mid-flow must not strand it.
  const { rpc, onNotification } = native;
  const flow = { loginId: null, cancelled: false, done: false, early: null, unsub: null, timer: null, rpc };
  loginFlow = flow;
  const settle = (result) => {
    if (flow.done) return;
    flow.done = true;
    clearTimeout(flow.timer);
    if (flow.unsub) { try { flow.unsub(); } catch {} }
    if (loginFlow === flow) loginFlow = null;
    loginResult = result;
  };
  // Nothing to undo unless the file is gone, which this flow does not do on its
  // own; kept so a failed sign-in can never be the thing that signed a box out.
  const restorePrevious = () => {
    if (prevCred == null || identityFrom(readLiveCredentials() || '')) return;
    try { atomicWrite(credentialsPath(), prevCred); } catch {}
  };
  const completed = (p) => {
    if (flow.cancelled) {
      restorePrevious();
      return settle({ ok: false, cancelled: true });
    }
    if (!p.success) {
      restorePrevious();
      return settle({ ok: false, error: loginError(p.error, 'The sign-in did not complete.') });
    }
    // The server reloaded its own login on success and wrote auth.json (file
    // credential store), so this snapshot is of the account just added. No
    // recycle: unlike a switch, the shared server is already on it.
    try {
      const account = saveCurrentAccount();
      hooks.invalidateModels();
      hooks.accountChanged();
      settle({ ok: true, account });
    } catch (err) {
      settle({ ok: false, error: err.message });
    }
  };
  // Subscribed BEFORE the request, so a completion can never slip between the
  // response and the subscription. One that names a login we do not know yet is
  // held until the response says which login is ours.
  const un = onNotification((method, params) => {
    if (method !== 'account/login/completed' || !params || flow.done) return;
    if (flow.loginId == null) { flow.early = params; return; }
    if (params.loginId != null && params.loginId !== flow.loginId) return; // someone else's sign-in
    completed(params);
  });
  flow.unsub = typeof un === 'function' ? un : null;
  flow.timer = setTimeout(() => {
    if (flow.loginId) rpc('account/login/cancel', { loginId: flow.loginId }, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => {});
    restorePrevious();
    settle({ ok: false, error: 'The one-time code expired before the sign-in finished. Start again.' });
  }, LOGIN_TIMEOUT_MS);
  if (flow.timer.unref) flow.timer.unref();
  rpc('account/login/start', { type: 'chatgptDeviceCode' }, { timeoutMs: 60_000 }).then((r) => {
    const loginId = r && typeof r.loginId === 'string' ? r.loginId : null;
    if (flow.done) {
      // Cancelled while the code was being fetched: stop the flow it started.
      if (loginId) rpc('account/login/cancel', { loginId }, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => {});
      return;
    }
    if (!r || r.type !== 'chatgptDeviceCode' || !loginId) return settle({ ok: false, error: 'Codex did not start a device-code sign-in on this machine.' });
    flow.loginId = loginId;
    loginUrl = typeof r.verificationUrl === 'string' ? r.verificationUrl : null;
    loginUserCode = typeof r.userCode === 'string' ? r.userCode : null;
    const early = flow.early;
    flow.early = null;
    if (early && (early.loginId == null || early.loginId === loginId)) completed(early);
  }, (e) => {
    restorePrevious();
    settle({ ok: false, error: loginError(e, 'Codex could not start a sign-in.') });
  });
}

function startLogin() {
  if (loginChild || loginFlow) throw new Error('A login is already in progress');
  loginUrl = null;
  loginUserCode = null;
  loginCancelled = false;
  loginResult = null;
  // The device code is the only flow the protocol offers that fits a browser on
  // another device: `chatgpt` is the localhost:1455 callback (useless remotely,
  // the same trap as plain `codex login`), `apiKey` would put a key on the wire,
  // and `chatgptAuthTokens` is for hosts that run their own OAuth. Needs the
  // notification half, since that is how the flow says it finished.
  if (native && native.onNotification) return startNativeLogin();
  const prevCred = snapshotOutgoing();
  // The device flow hands its code to the PERSON rather than reading one back,
  // so this half never hung the way Claude's paste step did — but the code and
  // the URL still have to reach us THROUGH that same cmd.exe hop, which is the
  // one that held Claude's prompt line and never let it go. Same route, same
  // reasons (lib/which.js interactiveSpawn).
  const route = interactiveSpawn(codexExe());
  const child = spawn(route.cmd, [...route.prefix, 'login', '--device-auth'], { stdio: ['pipe', 'pipe', 'pipe'], ...route.opts });
  loginChild = child;
  let out = '';
  const onData = (chunk) => {
    out += stripAnsi(String(chunk));
    if (!loginUrl) {
      const m = out.match(/https?:\/\/[^\s\x00-\x1f]+/);
      if (m) loginUrl = m[0];
    }
    if (!loginUserCode) {
      const m = out.match(DEVICE_CODE_LINE);
      if (m) loginUserCode = m[1];
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {}
  }, LOGIN_TIMEOUT_MS);
  const settle = (result) => {
    clearTimeout(timer);
    loginChild = null;
    loginResult = result;
  };
  // Undo the sign-out described above when the flow produced nothing. Only when
  // there is genuinely no login on disk: a successful `codex login` has already
  // written the NEW one, and putting the old bytes back over it would silently
  // discard the account the person just signed into.
  const restorePrevious = () => {
    if (prevCred == null) return;
    if (identityFrom(readLiveCredentials() || '')) return;
    try {
      atomicWrite(credentialsPath(), prevCred);
      hooks.reloadCodex();
    } catch {}
  };
  child.on('exit', (code) => {
    if (loginCancelled) {
      restorePrevious();
      return settle({ ok: false, cancelled: true });
    }
    const text = out.trim();
    if (code !== 0) {
      restorePrevious();
      // An older Codex has no --device-auth; clap rejects the flag rather than
      // failing the login, and "unexpected argument" is not a useful thing to
      // show someone who just clicked Add account.
      const stale = /unexpected argument|unrecognized|--device-auth/i.test(text) && /error|usage:/i.test(text);
      return settle({ ok: false, error: stale ? 'This machine’s Codex CLI is too old to add an account from the browser — update Codex and try again.' : text.slice(-500) || `login exited with code ${code}` });
    }
    try {
      const account = saveCurrentAccount();
      hooks.invalidateModels();
      hooks.reloadCodex();
      settle({ ok: true, account });
    } catch (err) {
      settle({ ok: false, error: err.message });
    }
  });
  child.on('error', (err) => settle({ ok: false, error: err.message }));
}

function cancelLogin() {
  if (loginFlow) {
    const flow = loginFlow;
    flow.cancelled = true;
    // Settled here rather than on the server's failed account/login/completed: the
    // person asked to stop, and the page should say so on its next poll whether or
    // not the server answers. A login not yet issued is cancelled when its id
    // arrives (startNativeLogin).
    if (flow.loginId) flow.rpc('account/login/cancel', { loginId: flow.loginId }, { timeoutMs: RPC_TIMEOUT_MS }).catch(() => {});
    flow.done = true;
    clearTimeout(flow.timer);
    if (flow.unsub) { try { flow.unsub(); } catch {} }
    loginFlow = null;
    loginResult = { ok: false, cancelled: true };
    return true;
  }
  if (!loginChild) return false;
  loginCancelled = true;
  // killTree: on the shell fallback the child is cmd.exe with the real CLI
  // underneath, and killing the parent orphans a `codex login` still holding
  // the device flow the person just cancelled.
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
  switchTookEffect,
  credentialsUsable,
  removeAccount,
  startLogin,
  cancelLogin,
  loginStatus,
  signInSupport,
  setCodexExe,
  setCodexNative,
  statusFromAccountRead,
};

// ponytail self-check: node lib/codex-accounts.js — pins the pure predicates
// (identity decoding, usability, switch verification, the probe's three states)
// without touching the CLI, the network, or the real ~/.codex.
if (require.main === module) {
  const assert = require('assert');

  // A real-shaped id_token: header.payload.signature, payload base64url JSON.
  const jwt = (claims) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  const chatgptAuth = (over = {}) =>
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt({
          email: 'someone@example.com',
          name: 'Some One',
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-1',
            chatgpt_plan_type: 'plus',
            organizations: [{ id: 'org-x', is_default: true, title: 'Personal' }],
          },
        }),
        access_token: 'at',
        refresh_token: 'rt',
        account_id: 'acct-1',
        ...over,
      },
      last_refresh: '2026-07-25T17:39:07.102775500Z',
    });

  const ident = identityFrom(chatgptAuth());
  assert.deepStrictEqual(ident, { orgId: 'acct-1', email: 'someone@example.com', orgName: 'Personal', subscriptionType: 'plus', authMode: 'chatgpt' }, 'identity comes out of the id_token claims');

  // An undecodable id_token must still be switchable via the loose copy.
  const fallback = identityFrom(JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'garbage', refresh_token: 'rt', account_id: 'acct-2' } }));
  assert.strictEqual(fallback.orgId, 'acct-2', 'falls back to tokens.account_id when the JWT will not decode');
  assert.strictEqual(fallback.email, null, 'and reports no email rather than inventing one');

  // API-key logins get a stable, non-secret id derived from the key.
  const k1 = identityFrom(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-aaa' }));
  const k2 = identityFrom(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-bbb' }));
  assert.strictEqual(k1.authMode, 'apikey', 'api-key login is recognised');
  assert.ok(!k1.orgId.includes('sk-aaa'), 'the id never contains the key itself');
  assert.strictEqual(k1.orgId, identityFrom(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-aaa' })).orgId, 'same key = same id');
  assert.notStrictEqual(k1.orgId, k2.orgId, 'different keys = different rows');
  // A ChatGPT login carries OPENAI_API_KEY: null — it must not be read as api-key mode.
  assert.strictEqual(identityFrom(chatgptAuth()).authMode, 'chatgpt', 'a null OPENAI_API_KEY does not make it an api-key login');
  assert.strictEqual(identityFrom('not json'), null, 'unparseable = nobody');
  assert.strictEqual(identityFrom(JSON.stringify({ auth_mode: 'chatgpt', tokens: {} })), null, 'no id anywhere = nobody');

  // account/read is the authority; auth.json fills in only what the server does
  // not say, and only for the same account.
  const routed = (id, email = 'someone@example.com', planType = 'pro') => ({ account: { type: 'chatgpt', email, planType }, requiresOpenaiAuth: true, workspaceRouting: id ? { chatgptAccountId: id, backendOrigin: 'https://chatgpt.com', accountRoutingOverride: 'NO_CONSTRAINT' } : null });
  assert.deepStrictEqual(statusFromAccountRead(routed('acct-1'), ident), { loggedIn: true, orgId: 'acct-1', email: 'someone@example.com', orgName: 'Personal', subscriptionType: 'pro', authMode: 'chatgpt' }, 'the server names the plan; the file only adds the org title');
  const other = statusFromAccountRead(routed('acct-9', 'nine@example.com'), ident);
  assert.strictEqual(other.orgId, 'acct-9', 'a file the server has not picked up never relabels its login');
  assert.strictEqual(other.orgName, null, 'and lends it no org title');
  assert.strictEqual(statusFromAccountRead(routed(null), ident).orgId, 'acct-1', 'no workspace routing: the account id comes from the file');
  assert.strictEqual(statusFromAccountRead(routed(null, 'x@example.com'), null).orgId, 'codex:x@example.com', 'and with no file either, from the email');
  assert.deepStrictEqual(statusFromAccountRead({ account: null, requiresOpenaiAuth: true }, ident), { loggedIn: false }, 'the server saying nobody beats a file saying somebody');
  assert.strictEqual(statusFromAccountRead({ account: { type: 'apiKey' } }, k1).orgId, k1.orgId, 'an API key keeps its stable id from the file');
  assert.strictEqual(statusFromAccountRead({ account: { type: 'amazonBedrock', usesCodexManagedCredentials: true } }, null).loggedIn, true, 'a Bedrock login is signed in, not signed out');

  assert.strictEqual(switchTookEffect({ loggedIn: true, orgId: 'A' }, 'A'), true, 'matching account = switched');
  assert.strictEqual(switchTookEffect({ loggedIn: true, orgId: 'B' }, 'A'), false, 'wrong account (mislabeled snapshot) = not switched');
  assert.strictEqual(switchTookEffect({ loggedIn: false }, 'A'), false, 'logged out = not switched');
  assert.strictEqual(switchTookEffect(null, 'A'), false, 'no status = not switched');

  assert.strictEqual(credentialsUsable(chatgptAuth()), true, 'a refresh token is enough to try');
  assert.strictEqual(credentialsUsable(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' })), true, 'so is an api key');
  assert.strictEqual(credentialsUsable(JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'x' } })), false, 'tokens with no refresh token cannot authenticate');
  assert.strictEqual(credentialsUsable('not json'), false, 'unparseable = unusable — Codex cannot read it either');

  const realFetch = global.fetch;
  const stub = (impl) => {
    global.fetch = impl;
  };
  (async () => {
    stub(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'new', id_token: jwt({ email: 'someone@example.com' }), refresh_token: 'rt2', expires_in: 864000 }) }));
    const good = await probeCredentials(chatgptAuth());
    assert.strictEqual(good.state, 'ok', 'accepted refresh = ok');
    const rolled = JSON.parse(good.credentials);
    assert.strictEqual(rolled.tokens.access_token, 'new', 'refreshed access token is kept');
    assert.strictEqual(rolled.tokens.refresh_token, 'rt2', 'rotated refresh token is kept — OpenAI rotates it on every refresh');
    assert.strictEqual(rolled.tokens.account_id, 'acct-1', 'untouched fields survive the merge');
    assert.strictEqual(rolled.auth_mode, 'chatgpt', 'and so does the non-token half of the file');
    assert.notStrictEqual(rolled.last_refresh, '2026-07-25T17:39:07.102775500Z', 'last_refresh is restamped');

    // The two shapes that mean "gone": OpenAI's nested code, and flat OAuth.
    stub(async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'token_expired', message: 'Could not validate your token.' } }) }));
    assert.strictEqual((await probeCredentials(chatgptAuth())).state, 'dead', 'nested token_expired = revoked login');
    stub(async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }));
    assert.strictEqual((await probeCredentials(chatgptAuth())).state, 'dead', 'flat invalid_grant = revoked login');
    stub(async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'refresh_token_invalidated' } }) }));
    assert.strictEqual((await probeCredentials(chatgptAuth())).state, 'dead', 'reuse-detection verdict is fatal too — Codex refuses the login after it');

    stub(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    assert.strictEqual((await probeCredentials(chatgptAuth())).state, 'unknown', '5xx = unknown, must not block a switch');
    stub(async () => {
      throw new Error('offline');
    });
    assert.strictEqual((await probeCredentials(chatgptAuth())).state, 'unknown', 'network error = unknown, must not block a switch');
    stub(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'new' }) }));
    assert.strictEqual((await probeCredentials(chatgptAuth())).state, 'unknown', '200 with a shape we do not recognise is not a pass');
    assert.strictEqual((await probeCredentials('not json')).state, 'unknown', 'unparseable snapshot = unknown');
    assert.strictEqual((await probeCredentials(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }))).state, 'unknown', 'an api-key login has no refresh token to check');

    global.fetch = realFetch;

    // The busy count is the caller's, and a junk value must never fabricate a
    // warning that makes someone click through "Switch anyway" (see note 4).
    assert.strictEqual(busyCount(undefined), 0, 'a caller that reports nothing means nothing is running');
    assert.strictEqual(busyCount(3), 3, 'a real count is passed through');
    assert.strictEqual(busyCount(-2), 0, 'nonsense counts do not become warnings');
    assert.strictEqual(busyCount('two'), 0, 'neither do unparseable ones');

    // The device code is read off its own line, not scavenged from the URL.
    const sample = stripAnsi(
      '\x1b[90mOpenAI\x1b[0m\n\n1. Open this link\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mS1B7-ZL7Y0\x1b[0m\n'
    );
    assert.strictEqual(sample.match(/https?:\/\/[^\s\x00-\x1f]+/)[0], 'https://auth.openai.com/codex/device', 'URL survives ANSI stripping intact');
    assert.strictEqual(sample.match(DEVICE_CODE_LINE)[1], 'S1B7-ZL7Y0', 'device code is picked off its own line');

    const missing = await preflightSwitch('no-such-account');
    assert.strictEqual(missing.ok, false, 'unknown account fails preflight');
    assert.strictEqual(missing.checks[0].status, 'fail', 'and says which step failed');

    console.log('✓ codex-accounts self-check: identity, usability, switch verification + oauth-probe predicates hold');
  })();
}
