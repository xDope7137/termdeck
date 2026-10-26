'use strict';

// Pure JSONL -> render-friendly message parsing. No knowledge of Express or
// the .claude directory layout; takes a file path, returns plain objects.

const fs = require('fs');
const fsp = require('fs/promises');
const readline = require('readline');
const zlib = require('zlib');

const MAX_MESSAGES = 5000;
const TOOL_RESULT_MAX = 10 * 1024;
const TOOL_INPUT_MAX = 20 * 1024;
const PREVIEW_MAX = 100;

const COMMAND_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;
const COMMAND_STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const TASK_NOTIF_RE = /<task-notification>([\s\S]*?)<\/task-notification>/;
const TASK_NOTIF_STATUS_RE = /<status>([\s\S]*?)<\/status>/;
const TASK_NOTIF_SUMMARY_RE = /<summary>([\s\S]*?)<\/summary>/;
const TASK_NOTIF_TOOLUSEID_RE = /<tool-use-id>([\s\S]*?)<\/tool-use-id>/;
const TASK_NOTIF_RESULT_RE = /<result>([\s\S]*?)<\/result>/;
// What a dying CLI writes as the cut-off turn's last user record. Two wordings in
// the wild ("…by user]" and "…by user for tool use]"), both on records that also
// carry `interruptedByShutdown` — see the guard in recordToMessage.
const SHUTDOWN_INTERRUPT_RE = /^\[Request interrupted by user(?: for tool use)?\]$/;

function isShutdownInterruptText(content) {
  const parts = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text)
    : [];
  return parts.length > 0 && parts.every((t) => SHUTDOWN_INTERRUPT_RE.test(t.trim()));
}

const NO_RESPONSE_TEXT = 'No response requested.';
function isNoResponsePlaceholder(content) {
  const parts = typeof content === 'string' ? [content]
    : Array.isArray(content) ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text)
    : [];
  return parts.length > 0 && parts.every((t) => t.trim() === NO_RESPONSE_TEXT)
    && !(Array.isArray(content) && content.some((b) => b && b.type !== 'text'));
}

// Terminal tool output arrives with ANSI color codes; strip for the browser.
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\[[0-9;?]*[ -/]*[@-~]", "g");

function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_RE, '') : text;
}

function truncate(text, max) {
  if (typeof text !== 'string') return { text: '', truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

// The SAME cut as `truncate`, made on the raw string — counting only the bytes
// the reader will see, so the escape sequences do not eat the budget.
//
// This is the whole reason it is not just `truncate(raw, max)`. `npm test`'s
// output is roughly a fifth escape codes; cutting the raw at 10,000 CHARACTERS
// would hand the browser about 8,000 characters of visible text next to a
// stripped copy holding 10,000, and public/js/ansi.js's contract — the visible
// text equals the stripped text, byte for byte — would be false by two thousand
// characters. The reader would see a payload quietly shorter than the one they
// could copy.
//
// `truncated` is deliberately NOT returned: the stripped cut is the authority on
// whether anything was dropped, and the two agree by construction.
function truncateVisible(raw, max) {
  if (typeof raw !== 'string') return '';
  let seen = 0;
  let at = 0;
  let out = '';
  const re = new RegExp(ANSI_RE.source, 'g');
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const gap = m.index - at;
    if (seen + gap >= max) return out + raw.slice(at, at + (max - seen));
    out += raw.slice(at, m.index + m[0].length); // the visible run AND the sequence after it
    seen += gap;
    at = m.index + m[0].length;
  }
  return seen + (raw.length - at) <= max ? out + raw.slice(at) : out + raw.slice(at, at + (max - seen));
}

// The optional raw sibling of a stripped body, or nothing at all.
//
// ADDITIVE BY DESIGN: every existing consumer reads `text` and is untouched, and
// a payload whose output used no colour — most of them — carries no second copy.
// The size cost lands only on output that actually spent the bytes.
function ansiSibling(raw, body, max) {
  if (typeof raw !== 'string' || stripAnsi(raw) === raw) return null;
  // Escape codes and nothing else — a screen clear, a title set, a colour turned
  // on and straight off again. There is no body to colour, so a raw copy would
  // be bytes on the wire for a payload that renders as nothing.
  if (!body) return null;
  const kept = truncateVisible(raw, max);
  // Belt and braces on the one invariant that matters. A raw copy whose visible
  // text has drifted from the stripped one is worse than no colour at all, so it
  // is dropped rather than shipped: the renderer falls back to `text` and the
  // reader loses a colour, not a character.
  return stripAnsi(kept) === body ? kept : null;
}

// The tool call's own one-line statement of intent, when it has one and it is
// not already what inputPreview picked. Bash/Task/Agent set `description`
// ("Survey the SDK type surface") while the preview shows the raw command — so
// the transcript can say WHAT a call is for, not just what it literally ran.
function inputDescription(input, preview) {
  if (!input || typeof input !== 'object') return null;
  const d = typeof input.description === 'string' ? input.description.replace(/\s+/g, ' ').trim() : '';
  if (!d || d === preview) return null;
  return d.length > PREVIEW_MAX ? `${d.slice(0, PREVIEW_MAX)}…` : d;
}

// Codex's one label-shaped field, and the only one it has: `spawn_agent` (the
// collaboration namespace) names the sub-agent it is starting in `task_name` and
// puts the actual instruction in an ENCRYPTED `message` blob. inputPreview knows
// none of those field names, so it falls through to its key:value summary and
// the row reads `task_name: … · fork_turns: all · message: gAAAAABqbg0l…`.
//
// Keyed on the field, not on the tool name: nothing else Codex emits carries one
// today, and anything that starts to means the same thing by it. Every other
// Codex call keeps showing its command, which is correct rather than a
// regression — 0 of 1,783 measured calls carried a description of any kind, and
// inventing a label an engine never wrote is the one thing this must not do.
function codexTaskLabel(input) {
  if (!input || typeof input !== 'object') return null;
  const s = typeof input.task_name === 'string' ? input.task_name.replace(/\s+/g, ' ').trim() : '';
  if (!s) return null;
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s;
}

// A nested argument said in words rather than as JSON: what its items are
// called when they carry a name (`entities: termdeck, deckhand`), or how many
// there are when they do not. The panel's table has the whole value.
const NAME_FIELDS = ['name', 'title', 'label', 'id'];
function nameOf(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '';
  const k = NAME_FIELDS.find((f) => typeof v[f] === 'string' && v[f].trim());
  return k ? v[k].trim() : '';
}
function nestedPreview(v) {
  if (Array.isArray(v)) {
    const names = v.map(nameOf);
    if (names.length && names.every(Boolean)) return names.join(', ');
    return `${v.length} item${v.length === 1 ? '' : 's'}`;
  }
  const n = Object.keys(v).length;
  return nameOf(v) || `${n} field${n === 1 ? '' : 's'}`;
}

function inputPreview(name, input) {
  if (!input || typeof input !== 'object') return '';
  let s = [
    input.command,
    input.file_path,
    input.pattern,
    input.url,
    input.description,
    input.skill,
    input.query,
    input.prompt,
    input.path,
  ].find((v) => typeof v === 'string' && v.trim());
  if (!s) {
    // No well-known field matched (arbitrary MCP tool schema) — build a
    // readable "key: value" summary instead of dumping raw JSON/code.
    const parts = [];
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === 'string' && v.trim()) parts.push(`${k}: ${v.trim()}`);
      else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}: ${v}`);
      else if (Array.isArray(v) && v.every((x) => x == null || typeof x !== 'object')) parts.push(`${k}: ${v.join(', ')}`);
      else if (v && typeof v === 'object') parts.push(`${k}: ${nestedPreview(v)}`);
    }
    s = parts.join(' · ');
  }
  if (!s && Object.keys(input).length) {
    try {
      s = JSON.stringify(input);
    } catch {
      s = '';
    }
  }
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > PREVIEW_MAX ? `${s.slice(0, PREVIEW_MAX)}…` : s;
}

// A user/tool_result image block on disk is either inline base64 or a URL.
// Turn it into a ready-to-use <img src> (data URI or the URL as-is).
// ponytail: base64 rides inline in the message JSON (snapshot + WS), same as the
// CLI stores it. Fine until transcripts carry many/large images — then serve via
// a byte endpoint and lazy-load instead of inlining.
function imageSrc(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'url' && typeof source.url === 'string') return source.url;
  if (source.type === 'base64' && source.data && source.media_type) {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return null;
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && item.type === 'text' && typeof item.text === 'string') return item.text;
        // image items render as real <img> from block.images — no text placeholder
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

// Claude Code wraps a tool call it refused or that failed before running in
// `<tool_use_error>...</tool_use_error>` (a blocked `sleep 60`, an Edit whose
// old string is not in the file, ExitWorktree outside a worktree). The wrapper
// is harness markup, not output: `isError` already says it failed, and the
// row shows the sentence inside (features/02 2.6).
const TOOL_USE_ERROR_RE = /^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/;
const unwrapToolUseError = (text) => {
  const m = typeof text === 'string' && text.match(TOOL_USE_ERROR_RE);
  return m ? m[1].trim() : text;
};

function userStringBlocks(text) {
  const command = text.match(COMMAND_RE);
  if (command) {
    const args = text.match(COMMAND_ARGS_RE);
    return [
      {
        kind: 'command',
        command: command[1].trim(),
        args: args ? args[1].trim() : '',
      },
    ];
  }
  const stdout = text.match(COMMAND_STDOUT_RE);
  if (stdout) {
    const raw = stdout[1].trim();
    const body = truncate(stripAnsi(raw), TOOL_RESULT_MAX);
    if (!body.text) return [];
    const ansi = ansiSibling(raw, body.text, TOOL_RESULT_MAX);
    return [{ kind: 'command-output', text: body.text, truncated: body.truncated, ...(ansi ? { textAnsi: ansi } : {}) }];
  }
  const taskNotif = text.match(TASK_NOTIF_RE);
  if (taskNotif) {
    const status = (taskNotif[1].match(TASK_NOTIF_STATUS_RE) || [])[1] || '';
    const summary = (taskNotif[1].match(TASK_NOTIF_SUMMARY_RE) || [])[1] || '';
    const toolUseId = (taskNotif[1].match(TASK_NOTIF_TOOLUSEID_RE) || [])[1] || '';
    // Present for a background Agent's completion (never for a background bash
    // command's, which points at an <output-file> instead) — the real result of
    // a run_in_background Agent call, delivered here instead of in its tool_result.
    const rawResult = (taskNotif[1].match(TASK_NOTIF_RESULT_RE) || [])[1] || '';
    const result = truncate(rawResult.trim(), TOOL_RESULT_MAX);
    return [{
      kind: 'task-notification',
      status: status.trim(),
      summary: summary.trim(),
      toolUseId: toolUseId.trim() || null,
      result: result.text || null,
      resultTruncated: result.truncated,
    }];
  }
  if (!text.trim()) return [];
  return promptTextBlocks(text);
}

// The reverse of lib/attachments.js uploadBlock: the words the user typed and
// the files the note named. Its wording is copied here rather than required,
// because this file ships to the agent and attachments.js does not;
// tests/transcript-readback.mjs round-trips textWithFiles through the parse, so
// a change to the sentence there fails the suite instead of quietly leaving the
// note in every bubble. Anchored to the END of the text, the only place
// textWithFiles puts it: the same sentence typed mid-prompt by a person stays.
const UPLOAD_HEAD_RE = /(?:^|\n\n)(?:Attached file, already saved on this machine\. Read it from this path:|Attached files, already saved on this machine\. Read them from these paths:)\n((?:- [^\n]+(?:\n|$))+)\s*$/;
const UPLOAD_LINE_RE = /^- (.+?): ((?:[A-Za-z]:)?[\\/].*)$/;

function splitUploadBlock(text) {
  if (typeof text !== 'string' || !text.includes('already saved on this machine')) return null;
  const m = UPLOAD_HEAD_RE.exec(text);
  if (!m) return null;
  const files = [];
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const f = UPLOAD_LINE_RE.exec(line.trim());
    if (!f) return null; // not a list uploadBlock wrote: leave the text alone
    files.push({ name: f[1], path: f[2] });
  }
  return files.length ? { text: text.slice(0, m.index), files } : null;
}

// A typed prompt, minus the attachment note Termdeck appended for the model
// (lib/attachments.js uploadBlock): the words become the text block and each
// file named in the note becomes a `file` block the viewer draws as a chip, the
// same chip the composer showed before Send. Without this the bubble carried
// "Attached file, already saved on this machine. Read it from this path: ..."
// under what the user wrote, an instruction nobody typed.
function promptTextBlocks(text) {
  const split = splitUploadBlock(text);
  if (!split) return [{ kind: 'text', text }];
  const blocks = split.text.trim() ? [{ kind: 'text', text: split.text }] : [];
  for (const f of split.files) blocks.push({ kind: 'file', name: f.name, path: f.path });
  return blocks;
}

// AskUserQuestion's answers, as the CLI recorded them beside the result:
// `toolUseResult.answers` is { question: answer }. The result TEXT says the same
// thing as one sentence for the model; the map is what lets the viewer put each
// answer under its own question. Bounded like everything else a record carries.
const ANSWERS_MAX = 20;
const ANSWER_TEXT_MAX = 2000;
function answersOf(toolUseResult) {
  const a = toolUseResult && typeof toolUseResult === 'object' ? toolUseResult.answers : null;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const out = {};
  let n = 0;
  for (const [q, v] of Object.entries(a)) {
    if (n >= ANSWERS_MAX) break;
    if (q === '__proto__') continue;
    const text = Array.isArray(v) ? v.map(String).join(', ') : v == null ? '' : String(v);
    out[String(q).slice(0, ANSWER_TEXT_MAX)] = text.slice(0, ANSWER_TEXT_MAX);
    n += 1;
  }
  return n ? out : null;
}

// What the edit and read tools recorded beside their result, for the viewer's
// per-tool panels (features/02 3.2-3.4). The result TEXT is a sentence for the
// model ("has been updated successfully"); these are the facts behind it:
//   patch        Edit/Write/MultiEdit's own hunks (`structuredPatch`), with line
//                numbers and the context lines around each change.
//   created      a Write that made a new file rather than replacing one.
//   occurrences  how many places a replace_all edit changed.
//   readLines    the span a Read returned: { first, last, total }.
//   notebook     a NotebookEdit's cell before and after.
// Bounded like everything else a record carries: a patch past PATCH_LINES_MAX
// lines is cut and says so, and a whole-file copy (`originalFile`) never rides.
const PATCH_HUNKS_MAX = 40;
const PATCH_LINES_MAX = 600;
const PATCH_LINE_CHARS = 2000;
function resultFacts(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) {
    const hunks = [];
    let lines = 0;
    let cut = false;
    for (const h of r.structuredPatch.slice(0, PATCH_HUNKS_MAX)) {
      if (!h || !Array.isArray(h.lines)) continue;
      const room = PATCH_LINES_MAX - lines;
      if (room <= 0) { cut = true; break; }
      const kept = h.lines.slice(0, room).map((l) => String(l).slice(0, PATCH_LINE_CHARS));
      if (kept.length < h.lines.length) cut = true;
      lines += kept.length;
      hunks.push({ oldStart: Number(h.oldStart) || 0, oldLines: Number(h.oldLines) || 0, newStart: Number(h.newStart) || 0, newLines: Number(h.newLines) || 0, lines: kept });
    }
    if (r.structuredPatch.length > PATCH_HUNKS_MAX) cut = true;
    if (hunks.length) {
      out.patch = hunks;
      if (cut) out.patchTruncated = true;
    }
  }
  if (r.type === 'create' && typeof r.filePath === 'string') out.created = true;
  if (r.replaceAll === true && typeof r.originalFile === 'string' && typeof r.oldString === 'string' && r.oldString) {
    let n = 0;
    for (let at = r.originalFile.indexOf(r.oldString); at !== -1 && n < 10000; at = r.originalFile.indexOf(r.oldString, at + r.oldString.length)) n += 1;
    if (n) out.occurrences = n;
  }
  const f = r.file && typeof r.file === 'object' ? r.file : null;
  if (f && Number.isFinite(f.startLine) && Number.isFinite(f.numLines) && f.numLines > 0) {
    out.readLines = { first: f.startLine, last: f.startLine + f.numLines - 1, ...(Number.isFinite(f.totalLines) ? { total: f.totalLines } : {}) };
  }
  if (typeof r.new_source === 'string' && typeof r.edit_mode === 'string') {
    const cap = (s) => truncate(String(s == null ? '' : s), DIFF_MAX).text;
    out.notebook = {
      editMode: r.edit_mode,
      newSource: cap(r.new_source),
      ...(typeof r.old_source === 'string' ? { oldSource: cap(r.old_source) } : {}),
      ...(typeof r.cell_type === 'string' ? { cellType: r.cell_type } : {}),
      ...(typeof r.language === 'string' ? { language: r.language.slice(0, 40) } : {}),
    };
  }
  return Object.keys(out).length ? out : null;
}

function userBlocks(content, toolUseResult = null) {
  if (typeof content === 'string') return userStringBlocks(content);
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      blocks.push(...userStringBlocks(item.text));
    } else if (item.type === 'tool_result') {
      const raw = unwrapToolUseError(toolResultText(item.content));
      const body = truncate(stripAnsi(raw), TOOL_RESULT_MAX);
      const images = Array.isArray(item.content)
        ? item.content.filter((c) => c && c.type === 'image').map((c) => imageSrc(c.source)).filter(Boolean)
        : [];
      const ansi = ansiSibling(raw, body.text, TOOL_RESULT_MAX);
      // A failed Bash call opens with "Exit code N"; the row shows it as a chip
      // rather than leaving it a line inside a panel (features/02 2.4).
      const exit = item.is_error ? /^Exit code (-?\d+)\s*(?:\n|$)/.exec(body.text) : null;
      blocks.push({
        kind: 'tool_result',
        toolUseId: item.tool_use_id || null,
        isError: !!item.is_error,
        ...(exit ? { exitCode: Number(exit[1]) } : {}),
        text: body.text,
        // The same characters with their colour still on, when the command used
        // any. Absent otherwise — see ansiSibling.
        ...(ansi ? { textAnsi: ansi } : {}),
        truncated: body.truncated,
        images,
      });
      const answers = answersOf(toolUseResult);
      if (answers) blocks[blocks.length - 1].answers = answers;
      const facts = resultFacts(toolUseResult);
      if (facts) Object.assign(blocks[blocks.length - 1], facts);
    } else if (item.type === 'image') {
      blocks.push({ kind: 'image', src: imageSrc(item.source) });
    }
  }
  return blocks;
}

// TaskCreate/TaskUpdate drive the CLI's checklist. Emit a compact task block
// instead of a raw JSON fold; the viewer renders a status line and resolves an
// update's subject from the create it accumulated. (Ids are assigned 1,2,3… in
// creation order — the create result echoes "Task #N created".)
function taskBlock(item) {
  const inp = item.input && typeof item.input === 'object' ? item.input : {};
  if (item.name === 'TaskCreate') {
    return { kind: 'task', op: 'create', id: item.id || null, subject: String(inp.subject || inp.activeForm || 'task') };
  }
  // `subject` rides along when present: an update may carry no status at all and
  // rename the task instead (1 of 53 real updates on this box did exactly that),
  // and the folded checklist needs the new wording.
  const update = { kind: 'task', op: 'update', id: item.id || null, taskId: inp.taskId != null ? String(inp.taskId) : null, status: String(inp.status || '') };
  if (inp.subject) update.subject = String(inp.subject).slice(0, TODO_TEXT_MAX);
  return update;
}

// Bounds for a checklist snapshot, shared by both engines that produce one —
// Claude's TodoWrite below and Codex's update_plan in parseRollout — so the two
// cannot quietly disagree about how much of a plan is renderable.
const TODO_MAX = 100;
const TODO_TEXT_MAX = 500;

// TodoWrite rewrites the whole checklist each call. One tool_use → one snapshot
// block the viewer renders as task lines (reusing the TaskCreate/Update styling),
// instead of a raw {todos:[…]} JSON fold.
function todoBlock(item) {
  const inp = item.input && typeof item.input === 'object' ? item.input : {};
  const todos = Array.isArray(inp.todos) ? inp.todos : [];
  const items = todos.slice(0, TODO_MAX).map((t) => {
    const src = t && typeof t === 'object' ? t : {};
    return { text: String(src.content || src.activeForm || '').slice(0, TODO_TEXT_MAX), status: String(src.status || 'pending') };
  }).filter((t) => t.text);
  return { kind: 'todos', id: item.id || null, items };
}

// Edit/Write/MultiEdit inputs carry the before/after text — hand the viewer the
// raw strings (capped) so it can render a real diff instead of a JSON fold.
const DIFF_MAX = 20 * 1024;
function diffFor(item) {
  const inp = item.input && typeof item.input === 'object' ? item.input : {};
  const cap = (s) => truncate(String(s == null ? '' : s), DIFF_MAX);
  if (item.name === 'Write') {
    const c = cap(inp.content);
    return { filePath: inp.file_path || '', write: true, edits: [{ oldText: '', newText: c.text, truncated: c.truncated }] };
  }
  if (item.name === 'Edit') {
    const o = cap(inp.old_string), n = cap(inp.new_string);
    return { filePath: inp.file_path || '', edits: [{ oldText: o.text, newText: n.text, truncated: o.truncated || n.truncated }] };
  }
  if (item.name === 'MultiEdit' && Array.isArray(inp.edits)) {
    const edits = inp.edits.slice(0, 30).map((e) => {
      const o = cap(e && e.old_string), n = cap(e && e.new_string);
      return { oldText: o.text, newText: n.text, truncated: o.truncated || n.truncated };
    });
    return { filePath: inp.file_path || '', edits };
  }
  return null;
}

// AskUserQuestion's input, reduced to what a reader needs: each question, its
// short header and the option labels. The viewer draws these with the chosen
// answers marked (the `answers` map its result carries) instead of the raw
// {"questions":[...]} JSON the row used to open on.
const QUESTIONS_MAX = 10;
const OPTIONS_MAX = 12;
function questionsOf(input) {
  const qs = input && typeof input === 'object' && Array.isArray(input.questions) ? input.questions : null;
  if (!qs) return null;
  const out = qs.slice(0, QUESTIONS_MAX).map((q) => {
    const src = q && typeof q === 'object' ? q : {};
    const options = Array.isArray(src.options) ? src.options.slice(0, OPTIONS_MAX).map((o) => {
      const label = o && typeof o === 'object' ? o.label : o;
      return String(label == null ? '' : label).slice(0, 200);
    }).filter(Boolean) : [];
    const item = {
      question: String(src.question || src.header || '').slice(0, 1000),
      header: typeof src.header === 'string' ? src.header.slice(0, 100) : '',
      options,
      multiSelect: !!src.multiSelect,
    };
    // Codex answers by question id, not by the question's text.
    if (typeof src.id === 'string' && src.id) item.id = src.id.slice(0, 200);
    return item;
  }).filter((q) => q.question);
  return out.length ? out : null;
}

// Codex's request_user_input output, {"answers":{"<id>":{"answers":["Blue"]}}},
// as the { id: answer } map the viewer marks picks from. `{}` when the question
// went unanswered ("Don't answer" replies with no answers); null for any other
// output, so a tool that merely returned JSON is never taken for one.
function codexAnswersOf(text) {
  if (typeof text !== 'string' || !text.startsWith('{"answers"')) return null;
  let o;
  try { o = JSON.parse(text); } catch { return null; }
  const a = o && typeof o === 'object' && Object.keys(o).length === 1 ? o.answers : null;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return null;
  const out = {};
  let n = 0;
  for (const [id, v] of Object.entries(a)) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.answers)) return null;
    if (n >= ANSWERS_MAX || id === '__proto__') continue;
    out[id.slice(0, ANSWER_TEXT_MAX)] = v.answers.map(String).join(', ').slice(0, ANSWER_TEXT_MAX);
    n += 1;
  }
  return out;
}

// Codex's request_user_input_async, {"questions":[{"title":"...","options":["A","B"]}]}:
// a question it asks and keeps working past. The id is the question's index,
// which is what the reply names it by (asyncReplyOf).
function asyncQuestionsOf(input) {
  const qs = input && typeof input === 'object' && Array.isArray(input.questions) ? input.questions : null;
  if (!qs) return null;
  const out = [];
  qs.slice(0, QUESTIONS_MAX).forEach((src, i) => {
    const title = src && typeof src === 'object' ? src.title : null;
    if (typeof title !== 'string' || !title.trim()) return;
    const options = Array.isArray(src.options) ? src.options.slice(0, OPTIONS_MAX).map((o) => String(o == null ? '' : o).slice(0, 200)).filter(Boolean) : [];
    out.push({ id: String(i), question: title.slice(0, 1000), header: '', options, multiSelect: false });
  });
  return out.length ? out : null;
}

// The answer to one, as the Codex app sends it: a user message of
//   <send_user_message_question_reply>
//   [{"answer":"A","question":"...","questionItemId":"[\"request_user_input_async\",\"call_x\",0]"}]
//   </send_user_message_question_reply>
// read as { kind: 'question-reply', answers: [{ callId, index, question, answer }] }.
const ASYNC_REPLY_RE = /^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/;
function asyncReplyOf(text) {
  const m = ASYNC_REPLY_RE.exec(text);
  if (!m) return null;
  let list;
  try { list = JSON.parse(m[1]); } catch { return null; }
  if (!Array.isArray(list)) return null;
  const answers = [];
  for (const a of list.slice(0, QUESTIONS_MAX)) {
    if (!a || typeof a !== 'object' || typeof a.answer !== 'string') continue;
    let ref = null;
    try { ref = JSON.parse(a.questionItemId); } catch {}
    answers.push({
      callId: Array.isArray(ref) && typeof ref[1] === 'string' ? ref[1] : null,
      index: Array.isArray(ref) && Number.isInteger(ref[2]) ? ref[2] : null,
      question: typeof a.question === 'string' ? a.question.slice(0, 1000) : '',
      answer: a.answer.slice(0, ANSWER_TEXT_MAX),
    });
  }
  return answers.length ? { kind: 'question-reply', answers } : null;
}

function assistantBlocks(content) {
  if (typeof content === 'string') {
    return content.trim() ? [{ kind: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') {
      if (item.text.trim()) blocks.push({ kind: 'text', text: item.text });
    } else if (item.type === 'thinking' && typeof item.thinking === 'string') {
      if (item.thinking.trim()) blocks.push({ kind: 'thinking', text: item.thinking });
    } else if (item.type === 'redacted_thinking') {
      blocks.push({ kind: 'thinking', text: '[redacted]' });
    } else if (item.type === 'tool_use') {
      if (item.name === 'TaskCreate' || item.name === 'TaskUpdate') {
        blocks.push(taskBlock(item));
        continue;
      }
      if (item.name === 'TodoWrite') {
        blocks.push(todoBlock(item));
        continue;
      }
      let inputJson = '';
      try {
        inputJson = JSON.stringify(item.input, null, 2) || '';
      } catch {}
      const diff = diffFor(item);
      const body = diff ? { text: '', truncated: false } : truncate(inputJson, TOOL_INPUT_MAX);
      const preview = inputPreview(item.name, item.input);
      const block = {
        kind: 'tool_use',
        id: item.id || null,
        name: item.name || 'tool',
        inputPreview: preview,
        description: inputDescription(item.input, preview),
        inputJson: body.text, // omitted for diffs — the viewer renders the diff, not the JSON
        truncated: body.truncated,
      };
      if (diff) block.diff = diff;
      if (item.name === 'AskUserQuestion') {
        const questions = questionsOf(item.input);
        if (questions) {
          block.questions = questions;
          block.inputPreview = questions.length === 1 ? questions[0].question.slice(0, PREVIEW_MAX) : `${questions.length} questions`;
        }
      }
      blocks.push(block);
    }
  }
  return blocks;
}

// The queue is not only for things a person typed. When a background agent
// finishes while a turn is in flight, the CLI puts its <task-notification> XML
// on the same queue and writes a `remove` record when it takes it off again to
// deliver it — so the notification lands TWICE: once correctly, as the
// attachment record parsed above, and once as a "removed from the queue" aside
// showing the raw markup. On this box 736 of 999 remove records are that, and
// only 252 are typed text.
//
// Named shapes rather than the tag-shape rule isSyntheticUserText() uses for
// titles: a wrong skip there costs a chat its title and the next message fixes
// it, but a wrong skip HERE deletes the only trace a person's message ever
// existed. Somebody pasting `<html>` into the composer and then taking it back
// must still see it.
const INJECTED_QUEUE_PREFIXES = [
  '<task-notification>',
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<system-reminder>',
];

function isInjectedQueueEntry(text) {
  return INJECTED_QUEUE_PREFIXES.some((p) => text.startsWith(p));
}

// The rows one compaction left at the tail of a message list: its boundary
// and the summary under it. Returns where that run starts (list.length when
// there is none). Only ONE boundary is crossed, so a /compact typed right
// after an auto-compaction is not carried above that earlier one too.
const firstBlockKind = (m) => (m && Array.isArray(m.blocks) && m.blocks[0] ? m.blocks[0].kind : '');
function compactionRunStart(list) {
  let at = list.length;
  while (at > 0 && list[at - 1].role === 'user' && firstBlockKind(list[at - 1]) === 'compact-summary') at -= 1;
  if (at > 0 && list[at - 1].role === 'compacted') at -= 1;
  return at;
}

function isCompactCommandMessage(m) {
  return !!(m && m.role === 'user' && firstBlockKind(m) === 'command'
    && String(m.blocks[0].command || '').replace(/^\//, '') === 'compact');
}

// Where a `/compact` record belongs when it lands after the compaction it
// asked for, or -1 to append it as usual. The command goes above the run; its
// output goes above the run too, under the command already moved there. A
// command stamped later than the boundary is not that compaction's cause.
function compactCommandSlot(list, message) {
  const isCmd = isCompactCommandMessage(message);
  if (!isCmd && !(message && message.role === 'user' && firstBlockKind(message) === 'command-output')) return -1;
  const at = compactionRunStart(list);
  if (at === list.length) return -1;
  if (isCmd) {
    const t = Date.parse(message.timestamp);
    const b = Date.parse(list[at].timestamp);
    return Number.isFinite(t) && Number.isFinite(b) && t > b ? -1 : at;
  }
  return isCompactCommandMessage(list[at - 1]) ? at : -1;
}

// A skill's title (its first `# heading`) and the first paragraph under it,
// out of the text the CLI loads for the model. The CLI may lead with a "Base
// directory for this skill:" line; it is a path for the model, not the skill.
// null when neither is there, so an unrelated meta record renders nothing.
const SKILL_TITLE_MAX = 120;
const SKILL_SUMMARY_MAX = 300;
function skillAbout(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n')
    : '';
  if (!text) return null;
  const lines = text.split('\n');
  let i = 0;
  if (/^Base directory for this skill:/.test(lines[0] || '')) i = 1;
  let title = '';
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const h = /^#\s+(.+)$/.exec(l);
    if (h) { title = h[1].trim(); i++; }
    break;
  }
  const para = [];
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) { if (para.length) break; continue; }
    if (/^(?:#{1,6}\s|[-*+]\s|\d+\.\s|```|~~~|\||>)/.test(l)) { if (para.length) break; continue; }
    para.push(l);
  }
  const summary = para.join(' ').replace(/\s+/g, ' ').trim();
  if (!title && !summary) return null;
  const cap = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  return { title: cap(title, SKILL_TITLE_MAX), summary: cap(summary, SKILL_SUMMARY_MAX) };
}

