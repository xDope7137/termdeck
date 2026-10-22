'use strict';

// Codex's half of the engine adapter: `codex app-server` JSON-RPC in, engine
// events out (lib/engine-events.js). Pure, like lib/claude-events.js: no process,
// no timer, no socket, so the contract tests can feed it recorded lines.
//
// One translator follows ONE TURN on one thread. The app-server is shared by every
// thread on the machine (agent/engine-runs.js routes each line to the run whose
// threadId it names), so nothing here may assume the lines it sees are the only
// traffic on the connection.
//
// The driver calls:
//
//   bound(threadId, { cwd })        the thread is resumed or started -> session.bound
//   notification(method, params)    one notification for this thread -> { events, ended }
//   request(method, params, rpcId)  one server request for this thread -> { events, writes }
//   answer(requestId, decision)     the master's decision on an approval -> { events, writes }
//   abort()                         Stop was pressed; the finish reports 'aborted'
//   fail(message, detail)           the turn never started (resume refused, turn/start rejected)
//   exit({ code, error })           the app-server is gone
//
// `writes` are JSON-RPC messages the driver must put on the app-server's stdin.
//
// What deliberately stays OUT of here and on the master: whether an approval is
// answered by a policy, a remembered "allow for this chat" or a person. The
// broker that decides is owner-scoped and lives on the master (lib/approval-broker.js),
// so every approval is raised as an event and the master answers it, even the ones
// it answers in a millisecond.

const { inputPreview } = require('./transcript');

// thread item type -> block kind. Types absent here (plan deltas,
// subAgentActivity...) get no block, matching the disk parser's whitelist so the
// browser's settle/pop counts stay aligned with the rollout. A webSearch item is
// the rollout's web_search_call, which the disk parser reads as one web_search
// call too.
const ITEM_KINDS = {
  agentMessage: 'text',
  reasoning: 'thinking',
  commandExecution: 'tool_use',
  fileChange: 'tool_use',
  mcpToolCall: 'tool_use',
  dynamicToolCall: 'tool_use',
  collabAgentToolCall: 'tool_use',
  webSearch: 'tool_use',
};

// A worker's names, as the sub-agents list and its live row both say them. Its
// task is the last segment of the agent path the parent gave it
// (`/root/summarize_math` is "summarize math"); its kind is the role it was
// spawned as, else the nickname Codex gave it, which is what the parent's own
// rows call it.
function agentTaskName(agentPath) {
  const leaf = typeof agentPath === 'string' ? agentPath.split('/').filter(Boolean).pop() : '';
  return leaf && leaf !== 'root' ? leaf.replace(/_/g, ' ').slice(0, 120) : '';
}
const agentKind = (role, nickname) => [role, nickname].find((v) => typeof v === 'string' && v.trim() && v !== 'default') || '';

// The task type a Codex sub-agent's telemetry carries, so the browser keys its
// row by the worker's thread id (public/js/subagents.js onTaskEvent).
const CODEX_AGENT_TASK = 'codex_agent';

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
  'item/permissions/requestApproval',
]);

function itemToolName(item) {
  if (item.type === 'commandExecution') return 'shell';
  if (item.type === 'fileChange') return 'apply_patch';
  if (item.type === 'mcpToolCall') return item.tool || 'mcp';
  if (item.type === 'webSearch') return 'web_search';
  return item.tool || item.type;
}

function itemPreviewText(item) {
  if (item.type === 'commandExecution') return shellCommand(item.command);
  if (item.type === 'fileChange') {
    const files = Array.isArray(item.changes) ? item.changes.map((c) => c.path || '').filter(Boolean) : [];
    return files.join(', ');
  }
  if (item.type === 'webSearch') {
    const a = item.action && typeof item.action === 'object' ? item.action : {};
    return String(item.query || a.query || a.url || '');
  }
  if (item.arguments) {
    try {
      return inputPreview(item.tool, typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments);
    } catch {}
  }
  return '';
}

