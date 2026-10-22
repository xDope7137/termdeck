'use strict';

// Codex's MCP servers, plugins and skills on one machine (features/01-extensions,
// phase 4). lib/extensions.js is the dispatcher; this file knows Codex.
//
// Reads come from Codex itself wherever it answers: `codex mcp list --json`,
// `codex plugin list --json`, and the shared app-server's `skills/list` and
// `mcpServerStatus/list` (agent/engine-runs.js rpc). Each is mapped onto the
// row shape and redacted here; their output carries env values and bearer
// tokens in clear and is never forwarded as it came.
//
// Writes are one `enabled` line in $CODEX_HOME/config.toml through
// lib/toml-edit.js, which keeps every comment and byte around it:
//
//   [mcp_servers.<name>] enabled            a server configured in config.toml
//   [plugins."<name>@<marketplace>"] enabled a plugin (and the servers it ships)
//   [[skills.config]] path + enabled         a skill
//
// Codex has no live switch, so every change applies to new chats.
//
// Shipped to agents by name (AGENT_FILES in master.js): siblings and builtins only.

const fsp = require('fs/promises');
const path = require('path');
const { frontmatter, readHead, clip, MAX_ENTRIES, rewriteFile, withFullName, fullName } = require('./machine-config');
const { redactCommandLine } = require('./mcp-config');
const { rawJson, redactToml, redactUrl, redactDetail } = require('./extensions-redact');
const toml = require('./toml-edit');

const CLI_TIMEOUT_MS = 20_000;
const RPC_TIMEOUT_MS = 30_000;
const MAX_TARGET = 300;

const fail = (message, code) => Object.assign(new Error(message), { code });
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

