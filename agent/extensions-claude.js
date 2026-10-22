'use strict';

// Claude Code's MCP servers, plugins and skills on one machine, read and
// switched on and off where the files live (features/01-extensions, phases 1
// and 3). lib/extensions.js is the dispatcher; this file knows Claude.
//
// Where each thing lives, and what a switch writes:
//
//   MCP, user scope     ~/.claude.json mcpServers
//   MCP, local scope    ~/.claude.json projects[cwd].mcpServers
//   MCP, project scope  <cwd>/.mcp.json, approved per project in settings
//   MCP, plugin         the plugin's own .mcp.json or plugin.json
//   MCP, managed        managed-mcp.json in the OS policy dir; never switched
//
//   off for user, local servers   name in ~/.claude.json projects[cwd].disabledMcpServers
//   off for .mcp.json servers     disabledMcpjsonServers / enabledMcpjsonServers
//                                 in <cwd>/.claude/settings.local.json
//   plugins                       `claude plugin enable|disable` (the CLI owns
//                                 enabledPlugins and its scopes)
//   skills                        skillOverrides[name] = "off" in ~/.claude/settings.json
//                                 (user) or <cwd>/.claude/settings.local.json (project)
//
// Every write re-reads the file, refuses one that does not parse, changes one
// key, and lands through a temp file and a rename (machine-config rewriteFile:
// one writer per file at a time, symlinks followed). Removing the last name from
// a list this module added removes the key too, so switching something off and
// on again leaves the file as it was.
//
// Shipped to agents by name (AGENT_FILES in master.js): siblings and builtins only.

const fsp = require('fs/promises');
const path = require('path');
const { frontmatter, readHead, clip, MAX_ENTRIES, rewriteFile, withFullName, fullName } = require('./machine-config');
const { redactCommandLine } = require('./mcp-config');
const { rawJson, redactUrl, redactDetail } = require('./extensions-redact');
const jsonEdit = require('./json-edit');

const MAX_JSON_BYTES = 64 * 1024 * 1024; // ~/.claude.json grows with history; it is still one file
const MAX_SMALL_JSON = 1024 * 1024;
const MAX_TARGET = 300;
const CLI_TIMEOUT_MS = 20_000;
const HEALTH_TIMEOUT_MS = 110_000;
const PLUGIN_ID = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;
const OVERRIDES = new Set(['on', 'name-only', 'user-invocable-only', 'off']);

const fail = (message, code) => Object.assign(new Error(message), { code });
const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
// The CLI records a project path the way the shell spelled it; Windows paths
// compare without case.
const pathKey = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
const findProject = (projects, p) => (typeof p === 'string' ? (projects || []).find((x) => pathKey(x) === pathKey(p)) || null : null);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

async function readJsonFile(file, max = MAX_SMALL_JSON) {
  let st;
  try { st = await fsp.stat(file); } catch { return { exists: false, json: null }; }
  if (!st.isFile() || st.size > max) return { exists: true, json: null, error: 'too large' };
  try {
    return { exists: true, json: JSON.parse(await fsp.readFile(file, 'utf8')) };
  } catch (e) {
    return { exists: true, json: null, error: clip(e.message, 200) };
  }
}

