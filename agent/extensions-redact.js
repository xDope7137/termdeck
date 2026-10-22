'use strict';

// The one redactor for the Extensions section (features/01-extensions). Every
// MCP server, plugin and skill row the agent sends carries a `raw` excerpt of
// its own config entry, and those entries are where people keep secrets: an
// `env` block with an API key, an `Authorization` header, an OAuth client
// secret, a token in a URL. This runs ON THE AGENT, before anything leaves the
// machine, and it serves all three engines: JSON entries (Claude, plugin
// manifests, the CLIs' --json output) and TOML table excerpts (Codex, Grok).
//
// The rule is stated once so it can be tested once:
//   * container keys (env, headers, oauth, ...) lose their whole value
//   * any key whose name looks like a secret loses its value
//   * URLs lose userinfo, query, fragment and token-shaped path segments
//   * command lines go through redactCommandLine (secret flags, KEY=... prefixes,
//     token-shaped words)
// Only the booleans the rows carry (hasEnv, hasHeaders, hasOauth) say that one
// of those was set.
//
// Shipped to agents by name (AGENT_FILES in master.js): siblings and builtins only.

const { redactCommandLine, redactUrl, secretFlag } = require('./mcp-config');

const R = '«redacted»';
const MAX_RAW = 6 * 1024;

// Keys whose whole value is a secret store, whatever is inside.
const CONTAINERS = new Set([
  'env', 'headers', 'headershelper', 'oauth', 'http_headers', 'env_http_headers',
  'bearer_token', 'bearer_token_env_var', 'bearer_token_file', 'auth', 'credentials',
]);
// Keys that are a secret by NAME. `keywords` and `key` alone are fine (manifest
// keywords, a table key); a key that ends or starts with key-ish words is not.
const SECRET_KEY = /(token|secret|passw(or)?d|pwd|credential|cookie|bearer|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?key|auth(?!or)|session[-_]?id)/i;
const URL_KEY = /(^|_)(url|uri|endpoint|homepage|repository|server)$/i;
const CMD_KEY = /^(command|args|cmd|run)$/i;

function secretKey(k) {
  const key = String(k);
  return CONTAINERS.has(key.toLowerCase()) || SECRET_KEY.test(key);
}

function redactString(key, v) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return redactUrl(v);
  if (URL_KEY.test(String(key || ''))) return redactUrl(v);
  return redactCommandLine(v);
}

// A deep copy of one JSON entry with every secret replaced.
function redactValue(v, key = '', depth = 0) {
  if (depth > 12) return R;
  if (v == null || typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v === 'string') return redactString(key, v);
  if (Array.isArray(v)) {
    // args: each element is a word of a command line, and a secret flag's value
    // is the NEXT word, so the array is redacted as one line and split back.
    if (CMD_KEY.test(String(key)) && v.every((x) => typeof x === 'string')) {
      return v.map((word, i) => {
        if (i > 0 && (secretFlag(v[i - 1]) || (/^--?[\w-]*$/.test(v[i - 1]) && SECRET_KEY.test(v[i - 1])))) return R;
        return redactCommandLine(word);
      });
    }
    return v.map((x) => redactValue(x, key, depth + 1));
  }
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = secretKey(k) && x != null && x !== '' && x !== false ? R : redactValue(x, k, depth + 1);
    }
    return out;
  }
  return R;
}

// The redacted entry as indented JSON, clipped for the wire. `name` labels it
// the way its file does (`{ "github": {...} }`) without the label itself being
// read as a key: a server called "auth" is not a secret.
function rawJson(entry, name = null) {
  const v = redactValue(entry);
  const text = JSON.stringify(name == null ? v : { [name]: v }, null, 2);
  return text && text.length > MAX_RAW ? `${text.slice(0, MAX_RAW)}\n…` : text || '';
}

// The body of a multi-line string is text, and pasted config is a common thing
// to find in it: `API_KEY = "x"` or `token: x` loses its value on top of the
// command-line rules.
const SECRET_ASSIGN = new RegExp(`([\\w.-]*${SECRET_KEY.source}[\\w.-]*["']?\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,]+)`, 'gi');
const assignOut = (t) => t.replace(SECRET_ASSIGN, (m, k, v) => (v.includes(R) ? m : `${k}"${R}"`));
function textBody(key, body) {
  return assignOut(redactString(key, body));
}

