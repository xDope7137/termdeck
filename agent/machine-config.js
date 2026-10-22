'use strict';

// What the engine is CONFIGURED with on this machine — the surfaces that live in
// `~/.claude` and were invisible from Termdeck (V3 §G, plus U2's hooks viewer
// and U9's settings chain, which turn out to be the same read).
//
// Sub-agents, skills, commands, plugins, hooks and the settings precedence chain
// are all files in one directory tree, and the tree is a transcript ROOT — so
// this needs no widening of the agent's confinement at all. It only needs to run
// where the disk is.
//
// It asks a QUESTION, not for bytes (`lib/index-head.js`'s rule): a browser that
// fetched each of these files over the tunnel would cost dozens of round trips
// to render one panel, and the panel wants a summary, not the contents. So this
// module walks the tree once on the machine and returns a structured answer,
// bounded on every axis.
//
// SECRETS. `settings.json` carries `env`, which is where people put API keys —
// and this is rendered into a browser that may be on a phone on someone else's
// wifi. Values are dropped and only the NAMES are kept, the same trade
// `lib/mcp-config.js` makes with server URLs: the question a config panel
// answers is "what is set", never "what is it set to".
//
// Shipped to agents by name (AGENT_FILES in master.js), so this module may only
// require SIBLINGS in lib/ — an installed agent has a flat directory. It
// requires none: node builtins only.

const fsp = require('fs/promises');
const path = require('path');
// A sibling in lib/ and in an installed agent's flat directory alike (AGENT_FILES).
const { redactCommandLine } = require('./mcp-config');

// Every cap is enforced HERE and never read from a request. A machine with a
// thousand skills reports the first hundred and says it truncated.
const MAX_ENTRIES = 100;
// Enough for any frontmatter block; a SKILL.md can be tens of KB and none of it
// past the header is wanted.
const HEAD_BYTES = 8 * 1024;
// A settings file is small. One that is not is not a settings file.
const MAX_SETTINGS_BYTES = 512 * 1024;
const MAX_STR = 400;

const clip = (v, n = MAX_STR) => (typeof v === 'string' ? v.slice(0, n) : null);

async function readHead(file, bytes = HEAD_BYTES) {
  const fd = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fd.close();
  }
}

// YAML frontmatter, the subset these files actually use: `key: value` lines
// between two `---` fences. Deliberately not a YAML parser — a dependency-free
// agent has none, and every field here is a scalar. Anything it cannot read is
// simply absent, which the UI renders as "no description".
//
// BLOCK SCALARS are the one piece of real YAML that had to be handled. A great
// many SKILL.md files write their description as `description: >` with the text
// indented underneath, and reading that as the literal string ">" is what this
// panel used to show for them.
//
// Only the EXPLICIT `>`/`|` indicators fold. A bare `key:` with an indented
// block under it is a nested MAP (`metadata:` is one), and flattening that into
// a string would just be a different wrong answer.
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    const block = /^([>|])[-+]?\d*$/.exec(v); // `>`, `|`, and their chomp/indent suffixes
    if (block) {
      // Every indented line belongs to the key, blank lines included; the block
      // ends at the first non-blank line back at column 0 (the next key, or the
      // closing fence).
      const body = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s/.test(lines[i + 1]))) {
        body.push(lines[i + 1]);
        i += 1;
      }
      const indent = Math.min(...body.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length), Infinity);
      const stripped = body.map((l) => (l.trim() ? l.slice(indent) : ''));
      // Folded (`>`) is one long sentence wrapped for the editor's benefit;
      // literal (`|`) meant those line breaks.
      v = (block[1] === '>' ? stripped.filter(Boolean).join(' ') : stripped.join('\n')).trim();
    } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[kv[1]] = v;
  }
  return out;
}