// Where Claude Code reads machine-wide policy from. Read only; a managed server
// is the administrator's, and the row says so.
function managedMcpPath() {
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-mcp.json';
  if (process.platform === 'win32') return path.join(process.env.ProgramData || 'C:\\ProgramData', 'ClaudeCode', 'managed-mcp.json');
  return '/etc/claude-code/managed-mcp.json';
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

function mcpRow(name, cfg, extra) {
  const c = obj(cfg) || {};
  const transport = ['stdio', 'http', 'sse', 'ws'].includes(c.type) ? c.type : c.url ? 'http' : 'stdio';
  const target = c.url
    ? redactUrl(c.url)
    : redactCommandLine([c.command, ...(Array.isArray(c.args) ? c.args : [])].filter((x) => typeof x === 'string').join(' '));
  const row = {
    name: clip(String(name), 160),
    transport,
    target: String(target).slice(0, MAX_TARGET),
    hasEnv: !!(obj(c.env) && Object.keys(c.env).length),
    hasHeaders: !!((obj(c.headers) && Object.keys(c.headers).length) || c.headersHelper),
    hasOauth: !!c.oauth,
    ...extra,
    raw: rawJson(c, String(name)),
  };
  if (typeof c.timeout === 'number') row.timeoutMs = c.timeout;
  if (typeof c.alwaysLoad === 'boolean') row.alwaysLoad = c.alwaysLoad;
  return withFullName(row, String(name));
}

// The approval state of a project's .mcp.json servers, merged the way Claude
// reads it: user settings, then the project's shared settings, then its local
// ones, then the project's own entry in ~/.claude.json (where older CLIs kept it).
function mcpjsonState(name, layers) {
  let enableAll = false;
  let enabled = false;
  let disabled = false;
  for (const s of layers) {
    if (!s) continue;
    if (s.enableAllProjectMcpServers === true) enableAll = true;
    if (names(s.enabledMcpjsonServers).includes(name)) enabled = true;
    if (names(s.disabledMcpjsonServers).includes(name)) disabled = true;
  }
  if (disabled) return { enabled: false, enabledBy: 'disabledMcpjsonServers' };
  if (enabled || enableAll) return { enabled: true, enabledBy: 'enabledMcpjsonServers' };
  return { enabled: false, enabledBy: 'pending', pending: true };
}

async function projectSettings(cwd) {
  const shared = await readJsonFile(path.join(cwd, '.claude', 'settings.json'));
  const local = await readJsonFile(path.join(cwd, '.claude', 'settings.local.json'));
  return { shared: obj(shared.json), local: obj(local.json) };
}

async function listMcp(ctx, projects, plugins, cfg) {
  const j = cfg.claudeJson || {};
  const userSettings = cfg.userSettings;
  const projEntry = (p) => obj(j.projects && j.projects[p]) || {};
  const disabledIn = (p) => names(projEntry(p).disabledMcpServers);
  const rows = [];
  let truncated = false;
  const push = (r) => { if (rows.length >= MAX_ENTRIES) { truncated = true; return; } rows.push(r); };

  // One row for a server whose state is per project: `enabledIn` maps each
  // Termdeck project to its state there, and `enabled` is "on everywhere".
  const perProject = (name, aliases = [name]) => {
    const enabledIn = {};
    for (const p of projects) enabledIn[p] = !disabledIn(p).some((n) => aliases.includes(n));
    const vals = Object.values(enabledIn);
    return { enabledIn, enabled: vals.every(Boolean), enabledBy: vals.every(Boolean) ? 'config' : 'disabledMcpServers' };
  };

  for (const [name, c] of Object.entries(obj(j.mcpServers) || {})) {
    push(mcpRow(name, c, { scope: 'user', sourceFile: '~/.claude.json', toggle: 'mcp', ...perProject(name) }));
  }
  for (const p of projects) {
    const entry = projEntry(p);
    for (const [name, c] of Object.entries(obj(entry.mcpServers) || {})) {
      const off = disabledIn(p).includes(name);
      push(mcpRow(name, c, { scope: 'local', sourceFile: '~/.claude.json', project: p, toggle: 'mcp', enabled: !off, enabledBy: off ? 'disabledMcpServers' : 'config' }));
    }
    const dot = await readJsonFile(path.join(p, '.mcp.json'));
    const servers = obj(dot.json && dot.json.mcpServers) || {};
    if (Object.keys(servers).length) {
      const ps = await projectSettings(p);
      for (const [name, c] of Object.entries(servers)) {
        let state = mcpjsonState(name, [userSettings, ps.shared, ps.local, entry]);
        if (disabledIn(p).includes(name)) state = { enabled: false, enabledBy: 'disabledMcpServers' };
        push(mcpRow(name, c, { scope: 'project', sourceFile: '.mcp.json', project: p, toggle: 'mcp', ...state }));
      }
    }
  }
  for (const pl of plugins) {
    for (const [server, c] of Object.entries(pl._mcp || {})) {
      const short = pl.name || pl.id;
      const full = `plugin:${short}:${server}`;
      const state = perProject(full, [full, server]);
      push(mcpRow(server, c, {
        scope: 'plugin', sourceFile: `${short} plugin`, pluginId: pl.id, toggle: 'plugin',
        enabledIn: Object.fromEntries(Object.entries(state.enabledIn).map(([k, v]) => [k, v && pl.enabled])),
        enabled: state.enabled && pl.enabled,
        enabledBy: pl.enabled ? state.enabledBy : 'enabledPlugins',
        displayName: full,
      }));
    }
  }
  const managed = await readJsonFile(ctx.managedMcpPath || managedMcpPath());
  for (const [name, c] of Object.entries(obj(managed.json && managed.json.mcpServers) || {})) {
    push(mcpRow(name, c, { scope: 'managed', sourceFile: 'managed-mcp.json', toggle: null, enabled: true, enabledBy: 'config' }));
  }
  return { rows, truncated };
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

async function countDir(dir, pred) {
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    return ents.filter(pred).length;
  } catch { return 0; }
}

// The plugin's MCP servers: plugin.json `mcpServers` (an object, or a path to a
// JSON file), else `.mcp.json` at its root, either `{ mcpServers: {...} }` or
// the bare map.
async function pluginMcp(installPath, manifest) {
  const fromFile = async (file) => {
    const r = await readJsonFile(file);
    const j = obj(r.json);
    if (!j) return null;
    return obj(j.mcpServers) || j;
  };
  if (manifest && obj(manifest.mcpServers)) return manifest.mcpServers;
  if (manifest && typeof manifest.mcpServers === 'string') {
    const f = path.resolve(installPath, manifest.mcpServers);
    if (f.startsWith(path.resolve(installPath) + path.sep)) return (await fromFile(f)) || {};
  }
  return (await fromFile(path.join(installPath, '.mcp.json'))) || {};
}

async function pluginDetail(installPath) {
  if (!installPath) return { manifest: null, components: null, mcp: {} };
  const m = await readJsonFile(path.join(installPath, '.claude-plugin', 'plugin.json'));
  const man = obj(m.json) || {};
  const hooks = await readJsonFile(path.join(installPath, 'hooks', 'hooks.json'));
  const hookMap = obj(hooks.json && (hooks.json.hooks || hooks.json));
  const lsp = await readJsonFile(path.join(installPath, '.lsp.json'));
  const mcp = await pluginMcp(installPath, man);
  const author = obj(man.author) ? man.author.name : man.author;
  return {
    manifest: {
      displayName: clip(man.displayName || man.name, 120),
      description: clip(man.description),
      author: clip(typeof author === 'string' ? author : null, 120),
      homepage: clip(typeof man.homepage === 'string' ? redactUrl(man.homepage) : null, 300),
      repository: clip(typeof man.repository === 'string' ? redactUrl(man.repository) : obj(man.repository) && typeof man.repository.url === 'string' ? redactUrl(man.repository.url) : null, 300),
      license: clip(man.license, 60),
      keywords: Array.isArray(man.keywords) ? man.keywords.filter((k) => typeof k === 'string').slice(0, 20).map((k) => k.slice(0, 40)) : [],
    },
    components: {
      skills: await countDir(path.join(installPath, 'skills'), (e) => e.isDirectory()),
      commands: await countDir(path.join(installPath, 'commands'), (e) => e.isFile() && e.name.endsWith('.md')),
      agents: await countDir(path.join(installPath, 'agents'), (e) => e.isFile() && e.name.endsWith('.md')),
      hooks: hookMap ? Object.keys(hookMap).length : 0,
      mcpServers: Object.keys(mcp).length,
      lspServers: obj(lsp.json) ? Object.keys(lsp.json).length : 0,
    },
    mcp,
    rawManifest: man,
  };
}

function scopeFile(scope) {
  if (scope === 'local') return '.claude/settings.local.json';
  if (scope === 'project') return '.claude/settings.json';
  if (scope === 'user') return '~/.claude/settings.json';
  return null;
}

// The CLI's own list when it answers, the files when it does not (an old CLI,
// or none on PATH while a turn binary is configured elsewhere).
async function pluginSource(ctx, cfg) {
  if (ctx.exe) {
    const r = await ctx.run(ctx.exe, ['plugin', 'list', '--json'], { timeout: CLI_TIMEOUT_MS, cwd: ctx.home });
    const list = parseJsonOut(r.stdout);
    if (r.code === 0 && Array.isArray(list)) return { via: 'cli', list };
  }
  const installed = await readJsonFile(path.join(ctx.claudeDir, 'plugins', 'installed_plugins.json'));
  const map = obj(installed.json && installed.json.plugins) || {};
  const enabled = { ...(obj(cfg.userSettings && cfg.userSettings.enabledPlugins) || {}), ...(obj(cfg.userLocal && cfg.userLocal.enabledPlugins) || {}) };
  const list = [];
  for (const [id, installs] of Object.entries(map)) {
    for (const inst of Array.isArray(installs) ? installs : []) {
      list.push({ id, version: inst.version, scope: inst.scope || 'user', enabled: enabled[id] !== false && has(enabled, id), installPath: inst.installPath, installedAt: inst.installedAt, lastUpdated: inst.lastUpdated, projectPath: inst.projectPath });
    }
  }
  return { via: 'files', list };
}

// `claude plugin list` answers for the folder it runs in, which is home, so a
// plugin installed for one project reads as off there. Its state is that
// project's own enabledPlugins: local over project over user, as Claude reads it.
async function projectPluginState(ctx, cfg, projectPath, id) {
  const read = async (f) => obj((await readJsonFile(path.join(projectPath, '.claude', f))).json) || {};
  const [proj, local] = await Promise.all([read('settings.json'), read('settings.local.json')]);
  for (const s of [local, proj, cfg.userLocal, cfg.userSettings]) {
    const map = obj(s && s.enabledPlugins);
    if (has(map, id)) return map[id] === true;
  }
  return null;
}

async function listPlugins(ctx, cfg, projects) {
  const src = await pluginSource(ctx, cfg);
  const rows = [];
  let truncated = false;
  for (const p of src.list) {
    if (!p || typeof p.id !== 'string') continue;
    if (rows.length >= MAX_ENTRIES) { truncated = true; break; }
    const at = p.id.lastIndexOf('@');
    const name = at > 0 ? p.id.slice(0, at) : p.id;
    const marketplace = at > 0 ? p.id.slice(at + 1) : null;
    const installPath = typeof p.installPath === 'string' ? p.installPath : null;
    const d = await pluginDetail(installPath);
    const mcp = Object.keys(obj(p.mcpServers) || {}).length ? p.mcpServers : d.mcp;
    if (d.components) d.components.mcpServers = Object.keys(mcp || {}).length;
    const scope = clip(p.scope, 20) || 'user';
    const inProject = (scope === 'project' || scope === 'local') && typeof p.projectPath === 'string';
    const added = inProject ? findProject(projects, p.projectPath) : null;
    let enabled = !!p.enabled;
    if (inProject) {
      const st = await projectPluginState(ctx, cfg, p.projectPath, p.id);
      if (st !== null) enabled = st;
    }
    let toggle = ['user', 'project', 'local'].includes(scope) ? 'plugin' : null;
    // A plugin for a folder that is not a Termdeck project has no switch: the
    // agent writes only inside added projects.
    if (inProject && !added) toggle = null;
    rows.push(withFullName({
      id: clip(p.id, 200),
      name: clip(name, 120),
      marketplace: clip(marketplace, 120),
      version: clip(p.version, 80),
      scope,
      project: added || (typeof p.projectPath === 'string' ? p.projectPath : undefined),
      enabled,
      enabledBy: scopeFile(scope) || scope,
      // `synced` plugins are the account's, delivered by the CLI; it has no
      // switch for them, so neither does the row.
      toggle,
      noSwitch: inProject && !added ? 'not-added' : undefined,
      installPath,
      installedAt: clip(p.installedAt, 40),
      lastUpdated: clip(p.lastUpdated, 40),
      manifest: d.manifest,
      components: d.components,
      raw: rawJson({ install: { ...p, mcpServers: undefined }, manifest: d.rawManifest || null }),
      _mcp: mcp || {},
    }, p.id));
  }
  return { rows, truncated, via: src.via };
}

async function listMarketplaces(ctx) {
  if (ctx.exe) {
    const r = await ctx.run(ctx.exe, ['plugin', 'marketplace', 'list', '--json'], { timeout: CLI_TIMEOUT_MS, cwd: ctx.home });
    const list = parseJsonOut(r.stdout);
    if (r.code === 0 && Array.isArray(list)) {
      return list.slice(0, MAX_ENTRIES).filter((m) => m && typeof m.name === 'string').map((m) => ({
        name: clip(m.name, 120), source: clip(m.source, 40), repo: clip(typeof m.repo === 'string' ? m.repo : typeof m.url === 'string' ? redactUrl(m.url) : null, 300), installLocation: clip(m.installLocation, 400),
      }));
    }
  }
  const known = await readJsonFile(path.join(ctx.claudeDir, 'plugins', 'known_marketplaces.json'));
  return Object.entries(obj(known.json) || {}).slice(0, MAX_ENTRIES).map(([name, m]) => {
    const s = obj(m && m.source) || {};
    return { name: clip(name, 120), source: clip(s.source, 40), repo: clip(s.repo || (s.url ? redactUrl(s.url) : null), 300), installLocation: clip(m && m.installLocation, 400) };
  });
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const bool = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);

function skillRow(dirName, fm, file, extra) {
  return withFullName({
    name: clip(fm.name || dirName, 120),
    path: file,
    description: clip(fm.description),
    whenToUse: clip(fm.when_to_use || fm.whenToUse),
    argumentHint: clip(fm['argument-hint'] || fm.argumentHint, 120),
    userInvocable: bool(fm['user-invocable']),
    disableModelInvocation: bool(fm['disable-model-invocation']),
    allowedTools: clip(fm['allowed-tools'] || fm.allowedTools),
    model: clip(fm.model, 64),
    effort: clip(fm.effort, 32),
    ...extra,
    raw: rawJson(fm),
  }, String(fm.name || dirName));
}

// Every SKILL.md under `dir`, `depth` levels down at most. A skill is a
// directory with a SKILL.md in it; nested folders group them.
async function walkSkills(dir, depth, visit) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const sub = path.join(dir, e.name);
    const file = path.join(sub, 'SKILL.md');
    let fm = null;
    try { fm = frontmatter(await readHead(file)); } catch { fm = null; }
    if (fm) { if ((await visit(e.name, fm, file)) === false) return; } else if (depth > 1) await walkSkills(sub, depth - 1, visit);
  }
}

