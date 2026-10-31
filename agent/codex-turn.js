'use strict';

// One turn of the native Codex harness (docs/codex-native.md): `codex app-server`
// traffic in, engine events and JSON-RPC replies out. Pure, like lib/codex-events.js
// which it replaces: no process, no timer, no socket, so tests/codex-turn.mjs feeds it
// messages and checks every reply against the pinned protocol.
//
// Where lib/codex-events.js translated Codex into Claude's shape (a message of
// blocks, tool_use rows, Claude's usage names), this one does not translate at all.
// Every notification for the run's thread, and for the sub-agent threads working for
// it, leaves as `codex.event { method, params }` exactly as Codex sent it, and the
// browser draws Codex's own Turn/ThreadItem model from those. What is derived here is
// only the generic lifecycle the shared plumbing reads whatever the engine
// (run.status, approval.requested / approval.resolved, usage, compaction, notice,
// run.finished), and the replies to the server requests a person answers.
//
// One follower follows ONE TURN on one thread. The app-server is shared by every
// thread on the machine (agent/codex-harness.js routes each message to the run whose
// thread it names, or whose sub-agent it is), so nothing here may assume it sees the
// whole connection. A message whose threadId is not the run's own is a sub-agent's:
// passed through, its approvals raised for this run's chat to answer, its turn
// tracked so Stop can reach it, but it never ends this run.
//
// The driver calls:
//
//   bound(threadId, { cwd, transcriptPath })  the thread is resumed or started -> session.bound
//   acknowledged(turn)                        turn/start (or review/start) answered with the turn
//   notification(method, params)              one notification -> { events, replies, ended }
//   request(id, method, params)               one server request -> { events, replies, ended }
//   answer(requestId, decision)               the master's decision on a card -> { events, replies }
//   subagentMeta(threadId, meta)              a worker's names, once the harness has read them
//   abort()                                   Stop was pressed; the finish reports 'aborted'
//   fail(message, detail)                     the turn never ran (resume refused, turn/start rejected)
//   exit({ code, error })                     the app-server is gone
//
// `replies` are JSON-RPC responses for the driver to write: { id, result } or
// { id, error }, without the "jsonrpc" member the app-server wire does not carry.
//
// What stays on the master: whether a card is answered by a policy, a grant or a
// person (lib/cloud/codex-native-runner.js). Every request is raised as an event
// and answered by the master, even the ones it answers in a millisecond. What stays
// HERE is the one check the master must not be trusted with: an answer is only ever
// one the request itself offered.

// Any string in a forwarded params over this is cut (docs/codex-native.md): a
// command's aggregatedOutput or a file diff can run to megabytes, and one event is
// one frame through the tunnel and one entry in the run's replay log.
const STRING_CAP = 256 * 1024;

// The notifications a run forwards. The item lifecycle and the turn's are what the
// SPA's thread model is built from; the rest is what Codex says about the turn on
// the thread level (usage, status, a name, a reroute, a hook, a warning).
const FORWARD_EXACT = new Set([
  'thread/tokenUsage/updated', 'thread/status/changed', 'thread/name/updated', 'thread/started',
  'serverRequest/resolved', 'model/rerouted', 'error', 'warning', 'hook/started', 'hook/completed',
]);
const forwarded = (method) => typeof method === 'string'
  && (method.startsWith('turn/') || method.startsWith('item/') || FORWARD_EXACT.has(method));

// The server requests a person answers, and the toolName their card carries.
// Anything else (item/tool/call, the v1 applyPatchApproval / execCommandApproval,
// currentTime/read...) is refused with an error rather than left hanging.
const CARDS = {
  'item/commandExecution/requestApproval': 'commandExecution',
  'item/fileChange/requestApproval': 'fileChange',
  'item/permissions/requestApproval': 'permissions',
  'item/tool/requestUserInput': 'requestUserInput',
  'mcpServer/elicitation/request': 'mcpElicitation',
};

const REFUSED = -32000;

// Cut every string over the cap, copying only the branches that change, and say
// so on the params. A surrogate pair is never split: the cut lands before it.
function capStrings(v, cap, hit) {
  if (typeof v === 'string') {
    if (v.length <= cap) return v;
    hit.cut = true;
    let end = cap;
    const c = v.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1;
    return v.slice(0, end);
  }
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    let out = null;
    for (let i = 0; i < v.length; i++) {
      const n = capStrings(v[i], cap, hit);
      if (n !== v[i]) { if (!out) out = v.slice(); out[i] = n; }
    }
    return out || v;
  }
  let out = null;
  for (const k of Object.keys(v)) {
    const n = capStrings(v[k], cap, hit);
    if (n !== v[k]) { if (!out) out = { ...v }; out[k] = n; }
  }
  return out || v;
}