// Free text a CLI printed about a server (a health detail, a status line, an
// error message): the command-line rules, URL paths and `KEY = value` pairs.
// `max` clips after redacting, so a cut never leaves half a secret readable.
function redactDetail(v, max = 400) {
  if (v == null || v === '') return null;
  const t = assignOut(redactCommandLine(String(v)));
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// A TOML excerpt with every secret value replaced. Line based, like the editor
// (lib/toml-edit.js), but a value is followed across lines: a multi-line array
// and a """ or ''' string are one value, so a line inside one is never read as
// a header or a key. A `[x.env]` sub-table loses every value under it, a value
// of a secret or container key loses every string in it, and any other string
// is cleaned as a URL or a command line. Inside an array, the word after a
// secret flag (`"--api-key", "x"`) goes, as it does in a JSON args list.
function redactToml(text) {
  const out = [];
  let inSecretTable = false;
  let cur = null; // the value being read: { key, secret, depth, prev, ml }

  // One stretch of a value's text, scanned with `cur` carried across lines.
  const scan = (src) => {
    let o = '';
    let i = 0;
    while (i < src.length) {
      if (cur.ml) {
        const end = src.indexOf(cur.ml, i);
        const body = end < 0 ? src.slice(i) : src.slice(i, end);
        o += !body ? '' : cur.secret || secretFlag(cur.prev) ? R : textBody(cur.key, body);
        if (end < 0) return o;
        o += cur.ml;
        i = end + 3;
        cur.ml = null;
        continue;
      }
      const c = src[i];
      if (c === '#') return o + src.slice(i);
      if (c === '[' || c === '{') { cur.depth += 1; o += c; i += 1; continue; }
      if (c === ']' || c === '}') { cur.depth -= 1; o += c; i += 1; continue; }
      if (src.startsWith('"""', i) || src.startsWith("'''", i)) {
        cur.ml = src.slice(i, i + 3);
        o += cur.ml;
        i += 3;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += c === '"' && src[j] === '\\' ? 2 : 1;
        const body = src.slice(i + 1, Math.min(j, src.length));
        const clean = cur.secret || (cur.depth > 0 && secretFlag(cur.prev)) ? R : redactString(cur.key, body);
        o += `${c}${clean}${c}`;
        cur.prev = body;
        i = j + 1;
        continue;
      }
      o += c;
      i += 1;
    }
    return o;
  };
  const done = () => !cur.ml && cur.depth <= 0;

  for (const line of String(text || '').split(/\r?\n/)) {
    if (cur) {
      out.push(scan(line));
      if (done()) cur = null;
      continue;
    }
    const header = /^\s*\[\[?\s*(.*?)\s*\]\]?\s*(#.*)?$/.exec(line);
    if (header) {
      const last = header[1].split('.').pop().replace(/^["']|["']$/g, '');
      inSecretTable = secretKey(last);
      out.push(line);
      continue;
    }
    const kv = /^(\s*)([^=#\s][^=]*?)(\s*=\s*)(.*)$/.exec(line);
    if (!kv) { out.push(line); continue; }
    const key = kv[2].trim().replace(/^["']|["']$/g, '');
    const lastKey = key.split('.').pop().replace(/^["']|["']$/g, '');
    cur = { key: lastKey, secret: inSecretTable || secretKey(lastKey), depth: 0, prev: '', ml: null };
    const value = scan(kv[4]);
    if (done()) {
      // A secret on one line loses the whole value, numbers and bare words too.
      out.push(cur.secret ? `${kv[1]}${kv[2]}${kv[3]}"${R}"` : `${kv[1]}${kv[2]}${kv[3]}${value}`);
      cur = null;
    } else {
      out.push(`${kv[1]}${kv[2]}${kv[3]}${value}`);
    }
  }
  const t = out.join('\n');
  return t.length > MAX_RAW ? `${t.slice(0, MAX_RAW)}\n…` : t;
}

module.exports = { redactValue, rawJson, redactToml, redactUrl, redactDetail, secretKey, R };