// The command a person is approving, without the shell Codex wraps it in:
// `/bin/bash -lc 'echo hi > made.txt'` is `echo hi > made.txt` (features/02
// 1.11). Only the exact `<shell> -lc '<one quoted word>'` shape is unwrapped,
// with `'\''` read back as a quote; anything else is shown as it came, since
// a command shown wrong is worse than one shown long.
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
// risk grader scores above what was approved (lib/cloud/agent-codex-runner.js
// turnRuleDecision). Anything else (a flag first, a path, `ls` on its own) has
// no rule and is asked one at a time. Codex's
// own `acceptWithExecpolicyAmendment` is not used for this: it saves a rule to
// the machine's execpolicy for every future session, terminal included, which is
// "always" and not "this turn".
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

// { key, label } for a command and the folder it runs in, or null.
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

// What a person is shown for each of the four approval RPCs. `reason` is the
// model's own justification for asking (the `justification` it passed with the
// escalation), and it is the card's WHY rather than a field in its input dump.
function approvalCard(method, params) {
  const why = typeof params.reason === 'string' && params.reason.trim() ? params.reason.trim() : null;
  if (method === 'item/commandExecution/requestApproval') {
    const command = shellCommand(params.command);
    const card = { toolName: 'shell', preview: command, description: why, detail: { command, cwd: params.cwd } };
    const rule = commandRule(command, params.cwd);
    if (rule) card.likeRule = rule;
    return card;
  }
  if (method === 'item/fileChange/requestApproval') {
    return { toolName: 'apply_patch', preview: params.reason || params.grantRoot || 'file changes', detail: params };
  }
  if (method === 'item/tool/requestUserInput') {
    return { toolName: 'input requested', preview: (params.questions || []).map((q) => q.question || q.header || '').join(' · '), detail: params, questions: params.questions || [] };
  }
  return { toolName: 'permissions', preview: params.reason || 'additional permissions', detail: params };
}

// A decision -> the JSON-RPC reply the app-server is blocked on. Deny, timeout and
// cancel all come out as the refusal each method understands.
function approvalReply(method, params, rpcId, decision) {
  const allow = decision && decision.behavior === 'allow';
  if (method === 'item/tool/requestUserInput') {
    // Deny/timeout/cancel -> {} ("no input provided"). A malformed answer from the
    // browser must not error the RPC, so every value is coerced to strings.
    const answers = {};
    if (allow && decision.answers && typeof decision.answers === 'object') {
      for (const [k, v] of Object.entries(decision.answers)) {
        const arr = v && Array.isArray(v.answers) ? v.answers : [String(v ?? '')];
        answers[k] = { answers: arr.map(String) };
      }
    }
    return { jsonrpc: '2.0', id: rpcId, result: { answers } };
  }
  if (method === 'item/permissions/requestApproval') {
    if (allow) return { jsonrpc: '2.0', id: rpcId, result: { permissions: params.permissions || {}, scope: 'turn' } };
    return { jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: (decision && decision.message) || 'Denied in Termdeck' } };
  }
  // command execution and file change share the decision enum
  const d = !decision || decision.cancelled || decision.timedOut ? 'decline' : allow ? (decision.scope === 'session' ? 'acceptForSession' : 'accept') : 'decline';
  return { jsonrpc: '2.0', id: rpcId, result: { decision: d } };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function usageNumbers(src) {
  if (!src || typeof src !== 'object') return null;
  const out = {
    inputTokens: num(src.inputTokens ?? src.input_tokens),
    outputTokens: num(src.outputTokens ?? src.output_tokens),
    cacheReadTokens: num(src.cachedInputTokens ?? src.cached_input_tokens),
  };
  for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return Object.keys(out).length ? out : null;
}