// Whitelist parser: only user/assistant records (plus file-history-snapshot and
// compact_boundary, handled specially below) render; every other record type
// (mode, permission-mode, last-prompt, hook attachments, future types) is
// silently skipped so new bookkeeping records never break the viewer.
function recordToMessage(rec, allowSidechain = false) {
  if (!rec || typeof rec !== 'object') return null;
  // A background Agent (or bash task)'s notification, when it lands while a
  // turn is already in flight, gets queued as its own `attachment` record
  // (commandMode: 'task-notification') instead of a plain user-turn string —
  // same <task-notification> XML either way, so reuse the same block parser.
  if (rec.type === 'attachment' && rec.attachment && rec.attachment.commandMode === 'task-notification' && typeof rec.attachment.prompt === 'string') {
    const blocks = userStringBlocks(rec.attachment.prompt);
    if (!blocks.length) return null;
    return {
      role: 'user',
      messageId: rec.uuid || null,
      uuid: rec.uuid || null,
      timestamp: rec.timestamp || null,
      blocks,
    };
  }
  // A PermissionRequest hook answered a tool call's permission request on the
  // machine (features/02 2.7). The live hook frame said so and the reload did
  // not, so the decision rides on disk and the viewer marks the call's own row.
  if (rec.type === 'attachment' && (!rec.isSidechain || allowSidechain) && rec.attachment && rec.attachment.type === 'hook_permission_decision'
    && typeof rec.attachment.toolUseID === 'string' && rec.attachment.toolUseID) {
    const a = rec.attachment;
    return {
      role: 'user',
      messageId: rec.uuid || null,
      uuid: rec.uuid || null,
      timestamp: rec.timestamp || null,
      blocks: [{ kind: 'hook-decision', toolUseId: a.toolUseID, decision: typeof a.decision === 'string' ? a.decision : '', hookEvent: typeof a.hookEvent === 'string' ? a.hookEvent : 'PermissionRequest' }],
    };
  }
  // Checkpoint: the CLI snapshots edited files before a turn. Surface it as a
  // marker with a restore affordance (server owns the actual restore, keyed by
  // this messageId). An EMPTY snapshot is kept rather than dropped here: under the
  // SDK it is written at turn start and every file arrives later as a delta, so it
  // is the only record that knows the moment being restored TO. The scanner's fold
  // is what drops a checkpoint that never gained a file — by then it knows.
  if (rec.type === 'file-history-snapshot') {
    const tfb = rec.snapshot && rec.snapshot.trackedFileBackups;
    const files = tfb && typeof tfb === 'object' ? Object.keys(tfb) : [];
    return {
      role: 'checkpoint',
      messageId: rec.messageId || (rec.snapshot && rec.snapshot.messageId) || null,
      uuid: rec.uuid || null,
      timestamp: (rec.snapshot && rec.snapshot.timestamp) || rec.timestamp || null,
      blocks: [{ kind: 'checkpoint', files: files.slice(0, 60), fileCount: files.length }],
    };
  }
  // …and the incremental form the CLI actually uses now (verified on 2.1.220,
  // SDK-driven): the snapshot is written at turn START and is therefore EMPTY,
  // then one `file-history-delta` lands per file as it is backed up. Reading only
  // the snapshot meant every checkpoint parsed as zero files and was dropped by
  // the `!files.length` guard above — no marker in the transcript and nothing to
  // restore, even though the backup blob was sitting on disk. One delta is one
  // file; the merge in parse() folds them onto their snapshot's messageId.
  if (rec.type === 'file-history-delta') {
    const trackingPath = rec.trackingPath;
    const messageId = rec.snapshotMessageId || rec.messageId || null;
    if (!trackingPath || !messageId) return null;
    return {
      role: 'checkpoint',
      messageId,
      uuid: rec.uuid || null,
      timestamp: rec.timestamp || (rec.backup && rec.backup.backupTime) || null,
      blocks: [{ kind: 'checkpoint', files: [trackingPath], fileCount: 1 }],
    };
  }
  // Auto/manual compaction boundary — surface it as a banner with the real
  // pre/post token counts instead of silently dropping it (the file just shrinks).
  // A message you queued and then TOOK BACK. The CLI writes `queue-operation`
  // records for the whole queue lifecycle, and only this end of it is worth a
  // row — measured across the 5,722 of them on this box:
  //
  //   enqueue (2,893) — the message ran, and the run wrote it as an ordinary
  //                     user record. Rendering these too would double every
  //                     queued message in the transcript.
  //   dequeue (1,914) — carries no content at all, ever. Nothing to show.
  //   remove    (911) — the message was cancelled before it ran, so it appears
  //                     NOWHERE else. 862 of them carry the text.
  //   popAll      (4) — the whole queue was dropped, same story.
  //
  // So this is not "render queue records"; it is the one case where something a
  // person typed left no other trace. A record with no content is skipped rather
  // than drawn as an empty row, and so is content nobody typed — see below.
  if (rec.type === 'queue-operation' && (rec.operation === 'remove' || rec.operation === 'popAll')) {
    const text = typeof rec.content === 'string' ? rec.content.trim() : '';
    if (!text || isInjectedQueueEntry(text)) return null;
    return {
      role: 'unqueued',
      messageId: rec.uuid || null,
      uuid: rec.uuid || null,
      timestamp: rec.timestamp || null,
      blocks: [{ kind: 'unqueued', text, operation: rec.operation }],
    };
  }
  if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
    const cm = rec.compactMetadata || {};
    return {
      role: 'compacted',
      messageId: rec.uuid || null,
      uuid: rec.uuid || null,
      timestamp: rec.timestamp || null,
      blocks: [{ kind: 'compacted', trigger: cm.trigger || 'auto', preTokens: cm.preTokens ?? null, postTokens: cm.postTokens ?? null, durationMs: cm.durationMs ?? null }],
    };
  }
  // The model refused, and the turn either moved to a fallback model or ended
  // (SDK-SIGNALS §B). Rendered from DISK rather than from the live stream, which
  // the plan assumed was the only source: the CLI writes these as ordinary system
  // records — 7 of them across the transcripts on this box — so a refusal is
  // durable, survives a reload, and shows up for terminal-made sessions the
  // stream path could never reach. It also sidesteps that plan's biggest gotcha.
  // `retractedMessageUuids` names messages withdrawn from the turn, and the worry
  // was that the transcript still contained them; measured across all 8 retracted
  // uuids on this box, NONE survives as a record. The CLI simply never persists a
  // retracted message, so retraction is a live-stream concern only and there is
  // nothing here to evict.
  //
  // Field names are read in both spellings: disk is camelCase, the SDK stream is
  // snake_case, and neither is contractual.
  if (rec.type === 'system' && (rec.subtype === 'model_refusal_fallback' || rec.subtype === 'model_refusal_no_fallback')) {
    const fallback = rec.subtype === 'model_refusal_fallback';
    const text = typeof rec.content === 'string' ? rec.content.trim() : '';
    return {
      role: 'refusal',
      messageId: rec.uuid || null,
      uuid: rec.uuid || null,
      timestamp: rec.timestamp || null,
      blocks: [{
        kind: 'refusal',
        fallback,
        // The engine's own prose. It is the only part that explains anything to
        // the reader, so an empty one still renders — the row's existence is the
        // point, and a refusal with no copy is exactly when it needs saying.
        text,
        originalModel: rec.originalModel || rec.original_model || null,
        fallbackModel: fallback ? rec.fallbackModel || rec.fallback_model || null : null,
        category: rec.apiRefusalCategory || rec.api_refusal_category || null,
      }],
    };
  }
  if (rec.type !== 'user' && rec.type !== 'assistant') return null;
  // The text a Skill call loaded for the model: a meta user record right after
  // the call's result, pointing back at it by sourceToolUseID. The body is the
  // model's, but its title and first paragraph are what the skill IS, and the
  // Skill row's own result only says "Launching skill: x" (features/02 3.12).
  // Same shape as hook-decision above: a block that marks the call's row.
  if (rec.type === 'user' && rec.isMeta && (!rec.isSidechain || allowSidechain)
    && typeof rec.sourceToolUseID === 'string' && rec.sourceToolUseID && rec.message) {
    const about = skillAbout(rec.message.content);
    if (!about) return null;
    return {
      role: 'user',
      messageId: rec.uuid || null,
      uuid: rec.uuid || null,
      timestamp: rec.timestamp || null,
      blocks: [{ kind: 'skill-body', toolUseId: rec.sourceToolUseID, ...about }],
    };
  }
  if (rec.isMeta || (rec.isSidechain && !allowSidechain) || rec.attachment) return null;
  const msg = rec.message;
  if (!msg || typeof msg !== 'object') return null;

  // The synthetic "this session is being continued…" summary the CLI writes
  // immediately after a compaction — fold it instead of rendering it as a
  // giant, misleadingly-normal user text bubble. Key off the record's own
  // isCompactSummary flag (not parentUuid==boundary): the boundary and summary
  // routinely land in separate incremental deltas — the runner even nudges the
  // watcher the instant the boundary is written — and a cross-record link can't
  // survive that split, so the summary would render as a plain text bubble AND
  // hijack the initial render-window anchor.
  if (rec.type === 'user' && rec.isCompactSummary && typeof msg.content === 'string') {
    return {
      role: 'user',
      messageId: msg.id || rec.uuid || null,
      uuid: rec.uuid || null,
      timestamp: rec.timestamp || null,
      blocks: [{ kind: 'compact-summary', text: msg.content }],
    };
  }

  // "[Request interrupted by user]" written by a CLI that was SHUT DOWN, not by a
  // user who pressed stop. `interruptedByShutdown` is the CLI's own flag for it and
  // the only thing that tells the two apart — the text is identical.
  //
  // Termdeck reaps the CLI child at the end of every turn, so the flag is mostly
  // OUR footprint: when the reap lands mid-turn (a background agent's notification
  // turn, a deploy, a machine reboot) the dying CLI writes this record and the user
  // is shown a message they never sent. Worse than the bubble, it counted as a typed
  // prompt everywhere downstream — it bumped the chat to the top of the sidebar,
  // anchored the preview window, closed the turn (dropping a "⏱ took" line in the
  // wrong place) and landed in the composer's ↑ history.
  //
  // Text AND flag, because a user who really does interrupt gets the same wording
  // and that record is theirs to keep.
  if (rec.type === 'user' && rec.interruptedByShutdown && isShutdownInterruptText(msg.content)) {
    return {
      role: 'user',
      messageId: msg.id || rec.uuid || null,
      uuid: rec.uuid || null,
      timestamp: rec.timestamp || null,
      blocks: [{ kind: 'engine-shutdown' }],
    };
  }

  // The same wording WITHOUT the shutdown flag: the user pressed Stop. It is a
  // real event and it stays, but it is not something they said. The CLI writes
  // it as a user text record, so it rendered as a `[Request interrupted by user
  // for tool use]` bubble, got pinned as "the last prompt" in the sticky header
  // and walked into the composer's history. As its own block kind it carries no
  // `text`, which is the property every "did the user type here" test reads.
  if (rec.type === 'user' && isShutdownInterruptText(msg.content)) {
    const t = typeof msg.content === 'string' ? msg.content : msg.content.map((b) => (b && b.text) || '').join('');
    return {
      role: 'user',
      messageId: msg.id || rec.uuid || null,
      uuid: rec.uuid || null,
      timestamp: rec.timestamp || null,
      blocks: [{ kind: 'interrupted', forTool: /for tool use/.test(t) }],
    };
  }

  // The CLI's placeholder answer to a turn that asked for nothing: after a stop,
  // the next start writes a `<synthetic>` assistant record reading "No response
  // requested." No model wrote it and it answers nobody, and as the turn's last
  // assistant record it also stretched that turn's "took" line to cover however
  // long the chat sat idle. Other `<synthetic>` records (API errors) are real
  // news and still render.
  if (rec.type === 'assistant' && msg.model === '<synthetic>' && isNoResponsePlaceholder(msg.content)) return null;

  // An answer the API never gave: Claude Code writes its own sentence for an
  // expired sign-in, a usage limit, an unknown model or a dropped connection
  // as an assistant record flagged `isApiErrorMessage`, with a code in `error`.
  // Rendered as a reply it read as the model talking (features/02 4.7), so it
  // is its own block: the viewer draws a notice with the next step.
  if (rec.type === 'assistant' && rec.isApiErrorMessage === true) {
    const content = msg.content;
    const text = typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n')
        : '';
    return {
      role: 'assistant',
      messageId: msg.id || rec.uuid || null,
      uuid: rec.uuid || null,
      timestamp: rec.timestamp || null,
      blocks: [{ kind: 'api-error', code: typeof rec.error === 'string' && rec.error ? rec.error : 'unknown', text: text.trim() }],
    };
  }

  const blocks = rec.type === 'user' ? userBlocks(msg.content, rec.toolUseResult) : assistantBlocks(msg.content);
  if (blocks.length === 0) return null;

  return {
    role: rec.type,
    messageId: msg.id || rec.uuid || null,
    uuid: rec.uuid || null,
    timestamp: rec.timestamp || null,
    blocks,
  };
}

// `/model` in a running session records no assistant turn — just a user record
// `<local-command-stdout>Set model to <Display Name> …` (plus a global settings
// write). Pull the display name out so the UI can reflect a mid-session model
// switch before the next response. Returns null for any other record. The client
// maps the display name → model id against its live model list.
// ponytail: matches Claude Code's stdout wording; if that changes, this quietly
// no-ops and the model just falls back to the last assistant turn's id.
function modelChoiceName(rec) {
  if (rec.type !== 'user' || !rec.message) return null;
  const c = rec.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b === 'string' ? b : b.text || '')).join('') : '';
  if (!text.includes('local-command-stdout') || !/Set model to/i.test(text)) return null;
  // Stop at a trailing clause, the closing tag, or end — NOT at a bare "." (model
  // names contain a decimal, e.g. "Haiku 4.5", "Opus 4.8").
  const m = text.replace(ANSI_RE, '').match(/Set model to\s+(.+?)(?:\s+and saved\b|\s+for (?:this|new)\b|\s*<\/local-command-stdout>|$)/i);
  return m ? m[1].trim() : null;
}

