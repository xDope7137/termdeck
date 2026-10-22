'use strict';

// Grok's MCP servers, plugins and skills on one machine (features/01-extensions,
// phase 5). lib/extensions.js is the dispatcher; this file knows Grok, which
// means xAI's own CLI (@xai-official/grok). The community @vibe-kit/grok-cli
// answers to the same command and has none of this, so it is refused by name.
//
// Reads come from the CLI wherever it answers, shapes captured from grok 1.0.50:
//
//   grok mcp list --json      config.toml servers: name, scope (user|project),
//                             enabled, and the entry itself (env and tokens in
//                             clear: redacted here, never forwarded)
//   grok inspect --json       skills (with `disabled`), plugin and Claude-compat
//                             MCP servers, plugin component counts
//   grok plugin list --json   installed plugins: name, version, path, source
//   grok mcp doctor --json    health: per server, healthy and the checks run
//
// Writes, all in ~/.grok/config.toml through lib/toml-edit.js:
//
//   disabled_mcp_servers = [...]   top of the file; what `grok mcp disable`
//                                  writes, and it covers user, project and
//                                  Claude-compat servers alike. Written here so
//                                  that switching back gives the file back.
//   [skills] disabled = [...]      a skill, by name
//   [plugins] enabled/disabled     what `grok plugin enable|disable` moves a
//                                  name between. Not run through that command:
//                                  it re-serialises the whole file and drops
//                                  every comment in it (seen on 1.0.50).
//
// `inspect` keeps saying `enabled: true` for a disabled plugin, so plugin state
// is read off [plugins] disabled instead.
//
// Shipped to agents by name (AGENT_FILES in master.js): siblings and builtins only.

const fsp = require('fs/promises');
const path = require('path');
const { clip, MAX_ENTRIES, rewriteFile, withFullName, fullName } = require('./machine-config');
const { redactCommandLine } = require('./mcp-config');
const { rawJson, redactToml, redactUrl, redactDetail } = require('./extensions-redact');
const toml = require('./toml-edit');

const CLI_TIMEOUT_MS = 20_000;
const DOCTOR_TIMEOUT_MS = 110_000;
const MAX_TARGET = 300;
const MAX_PROJECT_READS = 20;