function overrideOf(name, layers) {
  let v = null;
  let from = null;
  for (const [label, s] of layers) {
    const map = obj(s && s.skillOverrides);
    if (map && has(map, name) && OVERRIDES.has(map[name])) { v = map[name]; from = label; }
  }
  return { override: v || 'on', overrideFrom: from };
}

async function listSkills(ctx, projects, plugins, cfg) {
  const rows = [];
  let truncated = false;
  const add = (r) => { if (rows.length >= MAX_ENTRIES) { truncated = true; return false; } rows.push(r); return true; };
  const userLayers = [['~/.claude/settings.json', cfg.userSettings]];

  await walkSkills(path.join(ctx.claudeDir, 'skills'), 1, (dir, fm, file) => {
    if (dir === 'synced') return true;
    const o = overrideOf(fm.name || dir, userLayers);
    return add(skillRow(dir, fm, file, { scope: 'user', ...o, enabled: o.override !== 'off', toggle: 'skill' }));
  });
  // Skills the account syncs down (claude.ai): <skills>/synced/<bucket>/<name>.
  await walkSkills(path.join(ctx.claudeDir, 'skills', 'synced'), 2, (dir, fm, file) => {
    const o = overrideOf(fm.name || dir, userLayers);
    return add(skillRow(dir, fm, file, { scope: 'synced', ...o, enabled: o.override !== 'off', toggle: 'skill' }));
  });
  for (const p of projects) {
    const ps = await projectSettings(p);
    const layers = [...userLayers, ['.claude/settings.json', ps.shared], ['.claude/settings.local.json', ps.local]];
    await walkSkills(path.join(p, '.claude', 'skills'), 3, (dir, fm, file) => {
      const o = overrideOf(fm.name || dir, layers);
      return add(skillRow(dir, fm, file, { scope: 'project', project: p, ...o, enabled: o.override !== 'off', toggle: 'skill' }));
    });
  }
  for (const pl of plugins) {
    if (!pl.installPath) continue;
    await walkSkills(path.join(pl.installPath, 'skills'), 1, (dir, fm, file) => add(skillRow(dir, fm, file, {
      scope: 'plugin', pluginId: pl.id, override: 'on', overrideFrom: null, enabled: pl.enabled, toggle: 'plugin',
    })));
  }
  return { rows, truncated };
}