// Per-line accumulator shared by the streaming (local disk) and buffer (relay/tunnel)
// scanners so both produce byte-identical output. feed(line) per line; finish() at EOF.
// `usageSeed` is the cursor's carried state: { usageId }, the last message.id
// whose usage was already summed into a running total somebody else holds
// (features/04). Without it a resumed delta re-sums a turn whose blocks fall on
// both sides of the seam, and the cost on screen creeps up by one turn per
// resume. With it, this scan's cumUsage is exactly what this delta ADDED.
function makeClaudeScanner(since, allowSidechain = false, startLine = 0, usageSeed = null) {
  const messages = [];
  let lineCount = startLine;
  let lastLineBad = false;
  let cwd = null;
  let currentCwd = null; // LAST cwd seen — a chat can move into a worktree mid-conversation
  let gitBranch = null;
  // The pull request this chat opened (V3 §H's PR badge). The CLI writes a
  // `pr-link` record every time it mentions the PR, not once — 500 of them
  // across the transcripts on this box for a handful of actual PRs — so this is
  // METADATA, kept as the latest one seen, and never a row. Rendering them would
  // put the same link in the transcript dozens of times.
  let prLink = null;
  let model = null;
  let modelName = null; // display name from a `/model` switch, when it's the most recent model signal
  // The model the CLI says it is RUNNING, off its own `attachment` record, which
  // is not the same string as `model` above. An assistant record names the base
  // model (`claude-opus-5`) whether the chat is a 200k one or a 1M one, and
  // Claude's larger window rides entirely on the `[1m]` suffix in the model
  // NAME. This attachment is the only place on disk that suffix ever appears:
  // across the 40 most recent transcripts on this box, 32 carry the record, 28
  // of those say `claude-opus-5[1m]` while every assistant record in the same
  // file says the bare id, and the ones that are genuinely 200k chats say the
  // bare id here too, so it discriminates rather than always claiming the
  // maximum. Without it a chat Termdeck did not launch has NO way to know its
  // own window, which is what made a 1M chat draw a 200k bar.
  //
  // Kept separate from `model` rather than overwriting it, deliberately: `model`
  // is what cost is priced off and what the next turn is sent as, and neither
  // should silently acquire a suffix. Last one wins, because the CLI writes a
  // fresh record when the model changes, so this follows a `/model` switch.
  let effectiveModel = null;
  let permissionMode = null;
  // Reasoning effort, per turn, straight off the assistant records. This was
  // read as "never in the transcript" for a long time and the scan simply had no
  // variable for it, so every Claude chat fell through to the GLOBAL default in
  // settings.json — which is why a chat started in the terminal reported whatever
  // that file said rather than what it actually ran with. The CLI does record it:
  // 1,525 assistant records carried `effort` across 8 transcripts on this box.
  let effort = null;
  let usage = null;
  let activeStartedAt = null;
  // Session-total tokens, for a cumulative cost estimate (matches Claude Code's
  // own /cost, which sums live in-process — this sums from disk instead, so it
  // survives reloads and works for CLI-driven sessions too). Claude Code writes
  // one jsonl line per assistant *content block*, and every block of a turn
  // repeats that turn's usage — dedupe by message.id or a multi-block turn
  // counts its own usage several times over.
  const cumUsage = { freshInput: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0, cacheCreate5m: 0, outputTokens: 0 };
  let cumUsageMessageId = usageSeed && usageSeed.usageId ? usageSeed.usageId : null;
  let sawUsage = false;
  // ONE restore point per prompt, sitting directly above that prompt. Both record
  // shapes scatter checkpoints through the middle of a turn, and rendering each
  // one where it landed drew a "checkpoint · 1 file · Restore files" row after
  // every single edit:
  //
  //   SDK (current CLI) — an empty `file-history-snapshot` at turn start, then one
  //     `file-history-delta` per file as it is backed up. All carry the same id,
  //     which is the uuid of the USER RECORD that opened the turn, so they are one
  //     restore point drawn a dozen times.
  //   interactive TUI    — a fresh checkpoint per EDIT, keyed on the assistant
  //     record that made it, each snapshot carrying the whole tracked set so far.
  //     Genuinely several restore points, all of them mid-turn.
  //
  // Both fold onto the prompt whose turn they belong to: the id when it names a
  // prompt, otherwise the prompt that was open when the record was written. A row
  // therefore carries a LIST of ids (`messageIds`), and restore takes the earliest
  // backup of each file across them — that, not any single id, is the state the
  // files were in before the prompt ran, which is what the button now claims.
  const cpById = new Map(); // checkpoint id -> { files: Set, timestamp, sighting, row }
  const cpRows = new Map(); // prompt message -> { message, ids: [] }
  const anchors = new Map(); // uuid -> the prompt message with that uuid
  let currentPrompt = null; // the prompt whose turn is open, for ids that name no prompt

  function feed(line) {
    const idx = lineCount;
    lineCount++;
    if (!line.trim()) {
      lastLineBad = false;
      return;
    }
    if (idx < since) {
      lastLineBad = false;
      return;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // A torn final line (live write in progress) must be re-read next
      // poll; mid-file garbage just counts as consumed.
      lastLineBad = true;
      return;
    }
    lastLineBad = false;
    // `cwd` is FIRST-wins and stays full-parse-only: it is the chat's home
    // project, and a delta's first record is not the FILE's first record.
    if (since === 0 && !cwd && typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd;
    // `currentCwd` is LAST-wins, so it is tracked on deltas too — same reason as
    // gitBranch below, and it was the half that was missing. EnterWorktree moves
    // a chat into a worktree mid-conversation; without this the open chat went on
    // naming the folder it had already left until it was reopened.
    if (typeof rec.cwd === 'string' && rec.cwd) currentCwd = rec.cwd;
    // LAST branch wins, like currentCwd: EnterWorktree moves a chat onto a new
    // branch mid-conversation, so the head record's branch is stale from then
    // on. Tracked on deltas too, so an open chat's header follows the move.
    if (typeof rec.gitBranch === 'string' && rec.gitBranch) gitBranch = rec.gitBranch;
    if (rec.type === 'pr-link' && typeof rec.prUrl === 'string' && /^https:\/\//.test(rec.prUrl)) {
      // https only, and the url is carried verbatim rather than rebuilt from
      // number + repository: a link the browser will open is not a string to
      // assemble from three fields that may disagree.
      prLink = {
        url: rec.prUrl.slice(0, 500),
        number: Number.isFinite(Number(rec.prNumber)) ? Number(rec.prNumber) : null,
        repository: typeof rec.prRepository === 'string' ? rec.prRepository.slice(0, 200) : null,
      };
    }
    const userAt = claudeUserInputTimestamp(rec);
    if (userAt) activeStartedAt = userAt;
    // Session settings: last value in the file wins. Model comes from real
    // assistant turns ("<synthetic>" marks error placeholders); permission
    // mode from the CLI's own bookkeeping records.
    // Permission mode is written on the CLI's own `permission-mode` records AND
    // on plain `user` records — 47 of the first kind and 30 of the second across
    // 8 transcripts here. Reading only the former meant a chat resolved its mode
    // or not depending on which kind happened to fall inside the loaded window,
    // which is what made it look intermittent. Checked outside the else-chain
    // below so a `user` record still reaches modelChoiceName() for `/model`.
    if (typeof rec.permissionMode === 'string' && rec.permissionMode) permissionMode = rec.permissionMode;
    // Checked outside the else-chain below for the same reason permissionMode is:
    // an attachment record must still reach modelChoiceName(). It never matches
    // there (that one requires type `user`), but the chain is not the place to
    // decide that. Sidechains excluded like the assistant branch: a subagent
    // runs its own model and that is not the chat's window.
    if (rec.type === 'attachment' && !rec.isSidechain && rec.attachment && rec.attachment.type === 'model') {
      const runningId = rec.attachment.identity && rec.attachment.identity.modelId;
      if (typeof runningId === 'string' && runningId) effectiveModel = runningId;
    }
    if (rec.type === 'assistant' && !rec.isSidechain && rec.message && typeof rec.message.model === 'string' && rec.message.model && rec.message.model !== '<synthetic>') {
      model = rec.message.model;
      modelName = null; // a real turn is authoritative — supersedes any earlier /model switch
      if (typeof rec.effort === 'string' && rec.effort) effort = rec.effort; // last real turn wins
      if (rec.message.usage) {
        usage = rec.message.usage; // last real turn's usage wins
        const msgId = rec.message.id || null;
        if (msgId && msgId !== cumUsageMessageId) {
          cumUsageMessageId = msgId;
          sawUsage = true;
          const u = rec.message.usage;
          cumUsage.freshInput += u.input_tokens || 0;
          cumUsage.cacheRead += u.cache_read_input_tokens || 0;
          cumUsage.cacheCreate += u.cache_creation_input_tokens || 0;
          cumUsage.cacheCreate1h += u.cache_creation?.ephemeral_1h_input_tokens || 0;
          cumUsage.cacheCreate5m += u.cache_creation?.ephemeral_5m_input_tokens || 0;
          cumUsage.outputTokens += u.output_tokens || 0;
        }
      }
    } else {
      const mn = modelChoiceName(rec);
      if (mn) modelName = mn; // /model after the last turn — current model until the next response
    }
    // A compaction states what the context holds afterwards (compactMetadata
    // .postTokens). Until the next assistant turn, that IS the occupancy: the
    // last turn's usage describes a context that no longer exists, which is how
    // the header meter sat at the pre-compact figure after /compact finished.
    if (rec.type === 'system' && rec.subtype === 'compact_boundary' && !rec.isSidechain) {
      const post = rec.compactMetadata && Number(rec.compactMetadata.postTokens);
      if (Number.isFinite(post) && post >= 0) usage = { input_tokens: post };
    }
    const message = recordToMessage(rec, allowSidechain);
    if (!message) return;
    // What this API response cost in tokens, on the message itself, so the
    // viewer can sum a turn's usage from disk (features/02 5.2): the live
    // run-complete frame said it and a reload had only the clock.
    if (message.role === 'assistant' && rec.type === 'assistant' && !rec.isSidechain && rec.message && rec.message.usage) {
      const mu = messageUsage(rec.message.usage, rec.message.model);
      if (mu) message.usage = mu;
    }
    // Never pushed where it lands — held until its prompt goes by (noteCheckpoint).
    if (message.role === 'checkpoint') {
      noteCheckpoint(message);
      return;
    }
    // A prompt opens a turn: it is the anchor every checkpoint in that turn folds
    // onto, and it stays reachable by uuid afterwards because the records that
    // fill a checkpoint in keep arriving long after the prompt has gone by.
    if (isUserPromptMessage(message)) {
      currentPrompt = message;
      if (message.uuid) {
        anchors.set(message.uuid, message);
        const st = cpById.get(message.uuid);
        if (st && !st.row) attachCheckpoint(message.uuid, st, message); // its row goes in first, so it lands above
      }
    }
    const prev = messages[messages.length - 1];
    // Claude Code writes one line per assistant content block; merge lines
    // sharing the same API message id into a single turn.
    if (
      prev &&
      prev.role === 'assistant' &&
      message.role === 'assistant' &&
      prev.messageId &&
      prev.messageId === message.messageId
    ) {
      prev.blocks.push(...message.blocks);
      if (message.usage) prev.usage = message.usage; // the response's later record has its final count
      return;
    }
    // A removed queue entry can land BETWEEN two content blocks of one assistant
    // message — queueing and un-queueing is exactly what people do while a turn
    // is streaming. The merge above only looks at the immediately preceding
    // message, so appending here would leave the next block unable to find its
    // turn and split one answer into two bubbles. It goes in ABOVE instead,
    // which keeps the merge tail intact and is the same placement checkpoints
    // use for the same reason. It is also honest: the removal happened during
    // that message, not after it.
    if (message.role === 'unqueued' && prev && prev.role === 'assistant' && prev.messageId) {
      messages.splice(messages.length - 1, 0, message);
      return;
    }
    // `/compact` is written AFTER what it produced: the CLI appends the boundary
    // and the summary first, then the command record (stamped when it was
    // typed) and its "Compacted" output. Read in file order the summary sat
    // above the command that asked for it (bugs.md B33), so the command and its
    // output go in above the compaction instead. Splicing never disturbs the
    // assistant-merge tail: neither row is an assistant record.
    const compactAt = compactCommandSlot(messages, message);
    if (compactAt >= 0) {
      messages.splice(compactAt, 0, message);
      return;
    }
    messages.push(message);
  }

  // Fold one checkpoint record (snapshot or delta) onto its turn. A file edited
  // twice is backed up once per edit and every record names it again, so the SET,
  // not the record count, is what gives the row an honest number.
  function noteCheckpoint(cp) {
    const id = cp.messageId;
    if (!id) return;
    let st = cpById.get(id);
    if (!st) {
      // `sighting` is the fallback anchor: the turn that was open when this
      // checkpoint was first written. It is only consulted at finish(), once the
      // id has had the whole file to turn up as a prompt of its own.
      st = { files: new Set(), timestamp: null, sighting: currentPrompt, row: null };
      cpById.set(id, st);
    }
    for (const f of (cp.blocks[0] && cp.blocks[0].files) || []) st.files.add(f);
    // Turn start is the moment being restored to, so the earliest stamp wins — a
    // delta's is whenever that one file happened to get copied, minutes in.
    if (cp.timestamp && (!st.timestamp || cp.timestamp < st.timestamp)) st.timestamp = cp.timestamp;
    // The prompt is normally long past by the time the first file is backed up.
    if (!st.row && anchors.has(id)) attachCheckpoint(id, st, anchors.get(id));
    else if (st.row) paintCheckpoint(st.row);
  }

  // Put `id` on its prompt's row, creating that row if this is the turn's first
  // checkpoint. Splicing never disturbs the assistant-merge tail: the row goes in
  // ABOVE the prompt, so whatever was last stays last.
  function attachCheckpoint(id, st, prompt) {
    let row = cpRows.get(prompt);
    if (!row) {
      row = {
        message: {
          role: 'checkpoint',
          messageId: id,
          uuid: null,
          timestamp: st.timestamp,
          blocks: [{ kind: 'checkpoint', files: [], fileCount: 0 }],
        },
        ids: [],
      };
      cpRows.set(prompt, row);
      const at = messages.indexOf(prompt);
      if (at >= 0) messages.splice(at, 0, row.message);
      else messages.push(row.message); // the prompt's own push is next in line
    }
    row.ids.push(id);
    st.row = row;
    paintCheckpoint(row);
  }

  // The row states what a press of Restore will actually do: every file any of
  // its checkpoints backed up, and the id list that restore resolves them from.
  function paintCheckpoint(row) {
    const files = new Set();
    let timestamp = null;
    for (const id of row.ids) {
      const st = cpById.get(id);
      if (!st) continue;
      for (const f of st.files) files.add(f);
      if (st.timestamp && (!timestamp || st.timestamp < timestamp)) timestamp = st.timestamp;
    }
    row.message.messageId = row.ids[0];
    row.message.timestamp = timestamp;
    row.message.blocks[0].files = [...files].slice(0, 60);
    row.message.blocks[0].fileCount = files.size;
    // One id is the common case (and the only one the SDK writes) — the list is
    // only worth its bytes when restore genuinely has to read more than one.
    if (row.ids.length > 1) row.message.blocks[0].messageIds = [...row.ids];
  }

  function finish() {
    // Whatever never named a prompt of its own belongs to the turn it was written
    // during — that is the older per-edit shape, and it is only safe to decide
    // here, once no later line can still turn the id into a prompt.
    for (const [id, st] of cpById) {
      if (!st.row && st.sighting) attachCheckpoint(id, st, st.sighting);
    }
    // What is left has no prompt to sit above: in a `?since` window that prompt
    // is already rendered above the window (an append-only delta cannot reach
    // back and change it), and in a full parse the turn opened with a record the
    // viewer doesn't render. The next full parse places it; restore, which is
    // keyed by id on the server, never depended on the row existing.
    cpById.clear();
    // Empty rows can't happen (a row is only made for a checkpoint that has an
    // id), but a row whose files all vanished would be a control that does
    // nothing — drop it rather than ship a lie.
    for (const row of cpRows.values()) {
      if (row.message.blocks[0].fileCount) continue;
      const at = messages.indexOf(row.message);
      if (at >= 0) messages.splice(at, 1);
    }
    const totalLines = lastLineBad ? lineCount - 1 : lineCount;
    return {
      messages, totalLines, cwd, currentCwd, gitBranch, prLink, model, modelName, effectiveModel, effort, permissionMode, usage,
      cumulativeUsage: sawUsage ? cumUsage : null,
      activeStartedAt,
      // Chained by the framed cursor and carried in the cursor token, never in a
      // parse RESULT: finishClaudeParse drops it, so a body off a cursor is the
      // one-shot's byte for byte (tests/parse-cursor.mjs).
      turnState: { usageId: cumUsageMessageId },
      // Only a seeded scan can claim this: what THESE lines added to a total the
      // seed's holder already has.
      usageDelta: usageSeed && sawUsage ? cumUsage : null,
    };
  }
  return { feed, finish };
}

function scanFile(filePath, since, allowSidechain = false) {
  return new Promise((resolve, reject) => {
    const scanner = makeClaudeScanner(since, allowSidechain);
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    stream.on('error', reject);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    // readline re-emits the stream error on the Interface; without this listener
    // an ENOENT (file deleted mid-read) becomes an unhandled 'error' → crash.
    rl.on('error', reject);
    rl.on('line', (line) => scanner.feed(line));
    rl.on('close', () => resolve(scanner.finish()));
  });
}

// Buffer-source twin of scanFile (the master gets transcript bytes over the tunnel, not a
// path). Splitting on '\n' and dropping the trailing empty reproduces readline's line set
// exactly, so torn-final-line handling and the `since` line-cursor match byte-for-byte.
function scanText(text, since, allowSidechain = false) {
  const scanner = makeClaudeScanner(since, allowSidechain);
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) scanner.feed(line);
  return scanner.finish();
}

// When a `?since` scan has to be thrown away and redone from line 0, i.e. when
// the delta it produced cannot be handed to a client as an append. Two cases:
//
//  - the file SHRANK (session restarted/compacted) between polls, so the
//    client's line cursor no longer points into this file at all;
//  - the delta is bigger than MAX_MESSAGES. finish*Parse truncates any list
//    over the cap to its LAST MAX_MESSAGES but still reports the full
//    totalLines, and the client's applyDelta appends what it got and takes
//    totalLines as its new cursor — so the head of the delta is dropped and the
//    cursor advances past it. That hole is permanent: `truncatedHead` is only
//    read by applyInitial, never by applyDelta. Rescanning turns it into a
//    reset, which the client repaints instead of splicing.
//
// Reachable from an ordinary laptop closed over a long agentic run, and from
// any pinned-live / cache-revalidate catch-up after a big burst.
function needsRescan(scan, since) {
  if (since <= 0) return false;
  return scan.totalLines < since || scan.messages.length > MAX_MESSAGES;
}

async function parseTranscript(filePath, since = 0) {
  let scan = await scanFile(filePath, since);
  let reset = false;
  if (needsRescan(scan, since)) {
    scan = await scanFile(filePath, 0);
    reset = true;
  }
  return finishClaudeParse(scan, since, reset);
}

function parseSubagentText(text) {
  return finishClaudeParse(scanText(text, 0, true), 0, false);
}

// What a chat's subagents spent, per model, summed over their own transcripts
// (<session>/subagents/agent-*.jsonl). The chat's cumulativeUsage never sees
// these: they are separate files and every record in them is isSidechain. Kept
// per model because a Haiku subagent under an Opus chat bills at Haiku's rate,
// and a single total would have to be priced at one of them.
//
// Resumable: feed() takes appended bytes, holds a partial last line until its
// newline arrives, and keeps the last message.id it summed so the content
// blocks of one API response (one record each, same id, same usage) count once,
// the rule makeClaudeScanner applies to the chat itself.
function createSubagentUsageTally() {
  const byModel = {};
  let pending = '';
  let lastId = null;
  const addRecord = (line) => {
    if (line.indexOf('"usage"') < 0) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    const msg = rec && rec.type === 'assistant' ? rec.message : null;
    if (!msg || !msg.usage || typeof msg.model !== 'string' || !msg.model || msg.model === '<synthetic>') return;
    const id = msg.id || null;
    if (id && id === lastId) return;
    lastId = id;
    const u = msg.usage;
    const t = byModel[msg.model] || (byModel[msg.model] = { freshInput: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0, cacheCreate5m: 0, outputTokens: 0 });
    t.freshInput += u.input_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.cacheCreate += u.cache_creation_input_tokens || 0;
    t.cacheCreate1h += (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0;
    t.cacheCreate5m += (u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens) || 0;
    t.outputTokens += u.output_tokens || 0;
  };
  return {
    feed(chunk) {
      const text = pending + (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const nl = text.lastIndexOf('\n');
      pending = nl < 0 ? text : text.slice(nl + 1);
      if (nl >= 0) for (const line of text.slice(0, nl).split('\n')) addRecord(line);
    },
    totals() { return byModel; },
  };
}

// Several tallies' answers, one per-model total. Null when nothing was spent.
function addSubagentUsage(a, b) {
  const out = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [model, u] of Object.entries(src)) {
      const t = out[model] || (out[model] = { freshInput: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0, cacheCreate5m: 0, outputTokens: 0 });
      for (const k of Object.keys(t)) t[k] += u[k] || 0;
    }
  }
  return Object.keys(out).length ? out : null;
}

// Every background shell this transcript ever started, read back off DISK.
//
// The live registry (machine-host's `shells`) is memory only — it is built from
// the turn stream and dies with the master process, so after any restart a chat
// that left a dev server running has nothing to show for it. The transcript
// does, because the CLI writes both halves down:
//
//   tool_use   { name:'Bash', input:{ command, description?, run_in_background:true } }
//   result     a SENTENCE naming the task id and the output path
//
// Both halves are needed and neither is optional: the command is only in the
// first, the id and log path only in the second, and they are separate records.
//
// This is also the only source that attributes a shell to the right CHAT. The
// log path embeds the ROOT session id, not the resumed one — a chat resumed
// three times writes its shell output under the id of the session that first
// started (verified on disk: a transcript for 20fab244… holds a shell logged
// under 6904efb5…). Recovering by walking the scratchpad would therefore file
// those shells under a chat that never ran them; recovering from the transcript
// cannot, because the transcript IS the chat.
//
// Deliberately its own scan rather than a pass over parsed messages: this needs
// the raw tool_result text, which the parser folds away, and it wants to be
// cheap enough to run on a chat open.
const BG_START_RE = /Command running in background with ID:\s*([A-Za-z0-9_-]+)/;
const BG_LOG_RE = /Output is being written to:\s*(.+?\.output)\b/;
const TASK_NOTIF_ID_RE = /<task-id>([\s\S]*?)<\/task-id>/;
// A shell's ENDING, as the CLI itself recorded it. Same frame the live path
// reads off the stream (lib/claude-events.js), in its on-disk spelling, so
// a shell that ended while the master was not watching still gets its outcome
// rather than the "not tracked" a bare recovery can offer.
//
// 'stopped'/'killed'/'cancelled' collapse onto the word a TaskStop already
// carries; the two worth telling apart are the ordinary end and a failure, since
// a non-zero exit is the reason anyone opens the log.
const SHELL_NOTIF_STATUS = {
  completed: 'exited',
  failed: 'failed',
  stopped: 'stopped',
  killed: 'killed',
  cancelled: 'stopped',
};

// The same scan as a scanner that can be FED: the agent keeps one per
// transcript and hands it only what was appended since (features/04 phase 9),
// so a chat open no longer re-reads the whole file to find its shells. A start
// and its result can land in different feeds; `pending` carries the start.
function createShellScanner(from = null) {
  const pending = new Map(from ? from.pending : []); // tool_use_id -> { command, description }
  const out = from ? from.out.map((s) => ({ ...s })) : [];
  // backgroundTaskId -> { status, endedAt }. Collected as the lines go by and
  // applied at the end, because a notification can only ever land AFTER the
  // start it refers to.
  const ended = new Map(from ? from.ended : []);
  // tool_use_id -> { status, endedAt }: how each backgrounded RUN ended, keyed by
  // the call its notification names (an Agent spawn, or the SendMessage that
  // resumed one). The sub-agent panel reads it so a card whose ending scrolled
  // past a tab that was away (a reconnect, a background tab catching up with a
  // fresh window) is not left reading "running" forever.
  const runs = new Map(from ? from.runs : []);
  const feed = (text) => { scanShellLines(String(text || ''), pending, out, ended, runs); };
  // `status` is absent when the transcript never recorded an ending, and absent
  // is meaningful: it is the shell that may STILL BE RUNNING, which the caller
  // must not claim to know the outcome of.
  const result = () => out.map((s) => {
    const end = ended.get(s.id);
    return end ? { ...s, status: end.status, endedAt: end.endedAt } : { ...s };
  });
  const runEndings = () => Object.fromEntries(runs);
  const clone = () => createShellScanner({ pending, out, ended, runs });
  return { feed, result, runEndings, clone };
}

function scanBackgroundShells(text) {
  const scanner = createShellScanner();
  scanner.feed(text);
  return scanner.result();
}

// One-shot twin of the scanner's runEndings(), for a caller holding the whole text.
function scanRunEndings(text) {
  const scanner = createShellScanner();
  scanner.feed(text);
  return scanner.runEndings();
}

// The terminal statuses a run notification can carry, as the CLI spells them.
// 'running' and anything else the CLI adds later end nothing.
const RUN_END_STATUSES = new Set(['completed', 'failed', 'stopped', 'killed', 'cancelled']);

function scanShellLines(text, pending, out, ended, runs = null) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    // The CLI writes the same notification up to three times (a queue enqueue, a
    // queued_command attachment, a queue remove). Any one of them carries the
    // task id and the status, so this reads whichever comes first and lets the
    // rest overwrite it with the same values rather than picking a record type
    // and being wrong when the CLI adds a fourth.
    if (line.includes('<task-notification>')) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const xml = typeof rec.content === 'string' ? rec.content
        : rec.attachment && typeof rec.attachment.prompt === 'string' ? rec.attachment.prompt
          : rec.message && typeof rec.message.content === 'string' ? rec.message.content
            : null;
      const body = xml && (TASK_NOTIF_RE.exec(xml) || [])[1];
      if (!body) continue;
      const id = ((TASK_NOTIF_ID_RE.exec(body) || [])[1] || '').trim();
      const status = ((TASK_NOTIF_STATUS_RE.exec(body) || [])[1] || '').trim();
      const mapped = SHELL_NOTIF_STATUS[status];
      // Only a TERMINAL status ends anything. The CLI also emits these while a
      // task is still going ('running'), and treating one of those as an ending
      // would report a live dev server as finished, which is the same class of
      // lie in the opposite direction.
      if (id && mapped) ended.set(id, { status: mapped, endedAt: Date.parse(rec.timestamp || '') || null });
      const toolUseId = ((TASK_NOTIF_TOOLUSEID_RE.exec(body) || [])[1] || '').trim();
      if (runs && toolUseId && RUN_END_STATUSES.has(status)) runs.set(toolUseId, { status, endedAt: Date.parse(rec.timestamp || '') || null });
      continue;
    }
    // Cheap reject: most lines of a transcript are none of the three.
    if (!line.includes('run_in_background') && !line.includes('running in background')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const content = rec && rec.message && rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b && b.type === 'tool_use' && b.name === 'Bash' && b.input && b.input.run_in_background) {
        pending.set(b.id, {
          command: typeof b.input.command === 'string' ? b.input.command : '',
          description: typeof b.input.description === 'string' ? b.input.description : null,
        });
        continue;
      }
      if (!b || b.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
      const start = pending.get(b.tool_use_id);
      pending.delete(b.tool_use_id);
      const body = typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content) ? b.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n') : '';
      const id = (BG_START_RE.exec(body) || [])[1] || null;
      const logPath = (BG_LOG_RE.exec(body) || [])[1] || null;
      // No id is no shell: it is the handle the log read and every later frame
      // are keyed on, and a row without one could never be opened.
      if (!id) continue;
      out.push({
        id,
        command: start.command,
        description: start.description,
        logPath,
        startedAt: Date.parse(rec.timestamp || '') || null,
      });
    }
  }
}

