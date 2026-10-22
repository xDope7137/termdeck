'use strict';

// A table-scoped TOML editor that changes one key and keeps every other byte
// (features/01-extensions). Codex's config.toml and Grok's carry hand-written
// comments, odd spacing and CRLF line ends, and a parse-and-dump round trip
// destroys all three, so this never parses the file. It finds the header of one
// table, finds or inserts one `key = value` line inside it, and leaves the rest
// of the text exactly as it was.
//
// What it understands, and nothing past it:
//   [a.b."c d"]          a table header, bare and quoted segments
//   [[skills.config]]    an array-of-tables entry
//   key = value  # note  one line inside a table; the comment survives an edit
//
// A multi-line string (""" or ''') or a multi-line array is one value: a line
// inside one is never read as a header or a key, however much it looks like
// one, and a key whose value spans lines is refused rather than half-rewritten.
//
// What it refuses rather than guessing at: a table that is spelled some other
// way (dotted keys in a parent table, an inline table), because adding a header
// for it would define the same table twice and the CLI would stop reading the
// file. The caller gets a TomlEditError and the file is not written.
//
// Shipped to agents by name (AGENT_FILES in master.js): builtins only.

class TomlEditError extends Error {
  constructor(message) {
    super(message);
    this.code = 'WRITE_FAILED';
  }
}

const BARE = /^[A-Za-z0-9_-]+$/;

// One header's path as an array of segments, or null when the line is not a
// header. `[[x]]` reports `array: true`.
function parseHeader(line) {
  const m = /^\s*(\[\[?)\s*(.*?)\s*(\]\]?)\s*(#.*)?$/.exec(line);
  if (!m) return null;
  const array = m[1] === '[[';
  if (array !== (m[3] === ']]')) return null;
  const segs = splitPath(m[2]);
  return segs ? { path: segs, array } : null;
}

// `a."b.c".d` -> ['a', 'b.c', 'd']. Null on anything it cannot read.
function splitPath(src) {
  const out = [];
  let i = 0;
  const s = String(src);
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i += 1;
    if (s[i] === '"') {
      let j = i + 1;
      let buf = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { buf += unescapeChar(s[j + 1]); j += 2; continue; }
        buf += s[j];
        j += 1;
      }
      if (s[j] !== '"') return null;
      out.push(buf);
      i = j + 1;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      out.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_-]/.test(s[j])) j += 1;
      if (j === i) return null;
      out.push(s.slice(i, j));
      i = j;
    }
    while (s[i] === ' ' || s[i] === '\t') i += 1;
    if (i >= s.length) break;
    if (s[i] !== '.') return null;
    i += 1;
  }
  return out.length ? out : null;
}

function unescapeChar(c) {
  return c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
}

// JSON's escaping is TOML's for everything but these: a lone surrogate comes out
// as \uD800, which TOML refuses, and DEL goes through raw, which TOML refuses
// in a basic string. Control characters have no business in a name or a path.
function checkText(v) {
  const s = String(v);
  if (/[\u0000-\u001f\u007f]/.test(s) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)) {
    throw new TomlEditError('that name has characters TOML cannot hold; edit it by hand');
  }
  return s;
}

const keyText = (k) => (BARE.test(k) ? k : JSON.stringify(checkText(k)));
const pathText = (segs) => segs.map(keyText).join('.');
const samePath = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

// A TOML value from a JS one. JSON's string escaping is a subset of TOML basic
// strings for everything a config value here can hold (paths, names).
function valueText(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string') return JSON.stringify(checkText(v));
  if (Array.isArray(v)) return `[${v.map(valueText).join(', ')}]`;
  throw new TomlEditError(`cannot write a ${typeof v} into TOML`);
}