async function readJson(file, max = MAX_SETTINGS_BYTES) {
  let st;
  try { st = await fsp.stat(file); } catch { return { exists: false }; }
  if (!st.isFile()) return { exists: false };
  if (st.size > max) return { exists: true, tooLarge: true, bytes: st.size };
  try {
    return { exists: true, bytes: st.size, json: JSON.parse(await fsp.readFile(file, 'utf8')) };
  } catch (err) {
    // A settings file that does not parse is a REAL answer — it is why the
    // engine is ignoring the settings someone believes are in force.
    return { exists: true, bytes: st.size, error: clip(err.message, 200) };
  }
}

// The names of everything in `env`, never the values. Same for anything else
// that could hold a credential.
function redactSettings(json) {
  if (!json || typeof json !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    if (k === 'env' && v && typeof v === 'object') {
      out.env = { keys: Object.keys(v).slice(0, MAX_ENTRIES) };
      continue;
    }
    if (k === 'apiKeyHelper' || k === 'awsAuthRefresh' || k === 'awsCredentialExport') {
      out[k] = '«set»';
      continue;
    }
    out[k] = v;
  }
  return out;
}

// The `hooks` block, flattened into rows a table can render. The shape is
// `{ EventName: [{ matcher, hooks: [{ type, command }] }] }`, and a viewer wants
// one row per command with the event and matcher beside it.
function flattenHooks(json, scope) {
  const rows = [];
  const hooks = json && typeof json === 'object' ? json.hooks : null;
  if (!hooks || typeof hooks !== 'object') return rows;
  for (const [event, matchers] of Object.entries(hooks)) {
    for (const group of Array.isArray(matchers) ? matchers : []) {
      const matcher = group && typeof group.matcher === 'string' ? group.matcher : null;
      for (const h of (group && Array.isArray(group.hooks) ? group.hooks : [])) {
        rows.push({
          event: clip(event, 64),
          matcher: clip(matcher, 200),
          type: clip(h && h.type, 32) || 'command',
          // The command itself is the point of the row, it is what runs, so it
          // stays readable; a secret written into it does not (redactCommandLine).
          command: clip(redactCommandLine(h && (h.command || h.url)), MAX_STR),
          scope,
        });
        if (rows.length >= MAX_ENTRIES) return rows;
      }
    }
  }
  return rows;
}

// One directory of markdown definitions (agents/, commands/). `SKILL.md` lives a
// level deeper, so skills get their own walk below.
async function readDefs(dir, scope) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return { entries: [], truncated: false }; }
  const entries = [];
  let truncated = false;
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
    const file = path.join(dir, name);
    let fm = {};
    try { fm = frontmatter(await readHead(file)); } catch { continue; }
    entries.push({
      name: clip(fm.name || name.replace(/\.md$/, ''), 120),
      description: clip(fm.description),
      model: clip(fm.model, 64),
      tools: clip(fm.tools),
      scope,
    });
  }
  return { entries, truncated };
}

async function readSkills(dir, scope) {
  let names;
  try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return { entries: [], truncated: false }; }
  const entries = [];
  let truncated = false;
  for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
    let fm = {};
    try { fm = frontmatter(await readHead(path.join(dir, e.name, 'SKILL.md'))); } catch { continue; }
    entries.push({ name: clip(fm.name || e.name, 120), description: clip(fm.description), scope });
  }
  return { entries, truncated };
}