// ---------------------------------------------------------------------------
// The whole list
// ---------------------------------------------------------------------------

function parseJsonOut(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch {} }
  }
  return null;
}

async function readCfg(ctx) {
  const cj = await readJsonFile(ctx.claudeJson, MAX_JSON_BYTES);
  const us = await readJsonFile(path.join(ctx.claudeDir, 'settings.json'));
  const ul = await readJsonFile(path.join(ctx.claudeDir, 'settings.local.json'));
  return { claudeJson: obj(cj.json), userSettings: obj(us.json), userLocal: obj(ul.json) };
}

async function list(ctx, projects) {
  const cfg = await readCfg(ctx);
  const plugins = await listPlugins(ctx, cfg, projects);
  const mcp = await listMcp(ctx, projects, plugins.rows, cfg);
  const skills = await listSkills(ctx, projects, plugins.rows, cfg);
  const marketplaces = await listMarketplaces(ctx);
  return {
    mcp: mcp.rows,
    plugins: plugins.rows.map(({ _mcp, ...r }) => r),
    skills: skills.rows,
    marketplaces,
    truncated: { mcp: mcp.truncated, plugins: plugins.truncated, skills: skills.truncated },
  };
}

// ---------------------------------------------------------------------------
// Health: `claude mcp list`, run in one project. Exit status never reflects
// health and there is no --json, so the text is the contract.
// ---------------------------------------------------------------------------

