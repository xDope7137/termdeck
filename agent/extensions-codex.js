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
// NATIVE PATH. When the agent runs the native harness, ctx.codexNativeRpc is the
// shared app-server's request, `(method, params, { timeoutMs }) -> result`, and
// nothing is spawned or hand-edited:
//
//   MCP servers   config/read (mcp_servers + origins) + mcpServerStatus/list
//   plugins       plugin/installed + plugin/read per plugin
//   skills        skills/list, no filesystem fallback (the server is the answer)
//   switches      config/batchWrite (Codex's own toml_edit writer, keeping
//                 comments) and skills/config/write, then config/mcpServer/reload
//
// config/read returns the effective config VALUES, env blocks and bearer tokens
// included, so every row is built through the same redactor as the TOML
// excerpts (rawJson / redactUrl / redactCommandLine) and nothing from it is
// forwarded whole. Codex's error messages stay in the agent's log too: a config
// it cannot parse is quoted back line by line.
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

// A skills/list answer as rows, through `add` (false once the cap is hit).
// `configured(path)` says whether a [[skills.config]] entry names that file.
function skillRows(res, ctx, projects, configured, add) {
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
        enabledBy: configured(s.path) ? 'skills.config' : 'default',
        toggle: scope === 'plugin' ? 'plugin' : 'skill',
        raw: rawJson({ name: s.name, description: s.description, path: s.path, scope: s.scope, enabled: s.enabled, pluginId: s.pluginId }),
      });
      if (!ok) return;
    }
  }
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
    skillRows(res, ctx, projects, (p) => cfg.has(p), add);
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

/* ---------- native: the shared app-server answers ---------- */

const nrpc = (ctx, method, params, timeoutMs = RPC_TIMEOUT_MS) => ctx.codexNativeRpc(method, params, { timeoutMs });

// A Codex error, kept on the machine. Same rule as logStderr above.
function logRpc(what, e) {
  console.warn(`[extensions] codex ${what} failed: ${String((e && e.message) || e).slice(-2000)}`);
}

// Every page of mcpServerStatus/list, as one array. toolsAndAuthOnly is all the
// rows read (the tool names, auth, the runtime state) and spares resources and
// templates. Bounded: a server that keeps handing out cursors is not a reason to
// spin.
async function mcpStatusNative(ctx) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const params = { detail: 'toolsAndAuthOnly' };
    if (cursor) params.cursor = cursor;
    const r = await nrpc(ctx, 'mcpServerStatus/list', params);
    if (!r || !Array.isArray(r.data)) return page ? out : null;
    out.push(...r.data);
    cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : null;
    if (!cursor || out.length >= MAX_ENTRIES) break;
  }
  return out;
}

// Which config layer set this key, from config/read's `origins` (one entry per
// leaf, `mcp_servers.crawlseo.command` -> { name: { type: 'user', file } }).
function originOf(origins, prefix) {
  if (!obj(origins)) return null;
  const want = `${prefix}.`;
  for (const [k, v] of Object.entries(origins)) {
    if ((k === prefix || k.startsWith(want)) && obj(v) && obj(v.name)) return v.name;
  }
  return null;
}

