'use strict';

// What an MCP server's URL or command line may look like once it leaves the
// machine. Server rows (Settings, Extensions) and hook rows (machine config) are
// shown in the browser, and a web UI must never render a bearer token.

const R = '«redacted»';

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

module.exports = { redactCommandLine, redactUrl, secretFlag };