// The value of a simple scalar line, for matching `path = "..."` in an array
// entry. Strings (basic and literal), booleans and numbers; anything else null.
function scalarOf(raw) {
  const v = String(raw).trim();
  if (v.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"/.exec(v);
    if (!m) return null;
    try { return JSON.parse(`"${m[1]}"`); } catch { return m[1].replace(/\\(.)/g, (_, c) => unescapeChar(c)); }
  }
  if (v.startsWith("'")) {
    const m = /^'([^']*)'/.exec(v);
    return m ? m[1] : null;
  }
  if (/^(true|false)\b/.test(v)) return v.startsWith('true');
  const n = /^[+-]?\d+(\.\d+)?/.exec(v);
  return n ? Number(n[0]) : null;
}

// `key = value  # comment` split into its parts, or null for any other line.
function parseKeyLine(line) {
  const m = /^(\s*)((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))*)(\s*=\s*)(.*)$/.exec(line);
  if (!m) return null;
  const segs = splitPath(m[2]);
  if (!segs) return null;
  // The trailing comment, outside any string, so an edit keeps it.
  const rest = m[4];
  let inStr = null;
  let cut = rest.length;
  for (let i = 0; i < rest.length; i += 1) {
    const c = rest[i];
    if (inStr) {
      if (c === '\\' && inStr === '"') { i += 1; continue; }
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") inStr = c;
    else if (c === '#') { cut = i; break; }
  }
  const value = rest.slice(0, cut).replace(/\s+$/, '');
  const comment = rest.slice(value.length);
  return { indent: m[1], key: segs, eq: m[3], value, comment };
}

function splitLines(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = String(text).split(/\r?\n/);
  const masked = maskLines(lines);
  return { lines, eol, seen: masked.lines, opens: masked.opens };
}

// The lines as the header and key readers should see them: a line that starts
// inside a multi-line string or array is replaced by a placeholder that is not
// blank, not a comment, not a header and not a key, so nothing is found in it
// and nothing is inserted after it as if it ended a table. `opens` holds the
// lines whose value carries on past their end.
const MASK = '\u0000';
function maskLines(lines) {
  const out = lines.slice();
  const opens = new Set();
  let ml = null;
  let depth = 0;
  const scan = (src, from) => {
    let i = from;
    while (i < src.length) {
      if (ml) {
        let j = i;
        let end = -1;
        while (j < src.length) {
          if (ml === '"""' && src[j] === '\\') { j += 2; continue; }
          if (src.startsWith(ml, j)) { end = j; break; }
          j += 1;
        }
        if (end < 0) return;
        // A closing delimiter may carry up to two more quotes of the string.
        i = end + 3;
        while (src[i] === ml[0] && i < end + 5) i += 1;
        ml = null;
        continue;
      }
      const c = src[i];
      if (c === '#') return;
      if (src.startsWith('"""', i) || src.startsWith("'''", i)) { ml = src.slice(i, i + 3); i += 3; continue; }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += c === '"' && src[j] === '\\' ? 2 : 1;
        i = j + 1;
        continue;
      }
      if (c === '[' || c === '{') depth += 1;
      else if ((c === ']' || c === '}') && depth > 0) depth -= 1;
      i += 1;
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (ml || depth > 0) {
      out[i] = MASK;
      scan(line, 0);
      continue;
    }
    if (parseHeader(line)) continue;
    const kl = parseKeyLine(line);
    if (!kl) continue;
    scan(line, line.length - kl.value.length - kl.comment.length);
    if (ml || depth > 0) opens.add(i);
  }
  return { lines: out, opens };
}

// Every table in the file: its header line index, path, whether it is an array
// entry, and where it ends (the next header, or the end of the file).
function tables(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const h = parseHeader(lines[i]);
    if (!h) continue;
    if (out.length) out[out.length - 1].end = i;
    out.push({ start: i, path: h.path, array: h.array, end: lines.length });
  }
  return out;
}