// The whole answer for one machine's Claude config.
//
// `root` is the CLAUDE dir the agent already knows (a transcript root), so no
// path ever comes from the master — the same posture as every other read.
async function readClaudeConfig(root) {
  const userSettings = await readJson(path.join(root, 'settings.json'));
  const localSettings = await readJson(path.join(root, 'settings.local.json'));
  const agents = await readDefs(path.join(root, 'agents'), 'user');
  const commands = await readDefs(path.join(root, 'commands'), 'user');
  const skills = await readSkills(path.join(root, 'skills'), 'user');
  const plugins = await readJson(path.join(root, 'plugins', 'installed_plugins.json'));
  const memory = await (async () => {
    const file = path.join(root, 'CLAUDE.md');
    try {
      const st = await fsp.stat(file);
      return { exists: true, bytes: st.size, mtimeMs: st.mtimeMs };
    } catch { return { exists: false }; }
  })();

  // The precedence chain, weakest first, so a reader sees what overrides what.
  // Only the two Termdeck can reach are listed with contents: managed policy and
  // per-project settings live outside this root, and claiming to know about them
  // would be worse than saying where they are.
  const settings = [
    { scope: 'user', file: path.join(root, 'settings.json'), ...userSettings, json: redactSettings(userSettings.json) },
    { scope: 'local', file: path.join(root, 'settings.local.json'), ...localSettings, json: redactSettings(localSettings.json) },
  ];

  return {
    settings,
    hooks: [...flattenHooks(userSettings.json, 'user'), ...flattenHooks(localSettings.json, 'local')],
    agents: agents.entries,
    agentsTruncated: agents.truncated,
    commands: commands.entries,
    commandsTruncated: commands.truncated,
    skills: skills.entries,
    skillsTruncated: skills.truncated,
    plugins: plugins.exists && plugins.json ? pluginRows(plugins.json, enabledPlugins(userSettings.json, localSettings.json)) : [],
    memory,
  };
}

// `enabledPlugins` from user then local settings, local winning, as Claude Code
// reads them. Null when neither file says anything.
function enabledPlugins(...settings) {
  let out = null;
  for (const json of settings) {
    const map = json && json.enabledPlugins;
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    out = { ...(out || {}), ...map };
  }
  return out;
}