function capParams(params, cap = STRING_CAP) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const hit = { cut: false };
  const out = capStrings(p, cap, hit);
  return hit.cut ? { ...out, truncated: true } : out;
}

// The command a person is approving, without the shell Codex wraps it in:
// `/bin/bash -lc 'echo hi > made.txt'` is `echo hi > made.txt` (features/02
// 1.11). Only the exact `<shell> -lc '<one quoted word>'` shape is unwrapped,
// with `'\''` read back as a quote; anything else is shown as it came, since
// a command shown wrong is worse than one shown long. The app-server sends the
// command as one string; an argv (older builds, the rollout) is read too.
const SHELL_WRAP_RE = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+'((?:[^']|'\\'')*)'$/;
function shellCommand(command) {
  const raw = Array.isArray(command) ? command : null;
  // An argv: ['/bin/bash', '-lc', 'script'].
  if (raw && raw.length === 3 && /(?:^|\/)(?:ba|z)?sh$/.test(String(raw[0])) && /^-l?c$/.test(String(raw[1]))) return String(raw[2]);
  const text = raw ? raw.join(' ') : String(command || '');
  const m = SHELL_WRAP_RE.exec(text.trim());
  return m ? m[1].replace(/'\\''/g, "'") : text;
}

// "Approve commands like this for the rest of this turn" (features/02 1.11b).
// A turn that escalates six times should not be six clicks, and the grant that
// replaces them must never become a blanket allow. So "like this" is narrow and
// written down here, once, for the agent that enforces it and the master that
// offers it:
//
//   - the command is ONE simple command: plain words, quotes allowed, and no
//     pipe, redirect, `;`, `&&`, subshell, `$`, backtick, glob or newline, so
//     `npm test && rm -rf ~` is never "like" `npm test`;
//   - it names a program and a first subcommand word (`git status`,
//     `cargo test`, `pytest tests`). For a `run` subcommand the thing it runs is
//     part of it too (`npm run build`, `uv run pytest`), and so is the first
//     plain word after a subcommand that groups others (`git stash drop`,
//     `docker compose down`), so `git stash` never covers `git stash clear`;
//   - neither word runs some OTHER command (sudo, env, xargs, a shell, ssh,
//     find, `npm exec`, `docker exec`...), the program is not one that deletes,
//     moves, copies, fetches or changes permissions (rm, mv, cp, curl,
//     chmod...), and the subcommand does not delete (`git rm`);
//   - it runs in the same folder;
//   - it carries NO FLAG the approved command did not. Plain arguments may
//     differ (another file, another branch), flags may not: `git push` does not
//     cover `git push --force`, `git clean -n` does not cover `git clean -fdx`,
//     `git branch` does not cover `git branch -D`. A flag is any word starting
//     with `-`, compared whole (`--force-with-lease=main` is not
//     `--force-with-lease`); combined short flags count letter by letter (`-fdx`
//     is `-f -d -x`); and a word starting with `+` or `:` counts as one too,
//     since that is how git spells a force push (`+main`) and a remote delete
//     (`:main`). A list of the flags approved rather than a list of dangerous
//     flags, because the next dangerous flag is the one nobody wrote down.
//
// The key says which commands are alike; `flags` says how far a grant reaches.
// The master still runs its guards on every match and asks again for one the
// risk grader scores above what was approved (lib/cloud/codex-native-runner.js).
// Anything else (a flag first, a path, `ls` on its own) has no rule and is asked
// one at a time. Codex's own `acceptWithExecpolicyAmendment` is not used for
// this: it saves a rule to the machine's execpolicy for every future session,
// terminal included, which is "always" and not "this turn"; and acceptForSession
// is Codex's own session cache, which outlives the turn. A "like this" grant is
// answered `accept`, request by request.
//
// Copied from lib/codex-events.js, which keeps its own copy until the legacy
// harness is deleted; the two must not drift before then.
const RULE_CHAR = /^[A-Za-z0-9_./~+:,@%^=-]$/;
const RULE_PROGRAM = /^[A-Za-z0-9_.~/+-]+$/;
const RULE_WORD = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,63}$/;
// Words that run some OTHER command, as a program (`sudo rm`) or a subcommand
// (`npm exec`, `docker exec`, `pnpm dlx`).
const RULE_WRAPPERS = new Set([
  'sudo', 'doas', 'su', 'runuser', 'pkexec', 'env', 'xargs', 'nohup', 'nice', 'ionice', 'time', 'timeout',
  'watch', 'command', 'builtin', 'exec', 'eval', 'source', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'csh',
  'tcsh', 'pwsh', 'powershell', 'cmd', 'ssh', 'find', 'busybox', 'chroot', 'strace', 'parallel', 'stdbuf',
  'unbuffer', 'script', 'flock', 'setsid', 'dlx', 'x', 'shell',
]);
// Programs that delete, move, overwrite, fetch or re-permission.
const RULE_DESTRUCTIVE = new Set([
  'rm', 'rmdir', 'unlink', 'shred', 'dd', 'mkfs', 'mv', 'cp', 'ln', 'install', 'truncate', 'tee', 'chmod',
  'chown', 'chgrp', 'kill', 'killall', 'pkill', 'curl', 'wget', 'scp', 'rsync', 'sftp',
]);
// Subcommands that delete (`git rm`, `docker rm`).
const RULE_DELETE_SUBS = new Set(['rm', 'rmdir', 'unlink', 'shred']);
// Subcommands that group others, whose next plain word is part of the rule.
const RULE_GROUP_SUBS = new Set(['stash', 'remote', 'worktree', 'submodule', 'compose', 'bisect', 'notes', 'reflog']);
const isRuleFlag = (w) => /^[-+:]/.test(w);