// Byte-source twin: parse a transcript held in memory (relay/tunnel). Same semantics.
function parseTranscriptText(text, since = 0) {
  let scan = scanText(text, since);
  let reset = false;
  if (needsRescan(scan, since)) {
    scan = scanText(text, 0);
    reset = true;
  }
  return finishClaudeParse(scan, since, reset);
}

// The 5,000-message cap, and how many turns it cut: a turn is a prompt the
// user typed, so the notice can say what is missing in the reader's own unit
// (features/02 4.8).
function capHead(messages) {
  if (messages.length <= MAX_MESSAGES) return { messages, truncatedHead: false, truncatedTurns: 0 };
  const cut = messages.length - MAX_MESSAGES;
  let truncatedTurns = 0;
  for (let i = 0; i < cut; i += 1) if (isUserPromptMessage(messages[i])) truncatedTurns += 1;
  return { messages: messages.slice(cut), truncatedHead: true, truncatedTurns };
}

function finishClaudeParse(scan, since, reset) {
  const { messages, truncatedHead, truncatedTurns } = capHead(scan.messages);
  const result = {
    messages,
    totalLines: scan.totalLines,
    reset,
    truncatedHead,
  };
  if (truncatedHead) result.truncatedTurns = truncatedTurns;
  if (since === 0 || reset) {
    result.cwd = scan.cwd || null;
    result.currentCwd = scan.currentCwd || null;
    result.gitBranch = scan.gitBranch || null;
    result.prLink = scan.prLink || null;
    result.model = scan.model || null;
    result.modelName = scan.modelName || null;
    result.effectiveModel = scan.effectiveModel || null;
    result.effort = scan.effort || null;
    result.permissionMode = scan.permissionMode || null;
    result.usage = claudeUsage(scan.usage);
    result.activeStartedAt = scan.activeStartedAt || null;
    // Already in canonical shape (see makeClaudeScanner) — no per-message
    // transform needed, it's a running sum, not one API usage object.
    result.cumulativeUsage = scan.cumulativeUsage || null;
  } else {
    // Model/mode can change mid-session (CLI /model, mode switch). Forward them on
    // deltas too — but only when this delta actually saw one — so an open session
    // live-updates without a reopen, and a delta carrying neither leaves the field
    // absent (client keeps its current value). modelName carries a /model switch
    // that hasn't produced a turn yet (no assistant record to read a model id from).
    if (scan.model) result.model = scan.model;
    if (scan.modelName) result.modelName = scan.modelName;
    // Absent on most deltas, since the record is written when the model is
    // announced, usually once at the head. Absent means "keep what you have",
    // which is exactly right: the window has not changed unless a record says so.
    if (scan.effectiveModel) result.effectiveModel = scan.effectiveModel;
    if (scan.effort) result.effort = scan.effort;
    if (scan.gitBranch) result.gitBranch = scan.gitBranch;
    if (scan.prLink) result.prLink = scan.prLink;
    // Where the chat is running NOW. The branch alone does not move the header
    // path — it is read off the cwd — so a chat that entered a worktree mid-turn
    // kept claiming the folder it opened in. `cwd` is deliberately absent here:
    // see the scanner, it is first-wins.
    if (scan.currentCwd) result.currentCwd = scan.currentCwd;
    if (scan.permissionMode) result.permissionMode = scan.permissionMode;
    if (scan.activeStartedAt) result.activeStartedAt = scan.activeStartedAt;
    // scan.usage is last-value-wins over just this delta's lines, so when the
    // delta contains a new turn it's already the single latest turn's real
    // occupancy — safe to forward (unlike cumulativeUsage, which would only
    // cover this delta's slice, not the whole session).
    if (scan.usage) result.usage = claudeUsage(scan.usage);
  }
  // A seeded delta only (features/04): the caller holds the running total this
  // adds to. An unseeded parse never carries it, which is what keeps a cursor's
  // result deep-equal to the one-shot's.
  if (scan.usageDelta) result.usageDelta = scan.usageDelta;
  return result;
}

/* ---------- resumable parse cursor (features/70-parse-cursor.md) ---------- */

// One growing transcript, parsed as it grows. feed(bytes) takes ONLY the bytes
// appended since the previous feed and returns exactly what the one-shot path
// returns for that poll today: parseTranscriptText(wholeTextSoFar, lastTotal).
// The whole file used to be re-decoded and re-split on every poll of a live
// turn; the cursor makes an append cost the append.
//
// The equivalence is exact, not approximate (tests/parse-cursor.mjs holds it to
// deep-equality across every split point of a fixture), and it is possible
// because a one-shot scan builds NO state from pre-`since` lines: feed() above
// returns before parsing them, so they contribute a line count and nothing
// else. A fresh scanner per feed, seeded with the absolute line number, is
// therefore the same computation as today's full re-scan minus the redundant
// decode and split of everything already consumed.
//
// Line framing carries the byte stream across feeds:
//  - complete lines (newline-terminated) are fed and counted;
//  - an unterminated tail that parses as JSON, or is only whitespace, is fed
//    and counted too, because the one-shot feeds it (a record the CLI wrote
//    without its newline yet); `swallowToNL` then discards that line's eventual
//    terminator, or any accidental continuation, exactly as the one-shot skips
//    the already-counted line on later polls;
//  - any other unterminated tail is held back unfed, still as BYTES so a torn
//    UTF-8 character keeps failing until its other half arrives. The one-shot
//    feeds it, fails to parse it, and excludes it from totalLines
//    (lastLineBad), so both report the same cursor and both parse the
//    completed line on a later poll;
//  - `endedBad`: when the last consumed line was terminated garbage the
//    one-shot re-reads it every poll (it is the last line, so lastLineBad keeps
//    excluding it) until new content arrives. The cursor reports the same
//    totalLines without the re-read; a deterministic parse failure emits
//    nothing, so skipping the re-read changes no output.
//
// Contract: the FIRST feed must carry the whole file so far (the caller's
// readAll), paired with `since` = the caller's line cursor; later feeds carry
// only appended bytes. A result with `needsRescan: true` is not a usable delta
// (same predicate as needsRescan above; the over-cap catch-up case): the caller
// must discard this cursor and feed a fresh one the whole file, which
// reproduces the reset the one-shot path produces today. Every result carries
// `bytesExamined` (remainder + chunk, what this call actually decoded or
// scanned) so a test can pin that appending one line costs one line.
const NL_BYTE = 0x0a;
const EMPTY_BYTES = Buffer.alloc(0);

function jsonLineOk(s) {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function countNewlineBytes(buf, from, to) {
  let n = 0;
  for (let i = buf.indexOf(NL_BYTE, from); i !== -1 && i < to; i = buf.indexOf(NL_BYTE, i + 1)) n += 1;
  return n;
}

// The framing is engine-agnostic; each engine supplies its per-feed scan and
// its finish. scanLines(lines, tailLine, since, startLine, seed) must treat
// startLine as the absolute line number of lines[0] and skip nothing but
// pre-`since` lines; finishParse is the engine's finish*Parse. `seed` is the
// engine's carried turn state (codex/grok): each feed passes the previous
// feed's scan.turnState, exactly as machine-host chains cached.turn between
// one-shot polls, and the rescan drops it just as parse*Text rescans with null.
// `resume` restarts a cursor from a byte position another process (or an
// earlier master) left off at: { lines, byteOffset, nlOwed, turnState }, which
// is exactly what state() below hands out and what the cursor token carries
// across a restart (features/04). A resumed cursor has NOT had its first feed:
// it may never rescan in place, because the bytes before `byteOffset` are not
// coming again. That is why `firstFeed` is false and an over-cap delta comes
// back as needsRescan for the caller to answer with a full read.
function makeFramedCursor(sinceOpt, scanLines, finishParse, initialSeed, ringBytes = 0, resume = null) {
  const initialSince = Math.max(0, Math.floor(sinceOpt) || 0);
  let seed = resume && resume.turnState != null ? resume.turnState : (initialSeed == null ? null : initialSeed);
  let firstFeed = !resume;
  let lineNo = resume ? resume.lines : 0; // absolute count of lines consumed (fed to a scanner)
  let lastReported = resume ? resume.lines : initialSince; // last totalLines handed out; the next feed's `since`
  let remainder = EMPTY_BYTES; // held unterminated tail, not yet fed
  let swallowToNL = resume ? !!resume.nlOwed : false; // consumed a tail with no newline; its terminator is still owed
  let endedBad = false; // last consumed line was terminated garbage (see header)
  let bytesSeen = resume ? resume.byteOffset : 0; // total bytes accepted; the caller's stat cursor, now that no buffer accumulates
  let dead = false;
  // The last COMPLETE line's bytes (its own plus its newline), and whether
  // excluding it as garbage is what reduced the reported total. Together they
  // are the difference between "where the bytes end" and "where a re-read must
  // start": the one-shot re-reads a terminated garbage last line on every poll
  // (lastLineBad keeps excluding it), so a resume that started past it would
  // report a line the one-shot does not. Only ever set from the split below, in
  // BYTES, because re-encoding a decoded line would mis-measure a torn one.
  let lastCompleteLen = 0;
  let badExcluded = false;
  // Preview ring: the last <= 2 * ringBytes raw bytes of everything accepted,
  // plus the absolute byte and line offsets of its start, so previewSlice can
  // answer what sliceTail(wholeFile, ringBytes) would answer without anyone
  // holding the whole file. This is what replaced the per-subscriber whole-file
  // buffer pin (a 50 MB chat used to hold 50 MB of RAM per machine-host).
  let ring = EMPTY_BYTES;
  let ringStartByte = resume ? resume.byteOffset : 0;
  let ringStartLine = resume ? resume.lines : 0;

  function feed(chunkIn) {
    if (dead) throw new Error('parse cursor is dead after needsRescan; build a fresh one');
    let chunk = Buffer.isBuffer(chunkIn) ? chunkIn : Buffer.from(chunkIn == null ? '' : String(chunkIn), 'utf8');
    bytesSeen += chunk.length;
    const bytesExamined = remainder.length + chunk.length;
    if (ringBytes > 0 && chunk.length) {
      ring = ring.length ? Buffer.concat([ring, chunk]) : Buffer.from(chunk);
      if (ring.length > ringBytes * 2) {
        const dropTo = ring.length - ringBytes;
        ringStartLine += countNewlineBytes(ring, 0, dropTo);
        ringStartByte += dropTo;
        ring = Buffer.from(ring.subarray(dropTo)); // copy, so the trimmed prefix actually frees
      }
    }
    if (swallowToNL && chunk.length) {
      const at = chunk.indexOf(NL_BYTE);
      if (at === -1) chunk = EMPTY_BYTES;
      else {
        chunk = chunk.subarray(at + 1);
        swallowToNL = false;
      }
    }
    const buf = remainder.length ? Buffer.concat([remainder, chunk]) : chunk;

    const lines = [];
    let start = 0;
    let lastLineBytes = 0; // the last complete line, newline included, in bytes
    for (let at = buf.indexOf(NL_BYTE); at !== -1; at = buf.indexOf(NL_BYTE, start)) {
      lines.push(buf.subarray(start, at).toString('utf8'));
      lastLineBytes = at + 1 - start;
      start = at + 1;
    }
    const tail = start < buf.length ? buf.subarray(start) : EMPTY_BYTES;
    let tailLine = null;
    if (tail.length) {
      const s = tail.toString('utf8');
      if (!s.trim() || jsonLineOk(s)) tailLine = s;
    }
    const heldTail = tail.length > 0 && tailLine === null;
    const fedCount = lines.length + (tailLine === null ? 0 : 1);

    const sinceForFeed = firstFeed ? initialSince : lastReported;
    const runScan = (sinceArg, seedArg) => scanLines(lines, tailLine, sinceArg, lineNo, seedArg);
    const newLineNo = lineNo + fedCount;
    // Reported totalLines must match the one-shot, which also feeds the held
    // tail and then excludes it (lastLineBad). With the tail held back, the
    // exclusion is only owed when the last CONSUMED line was the bad one.
    const reported = (scan) => {
      const bad = fedCount > 0 ? scan.totalLines < newLineNo : endedBad;
      return { bad, total: heldTail ? newLineNo : newLineNo - (bad ? 1 : 0) };
    };

    let scan = runScan(sinceForFeed, seed);
    const { bad, total } = reported(scan);
    scan.totalLines = total;
    let reset = false;
    if (needsRescan(scan, sinceForFeed)) {
      if (!firstFeed) {
        dead = true;
        return { needsRescan: true };
      }
      scan = runScan(0, null);
      scan.totalLines = reported(scan).total;
      reset = true;
    }

    firstFeed = false;
    lineNo = newLineNo;
    endedBad = bad;
    // A held tail is the line the one-shot excludes, so the terminated garbage
    // before it was COUNTED and must not be rewound past; `remainder` already
    // covers the held tail itself.
    if (fedCount > 0) {
      lastCompleteLen = lastLineBytes;
      badExcluded = bad && !heldTail;
    }
    swallowToNL = tailLine !== null;
    remainder = heldTail ? Buffer.from(tail) : EMPTY_BYTES; // copy: a subarray would pin the whole chunk
    lastReported = scan.totalLines;
    if ('turnState' in scan) seed = scan.turnState;

    const result = finishParse(scan, sinceForFeed, reset);
    result.needsRescan = false;
    result.bytesExamined = bytesExamined;
    return result;
  }

  // In-ring twin of sliceTail(wholeFileSoFar, maxBytes): same buf, startLine and
  // whole for every ask the ring can cover. Null means the caller must read the
  // tail itself: the ring is stale against the disk (expectedSize mismatch), the
  // ask is wider than the ring keeps, or there is no line boundary in the window
  // (one enormous line, whose whole-file answer only the reader of the whole
  // file can give).
  function previewSlice(expectedSize, maxBytes) {
    if (dead || !ringBytes || expectedSize !== bytesSeen) return null;
    if (bytesSeen <= maxBytes) {
      if (ringStartByte !== 0) return null; // trimmed below a whole-file ask
      return { buf: ring, startLine: 0, whole: true };
    }
    const target = bytesSeen - maxBytes;
    if (target < ringStartByte) return null; // ask wider than the ring keeps
    const rel = ring.indexOf(NL_BYTE, target - ringStartByte);
    if (rel === -1) return null;
    return { buf: ring.subarray(rel + 1), startLine: ringStartLine + countNewlineBytes(ring, 0, rel + 1), whole: false };
  }

  // Where a fresh cursor would have to start to produce what this one has
  // produced. Not `bytesSeen`: that is bumped before the torn tail is held back
  // and before a terminated garbage last line is excluded, and a resume at that
  // byte would skip a line the one-shot re-reads. This is the whole of what the
  // cursor token carries (features/04), so it is the one place the arithmetic
  // lives.
  function state() {
    return {
      lines: lastReported,
      byteOffset: bytesSeen - remainder.length - (badExcluded ? lastCompleteLen : 0),
      nlOwed: swallowToNL,
      turnState: seed,
      dead,
    };
  }

  return { feed, bytesSeen: () => bytesSeen, previewSlice, ringSize: () => ring.length, state };
}

// The same arithmetic as state(), computed over a buffer somebody else parsed:
// the byte a fresh cursor must resume at, and whether the last counted line
// still owes its newline. Mirrors the framing rules in the header exactly, so a
// token minted from a one-shot read resumes where a cursor would have.
//
// `baseOffset`/`baseLines` place a SLICE: a tail read starts at
// (size - buf.length) and at the line the agent counted for it, and the answer
// has to be in whole-file terms or it names a byte in the wrong file.
function byteCursorFor(bufIn, totalLines, { baseOffset = 0, baseLines = 0 } = {}) {
  const buf = Buffer.isBuffer(bufIn) ? bufIn : Buffer.from(bufIn == null ? '' : String(bufIn), 'utf8');
  const lines = Math.max(0, Math.floor(totalLines) || 0);
  const lastNL = buf.lastIndexOf(NL_BYTE);
  const tail = lastNL === -1 ? buf : buf.subarray(lastNL + 1);
  if (tail.length) {
    const s = tail.toString('utf8');
    // Counted by the one-shot (a record written without its newline yet, or
    // whitespace): the resume point is the end, and the terminator is owed.
    if (!s.trim() || jsonLineOk(s)) return { lines, byteOffset: baseOffset + buf.length, nlOwed: true };
    // Held back unfed: the one-shot excludes it from totalLines and parses it
    // on a later poll, so a resume must start AT it.
    return { lines, byteOffset: baseOffset + buf.length - tail.length, nlOwed: false };
  }
  // Ends on a newline. One case left: a terminated last line that is garbage is
  // excluded and re-read every poll, so the resume starts at it.
  const prevNL = lastNL <= 0 ? -1 : buf.lastIndexOf(NL_BYTE, lastNL - 1);
  const lastLine = buf.subarray(prevNL + 1, lastNL).toString('utf8');
  if (lastLine.trim() && !jsonLineOk(lastLine) && baseLines + countNewlineBytes(buf, 0, buf.length) > lines) {
    return { lines, byteOffset: baseOffset + prevNL + 1, nlOwed: false };
  }
  return { lines, byteOffset: baseOffset + buf.length, nlOwed: false };
}

// The per-engine factory machine-host wires the delta stream through. `since`
// is the caller's line cursor for the first feed; `turnSeed` is the carried
// turn state for that first feed (codex/grok), exactly what the caller handed
// the one-shot parser per poll.
function createParseCursor(engine, opts = {}) {
  const since = opts.since || 0;
  const ringBytes = opts.ringBytes || 0;
  // A resume overrides `since`: it names the line AND the byte the caller left
  // off at, and carries the turn state that went with them (features/04).
  const resume = opts.resume || null;
  if (engine === 'claude') {
    const allowSidechain = !!opts.allowSidechain;
    const scanClaude = (lines, tailLine, s, startLine, seedArg) => {
      const scanner = makeClaudeScanner(s, allowSidechain, startLine, seedArg);
      for (const line of lines) scanner.feed(line);
      if (tailLine !== null) scanner.feed(tailLine);
      return scanner.finish();
    };
    return makeFramedCursor(since, scanClaude, finishClaudeParse, null, ringBytes, resume);
  }
  if (engine === 'codex') {
    const scanCodex = (lines, tailLine, s, startLine, seedArg) =>
      scanRolloutLines(tailLine === null ? lines : lines.concat(tailLine), s, seedArg, startLine);
    return makeFramedCursor(since, scanCodex, finishRolloutParse, opts.turnSeed, ringBytes, resume);
  }
  if (engine === 'grok') {
    const scanGrok = (lines, tailLine, s, startLine, seedArg) =>
      scanGrokLines(tailLine === null ? lines : lines.concat(tailLine), s, seedArg, startLine);
    return makeFramedCursor(since, scanGrok, finishGrokParse, opts.turnSeed, ringBytes, resume);
  }
  throw new Error(`no parse cursor for engine: ${engine}`);
}

// Canonical wire shape shared by both engines and the live run-complete event:
// { contextTokens, inputTokens, freshInput, cacheRead, cacheCreate, outputTokens,
// contextWindow }. contextTokens is the current context occupancy (the input side
// of the last turn) and always == cacheRead + cacheCreate + freshInput, so the UI
// can render a segmented breakdown that sums to the total. Computed per engine
// because Claude's input_tokens EXCLUDES cache reads while Codex's INCLUDES them.
// contextWindow is null for Claude (the frontend fills it from max_input_tokens)
// and comes straight off the rollout for Codex.
// One API response's usage, as it rides on its assistant message: the same
// field names claudeUsage reports for the session, zero TTL buckets left out to
// keep the record small, and the model it was billed on so the viewer can price
// it. null when the response counted nothing (a synthetic error placeholder).
function messageUsage(u, model) {
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const out = {
    freshInput: n(u.input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheCreate: n(u.cache_creation_input_tokens),
    outputTokens: n(u.output_tokens),
  };
  const c1h = n(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens);
  const c5m = n(u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens);
  if (c1h) out.cacheCreate1h = c1h;
  if (c5m) out.cacheCreate5m = c5m;
  if (!out.freshInput && !out.cacheRead && !out.cacheCreate && !out.outputTokens) return null;
  if (typeof model === 'string' && model && model !== '<synthetic>') out.model = model;
  return out;
}

function claudeUsage(u) {
  if (!u) return null;
  return {
    contextTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    inputTokens: u.input_tokens ?? null,
    freshInput: u.input_tokens ?? null, // Claude input_tokens is already the uncached-new portion
    cacheRead: u.cache_read_input_tokens ?? null,
    cacheCreate: u.cache_creation_input_tokens ?? null,
    // cacheCreate's TTL split — write pricing differs (1h ≈2x input, 5m ≈1.25x)
    // and both cost the same regardless of engine, so this is exposed alongside
    // the combined total rather than replacing it.
    cacheCreate1h: u.cache_creation?.ephemeral_1h_input_tokens ?? null,
    cacheCreate5m: u.cache_creation?.ephemeral_5m_input_tokens ?? null,
    outputTokens: u.output_tokens ?? null,
    contextWindow: null,
  };
}

/* ================= Codex rollouts ================= */

// parseTranscript's twin for Codex rollout jsonl (record shapes: PHASE5.md §4).
// Same contract and torn-final-line semantics, same block vocabulary out.
// Rollouts have no API message id, so assistant records merge on a synthesized
// per-turn id (turn boundary = event_msg/task_started); `turnSeed` threads that
// id across incremental scans — the watcher keeps it in its fileCache. A
// mid-turn scan with no seed (WS-resubscribe REST call) falls back to a
// per-scan orphan id: the turn tail renders as a separate bubble, cosmetic only.

// Cold rollouts are zstd-compressed in place (.jsonl.zst). decodeRollout is split out so
// the master can decompress bytes it pulled over the tunnel (agent forwards .zst raw).
function decodeRollout(buf, name) {
  if (!name.endsWith('.zst')) return buf.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('compressed rollout needs Node >= 22.15 (zlib zstd support)');
  }
  return zlib.zstdDecompressSync(buf).toString('utf8');
}

async function readRolloutRaw(filePath) {
  return decodeRollout(await fsp.readFile(filePath), filePath);
}

// User-role records that aren't things the user typed. Both shapes below were
// read off real rollouts, not guessed.
//
// 1. Auto-injected context blocks open with a lowercase tag ALONE on the
//    record's first line: <task-notification>, <recommended_plugins>,
//    <environment_context>, <turn_aborted>… The CLI grows new ones as it gains
//    features, and a hardcoded list silently goes stale — an unknown tag then
//    reads as a real prompt and becomes the chat's TITLE. That is exactly how
//    "<recommended_plugins> Here is a list of" ended up naming a chat: the tag
//    shipped after the list was written. Matching the SHAPE handles the next one
//    before it appears. Note the hyphens: most of these are kebab, not snake.
//
//    The required newline is the guard against over-matching. An injected block
//    puts its tag on its own line, so a real prompt that merely opens with markup
//    ("<div>…" pasted inline) still titles normally.
//
//    It does still catch a prompt that IS a pasted block opening with a bare tag
//    on line 1 ("<html>\n<body>…"). That's deliberate: the parse keeps scanning
//    on a skip, so such a chat takes its title from the next message — a mild,
//    self-correcting miss, and a better title than "<html> <body>" regardless.
//    The alternative (requiring the _ or - that every tag observed so far has)
//    would spare it, but hand the reported bug straight back the first time the
//    CLI ships a single-word tag.
const SYNTHETIC_BLOCK_RE = /^<\/?[a-z][a-z0-9_-]*>[ \t]*\r?\n/;

// 2. Shapes the tag rule can't see, so they're named outright: an open tag
//    carrying attributes; a markdown heading; and the slash-command echoes,
//    which sit INLINE (<command-name>/model</command-name>) with no newline.
//    Excluding those matches the Claude side, whose title parse already skips
//    command echoes — running /model shouldn't rename your chat.
const SYNTHETIC_USER_PREFIXES = [
  '<permissions',
  '<user_instructions>', // shape unverified in the wild — keep it named
  '# AGENTS.md instructions',
  '<command-name>',
  '<command-message>',
  '<local-command-stdout>',
  '<ide_opened_file>', // inline: "<ide_opened_file>The user opened the file …"
];

function isSyntheticUserText(text) {
  const t = String(text).trimStart();
  return SYNTHETIC_BLOCK_RE.test(t) || SYNTHETIC_USER_PREFIXES.some((p) => t.startsWith(p));
}

// Sort key = "when did I last type here". Timestamp (ms epoch) of the last real
// user PROMPT in a Claude jsonl chunk, scanning bottom-up. Skips tool_result /
// meta / sidechain records and slash-command + local-command echoes (same
// exclusion the title head-parse uses), so background activity never reorders a
// chat above one the user actually spoke to more recently. null if none found.
function lastClaudeUserInputAt(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // tail may cut line 0 in half
    if (rec.type !== 'user' || rec.isMeta || rec.isSidechain || rec.attachment) continue;
    const c = rec.message && rec.message.content;
    // A CLI killed mid-turn writes "[Request interrupted by user]" — nobody typed
    // it, so it must not reorder the sidebar as if somebody had. See recordToMessage.
    if (rec.interruptedByShutdown && isShutdownInterruptText(c)) continue;
    const parts = typeof c === 'string' ? [c]
      : Array.isArray(c) ? c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text) : [];
    const typed = parts.some((t) => {
      const tt = t.trim();
      return tt && !tt.startsWith('<command-') && !tt.startsWith('<local-command') && !tt.startsWith('<task-notification');
    });
    if (!typed) continue;
    const ts = Date.parse(rec.timestamp);
    return Number.isNaN(ts) ? null : ts;
  }
  return null;
}