function parseJsonOut(stdout) {
  const s = String(stdout || '').trim();
  try { return JSON.parse(s); } catch {}
  const i = s.search(/[[{]/);
  if (i > 0) { try { return JSON.parse(s.slice(i)); } catch {} }
  return null;
}

const configPath = (ctx) => path.join(ctx.codexHome, 'config.toml');

async function readConfig(ctx) {
  try { return await fsp.readFile(configPath(ctx), 'utf8'); } catch { return ''; }
}

// `.../plugins/cache/<marketplace>/<plugin>/<version>/...` names the plugin a
// bundled server came from when the status list is not there to say.
function pluginFromPath(p) {
  const m = /[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]/.exec(String(p || ''));
  return m ? `${m[2]}@${m[1]}` : null;
}

// What a CLI said on stderr, kept on the machine (the agent's own log) and
// never sent to the browser.
function logStderr(what, r) {
  const err = String((r && r.stderr) || '').trim();
  if (err) console.warn(`[extensions] ${what} failed (exit ${r.code}): ${err.slice(-2000)}`);
}

async function rpc(ctx, method, params) {
  if (!ctx.codexRpc) return null;
  try { return await ctx.codexRpc(method, params, RPC_TIMEOUT_MS); } catch { return null; }
}

async function listMcp(ctx, text) {
  const r = await ctx.run(ctx.exe, ['mcp', 'list', '--json'], { timeout: CLI_TIMEOUT_MS, cwd: ctx.home });
  const list = parseJsonOut(r.stdout);
  if (!Array.isArray(list)) {
    // Never forwarded: a config.toml codex cannot parse comes back quoted line by
    // line, secrets and all. The owner reads it in the agent's log.
    logStderr('codex mcp list', r);
    throw fail(r.timedOut ? 'codex mcp list timed out' : 'codex could not read its config.toml; run `codex mcp list` on the machine to see why', 'CLI_FAILED');
  }
  const status = await rpc(ctx, 'mcpServerStatus/list', {});
  const pluginOf = new Map(((status && status.data) || []).map((s) => [s.name, s.pluginId || null]));
  const rows = [];
  let truncated = false;
  for (const s of list) {
    if (!s || typeof s.name !== 'string') continue;
    if (rows.length >= MAX_ENTRIES) { truncated = true; break; }
    const t = obj(s.transport) || {};
    const kind = t.type === 'streamable_http' || t.url ? 'http' : 'stdio';
    const target = t.url ? redactUrl(t.url) : redactCommandLine([t.command, ...(Array.isArray(t.args) ? t.args : [])].filter((x) => typeof x === 'string').join(' '));
    const excerpt = toml.tableExcerpt(text, ['mcp_servers', s.name]);
    const pluginId = excerpt ? null : (pluginOf.get(s.name) || pluginFromPath(t.cwd));
    const row = {
      name: clip(s.name, 160),
      scope: excerpt ? 'user' : pluginId ? 'plugin' : 'user',
      sourceFile: excerpt ? '~/.codex/config.toml' : pluginId ? `${pluginId.split('@')[0]} plugin` : null,
      transport: kind,
      target: String(target).slice(0, MAX_TARGET),
      hasEnv: !!((obj(t.env) && Object.keys(t.env).length) || (Array.isArray(t.env_vars) && t.env_vars.length)),
      hasHeaders: !!(obj(t.http_headers) || obj(t.env_http_headers) || t.bearer_token_env_var),
      hasOauth: s.auth_status === 'o_auth' || s.auth_status === 'oauth',
      enabled: s.enabled !== false,
      enabledBy: excerpt ? 'enabled-key' : pluginId ? 'plugin' : 'config',
      toggle: excerpt ? 'mcp' : pluginId ? 'plugin' : null,
      raw: excerpt ? redactToml(excerpt) : rawJson(s),
    };
    if (pluginId) row.pluginId = pluginId;
    if (s.disabled_reason) row.disabledReason = clip(String(s.disabled_reason), 200);
    if (typeof s.startup_timeout_sec === 'number') row.timeoutMs = Math.round(s.startup_timeout_sec * 1000);
    if (typeof s.tool_timeout_sec === 'number') row.toolTimeoutMs = Math.round(s.tool_timeout_sec * 1000);
    if (typeof s.auth_status === 'string') row.authStatus = clip(s.auth_status, 40);
    rows.push(withFullName(row, s.name));
  }
  return { rows, truncated };
}

async function manifestOf(dir) {
  if (!dir) return null;
  try {
    const m = JSON.parse(await fsp.readFile(path.join(dir, '.codex-plugin', 'plugin.json'), 'utf8'));
    return obj(m);
  } catch { return null; }
}

async function countDir(dir, pred) {
  try { return (await fsp.readdir(dir, { withFileTypes: true })).filter(pred).length; } catch { return 0; }
}

async function listPlugins(ctx, text) {
  const r = await ctx.run(ctx.exe, ['plugin', 'list', '--json'], { timeout: CLI_TIMEOUT_MS, cwd: ctx.home });
  const out = parseJsonOut(r.stdout);
  const installed = out && Array.isArray(out.installed) ? out.installed : null;
  // A plugin list that failed or came back in a shape this does not read is not
  // "no plugins": say so to the page, and leave the reason in the agent's log.
  if (!installed) {
    if (r.code !== 0) logStderr('codex plugin list', r);
    else console.warn(`[extensions] codex plugin list printed no "installed" list (${String(r.stdout || '').length} bytes of stdout)`);
    return { rows: [], truncated: false, marketplaces: [], unread: true };
  }
  const rows = [];
  let truncated = false;
  const markets = new Map();
  for (const p of installed) {
    if (!p || typeof p.pluginId !== 'string') continue;
    if (rows.length >= MAX_ENTRIES) { truncated = true; break; }
    const dir = obj(p.source) && typeof p.source.path === 'string' ? p.source.path : null;
    const man = (await manifestOf(dir)) || {};
    const iface = obj(man.interface) || {};
    const author = obj(man.author) ? man.author.name : man.author;
    const excerpt = toml.tableExcerpt(text, ['plugins', p.pluginId], { withSubtables: false });
    rows.push(withFullName({
      id: clip(p.pluginId, 200),
      name: clip(p.name, 120),
      marketplace: clip(p.marketplaceName, 120),
      version: clip(p.version, 80),
      scope: 'user',
      enabled: p.enabled !== false,
      enabledBy: excerpt ? 'enabled-key' : 'default',
      toggle: 'plugin',
      installPath: dir,
      installedAt: null,
      lastUpdated: null,
      manifest: {
        displayName: clip(iface.displayName || man.displayName || man.name || p.name, 120),
        description: clip(iface.shortDescription || man.description),
        author: clip(typeof author === 'string' ? author : null, 120),
        homepage: clip(typeof man.homepage === 'string' ? redactUrl(man.homepage) : null, 300),
        repository: clip(typeof man.repository === 'string' ? redactUrl(man.repository) : null, 300),
        license: clip(man.license, 60),
        keywords: Array.isArray(man.keywords) ? man.keywords.filter((k) => typeof k === 'string').slice(0, 20) : [],
      },
      components: dir ? {
        skills: await countDir(path.join(dir, 'skills'), (e) => e.isDirectory()),
        commands: 0,
        agents: 0,
        hooks: 0,
        mcpServers: obj(man.mcpServers) ? Object.keys(man.mcpServers).length : 0,
        lspServers: 0,
      } : null,
      raw: excerpt ? redactToml(excerpt) : rawJson({ ...p, source: undefined, marketplaceSource: undefined }),
    }, p.pluginId));
    const ms = obj(p.marketplaceSource);
    if (p.marketplaceName && !markets.has(p.marketplaceName)) {
      markets.set(p.marketplaceName, { name: clip(p.marketplaceName, 120), source: clip(ms && ms.sourceType, 40), repo: null, installLocation: clip(ms && typeof ms.source === 'string' ? ms.source : null, 400) });
    }
  }
  return { rows, truncated, marketplaces: [...markets.values()] };
}

// The `[[skills.config]]` entries, path -> enabled.
function skillConfig(text) {
  const map = new Map();
  for (const e of toml.readArrayTables(text, ['skills', 'config'])) {
    if (typeof e.path === 'string' && typeof e.enabled === 'boolean') map.set(e.path, e.enabled);
  }
  return map;
}

function scopeOf(p, ctx, projects) {
  const s = String(p || '');
  if (s.includes(`${path.sep}.system${path.sep}`)) return 'bundled';
  if (projects.some((cwd) => s.startsWith(cwd + path.sep))) return 'project';
  return 'user';
}

// From the app-server when it answers: the authoritative set, plugin skills
// included. Else the three folders Codex reads, walked here.
async function listSkills(ctx, projects, text) {
  const cfg = skillConfig(text);
  const rows = [];
  let truncated = false;
  const seen = new Set();
  const add = (r) => {
    if (seen.has(r.path)) return true;
    if (rows.length >= MAX_ENTRIES) { truncated = true; return false; }
    seen.add(r.path);
    rows.push(r);
    return true;
  };
  const res = await rpc(ctx, 'skills/list', { cwds: projects.length ? projects : [ctx.home] });
  if (res && Array.isArray(res.data)) {
    for (const group of res.data) {
      for (const s of (group && Array.isArray(group.skills) ? group.skills : [])) {
        if (!s || typeof s.path !== 'string') continue;
        const scope = s.pluginId ? 'plugin' : scopeOf(s.path, ctx, projects);
        const iface = obj(s.interface) || {};
        const ok = add({
          name: clip(s.name, 120),
          scope,
          project: scope === 'project' ? group.cwd : undefined,
          pluginId: s.pluginId || undefined,
          path: s.path,
          description: clip(s.description),
          whenToUse: clip(iface.shortDescription),
          argumentHint: null, userInvocable: null, disableModelInvocation: null, allowedTools: null, model: null, effort: null,
          override: s.enabled === false ? 'off' : 'on',
          enabled: s.enabled !== false,
          enabledBy: cfg.has(s.path) ? 'skills.config' : 'default',
          toggle: scope === 'plugin' ? 'plugin' : 'skill',
          raw: rawJson({ name: s.name, description: s.description, path: s.path, scope: s.scope, enabled: s.enabled, pluginId: s.pluginId }),
        });
        if (!ok) break;
      }
    }
    return { rows, truncated };
  }
  const roots = [
    [path.join(ctx.codexHome, 'skills'), 'user', null],
    [path.join(ctx.home, '.agents', 'skills'), 'user', null],
    ...projects.map((p) => [path.join(p, '.agents', 'skills'), 'project', p]),
  ];
  for (const [root, scope, project] of roots) {
    let ents;
    try { ents = await fsp.readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory()) continue;
      const dirs = e.name === '.system' ? (await fsp.readdir(path.join(root, e.name), { withFileTypes: true }).catch(() => [])).filter((x) => x.isDirectory()).map((x) => path.join(root, e.name, x.name)) : [path.join(root, e.name)];
      for (const d of dirs) {
        const file = path.join(d, 'SKILL.md');
        let fm;
        try { fm = frontmatter(await readHead(file)); } catch { continue; }
        const enabled = cfg.has(file) ? cfg.get(file) : true;
        const sc = e.name === '.system' ? 'bundled' : scope;
        if (!add({
          name: clip(fm.name || path.basename(d), 120), scope: sc, project: project || undefined, path: file,
          description: clip(fm.description), whenToUse: null, argumentHint: null, userInvocable: null, disableModelInvocation: null, allowedTools: null, model: null, effort: null,
          override: enabled ? 'on' : 'off', enabled, enabledBy: cfg.has(file) ? 'skills.config' : 'default', toggle: 'skill', raw: rawJson(fm),
        })) return { rows, truncated };
      }
    }
  }
  return { rows, truncated };
}

async function list(ctx, projects) {
  const text = await readConfig(ctx);
  const mcp = await listMcp(ctx, text);
  const plugins = await listPlugins(ctx, text);
  const skills = await listSkills(ctx, projects, text);
  return {
    mcp: mcp.rows,
    plugins: plugins.rows,
    skills: skills.rows,
    marketplaces: plugins.marketplaces,
    truncated: { mcp: mcp.truncated, plugins: plugins.truncated, skills: skills.truncated },
    unread: plugins.unread ? { plugins: true } : undefined,
  };
}

// codex-cli 0.160 leaves runtimeStatus null even for a connected server (checked
// 2026-10-11 against a real app-server); the server's tool list is the signal
// that it answered. runtimeStatus is used whenever a version fills it in.
// Before 0.160, runtimeStatus was null until a thread had started the server, so a machine
// that has not run a Codex chat since its app-server started reads "unknown".
const RUNTIME = {
  connected: 'connected', starting: 'unknown', notStarted: 'unknown', authenticationRequired: 'needs-auth',
  failed: 'failed', cancelled: 'failed', disabled: 'disabled',
};

async function health(ctx) {
  const res = await rpc(ctx, 'mcpServerStatus/list', {});
  if (!res || !Array.isArray(res.data)) return { project: null, servers: [], unavailable: true };
  return {
    project: null,
    servers: res.data.filter((s) => s && typeof s.name === 'string').slice(0, MAX_ENTRIES).map((s) => {
      const tools = obj(s.tools) ? Object.keys(s.tools).length : 0;
      let status = RUNTIME[s.runtimeStatus];
      let statusText = s.runtimeStatus;
      if (!status) {
        if (s.toolsError) { status = 'failed'; statusText = 'tools failed'; }
        else if (s.authStatus === 'notLoggedIn') { status = 'needs-auth'; statusText = 'not logged in'; }
        else if (tools) { status = 'connected'; statusText = `${tools} tool${tools === 1 ? '' : 's'}`; }
        else { status = 'unknown'; statusText = 'not started yet'; }
      }
      return {
        name: clip(s.name, 160),
        status,
        statusText: redactDetail(statusText, 60),
        detail: s.toolsError ? redactDetail(String(s.toolsError.message || s.toolsError), 400) : null,
        tools,
      };
    }),
  };
}

// The config.toml rewrite: re-read, edit one line, check the edit reads back,
// temp file, rename. A file that is not there is created with the one table.
async function rewriteToml(ctx, edit) {
  return rewriteFile(configPath(ctx), (text) => {
    const cur = text == null ? '' : text;
    let next;
    try { next = edit(cur); } catch (e) { throw fail(e.message, 'WRITE_FAILED'); }
    return next === cur ? null : next;
  }, { mkdir: true });
}

// Codex has no "off" list: a switch is an `enabled` key. Turning one off that had
// no key adds `enabled = false` marked as ours, and turning it back on removes
// that line (or the whole [[skills.config]] entry Termdeck added), so the file
// ends exactly as it was. A key the person wrote is set in place, never removed.
const OURS = '# turned off in Termdeck';
const isOurs = (line) => !!(line && line.comment === OURS);

function setEnabled(t, tablePath, on) {
  if (on && isOurs(toml.readKeyLine(t, tablePath, 'enabled'))) return toml.deleteKey(t, tablePath, 'enabled');
  return toml.setTableKey(t, tablePath, 'enabled', on, { comment: OURS });
}

function setSkillEnabled(t, skillPath, on) {
  const entry = toml.arrayEntry(t, ['skills', 'config'], 'path', skillPath);
  if (on && entry && isOurs(entry.enabled) && Object.keys(entry).length === 2) {
    return toml.deleteArrayEntry(t, ['skills', 'config'], 'path', skillPath);
  }
  return toml.setArrayTableEntry(t, ['skills', 'config'], 'path', skillPath, 'enabled', on, { comment: OURS });
}

async function toggle(ctx, projects, req) {
  const fresh = await list(ctx, projects);
  const file = configPath(ctx);
  let applied = [];
  if (req.kind === 'mcp') {
    const row = fresh.mcp.find((r) => r.name === req.name);
    if (!row) throw fail(`no MCP server named ${req.name}`, 'UNKNOWN_ITEM');
    if (row.toggle !== 'mcp') throw fail(`${req.name} comes from a plugin; switch the plugin instead`, 'NOT_SUPPORTED');
    const name = fullName(row, req.name);
    if (await rewriteToml(ctx, (t) => setEnabled(t, ['mcp_servers', name], !!req.enabled))) applied = [{ file, key: `mcp_servers.${name}.enabled` }];
  } else if (req.kind === 'plugin') {
    const row = fresh.plugins.find((r) => r.id === req.name);
    if (!row) throw fail(`no plugin named ${req.name}`, 'UNKNOWN_ITEM');
    const id = fullName(row, req.name);
    if (await rewriteToml(ctx, (t) => setEnabled(t, ['plugins', id], !!req.enabled))) applied = [{ file, key: `plugins."${id}".enabled` }];
  } else if (req.kind === 'skill') {
    const row = fresh.skills.find((r) => r.name === req.name && (req.path ? r.path === req.path : true) && (r.project && req.project ? r.project === req.project : true));
    if (!row) throw fail(`no skill named ${req.name}`, 'UNKNOWN_ITEM');
    if (row.toggle !== 'skill') throw fail(`${req.name} comes from a plugin; switch the plugin instead`, 'NOT_SUPPORTED');
    if (await rewriteToml(ctx, (t) => setSkillEnabled(t, row.path, !!req.enabled))) applied = [{ file, key: 'skills.config' }];
  } else {
    throw fail(`unknown kind ${req.kind}`, 'UNKNOWN_ITEM');
  }
  return { ok: true, applied, restartNeeded: true };
}

async function cliVersion(ctx) {
  const r = await ctx.run(ctx.exe, ['--version'], { timeout: 8000, cwd: ctx.home });
  return r.code === 0 ? clip(String(r.stdout || '').trim().split('\n')[0], 80) : null;
}

module.exports = { list, health, toggle, cliVersion, pluginFromPath, skillConfig, rewriteToml };
