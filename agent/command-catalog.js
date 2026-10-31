'use strict';

// What a chat can actually TYPE after a slash, and what each one does.
//
// The engines all know this and none of them will say. Claude Code's
// stream-json init frame carries `slash_commands` as a bare array of NAMES —
// its own command objects hold a description and an argument hint, and neither
// is serialized. Codex has no slash surface over app-server at all. Grok has
// none either. So a palette built from the wire can only ever render `/name`.
//
// All three do write the answer to disk, in the YAML frontmatter of the same
// two shapes: a `commands/*.md` file, or a `skills/<name>/SKILL.md`. This walks
// those directories and returns the descriptions, which is the one source that
// works uniformly, needs no CLI to be running, and reaches a PROJECT's own
// commands — the ones a name alone explains least.
//
// It answers a QUESTION, not bytes (lib/index-head.js's rule, and
// lib/machine-config.js's): a browser fetching each of these files over the
// tunnel would spend dozens of round trips to fill one dropdown.
//
// Shipped to agents by name (AGENT_FILES in master.js), so this module may only
// require SIBLINGS in lib/. It requires one: machine-config.js, for the
// frontmatter parser and the caps. Two copies of either is how one of them
// stays broken.

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const { frontmatter, readHead, readJson, clip, MAX_ENTRIES } = require('./machine-config');

// One budget for the whole catalog rather than one per directory. A palette
// shows ten rows at a time; a machine with three hundred skills is answered
// honestly with a hundred of them and `truncated`.
const MAX_COMMANDS = MAX_ENTRIES;
// `commands/` may nest to namespace (`git/commit.md` -> `/git:commit`). Three
// levels is deeper than anyone nests and keeps a symlink loop finite.
const MAX_DEPTH = 3;
// Installed plugins, not the whole plugin tree: each one is walked at its own
// root, and an unbounded walk of ~/.claude/plugins would read a vendored
// node_modules — and every version of every plugin ever cached, most of them
// uninstalled.
const MAX_PLUGINS = 40;

// Third guard, behind "not under commands/ or skills/" and the `.md` extension
// gate. Grok's OIDC token and Claude's OAuth token must never be opened by this
// module however a future caller rearranges the roots above it. Mirrors
// DENYLIST_BASENAMES in agent/capabilities.js.
const DENY_BASENAMES = new Set(['auth.json', '.credentials.json']);

// A skill or command that says it is not user-invocable is not in the palette.
// Absent means yes — that is every engine's default.
const invocable = (fm) => String(fm['user-invocable'] || '').trim().toLowerCase() !== 'false';

async function readFrontmatter(file) {
  if (DENY_BASENAMES.has(path.basename(file))) return null;
  try {
    return frontmatter(await readHead(file));
  } catch {
    return null;
  }
}

// Precedence is the order sources are visited, so the first writer of a name
// wins and later ones are dropped. Project beats user beats plugin, which is
// what every engine's own resolver does.
function add(state, entry) {
  if (state.byName.has(entry.name)) return;
  if (state.byName.size >= MAX_COMMANDS) { state.truncated = true; return; }
  state.byName.set(entry.name, entry);
}

// One `commands/` tree. Nested directories namespace the command, and the
// engines disagree about the separator and have changed their minds about it,
// so the nested name ships with the bare stem as an ALIAS and whichever one the
// CLI actually advertises is the one that matches. One row, several keys.
async function readCommands(dir, scope, state, depth = 0, prefix = '') {
  let names;
  try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) await readCommands(path.join(dir, e.name), scope, state, depth + 1, prefix ? `${prefix}:${e.name}` : e.name);
      continue;
    }
    if (!e.name.endsWith('.md')) continue;
    const file = path.join(dir, e.name);
    const fm = await readFrontmatter(file);
    if (!fm || !invocable(fm)) continue;
    const stem = clip(fm.name || e.name.replace(/\.md$/, ''), 120);
    add(state, {
      name: prefix ? `${prefix}:${stem}` : stem,
      aliases: prefix ? [stem] : [],
      description: clip(fm.description),
      argumentHint: clip(fm['argument-hint'], 120),
      scope,
      source: 'command',
      file,
    });
  }
}

// One `skills/` directory: each child holds a SKILL.md. A directory without one
// is not a skill, and a dotted one (`.system`) is scanned by name where it is
// wanted rather than swept up here.
async function readSkills(dir, scope, state) {
  let names;
  try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const file = path.join(dir, e.name, 'SKILL.md');
    const fm = await readFrontmatter(file);
    if (!fm || !invocable(fm)) continue;
    add(state, {
      name: clip(fm.name || e.name, 120),
      aliases: [],
      description: clip(fm.description || fm['when-to-use']),
      argumentHint: clip(fm['argument-hint'], 120),
      scope,
      source: 'skill',
      file,
    });
  }
}