// Inside one table's body, set `key` or insert it after the last content line.
// `comment` (a whole `# ...`) rides on an inserted line only; an existing line
// keeps its own. Returns the new line array.
function setInBody(lines, seen, opens, t, key, value, comment = '') {
  for (let i = t.start + 1; i < t.end; i += 1) {
    const kl = parseKeyLine(seen[i]);
    if (kl && kl.key.length === 1 && kl.key[0] === key) {
      if (opens.has(i)) throw new TomlEditError(`${key} spans more than one line; edit it by hand`);
      const next = lines.slice();
      next[i] = `${kl.indent}${keyText(key)}${kl.eq}${valueText(value)}${kl.comment}`;
      return next;
    }
  }
  // Insert after the last non-blank, non-comment line of the table so the blank
  // line that separates it from the next table stays where it was.
  let at = t.start + 1;
  for (let i = t.start + 1; i < t.end; i += 1) {
    const s = seen[i].trim();
    if (s && !s.startsWith('#')) at = i + 1;
  }
  const indent = (() => {
    for (let i = t.start + 1; i < t.end; i += 1) {
      const kl = parseKeyLine(seen[i]);
      if (kl) return kl.indent;
    }
    return '';
  })();
  const next = lines.slice();
  next.splice(at, 0, `${indent}${keyText(key)} = ${valueText(value)}${comment ? ` ${comment}` : ''}`);
  return next;
}

// Is the table defined some way a header cannot safely be added for? Dotted keys
// in an ancestor table, or an inline table, both name it without a header.
function definedInline(lines, all, tablePath) {
  for (let cut = 0; cut < tablePath.length; cut += 1) {
    const parent = tablePath.slice(0, cut);
    const rest = tablePath.slice(cut);
    // The body of `parent`: the root (before any header) or that table's lines.
    const ranges = [];
    if (!parent.length) ranges.push([0, all.length ? all[0].start : lines.length]);
    for (const t of all) if (!t.array && samePath(t.path, parent)) ranges.push([t.start + 1, t.end]);
    for (const [a, b] of ranges) {
      for (let i = a; i < b; i += 1) {
        const kl = parseKeyLine(lines[i]);
        if (!kl) continue;
        const n = Math.min(kl.key.length, rest.length);
        if (samePath(kl.key.slice(0, n), rest.slice(0, n))) return true;
      }
    }
  }
  return false;
}

function join(lines, eol) {
  return lines.join(eol);
}

// The edit's own check: exactly one line changed or was added, and it is inside
// the table it was meant for. Anything else is a reading of the file this
// module got wrong, and the file is not written.
function oneLineChanged(before, after, t) {
  const a = splitLines(before).lines;
  const b = splitLines(after).lines;
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo += 1;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) { ea -= 1; eb -= 1; }
  const changed = ea - lo;
  const added = eb - lo;
  const ok = (changed === 1 && added === 1) || (changed === 0 && added === 1);
  if (!ok || lo <= t.start || lo > t.end) throw new TomlEditError('the edit did not land where expected; nothing was written');
}

// setTableKey's check: one line inside the existing table, or one new table at
// the end, and the value reads back.
function verifyEdit(before, after, segs, key, value, table) {
  if (table) oneLineChanged(before, after, table);
  else if (!String(after).startsWith(String(before).replace(/(\r?\n)*$/, ''))) {
    throw new TomlEditError('the edit did not land where expected; nothing was written');
  }
  if (typeof value !== 'object') {
    if (readTableKey(after, segs, key) !== value) throw new TomlEditError('the edit did not read back; nothing was written');
  } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    const back = readStringArray(after, segs, key);
    if (!back || back.length !== value.length || back.some((v, i) => v !== value[i])) throw new TomlEditError('the edit did not read back; nothing was written');
  }
  return after;
}

