'use strict';

// The `extensions` agent op (features/01-extensions): every MCP server, plugin
// and skill an engine is configured with on this machine, their connection
// health, and a switch for each. agent/capabilities.js builds the context (the
// engine homes, the executables, how to run one, the projects it may touch) and
// this file answers the three ops for whichever engine was asked.
//
// The rails, all enforced here and none read from the request:
//   * TERMDECK_CONFIG_READONLY in the agent's env refuses every toggle before a
//     file is opened, and `list` says so, so the browser can lock the switches.
//   * The master names the projects (Termdeck's added projects on this machine);
//     the context's `projectOk` drops any it cannot vouch for, and a toggle may
//     only touch a project that survived.
//   * Writes change one key of one named item. Nothing is added, removed or
//     installed, and no file is deleted.
//
// Shipped to agents by name (AGENT_FILES in master.js): siblings and builtins only.

const claude = require('./extensions-claude');
const codex = require('./extensions-codex');
const grok = require('./extensions-grok');

const ENGINES = { claude, codex, grok };
const OPS = new Set(['list', 'health', 'toggle']);
const KINDS = new Set(['mcp', 'plugin', 'skill']);
const MAX_PROJECTS = 100;

const fail = (message, code) => Object.assign(new Error(message), { code });

function readonlyFrom(env = process.env) {
  const v = String(env.TERMDECK_CONFIG_READONLY || '').trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

// The projects the master named, minus any the context will not vouch for. The
// strings are kept as sent: ~/.claude.json keys its projects by the cwd a chat
// was started in, which is the same string Termdeck read off that chat.
function cleanProjects(ctx, list) {
  const out = [];
  for (const p of Array.isArray(list) ? list.slice(0, MAX_PROJECTS) : []) {
    if (typeof p !== 'string' || !p || out.includes(p)) continue;
    if (ctx.projectOk && !ctx.projectOk(p)) continue;
    out.push(p);
  }
  return out;
}

async function handle(op, payload, ctx) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const name = OPS.has(op) ? op : 'list';
  const engine = p.engine === 'codex' || p.engine === 'grok' ? p.engine : 'claude';
  const impl = ENGINES[engine];
  if (!impl) throw fail(`${engine} extensions are not supported yet`, 'NOT_SUPPORTED');
  const exe = ctx.exes ? ctx.exes[engine] : null;
  // Claude's config is files Termdeck can read without the CLI; Codex and Grok
  // answer only through theirs.
  if (!exe && engine !== 'claude') throw fail(`${engine} is not installed on this machine`, 'ENGINE_MISSING');
  const ectx = { ...ctx, exe };
  const projects = cleanProjects(ctx, p.projects);
  const readonly = !!ctx.readonly;

  if (name === 'list') {
    const [body, cliVersion] = await Promise.all([impl.list(ectx, projects), impl.cliVersion(ectx).catch(() => null)]);
    return { engine, readonly, cliVersion, generatedAt: new Date().toISOString(), projects, ...body };
  }
  if (name === 'health') {
    if (!exe) throw fail(`${engine} is not installed on this machine`, 'ENGINE_MISSING');
    const body = await impl.health(ectx, projects, typeof p.project === 'string' ? p.project : null);
    return { engine, checkedAt: new Date().toISOString(), ...body };
  }
  // toggle
  if (readonly) throw fail('This machine is read-only (TERMDECK_CONFIG_READONLY)', 'CONFIG_READONLY');
  if (!KINDS.has(p.kind)) throw fail(`unknown kind ${p.kind}`, 'UNKNOWN_ITEM');
  if (typeof p.name !== 'string' || !p.name || p.name.length > 300) throw fail('name is required', 'UNKNOWN_ITEM');
  if (typeof p.enabled !== 'boolean') throw fail('enabled must be true or false', 'UNKNOWN_ITEM');
  if (p.project != null && !projects.includes(p.project)) throw fail('that folder is not one of your Termdeck projects on this machine', 'UNKNOWN_ITEM');
  const req = {
    kind: p.kind,
    name: p.name,
    enabled: p.enabled,
    scope: typeof p.scope === 'string' ? p.scope : null,
    project: typeof p.project === 'string' ? p.project : null,
    path: typeof p.path === 'string' ? p.path : null,
    allProjects: p.allProjects === true,
  };
  return impl.toggle(ectx, projects, req);
}

module.exports = { handle, readonlyFrom, cleanProjects };