// A pair of `commands/` + `skills/` under one parent, which is how every tier of
// every engine is laid out.
async function readPair(parent, scope, state) {
  await readCommands(path.join(parent, 'commands'), scope, state);
  await readSkills(path.join(parent, 'skills'), scope, state);
}

// Is `child` at or below `dir`? Used for a project-scoped plugin, which is only
// installed for the tree it was installed under.
function within(dir, child) {
  if (!dir || !child) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The roots of the plugins that are actually INSTALLED, from the file the CLI
// itself writes.
//
// `plugins/marketplaces/<name>` is the CATALOG — the marketplace checkout, which
// holds every plugin on offer under `plugins/<name>/` and no commands at its own
// top level. What a chat can type lives at the `installPath` of each installed
// plugin (`plugins/cache/<marketplace>/<plugin>/<version>`), and only that file
// says which of the cached versions is the live one. Walking the marketplace
// root instead found nothing at all, which is why plugin commands and skills
// were missing from the palette entirely.
//
// Two shapes have shipped. v2 is `{version, plugins: {"<name>@<market>": [inst]}}`
// with a real installPath per install; v1 named plugins without one, and for that
// the marketplace layout below is still the best guess available.
async function pluginRoots(claudeDir, cwd) {
  const dir = path.join(claudeDir, 'plugins');
  const roots = [];
  const file = await readJson(path.join(dir, 'installed_plugins.json'));
  const map = file.json && typeof file.json === 'object' && !Array.isArray(file.json) ? file.json.plugins : null;
  if (map && typeof map === 'object') {
    for (const key of Object.keys(map).sort()) {
      const installs = Array.isArray(map[key]) ? map[key] : [map[key]];
      for (const inst of installs) {
        if (!inst || typeof inst !== 'object' || typeof inst.installPath !== 'string' || !inst.installPath) continue;
        // An install carrying a projectPath belongs to that tree, and offering
        // its commands to every other chat on the machine would be a list the
        // engine will not honour. Gated on the PATH being there rather than on
        // `scope`, which has been seen as both `project` and `local` for the
        // same meaning — a scope name this does not recognise would otherwise
        // leak one project's plugins into every other chat.
        if (typeof inst.projectPath === 'string' && inst.projectPath && !within(inst.projectPath, cwd)) continue;
        roots.push(inst.installPath);
      }
    }
  }
  if (roots.length) return roots;

  const market = path.join(dir, 'marketplaces');
  let names;
  try { names = await fsp.readdir(market, { withFileTypes: true }); } catch { return roots; }
  for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    roots.push(path.join(market, e.name));
  }
  return roots;
}

async function readPlugins(claudeDir, state, cwd) {
  const roots = await pluginRoots(claudeDir, cwd);
  let seen = 0;
  for (const root of roots) {
    if (seen >= MAX_PLUGINS) { state.truncated = true; return; }
    seen += 1;
    await readPair(root, 'plugin', state);
    await readPair(path.join(root, '.claude'), 'plugin', state);
  }
}

// The directories to walk, in precedence order, for one engine.
//
// GROK'S ROOTS ARE READ WITHOUT `confined()`, deliberately. ~/.grok is not one
// of the agent's confinement roots — only ~/.grok/sessions is — because
// ~/.grok/auth.json is a bare OIDC token sitting at that directory's top level.
// Widening the root to read two fixed subdirectories would also authorise the
// master to NAME any path under ~/.grok in every other confined frame, which is
// a strictly larger grant than the one wanted. These paths carry no request
// input at all: they are joined here from the agent's own constant, they are
// extension-gated, and readFrontmatter refuses the token by basename anyway.
function sourcesFor(engine, dirs) {
  const { cwd, claudeDir, codexHome, grokDir } = dirs;
  const out = [];
  const project = (rel, scope = 'project') => { if (cwd) out.push({ parent: path.join(cwd, rel), scope }); };

  if (engine === 'codex') {
    project('.codex');
    project('.agents');
    out.push({ parent: codexHome, scope: 'user' });
    // Codex ships six of its own under skills/.system — they are as invocable
    // as any other and a user who sees /review-agent in the CLI expects it here.
    out.push({ parent: path.join(codexHome, 'skills'), scope: 'user', skillsOnly: '.system' });
    return out;
  }

  if (engine === 'grok') {
    // Grok reads the Claude and Cursor trees for compatibility and walks every
    // directory between cwd and the repo root. Two tiers plus the Claude compat
    // pair is most of that list; the rest is a parity project, not a palette.
    project('.grok');
    project('.claude');
    project('.agents');
    out.push({ parent: grokDir, scope: 'user' });
    out.push({ parent: claudeDir, scope: 'user' });
    return out;
  }

  project('.claude');
  out.push({ parent: claudeDir, scope: 'user' });
  out.push({ plugins: claudeDir });
  return out;
}