// Set `key = value` inside the table `[tablePath]`, creating the table at the
// end of the file when it does not exist.
function setTableKey(text, tablePath, key, value, { comment = '' } = {}) {
  const segs = Array.isArray(tablePath) ? tablePath : splitPath(tablePath);
  if (!segs || !segs.length) throw new TomlEditError('bad table path');
  const { lines, eol, seen, opens } = splitLines(text);
  const all = tables(seen);
  const hits = all.filter((t) => !t.array && samePath(t.path, segs));
  if (hits.length > 1) throw new TomlEditError(`[${pathText(segs)}] appears twice; the file is not valid TOML`);
  let out;
  if (hits.length === 1) {
    out = join(setInBody(lines, seen, opens, hits[0], key, value, comment), eol);
  } else {
    if (definedInline(seen, all, segs)) {
      throw new TomlEditError(`[${pathText(segs)}] is written as an inline or dotted table; edit it by hand`);
    }
    out = appendBlock(lines, eol, [`[${pathText(segs)}]`, `${keyText(key)} = ${valueText(value)}${comment ? ` ${comment}` : ''}`]);
  }
  return verifyEdit(text, out, segs, key, value, hits[0] || null);
}

// A new table at the end of the file, one blank line above it and a newline
// after it. Only trailing blank lines are touched.
function appendBlock(lines, eol, block) {
  const next = lines.slice();
  while (next.length && next[next.length - 1] === '') next.pop();
  return join(next.length ? [...next, '', ...block, ''] : [...block, ''], eol);
}

// Set `key = value` in the `[[arrayPath]]` entry whose `matchKey` equals
// `matchValue`, appending a new entry with both keys when none matches.
function setArrayTableEntry(text, arrayPath, matchKey, matchValue, key, value, { comment = '' } = {}) {
  const segs = Array.isArray(arrayPath) ? arrayPath : splitPath(arrayPath);
  if (!segs || !segs.length) throw new TomlEditError('bad table path');
  const { lines, eol, seen, opens } = splitLines(text);
  const all = tables(seen);
  for (const t of all) {
    if (!t.array || !samePath(t.path, segs)) continue;
    for (let i = t.start + 1; i < t.end; i += 1) {
      const kl = parseKeyLine(seen[i]);
      if (kl && kl.key.length === 1 && kl.key[0] === matchKey && scalarOf(kl.value) === matchValue) {
        const out = join(setInBody(lines, seen, opens, t, key, value, comment), eol);
        oneLineChanged(text, out, t);
        return out;
      }
    }
  }
  return appendBlock(lines, eol, [`[[${pathText(segs)}]]`, `${keyText(matchKey)} = ${valueText(matchValue)}`, `${keyText(key)} = ${valueText(value)}${comment ? ` ${comment}` : ''}`]);
}

// The `[[arrayPath]]` entry whose `matchKey` equals `matchValue`, with its line
// range, as { start, end, keys: { key: { value, comment } } }. Null when absent.
function findArrayEntry(seen, arrayPath, matchKey, matchValue) {
  for (const t of tables(seen)) {
    if (!t.array || !samePath(t.path, arrayPath)) continue;
    const keys = {};
    for (let i = t.start + 1; i < t.end; i += 1) {
      const kl = parseKeyLine(seen[i]);
      if (kl && kl.key.length === 1) keys[kl.key[0]] = { value: scalarOf(kl.value), comment: kl.comment.trim() };
    }
    if (keys[matchKey] && keys[matchKey].value === matchValue) return { ...t, keys };
  }
  return null;
}

function arrayEntry(text, arrayPath, matchKey, matchValue) {
  const segs = Array.isArray(arrayPath) ? arrayPath : splitPath(arrayPath);
  const hit = findArrayEntry(splitLines(text).seen, segs, matchKey, matchValue);
  return hit ? hit.keys : null;
}

// Remove that entry and the blank line above it: the exact inverse of the block
// setArrayTableEntry appends. Unchanged when absent.
function deleteArrayEntry(text, arrayPath, matchKey, matchValue) {
  const segs = Array.isArray(arrayPath) ? arrayPath : splitPath(arrayPath);
  const { lines, eol, seen } = splitLines(text);
  const hit = findArrayEntry(seen, segs, matchKey, matchValue);
  if (!hit) return text;
  let end = hit.end;
  while (end > hit.start + 1 && !seen[end - 1].trim()) end -= 1;
  let from = hit.start;
  if (from > 0 && lines[from - 1] === '') from -= 1;
  const next = lines.slice();
  next.splice(from, end - from);
  if (next.length === 1 && next[0] === '') return '';
  return join(next, eol);
}