const fail = (message, code) => Object.assign(new Error(message), { code });
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function parseJsonOut(stdout) {
  const s = String(stdout || '').trim();
  try { return JSON.parse(s); } catch {}
  const i = s.search(/[[{]/);
  if (i > 0) { try { return JSON.parse(s.slice(i)); } catch {} }
  return null;
}

const configPath = (ctx) => path.join(ctx.grokDir, 'config.toml');
const homeLabel = '~/.grok/config.toml';

async function readConfig(ctx) {
  try { return await fsp.readFile(configPath(ctx), 'utf8'); } catch { return ''; }
}

// xAI's CLI answers `grok 1.0.50 (c58f321264ba)`; the community one a bare
// `1.0.1`. agent/capabilities.js cliStatus draws the same line.
const isOfficial = (version) => /^grok\s+v?\d/i.test(String(version || ''));

async function cliVersion(ctx) {
  const r = await ctx.run(ctx.exe, ['--version'], { timeout: 8000, cwd: ctx.home });
  return r.code === 0 ? clip(String(r.stdout || '').trim().split('\n')[0], 80) : null;
}

async function requireOfficial(ctx) {
  const v = await cliVersion(ctx).catch(() => null);
  if (v && !isOfficial(v)) {
    throw fail('The grok on this machine is @vibe-kit/grok-cli, not xAI\'s Grok CLI. Install @xai-official/grok to use Grok here.', 'ENGINE_MISSING');
  }
}

// What a CLI said on stderr, kept on the machine (the agent's own log) and
// never sent to the browser.
function logStderr(what, r) {
  const err = String((r && r.stderr) || '').trim();
  if (err) console.warn(`[extensions] ${what} failed (exit ${r.code}): ${err.slice(-2000)}`);
}

async function cli(ctx, args, cwd, timeout = CLI_TIMEOUT_MS) {
  const r = await ctx.run(ctx.exe, args, { timeout, cwd: cwd || ctx.home });
  return { ...r, json: parseJsonOut(r.stdout) };
}

function disabledServers(text) {
  const v = toml.readStringArray(text, [], 'disabled_mcp_servers');
  return v === undefined ? [] : v;
}

function transportOf(s) {
  const url = typeof s.url === 'string' ? s.url : null;
  return {
    transport: url ? (s.transport === 'sse' ? 'sse' : 'http') : 'stdio',
    target: String(url ? redactUrl(url) : redactCommandLine([s.command, ...strs(s.args)].filter((x) => typeof x === 'string').join(' '))).slice(0, MAX_TARGET),
  };
}

function mcpRow(s, { scope, project, text, off }) {
  const t = transportOf(s);
  const excerpt = scope === 'user' ? toml.tableExcerpt(text, ['mcp_servers', s.name]) : null;
  const enabled = s.enabled !== false && !off.includes(s.name);
  return withFullName({
    name: clip(s.name, 160),
    scope,
    project: project || undefined,
    sourceFile: scope === 'user' ? homeLabel : '.grok/config.toml',
    transport: t.transport,
    target: t.target,
    hasEnv: !!(obj(s.env) && Object.keys(s.env).length),
    hasHeaders: !!(obj(s.headers) || obj(s.http_headers) || s.bearer_token_env_var || s.bearer_token_file),
    hasOauth: !!obj(s.oauth),
    enabled,
    enabledBy: off.includes(s.name) ? 'disabled_mcp_servers' : s.enabled === false ? 'enabled-key' : 'config',
    toggle: 'mcp',
    raw: excerpt ? redactToml(excerpt) : rawJson({ ...s, scope: undefined }, s.name),
  }, s.name);
}

// The servers config.toml names, in home and in each added project (a project's
// own .grok/config.toml only shows when the CLI runs in it).
async function listConfigServers(ctx, projects, text, off) {
  const rows = [];
  const seen = new Set();
  const home = await cli(ctx, ['mcp', 'list', '--json'], ctx.home);
  if (!Array.isArray(home.json)) {
    // Never forwarded: grok quotes the config line it could not read.
    logStderr('grok mcp list', home);
    throw fail(home.timedOut ? 'grok mcp list timed out' : 'grok could not read its config.toml; run `grok mcp list` on the machine to see why', 'CLI_FAILED');
  }
  for (const s of home.json) {
    if (!s || typeof s.name !== 'string' || s.scope === 'project') continue;
    seen.add(`user:${s.name}`);
    rows.push(mcpRow(s, { scope: 'user', text, off }));
  }
  for (const p of projects.slice(0, MAX_PROJECT_READS)) {
    const r = await cli(ctx, ['mcp', 'list', '--json'], p);
    for (const s of Array.isArray(r.json) ? r.json : []) {
      if (!s || typeof s.name !== 'string' || s.scope !== 'project' || seen.has(`${p}:${s.name}`)) continue;
      seen.add(`${p}:${s.name}`);
      rows.push(mcpRow(s, { scope: 'project', project: p, text, off }));
    }
  }
  return rows;
}

// Servers no config.toml names: a plugin's, and the ones Grok reads from other
// tools' config (Claude's ~/.claude.json by default). Those last are switched for
// Grok only, in Grok's own list; the Claude tab still owns them for Claude.
function extraServers(inspect, off, known) {
  const rows = [];
  for (const s of (inspect && Array.isArray(inspect.mcpServers) ? inspect.mcpServers : [])) {
    if (!s || typeof s.name !== 'string' || known.has(s.name)) continue;
    const src = obj(s.source) || {};
    const target = String(s.transport === 'stdio' ? redactCommandLine(String(s.target || '')) : redactUrl(String(s.target || ''))).slice(0, MAX_TARGET);
    if (src.type === 'plugin') {
      rows.push(withFullName({
        name: clip(s.name, 160), scope: 'plugin', sourceFile: `${src.plugin_name || 'a'} plugin`, transport: s.transport || 'stdio', target,
        hasEnv: false, hasHeaders: false, hasOauth: false, enabled: !off.includes(s.name), enabledBy: 'plugin', toggle: 'plugin',
        pluginId: clip(src.plugin_name, 120) || undefined, raw: rawJson({ name: s.name, transport: s.transport, target, source: { type: src.type, plugin: src.plugin_name } }, s.name),
      }, s.name));
    } else if (src.type !== 'configToml') {
      const vendor = s.vendor || (src.type === 'claudeJson' ? 'claude' : src.type);
      rows.push(withFullName({
        name: clip(s.name, 160), scope: 'compat', sourceFile: clip(src.path ? String(src.path).replace(/^.*[\\/](\.[^\\/]+)$/, '~/$1') : vendor, 200), transport: s.transport || 'stdio', target,
        hasEnv: false, hasHeaders: false, hasOauth: false,
        enabled: !off.includes(s.name) && s.compatibilityStatus !== 'disabled', enabledBy: off.includes(s.name) ? 'disabled_mcp_servers' : 'config',
        toggle: 'mcp', vendor: clip(vendor, 40),
        raw: rawJson({ name: s.name, transport: s.transport, target, source: src.type, vendor }, s.name),
      }, s.name));
    }
  }
  return rows;
}

async function manifestOf(dir) {
  for (const f of ['.grok-plugin', '.claude-plugin']) {
    try { return obj(JSON.parse(await fsp.readFile(path.join(dir, f, 'plugin.json'), 'utf8'))); } catch {}
  }
  return null;
}

async function countDir(dir, pred) {
  try { return (await fsp.readdir(dir, { withFileTypes: true })).filter(pred).length; } catch { return 0; }
}

async function listPlugins(ctx, text, inspect) {
  const r = await cli(ctx, ['plugin', 'list', '--json'], ctx.home);
  const list = Array.isArray(r.json) ? r.json : [];
  const off = toml.readStringArray(text, ['plugins'], 'disabled') || [];
  const provides = new Map(((inspect && inspect.plugins) || []).filter((p) => p && p.name).map((p) => [p.name, obj(p.provides) || {}]));
  const rows = [];
  const markets = new Map();
  let truncated = false;
  for (const p of list) {
    if (!p || typeof p.name !== 'string') continue;
    if (rows.length >= MAX_ENTRIES) { truncated = true; break; }
    const dir = typeof p.path === 'string' ? p.path : null;
    const man = (dir && await manifestOf(dir)) || {};
    const author = obj(man.author) ? man.author.name : man.author;
    const pv = provides.get(p.name);
    rows.push(withFullName({
      id: clip(p.name, 200),
      name: clip(p.name, 120),
      marketplace: clip(p.marketplace, 120),
      version: clip(p.version || man.version, 80),
      scope: 'user',
      enabled: !off.includes(p.name),
      enabledBy: off.includes(p.name) ? '[plugins] disabled' : '[plugins] enabled',
      toggle: 'plugin',
      installPath: dir,
      installedAt: null,
      lastUpdated: null,
      manifest: {
        displayName: clip(man.displayName || man.name || p.name, 120),
        description: clip(man.description),
        author: clip(typeof author === 'string' ? author : null, 120),
        homepage: clip(typeof man.homepage === 'string' ? redactUrl(man.homepage) : null, 300),
        repository: clip(typeof man.repository === 'string' ? redactUrl(man.repository) : null, 300),
        license: clip(man.license, 60),
        keywords: strs(man.keywords).slice(0, 20),
      },
      components: dir ? {
        skills: pv && typeof pv.skills === 'number' ? pv.skills : await countDir(path.join(dir, 'skills'), (e) => e.isDirectory()),
        commands: await countDir(path.join(dir, 'commands'), (e) => e.isFile() && e.name.endsWith('.md')),
        agents: pv && typeof pv.agents === 'number' ? pv.agents : await countDir(path.join(dir, 'agents'), (e) => e.isFile() && e.name.endsWith('.md')),
        hooks: pv && pv.hooks ? 1 : 0,
        mcpServers: pv && typeof pv.mcpServers === 'number' ? pv.mcpServers : 0,
        lspServers: 0,
      } : null,
      raw: rawJson({ name: p.name, version: p.version, status: p.status, source: typeof p.source === 'string' ? redactUrl(p.source) : null, marketplace: p.marketplace, manifest: man }, p.name),
    }, p.name));
    if (p.marketplace && !markets.has(p.marketplace)) markets.set(p.marketplace, { name: clip(p.marketplace, 120), source: null, repo: null, installLocation: null });
  }
  return { rows, truncated, marketplaces: [...markets.values()] };
}

const SKILL_SCOPE = { user: 'user', project: 'project', plugin: 'plugin', builtin: 'bundled', bundled: 'bundled' };

function listSkills(text, inspect) {
  const off = toml.readStringArray(text, ['skills'], 'disabled') || [];
  const rows = [];
  let truncated = false;
  for (const s of (inspect && Array.isArray(inspect.skills) ? inspect.skills : [])) {
    if (!s || typeof s.name !== 'string') continue;
    if (rows.length >= MAX_ENTRIES) { truncated = true; break; }
    const src = obj(s.source) || {};
    const scope = SKILL_SCOPE[src.type] || 'compat';
    const disabled = s.disabled === true || off.includes(s.name);
    rows.push(withFullName({
      name: clip(s.name, 120),
      scope,
      pluginId: scope === 'plugin' ? clip(src.plugin_name || src.plugin, 120) || undefined : undefined,
      path: typeof src.path === 'string' ? src.path : null,
      description: clip(s.description),
      whenToUse: null,
      argumentHint: null,
      userInvocable: typeof s.userInvocable === 'boolean' ? s.userInvocable : null,
      disableModelInvocation: null, allowedTools: null, model: null, effort: null,
      override: disabled ? 'off' : 'on',
      enabled: !disabled,
      enabledBy: off.includes(s.name) ? '[skills] disabled' : 'default',
      toggle: scope === 'plugin' ? 'plugin' : scope === 'bundled' ? null : 'skill',
      vendor: scope === 'compat' ? clip(src.type, 40) : undefined,
      raw: rawJson({ name: s.name, description: s.description, source: { type: src.type, path: src.path }, userInvocable: s.userInvocable, disabled: s.disabled }, s.name),
    }, s.name));
  }
  return { rows, truncated };
}

async function list(ctx, projects) {
  await requireOfficial(ctx);
  const text = await readConfig(ctx);
  const off = disabledServers(text);
  if (off === null) throw fail('disabled_mcp_servers in ~/.grok/config.toml is not a one-line list; Termdeck cannot read it', 'CLI_FAILED');
  const ins = await cli(ctx, ['inspect', '--json'], ctx.home);
  const inspect = obj(ins.json);
  const config = await listConfigServers(ctx, projects, text, off);
  const extra = extraServers(inspect, off, new Set(config.map((r) => r.name)));
  const mcp = [...config, ...extra];
  const plugins = await listPlugins(ctx, text, inspect);
  const skills = listSkills(text, inspect);
  return {
    mcp: mcp.slice(0, MAX_ENTRIES),
    plugins: plugins.rows,
    skills: skills.rows,
    marketplaces: plugins.marketplaces,
    truncated: { mcp: mcp.length > MAX_ENTRIES, plugins: plugins.truncated, skills: skills.truncated },
  };
}

// `grok mcp doctor --json` starts each server the way a chat would and reports
// the checks it ran. It exits 1 when any server fails, so the exit code is not
// the verdict; the JSON is. It does not start a project's own servers in a
// folder Grok has not been told to trust, and Termdeck never passes --trust.
function doctorStatus(s) {
  const checks = Array.isArray(s.checks) ? s.checks : [];
  if (s.healthy === true) {
    const tools = checks.map((c) => /^(\d+) tools? discovered/i.exec(String(c.label || ''))).find(Boolean);
    return { status: 'connected', statusText: tools ? `${tools[1]} tool${tools[1] === '1' ? '' : 's'}` : 'Connected', detail: null };
  }
  const bad = checks.find((c) => c && c.passed === false) || {};
  const label = String(bad.label || '');
  const detail = redactDetail([label, bad.detail].filter(Boolean).join(': '), 400);
  if (/untrusted/i.test(label)) return { status: 'pending-approval', statusText: 'Folder not trusted', detail };
  if (/auth|login|unauthori[sz]ed|\b401\b|\b403\b/i.test(`${label} ${bad.detail || ''}`)) return { status: 'needs-auth', statusText: 'Needs login', detail };
  if (/disabled/i.test(label)) return { status: 'disabled', statusText: 'Off', detail: null };
  return { status: 'failed', statusText: redactDetail(label || 'Failed', 60), detail };
}

async function health(ctx, projects, project) {
  await requireOfficial(ctx);
  const cwd = project && projects.includes(project) ? project : ctx.home;
  const r = await cli(ctx, ['mcp', 'doctor', '--json'], cwd, DOCTOR_TIMEOUT_MS);
  const d = obj(r.json);
  if (!d || !Array.isArray(d.servers)) {
    logStderr('grok mcp doctor', r);
    throw fail(r.timedOut ? 'grok mcp doctor timed out' : 'grok mcp doctor did not answer; run `grok mcp doctor` on the machine to see why', 'CLI_FAILED');
  }
  return {
    project: cwd === ctx.home ? null : cwd,
    servers: d.servers.filter((s) => s && typeof s.name === 'string').slice(0, MAX_ENTRIES).map((s) => ({ name: clip(s.name, 160), ...doctorStatus(s) })),
  };
}

// Re-read, edit, temp file, rename; the same rail as the Codex writer.
async function rewriteToml(ctx, edit) {
  return rewriteFile(configPath(ctx), (text) => {
    const cur = text == null ? '' : text;
    let next;
    try { next = edit(cur); } catch (e) { throw fail(e.message, 'WRITE_FAILED'); }
    return next === cur ? null : next;
  }, { mkdir: true });
}

// Add or drop one name in a string list, removing the key when it empties so
// that switching back gives the file back. `keepEmpty` leaves `key = []`, for a
// list Grok itself writes empty.
function listEdit(text, tablePath, key, name, add, { keepEmpty = false } = {}) {
  const cur = toml.readStringArray(text, tablePath, key);
  if (cur === null) throw new Error(`${tablePath.length ? `[${tablePath.join('.')}] ` : ''}${key} is not a one-line list; edit it by hand`);
  const have = cur || [];
  const next = add ? (have.includes(name) ? have : [...have, name]) : have.filter((n) => n !== name);
  if (next.length === have.length && next.every((n, i) => n === have[i])) return text;
  if (!next.length && !keepEmpty) return toml.deleteKey(text, tablePath, key);
  return tablePath.length ? toml.setTableKey(text, tablePath, key, next) : toml.setRootKey(text, key, next);
}

async function toggle(ctx, projects, req) {
  const fresh = await list(ctx, projects);
  const file = configPath(ctx);
  let applied = [];
  if (req.kind === 'mcp') {
    const row = fresh.mcp.find((r) => r.name === req.name && (req.scope ? r.scope === req.scope : true) && (r.project && req.project ? r.project === req.project : true));
    if (!row) throw fail(`no MCP server named ${req.name}`, 'UNKNOWN_ITEM');
    if (row.toggle !== 'mcp') throw fail(`${req.name} comes from a plugin; switch the plugin instead`, 'NOT_SUPPORTED');
    const name = fullName(row, req.name);
    const did = await rewriteToml(ctx, (t) => {
      let next = listEdit(t, [], 'disabled_mcp_servers', name, !req.enabled);
      // A table someone set `enabled = false` in by hand stays off whatever the
      // list says; turning it on means that line too.
      if (req.enabled && row.scope === 'user' && toml.readTableKey(next, ['mcp_servers', name], 'enabled') === false) {
        next = toml.setTableKey(next, ['mcp_servers', name], 'enabled', true);
      }
      return next;
    });
    if (did) applied = [{ file, key: 'disabled_mcp_servers' }];
  } else if (req.kind === 'plugin') {
    const row = fresh.plugins.find((r) => r.id === req.name);
    if (!row) throw fail(`no plugin named ${req.name}`, 'UNKNOWN_ITEM');
    // The order `grok plugin` uses, so a switch off and on lands back on the
    // same bytes: `disabled` comes and goes, `enabled` is edited in place.
    const pname = fullName(row, row.name);
    const did = await rewriteToml(ctx, (t) => (req.enabled
      ? listEdit(listEdit(t, ['plugins'], 'disabled', pname, false), ['plugins'], 'enabled', pname, true, { keepEmpty: true })
      : listEdit(listEdit(t, ['plugins'], 'disabled', pname, true), ['plugins'], 'enabled', pname, false, { keepEmpty: true })));
    if (did) applied = [{ file, key: '[plugins]' }];
  } else if (req.kind === 'skill') {
    const row = fresh.skills.find((r) => r.name === req.name && (req.path && r.path ? r.path === req.path : true));
    if (!row) throw fail(`no skill named ${req.name}`, 'UNKNOWN_ITEM');
    if (row.toggle !== 'skill') throw fail(row.toggle === 'plugin' ? `${req.name} comes from a plugin; switch the plugin instead` : `${req.name} is built into Grok`, 'NOT_SUPPORTED');
    const sname = fullName(row, req.name);
    if (await rewriteToml(ctx, (t) => listEdit(t, ['skills'], 'disabled', sname, !req.enabled))) applied = [{ file, key: '[skills] disabled' }];
  } else {
    throw fail(`unknown kind ${req.kind}`, 'UNKNOWN_ITEM');
  }
  return { ok: true, applied, restartNeeded: true };
}

module.exports = { list, health, toggle, cliVersion, isOfficial, doctorStatus, listEdit };
