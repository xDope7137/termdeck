'use strict';

// U8 — read-only MCP servers list. Surfaces the MCP servers configured for a
// session so you can see what tools the agent can reach. Config-only: there is
// no live-status RPC for either engine (the CLI holds connection state), so a
// listed server means "configured", not "connected".
//
// Sources:
//   Claude — ~/.claude.json `mcpServers` (user) + `projects[cwd].mcpServers`
//            (project), plus a project-root `.mcp.json`.
//   Codex  — `[mcp_servers.*]` sections in $CODEX_HOME/config.toml (best-effort
//            line scan — no TOML dep; nested/inline-table configs may be partial).
//
// Secrets never cross the wire: auth headers, env values, and URL userinfo are
// dropped — only a boolean `auth` flag survives. (The API is owner-scoped, but a
// web UI should never render a bearer token.)

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const MAX_TARGET = 300;
const R = '«redacted»';

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// A path segment that is a credential rather than a name: a known token prefix,
// or a long run of key-shaped characters with a digit in it (or long enough that
// no folder is called that). Hosted MCP servers put the key in the path
// (`https://mcp.zapier.com/api/mcp/s/<base64>/mcp`), so query stripping alone
// is not enough. `modelcontextprotocol` stays; `a1B2...` does not.
const TOKEN_PREFIX = /^(?:sk-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza)[A-Za-z0-9_\-]{8,}/;
function tokenSegment(seg) {
  let s = String(seg || '');
  try { s = decodeURIComponent(s); } catch {}
  if (TOKEN_PREFIX.test(s)) return true;
  if (!/^[A-Za-z0-9_\-=+/]{20,}$/.test(s)) return false;
  return /\d/.test(s) || s.length >= 32;
}