// `key` in `[tablePath]` as { value, comment }, or null when it is not there.
function readKeyLine(text, tablePath, key) {
  const segs = Array.isArray(tablePath) ? tablePath : splitPath(tablePath);
  const { seen } = splitLines(text);
  const range = keyRange(seen, tables(seen), segs);
  if (!range) return null;
  const hit = findKey(seen, range, key);
  return hit ? { value: scalarOf(hit.kl.value), comment: hit.kl.comment.trim() } : null;
}

// The raw text of one table (header through its last content line), for the
// "Show config" excerpt. Null when the table is not there.
function tableExcerpt(text, tablePath, { withSubtables = true } = {}) {
  const segs = Array.isArray(tablePath) ? tablePath : splitPath(tablePath);
  const { lines, seen } = splitLines(text);
  const all = tables(seen);
  const picked = all.filter((t) => !t.array && (samePath(t.path, segs) || (withSubtables && t.path.length > segs.length && samePath(t.path.slice(0, segs.length), segs))));
  if (!picked.length) return null;
  return picked.map((t) => {
    let end = t.end;
    while (end > t.start + 1 && !seen[end - 1].trim()) end -= 1;
    return lines.slice(t.start, end).join('\n');
  }).join('\n\n');
}

// Every value of `key` in the `[tablePath]` table, read the same way the editor
// reads it. For tests and for reading `enabled` back.
function readTableKey(text, tablePath, key) {
  const segs = Array.isArray(tablePath) ? tablePath : splitPath(tablePath);
  const { seen } = splitLines(text);
  for (const t of tables(seen)) {
    if (t.array || !samePath(t.path, segs)) continue;
    for (let i = t.start + 1; i < t.end; i += 1) {
      const kl = parseKeyLine(seen[i]);
      if (kl && kl.key.length === 1 && kl.key[0] === key) return scalarOf(kl.value);
    }
  }
  return undefined;
}