// Codex rollout timestamps are normally ISO 8601 strings with an explicit
// offset. Keep that offset mandatory: Date.parse treats a zone-less timestamp
// as local time, so the same rollout would sort differently on an India laptop
// and a Germany server. Numeric provider timestamps are accepted in either
// seconds or milliseconds, with the magnitude making the unit explicit.
function codexTimestampMs(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value < 100_000_000_000 ? value * 1000 : value;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/(?:z|[+-]\d\d:?\d\d)$/i.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

// When did this chat last DO something? The timestamp of the final dated record
// in a transcript tail chunk, scanning bottom-up. Every engine, because the
// question is the same and only the field the stamp sits in differs.
//
// This exists because a file's mtime is not that answer. A CLI holding a chat
// open keeps touching its jsonl long after the conversation stopped: measured on
// a live fleet, three terminal-held Claude chats reported mtimes 3, 23 and 347
// MINUTES newer than their own last record. The worst of them rendered "22m ago"
// for a chat nobody had spoken to since breakfast. The sidebar's "3h ago" is
// asking about the conversation, so it has to read the conversation.
//
// Any dated record counts, not just a message: a turn ends on a `turn_duration`
// system record, and "the transcript grew" is the honest reading of when the
// chat last moved. null when the chunk holds no dated record at all (the caller
// falls back to mtime, which is wrong by minutes rather than by hours).
function lastRecordAt(text, engine) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; } // the tail window may cut line 0 in half
    // Grok stamps the ACP frame, in seconds, with the agent's own ms clock beside
    // it, in the same precedence lastGrokUserInputAt reads them in.
    const ts = engine === 'grok'
      ? (rec && rec.params && rec.params._meta && rec.params._meta.agentTimestampMs)
        || (typeof rec.timestamp === 'number' ? rec.timestamp * 1000 : NaN)
      : engine === 'codex' ? codexTimestampMs(rec && rec.timestamp) : Date.parse(rec && rec.timestamp);
    if (Number.isFinite(ts) && ts > 0) return ts;
  }
  return null;
}

function claudeUserInputTimestamp(rec) {
  if (!rec || rec.type !== 'user' || rec.isMeta || rec.isSidechain || rec.attachment) return null;
  const c = rec.message && rec.message.content;
  if (rec.interruptedByShutdown && isShutdownInterruptText(c)) return null; // not typed — see lastClaudeUserInputAt
  const parts = typeof c === 'string' ? [c]
    : Array.isArray(c) ? c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text) : [];
  const typed = parts.some((t) => {
    const tt = t.trim();
    return tt && !tt.startsWith('<command-') && !tt.startsWith('<local-command') && !tt.startsWith('<task-notification');
  });
  if (!typed) return null;
  const ts = Date.parse(rec.timestamp);
  return Number.isNaN(ts) ? null : ts;
}

// Same, for a Codex rollout chunk: last real user message's timestamp (ms epoch),
// skipping the synthetic env/instructions wrappers. null if none found.
function lastCodexUserInputAt(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const p = rec && rec.payload;
    if (!rec || rec.type !== 'response_item' || !p || p.type !== 'message' || p.role !== 'user') continue;
    const t = rolloutContentText(p.content);
    if (!t.trim() || isSyntheticUserText(t)) continue;
    return codexTimestampMs(rec.timestamp);
  }
  return null;
}

function rolloutContentText(content) {
  return (Array.isArray(content) ? content : [])
    .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

function codexPermissionMode(rec) {
  if (!rec || rec.type !== 'turn_context' || !rec.payload || typeof rec.payload !== 'object') return null;
  const approval = typeof rec.payload.approval_policy === 'string' ? rec.payload.approval_policy : '';
  const sandbox = rec.payload.sandbox_policy;
  const sandboxType =
    sandbox && typeof sandbox === 'object' && typeof sandbox.type === 'string'
      ? sandbox.type
      : typeof sandbox === 'string'
        ? sandbox
        : '';
  if (sandboxType === 'read-only' || sandboxType === 'readOnly') return 'read-only';
  if (sandboxType === 'danger-full-access' || sandboxType === 'dangerFullAccess') return 'full-access';
  if (sandboxType === 'workspace-write' || sandboxType === 'workspaceWrite') return approval === 'never' ? 'full-access' : 'auto';
  if (approval === 'never') return 'full-access';
  return null;
}

// A Codex plan is a whole-list snapshot: the same three statuses as Claude's
// TodoWrite, so it becomes the same `todos` block (see rolloutToMessage). Shared
// by both shapes a plan arrives in — the direct call and the exec snippet below
// — so the two cannot quietly disagree about how much of a plan is renderable.
function codexPlanItems(plan) {
  if (!Array.isArray(plan)) return [];
  return plan.slice(0, TODO_MAX).map((s) => {
    const src = s && typeof s === 'object' ? s : {};
    return { text: String(src.step || '').slice(0, TODO_TEXT_MAX), status: String(src.status || 'pending') };
  }).filter((t) => t.text);
}

// GPT-5.x "Sol" models never call a tool directly: the whole turn is JS run in
// one `exec` call, so a plan arrives as `await tools.update_plan({plan:[…]})`
// inside the *code*, not as a function_call named update_plan. That argument is
// a JS object literal — unquoted keys, single quotes, trailing commas — which
// JSON.parse cannot read, so the reader below walks the literal subset a plan
// ever uses and bails to null on anything else (an expression, a spread, a
// template with ${}), which falls through to the ordinary tool rendering.
const JS_REF = Symbol('js-ref'); // a bare identifier: `{plan}` or `{plan: steps}`
const JS_ESCAPES = new Map([['n', '\n'], ['t', '\t'], ['r', '\r'], ['b', '\b'], ['f', '\f'], ['v', '\v'], ['0', '\0']]);
const JS_WORDS = new Map([['true', true], ['false', false], ['null', null], ['undefined', null]]);
const JS_NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const JS_IDENT_RE = /^[A-Za-z_$][\w$]*/;

function skipJsTrivia(src, i) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    if (src[i] === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      if (nl < 0) return src.length;
      i = nl + 1;
      continue;
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return src.length;
      i = end + 2;
      continue;
    }
    return i;
  }
}

function readJsString(src, start) {
  const quote = src[start];
  let out = '';
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1];
      const width = next === 'u' ? 4 : next === 'x' ? 2 : 0;
      const hex = width ? src.slice(i + 2, i + 2 + width) : '';
      if (width && hex.length === width && /^[0-9a-fA-F]+$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2 + width;
        continue;
      }
      out += JS_ESCAPES.has(next) ? JS_ESCAPES.get(next) : next;
      i += 2;
      continue;
    }
    if (ch === quote) return { value: out, end: i + 1 };
    if (quote === '`' && ch === '$' && src[i + 1] === '{') return null; // interpolated — not a literal
    out += ch;
    i += 1;
  }
  return null; // unterminated
}

function readJsObject(src, start) {
  const out = {};
  let i = skipJsTrivia(src, start + 1);
  if (src[i] === '}') return { value: out, end: i + 1 };
  for (;;) {
    let key;
    if (src[i] === '"' || src[i] === "'") {
      const k = readJsString(src, i);
      if (!k) return null;
      key = k.value;
      i = k.end;
    } else {
      const word = JS_IDENT_RE.exec(src.slice(i));
      if (!word) return null;
      key = word[0];
      i += word[0].length;
    }
    i = skipJsTrivia(src, i);
    const shorthand = src[i] === ',' || src[i] === '}';
    if (!shorthand && src[i] !== ':') return null;
    const val = shorthand ? { value: { [JS_REF]: key }, end: i } : readJsValue(src, i + 1);
    if (!val) return null;
    if (key !== '__proto__') out[key] = val.value; // model-written text must not reach the prototype
    i = skipJsTrivia(src, val.end);
    if (src[i] === '}') return { value: out, end: i + 1 };
    if (src[i] !== ',') return null;
    i = skipJsTrivia(src, i + 1);
    if (src[i] === '}') return { value: out, end: i + 1 }; // trailing comma
  }
}

function readJsArray(src, start) {
  const out = [];
  let i = skipJsTrivia(src, start + 1);
  if (src[i] === ']') return { value: out, end: i + 1 };
  for (;;) {
    const val = readJsValue(src, i);
    if (!val) return null;
    out.push(val.value);
    i = skipJsTrivia(src, val.end);
    if (src[i] === ']') return { value: out, end: i + 1 };
    if (src[i] !== ',') return null;
    i = skipJsTrivia(src, i + 1);
    if (src[i] === ']') return { value: out, end: i + 1 }; // trailing comma
  }
}

function readJsValue(src, start) {
  const i = skipJsTrivia(src, start);
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === '`') return readJsString(src, i);
  if (ch === '{') return readJsObject(src, i);
  if (ch === '[') return readJsArray(src, i);
  const rest = src.slice(i);
  const num = JS_NUMBER_RE.exec(rest);
  if (num) return { value: Number(num[0]), end: i + num[0].length };
  const word = JS_IDENT_RE.exec(rest);
  if (word && JS_WORDS.has(word[0])) return { value: JS_WORDS.get(word[0]), end: i + word[0].length };
  if (word) return { value: { [JS_REF]: word[0] }, end: i + word[0].length }; // a name — resolved only where a plan is expected
  return null;
}

// Scripts that build the list first — `const plan = [...]` then
// `tools.update_plan({plan})` — reach the literal through its declaration. Only
// declarations above the call count, so a later rebuild can't be read as this
// call's list.
function resolveJsRef(code, value, before) {
  const name = value && typeof value === 'object' ? value[JS_REF] : null;
  if (typeof name !== 'string') return null;
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$&')}\\s*=`, 'g');
  let at = -1;
  for (let m; (m = decl.exec(code)) && m.index < before; ) at = m.index + m[0].length;
  if (at < 0) return null;
  const read = readJsValue(code, at);
  return read && Array.isArray(read.value) ? read.value : null;
}

const EXEC_PLAN_RE = /tools\s*\.\s*update_plan\s*\(/g;
const EXEC_TOOL_RE = /tools\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;

// The plan a Sol snippet sets, plus whether that snippet did anything else: a
// script that only rewrites the plan renders as the checklist alone, like the
// direct call, while one that also greps and patches keeps its tool fold so the
// rest of the work — and the result that pairs with it — still shows.
function execPlanCall(code) {
  if (typeof code !== 'string' || !code.includes('update_plan')) return null;
  let plan = null;
  EXEC_PLAN_RE.lastIndex = 0;
  for (let m; (m = EXEC_PLAN_RE.exec(code)); ) {
    const arg = readJsValue(code, m.index + m[0].length);
    const value = arg && arg.value && typeof arg.value === 'object' ? arg.value.plan : null;
    // A snippet may rewrite the plan twice; the last call is the current list.
    const steps = Array.isArray(value) ? value : resolveJsRef(code, value, m.index);
    if (steps) plan = steps;
  }
  const items = codexPlanItems(plan);
  if (!items.length) return null;
  let others = 0;
  EXEC_TOOL_RE.lastIndex = 0;
  for (let m; (m = EXEC_TOOL_RE.exec(code)); ) if (m[1] !== 'update_plan') others += 1;
  return { items, planOnly: others === 0 };
}

// Code-mode `exec` snippets, read as the calls they make. GPT-6's code mode wraps
// every action as JS: `text(await tools.exec_command({cmd:"ls"}))`,
// `tools.apply_patch("*** Begin Patch...")`, `tools.web__run({search_query:[...]})`,
// and the row printed that JS verbatim under the one tool name `exec`. Each call
// is read with the literal reader; an argument it cannot read is kept as null
// rather than guessed at.
const EXEC_COMMAND_TOOLS = new Set(['exec_command', 'shell', 'local_shell']);
// Calls that say nothing about what the snippet DID: a clock read, the plan
// (which renders as its own checklist above the row).
const EXEC_INCIDENTAL_TOOLS = new Set(['clock__curr_time', 'update_plan']);

// `const patch = "..."` then `tools.apply_patch(patch)`: the literal a name was
// last given above the call.
function resolveJsStringRef(code, value, before) {
  const name = value && typeof value === 'object' ? value[JS_REF] : null;
  if (typeof name !== 'string') return null;
  const decl = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$&')}\\s*=`, 'g');
  let at = -1;
  for (let m; (m = decl.exec(code)) && m.index < before; ) at = m.index + m[0].length;
  if (at < 0) return null;
  const read = readJsValue(code, at);
  return read && typeof read.value === 'string' ? read.value : null;
}

function execCalls(code) {
  if (typeof code !== 'string' || !code.includes('tools')) return [];
  const calls = [];
  EXEC_TOOL_RE.lastIndex = 0;
  for (let m; (m = EXEC_TOOL_RE.exec(code)); ) {
    const read = readJsValue(code, m.index + m[0].length);
    let args = read ? read.value : null;
    if (args && typeof args === 'object' && args[JS_REF]) args = resolveJsStringRef(code, args, m.index);
    calls.push({ tool: m[1], args });
  }
  return calls;
}

function execCommandOf(args) {
  const obj = args && typeof args === 'object' && !Array.isArray(args) ? args : null;
  const raw = obj ? (obj.cmd ?? obj.command) : null;
  const cmd = typeof raw === 'string' ? raw : Array.isArray(raw) && raw.every((x) => typeof x === 'string') ? raw.join(' ') : null;
  return cmd && cmd.trim() ? { cmd, workdir: typeof obj.workdir === 'string' ? obj.workdir : null } : null;
}

// The patch grammar apply_patch takes (codex-rs/apply-patch): `*** Add File: p`
// with every line `+`, `*** Delete File: p` with no body, `*** Update File: p`
// optionally followed by `*** Move to: q`, then `@@` hunks of ` `/`-`/`+` lines.
const PATCH_FILE_RE = /^\*\*\* (Add|Delete|Update) File: (.+)$/;
function parseApplyPatch(text) {
  if (typeof text !== 'string' || !text.includes('*** ')) return null;
  const files = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const head = PATCH_FILE_RE.exec(line);
    if (head) {
      cur = { action: head[1].toLowerCase(), path: head[2].trim(), movePath: null, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur || line === '*** End Patch' || line === '*** Begin Patch' || line === '*** End of File') continue;
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) { cur.movePath = move[1].trim(); continue; }
    cur.lines.push(line);
  }
  return files.length ? files : null;
}

// One file's hunks as the {oldText, newText} pairs renderDiff draws, split at
// every change run so the unchanged lines between two changes stay context
// rather than being redrawn as a delete and an add.
function patchEdits(file) {
  const cap = (s) => truncate(s, DIFF_MAX);
  if (file.action === 'add') {
    const body = file.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
    const n = cap(body);
    return [{ filePath: file.movePath || file.path, oldText: '', newText: n.text, truncated: n.truncated }];
  }
  if (file.action === 'delete') return [{ filePath: file.path, deleted: true, oldText: '', newText: '' }];
  const edits = [];
  let ctx = [];
  let dels = [];
  let adds = [];
  let hunkStart = 0;
  const flush = () => {
    if (!dels.length && !adds.length) return;
    // Lines between two changes stay whole when there are a few; otherwise the
    // run gets the three nearest, like a hunk's own leading context.
    const lead = edits.length > hunkStart && ctx.length <= 8 ? ctx : ctx.slice(-3);
    const o = cap([...lead, ...dels].join('\n'));
    const n = cap([...lead, ...adds].join('\n'));
    edits.push({ filePath: file.movePath || file.path, oldText: o.text, newText: n.text, truncated: o.truncated || n.truncated });
    ctx = [];
    dels = [];
    adds = [];
  };
  // The unchanged lines after a hunk's last change close it, on both sides.
  const endHunk = () => {
    flush();
    const last = edits[edits.length - 1];
    if (ctx.length && edits.length > hunkStart && !last.truncated) {
      const tail = `\n${ctx.slice(0, 3).join('\n')}`;
      last.oldText += tail;
      last.newText += tail;
    }
    ctx = [];
    hunkStart = edits.length;
  };
  for (const line of file.lines) {
    if (line.startsWith('@@')) { endHunk(); continue; }
    const mark = line[0];
    const body = line.slice(1);
    if (mark === '-') dels.push(body);
    else if (mark === '+') adds.push(body);
    else {
      // A context line after a change starts the next run's leading context.
      flush();
      ctx.push(body);
    }
  }
  endHunk();
  return edits.slice(0, 60);
}

// The diff block an apply_patch call carries, in the shape Claude's Edit/Write
// already render with (diffFor above), plus every path it touched so the card
// counts files rather than calls, and the verb the row leads with.
function patchDiff(patches) {
  const files = patches.flatMap((p) => parseApplyPatch(p) || []);
  if (!files.length) return null;
  const edits = files.flatMap(patchEdits);
  const paths = [...new Set(files.map((f) => f.movePath || f.path))];
  const one = files.length === 1 ? files[0] : null;
  const verb = !one ? 'Edited'
    : one.action === 'add' ? 'Created'
      : one.action === 'delete' ? 'Deleted'
        : one.movePath ? 'Renamed' : 'Edited';
  const diff = { filePath: paths[0], paths, edits, verb };
  if (one && one.action === 'add') diff.write = true;
  if (one && one.movePath) diff.movedFrom = one.path;
  return diff;
}

// Codex's own tool names, said the way the rest of Termdeck already says them:
// the live adapter calls a command `shell` (lib/codex-events.js itemToolName),
// and the sub-agent panel and the files dock know `spawn_agent`, `web_search`,
// `view_image` by those names.
function codexToolName(tool) {
  if (EXEC_COMMAND_TOOLS.has(tool)) return 'shell';
  if (tool === 'web__run') return 'web_search';
  return tool.replace(/^multi_agent_v\d+__/, '');
}

// A web__run call's subject: the searches it ran, or the page it opened.
function webRunInput(args) {
  const obj = args && typeof args === 'object' ? args : {};
  const qs = (Array.isArray(obj.search_query) ? obj.search_query : []).map((q) => q && q.q).filter((q) => typeof q === 'string');
  if (qs.length) return { query: qs.join(' | ') };
  const open = (Array.isArray(obj.open) ? obj.open : []).map((o) => o && o.ref_id).filter((u) => typeof u === 'string');
  if (open.length) return { url: open[0] };
  return {};
}

// How a web row reads: a search names its query, opening a page names the page.
function webVerb(input) {
  if (input && input.query) return 'Searched the web';
  if (input && input.pattern) return 'Searched the page';
  if (input && input.url) return 'Opened';
  return null;
}

// The built-in web search tool (not code mode) writes one `web_search_call`
// item and no output item: `action` is `{type:"search", query, queries}`,
// `{type:"open_page", url}` or `{type:"find_in_page", url, pattern}`
// (WebSearchAction in the codex binary). It used to be dropped, so a search the
// model ran left no trace in the transcript.
function webSearchInput(action) {
  const a = action && typeof action === 'object' ? action : {};
  const queries = Array.isArray(a.queries) ? a.queries.filter((q) => typeof q === 'string' && q.trim()) : [];
  if (a.type === 'search' || a.query || queries.length) {
    const query = queries.length ? queries.join(' | ') : typeof a.query === 'string' ? a.query : '';
    return query ? { query } : {};
  }
  if (a.type === 'find_in_page') return { ...(a.url ? { url: String(a.url) } : {}), ...(a.pattern ? { pattern: String(a.pattern) } : {}) };
  if (a.url) return { url: String(a.url) };
  return {};
}

// The pages a web tool returned, as `Title (https://...)` lines each followed by
// the model-facing citation marker (`\ue200cite\ue202turn0search0...`). Only web
// output carries that marker, so a result can be read as a link list on its
// own, without knowing which call it answers.
const WEB_LINK_RE = /^(.{1,300}?) \((https?:\/\/[^\s)]+)\)\s*$/;
const WEB_CITE_RE = /^\W{0,3}cite\W{0,3}turn\d+(?:search|view|fetch|open)\d+/;
const WEB_LINKS_MAX = 10;
function webLinks(text) {
  if (typeof text !== 'string' || !/cite\W{0,3}turn\d/.test(text)) return null;
  const lines = text.split('\n');
  const links = [];
  const seen = new Set();
  for (let i = 0; i + 1 < lines.length && links.length < WEB_LINKS_MAX; i++) {
    const m = WEB_LINK_RE.exec(lines[i]);
    if (!m || !WEB_CITE_RE.test(lines[i + 1])) continue;
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    links.push({ title: m[1].trim(), url: m[2] });
  }
  return links.length ? links : null;
}

// The row a snippet becomes: named by the main thing it did, with everything
// else it did one level down in the panel. One snippet is one call id with one
// result, so it stays one row; splitting it would leave rows no result can
// settle. Main thing, in order: an edit (what it did to the code), commands,
// then any single other tool. null keeps the snippet as it was.
function codexExecRow(code) {
  const calls = execCalls(code).filter((c) => !EXEC_INCIDENTAL_TOOLS.has(c.tool));
  if (!calls.length) {
    // `ALL_TOOLS.filter(...)` / `ALL_TOOLS.map(...)`: the model reading its own
    // tool list, the code-mode twin of Claude's ToolSearch.
    if (typeof code === 'string' && /\bALL_TOOLS\b/.test(code)) {
      return { name: 'ToolSearch', input: null, description: 'Listed its available tools' };
    }
    return null;
  }
  const commands = [];
  let workdir = null;
  const patches = [];
  const polls = [];
  const others = [];
  for (const c of calls) {
    if (EXEC_COMMAND_TOOLS.has(c.tool)) {
      const cmd = execCommandOf(c.args);
      if (!cmd) return null;
      commands.push(cmd.cmd);
      if (!workdir && cmd.workdir) workdir = cmd.workdir;
    } else if (c.tool === 'apply_patch') {
      if (typeof c.args !== 'string') return null;
      patches.push(c.args);
    } else if (c.tool === 'write_stdin') polls.push(c);
    else others.push(c);
  }
  const shellInput = () => ({ command: commands.join('\n'), ...(workdir ? { workdir } : {}) });
  const also = [...new Set(others.map((c) => codexToolName(c.tool)))];
  const withAlso = (input) => (also.length ? { ...input, also: also.join(', ') } : input);
  if (patches.length) {
    const diff = patchDiff(patches);
    if (!diff) return null;
    return { name: 'apply_patch', diff, input: commands.length || also.length ? withAlso(commands.length ? shellInput() : {}) : null };
  }
  if (commands.length) {
    const input = withAlso(shellInput());
    return { name: 'shell', input, preview: commands.map((c) => c.replace(/\s+/g, ' ').trim()).join(' · ') };
  }
  if (!others.length) {
    // Only polls of commands started earlier: reading more of their output, or
    // typing into them.
    const p = polls[0].args && typeof polls[0].args === 'object' ? polls[0].args : {};
    const typed = typeof p.chars === 'string' && p.chars !== '';
    const input = { ...(p.session_id != null ? { session_id: p.session_id } : {}), ...(typed ? { chars: p.chars } : {}) };
    // A poll that only waits names the commands it is waiting on, so the view
    // can fold it into the row that started them (features/02 1.3b). Typing
    // into a command is an action of its own and keeps its row.
    const pollOf = polls.map((c) => (c.args && typeof c.args === 'object' ? c.args : {}));
    const waits = pollOf.every((a) => a.session_id != null && !(typeof a.chars === 'string' && a.chars !== ''));
    return {
      name: 'write_stdin', input, description: typed ? 'Sent input to a running command' : 'Waited for a running command',
      ...(waits ? { pollOf: [...new Set(pollOf.map((a) => String(a.session_id)))] } : {}),
    };
  }
  const tools = new Set(others.map((c) => c.tool));
  if (tools.size !== 1) return null;
  const first = others[0];
  const args = first.args && typeof first.args === 'object' && !Array.isArray(first.args) ? first.args : {};
  if (first.tool === 'web__run') {
    const input = webRunInput(args);
    return { name: codexToolName(first.tool), input, verb: webVerb(input) };
  }
  return codexToolRow(codexToolName(first.tool), { ...args });
}