// The path of a URL (everything after `scheme://authority`) with every
// token-shaped segment replaced.
function redactUrlPath(u) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]*)(\/[^?#\s]*)?(.*)$/i.exec(String(u || ''));
  if (!m || !m[2]) return String(u || '');
  return m[1] + m[2].split('/').map((seg) => (tokenSegment(seg) ? R : seg)).join('/') + m[3];
}

// Strip credentials, query, fragment and token-shaped path segments from a URL
// for display.
function redactUrl(u) {
  const s = String(u || '');
  try {
    const x = new URL(s);
    if (!/^[a-z][a-z0-9+.-]*:$/i.test(x.protocol)) return s;
    x.username = '';
    x.password = '';
    x.search = '';
    x.hash = '';
    return redactUrlPath(x.toString());
  } catch {
    return redactUrlPath(s.replace(/\/\/[^@/\s]*@/, '//').replace(/[?#].*$/, ''));
  }
}

// A command line as it may leave the machine. MCP servers and hooks are commonly
// configured with the secret on the command line itself (a connection string, an
// --api-key, TOKEN=... in front), and these rows are shown in the browser, so they
// pass through here first: credentials in URLs, values of secret-named flags and
// variables, and anything shaped like a key become «redacted». The program and the
// shape of the line stay readable, which is what the row is for.
const SECRET_WORD = '(?:key|token|secret|passw(?:or)?d|pwd|auth|credential|bearer|cookie|session)';
// A header that carries a credential, and its value: `Authorization: Bearer x`
// (the scheme word and the token both go), `X-Api-Key: x`.
const SECRET_HEADER = /\b((?:Proxy-)?Authorization|X-[\w-]*(?:Key|Token|Secret|Auth)[\w-]*|Cookie)(\s*:\s*)(?:(?:Bearer|Basic|Token|Digest)\s+)?[^\s"']+/gi;
// `-H` / `--header` take a whole header as their value. A value the header rule
// above already cleaned keeps its name; any other value goes.
const HEADER_FLAG = /(^|\s)(-H|--headers?)(=|\s+)("[^"]*"|'[^']*'|\S+)/g;
function redactCommandLine(line) {
  return String(line || '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${R}@`)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, (u) => redactUrlPath(u))
    .replace(new RegExp(`([?&][\\w.-]*${SECRET_WORD}[\\w.-]*=)[^&\\s"']+`, 'gi'), `$1${R}`)
    .replace(SECRET_HEADER, `$1$2${R}`)
    .replace(HEADER_FLAG, (m, pre, flag, sep, v) => (v.includes(R) ? m : `${pre}${flag}${sep}${R}`))
    .replace(new RegExp(`(--?[\\w-]*${SECRET_WORD}[\\w-]*)(=|\\s+)("[^"]*"|'[^']*'|\\S+)`, 'gi'), `$1$2${R}`)
    .replace(new RegExp(`(^|\\s)([A-Z0-9_]*${SECRET_WORD}[A-Z0-9_]*=)("[^"]*"|'[^']*'|\\S+)`, 'gi'), `$1$2${R}`)
    .replace(/\b(?:sk-|ghp_|gho_|github_pat_|xox[abprs]-|AKIA|AIza)[A-Za-z0-9_\-]{8,}/g, R)
    .replace(/\b[A-Za-z0-9_\-]{40,}\b/g, R);
}

// A word of an argv that makes the NEXT word a secret: `--api-key <v>`,
// `-H <header>`.
function secretFlag(word) {
  const w = String(word || '');
  if (!/^--?[\w-]*$/.test(w)) return false;
  return w === '-H' || /^--headers?$/.test(w) || new RegExp(SECRET_WORD, 'i').test(w);
}

// Normalize one Claude mcpServers entry to the redacted wire shape.
function claudeServer(name, cfg, scope, source) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const type = c.type || (c.url ? 'http' : 'stdio');
  let target = '';
  let auth = false;
  if (c.url) {
    target = redactUrl(c.url);
    auth = !!(c.headers && Object.keys(c.headers).length) || /\/\/[^@/]*@/.test(String(c.url));
  } else {
    const args = Array.isArray(c.args) ? c.args : [];
    target = redactCommandLine([c.command, ...args].filter(Boolean).join(' '));
    auth = !!(c.env && Object.keys(c.env).length);
  }
  return { name: String(name).slice(0, 120), scope, transport: type, target: String(target).slice(0, MAX_TARGET), auth, source };
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function grokHome() {
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok');
}

// Best-effort [mcp_servers.NAME] TOML section scan, shared by readCodex/readGrok
// (both CLIs configure MCP servers the same way — grok's own docs, 07-mcp-servers.md,
// describe the identical mcp_servers.<name> table shape as Codex's config.toml).
function scanMcpServersToml(text, scope, source) {
  const servers = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const header = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/.exec(line);
    if (header) {
      cur = { name: header[1].trim().replace(/^["']|["']$/g, ''), scope, transport: 'stdio', target: '', auth: false, source };
      servers.push(cur);
      continue;
    }
    if (/^\s*\[/.test(line)) { cur = null; continue; } // left the section
    if (!cur) continue;
    const cmd = /^\s*command\s*=\s*"([^"]*)"/.exec(line);
    if (cmd) cur.target = redactCommandLine(cmd[1]).slice(0, MAX_TARGET);
    const url = /^\s*url\s*=\s*"([^"]*)"/.exec(line);
    if (url) { cur.transport = 'http'; cur.target = redactUrl(url[1]).slice(0, MAX_TARGET); }
  }
  return servers;
}

// Best-effort TOML scan for [mcp_servers.NAME] sections + their command/url.
async function readCodex() {
  let text;
  try {
    text = await fsp.readFile(path.join(codexHome(), 'config.toml'), 'utf8');
  } catch {
    return [];
  }
  return scanMcpServersToml(text, 'user', '~/.codex/config.toml');
}

// Same TOML shape as Codex, two scopes: user (~/.grok/config.toml) + project
// (<cwd>/.grok/config.toml). Best-effort/minimal per the build brief — grok's TOML
// nesting hasn't been verified as deeply as Codex's, so this only covers the
// top-level [mcp_servers.NAME] table form; nested/inline-table configs may be partial
// (same caveat readCodex already carries).
async function readGrok(cwd) {
  const out = [];
  try {
    out.push(...scanMcpServersToml(await fsp.readFile(path.join(grokHome(), 'config.toml'), 'utf8'), 'user', '~/.grok/config.toml'));
  } catch {}
  try {
    out.push(...scanMcpServersToml(await fsp.readFile(path.join(cwd, '.grok', 'config.toml'), 'utf8'), 'project', '.grok/config.toml'));
  } catch {}
  return out;
}

async function readMcpServers(cwd, engine) {
  const eng = engine === 'codex' ? 'codex' : engine === 'grok' ? 'grok' : 'claude';
  if (eng === 'codex') return { engine: 'codex', cwd, servers: await readCodex() };
  if (eng === 'grok') return { engine: 'grok', cwd, servers: await readGrok(cwd) };

  const servers = [];
  const j = await readJson(path.join(os.homedir(), '.claude.json'));
  if (j) {
    for (const [name, cfg] of Object.entries(j.mcpServers || {})) servers.push(claudeServer(name, cfg, 'user', '~/.claude.json'));
    const proj = j.projects && j.projects[cwd] && j.projects[cwd].mcpServers;
    for (const [name, cfg] of Object.entries(proj || {})) servers.push(claudeServer(name, cfg, 'project', '~/.claude.json'));
  }
  const dotMcp = await readJson(path.join(cwd, '.mcp.json'));
  if (dotMcp) for (const [name, cfg] of Object.entries(dotMcp.mcpServers || {})) servers.push(claudeServer(name, cfg, 'project', '.mcp.json'));

  return { engine: 'claude', cwd, servers };
}

module.exports = { readMcpServers, redactCommandLine, redactUrl, redactUrlPath, tokenSegment, secretFlag };

// ponytail: runnable check — node lib/mcp-config.js
if (require.main === module) {
  const assert = require('assert');
  const fs = require('fs');

  // Redaction: creds, query, and fragment all dropped.
  assert.equal(redactUrl('https://u:p@host:8931/mcp?token=abc#x'), 'https://host:8931/mcp');

  // http entry with auth headers → auth:true, no header values leak.
  const http = claudeServer('x', { type: 'http', url: 'http://127.0.0.1:8931/mcp', headers: { Authorization: 'Basic zzz' } }, 'user', '~/.claude.json');
  assert.equal(http.transport, 'http');
  assert.equal(http.target, 'http://127.0.0.1:8931/mcp');
  assert.equal(http.auth, true);
  assert.ok(!JSON.stringify(http).includes('zzz'), 'no secret in output');

  // stdio entry with env → auth:true, command+args shown.
  const stdio = claudeServer('y', { command: 'npx', args: ['-y', 'some-mcp'], env: { API_KEY: 'sekret' } }, 'project', '.mcp.json');
  assert.equal(stdio.transport, 'stdio');
  assert.equal(stdio.target, 'npx -y some-mcp');
  assert.equal(stdio.auth, true);
  assert.ok(!JSON.stringify(stdio).includes('sekret'), 'no env value in output');

  // Project-root .mcp.json is picked up under scope 'project'.
  (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
    fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node', args: ['srv.js'] } } }));
    const out = await readMcpServers(tmp, 'claude');
    assert.equal(out.engine, 'claude');
    assert.ok(out.servers.some((s) => s.name === 'local' && s.scope === 'project' && s.source === '.mcp.json'));

    // Grok resolves to its OWN engine label (not 'claude') and reads project
    // .grok/config.toml — same [mcp_servers.NAME] TOML shape as Codex.
    process.env.GROK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
    fs.mkdirSync(path.join(tmp, '.grok'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.grok', 'config.toml'), '[mcp_servers.remote]\nurl = "http://127.0.0.1:9/mcp"\n');
    const grokOut = await readMcpServers(tmp, 'grok');
    assert.equal(grokOut.engine, 'grok');
    assert.ok(grokOut.servers.some((s) => s.name === 'remote' && s.scope === 'project' && s.source === '.grok/config.toml' && s.transport === 'http'));
    fs.rmSync(process.env.GROK_HOME, { recursive: true, force: true });

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('mcp-config self-check ok');
  })().catch((e) => { console.error(e); process.exit(1); });
}