const STATUS = [
  [/tools fetch failed/i, 'failed'],
  [/needs authentication|needs auth|requires authentication/i, 'needs-auth'],
  [/pending approval/i, 'pending-approval'],
  [/disabled/i, 'disabled'],
  [/failed to connect|failed|error/i, 'failed'],
  [/connected/i, 'connected'],
];

// One line per server: `<name>: <target> - <glyph> <status>`. The name may hold
// colons (`plugin:x:y`) but never ": ", and the status is after the LAST " - ".
// An indented line after one (`  Issue: ...`) is that server's detail.
function parseMcpList(text) {
  const servers = [];
  let last = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/^\s/.test(raw) && last) { last.detail = redactDetail(`${last.detail ? `${last.detail} ` : ''}${raw.trim()}`, 400); continue; }
    const m = /^(.+?): (.*) - (.+)$/.exec(raw);
    if (!m) continue;
    const statusText = m[3].replace(/^[^\p{L}]+/u, '').trim();
    let status = 'unknown';
    for (const [re, s] of STATUS) if (re.test(statusText)) { status = s; break; }
    const detail = /tools fetch failed|failed to connect|needs auth/i.test(statusText) ? redactDetail(statusText, 400) : null;
    last = { name: clip(m[1], 200), status, statusText: redactDetail(statusText, 200), detail };
    servers.push(last);
  }
  return servers;
}