const CODEX_DIRECT_TOOLS = new Set(['view_image', 'spawn_agent', 'wait_agent']);

// Codex's own tools, said as actions (features/02 1.7, 1.8). Shared by the
// code-mode snippet and the direct function_call, which name them the same
// once codexToolName has dropped the `multi_agent_v1__` namespace.
//
// spawn_agent's instruction is plain text in the v1 tools and an ENCRYPTED blob
// in the collaboration namespace, which names the task in `task_name` instead
// (codexTaskLabel). The blob is never shown; the panel keeps everything else.
const CODEX_SEALED_RE = /^gAAAAA[\w-]{20,}={0,2}$/;
function codexToolRow(name, input) {
  const obj = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (name === 'view_image') return { name, input: obj, verb: 'Viewed' };
  if (name === 'spawn_agent') {
    const sealed = typeof obj.message === 'string' && CODEX_SEALED_RE.test(obj.message.trim());
    const shown = { ...obj };
    if (sealed) delete shown.message;
    const said = !sealed && typeof obj.message === 'string' ? obj.message.replace(/\s+/g, ' ').trim() : '';
    const description = said ? (said.length > PREVIEW_MAX ? `${said.slice(0, PREVIEW_MAX)}…` : said) : codexTaskLabel(obj);
    return { name, input: shown, verb: 'Spawned agent', description: description || null, preview: description || '' };
  }
  if (name === 'wait_agent' || name === 'wait') {
    const targets = Array.isArray(obj.targets) ? obj.targets.filter((t) => typeof t === 'string') : [];
    const n = targets.length;
    const description = n ? `${n} agent${n === 1 ? '' : 's'}` : 'its agents';
    return { name: 'wait_agent', input: obj, verb: 'Waited for', description, preview: description };
  }
  return { name, input: obj };
}

// What a sub-agent call returned, said as what happened to the agent rather
// than the JSON the model reads. `agents` maps a worker's thread id to its
// nickname, from the spawn results and the CollabAgentToolCall records the
// rollout writes beside every wait (scanRolloutLines). The row's own label is
// written when the call is, before anyone knows the name, so the result
// carries the better one (`rowVerb`, `rowDescription`) for the view to put on
// the row it settles.
function codexAgentResult(text, agents) {
  if (typeof text !== 'string' || !/^\s*\{/.test(text)) return null;
  let json;
  try { json = JSON.parse(text); } catch { return null; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const nameOf = (id) => (agents && agents.get(id)) || null;
  if (typeof json.agent_id === 'string' && typeof json.nickname === 'string' && json.nickname) {
    return { text: `${json.nickname} started`, rowVerb: `Spawned ${json.nickname}`, agent: { id: json.agent_id, name: json.nickname } };
  }
  const keys = Object.keys(json);
  if (keys.length === 1 && typeof json.task_name === 'string') return { text: `Started ${json.task_name}` };
  if (json.status && typeof json.status === 'object' && 'timed_out' in json) {
    const lines = [];
    const names = [];
    for (const [id, state] of Object.entries(json.status)) {
      const who = nameOf(id);
      if (who) names.push(who);
      const label = who || 'Agent';
      if (state && typeof state === 'object') {
        const [kind] = Object.keys(state);
        const said = typeof state[kind] === 'string' ? state[kind] : '';
        lines.push(kind === 'completed' ? `${label} finished:\n${said}` : `${label} ${kind}${said ? `: ${said}` : ''}`);
      } else lines.push(`${label}: ${String(state).replace(/_/g, ' ')}`);
    }
    if (json.timed_out) lines.push('Stopped waiting (timed out).');
    return { text: lines.join('\n\n'), ...(names.length ? { rowDescription: names.join(', ') } : {}) };
  }
  if (typeof json.message === 'string' && 'timed_out' in json && keys.length === 2) return { text: json.message };
  return null;
}

// What a Codex tool call printed, and whether it failed. Code-mode `exec` output
// is an array of `input_text` items (not Claude's `text`), so the generic reader
// kept none of it and every row showed an empty RESULT. The first item is the
// harness's `Script completed|failed\nWall time Ns\nOutput:\n` preamble; each
// exec_command then reports `{chunk_id, exit_code, output}` JSON (Promise.allSettled
// wraps it as `{i, status, value}`), and a nested non-zero exit_code is the only
// sign a command failed. Parts that are none of these are printed as they are.
const CODEX_SCRIPT_RE = /^Script (completed|failed|running with cell ID \d+)\nWall time [\d.]+ seconds\nOutput:\n?/;
const CODEX_WARNING_RE = /^(Warning: truncated output[^\n]*\n(?:Total output lines: \d+\n)?\n?)/;
const CODEX_EXIT_LINE_RE = /^exit_code=(-?\d+)\s*$/;
const CODEX_PROCESS_EXIT_RE = /^Process exited with code (-?\d+)$/m;
const CODEX_ABORT_RE = /^aborted by user after /;
// A call the user denied at the approval card. Codex hands the model its Rust
// error verbatim (`exec_command failed: CreateProcess { message:
// "Rejected(\"rejected by user\")" }`, or `patch rejected by user` for an
// edit), and the row painted a call the user refused as a green check
// (QA 2026-10-08, 5.2). The row says it in words and in the stopped style a
// Claude denial already gets.
const CODEX_REJECTED_RE = /Rejected\(\\?"rejected by user\\?"\)|^\s*(?:Script error:\s*)?patch rejected by user\s*$/;
const CODEX_DENIED_TEXT = 'Denied: you rejected this call, so it did not run.';
const isCodexRejection = (text) => typeof text === 'string' && CODEX_REJECTED_RE.test(text);

function codexOutputPart(text) {
  const warn = CODEX_WARNING_RE.exec(text);
  const rest = warn ? text.slice(warn[1].length) : text;
  const exit = CODEX_EXIT_LINE_RE.exec(rest);
  if (exit) return { text: '', failed: Number(exit[1]) !== 0, code: Number(exit[1]) };
  let json = null;
  if (/^\s*\{/.test(rest)) {
    try { json = JSON.parse(rest); } catch {}
  }
  // Promise.allSettled's result, bare (`{i, status, value}`) or under `result`.
  if (json && json.result && typeof json.result === 'object' && 'status' in json.result) json = json.result;
  if (json && json.value && typeof json.value === 'object' && 'status' in json) {
    if (json.status === 'rejected') return { text: rest, failed: true };
    json = json.value;
  }
  if (json && typeof json.output === 'string') {
    const code = json.exit_code ?? (json.metadata && json.metadata.exit_code);
    // No exit code yet and a session to poll: the command is still running,
    // and a later write_stdin poll names this session (features/02 1.3b).
    const session = code == null && json.session_id != null ? String(json.session_id) : null;
    return {
      text: (warn ? warn[1] : '') + json.output, failed: code != null && Number(code) !== 0, code: code != null ? Number(code) : null,
      ...(session ? { session } : {}),
    };
  }
  const exited = CODEX_PROCESS_EXIT_RE.exec(text);
  return { text, failed: !!exited && Number(exited[1]) !== 0, code: exited ? Number(exited[1]) : null };
}

// The pictures a Codex call returned: `view_image` (and any tool that answers
// with a screenshot) puts the file into its output as an `input_image` data
// URL, which is exactly what the model looked at, and works for a file outside
// the project the files route could not read. The generic reader kept only
// text, so the row showed a check and nothing else (features/02 1.7). These
// ride `images` like a Claude tool_result's, so the same <img> and lightbox
// draw them. A paint drops them (capPreviewBlock); this cap only keeps one
// absurd image from riding every load.
const CODEX_IMAGE_MAX = 4 * 1024 * 1024;
const CODEX_IMAGES_MAX = 4;
function codexImages(output) {
  if (!Array.isArray(output)) return [];
  const out = [];
  for (const item of output) {
    if (out.length >= CODEX_IMAGES_MAX) break;
    const url = item && item.type === 'input_image' ? item.image_url : null;
    if (typeof url !== 'string' || url.length > CODEX_IMAGE_MAX) continue;
    // Bytes only: a remote URL would be fetched by the reader's browser.
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)) out.push(url);
  }
  return out;
}

function codexToolOutput(output) {
  let parts;
  if (typeof output === 'string') parts = [output];
  else if (Array.isArray(output)) {
    parts = output
      .filter((item) => item && ['text', 'input_text', 'output_text'].includes(item.type) && typeof item.text === 'string')
      .map((item) => item.text);
  } else return { text: toolResultText(output), isError: false };
  let isError = false;
  const script = parts.length ? CODEX_SCRIPT_RE.exec(parts[0]) : null;
  // A snippet still running when its yield ran out (an approval card is the
  // usual reason): Codex names the cell, and a later `wait` on that cell
  // brings back how it ended. The cell rides `sessions` like a command's
  // session id does, so the wait folds into this row (foldPoll).
  const cell = script && /^running with cell ID (\d+)$/.exec(script[1]);
  if (script) {
    isError = script[1] === 'failed';
    parts[0] = parts[0].slice(script[0].length);
  }
  if (parts.length === 1 && CODEX_ABORT_RE.test(parts[0])) return { text: parts[0], isError: true };
  if (parts.some(isCodexRejection)) return { text: CODEX_DENIED_TEXT, isError: true, denied: true };
  const texts = [];
  const sessions = cell ? [`cell:${cell[1]}`] : [];
  let exitCode = null;
  for (const part of parts) {
    if (!part) continue;
    const read = codexOutputPart(part);
    if (read.failed) isError = true;
    // The first command that failed names the exit; one that passed only
    // stands in until then.
    if (Number.isFinite(read.code) && (exitCode == null || (exitCode === 0 && read.code !== 0))) exitCode = read.code;
    if (read.session && !sessions.includes(read.session)) sessions.push(read.session);
    if (read.text) texts.push(read.text);
  }
  return { text: texts.join('\n'), isError, ...(exitCode != null ? { exitCode } : {}), ...(sessions.length ? { sessions } : {}) };
}

// A Codex compaction, as the same divider a Claude compact_boundary draws
// (features/02 4.6b). The rollout writes a `compacted` record holding the new
// history. Only one inside a turn counts: the copy a forked thread starts from
// sits above its first turn, and nobody ran that compaction here.
//
// `latest_token_usage_record` is the compaction request's own usage, so its
// input is what the context held going in. When that request is the turn's
// ONLY one (turn total equals it), nothing else ran: the user asked for it. Any
// other is the CLI making room mid-turn. Read off the record alone, so a delta
// that starts mid-turn says the same as a full parse. The size afterwards is
// only known from the next request, which lands after the turn has moved on,
// so the divider leaves it unknown rather than reorder anything.
function codexCompaction(rec, idx, turnId) {
  if (!turnId) return null;
  const p = rec.payload && typeof rec.payload === 'object' ? rec.payload : {};
  const record = p.latest_token_usage_record && typeof p.latest_token_usage_record === 'object' ? p.latest_token_usage_record : null;
  const req = record && record.usage ? Number(record.usage.input_tokens) : NaN;
  const turn = record && record.turn_token_usage ? Number(record.turn_token_usage.input_tokens) : NaN;
  const pre = Number.isFinite(req) && req > 0 ? req : null;
  const id = typeof p.window_id === 'string' && p.window_id ? p.window_id : `line${idx}`;
  return {
    role: 'compacted',
    messageId: `compacted:${id}`,
    uuid: null,
    timestamp: rec.timestamp || null,
    blocks: [{
      kind: 'compacted',
      trigger: Number.isFinite(req) && req > 0 && req === turn ? 'manual' : 'auto',
      preTokens: pre,
      postTokens: null,
      durationMs: null,
    }],
  };
}

// Every summary part Codex writes opens with its heading in bold: `**Checking
// the repo**`, alone or above a paragraph (707 of 707 parts across this box's
// rollouts). The heading is the row's label, said without its asterisks; the
// text stays whole for the panel.
const THOUGHT_TITLE_RE = /^\s*\*\*([^*\n]+)\*\*[ \t]*(?:\r?\n|$)/;
function codexThought(text) {
  const m = THOUGHT_TITLE_RE.exec(text);
  const title = m ? m[1].trim() : '';
  return title ? { kind: 'thinking', text, title } : { kind: 'thinking', text };
}

function rolloutToMessage(rec, turnId, agents = null) {
  if (!rec || rec.type !== 'response_item' || !rec.payload || typeof rec.payload !== 'object') return null;
  const p = rec.payload;
  const base = { role: 'assistant', messageId: `turn:${turnId}`, uuid: null, timestamp: rec.timestamp || null };
  switch (p.type) {
    case 'message': {
      const text = rolloutContentText(p.content);
      if (!text.trim()) return null;
      if (p.role === 'user') {
        // Ahead of the synthetic check, which takes any tag-shaped text for the CLI's.
        const reply = asyncReplyOf(text);
        if (reply) return { ...base, role: 'user', messageId: null, blocks: [reply] };
        if (isSyntheticUserText(text)) return null;
        return { ...base, role: 'user', messageId: null, blocks: promptTextBlocks(text) };
      }
      if (p.role !== 'assistant') return null; // developer/system prompts
      // Codex plan mode wraps its proposed plan in <proposed_plan>…</proposed_plan>.
      const planMatch = text.match(/^\s*<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>\s*$/);
      return { ...base, blocks: [{ kind: 'text', text: planMatch ? planMatch[1] : text }] };
    }
    case 'reasoning': {
      // One thought per summary part. Joined, they ran together on one row as
      // "Thought **Resolving...** **Updating...**" (features/02 1.10). The live
      // adapter opens a block per part too (lib/codex-events.js), so a streamed
      // bubble pops the same count the rollout settles.
      const parts = (Array.isArray(p.summary) ? p.summary : [])
        .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
        .filter((t) => t.trim());
      if (!parts.length) return null; // encrypted_content only, nothing readable
      return { ...base, blocks: parts.map(codexThought) };
    }
    case 'function_call':
    case 'custom_tool_call': {
      const raw = p.type === 'function_call' ? p.arguments : p.input;
      let input = raw;
      if (typeof raw === 'string') {
        try {
          input = JSON.parse(raw);
        } catch {} // apply_patch input is a plain string — keep it
      }
      // Codex's `update_plan` IS Claude's TodoWrite: it rewrites the whole
      // checklist each call and uses the same three statuses (verified against
      // 53 real calls in this box's rollouts — pending/in_progress/completed and
      // nothing else). Emitting the same `todos` block is all it takes to give
      // Codex the checklist rendering, the pinned strip above the composer and
      // the terminals-canvas strip, none of which know about engines. Without
      // this it rendered as a raw JSON fold like any other tool call.
      // A question Codex asks without stopping: a card in the chat, answered by
      // a later message (asyncReplyOf), not a tool row.
      if (p.name === 'request_user_input_async') {
        const questions = asyncQuestionsOf(input);
        if (questions) return { ...base, blocks: [{ kind: 'question', id: p.call_id || null, questions }] };
      }
      const plan = p.name === 'update_plan' && input && typeof input === 'object' ? input.plan : null;
      // An empty or unreadable plan falls through to the normal tool rendering
      // rather than painting an empty checklist.
      const planBlocks = [];
      const direct = codexPlanItems(plan);
      if (direct.length) return { ...base, blocks: [{ kind: 'todos', id: p.call_id || null, items: direct }] };
      // Sol models hide the same call inside an exec snippet — one code string
      // for a custom_tool_call, or a field of the arguments object otherwise.
      for (const code of input && typeof input === 'object' ? Object.values(input) : [input]) {
        const call = execPlanCall(code);
        if (!call) continue;
        const todos = { kind: 'todos', id: p.call_id || null, items: call.items };
        if (call.planOnly) return { ...base, blocks: [todos] };
        planBlocks.push(todos);
        break;
      }
      // A code-mode snippet is shown as what it did (codexExecRow), and a direct
      // apply_patch call as the diff it applies.
      let name = p.name || 'tool';
      let row = null;
      if (name === 'apply_patch') {
        const patch = typeof input === 'string' ? input : input && typeof input.input === 'string' ? input.input : null;
        const diff = patch ? patchDiff([patch]) : null;
        if (diff) row = { name, diff, input: null };
      } else if (typeof input === 'string') {
        row = codexExecRow(input);
      } else if (CODEX_DIRECT_TOOLS.has(name)) {
        row = codexToolRow(name, input);
      } else if (name === 'wait' && input && typeof input === 'object' && input.cell_id != null) {
        // Codex polling a snippet that outlived its yield (see codexToolOutput).
        // Not an action of its own: it folds into the row that started the
        // cell, the way a waiting write_stdin does (features/02 1.3b).
        row = {
          name: 'write_stdin',
          input: { cell_id: String(input.cell_id) },
          description: 'Waited for a running command',
          pollOf: [`cell:${input.cell_id}`],
        };
      }
      if (row) {
        name = row.name;
        input = row.input;
      }
      let inputJson = '';
      try {
        inputJson = input == null ? '' : typeof input === 'string' ? input : JSON.stringify(input, null, 2) || '';
      } catch {}
      const body = truncate(inputJson, TOOL_INPUT_MAX);
      const preview = row && row.diff ? row.diff.filePath.slice(0, PREVIEW_MAX)
        : row && row.preview ? row.preview.slice(0, PREVIEW_MAX)
        // A typed row with nothing to preview says nothing, never the JS it came from.
        : row && !input ? ''
        : input && typeof input === 'object'
          ? inputPreview(name, input)
          : String(raw || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX);
      const block = {
        kind: 'tool_use',
        id: p.call_id || null,
        name,
        inputPreview: preview,
        description: (row && row.description) || inputDescription(input, preview) || codexTaskLabel(input),
        inputJson: body.text,
        truncated: body.truncated,
      };
      // Codex's AskUserQuestion: the same questions block, so the viewer draws
      // the questions instead of their JSON.
      if (name === 'request_user_input') {
        const questions = questionsOf(input);
        if (questions) {
          block.questions = questions;
          block.inputPreview = questions.length === 1 ? questions[0].question.slice(0, PREVIEW_MAX) : `${questions.length} questions`;
        }
      }
      if (row && row.verb) block.verb = row.verb;
      if (row && row.pollOf) block.pollOf = row.pollOf;
      if (row && row.diff) {
        const { verb, ...diff } = row.diff;
        block.diff = diff;
        block.verb = verb;
        if (diff.paths.length > 1) block.description = `${diff.paths.length} files`;
        else if (diff.movedFrom) {
          // A rename within one folder names the old file; a move names where from.
          const dir = (f) => f.replace(/[^/\\]*$/, '');
          const same = dir(diff.movedFrom) === dir(diff.filePath);
          block.description = `from ${same ? diff.movedFrom.slice(dir(diff.movedFrom).length) : diff.movedFrom}`;
        }
      }
      return { ...base, blocks: [...planBlocks, block] };
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const out = codexToolOutput(p.output);
      const { isError, exitCode, sessions, denied } = out;
      const said = isError ? null : codexAgentResult(out.text, agents);
      const raw = said ? said.text : out.text;
      const links = webLinks(raw);
      const body = truncate(stripAnsi(raw), TOOL_RESULT_MAX);
      const ansi = ansiSibling(raw, body.text, TOOL_RESULT_MAX);
      const images = codexImages(p.output);
      const answers = isError ? null : codexAnswersOf(out.text);
      return {
        ...base,
        blocks: [{
          kind: 'tool_result',
          toolUseId: p.call_id || null,
          isError,
          ...(denied ? { denied: true } : {}),
          ...(exitCode != null && exitCode !== 0 ? { exitCode } : {}),
          text: body.text,
          ...(ansi ? { textAnsi: ansi } : {}),
          ...(links ? { links } : {}),
          ...(images.length ? { images } : {}),
          // Commands this call left running, which a later poll names (1.3b).
          ...(sessions ? { sessions } : {}),
          ...(said && said.rowVerb ? { rowVerb: said.rowVerb } : {}),
          ...(said && said.rowDescription ? { rowDescription: said.rowDescription } : {}),
          ...(said && said.agent ? { agent: said.agent } : {}),
          ...(answers ? { answers } : {}),
          truncated: body.truncated,
        }],
      };
    }
    case 'web_search_call': {
      const input = webSearchInput(p.action);
      const id = p.id || p.call_id || `ws:${rec.timestamp || turnId}`;
      const verb = webVerb(input);
      const preview = inputPreview('web_search', input).slice(0, PREVIEW_MAX);
      const blocks = [{
        kind: 'tool_use', id, name: 'web_search', inputPreview: preview, description: null,
        inputJson: Object.keys(input).length ? JSON.stringify(input, null, 2) : '', truncated: false,
        ...(verb ? { verb } : {}),
      }];
      // No output item follows, so the call's own status is its result.
      if (p.status && p.status !== 'in_progress' && p.status !== 'searching') {
        const ok = p.status === 'completed';
        blocks.push({ kind: 'tool_result', toolUseId: id, isError: !ok, text: ok ? '' : `Search ${p.status}`, truncated: false });
      }
      return { ...base, blocks };
    }
    default:
      return null; // future types: whitelist
  }
}

// The turn in effect at line `since` — the last task_started before the cursor.
// Scans backwards and stops at the first hit, and only JSON.parses a line that
// could be one, so the usual answer (the last few lines of a big rollout) costs a
// substring test per line rather than a parse.
function lastTurnIdBefore(lines, since) {
  if (!(since > 0)) return null;
  for (let idx = Math.min(since, lines.length) - 1; idx >= 0; idx--) {
    const line = lines[idx];
    if (!line || line.indexOf('task_started') < 0) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || rec.type !== 'event_msg' || !rec.payload || rec.payload.type !== 'task_started') continue;
    return rec.payload.turn_id || `line${idx}`; // same id the forward scan assigns
  }
  return null;
}

// The sub-agent names the current turn met before `since`: the
// CollabAgentToolCall events and spawn results between its task_started and the
// cursor. The forward scan clears its names at every task_started, so this is
// exactly what it would hold at `since`. On a framed feed (startLine > 0) the
// earlier lines are not in hand and the map starts empty; the event lands just
// before its output, so a feed splitting the two is the only miss.
function agentsBefore(lines, since) {
  const agents = new Map();
  if (!(since > 0)) return agents;
  const found = [];
  for (let idx = Math.min(since, lines.length) - 1; idx >= 0; idx--) {
    const line = lines[idx];
    if (!line) continue;
    const started = line.indexOf('task_started') >= 0;
    if (!started && line.indexOf('CollabAgentToolCall') < 0 && line.indexOf('agent_id') < 0) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || typeof rec !== 'object') continue;
    const p = rec.payload;
    if (rec.type === 'event_msg' && p && p.type === 'task_started') break;
    if (rec.type === 'event_msg' && p && p.type === 'item_completed') {
      const item = p.item;
      if (item && item.type === 'CollabAgentToolCall' && Array.isArray(item.receiver_agents)) {
        for (const a of item.receiver_agents) {
          if (a && typeof a.thread_id === 'string' && typeof a.agent_nickname === 'string' && a.agent_nickname) found.push([a.thread_id, a.agent_nickname]);
        }
      }
      continue;
    }
    if (rec.type !== 'response_item') continue;
    const message = rolloutToMessage(rec, 'scan', null);
    if (message) for (const b of message.blocks) if (b.agent) found.push([b.agent.id, b.agent.name]);
  }
  for (let i = found.length - 1; i >= 0; i--) agents.set(found[i][0], found[i][1]); // oldest first, as the forward scan set them
  return agents;
}