// A keyPath segment for config/value/write and config/batchWrite. Bare when it
// is plainly a word (`pdf@openai-primary-runtime` stays bare, as Codex's own TUI
// writes it), quoted otherwise so a dot in a name is never read as a separator
// (parse_key_path upstream: `\` escapes inside a quoted segment).
function keySeg(s) {
  const v = String(s);
  return /^[A-Za-z0-9_@-]+$/.test(v) ? v : `"${v.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function mcpRowsNative(cfg, status, pluginEnabled) {
  const servers = obj(cfg.config.mcp_servers) || {};
  const byName = new Map((status || []).filter((s) => s && typeof s.name === 'string').map((s) => [s.name, s]));
  const rows = [];
  let truncated = false;
  const push = (row, name) => {
    if (rows.length >= MAX_ENTRIES) { truncated = true; return false; }
    rows.push(withFullName(row, name));
    return true;
  };
  for (const [name, raw] of Object.entries(servers)) {
    const s = obj(raw) || {};
    const st = byName.get(name) || {};
    byName.delete(name);
    const layer = originOf(cfg.origins, `mcp_servers.${name}`);
    // Writes go to the user's config.toml only (apply_edits upstream refuses any
    // other file), so a server another layer set is shown and not switched.
    const user = !layer || layer.type === 'user';
    const project = layer && layer.type === 'project';
    const kind = typeof s.url === 'string' && s.url ? 'http' : 'stdio';
    const target = kind === 'http' ? redactUrl(s.url) : redactCommandLine([s.command, ...(Array.isArray(s.args) ? s.args : [])].filter((x) => typeof x === 'string').join(' '));
    const row = {
      name: clip(name, 160),
      scope: project ? 'project' : 'user',
      sourceFile: user ? '~/.codex/config.toml' : project ? '.codex/config.toml' : clip(layer.file || layer.type, 200),
      transport: kind,
      target: String(target).slice(0, MAX_TARGET),
      hasEnv: !!((obj(s.env) && Object.keys(s.env).length) || (Array.isArray(s.env_vars) && s.env_vars.length)),
      hasHeaders: !!(obj(s.http_headers) || obj(s.env_http_headers) || s.bearer_token_env_var),
      hasOauth: st.authStatus === 'oAuth',
      enabled: s.enabled !== false,
      enabledBy: originOf(cfg.origins, `mcp_servers.${name}.enabled`) ? 'enabled-key' : 'config',
      toggle: user ? 'mcp' : null,
      raw: rawJson(s, name),
    };
    if (typeof s.disabled_reason === 'string' && s.disabled_reason) row.disabledReason = clip(s.disabled_reason, 200);
    if (typeof s.startup_timeout_sec === 'number') row.timeoutMs = Math.round(s.startup_timeout_sec * 1000);
    if (typeof s.tool_timeout_sec === 'number') row.toolTimeoutMs = Math.round(s.tool_timeout_sec * 1000);
    if (typeof st.authStatus === 'string') row.authStatus = clip(st.authStatus, 40);
    if (!push(row, name)) return { rows, truncated };
  }
  // Servers a plugin ships are in no config the person wrote; the status list is
  // where they are named, with the plugin they came from. One with no plugin and
  // no config entry is Codex's own (the ChatGPT apps connector), which the CLI's
  // `codex mcp list` never showed either.
  for (const st of byName.values()) {
    if (!st.pluginId) continue;
    const origin = typeof st.httpOrigin === 'string' && st.httpOrigin ? st.httpOrigin : null;
    const row = {
      name: clip(st.name, 160),
      scope: 'plugin',
      sourceFile: `${String(st.pluginId).split('@')[0]} plugin`,
      transport: origin ? 'http' : 'stdio',
      target: origin ? redactUrl(origin).slice(0, MAX_TARGET) : '',
      hasEnv: false,
      hasHeaders: st.authStatus === 'bearerToken',
      hasOauth: st.authStatus === 'oAuth',
      enabled: pluginEnabled.has(st.pluginId) ? pluginEnabled.get(st.pluginId) : true,
      enabledBy: 'plugin',
      toggle: 'plugin',
      pluginId: clip(st.pluginId, 200),
      raw: rawJson({ name: st.name, pluginId: st.pluginId, httpOrigin: origin, authStatus: st.authStatus }),
    };
    if (typeof st.authStatus === 'string') row.authStatus = clip(st.authStatus, 40);
    if (!push(row, st.name)) break;
  }
  return { rows, truncated };
}

const isoSecs = (n) => (typeof n === 'number' && Number.isFinite(n) ? new Date(n * 1000).toISOString() : null);

async function pluginsNative(ctx, cfg) {
  let res;
  try {
    res = await nrpc(ctx, 'plugin/installed', {});
  } catch (e) {
    logRpc('plugin/installed', e);
    res = null;
  }
  if (!res || !Array.isArray(res.marketplaces)) return { rows: [], truncated: false, marketplaces: [], unread: true, enabled: new Map() };
  const plugins = obj(cfg.config.plugins) || {};
  const found = [];
  const markets = new Map();
  for (const m of res.marketplaces) {
    if (!m || typeof m.name !== 'string') continue;
    for (const p of (Array.isArray(m.plugins) ? m.plugins : [])) {
      if (!p || typeof p.id !== 'string' || p.installed === false) continue;
      found.push({ m, p });
      if (!markets.has(m.name)) {
        markets.set(m.name, { name: clip(m.name, 120), source: m.path ? 'local' : 'remote', repo: null, installLocation: clip(typeof m.path === 'string' ? m.path : null, 400) });
      }
    }
  }
  const truncated = found.length > MAX_ENTRIES;
  // plugin/read is the only place a plugin's contents are counted (skills,
  // servers, hooks). One per plugin, side by side; a plugin that will not read
  // still gets its row, just without the counts.
  const details = await Promise.all(found.slice(0, MAX_ENTRIES).map(async ({ m, p }) => {
    const params = { pluginName: p.name };
    if (typeof m.path === 'string' && m.path) params.marketplacePath = m.path;
    else params.remoteMarketplaceName = m.name;
    try { return (await nrpc(ctx, 'plugin/read', params)) || null; } catch { return null; }
  }));
  const enabled = new Map();
  const rows = found.slice(0, MAX_ENTRIES).map(({ m, p }, i) => {
    const d = obj(details[i]) && obj(details[i].plugin) ? details[i].plugin : null;
    const iface = obj(p.interface) || {};
    const src = obj(p.source) || {};
    const dir = src.type === 'local' && typeof src.path === 'string' ? src.path : null;
    const repo = src.type === 'git' && typeof src.url === 'string' ? src.url : null;
    const count = (k) => (d && Array.isArray(d[k]) ? d[k].length : 0);
    enabled.set(p.id, p.enabled !== false);
    return withFullName({
      id: clip(p.id, 200),
      name: clip(p.name, 120),
      marketplace: clip(m.name, 120),
      version: clip(p.localVersion || p.version, 80),
      scope: 'user',
      enabled: p.enabled !== false,
      enabledBy: originOf(cfg.origins, `plugins.${p.id}.enabled`) ? 'enabled-key' : 'default',
      toggle: 'plugin',
      installPath: dir,
      installedAt: isoSecs(p.installedAt),
      lastUpdated: null,
      manifest: {
        displayName: clip(iface.displayName || p.name, 120),
        description: clip(iface.shortDescription || (d && d.description)),
        author: clip(typeof iface.developerName === 'string' ? iface.developerName : null, 120),
        homepage: clip(typeof iface.websiteUrl === 'string' ? redactUrl(iface.websiteUrl) : null, 300),
        repository: clip(repo ? redactUrl(repo) : null, 300),
        license: null,
        keywords: Array.isArray(p.keywords) ? p.keywords.filter((k) => typeof k === 'string').slice(0, 20) : [],
      },
      components: d ? { skills: count('skills'), commands: 0, agents: 0, hooks: count('hooks'), mcpServers: count('mcpServers'), lspServers: 0 } : null,
      raw: rawJson({ id: p.id, name: p.name, marketplace: m.name, version: p.localVersion || p.version, installed: p.installed, enabled: p.enabled, installPolicy: p.installPolicy, authPolicy: p.authPolicy, availability: p.availability, config: plugins[p.id] }),
    }, p.id);
  });
  return { rows, truncated, marketplaces: [...markets.values()], enabled };
}

async function skillsNative(ctx, projects, cfg) {
  let res;
  try {
    res = await nrpc(ctx, 'skills/list', { cwds: projects.length ? projects : [ctx.home] });
  } catch (e) {
    logRpc('skills/list', e);
    res = null;
  }
  if (!res || !Array.isArray(res.data)) return { rows: [], truncated: false, unread: true };
  const skills = obj(cfg.config.skills);
  const configured = new Set((skills && Array.isArray(skills.config) ? skills.config : []).map((e) => e && e.path).filter((p) => typeof p === 'string'));
  const rows = [];
  let truncated = false;
  const seen = new Set();
  skillRows(res, ctx, projects, (p) => configured.has(p), (r) => {
    if (seen.has(r.path)) return true;
    if (rows.length >= MAX_ENTRIES) { truncated = true; return false; }
    seen.add(r.path);
    rows.push(r);
    return true;
  });
  return { rows, truncated };
}

async function readConfigNative(ctx) {
  let cfg;
  try {
    cfg = await nrpc(ctx, 'config/read', {});
  } catch (e) {
    // Never forwarded: Codex quotes a config.toml it cannot parse line by line.
    logRpc('config/read', e);
    throw fail('codex could not read its config.toml; run `codex mcp list` on the machine to see why', 'CLI_FAILED');
  }
  if (!cfg || !obj(cfg.config)) throw fail('codex returned no config', 'CLI_FAILED');
  return cfg;
}

async function listNative(ctx, projects) {
  const [cfg, status] = await Promise.all([
    readConfigNative(ctx),
    mcpStatusNative(ctx).catch((e) => { logRpc('mcpServerStatus/list', e); return null; }),
  ]);
  const [plugins, skills] = await Promise.all([pluginsNative(ctx, cfg), skillsNative(ctx, projects, cfg)]);
  const mcp = mcpRowsNative(cfg, status, plugins.enabled);
  const unread = {};
  if (plugins.unread) unread.plugins = true;
  if (skills.unread) unread.skills = true;
  return {
    mcp: mcp.rows,
    plugins: plugins.rows,
    skills: skills.rows,
    marketplaces: plugins.marketplaces,
    truncated: { mcp: mcp.truncated, plugins: plugins.truncated, skills: skills.truncated },
    unread: Object.keys(unread).length ? unread : undefined,
  };
}

// One switch through Codex's own writer. config/batchWrite rather than
// config/value/write for `reloadUserConfig`, which applies the change to threads
// already loaded; Codex's TUI writes a plugin switch with exactly this edit
// (`plugins.<id>` upserted with `{ enabled }`, tui/src/app/background_requests.rs).
// A layer above the user's that still wins is said, not hidden.
async function writeNative(ctx, edits) {
  let r;
  try {
    r = await nrpc(ctx, 'config/batchWrite', { edits, reloadUserConfig: true });
  } catch (e) {
    logRpc('config/batchWrite', e);
    throw fail(redactDetail((e && e.message) || 'codex refused the change', 300), 'WRITE_FAILED');
  }
  const over = r && obj(r.overriddenMetadata);
  return { file: (r && typeof r.filePath === 'string' && r.filePath) || null, notes: over && over.message ? [redactDetail(over.message, 300)] : [] };
}

async function toggleNative(ctx, projects, req) {
  const fresh = await listNative(ctx, projects);
  const fallbackFile = configPath(ctx);
  let applied = [];
  let notes = [];
  let restartNeeded = true;
  if (req.kind === 'mcp') {
    const row = fresh.mcp.find((r) => r.name === req.name);
    if (!row) throw fail(`no MCP server named ${req.name}`, 'UNKNOWN_ITEM');
    if (row.toggle !== 'mcp') throw fail(row.scope === 'plugin' ? `${req.name} comes from a plugin; switch the plugin instead` : `${req.name} is set outside ~/.codex/config.toml; change it there`, 'NOT_SUPPORTED');
    const name = fullName(row, req.name);
    const w = await writeNative(ctx, [{ keyPath: `mcp_servers.${keySeg(name)}.enabled`, value: !!req.enabled, mergeStrategy: 'replace' }]);
    applied = [{ file: w.file || fallbackFile, key: `mcp_servers.${name}.enabled` }];
    notes = w.notes;
    // Loaded threads pick the server set up again, so the switch is live.
    try { await nrpc(ctx, 'config/mcpServer/reload', undefined); restartNeeded = false; } catch (e) { logRpc('config/mcpServer/reload', e); }
  } else if (req.kind === 'plugin') {
    const row = fresh.plugins.find((r) => r.id === req.name);
    if (!row) throw fail(`no plugin named ${req.name}`, 'UNKNOWN_ITEM');
    const id = fullName(row, req.name);
    const w = await writeNative(ctx, [{ keyPath: `plugins.${keySeg(id)}`, value: { enabled: !!req.enabled }, mergeStrategy: 'upsert' }]);
    applied = [{ file: w.file || fallbackFile, key: `plugins."${id}".enabled` }];
    notes = w.notes;
  } else if (req.kind === 'skill') {
    const row = fresh.skills.find((r) => r.name === req.name && (req.path ? r.path === req.path : true) && (r.project && req.project ? r.project === req.project : true));
    if (!row) throw fail(`no skill named ${req.name}`, 'UNKNOWN_ITEM');
    if (row.toggle !== 'skill') throw fail(`${req.name} comes from a plugin; switch the plugin instead`, 'NOT_SUPPORTED');
    try {
      await nrpc(ctx, 'skills/config/write', { path: row.path, enabled: !!req.enabled });
    } catch (e) {
      logRpc('skills/config/write', e);
      throw fail(redactDetail((e && e.message) || 'codex refused the change', 300), 'WRITE_FAILED');
    }
    applied = [{ file: fallbackFile, key: 'skills.config' }];
  } else {
    throw fail(`unknown kind ${req.kind}`, 'UNKNOWN_ITEM');
  }
  const out = { ok: true, applied, restartNeeded };
  if (notes.length) out.notes = notes;
  return out;
}

async function list(ctx, projects) {
  if (ctx.codexNativeRpc) return listNative(ctx, projects);
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
  let data;
  if (ctx.codexNativeRpc) {
    data = await mcpStatusNative(ctx).catch((e) => { logRpc('mcpServerStatus/list', e); return null; });
  } else {
    const res = await rpc(ctx, 'mcpServerStatus/list', {});
    data = res && Array.isArray(res.data) ? res.data : null;
  }
  if (!data) return { project: null, servers: [], unavailable: true };
  return {
    project: null,
    servers: data.filter((s) => s && typeof s.name === 'string').slice(0, MAX_ENTRIES).map((s) => {
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
  if (ctx.codexNativeRpc) return toggleNative(ctx, projects, req);
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

module.exports = { list, health, toggle, cliVersion, pluginFromPath, skillConfig, rewriteToml, keySeg };