// `installed_plugins.json` is a map of marketplace -> plugin names, or a list;
// both have been seen. Anything else reports nothing rather than guessing.
//
// v2 wraps the map one level deeper and moves the marketplace INTO the key
// (`{version: 2, plugins: {"name@marketplace": [install, ...]}}`). Read as the
// older shape it reported one plugin per install named `name@marketplace` in a
// marketplace called "plugins", which is the literal wrapper key — so the
// version is checked before the shape is guessed at.
//
// `enabled` is the merged `enabledPlugins` map from the settings files, keyed
// `name@marketplace`. Installed is not the same as on: Claude Code keeps a
// switched-off plugin installed with `false` there, and listing it like the
// others said it was in use. A row gets `enabled` only when the map names it.
function pluginRows(json, enabled = null) {
  const rows = [];
  const push = (name, marketplace) => {
    if (rows.length >= MAX_ENTRIES || !name) return;
    const row = { name: clip(String(name), 120), marketplace: clip(marketplace, 120) };
    const key = marketplace ? `${name}@${marketplace}` : String(name);
    if (enabled && Object.prototype.hasOwnProperty.call(enabled, key)) row.enabled = enabled[key] !== false;
    rows.push(row);
  };
  if (json && typeof json === 'object' && !Array.isArray(json) && json.plugins && typeof json.plugins === 'object') {
    for (const key of Object.keys(json.plugins)) {
      const at = key.lastIndexOf('@');
      // A bare key with no `@` is a plugin whose marketplace this file does not
      // say. Splitting on the LAST one leaves a scoped name intact.
      if (at > 0) push(key.slice(0, at), key.slice(at + 1));
      else push(key, null);
    }
    return rows;
  }
  if (Array.isArray(json)) {
    for (const p of json) push(typeof p === 'string' ? p : p && p.name, p && p.marketplace);
    return rows;
  }
  if (json && typeof json === 'object') {
    for (const [marketplace, v] of Object.entries(json)) {
      if (Array.isArray(v)) for (const name of v) push(typeof name === 'string' ? name : name && name.name, marketplace);
      else if (v && typeof v === 'object') for (const name of Object.keys(v)) push(name, marketplace);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The one way the Extensions switches (lib/extensions-*.js) write a config
// file. Each switch is read, edit one key, write back, and three things went
// wrong with doing that by hand in each engine module:
//   * two switches at once each read the same text and the second rename
//     dropped the first edit, so every rewrite of one file waits its turn here
//   * the temp name was pid + Date.now(), which two writes in one millisecond
//     share; it is random now
//   * a CLI writing the same file between our read and our rename lost its
//     write; the file is stat'd again before the rename and the whole
//     read-edit-write runs once more if it moved
// And a config file that is a symlink (dotfiles repos) is written where it
// points, so the link stays a link.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const fileLocks = new Map();

async function lockKey(file) {
  try { return await fsp.realpath(file); } catch { return path.resolve(file); }
}

// Run `fn` with `file` to ourselves (within this process). Waiters queue in
// arrival order; the map holds a key only while someone is in or waiting.
async function withFileLock(file, fn) {
  const key = await lockKey(file);
  const prev = fileLocks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const tail = prev.then(() => mine);
  fileLocks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (fileLocks.get(key) === tail) fileLocks.delete(key);
  }
}

const writeFail = (message, code = 'WRITE_FAILED') => Object.assign(new Error(message), { code });
const sameStat = (a, b) => (!a && !b) || (!!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino);
async function statOrNull(file) {
  try { return await fsp.stat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Read `file`, hand its text (null when it is not there) to `edit`, and write
// what comes back through a temp file beside the real file and a rename. `edit`
// returning null or the same text writes nothing. Returns whether it wrote.
// `mkdir` makes the parent folder for a file that does not exist yet.
async function rewriteFile(file, edit, { mkdir = false, createMode = 0o600 } = {}) {
  const name = path.basename(file);
  return withFileLock(file, async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let target = file;
      try { target = await fsp.realpath(file); } catch (e) {
        if (e.code !== 'ENOENT') throw writeFail(`cannot read ${name}: ${e.code || e.message}`);
      }
      let before;
      let text = null;
      try {
        before = await statOrNull(target);
        if (before) text = await fsp.readFile(target, 'utf8');
      } catch (e) {
        throw writeFail(`cannot read ${name}: ${e.code || e.message}`);
      }
      const next = await edit(text);
      if (next == null || next === text) return false;
      const mode = before ? before.mode & 0o777 : createMode;
      const tmp = `${target}.termdeck-${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        if (!before && mkdir) await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(tmp, next, { encoding: 'utf8', mode, flag: 'wx' });
        try { await fsp.chmod(tmp, mode); } catch {}
        // Someone else wrote it while we were editing: their write wins the
        // read, ours is made again on top of it.
        if (!sameStat(before, await statOrNull(target))) {
          await fsp.unlink(tmp).catch(() => {});
          if (attempt === 0) continue;
          throw writeFail(`${name} kept changing while Termdeck edited it; nothing was written, try again`);
        }
        await fsp.rename(tmp, target);
      } catch (e) {
        await fsp.unlink(tmp).catch(() => {});
        if (e.code === 'WRITE_FAILED') throw e;
        throw writeFail(`could not write ${name}: ${e.code || e.message}`);
      }
      return true;
    }
    return false;
  });
}

// A row's name is clipped for the wire, and a switch must write the name the
// file has, not the clipped one (which would add a new entry). The full name
// rides on the row under a symbol: object spread keeps it, JSON drops it.
const FULL_NAME = Symbol.for('termdeck.extensions.fullName');
function withFullName(row, full) {
  if (typeof full === 'string') row[FULL_NAME] = full;
  return row;
}
const fullName = (row, fallback) => (row && typeof row[FULL_NAME] === 'string' ? row[FULL_NAME] : fallback);

module.exports = {
  rewriteFile,
  withFullName,
  fullName,
  withFileLock,
  readClaudeConfig,
  frontmatter,
  redactSettings,
  flattenHooks,
  pluginRows,
  MAX_ENTRIES,
  // Shared with lib/command-catalog.js, which walks the same kind of tree and
  // must enforce the same caps — two copies of these numbers is how one of them
  // ends up unbounded.
  readHead,
  readJson,
  clip,
  HEAD_BYTES,
  MAX_STR,
};