// features/02 3.3b. An apply_patch's own grammar has no line numbers, but the
// rollout writes what the patch did to each file as an `item_completed`
// FileChange event, with a unified diff computed against the file itself.
// That diff is the honest source of a Codex edit's line numbers. Its item id is
// not the call's, so it rides the next tool output (the call it belongs to has
// not answered yet: the event lands between a call and its output), and the
// viewer uses it only where its lines say the same change as the row's patch.
// Only updates carry hunks: an added file is numbered from 1 already and a
// deleted one shows no lines. Bounded like resultFacts' patch.
const UNIFIED_HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
function unifiedHunks(text, room) {
  const hunks = [];
  let cur = null;
  let used = 0;
  for (const line of String(text).split('\n')) {
    const head = UNIFIED_HUNK_RE.exec(line);
    if (head) {
      cur = {
        oldStart: Number(head[1]), oldLines: head[2] == null ? 1 : Number(head[2]),
        newStart: Number(head[3]), newLines: head[4] == null ? 1 : Number(head[4]), lines: [],
      };
      hunks.push(cur);
      continue;
    }
    if (!cur || !line || !' -+\\'.includes(line[0])) continue;
    if (++used > room || hunks.length > PATCH_HUNKS_MAX) return null;
    cur.lines.push(line.slice(0, PATCH_LINE_CHARS));
  }
  return hunks.length ? { hunks, used } : null;
}

function codexFileChanges(item) {
  const changes = item && item.changes && typeof item.changes === 'object' && !Array.isArray(item.changes) ? item.changes : null;
  if (!changes) return [];
  const out = [];
  let room = PATCH_LINES_MAX;
  for (const [path, c] of Object.entries(changes)) {
    if (!c || c.type !== 'update' || typeof c.unified_diff !== 'string') continue;
    const parsed = unifiedHunks(c.unified_diff, room);
    if (!parsed) continue;
    room -= parsed.used;
    out.push({ path: typeof c.move_path === 'string' && c.move_path ? c.move_path : path, hunks: parsed.hunks });
  }
  return out;
}

// Which output a FileChange rides. It waits for the output of a call that
// patched its file; a command's output leaves it waiting (the patch is still
// running beside it), and an output whose call this parse never saw takes
// everything waiting. Per turn.
function patchTracker() {
  const t = { pending: [], callPaths: new Map() }; // call id -> Set of paths, or null: patched nothing
  t.change = (item) => {
    if (item.status !== 'failed') t.pending.push(...codexFileChanges(item));
  };
  t.block = (b) => {
    if (b.kind !== 'tool_result') {
      if (b.id) t.callPaths.set(b.id, b.diff ? new Set(b.diff.paths) : null);
      return;
    }
    if (!b.toolUseId || !t.pending.length) return;
    const known = t.callPaths.has(b.toolUseId);
    const paths = known ? t.callPaths.get(b.toolUseId) : null;
    if (known && !paths) return;
    const take = paths ? t.pending.filter((c) => paths.has(c.path)) : t.pending;
    t.pending = paths ? t.pending.filter((c) => !paths.has(c.path)) : [];
    if (take.length) b.filePatches = take;
  };
  return t;
}

// What the forward scan's tracker holds at `since`, for a delta that starts
// mid-turn: the turn's earlier calls, outputs and FileChanges replayed. Only a
// FileChange and a patching call are parsed; any other call is known by its id
// alone. Same framing caveat as agentsBefore.
const CALL_ID_RE = /"call_id":"([^"\\]+)"/;
function patchesBefore(lines, since) {
  const t = patchTracker();
  const end = Math.min(since, lines.length);
  if (!(end > 0)) return t;
  let from = end;
  while (from > 0) {
    const line = lines[from - 1];
    if (line && line.indexOf('"task_started"') >= 0) {
      let rec;
      try { rec = JSON.parse(line); } catch {}
      if (rec && rec.type === 'event_msg' && rec.payload && rec.payload.type === 'task_started') break;
    }
    from -= 1;
  }
  for (let idx = from; idx < end; idx++) {
    const line = lines[idx];
    if (!line) continue;
    if (line.indexOf('"FileChange"') >= 0) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const p = rec && rec.payload;
      if (p && rec.type === 'event_msg' && p.type === 'item_completed' && p.item && p.item.type === 'FileChange') t.change(p.item);
      continue;
    }
    if (line.indexOf('"type":"response_item"') < 0) continue;
    const output = line.indexOf('_call_output"') >= 0;
    if (!output && line.indexOf('_call"') < 0) continue;
    const id = (CALL_ID_RE.exec(line) || [])[1];
    if (!id) continue;
    if (output) {
      t.block({ kind: 'tool_result', toolUseId: id });
      continue;
    }
    if (line.indexOf('apply_patch') < 0) {
      t.callPaths.set(id, null);
      continue;
    }
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const message = rolloutToMessage(rec, 'scan', null);
    if (message) for (const b of message.blocks) t.block(b);
  }
  return t;
}

function scanRolloutText(text, since, turnSeed) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing-newline artifact, not a line
  return scanRolloutLines(lines, since, turnSeed, 0);
}

// Line-array core, so the resumable cursor can hand in ONLY appended lines:
// `startLine` is the absolute line number of lines[0]. Pre-`since` lines
// contribute nothing but their count (the skip below runs before any parse),
// so a window that starts at the cursor scans identically to the full text.
function scanRolloutLines(lines, since, turnSeed, startLine = 0) {
  const messages = [];
  let lastLineBad = false;
  let cwd = null;
  // Every record of a Codex turn is keyed `turn:<turnId>`, and that id comes from
  // a task_started event which — for a delta that starts mid-turn — is BEHIND the
  // cursor. The live path hands it in as turnSeed from its own cache; the REST
  // `?since` paths (readTranscript, remote-sessions.readSession) had nothing to
  // hand in and got `turn:orphan<since>` instead, for every record until the next
  // task_started.
  //
  // That id is not cosmetic: it is what makes the browser's streamed bubble
  // reconcile against the same message on disk. Under an orphan id nothing
  // matches, so the streamed answer is never popped, the canonical copy renders
  // as a message of its own, and the turn's tool groups end up rendered around
  // an answer that is already on screen. A resync mid-turn is the common way in,
  // which is why it showed up at the END of long turns.
  //
  // So the seed is derived here when it is not supplied: the parse owns the whole
  // text either way, and this makes turnSeed an optimisation rather than
  // something every call site has to remember.
  // With startLine > 0 the pre-`since` lines are not in the array, and the
  // relative bound is never positive, so the backward scan stays a no-op: on
  // those feeds the seed chain (previous feed's turnState) is the carrier.
  let turnId = turnSeed || lastTurnIdBefore(lines, Math.max(0, since - startLine));
  // Sub-agent thread id -> nickname, as this turn has met them. A delta that
  // starts mid-turn reads the turn's earlier lines for the names it has not
  // met (agentsBefore), so a wait's result is said in the same names either
  // way. That read is lazy: only a sub-agent result asks, and only while the
  // delta is still in the turn it started in.
  const agents = new Map();
  let earlier = null;
  let inFirstTurn = true;
  const names = {
    get(id) {
      if (agents.has(id)) return agents.get(id);
      if (!inFirstTurn) return undefined;
      if (!earlier) earlier = agentsBefore(lines, Math.max(0, since - startLine));
      return earlier.get(id);
    },
  };
  // 3.3b: FileChange hunks waiting for the output they ride (patchTracker). A
  // delta's first output also takes what the tracker held at `since`
  // (patchesBefore), asked once.
  let patches = patchTracker();
  let askedBefore = false;
  const notePatchBlock = (b) => {
    if (b.kind === 'tool_result' && !askedBefore) {
      askedBefore = true;
      if (inFirstTurn) {
        const before = patchesBefore(lines, Math.max(0, since - startLine));
        patches.pending = before.pending.concat(patches.pending);
        for (const [id, paths] of before.callPaths) if (!patches.callPaths.has(id)) patches.callPaths.set(id, paths);
      }
    }
    patches.block(b);
  };
  let branch = null;
  let model = null;
  let effort = null;
  let permissionMode = null;
  let usage = null;
  let activeStartedAt = null;
  let lastUserInputAt = null;
  // A Stop, as the same "Stopped" line a Claude interrupt draws. Codex writes
  // `turn_aborted` the moment the turn ends, and the reply it cut off is handed
  // back right after it (agent/engine-runs.js codexKeepPartial), so the line
  // waits for the next prompt, the next turn or the end of the read, and sits
  // under that reply rather than above it (QA 2026-10-08, 5.1).
  let stopLine = null;
  const flushStop = () => {
    if (stopLine) messages.push(stopLine);
    stopLine = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const idx = startLine + i;
    const line = lines[i];
    if (!line.trim()) {
      lastLineBad = false;
      continue;
    }
    if (idx < since) {
      lastLineBad = false;
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      lastLineBad = true; // torn final line re-reads next poll; mid-file garbage counts as consumed
      continue;
    }
    lastLineBad = false;
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'session_meta' && !cwd && rec.payload && typeof rec.payload.cwd === 'string') {
      cwd = rec.payload.cwd; // first session_meta is canonical
      // The branch the thread STARTED on: a first paint for the chip, which
      // /api/branch then confirms (features/bugs.md B11).
      const git = rec.payload.git;
      if (git && typeof git.branch === 'string' && git.branch) branch = git.branch;
    }
    if (rec.type === 'turn_context' && rec.payload && typeof rec.payload === 'object') {
      if (typeof rec.payload.model === 'string' && rec.payload.model) model = rec.payload.model;
      // effort lives at payload.effort (top-level) or under collaboration_mode; last turn wins
      const eff = rec.payload.effort || (rec.payload.collaboration_mode && rec.payload.collaboration_mode.settings && rec.payload.collaboration_mode.settings.reasoning_effort);
      if (typeof eff === 'string' && eff) effort = eff;
      const mode = codexPermissionMode(rec);
      if (mode) permissionMode = mode;
    }
    if (rec.type === 'event_msg' && rec.payload && rec.payload.type === 'turn_aborted') {
      if (rec.payload.reason === 'interrupted') {
        flushStop();
        const id = rec.payload.turn_id || turnId || `line${idx}`;
        stopLine = { role: 'user', messageId: `interrupted:${id}`, uuid: null, timestamp: rec.timestamp || null, blocks: [{ kind: 'interrupted', forTool: false }] };
      }
      continue;
    }
    if (rec.type === 'event_msg' && rec.payload && rec.payload.type === 'task_started') {
      flushStop();
      turnId = rec.payload.turn_id || `line${idx}`;
      agents.clear(); // names are the turn's own, so a delta read from its start knows the same ones
      inFirstTurn = false;
      patches = patchTracker();
      askedBefore = true;
      const ts = codexTimestampMs(rec.timestamp);
      activeStartedAt = ts == null ? lastUserInputAt : ts;
      continue;
    }
    if (rec.type === 'event_msg' && rec.payload && rec.payload.type === 'token_count' && rec.payload.info) {
      usage = rec.payload.info; // last one wins — carries model_context_window too
      continue;
    }
    if (rec.type === 'compacted') {
      const divider = codexCompaction(rec, idx, turnId);
      if (divider) messages.push(divider);
      continue;
    }
    // The rollout names every agent a wait or a spawn touched, just before that
    // call's output: the names its result is said in (codexAgentResult).
    if (rec.type === 'event_msg' && rec.payload && rec.payload.type === 'item_completed') {
      const item = rec.payload.item;
      if (item && item.type === 'CollabAgentToolCall' && Array.isArray(item.receiver_agents)) {
        for (const a of item.receiver_agents) {
          if (a && typeof a.thread_id === 'string' && typeof a.agent_nickname === 'string' && a.agent_nickname) agents.set(a.thread_id, a.agent_nickname);
        }
      }
      if (item && item.type === 'FileChange') patches.change(item);
      continue;
    }
    const message = rolloutToMessage(rec, turnId || `orphan${since}`, names);
    if (!message) continue;
    for (const b of message.blocks) {
      if (b.agent) agents.set(b.agent.id, b.agent.name);
      notePatchBlock(b);
    }
    if (message.role === 'user') {
      flushStop();
      const ts = codexTimestampMs(message.timestamp);
      if (ts != null) {
        lastUserInputAt = ts;
        if (!activeStartedAt) activeStartedAt = ts;
      }
    }
    const prev = messages[messages.length - 1];
    if (prev && prev.role === 'assistant' && message.role === 'assistant' && prev.messageId === message.messageId) {
      // One message holds a whole turn, but its records were written minutes
      // apart. Each merged block keeps its own record's time, or the turn's
      // "took", a card's clock and a row's duration all read the turn's FIRST
      // record and a 65-call turn said "took 3s" (features/02 1.9). A delta
      // that starts mid-turn opens a message stamped with that same time, so
      // the view reads one clock either way.
      if (message.timestamp && message.timestamp !== prev.timestamp) {
        for (const b of message.blocks) b.at = message.timestamp;
      }
      prev.blocks.push(...message.blocks);
      continue;
    }
    messages.push(message);
  }
  flushStop();

  const totalLines = startLine + (lastLineBad ? lines.length - 1 : lines.length);
  return { messages, totalLines, cwd, branch, model, effort, permissionMode, turnState: turnId, usage, activeStartedAt };
}

async function scanRollout(filePath, since, turnSeed) {
  return scanRolloutText(await readRolloutRaw(filePath), since, turnSeed);
}

async function parseRollout(filePath, since = 0, turnSeed = null) {
  let scan = await scanRollout(filePath, since, turnSeed);
  let reset = false;
  if (needsRescan(scan, since)) {
    scan = await scanRollout(filePath, 0, null);
    reset = true;
  }
  return finishRolloutParse(scan, since, reset);
}

// Byte-source twin: parse Codex rollout text held in memory (relay/tunnel; use decodeRollout
// on the raw/.zst bytes first). Same semantics as parseRollout.
function parseRolloutText(text, since = 0, turnSeed = null) {
  let scan = scanRolloutText(text, since, turnSeed);
  let reset = false;
  if (needsRescan(scan, since)) {
    scan = scanRolloutText(text, 0, null);
    reset = true;
  }
  return finishRolloutParse(scan, since, reset);
}

function finishRolloutParse(scan, since, reset) {
  const { messages, truncatedHead, truncatedTurns } = capHead(scan.messages);
  const result = {
    messages,
    totalLines: scan.totalLines,
    reset,
    truncatedHead,
    turnState: scan.turnState,
  };
  if (truncatedHead) result.truncatedTurns = truncatedTurns;
  if (since === 0 || reset) {
    result.cwd = scan.cwd || null;
    result.gitBranch = scan.branch || null;
    result.prLink = null;
    result.model = scan.model || null;
    result.effort = scan.effort || null;
    result.permissionMode = scan.permissionMode || null;
    result.usage = codexUsage(scan.usage);
    result.cumulativeUsage = codexCumulativeUsage(scan.usage);
    result.activeStartedAt = scan.activeStartedAt || null;
  } else {
    // A new turn_context (new turn) can change model/effort/mode mid-session;
    // forward them on deltas so an open session live-updates without a reopen.
    if (scan.model) result.model = scan.model;
    if (scan.effort) result.effort = scan.effort;
    if (scan.permissionMode) result.permissionMode = scan.permissionMode;
    if (scan.activeStartedAt) result.activeStartedAt = scan.activeStartedAt;
  }
  return result;
}

// Codex token_count.info → canonical usage shape. `last_token_usage.input_tokens`
// (which already includes cached) is the current context occupancy;
// `model_context_window` is the real denominator, straight off the rollout.
function codexUsage(info) {
  if (!info) return null;
  const last = info.last_token_usage || info.total_token_usage || {};
  const cached = last.cached_input_tokens ?? 0;
  return {
    contextTokens: last.input_tokens ?? null,
    inputTokens: last.input_tokens ?? null,
    // codex input_tokens INCLUDES cached, so fresh = input - cached (keeps the
    // segments summing to contextTokens like Claude); no separate cache-write bucket
    freshInput: last.input_tokens != null ? Math.max(0, last.input_tokens - cached) : null,
    cacheRead: last.cached_input_tokens ?? null,
    cacheCreate: null,
    outputTokens: last.output_tokens ?? null,
    contextWindow: info.model_context_window ?? null,
  };
}

// Unlike Claude, Codex's token_count event already carries a running session
// total (info.total_token_usage) alongside the last turn's — no dedup-summing
// needed, just read the other bucket.
function codexCumulativeUsage(info) {
  if (!info || !info.total_token_usage) return null;
  const total = info.total_token_usage;
  const cached = total.cached_input_tokens ?? 0;
  return {
    freshInput: total.input_tokens != null ? Math.max(0, total.input_tokens - cached) : null,
    cacheRead: total.cached_input_tokens ?? null,
    cacheCreate: null,
    outputTokens: total.output_tokens ?? null,
  };
}

/* ================= Grok Build updates.jsonl ================= */

// parseRollout's twin for the `grok` CLI's ACP session/update stream
// (ground truth verified against real `grok` 0.2.101 — see lib/grok-data.js's
// header). Same contract: pure text -> { messages, totalLines, ... }, same
// torn-final-line semantics, same shared block vocabulary out. updates.jsonl
// carries no API message id and no explicit turn-start event (unlike Codex's
// task_started); the closest thing to a turn boundary is the promptId that
// shows up in params._meta once the agent starts responding (never on the
// user's own user_message_chunk, and NOT reliably on every later frame either
// — e.g. mid-stream tool_call_update frames can omit it). So — mirroring
// Codex's sticky-turn-id approach for the same live/disk-symmetry reason —
// this keeps a closure `turnId` that only moves forward when a frame actually
// carries a promptId (params._meta.promptId, or turn_completed's
// update.prompt_id), and otherwise stays put. `turnSeed` threads that id
// across incremental (`?since`) scans exactly like parseRollout's turnSeed.
//
// A tool call's lifecycle is multi-frame: one `tool_call` (may carry partial
// rawInput) followed by several `tool_call_update`s (status ''/in_progress/
// .../completed, each able to carry its own slice of locations/rawInput/
// content/rawOutput). All frames for one toolCallId fold into the SAME
// tool_use block (looked up by id in a per-scan Map); exactly one tool_result
// is emitted, from the terminal (completed/failed/...) frame's content —
// verified against the fixtures to be a full snapshot per frame, not a delta,
// so only the terminal frame's content/rawOutput is read, earlier in_progress
// frames' content is ignored.
//
// A lifecycle can also span two `?since` windows — the `tool_call` frame in
// one incremental parse, the terminal `tool_call_update` in the next (the
// watcher's normal incremental parse as updates.jsonl grows). The per-scan
// Map alone can't see across that boundary, so `turnSeed` doubles as a
// carrier for two toolCallId sets threaded the same way as turnId: `toolIds`
// (every id that has ever had a tool_use block emitted, in this or an
// earlier window) and `resultIds` (every id whose terminal tool_result has
// already been emitted). A terminal update for an id in `toolIds` but not
// yet in `resultIds` emits ONLY the tool_result — no second tool_use. The
// stub-synthesis path is reserved for a toolCallId truly never seen in any
// window (not in `toolIds` either) — a genuine mid-call cold start (e.g. a
// `?since` REST read with no seed).

const TERMINAL_TOOL_STATUSES = new Set(['completed', 'failed', 'error', 'cancelled']);

function grokPromptId(rec) {
  const params = rec && rec.params;
  const update = params && params.update;
  if (update && update.sessionUpdate === 'turn_completed' && typeof update.prompt_id === 'string' && update.prompt_id) {
    return update.prompt_id;
  }
  const meta = params && params._meta;
  if (meta && typeof meta.promptId === 'string' && meta.promptId) return meta.promptId;
  return null;
}

function grokChunkText(content) {
  return content && content.type === 'text' && typeof content.text === 'string' ? content.text : '';
}

// tool_call_update's `content` array holds either {type:'content',content:{type:'text',text}}
// (read/execute tools) or {type:'diff',...} (write/edit tools — no plain-text summary here).
function grokContentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (item && item.type === 'content' ? grokChunkText(item.content) : ''))
    .filter(Boolean)
    .join('\n');
}

// Fallback for tool kinds whose `content` array carries no plain text (edits):
// rawOutput's shape is tool-specific — Bash/{output_for_prompt}, ReadFile/
// {FileContent.content}, SearchReplace (write/edit)/{EditsApplied.tool_output_for_prompt}.
function grokRawOutputText(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'object') return '';
  if (typeof rawOutput.output_for_prompt === 'string' && rawOutput.output_for_prompt) return rawOutput.output_for_prompt;
  if (rawOutput.FileContent && typeof rawOutput.FileContent.content === 'string') return rawOutput.FileContent.content;
  if (rawOutput.EditsApplied && typeof rawOutput.EditsApplied.tool_output_for_prompt === 'string') return rawOutput.EditsApplied.tool_output_for_prompt;
  return '';
}

function grokToolResultText(update) {
  const fromContent = grokContentText(update.content);
  if (fromContent) return fromContent;
  return grokRawOutputText(update.rawOutput);
}

function grokToolUseBlock(toolCallId, title, rawInput, meta) {
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  let inputJson = '';
  try {
    inputJson = JSON.stringify(input, null, 2) || '';
  } catch {}
  const body = truncate(inputJson, TOOL_INPUT_MAX);
  const preview = inputPreview(title, input);
  return {
    kind: 'tool_use',
    id: toolCallId,
    name: title || 'tool',
    inputPreview: preview,
    // The Claude and Codex block builders both set this and Grok's did not,
    // which was a gap rather than a decision: a Grok tool that carries a
    // description had it dropped on the floor, and the row it built could only
    // ever show the value. Returns null when there is none, which is what Grok's
    // own tools do today — this is here for the MCP tools it can be given.
    description: inputDescription(input, preview),
    inputJson: body.text,
    truncated: body.truncated,
    // Risk metadata from _meta["x.ai/tool"] — carried through so a later piece
    // can wire it into approval scoring instead of it being lost.
    toolKind: meta && typeof meta.kind === 'string' ? meta.kind : null,
    readOnly: meta && typeof meta.read_only === 'boolean' ? meta.read_only : null,
  };
}

// Grok's on-disk / live usage → Termdeck's canonical usage shape.
//
// CRITICAL: `usage.inputTokens` from turn_completed / session/prompt is the SUM
// of every model call in the turn (tool loops set modelCalls/numTurns > 1). That
// is a legitimate cost total, NOT point-in-time context occupancy — treating it
// as contextTokens is the same trap Claude hit (main.js run-complete comment).
// Occupancy comes from params._meta.totalTokens on session/update frames (what
// the CLI streams continuously) or, for single-call turns only, inputTokens.
// contextWindow is not on the usage object; callers supply it from the model
// catalog (or leave null for the frontend modelCap fallback).
function grokUsage(usage, contextTokens, contextWindow) {
  if (!usage && contextTokens == null) return null;
  const inputTokens = usage && usage.inputTokens != null ? usage.inputTokens : null;
  const cached = usage && usage.cachedReadTokens != null ? usage.cachedReadTokens : null;
  const calls = usage && usage.modelCalls != null ? usage.modelCalls : usage && usage.numTurns != null ? usage.numTurns : null;
  // NEVER fall back to inputTokens for occupancy. On Grok even single-call
  // turns disagree (e.g. inputTokens 15332 vs totalTokens/signals 5329) —
  // inputTokens is billed prompt size, not the CLI's context meter.
  const ctx = contextTokens != null && Number.isFinite(contextTokens) ? contextTokens : null;
  return {
    contextTokens: ctx,
    inputTokens,
    // I/O buckets (may be multi-call SUMS). Cost/I/O asides use them; the
    // occupancy segment bar must not (see renderContextBreakdown for Grok).
    freshInput: inputTokens != null && cached != null ? Math.max(0, inputTokens - cached) : null,
    cacheRead: cached,
    cacheCreate: null,
    outputTokens: usage && usage.outputTokens != null ? usage.outputTokens : null,
    contextWindow: contextWindow != null && Number.isFinite(contextWindow) ? contextWindow : null,
    modelCalls: calls,
  };
}