// Every `[[arrayPath]]` entry as a flat object of its scalar keys.
function readArrayTables(text, arrayPath) {
  const segs = Array.isArray(arrayPath) ? arrayPath : splitPath(arrayPath);
  const { seen } = splitLines(text);
  const out = [];
  for (const t of tables(seen)) {
    if (!t.array || !samePath(t.path, segs)) continue;
    const row = {};
    for (let i = t.start + 1; i < t.end; i += 1) {
      const kl = parseKeyLine(seen[i]);
      if (kl && kl.key.length === 1) row[kl.key[0]] = scalarOf(kl.value);
    }
    out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// String arrays, and keys at the top of the file. Grok keeps its switches as
// lists (`disabled_mcp_servers = [...]` before any table, `[skills] disabled`),
// and turning the last item back on has to give the file back as it was, so a
// key can be removed as well as set. Only one-line arrays of plain strings are
// read; anything else reads as null and the caller refuses to write.
// ---------------------------------------------------------------------------

// The line range a key in `tablePath` lives in: the top of the file for [],
// else the one table of that path. Null when the table is not there.
function keyRange(lines, all, segs) {
  if (!segs.length) return { start: -1, end: all.length ? all[0].start : lines.length };
  const hits = all.filter((t) => !t.array && samePath(t.path, segs));
  if (hits.length > 1) throw new TomlEditError(`[${pathText(segs)}] appears twice; the file is not valid TOML`);
  return hits[0] || null;
}

function findKey(lines, range, key) {
  for (let i = range.start + 1; i < range.end; i += 1) {
    const kl = parseKeyLine(lines[i]);
    if (kl && kl.key.length === 1 && kl.key[0] === key) return { i, kl };
  }
  return null;
}

function stringArrayOf(raw) {
  const v = String(raw).trim();
  if (!/^\[.*\]$/.test(v)) return null;
  const inner = v.slice(1, -1);
  const out = [];
  const re = /\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(,|$)/y;
  let at = 0;
  if (!inner.trim()) return out;
  while (at < inner.length) {
    re.lastIndex = at;
    const m = re.exec(inner);
    if (!m) return inner.slice(at).trim() ? null : out;
    out.push(scalarOf(m[1]));
    at = re.lastIndex;
    if (!m[2]) break;
  }
  return inner.slice(at).trim() ? null : out;
}

// The strings in `key` of `tablePath` ([] for the top of the file): undefined
// when the key is not there, null when it is there but not a one-line string array.
function readStringArray(text, tablePath, key) {
  const segs = Array.isArray(tablePath) ? tablePath : splitPath(tablePath);
  const { seen, opens } = splitLines(text);
  const range = keyRange(seen, tables(seen), segs);
  if (!range) return undefined;
  const hit = findKey(seen, range, key);
  if (hit && opens.has(hit.i)) return null;
  return hit ? stringArrayOf(hit.kl.value) : undefined;
}

// Set `key` at the top of the file, before any table. A new key goes on the
// first line with a blank line after it when a table follows, the way the
// engines' own CLIs write it.
function setRootKey(text, key, value) {
  const { lines, eol, seen, opens } = splitLines(text);
  const range = keyRange(seen, tables(seen), []);
  const hit = findKey(seen, range, key);
  const next = lines.slice();
  if (hit && opens.has(hit.i)) throw new TomlEditError(`${key} spans more than one line; edit it by hand`);
  if (hit) {
    next[hit.i] = `${hit.kl.indent}${keyText(key)}${hit.kl.eq}${valueText(value)}${hit.kl.comment}`;
    return join(next, eol);
  }
  const line = `${keyText(key)} = ${valueText(value)}`;
  if (!String(text).length) return `${line}${eol}`;
  next.splice(0, 0, ...(lines[0] === '' ? [line] : [line, '']));
  return join(next, eol);
}

// Remove `key` from `tablePath` ([] for the top of the file). A table left with
// nothing in it goes too, with the blank line above it, which is the exact
// inverse of a table setTableKey appended; a top key on the first line takes the
// blank line after it, the inverse of setRootKey. Unchanged when absent.
function deleteKey(text, tablePath, key) {
  const segs = Array.isArray(tablePath) ? tablePath : splitPath(tablePath);
  const { lines, eol, seen, opens } = splitLines(text);
  const range = keyRange(seen, tables(seen), segs);
  if (!range) return text;
  const hit = findKey(seen, range, key);
  if (!hit) return text;
  if (opens.has(hit.i)) throw new TomlEditError(`${key} spans more than one line; edit it by hand`);
  let next = lines.slice();
  next.splice(hit.i, 1);
  if (!segs.length) {
    if (hit.i === 0 && next[0] === '' && next.length > 1) next.splice(0, 1);
    return join(next, eol);
  }
  // The table now spans [range.start, end); the file's own final newline (an
  // empty last element) is not part of it.
  let end = range.end - 1;
  if (end === next.length && next[end - 1] === '') end -= 1;
  const body = next.slice(range.start + 1, end);
  if (body.every((l) => !l.trim())) {
    let from = range.start;
    if (from > 0 && next[from - 1] === '') from -= 1;
    next.splice(from, end - from);
    if (next.length === 1 && next[0] === '') return '';
  }
  return join(next, eol);
}

module.exports = {
  setTableKey,
  arrayEntry,
  deleteArrayEntry,
  readKeyLine,
  readStringArray,
  setRootKey,
  deleteKey,
  setArrayTableEntry,
  tableExcerpt,
  readTableKey,
  readArrayTables,
  parseHeader,
  parseKeyLine,
  splitPath,
  tables: (text) => tables(splitLines(text).seen),
  TomlEditError,
};