// Codex on the native harness: its skills come from the shared app-server's
// skills/list, which is the set Codex itself resolves (plugin skills, admin and
// system tiers, and what [[skills.config]] turned off), where the walk above can
// only guess. `commands/` has no RPC and is still walked.
//
// Each listed SKILL.md is still opened for its frontmatter, through the same
// guarded reader: skills/list does not carry `argument-hint`, nor
// `user-invocable: false`, which keeps a skill out of the palette.
const SKILL_TIER = { repo: 0, user: 1, admin: 1, system: 2 };

async function readCodexNative(dirs, codexRpc, state) {
  const res = await codexRpc('skills/list', { cwds: [dirs.cwd || os.homedir()] }, { timeoutMs: 15_000 });
  if (!res || !Array.isArray(res.data)) throw new Error('skills/list gave no list');
  const skills = [];
  for (const group of res.data) {
    for (const s of (group && Array.isArray(group.skills) ? group.skills : [])) {
      if (!s || typeof s.name !== 'string' || typeof s.path !== 'string' || s.enabled === false) continue;
      skills.push(s);
    }
  }
  // Project beats user beats plugin, as the walk orders it: a project's commands
  // and skills, then the user's commands and skills, then the rest.
  const tier = (s) => (s.pluginId ? 3 : SKILL_TIER[s.scope] ?? 1);
  skills.sort((a, b) => tier(a) - tier(b));
  if (dirs.cwd) {
    await readCommands(path.join(dirs.cwd, '.codex', 'commands'), 'project', state);
    await readCommands(path.join(dirs.cwd, '.agents', 'commands'), 'project', state);
  }
  await addSkills(skills.filter((s) => tier(s) === 0), state);
  await readCommands(path.join(dirs.codexHome, 'commands'), 'user', state);
  await addSkills(skills.filter((s) => tier(s) > 0), state);
}

async function addSkills(skills, state) {
  for (const s of skills) {
    const fm = s.path.endsWith('.md') ? (await readFrontmatter(s.path)) || {} : {};
    if (!invocable(fm)) continue;
    const iface = s.interface && typeof s.interface === 'object' ? s.interface : {};
    add(state, {
      name: clip(s.name, 120),
      aliases: [],
      description: clip(s.description || iface.shortDescription || fm.description),
      argumentHint: clip(fm['argument-hint'], 120),
      scope: s.pluginId ? 'plugin' : s.scope === 'repo' ? 'project' : 'user',
      source: 'skill',
      file: s.path,
    });
  }
}

// `cwd` is the session's own project directory, resolved by the agent from the
// session's transcript head — never a path the master named. Everything else
// defaults to this machine's engine homes.
//
// `opts.codexRpc(method, params, { timeoutMs })` is the native harness's shared
// client (agent/capabilities.js). A Codex catalog that cannot be read from it
// falls back to the walk: a palette with guessed rows beats an empty one.
async function readCatalog(opts = {}) {
  const engine = ['claude', 'codex', 'grok'].includes(opts.engine) ? opts.engine : 'claude';
  const home = os.homedir();
  const dirs = {
    cwd: typeof opts.cwd === 'string' && opts.cwd ? opts.cwd : null,
    claudeDir: opts.claudeDir || process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    codexHome: opts.codexHome || process.env.CODEX_HOME || path.join(home, '.codex'),
    grokDir: opts.grokDir || process.env.GROK_HOME || path.join(home, '.grok'),
  };

  if (engine === 'codex' && typeof opts.codexRpc === 'function') {
    const state = { byName: new Map(), truncated: false };
    try {
      await readCodexNative(dirs, opts.codexRpc, state);
      return { entries: [...state.byName.values()], truncated: state.truncated, root: dirs.cwd, engine };
    } catch { /* the walk below */ }
  }

  const state = { byName: new Map(), truncated: false };
  for (const src of sourcesFor(engine, dirs)) {
    if (src.plugins) { await readPlugins(src.plugins, state, dirs.cwd); continue; }
    if (src.skillsOnly) { await readSkills(path.join(src.parent, src.skillsOnly), src.scope, state); continue; }
    await readPair(src.parent, src.scope, state);
  }

  return { entries: [...state.byName.values()], truncated: state.truncated, root: dirs.cwd, engine };
}

module.exports = { readCatalog, MAX_COMMANDS };