async function health(ctx, projects, project) {
  const cwd = project && projects.includes(project) ? project : projects[0] || ctx.home;
  const r = await ctx.run(ctx.exe, ['mcp', 'list'], { timeout: HEALTH_TIMEOUT_MS, cwd });
  const servers = parseMcpList(r.stdout).map((s) => {
    const m = /^plugin:([^:]+):(.+)$/.exec(s.name);
    return m ? { ...s, name: m[2], plugin: m[1], displayName: s.name } : s;
  });
  return { project: cwd === ctx.home ? null : cwd, timedOut: !!r.timedOut, servers };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// Rewrite one JSON file through `edit(text, json) -> text`, where the edit is
// made with lib/json-edit.js so every byte outside the changed member stays.
// Refuses a file that does not parse, and never creates anything but the file
// itself (and its .claude dir for a project). Returns whether it wrote.
async function rewriteJson(file, edit, { create = false } = {}) {
  const name = path.basename(file);
  return rewriteFile(file, (text) => {
    if (text == null && !create) throw fail(`cannot read ${name}: ENOENT`, 'WRITE_FAILED');
    const base = text == null ? '{}\n' : text;
    let json;
    try { json = JSON.parse(base); } catch { throw fail(`${name} does not parse; nothing was written`, 'WRITE_FAILED'); }
    if (!obj(json)) throw fail(`${name} is not a JSON object; nothing was written`, 'WRITE_FAILED');
    let next;
    try { next = edit(base, json); } catch (e) { throw fail(`${name}: ${e.message}; nothing was written`, 'WRITE_FAILED'); }
    if (next == null || next === base) return null;
    // The edit must still be JSON, or it does not land.
    try { JSON.parse(next); } catch { throw fail(`the edit to ${name} did not parse; nothing was written`, 'WRITE_FAILED'); }
    return next;
  }, { mkdir: true });
}

// Add or remove `name` in the string list at `keyPath`. A list emptied by a
// removal takes its key with it, unless the key is one Claude writes by default
// (an empty `disabledMcpjsonServers` in a project entry stays as it was).
function listEdit(text, json, keyPath, name, present, { keepEmpty = false } = {}) {
  const cur = jsonEdit.getPath(text, keyPath);
  const list = names(cur);
  if (present === list.includes(name)) return text;
  const next = present ? [...list, name] : list.filter((n) => n !== name);
  if (!next.length && !keepEmpty && !present) return jsonEdit.deletePath(text, keyPath);
  return jsonEdit.setPath(text, keyPath, next);
}

async function toggleMcp(ctx, projects, req, fresh) {
  const row = fresh.mcp.find((r) => r.name === req.name && (req.scope ? r.scope === req.scope : true) && (r.project ? r.project === req.project : true));
  if (!row) throw fail(`no MCP server named ${req.name}`, 'UNKNOWN_ITEM');
  if (row.scope === 'plugin') throw fail(`${req.name} comes from a plugin; switch the plugin instead`, 'NOT_SUPPORTED');
  if (row.scope === 'managed') throw fail(`${req.name} is managed by your administrator`, 'NOT_SUPPORTED');
  req = { ...req, name: fullName(row, req.name) };
  const targets = req.allProjects ? projects : row.project ? [row.project] : req.project ? [req.project] : [];
  if (!targets.length) throw fail('pick a project to switch this server in', 'UNKNOWN_ITEM');
  const applied = [];
  if (row.scope === 'project') {
    const p = row.project;
    const file = path.join(p, '.claude', 'settings.local.json');
    const did = await rewriteJson(file, (t, j) => {
      let x = listEdit(t, j, ['disabledMcpjsonServers'], req.name, !req.enabled);
      x = listEdit(x, JSON.parse(x), ['enabledMcpjsonServers'], req.name, req.enabled);
      return x;
    }, { create: true });
    // The legacy per-project lists in ~/.claude.json would otherwise keep an old
    // "off" in force after the switch said on.
    const did2 = req.enabled ? await rewriteJson(ctx.claudeJson, (t, j) => {
      if (!obj(j.projects && j.projects[p])) return t;
      let x = listEdit(t, j, ['projects', p, 'disabledMcpServers'], req.name, false);
      if (obj(JSON.parse(x).projects[p]) && Array.isArray(JSON.parse(x).projects[p].disabledMcpjsonServers)) {
        x = listEdit(x, null, ['projects', p, 'disabledMcpjsonServers'], req.name, false, { keepEmpty: true });
      }
      return x;
    }) : false;
    if (did) applied.push({ file, key: req.enabled ? 'enabledMcpjsonServers' : 'disabledMcpjsonServers', project: p });
    if (did2) applied.push({ file: ctx.claudeJson, key: `projects[${p}].disabledMcpServers`, project: p });
    return applied;
  }
  const scoped = row.scope === 'local' ? [row.project] : targets;
  const changedIn = [];
  await rewriteJson(ctx.claudeJson, (t, j) => {
    let x = t;
    for (const p of scoped) {
      if (req.enabled && !obj(j.projects && j.projects[p])) continue;
      const y = listEdit(x, null, ['projects', p, 'disabledMcpServers'], req.name, !req.enabled);
      if (y !== x) changedIn.push(p);
      x = y;
    }
    return x;
  });
  for (const p of changedIn) applied.push({ file: ctx.claudeJson, key: `projects[${p}].disabledMcpServers`, project: p });
  return applied;
}

async function togglePlugin(ctx, projects, req, fresh) {
  const row = fresh.plugins.find((r) => r.id === req.name && (req.scope ? r.scope === req.scope : true) && (r.project && req.project ? r.project === req.project : true));
  if (!row) throw fail(`no plugin named ${req.name}`, 'UNKNOWN_ITEM');
  if (!row.toggle) throw fail(`${req.name} is a ${row.scope} plugin; the CLI has no switch for it`, 'NOT_SUPPORTED');
  if (!ctx.exe) throw fail('Claude Code is not installed on this machine', 'ENGINE_MISSING');
  const cwd = row.scope === 'user' ? ctx.home : findProject(projects, row.project);
  if (!cwd) {
    throw fail(`${req.name} is installed for ${row.project || 'a project'}, which is not one of your Termdeck projects on this machine`, 'NOT_SUPPORTED');
  }
  const id = fullName(row, row.id);
  // On Windows the CLI is a .cmd shim and runs through cmd.exe (agent/capabilities.js
  // extensionsRun), where `&`, `|` or `%` in an argument is syntax. A plugin id
  // is a name and a marketplace, nothing else.
  if (!PLUGIN_ID.test(id)) throw fail(`${id} is not a plugin id Termdeck can pass to the CLI`, 'NOT_SUPPORTED');
  const r = await ctx.run(ctx.exe, ['plugin', req.enabled ? 'enable' : 'disable', id, '--json', '-s', row.scope], { timeout: CLI_TIMEOUT_MS, cwd });
  const out = parseJsonOut(r.stdout) || {};
  const settled = r.code === 0 || out.failureCode === 'already_in_goal_state' || out.alreadyInGoalState === true;
  if (!settled) {
    // The CLI's own JSON message is meant for people and is passed on, redacted;
    // raw stderr stays in the agent's log.
    const err = String(r.stderr || '').trim();
    if (err) console.warn(`[extensions] claude plugin ${req.enabled ? 'enable' : 'disable'} failed (exit ${r.code}): ${err.slice(-2000)}`);
    throw fail(redactDetail(typeof out.message === 'string' && out.message ? out.message : `claude plugin exited ${r.code}`, 300), 'CLI_FAILED');
  }
  const file = row.scope === 'user' ? path.join(ctx.claudeDir, 'settings.json') : path.join(cwd, scopeFile(row.scope));
  return out.failureCode === 'already_in_goal_state' ? [] : [{ file, key: `enabledPlugins["${id}"]` }];
}

async function toggleSkill(ctx, projects, req, fresh) {
  const row = fresh.skills.find((r) => r.name === req.name && (req.scope ? r.scope === req.scope : true) && (r.project ? r.project === req.project : true));
  if (!row) throw fail(`no skill named ${req.name}`, 'UNKNOWN_ITEM');
  if (row.toggle !== 'skill') throw fail(`${req.name} comes from a plugin; switch the plugin instead`, 'NOT_SUPPORTED');
  req = { ...req, name: fullName(row, req.name) };
  const file = row.scope === 'project' ? path.join(row.project, '.claude', 'settings.local.json') : path.join(ctx.claudeDir, 'settings.json');
  const did = await rewriteJson(file, (t, j) => {
    const map = obj(j.skillOverrides) || {};
    if (req.enabled) {
      if (!has(map, req.name)) return t;
      // The last override takes its object with it.
      return Object.keys(map).length > 1 ? jsonEdit.deletePath(t, ['skillOverrides', req.name]) : jsonEdit.deletePath(t, ['skillOverrides']);
    }
    if (map[req.name] === 'off') return t;
    return jsonEdit.setPath(t, ['skillOverrides', req.name], 'off');
  }, { create: row.scope === 'project' });
  return did ? [{ file, key: `skillOverrides["${req.name}"]` }] : [];
}

async function toggle(ctx, projects, req) {
  const fresh = await list(ctx, projects);
  let applied;
  if (req.kind === 'mcp') applied = await toggleMcp(ctx, projects, req, fresh);
  else if (req.kind === 'plugin') applied = await togglePlugin(ctx, projects, req, fresh);
  else if (req.kind === 'skill') applied = await toggleSkill(ctx, projects, req, fresh);
  else throw fail(`unknown kind ${req.kind}`, 'UNKNOWN_ITEM');
  // MCP config is read when a session starts; plugins need /reload-plugins or a
  // new session; skills reload live.
  return { ok: true, applied, restartNeeded: req.kind !== 'skill' };
}

async function cliVersion(ctx) {
  if (!ctx.exe) return null;
  const r = await ctx.run(ctx.exe, ['--version'], { timeout: 8000, cwd: ctx.home });
  return r.code === 0 ? clip(String(r.stdout || '').trim().split('\n')[0], 80) : null;
}

module.exports = {
  list, health, toggle, cliVersion,
  parseMcpList, mcpjsonState, rewriteJson, managedMcpPath,
};