function contextWindowOf(u) {
  if (!u || typeof u !== 'object') return null;
  for (const src of [u, u.last, u.total]) {
    if (!src || typeof src !== 'object') continue;
    const v = src.contextWindow ?? src.modelContextWindow ?? src.model_context_window;
    if (v != null && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

// thread/tokenUsage/updated -> usage. `last` is this request's own counts, which is
// what fills the context window; `total` is the thread's running sum.
function usageEvent(tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== 'object') return null;
  const last = usageNumbers(tokenUsage.last) || usageNumbers(tokenUsage);
  const total = usageNumbers(tokenUsage.total);
  if (!last && !total) return null;
  const ev = { type: 'usage', ...(last || {}) };
  if (last && last.inputTokens != null) ev.contextTokens = last.inputTokens;
  const cw = contextWindowOf(tokenUsage);
  if (cw != null) ev.contextWindow = cw;
  if (total) ev.total = total;
  return ev;
}

function durationOf(turn) {
  const v = turn && (turn.durationMs ?? turn.duration_ms);
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
}

function createCodexTranslator({ threadId = null } = {}) {
  let tid = threadId;
  let turnId = null;
  let messageId = null;
  let started = false;
  let ended = false;
  let aborted = false;
  let errorText = null;
  let compacting = false; // a contextCompaction item is open
  let planText = '';
  const blocks = [];           // { index, kind, text, stopped }
  const itemBlock = new Map(); // block key (an itemId, or itemId#part) -> block index
  const itemBlocks = new Map(); // itemId -> every block index it opened
  const summaryPart = new Map(); // reasoning itemId -> the summary part being written
  const pending = new Map();   // requestId -> { method, params, rpcId, rule }
  const turnRules = new Map(); // commandRule key -> [the flags of each command a person allowed "like this" this turn]
  const agents = new Map();    // sub-agent threadId -> { name, toolUses, lastText } (subagentNotification)

  const out = (events = [], writes = [], extra = {}) => ({ events, writes, ended: false, ...extra });

  function openMessage(events) {
    if (messageId) return;
    messageId = turnId ? `turn:${turnId}` : `turn:pending:${tid || 'new'}`;
    events.push({ type: 'message.started', messageId });
  }

  function blockFor(events, itemId, kind, toolName, key = itemId) {
    let idx = itemBlock.get(key);
    if (idx === undefined) {
      openMessage(events);
      idx = blocks.length;
      itemBlock.set(key, idx);
      if (!itemBlocks.has(itemId)) itemBlocks.set(itemId, []);
      itemBlocks.get(itemId).push(idx);
      blocks.push({ index: idx, kind, toolName: toolName || null, text: '', stopped: false });
    }
    return blocks[idx];
  }

  // Each reasoning summary part is its own thinking block, as the rollout
  // parse reads it (lib/transcript.js codexThought): joined, the parts ran
  // together on one row (features/02 1.10), and a different block count would
  // pop the wrong streamed blocks. The app-server numbers the parts; a frame
  // without the number goes to the part last opened.
  function thoughtBlock(events, params) {
    const part = Number.isInteger(params.summaryIndex) ? params.summaryIndex : (summaryPart.get(params.itemId) || 0);
    return blockFor(events, params.itemId, 'thinking', null, part ? `${params.itemId}#${part}` : params.itemId);
  }

  function delta(events, block, text) {
    if (!text) return;
    block.text += text;
    const ev = { type: 'block.delta', messageId, blockIndex: block.index, kind: block.kind, delta: text };
    if (block.toolName) ev.toolName = block.toolName;
    events.push(ev);
  }

  // Every approval still open when the turn ends is answered as cancelled, so the
  // app-server is never left blocked on a request for a turn that is over.
  function settleAll(events, writes, outcome) {
    for (const [requestId, p] of pending) {
      writes.push(approvalReply(p.method, p.params, p.rpcId, { cancelled: true }));
      events.push({ type: 'approval.resolved', requestId, outcome });
    }
    pending.clear();
  }

  // The reply text whose item never completed: what a Stop cut off mid-stream.
  // A completed agentMessage is on disk already; this one Codex drops, so the
  // agent hands it back to the thread (agent/engine-runs.js codexKeepPartial).
  function unfinishedText() {
    return blocks.filter((b) => b.kind === 'text' && !b.stopped).map((b) => b.text).join('\n').trim();
  }

  function lastMessage() {
    const text = blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n').trim();
    return text || null;
  }

  function finish(events, writes, status, error, turn) {
    if (ended) return;
    ended = true;
    settleAll(events, writes, 'run-ended');
    // A compaction the turn ended inside of did not finish: say so, with the
    // reason when there is one ("Error running remote compact task: ...").
    if (compacting) {
      compacting = false;
      const why = error || errorText;
      events.push({ type: 'compaction', phase: 'end', result: 'failed', ...(why ? { error: String(why) } : {}) });
    }
    for (const b of blocks) {
      if (!b.stopped) { b.stopped = true; events.push({ type: 'block.stopped', messageId, blockIndex: b.index }); }
    }
    if (messageId) events.push({ type: 'message.stopped', messageId });
    const fin = { type: 'run.finished', status };
    if (status === 'error') fin.error = error || errorText || 'Codex turn failed';
    const ms = durationOf(turn);
    if (ms != null) fin.durationMs = ms;
    const last = status === 'ok' ? lastMessage() : null;
    if (last) fin.lastMessage = last;
    const detail = {};
    if (planText.trim()) detail.plan = planText;
    if (turnId) detail.turnId = turnId;
    if (turn && turn.status) detail.turnStatus = turn.status;
    if (Object.keys(detail).length) fin.detail = detail;
    events.push(fin);
  }

  function bound(id, { cwd = null, transcriptPath = null } = {}) {
    tid = id;
    const ev = { type: 'session.bound', sessionId: id };
    if (cwd) ev.cwd = cwd;
    if (transcriptPath) ev.transcriptPath = transcriptPath;
    return out([ev]);
  }

  function notification(method, params = {}) {
    const events = [];
    const writes = [];
    if (ended) return out();
    switch (method) {
      case 'turn/started': {
        turnId = (params.turn && params.turn.id) || turnId;
        if (!started) {
          started = true;
          events.push({ type: 'run.status', status: 'running' });
        }
        // Same key the disk parser synthesizes from event_msg/task_started, which is
        // what lets the browser pop settled blocks when the rollout catches up.
        if (!messageId && turnId) openMessage(events);
        break;
      }
      case 'item/started': {
        const item = params.item || {};
        if (item.type === 'subAgentActivity') {
          agentActivity(events, item);
          break;
        }
        if (item.type === 'contextCompaction') {
          // features/02 4.6c. A compaction is no block (the rollout writes it as a
          // `compacted` record, which the parse draws as the divider); live it is
          // the same running/end pair Claude's status frames give.
          if (!compacting) {
            compacting = true;
            events.push({ type: 'compaction', phase: 'running' }, { type: 'run.status', status: 'compacting' });
          }
          break;
        }
        const kind = ITEM_KINDS[item.type];
        if (!kind) break;
        const toolName = kind === 'tool_use' ? itemToolName(item) : null;
        const block = blockFor(events, item.id, kind, toolName);
        if (kind === 'tool_use') {
          const preview = itemPreviewText(item);
          delta(events, block, preview);
          const ev = { type: 'tool.started', toolCallId: String(item.id), toolName };
          if (preview) ev.preview = preview;
          events.push(ev);
        }
        break;
      }
      case 'item/agentMessage/delta':
        delta(events, blockFor(events, params.itemId, 'text', null), params.delta);
        break;
      case 'item/commandExecution/outputDelta': {
        // A running command's output as it prints (bugs.md B7). The run registry
        // paces these; the result still arrives whole with item/completed.
        if (!params.itemId || typeof params.delta !== 'string' || !params.delta) break;
        const ev = { type: 'tool.output', toolCallId: String(params.itemId), text: params.delta };
        const idx = itemBlock.get(params.itemId);
        if (idx !== undefined) ev.blockIndex = idx;
        events.push(ev);
        break;
      }
      case 'item/plan/delta':
        // The proposed plan settles on disk as its own message; it only matters here
        // for the "Implement this plan?" confirm the master raises after the turn.
        planText += params.delta || '';
        break;
      case 'item/reasoning/summaryTextDelta':
        delta(events, thoughtBlock(events, params), params.delta);
        break;
      case 'item/reasoning/summaryPartAdded': {
        // The next part opens its own block with its first delta.
        const cur = summaryPart.get(params.itemId) || 0;
        const idx = itemBlock.get(cur ? `${params.itemId}#${cur}` : params.itemId);
        const next = Number.isInteger(params.summaryIndex) ? params.summaryIndex
          : idx !== undefined && blocks[idx].text ? cur + 1 : cur;
        summaryPart.set(params.itemId, next);
        break;
      }
      case 'item/completed': {
        const item = params.item || {};
        if (item.type === 'contextCompaction') {
          if (compacting) {
            compacting = false;
            events.push({ type: 'compaction', phase: 'end', result: 'success' }, { type: 'run.status', status: 'running' });
          }
          break;
        }
        const opened = itemBlocks.get(item.id);
        if (!opened) break;
        for (const idx of opened) {
          if (blocks[idx].stopped) continue;
          blocks[idx].stopped = true;
          events.push({ type: 'block.stopped', messageId, blockIndex: idx });
        }
        const block = blocks[opened[0]];
        if (block.kind === 'tool_use') {
          const failed = item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0);
          events.push({ type: 'tool.finished', toolCallId: String(item.id), ok: !failed });
        }
        break;
      }
      case 'thread/tokenUsage/updated': {
        const ev = usageEvent(params.tokenUsage);
        if (ev) events.push(ev);
        break;
      }
      case 'turn/completed': {
        const turn = params.turn || {};
        const st = turn.status;
        const status = aborted || st === 'interrupted' ? 'aborted' : st === 'failed' ? 'error' : 'ok';
        const err = turn.error ? turn.error.message || String(turn.error) : null;
        finish(events, writes, status, err, turn);
        break;
      }
      case 'error': {
        const message = (params.error && params.error.message) || String(params.error || 'codex error');
        if (params.willRetry) {
          events.push({ type: 'notice', level: 'warn', code: 'api_retry', message });
          break;
        }
        errorText = message;
        break;
      }
      default:
        break;
    }
    return out(events, writes, { ended });
  }

  // Codex's sub-agents are threads of their own on the same app-server, so their
  // traffic is not this turn's stream: it never draws a block (the worker's
  // rollout is its own transcript). It is what Claude's task telemetry is for the
  // same job, so it leaves as the same `task.updated` frames, keyed by the
  // worker's thread id, which is the id the sub-agents list and its transcript
  // route use (lib/cloud/codex-subagents.js). The parent says when one starts,
  // is messaged, is interrupted and completes (subAgentActivity); the worker's
  // own notifications say what it is doing and what it has spent.
  function agentRow(id, agentPath) {
    let a = agents.get(id);
    if (!a) {
      a = { name: '', kind: '', toolUses: 0, lastText: '' };
      agents.set(id, a);
    }
    const name = agentTaskName(agentPath);
    if (name) a.name = name;
    return a;
  }

  function task(events, subtype, id, extra = {}) {
    const a = agents.get(id) || agentRow(id);
    const detail = { task_id: id, task_type: CODEX_AGENT_TASK, ...extra };
    if (a.name) detail.description = a.name;
    if (a.kind) detail.subagent_type = a.kind;
    events.push({ type: 'task.updated', subtype, detail });
  }

  // Who the worker is, once the agent has read its thread: the nickname the
  // parent's rows call it by ("Spawned Sartre"), or its role.
  function subagentMeta(id, { nickname = null, role = null, agentPath = null } = {}) {
    const events = [];
    if (ended || !id) return out(events);
    const a = agentRow(id, agentPath);
    const kind = agentKind(role, nickname);
    if (kind) a.kind = kind;
    task(events, 'task_progress', id);
    return out(events);
  }

  function agentActivity(events, item) {
    const id = typeof item.agentThreadId === 'string' && item.agentThreadId ? item.agentThreadId : null;
    if (!id) return;
    agentRow(id, item.agentPath);
    // A message to a worker that had finished starts it again, as a new run on
    // the same row: the item's id differs from the row's, which is how the
    // registry tells a resume from a duplicate start.
    if (item.kind === 'started') task(events, 'task_started', id, { tool_use_id: id });
    else if (item.kind === 'interacted') task(events, 'task_started', id, { tool_use_id: String(item.id || id) });
    else if (item.kind === 'interrupted') task(events, 'task_notification', id, { status: 'stopped' });
    else if (item.kind === 'completed') {
      const a = agents.get(id);
      task(events, 'task_notification', id, { status: 'completed', ...(a.lastText ? { summary: a.lastText } : {}) });
    }
  }

  // One notification from a sub-agent's own thread.
  function subagentNotification(id, method, params = {}) {
    const events = [];
    if (ended || !id) return out(events);
    const a = agentRow(id);
    const item = params.item || {};
    switch (method) {
      case 'turn/started':
        task(events, 'task_progress', id);
        break;
      case 'item/started': {
        const kind = ITEM_KINDS[item.type];
        if (kind !== 'tool_use') break;
        const preview = itemPreviewText(item);
        task(events, 'task_progress', id, { last_tool_name: preview ? `${itemToolName(item)}: ${preview}`.slice(0, 200) : itemToolName(item) });
        break;
      }
      case 'item/completed':
        if (ITEM_KINDS[item.type] === 'tool_use') {
          a.toolUses += 1;
          task(events, 'task_progress', id, { usage: { tool_uses: a.toolUses } });
        } else if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
          a.lastText = item.text.trim().slice(0, 2000);
        }
        break;
      case 'thread/tokenUsage/updated': {
        const t = (params.tokenUsage && params.tokenUsage.total) || {};
        const total = Number.isFinite(t.totalTokens) ? t.totalTokens : (Number(t.inputTokens) || 0) + (Number(t.outputTokens) || 0);
        if (total > 0) task(events, 'task_progress', id, { usage: { total_tokens: total } });
        break;
      }
      case 'turn/completed': {
        const turn = params.turn || {};
        const status = turn.status === 'interrupted' ? 'stopped' : turn.status === 'failed' ? 'failed' : 'completed';
        const summary = status === 'failed' && turn.error ? String(turn.error.message || turn.error) : a.lastText;
        const ev = { status, ...(summary ? { summary } : {}) };
        const ms = durationOf(turn);
        if (ms != null) ev.usage = { duration_ms: ms };
        task(events, 'task_notification', id, ev);
        break;
      }
      default:
        break;
    }
    return out(events);
  }

  // A sub-agent's approval is this turn's to answer: the person is watching the
  // chat that spawned it, and nobody is watching the worker's thread. Raised like
  // the turn's own, with the worker named so the card says who is asking.
  function subagentRequest(id, method, params = {}, rpcId) {
    const r = request(method, params, rpcId);
    const a = agents.get(id);
    const ev = r.events.find((e) => e.type === 'approval.requested');
    if (ev) {
      const who = `Sub-agent ${(a && a.name) || 'Codex'}`;
      ev.description = ev.description ? `${who}: ${ev.description}` : `${who} asks`;
      delete ev.anchor; // its row is in the worker's transcript, not this turn's
    }
    return r;
  }

  function request(method, params = {}, rpcId) {
    if (!APPROVAL_METHODS.has(method)) {
      // v1 compat requests (applyPatchApproval, execCommandApproval) and anything
      // future: refuse rather than hang the server.
      return out([], [{ jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: `Termdeck does not handle ${method}` } }]);
    }
    if (ended) {
      return out([], [approvalReply(method, params, rpcId, { cancelled: true })]);
    }
    const card = approvalCard(method, params);
    const requestId = `codex-${rpcId}`;
    pending.set(requestId, { method, params, rpcId, rule: card.likeRule || null });
    const ev = { type: 'approval.requested', requestId, toolName: card.toolName, input: card.detail || {} };
    if (card.preview) ev.preview = card.preview;
    if (card.description) ev.description = card.description;
    if (card.questions) ev.questions = card.questions;
    if (card.likeRule) {
      // Offered, and (when a person already said yes to one like it this turn)
      // vouched for. The master still runs its guards first and must hold the
      // same grant itself before it answers without asking.
      ev.likeRule = card.likeRule;
      const granted = turnRules.get(card.likeRule.key) || [];
      if (granted.some((flags) => ruleCovers(flags, card.likeRule.flags))) ev.turnRule = card.likeRule.key;
    }
    // The live row this call already has ("shell · npm test"), so the browser can
    // put the question on that row instead of saying the command twice.
    const row = params.itemId != null ? itemBlock.get(params.itemId) : undefined;
    if (row !== undefined && messageId) ev.anchor = { messageId, blockIndex: row };
    return out([ev, { type: 'run.status', status: 'awaiting-permission' }]);
  }

  function answer(requestId, decision) {
    const p = pending.get(requestId);
    if (!p) return out(); // already settled: a second copy of an answer is harmless
    pending.delete(requestId);
    // "Like this, for this turn": the rule is the one this agent derived from
    // the request it raised, never one the answer describes, so a master cannot
    // widen it. It lives on this translator, which follows one turn, so it ends
    // with the turn. The request itself is answered `accept`, not
    // acceptForSession: the app-server's own cache outlives the turn.
    if (p.rule && decision && decision.behavior === 'allow' && decision.scope === 'turn') {
      if (!turnRules.has(p.rule.key)) turnRules.set(p.rule.key, []);
      turnRules.get(p.rule.key).push(p.rule.flags);
    }
    const events = [];
    const outcome = decision && decision.timedOut ? 'timeout'
      : decision && decision.cancelled ? 'cancelled'
      : decision && decision.behavior === 'allow' ? (decision.answers ? 'answered' : 'allow')
      : 'deny';
    events.push({ type: 'approval.resolved', requestId, outcome });
    if (!pending.size && !ended) events.push({ type: 'run.status', status: 'running' });
    return out(events, [approvalReply(p.method, p.params, p.rpcId, decision || {})]);
  }

  function abort() {
    aborted = true;
  }

  function fail(message, detail = null) {
    const events = [];
    const writes = [];
    if (!ended) {
      finish(events, writes, aborted ? 'aborted' : 'error', message, null);
      const fin = events[events.length - 1];
      if (detail) fin.detail = { ...(fin.detail || {}), ...detail };
    }
    return out(events, writes, { ended: true });
  }

  function exit({ code = null, error = null } = {}) {
    const why = error || `codex app-server exited${code != null ? ` (code ${code})` : ''}`;
    const r = fail(why);
    // Nobody is left to read these replies.
    r.writes = [];
    return r;
  }

  return {
    bound,
    notification,
    request,
    subagentNotification,
    subagentRequest,
    subagentMeta,
    answer,
    abort,
    fail,
    exit,
    get threadId() { return tid; },
    get turnId() { return turnId; },
    get started() { return started; },
    get ended() { return ended; },
    pendingApprovals: () => pending.size,
    unfinishedText,
  };
}

module.exports = {
  itemToolName,
  shellCommand,
  commandRule,
  ruleCovers,
  approvalCard,
  approvalReply,
  usageEvent,
  createCodexTranslator,
  CODEX_AGENT_TASK,
  agentTaskName,
  agentKind,
};