// The words of one simple command, quotes removed, or null when it is not one.
function ruleWords(script) {
  const s = String(script || '').trim();
  if (!s || s.length > 2000) return null;
  const words = [];
  let cur = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ' ' || ch === '\t') {
      if (cur !== null) words.push(cur);
      cur = null;
    } else if (ch === "'" || ch === '"') {
      const end = s.indexOf(ch, i + 1);
      if (end < 0) return null;
      const inner = s.slice(i + 1, end);
      if (ch === '"' && /[$`\\!]/.test(inner)) return null; // still expands inside double quotes
      cur = (cur || '') + inner;
      i = end;
    } else if (RULE_CHAR.test(ch)) {
      cur = (cur || '') + ch;
    } else {
      return null;
    }
  }
  if (cur !== null) words.push(cur);
  return words;
}

const ruleName = (word) => String(word).split('/').pop().toLowerCase().replace(/\.exe$/, '');

// { key, label, flags } for a command and the folder it runs in, or null.
function commandRule(command, cwd) {
  const words = ruleWords(command);
  if (!words || words.length < 2) return null;
  const [program, sub] = words;
  if (!RULE_PROGRAM.test(program) || program.startsWith('-')) return null;
  const name = ruleName(program);
  if (RULE_WRAPPERS.has(name) || RULE_DESTRUCTIVE.has(name) || name.startsWith('mkfs')) return null;
  const rest = words.slice(2);
  const parts = [program, sub];
  if (sub === 'run' || RULE_GROUP_SUBS.has(sub)) {
    const at = rest.findIndex((w) => !isRuleFlag(w));
    if (at >= 0) parts.push(rest.splice(at, 1)[0]);
    else if (sub === 'run') return null;
  }
  for (const w of parts.slice(1)) {
    if (!w || !RULE_WORD.test(w)) return null;
    const lower = w.toLowerCase();
    if (RULE_WRAPPERS.has(lower) || RULE_DELETE_SUBS.has(lower)) return null;
  }
  const flags = [];
  for (const w of rest) {
    if (!isRuleFlag(w)) continue;
    const split = /^-[A-Za-z]{2,}$/.test(w) ? [...w.slice(1)].map((ch) => `-${ch}`) : [w];
    for (const f of split) if (!flags.includes(f)) flags.push(f);
  }
  return { key: JSON.stringify([...parts, String(cwd || '')]), label: [...parts, ...flags].join(' '), flags: [...flags].sort() };
}

// A later command is covered by a grant when it is alike (the same key, which
// the caller checks) and every flag it carries was on a command approved.
function ruleCovers(grantedFlags, flags) {
  const have = new Set(Array.isArray(grantedFlags) ? grantedFlags : []);
  return Array.isArray(flags) && flags.every((f) => have.has(f));
}

// The answers a request offers, as Codex lists them. With experimentalApi on (it
// always is: lib/codex-rpc.js) a command approval carries `availableDecisions`;
// without it, the set Codex's own core falls back to
// (codex-rs/protocol/src/approvals.rs default_available_decisions), where its
// Abort is the app-server's `cancel`. A file change has no such field and offers
// the whole FileChangeApprovalDecision enum; an elicitation its three actions.
// The other two methods are answered with data, not a choice, and offer none.
function defaultDecisions(method, params = {}) {
  if (method === 'item/commandExecution/requestApproval') {
    if (Array.isArray(params.availableDecisions) && params.availableDecisions.length) return params.availableDecisions;
    if (params.networkApprovalContext) {
      const allow = Array.isArray(params.proposedNetworkPolicyAmendments)
        ? params.proposedNetworkPolicyAmendments.find((a) => a && a.action === 'allow') : null;
      return ['accept', 'acceptForSession', ...(allow ? [{ applyNetworkPolicyAmendment: { network_policy_amendment: allow } }] : []), 'cancel'];
    }
    if (params.additionalPermissions) return ['accept', 'cancel'];
    return ['accept', ...(params.proposedExecpolicyAmendment ? [{ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } }] : []), 'cancel'];
  }
  if (method === 'item/fileChange/requestApproval') return ['accept', 'acceptForSession', 'decline', 'cancel'];
  if (method === 'mcpServer/elicitation/request') return ['accept', 'decline', 'cancel'];
  return null;
}

// Decisions compared as values: an amendment object comes back from the master as
// a copy, so key order is not identity.
function canonical(v) {
  if (!v || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
const offered = (decisions, d) => d != null && Array.isArray(decisions) && decisions.some((x) => canonical(x) === canonical(d));
const isAccept = (d) => d === 'accept' || d === 'acceptForSession'
  || (d && typeof d === 'object' && ('acceptWithExecpolicyAmendment' in d || 'applyNetworkPolicyAmendment' in d));
// What a refusal is for a decision-enum request: decline (the turn goes on) when
// the request offers it, else cancel, which is the only no Codex left on the list.
const refusalOf = (decisions) => (offered(decisions, 'decline') ? 'decline' : 'cancel');

// A permissions grant is the request's own profile, or the parts of it the master
// names. Never the master's content: it chooses which of what was asked it grants,
// and cannot grant what was not asked.
function grantFrom(requested, chosen) {
  const req = requested && typeof requested === 'object' ? requested : {};
  const out = {};
  for (const k of ['network', 'fileSystem']) {
    if (req[k] == null) continue;
    if (chosen === true || chosen == null || (chosen && typeof chosen === 'object' && chosen[k] != null && chosen[k] !== false)) out[k] = req[k];
  }
  return out;
}

// The question ids a request asked, and each answer coerced to the strings the
// reply type wants: a malformed answer must not error the RPC.
function answersFor(questions, given) {
  const ids = new Set((Array.isArray(questions) ? questions : []).map((q) => q && q.id).filter((id) => typeof id === 'string'));
  const out = {};
  if (!given || typeof given !== 'object') return out;
  for (const [k, v] of Object.entries(given)) {
    if (!ids.has(k)) continue;
    const arr = v && typeof v === 'object' && Array.isArray(v.answers) ? v.answers : Array.isArray(v) ? v : [v];
    out[k] = { answers: arr.filter((a) => a != null).map(String).slice(0, 20) };
  }
  return out;
}

// What Codex is blocked on, replied to with the answer that means "no" for each
// method. `cancelled` is the run ending under it (Stop, the turn over, the server
// leaving), which for a decision enum is `cancel`: there is no turn left to go on.
function refusalReply(p, why = 'cancel') {
  switch (p.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { id: p.rpcId, result: { decision: why === 'cancel' ? 'cancel' : refusalOf(p.decisions) } };
    case 'item/tool/requestUserInput':
      return { id: p.rpcId, result: { answers: {} } };
    case 'mcpServer/elicitation/request':
      return { id: p.rpcId, result: { action: why === 'cancel' ? 'cancel' : 'decline', content: null, _meta: null } };
    default:
      return { id: p.rpcId, error: { code: REFUSED, message: why === 'cancel' ? 'The turn ended in Termdeck' : 'Denied in Termdeck' } };
  }
}

// What a person is shown, in Codex's words. `input` is the short form the shared
// card frame lists; the request itself rides whole as `codex`.
function card(method, params) {
  const why = typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim() : null;
  switch (method) {
    case 'item/commandExecution/requestApproval': {
      const command = shellCommand(params.command);
      const c = { preview: command, description: why, input: { command, cwd: params.cwd || null } };
      const rule = commandRule(command, params.cwd);
      if (rule) c.likeRule = rule;
      return c;
    }
    case 'item/fileChange/requestApproval':
      return { preview: why || params.grantRoot || 'file changes', input: { reason: why, grantRoot: params.grantRoot || null } };
    case 'item/permissions/requestApproval':
      return { preview: why || 'additional permissions', description: why, input: { permissions: params.permissions || {}, cwd: params.cwd || null } };
    case 'item/tool/requestUserInput': {
      const questions = Array.isArray(params.questions) ? params.questions : [];
      return { preview: questions.map((q) => (q && (q.question || q.header)) || '').filter(Boolean).join(' · '), input: { questions }, questions };
    }
    case 'mcpServer/elicitation/request': {
      const text = params.message || params.title || params.description || '';
      return { preview: `${params.serverName || 'MCP server'}: ${text}`.slice(0, 2000), input: { serverName: params.serverName || null, mode: params.mode || null } };
    }
    default:
      return { input: {} };
  }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// thread/tokenUsage/updated -> usage, in Codex's field names. `total` carries the
// notification's own { last, total, modelContextWindow }: `last` is the latest
// request's breakdown, `total` the thread's running sum. The two generic fields
// the shared context meter reads are derived the way Codex's TUI derives them
// (TokenUsage::tokens_in_context_window is the last request's totalTokens).
function usageEvent(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  const last = tokenUsage.last && typeof tokenUsage.last === 'object' ? tokenUsage.last : null;
  const total = tokenUsage.total && typeof tokenUsage.total === 'object' ? tokenUsage.total : null;
  if (!last && !total) return null;
  const ev = { type: 'usage', total: { last, total, modelContextWindow: num(tokenUsage.modelContextWindow) } };
  const inContext = last ? (num(last.totalTokens) ?? ((num(last.inputTokens) || 0) + (num(last.outputTokens) || 0))) : null;
  if (inContext != null) ev.contextTokens = inContext;
  if (num(tokenUsage.modelContextWindow) != null) ev.contextWindow = tokenUsage.modelContextWindow;
  return ev;
}

// A worker's name, as the card says who is asking: its nickname, else its role,
// else the leaf of the agent path the parent gave it (`/root/summarize_math`).
function workerName(meta) {
  if (!meta) return null;
  for (const v of [meta.nickname, meta.role]) if (typeof v === 'string' && v.trim() && v !== 'default') return v.trim().slice(0, 80);
  const leaf = typeof meta.agentPath === 'string' ? meta.agentPath.split('/').filter(Boolean).pop() : '';
  return leaf && leaf !== 'root' ? leaf.replace(/_/g, ' ').slice(0, 80) : null;
}

function createCodexTurn({ threadId = null } = {}) {
  let tid = threadId;
  let turnId = null;
  let started = false;
  let ended = false;
  let aborted = false;
  let errorText = null;
  let compacting = false;
  let lastMessage = null;
  let plan = null;              // the text of the turn's last completed plan item
  const planDeltas = new Map(); // plan itemId -> streamed text, for a plan the turn ended inside of
  const open = new Map();       // own agentMessage itemId -> streamed text, until it completes
  const pending = new Map();    // requestId -> { method, params, rpcId, decisions, rule }
  const turnRules = new Map();  // commandRule key -> [the flags of each command allowed "like this" this turn]
  const subTurns = new Map();   // sub-agent threadId -> its running turn id
  const workers = new Map();    // sub-agent threadId -> { nickname, role, agentPath }

  const out = (events = [], replies = []) => ({ events, replies, ended });
  const own = (params) => !params || !params.threadId || !tid || params.threadId === tid;
  const passthrough = (events, method, params) => {
    if (forwarded(method)) events.push({ type: 'codex.event', method, params: capParams(params) });
  };

  // Every card still open is answered, so the app-server is never left blocked on a
  // request for a turn that is over.
  function settleAll(events, replies, outcome, write = true) {
    for (const [requestId, p] of pending) {
      if (write) replies.push(refusalReply(p, 'cancel'));
      events.push({ type: 'approval.resolved', requestId, outcome });
    }
    pending.clear();
  }

  function finish(events, replies, status, error, turn, { write = true } = {}) {
    if (ended) return;
    settleAll(events, replies, 'run-ended', write);
    // A compaction the turn ended inside of did not finish: say so, with the
    // reason when there is one ("Error running remote compact task: ...").
    if (compacting) {
      compacting = false;
      const why = error || errorText;
      events.push({ type: 'compaction', phase: 'end', result: 'failed', ...(why ? { error: String(why) } : {}) });
    }
    const fin = { type: 'run.finished', status };
    if (status === 'error') fin.error = error || errorText || 'Codex turn failed';
    const ms = turn ? num(turn.durationMs) : null;
    if (ms != null) fin.durationMs = ms;
    if (status === 'ok' && lastMessage) fin.lastMessage = lastMessage;
    const detail = { turnId: turnId || (turn && turn.id) || null, turnStatus: (turn && turn.status) || null };
    const planText = plan || [...planDeltas.values()].filter(Boolean).pop() || null;
    if (planText && planText.trim()) detail.plan = planText;
    fin.detail = detail;
    events.push(fin);
    ended = true;
  }

  function bound(id, { cwd = null, transcriptPath = null } = {}) {
    tid = id;
    const ev = { type: 'session.bound', sessionId: id };
    if (cwd) ev.cwd = cwd;
    if (transcriptPath) ev.transcriptPath = transcriptPath;
    return out([ev]);
  }

  // turn/start's answer names the turn before turn/started may have arrived, which
  // is all steer and Stop are waiting for.
  function acknowledged(turn) {
    if (!turnId && turn && typeof turn.id === 'string' && turn.id) turnId = turn.id;
    return out();
  }

  function subagentNotification(events, method, params) {
    const sub = params.threadId || (params.thread && params.thread.id) || null;
    if (!sub) return;
    if (method === 'thread/started' && params.thread) {
      const t = params.thread;
      workers.set(sub, { ...(workers.get(sub) || {}), nickname: t.agentNickname || null, role: t.agentRole || null });
    }
    if (method === 'turn/started' && params.turn && params.turn.id) subTurns.set(sub, params.turn.id);
    if (method === 'turn/completed') subTurns.delete(sub);
    passthrough(events, method, params);
  }

  function notification(method, params = {}) {
    const events = [];
    const replies = [];
    if (ended) return out();
    const p = params && typeof params === 'object' ? params : {};
    if (method === 'thread/started' ? !!(p.thread && p.thread.parentThreadId && p.thread.id !== tid) : !own(p)) {
      subagentNotification(events, method, p);
      return out(events, replies);
    }
    // The run's own thread announcing itself is not news to this run.
    if (method === 'thread/started') return out();
    passthrough(events, method, p);
    switch (method) {
      case 'turn/started': {
        if (!turnId && p.turn && p.turn.id) turnId = p.turn.id;
        if (!started) {
          started = true;
          events.push({ type: 'run.status', status: 'running' });
        }
        break;
      }
      case 'item/started': {
        const item = p.item || {};
        if (item.type === 'contextCompaction' && !compacting) {
          // features/02 4.6c: the same running/end pair Claude's status frames give.
          compacting = true;
          events.push({ type: 'compaction', phase: 'running' }, { type: 'run.status', status: 'compacting' });
        } else if (item.type === 'agentMessage' && item.id) {
          open.set(item.id, typeof item.text === 'string' ? item.text : '');
        }
        break;
      }
      case 'item/agentMessage/delta':
        if (p.itemId && typeof p.delta === 'string') open.set(p.itemId, (open.get(p.itemId) || '') + p.delta);
        break;
      case 'item/plan/delta':
        if (p.itemId && typeof p.delta === 'string') planDeltas.set(p.itemId, (planDeltas.get(p.itemId) || '') + p.delta);
        break;
      case 'item/completed': {
        const item = p.item || {};
        if (item.type === 'contextCompaction') {
          if (compacting) {
            compacting = false;
            events.push({ type: 'compaction', phase: 'end', result: 'success' }, { type: 'run.status', status: pending.size ? 'awaiting-permission' : 'running' });
          }
        } else if (item.type === 'agentMessage') {
          const text = typeof item.text === 'string' ? item.text : open.get(item.id) || '';
          open.delete(item.id);
          if (text.trim()) lastMessage = text.trim();
        } else if (item.type === 'plan') {
          planDeltas.delete(item.id);
          if (typeof item.text === 'string' && item.text.trim()) plan = item.text;
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const ev = usageEvent(p.tokenUsage);
        if (ev) events.push(ev);
        break;
      }
      // Codex settled a request itself (an auto-review, the turn ending under it):
      // the card has nothing left to answer.
      case 'serverRequest/resolved': {
        for (const [requestId, q] of pending) {
          if (String(q.rpcId) !== String(p.requestId)) continue;
          pending.delete(requestId);
          events.push({ type: 'approval.resolved', requestId, outcome: 'cancelled' });
          if (!pending.size) events.push({ type: 'run.status', status: compacting ? 'compacting' : 'running' });
        }
        break;
      }
      case 'turn/completed': {
        const turn = p.turn || {};
        if (turnId && turn.id && turn.id !== turnId) break; // not this run's turn
        const st = turn.status;
        const status = aborted || st === 'interrupted' ? 'aborted' : st === 'failed' ? 'error' : 'ok';
        const err = turn.error ? turn.error.message || String(turn.error) : null;
        finish(events, replies, status, err, turn);
        break;
      }
      case 'error': {
        const message = (p.error && p.error.message) || String(p.error || 'codex error');
        if (p.willRetry) events.push({ type: 'notice', level: 'warn', code: 'api_retry', message });
        else errorText = message;
        break;
      }
      default:
        break;
    }
    return out(events, replies);
  }

  function request(rpcId, method, params = {}) {
    const p = params && typeof params === 'object' ? params : {};
    const toolName = CARDS[method];
    if (!toolName) return out([], [{ id: rpcId, error: { code: REFUSED, message: `Termdeck does not handle ${method}` } }]);
    const entry = { method, params: p, rpcId, decisions: defaultDecisions(method, p), rule: null };
    if (ended) return out([], [refusalReply(entry, 'cancel')]);
    const c = card(method, p);
    const requestId = `codex-${rpcId}`;
    entry.rule = c.likeRule || null;
    pending.set(requestId, entry);
    const ev = { type: 'approval.requested', requestId, toolName, input: c.input };
    if (c.preview) ev.preview = c.preview;
    if (c.description) ev.description = c.description;
    if (c.questions) ev.questions = c.questions;
    if (c.likeRule) {
      // Offered, and (when a person already said yes to one like it this turn)
      // vouched for. The master still runs its guards first and must hold the
      // same grant itself before it answers without asking.
      ev.likeRule = c.likeRule;
      const granted = turnRules.get(c.likeRule.key) || [];
      if (granted.some((flags) => ruleCovers(flags, c.likeRule.flags))) ev.turnRule = c.likeRule.key;
    }
    // A worker's request is this run's to answer: the person is watching the chat
    // that spawned it, and nobody is watching the worker's thread.
    if (!own(p)) {
      const who = `Sub-agent ${workerName(workers.get(p.threadId)) || 'Codex'}`;
      ev.description = ev.description ? `${who}: ${ev.description}` : `${who} asks`;
    }
    ev.codex = { method, params: capParams(p) };
    if (entry.decisions) ev.decisions = entry.decisions;
    return out([ev, { type: 'run.status', status: 'awaiting-permission' }]);
  }

  // The master's decision -> the reply Codex is blocked on (docs/codex-native.md,
  // "Server request -> card -> reply"). `{ behavior, scope }` is the shared
  // broker's own shape, read too, so a card the master answers through the shared
  // plumbing (a timeout, a policy) still means the same thing here.
  function answer(requestId, decision) {
    const p = pending.get(requestId);
    if (!p) return out(); // already settled: a second copy of an answer is harmless
    pending.delete(requestId);
    const d = decision && typeof decision === 'object' ? decision : {};
    const allowCompat = d.behavior === 'allow';
    let reply;
    let outcome;
    if (d.cancelled || d.timedOut) {
      reply = refusalReply(p, d.cancelled ? 'cancel' : 'deny');
      outcome = d.cancelled ? 'cancelled' : 'timeout';
    } else {
      switch (p.method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval': {
          let want = d.codexDecision;
          if (want === undefined && d.behavior) want = allowCompat ? (d.scope === 'session' ? 'acceptForSession' : 'accept') : refusalOf(p.decisions);
          // A decision the request did not offer is refused, so a master cannot
          // widen what Codex asked.
          const ok = offered(p.decisions, want);
          const value = ok ? want : refusalOf(p.decisions);
          // "Like this, for this turn": the rule is the one derived from the
          // request raised here, never one the answer describes, and it lives on
          // this follower, which follows one turn, so it ends with the turn.
          if (ok && value === 'accept' && p.rule && d.scope === 'turn') {
            if (!turnRules.has(p.rule.key)) turnRules.set(p.rule.key, []);
            turnRules.get(p.rule.key).push(p.rule.flags);
          }
          reply = { id: p.rpcId, result: { decision: value } };
          outcome = ok && isAccept(value) ? 'allow' : 'deny';
          break;
        }
        case 'item/permissions/requestApproval': {
          const granted = d.permissions !== undefined || allowCompat;
          if (granted && d.permissions !== false) {
            reply = { id: p.rpcId, result: { permissions: grantFrom(p.params.permissions, d.permissions === undefined ? true : d.permissions), scope: d.scope === 'session' ? 'session' : 'turn' } };
            outcome = 'allow';
          } else {
            reply = { id: p.rpcId, error: { code: REFUSED, message: typeof d.message === 'string' && d.message ? d.message.slice(0, 500) : 'Denied in Termdeck' } };
            outcome = 'deny';
          }
          break;
        }
        case 'item/tool/requestUserInput': {
          const answers = answersFor(p.params.questions, d.answers);
          reply = { id: p.rpcId, result: { answers } };
          outcome = Object.keys(answers).length ? 'answered' : 'deny';
          break;
        }
        case 'mcpServer/elicitation/request': {
          let action = typeof d.action === 'string' ? d.action : allowCompat ? 'accept' : 'decline';
          if (!['accept', 'decline', 'cancel'].includes(action)) action = 'decline';
          reply = { id: p.rpcId, result: { action, content: action === 'accept' && d.content !== undefined ? d.content : null, _meta: null } };
          outcome = action === 'accept' ? 'allow' : action === 'cancel' ? 'cancelled' : 'deny';
          break;
        }
        default:
          reply = refusalReply(p, 'deny');
          outcome = 'deny';
      }
    }
    const events = [{ type: 'approval.resolved', requestId, outcome }];
    if (!pending.size && !ended) events.push({ type: 'run.status', status: compacting ? 'compacting' : 'running' });
    return out(events, [reply]);
  }

  function subagentMeta(id, meta = {}) {
    if (id) workers.set(id, { ...(workers.get(id) || {}), ...meta });
    return out();
  }

  function abort() {
    aborted = true;
  }

  function fail(message, detail = null) {
    const events = [];
    const replies = [];
    if (!ended) {
      finish(events, replies, aborted ? 'aborted' : 'error', message, null);
      const fin = events[events.length - 1];
      if (detail) fin.detail = { ...fin.detail, ...detail };
    }
    return out(events, replies);
  }

  function exit({ code = null, error = null } = {}) {
    const why = error || `codex app-server exited${code != null ? ` (code ${code})` : ''}`;
    const events = [];
    // Nobody is left to read a reply.
    if (!ended) finish(events, [], aborted ? 'aborted' : 'error', why, null, { write: false });
    return out(events, []);
  }

  // The reply text whose item never completed: what a Stop cut off mid-stream.
  // Codex writes an agentMessage to the rollout only when the item completes, so
  // the harness hands this back to the thread (thread/inject_items).
  const unfinishedText = () => [...open.values()].join('\n').trim();

  return {
    bound,
    acknowledged,
    notification,
    request,
    answer,
    subagentMeta,
    abort,
    fail,
    exit,
    unfinishedText,
    get threadId() { return tid; },
    get turnId() { return turnId; },
    get started() { return started; },
    get ended() { return ended; },
    get aborted() { return aborted; },
    pendingApprovals: () => pending.size,
    // Sub-agent turns still running for this run, [threadId, turnId], for Stop.
    subagentTurns: () => [...subTurns.entries()],
    worker: (id) => workers.get(id) || null,
  };
}

module.exports = {
  STRING_CAP,
  CARDS,
  forwarded,
  capParams,
  shellCommand,
  commandRule,
  ruleCovers,
  defaultDecisions,
  usageEvent,
  workerName,
  createCodexTurn,
};