// turnSeed is either null, a bare turnId string (legacy/back-compat), or the
// object shape this function itself returns via turnState: { turnId, toolIds,
// resultIds } — see the "lifecycle can also span two `?since` windows" note
// above.
function scanGrokUpdatesText(text, since, turnSeed) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop(); // trailing-newline artifact, not a line
  return scanGrokLines(lines, since, turnSeed, 0);
}

// Line-array core, mirror of scanRolloutLines: `startLine` is the absolute
// line number of lines[0]; the turnSeed object (turnId + tool/result id sets)
// is the only cross-window state and the cursor chains it per feed.
function scanGrokLines(lines, since, turnSeed, startLine = 0) {
  const messages = [];
  let lastLineBad = false;
  let turnId = null;
  let seedToolIds = null;
  let seedResultIds = null;
  if (turnSeed && typeof turnSeed === 'object') {
    turnId = turnSeed.turnId || null;
    seedToolIds = turnSeed.toolIds || null;
    seedResultIds = turnSeed.resultIds || null;
  } else if (typeof turnSeed === 'string') {
    turnId = turnSeed;
  }
  let activeStartedAt = null;
  // True while the records run through one prompt's user chunks. The turn clock
  // is the LAST prompt's first chunk: a follow-up queued behind a running turn
  // lands in the same file, and taking the window's first chunk clocked it from
  // the previous prompt.
  let inUserPrompt = false;
  let lastTotalTokens = null; // params._meta.totalTokens — live context occupancy
  let lastUsage = null; // turn_completed.usage (I/O breakdown; inputTokens may be multi-call sum)
  let model = null;
  const toolCalls = new Map(); // toolCallId -> { block, resultEmitted } (block is null for an id known only via the seed)

  function turnKey() {
    return `turn:${turnId || `orphan${since}`}`;
  }

  // One growing assistant message per turn — text/thinking/tool_use/tool_result
  // all land in its blocks array in disk order, exactly like Codex's response_item
  // merge (rolloutToMessage's base.messageId), so the viewer needs no new render code.
  function assistantMessage(ts) {
    const key = turnKey();
    const prev = messages[messages.length - 1];
    if (prev && prev.role === 'assistant' && prev.messageId === key) return prev;
    const msg = { role: 'assistant', messageId: key, uuid: null, timestamp: ts || null, blocks: [] };
    messages.push(msg);
    return msg;
  }

  // Streamed text/thinking arrives as many small chunks; a chunk immediately
  // following another chunk of the SAME kind (nothing else interleaved) is a
  // fragment of the same logical block and concatenates onto it instead of
  // starting a new one.
  function pushMergeable(msg, kind, textVal) {
    const blocks = msg.blocks;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) {
      last.text += textVal;
      return;
    }
    blocks.push({ kind, text: textVal });
  }

  for (let i = 0; i < lines.length; i++) {
    const idx = startLine + i;
    const line = lines[i];
    if (!line.trim()) {
      lastLineBad = false;
      continue;
    }
    if (idx < since) {
      lastLineBad = false;
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      lastLineBad = true; // torn final line re-reads next poll; mid-file garbage counts as consumed
      continue;
    }
    lastLineBad = false;
    const params = rec && rec.params;
    const update = params && params.update;
    if (!update || typeof update.sessionUpdate !== 'string') continue; // non-update record — skip

    const pid = grokPromptId(rec);
    if (pid && pid !== turnId) turnId = pid;

    // Live occupancy: nearly every post-prompt session/update frame carries
    // params._meta.totalTokens (fixtures + real sessions). Last value wins.
    const frameMeta = params && params._meta;
    if (frameMeta && typeof frameMeta.totalTokens === 'number' && Number.isFinite(frameMeta.totalTokens)) {
      lastTotalTokens = frameMeta.totalTokens;
    }

    const ts = typeof rec.timestamp === 'number' ? rec.timestamp * 1000 : null;
    if (update.sessionUpdate !== 'user_message_chunk') inUserPrompt = false;

    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const t = grokChunkText(update.content);
        if (!t) break;
        messages.push({ role: 'user', messageId: null, uuid: null, timestamp: ts, blocks: promptTextBlocks(t) });
        if (ts != null && (!inUserPrompt || !activeStartedAt)) activeStartedAt = ts;
        inUserPrompt = true;
        // update._meta.modelId is set on the user chunk (not params._meta).
        const um = update._meta;
        if (um && typeof um.modelId === 'string' && um.modelId) model = um.modelId;
        break;
      }
      case 'agent_message_chunk': {
        const t = grokChunkText(update.content);
        if (!t) break;
        pushMergeable(assistantMessage(ts), 'text', t);
        break;
      }
      case 'agent_thought_chunk': {
        const t = grokChunkText(update.content);
        if (!t) break;
        pushMergeable(assistantMessage(ts), 'thinking', t);
        break;
      }
      case 'tool_call': {
        const toolCallId = update.toolCallId;
        if (!toolCallId) break;
        const meta = update._meta && update._meta['x.ai/tool'];
        const block = grokToolUseBlock(toolCallId, update.title, update.rawInput, meta);
        assistantMessage(ts).blocks.push(block);
        toolCalls.set(toolCallId, { block, resultEmitted: false });
        break;
      }
      case 'tool_call_update': {
        const toolCallId = update.toolCallId;
        if (!toolCallId) break;
        let entry = toolCalls.get(toolCallId);
        if (!entry) {
          const knownFromSeed = Boolean(seedToolIds && seedToolIds.has(toolCallId));
          if (knownFromSeed) {
            // Already emitted a tool_use for this id in an earlier `?since`
            // window (per the threaded seed) — this window only saw the
            // terminal update, not the original tool_call. Don't synthesize
            // a second tool_use; just track it so the result logic below can
            // fold/emit against a null block.
            entry = { block: null, resultEmitted: Boolean(seedResultIds && seedResultIds.has(toolCallId)) };
          } else {
            // A genuine orphan: no preceding tool_call in this scan window
            // AND no record of this id from any earlier window either (a
            // ?since delta starting mid-call with no seed) — synthesize a
            // stub so the update still has somewhere to fold into.
            const block = grokToolUseBlock(toolCallId, update.title, update.rawInput, update._meta && update._meta['x.ai/tool']);
            assistantMessage(ts).blocks.push(block);
            entry = { block, resultEmitted: false };
          }
          toolCalls.set(toolCallId, entry);
        }
        const block = entry.block;
        // Fold rawInput only if the tool_use didn't already carry one (the
        // initial tool_call frame usually does; a later update's rawInput
        // is often just a superset with a `variant` tag added). No block to
        // fold into when this id's tool_use lives in an earlier window.
        if (block && (!block.inputJson || block.inputJson === '{}') && update.rawInput && typeof update.rawInput === 'object') {
          let inputJson = '';
          try {
            inputJson = JSON.stringify(update.rawInput, null, 2) || '';
          } catch {}
          const body = truncate(inputJson, TOOL_INPUT_MAX);
          block.inputJson = body.text;
          block.truncated = block.truncated || body.truncated;
          if (!block.inputPreview) block.inputPreview = inputPreview(block.name, update.rawInput);
        }
        const meta = update._meta && update._meta['x.ai/tool'];
        if (block && meta) {
          if (block.toolKind == null && typeof meta.kind === 'string') block.toolKind = meta.kind;
          if (block.readOnly == null && typeof meta.read_only === 'boolean') block.readOnly = meta.read_only;
        }
        const status = typeof update.status === 'string' ? update.status : '';
        // Multi-stage: many tool_call_update frames share one toolCallId (status
        // ''/in_progress/.../completed); only the terminal one emits a result, and
        // only once, however many more frames for the same id follow (even across
        // a window boundary, tracked via resultEmitted/seedResultIds above).
        if (TERMINAL_TOOL_STATUSES.has(status) && !entry.resultEmitted) {
          entry.resultEmitted = true;
          const raw = grokToolResultText(update);
          const body = truncate(stripAnsi(raw), TOOL_RESULT_MAX);
          const ansi = ansiSibling(raw, body.text, TOOL_RESULT_MAX);
          assistantMessage(ts).blocks.push({
            kind: 'tool_result',
            toolUseId: toolCallId,
            isError: status !== 'completed',
            text: body.text,
            ...(ansi ? { textAnsi: ansi } : {}),
            truncated: body.truncated,
          });
        }
        break;
      }
      case 'turn_completed':
        // No block to render, but this is where the CLI writes the turn's
        // usage breakdown (input/output/cache). Occupancy still prefers
        // lastTotalTokens over usage.inputTokens (see grokUsage).
        if (update.usage && typeof update.usage === 'object') lastUsage = update.usage;
        break;
      default:
        break; // unrecognized sessionUpdate kind (e.g. available_commands_update) — ignore, don't crash
    }
  }

  const totalLines = startLine + (lastLineBad ? lines.length - 1 : lines.length);
  // Union forward: every id that ever got a tool_use (seed carry-forward plus
  // any real/synthesized block from THIS window) and every id whose result
  // has ever been emitted — so the next `?since` window recognizes a
  // terminal update for an id whose tool_call frame it never saw.
  const toolIds = new Set(seedToolIds || []);
  const resultIds = new Set(seedResultIds || []);
  for (const [id, entry] of toolCalls) {
    if (entry.block) toolIds.add(id);
    if (entry.resultEmitted) resultIds.add(id);
  }
  return {
    messages,
    totalLines,
    turnState: { turnId, toolIds, resultIds },
    activeStartedAt,
    lastTotalTokens,
    lastUsage,
    model,
  };
}

function finishGrokParse(scan, since, reset) {
  const { messages, truncatedHead, truncatedTurns } = capHead(scan.messages);
  const result = { messages, totalLines: scan.totalLines, reset, truncatedHead, turnState: scan.turnState };
  if (truncatedHead) result.truncatedTurns = truncatedTurns;
  const usage = grokUsage(scan.lastUsage, scan.lastTotalTokens, null);
  if (since === 0 || reset) {
    result.activeStartedAt = scan.activeStartedAt || null;
    result.model = scan.model || null;
    result.usage = usage;
  } else {
    // Deltas: forward usage/model whenever this window saw them so an open
    // session's context strip updates without a reopen (mirrors Codex).
    if (scan.activeStartedAt) result.activeStartedAt = scan.activeStartedAt;
    if (scan.model) result.model = scan.model;
    if (usage) result.usage = usage;
  }
  return result;
}

// Byte-source parse of Grok updates.jsonl text held in memory. Same
// `?since`/turnSeed/reset semantics as parseRolloutText.
function parseGrokUpdatesText(text, since = 0, turnSeed = null) {
  let scan = scanGrokUpdatesText(text, since, turnSeed);
  let reset = false;
  if (needsRescan(scan, since)) {
    scan = scanGrokUpdatesText(text, 0, null);
    reset = true;
  }
  return finishGrokParse(scan, since, reset);
}

// Same "last input from me" sort key as lastCodexUserInputAt, for a
// updates.jsonl tail buffer: last user_message_chunk's timestamp (ms epoch),
// scanning bottom-up. Canonical version — grok-data.js's own lastUserInputAt
// calls this instead of inlining its own tail-scan (mirrors codex-data.js
// calling lastCodexUserInputAt).
// Grok's title lives in summary.json (generated_title / session_summary), which the
// agent may never have written — a session that ended before grok summarised it has
// neither, and there is no other title record in the engine at all. So fall back to
// the chat's own first prompt, the same rung Claude's head gives it. Top-down: the
// FIRST user chunk is the opening prompt. Reads a head buffer of updates.jsonl.
function firstGrokUserInput(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    let rec;
    try {
      rec = JSON.parse(l);
    } catch {
      continue; // a head window can cut the LAST line in half
    }
    const update = rec && rec.params && rec.params.update;
    if (!update || update.sessionUpdate !== 'user_message_chunk') continue;
    const t = grokChunkText(update.content);
    if (t.trim()) return t.trim();
  }
  return null;
}

function lastGrokUserInputAt(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // tail window may cut the first line in half
    }
    const params = rec && rec.params;
    const update = params && params.update;
    if (!update || update.sessionUpdate !== 'user_message_chunk') continue;
    const t = grokChunkText(update.content);
    if (!t.trim()) continue;
    const meta = params._meta;
    const ts = (meta && typeof meta.agentTimestampMs === 'number' && meta.agentTimestampMs)
      || (typeof rec.timestamp === 'number' ? rec.timestamp * 1000 : null);
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

/* ---------- preview windows ---------- */

// A preview window is the last N messages, but a blind slice(-N) can land
// entirely on assistant/tool records and drop the prompt that started the turn
// — the one line the user always wants on screen. Extend the window back to the
// last real user prompt (a `user` record carrying non-empty text; a user record
// holding only tool_result blocks is not a prompt).
//
// The ceiling is a backstop, not a budget: one long agentic turn measured 159
// messages deep, so 600 leaves ~4x headroom while still bounding a pathological
// session well under the parser's own MAX_MESSAGES (5000).
//
// Lives here rather than in server.js because BOTH products window transcripts:
// the hub serves its own files, and the cloud master windows what it read over
// the tunnel (lib/cloud/machine-host.js). A master that skipped this shipped the
// entire transcript for every open — and, once the browser started seeding its
// cache from previews, would have shipped every transcript on the machine.
const PREVIEW_PROMPT_LOOKBACK = 600;

// Ceiling on how far the prompt anchor may stretch a SEED window, mirroring
// SEED_MAX in public/js/transcript-cache.js — the client applies the same rule
// to what it stores, and shipping more than that is pure waste.
//
// Measured on a real 118 MB chat: `?preview=5` came back with 92 messages and
// 8.6 MB, byte-identical to `?preview=15`, because the last user prompt was 92
// messages back behind one long agentic turn. The client then threw 87 of them
// away. The anchor is right for a chat somebody opened — you must not land on a
// promptless wall of tool output — but a seed is a placeholder for a chat nobody
// has opened, and it does not get to cost megabytes to keep one prompt on screen.
const SEED_ANCHOR_CAP = 30;

// Ceiling on how far the anchor may stretch a real OPEN. The open used to pass
// none ("a real open wants the prompt at any cost"), and the cost was the audit's
// P1-02: the 15 the client asked for became 92 messages and 8.6 MB on one chat
// and 547 messages on another, all parsed, rendered and laid out on the main
// thread before the reader saw anything, because one agentic turn ran that
// deep. Past this many, the open takes the plain tail and says what it cut
// (`promptContext` below), and the view offers the way back up: the prompt
// is one bounded `?before` page away instead of the price of every open.
//
// The same number as the seed cap, on purpose: the window the hub pushes on
// subscribe (a paint, capped at SEED_ANCHOR_CAP) and the authoritative load
// behind it now cut at the same place, so the load can adopt the paint instead
// of rebuilding the pane over it (transcript-view.js adoptAuthoritative).
const OPEN_ANCHOR_CAP = 30;

// How much of the cut prompt rides along as context: enough to recognise it,
// never a second copy of it.
const PROMPT_CONTEXT_CHARS = 240;

function isUserPromptMessage(message) {
  if (!message || message.role !== 'user' || !Array.isArray(message.blocks)) return false;
  return message.blocks.some((blk) => blk && blk.kind === 'text' && typeof blk.text === 'string' && blk.text.trim());
}

function promptText(message) {
  return message.blocks
    .filter((blk) => blk && blk.kind === 'text' && typeof blk.text === 'string')
    .map((blk) => blk.text.trim())
    .filter(Boolean)
    .join('\n');
}

// -> { messages, hasEarlier, windowStart[, promptContext] } for a parsed message
// list, honoring `preview`. preview <= 0 means "no window" and returns the list
// untouched.
//
// cap > 0 bounds what the anchor may add: past it, take the plain tail instead,
// and say so: `promptContext` names the prompt the cap cut (its ABSOLUTE index,
// the first PROMPT_CONTEXT_CHARS of its text, and how many messages of its turn
// sit above the window), so the client can offer "show the whole turn" as one
// bounded page instead of either shipping the turn or losing the prompt.
// Seeds pass SEED_ANCHOR_CAP, opens pass OPEN_ANCHOR_CAP; cap 0 is the
// uncapped form and only tests call it that way now.
//
// `windowStart` is the ABSOLUTE index of messages[0] in the full parse. It is
// the cursor `earlierWindow` pages backwards from: absolute indexes are stable
// under append (new records only ever land at the tail — a rewrite raises
// `reset` and invalidates everything), so a client can hold one across any
// number of live deltas and still name the exact history above its window.
function previewWindow(messages, preview, cap = 0) {
  if (!(preview > 0) || messages.length <= preview) return { messages, hasEarlier: false, windowStart: 0 };
  const tail = messages.length - preview;
  let start = tail;
  let promptAt = -1;
  const floor = Math.max(0, messages.length - PREVIEW_PROMPT_LOOKBACK);
  for (let i = start; i >= floor; i -= 1) {
    if (isUserPromptMessage(messages[i])) { start = i; promptAt = i; break; }
  }
  // A prompt's checkpoint row sits immediately above it, so anchoring exactly on
  // the prompt would cut the one restore point the window is about — and cutting
  // it looks like the turn never made one.
  if (start > 0 && messages[start - 1] && messages[start - 1].role === 'checkpoint') start -= 1;
  let promptContext = null;
  if (cap > 0 && messages.length - start > cap) {
    if (promptAt >= 0 && promptAt < tail) {
      promptContext = {
        index: promptAt,
        text: promptText(messages[promptAt]).slice(0, PROMPT_CONTEXT_CHARS),
        messagesSince: tail - promptAt,
      };
    }
    start = tail;
  }
  const out = { messages: messages.slice(start), hasEarlier: start > 0, windowStart: start };
  if (promptContext) out.promptContext = promptContext;
  return out;
}

// The backwards companion to previewWindow: the `limit` messages ENDING at
// absolute index `before` (exclusive) — one page of scroll-back history. This is
// what replaced the "load earlier" fetch of the ENTIRE transcript: the parse is
// memoized either way, but the wire and the browser used to get all of it.
//
// `paged: true` is the contract with the client: prepend these above what you
// hold, do not repaint from them.
function earlierWindow(messages, before, limit) {
  const end = Math.max(0, Math.min(Math.floor(before) || 0, messages.length));
  const start = Math.max(0, end - Math.max(1, Math.floor(limit) || 1));
  return { messages: messages.slice(start, end), windowStart: start, hasEarlier: start > 0, paged: true };
}

// What a PAINT is allowed to carry.
//
// Measured on one real chat: `?preview=15` came back at 1001 KB. Two causes,
// and neither is the number of messages anybody asked for:
//   * 354 KB of it was FOUR tool results carrying inline base64 screenshots
//     (90-128 KB each) — a paint does not need them, and a seed carrying them
//     is stored in IndexedDB on a phone;
//   * the window itself was 547 messages, because previewWindow anchors back to
//     the prompt that started the turn and that prompt was 547 messages back.
//
// So a paint drops inline images (the count survives, so the view can say what
// is coming), truncates any single oversized text block, and takes the capped
// anchor. The authoritative load right behind it carries all of it in full —
// which is exactly why dropping it here costs the reader nothing.
const PREVIEW_TEXT_MAX = 8 * 1024;

function capPreviewBlock(block) {
  if (!block || typeof block !== 'object') return block;
  let out = block;
  const copy = () => { if (out === block) out = { ...block }; return out; };
  if (Array.isArray(block.images) && block.images.length) {
    copy();
    out.imagesOmitted = block.images.length;
    delete out.images;
  }
  for (const field of ['text', 'inputJson', 'diff']) {
    const v = block[field];
    if (typeof v === 'string' && v.length > PREVIEW_TEXT_MAX) {
      copy();
      out[field] = v.slice(0, PREVIEW_TEXT_MAX);
      out.truncated = true;
    }
  }
  return out;
}

// Pure: returns new objects only where something was actually cut, so a message
// list that needs no capping is passed through untouched (and a frozen parse-memo
// entry is never mutated — that object is shared with every other reader).
function capPreviewBlocks(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((msg) => {
    if (!msg || !Array.isArray(msg.blocks)) return msg;
    let msgChanged = false;
    const blocks = msg.blocks.map((b) => {
      const capped = capPreviewBlock(b);
      if (capped !== b) msgChanged = true;
      return capped;
    });
    if (!msgChanged) return msg;
    changed = true;
    return { ...msg, blocks };
  });
  return changed ? out : messages;
}

// A preview served from the TAIL of a file rather than the whole of it (see
// lib/tail-read.js for why). `parsed` is the tail's own parse; `startLine` is
// how many lines precede it.
//
// Two fields a tail CANNOT honestly report, because both are properties of the
// whole file:
//   * `cwd` — the session's opening directory, which is above the cut. The
//     header wants a path, so it gets the CURRENT one (last record wins), which
//     is what it displays anyway; claiming a stale origin would be worse.
//   * `cumulativeUsage` — a running sum over every turn. A partial sum shown as
//     a session total is a wrong COST, so it is dropped rather than guessed;
//     the full load that follows fills it in.
// Everything else the scanner reports is last-value-wins (model, effort,
// permissionMode, gitBranch, currentCwd, the last turn's usage) and the last
// value is in the tail by definition.
//
// `partial: true` is the contract with the client: this is a paint, the rest is
// still up there, and `hasEarlier` is true even when the window did not fill.
function finishPartialPreview(parsed, { startLine = 0, whole = true, preview = 0, cap = 0 } = {}) {
  const win = previewWindow(parsed.messages, preview, cap);
  const out = { ...parsed, messages: capPreviewBlocks(win.messages), hasEarlier: win.hasEarlier, windowStart: win.windowStart };
  if (win.promptContext) out.promptContext = win.promptContext;
  if (whole) return out;
  out.totalLines = startLine + parsed.totalLines;
  out.partial = true;
  out.truncatedHead = true;
  out.hasEarlier = true;
  // A tail parse's message indexes are offsets into the TAIL, not the file — a
  // partial window cannot honestly report where it starts, and a client must
  // not page backwards from a number that means nothing.
  out.windowStart = null;
  // Same for the cut prompt: its text and depth are true, its index is a tail
  // offset. The authoritative load behind this paint carries the real one.
  if (out.promptContext) out.promptContext = { ...out.promptContext, index: null };
  out.cwd = parsed.currentCwd || parsed.cwd || null;
  out.cumulativeUsage = null;
  return out;
}

module.exports = {
  inputDescription,
  parseTranscript, parseRollout, readRolloutRaw, isSyntheticUserText, inputPreview, isCodexRejection,
  finishPartialPreview,
  // Prompt-anchored preview window — shared by the hub and the cloud master so a
  // chat opens the same length on either product. earlierWindow is its backwards
  // companion: one bounded page of scroll-back above an absolute message index.
  splitUploadBlock,
  previewWindow, earlierWindow, PREVIEW_PROMPT_LOOKBACK, SEED_ANCHOR_CAP, OPEN_ANCHOR_CAP, PROMPT_CONTEXT_CHARS,
  // What a paint may carry: no inline images, no oversized block (see above).
  capPreviewBlocks, PREVIEW_TEXT_MAX,
  // Byte-source seam (Phase 12 relay): parse from in-memory bytes instead of a path.
  parseTranscriptText, parseRolloutText, decodeRollout,
  // Resumable form of the same parse: an append costs the append, not the file
  // (features/70-parse-cursor.md). All three engines.
  createParseCursor,
  createShellScanner,
  // Where a resume must start, computed over bytes somebody else parsed. The
  // mint side of the cursor token (features/04); the cursor's own state() is
  // the other.
  byteCursorFor,
  parseSubagentText, scanBackgroundShells, scanRunEndings,
  // Per-model token totals of a chat's subagent transcripts (the pane's cost).
  createSubagentUsageTally, addSubagentUsage,
  // Grok Build engine (ACP session/update stream).
  parseGrokUpdatesText,
  // Canonical sticky-turn-id extractor and terminal tool-call statuses — the
  // single source of truth lib/grok-events.js's live path reuses instead of
  // hand-copying (was two "keep in sync" comments pointing at each other).
  grokPromptId, TERMINAL_TOOL_STATUSES,
  // "Last input from me" sort key, computed from a transcript tail buffer.
  lastClaudeUserInputAt, lastCodexUserInputAt, lastGrokUserInputAt, codexTimestampMs,
  // "When did this chat last move": the row's displayed time, and the one
  // reading a file mtime cannot give while a CLI holds the transcript open.
  lastRecordAt,
  // Grok's fallback title when summary.json never got one.
  firstGrokUserInput,
};
