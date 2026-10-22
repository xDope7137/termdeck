'use strict';

// Change one member of a JSON file and keep every other byte (features/01-extensions).
// settings.json files are written by hand as often as by a CLI: compact objects
// on one line, odd indents, a key order someone chose. JSON.parse then
// JSON.stringify keeps the meaning and loses all of that, so a switch flipped
// off and on would hand the owner back a reformatted file. This finds the byte
// span of one member and rewrites only that span.
//
//   setPath(text, ['skillOverrides', 'writer'], 'off')   set or insert
//   deletePath(text, ['skillOverrides', 'writer'])       remove the member
//
// Inserting and then deleting the same member returns the original text: the
// insert writes `, "k": v` (or a new line at the siblings' indent) and the
// delete removes exactly the separator in front of the member.
//
// Shipped to agents by name (AGENT_FILES in master.js): builtins only.

class JsonEditError extends Error {
  constructor(message) {
    super(message);
    this.code = 'WRITE_FAILED';
  }
}

const WS = new Set([' ', '\t', '\n', '\r']);

function skipWs(t, i) {
  while (i < t.length && WS.has(t[i])) i += 1;
  return i;
}

function stringEnd(t, i) {
  // t[i] === '"'
  let j = i + 1;
  while (j < t.length) {
    if (t[j] === '\\') { j += 2; continue; }
    if (t[j] === '"') return j + 1;
    j += 1;
  }
  throw new JsonEditError('unterminated string');
}

// The end index of the value starting at i (after whitespace).
function valueEnd(t, i) {
  const c = t[i];
  if (c === '"') return stringEnd(t, i);
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    let j = skipWs(t, i + 1);
    if (t[j] === close) return j + 1;
    for (;;) {
      if (c === '{') {
        if (t[j] !== '"') throw new JsonEditError('expected a key');
        j = skipWs(t, stringEnd(t, j));
        if (t[j] !== ':') throw new JsonEditError('expected ":"');
        j = skipWs(t, j + 1);
      }
      j = skipWs(t, valueEnd(t, j));
      if (t[j] === ',') { j = skipWs(t, j + 1); continue; }
      if (t[j] === close) return j + 1;
      throw new JsonEditError(`expected "," or "${close}"`);
    }
  }
  const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(t.slice(i, i + 64));
  if (!m) throw new JsonEditError('unexpected token');
  return i + m[0].length;
}

// The members of the object whose `{` is at `open`: key text, the member's
// start (the key's quote), the value's span, and where the object closes.
function members(t, open) {
  const out = [];
  let j = skipWs(t, open + 1);
  if (t[j] === '}') return { list: out, close: j };
  for (;;) {
    const keyStart = j;
    const keyEnd = stringEnd(t, j);
    const key = JSON.parse(t.slice(keyStart, keyEnd));
    j = skipWs(t, keyEnd);
    j = skipWs(t, j + 1); // past ':'
    const vStart = j;
    const vEnd = valueEnd(t, j);
    out.push({ key, keyStart, vStart, vEnd });
    j = skipWs(t, vEnd);
    if (t[j] === ',') { j = skipWs(t, j + 1); continue; }
    return { list: out, close: j };
  }
}

// The indentation unit and the column a member of this object sits at, read
// off its siblings (or its own line when it has none).
function layoutOf(t, open, list) {
  const lineStart = (i) => t.lastIndexOf('\n', i - 1) + 1;
  const col = (i) => i - lineStart(i);
  const parentIndent = t.slice(lineStart(open), lineStart(open) + (/^[ \t]*/.exec(t.slice(lineStart(open))) || [''])[0].length);
  if (list.length) {
    const first = list[0];
    const multiline = t.slice(open, first.keyStart).includes('\n');
    if (!multiline) return { multiline: false };
    const indent = t.slice(lineStart(first.keyStart), first.keyStart);
    return { multiline: true, indent, unit: indent.slice(parentIndent.length) || '  ', parentIndent };
  }
  return { multiline: null, parentIndent, unit: detectUnit(t), col: col(open) };
}

function detectUnit(t) {
  const m = /\n([ \t]+)"/.exec(t);
  return m ? m[1] : '  ';
}

// A value serialised for a member at `indent`, in the file's unit.
function render(value, indent, unit) {
  const s = JSON.stringify(value, null, unit);
  return s.replace(/\n/g, `\n${indent}`);
}

function eolOf(t) {
  return /\r\n/.test(t) ? '\r\n' : '\n';
}

function rootOpen(t) {
  const i = skipWs(t, 0);
  if (t[i] !== '{') throw new JsonEditError('the file is not a JSON object');
  valueEnd(t, i); // validates the whole thing
  const rest = skipWs(t, valueEnd(t, i));
  if (rest !== t.length) throw new JsonEditError('trailing text after the JSON object');
  return i;
}

// Find the object at `path` (all but the last segment), creating missing
// parents as `{}` members on the way. Returns { text, open }.
function descend(t, path, create) {
  let open = rootOpen(t);
  for (const seg of path) {
    const { list } = members(t, open);
    const m = list.find((x) => x.key === seg);
    if (m) {
      if (t[m.vStart] !== '{') throw new JsonEditError(`"${seg}" is not an object`);
      open = m.vStart;
      continue;
    }
    if (!create) return null;
    t = insertMember(t, open, seg, {});
    const after = members(t, open).list.find((x) => x.key === seg);
    open = after.vStart;
  }
  return { text: t, open };
}

function insertMember(t, open, key, value) {
  const { list, close } = members(t, open);
  const lay = layoutOf(t, open, list);
  const eol = eolOf(t);
  if (lay.multiline === true) {
    const at = list[list.length - 1].vEnd;
    return `${t.slice(0, at)},${eol}${lay.indent}${JSON.stringify(key)}: ${render(value, lay.indent, lay.unit).replace(/\n/g, eol === '\r\n' ? '\r\n' : '\n')}${t.slice(at)}`;
  }
  if (lay.multiline === false) {
    const at = list[list.length - 1].vEnd;
    return `${t.slice(0, at)}, ${JSON.stringify(key)}: ${JSON.stringify(value)}${t.slice(at)}`;
  }
  // An empty object: `{}` becomes a one-member block at the file's indent.
  const unit = lay.unit;
  const indent = lay.parentIndent + unit;
  const body = `{${eol}${indent}${JSON.stringify(key)}: ${render(value, indent, unit)}${eol}${lay.parentIndent}}`;
  return `${t.slice(0, open)}${body}${t.slice(close + 1)}`;
}

function setPath(text, path, value) {
  if (!Array.isArray(path) || !path.length) throw new JsonEditError('bad path');
  const parent = descend(String(text), path.slice(0, -1), true);
  const t = parent.text;
  const key = path[path.length - 1];
  const { list } = members(t, parent.open);
  const m = list.find((x) => x.key === key);
  if (!m) return insertMember(t, parent.open, key, value);
  const lineStart = t.lastIndexOf('\n', m.keyStart - 1) + 1;
  const indent = /^[ \t]*/.exec(t.slice(lineStart))[0];
  const unit = layoutOf(t, parent.open, list).unit || detectUnit(t);
  const multi = t.slice(m.vStart, m.vEnd).includes('\n');
  const next = multi || (typeof value === 'object' && value !== null && JSON.stringify(value).length > 60)
    ? render(value, indent, unit) : JSON.stringify(value);
  return `${t.slice(0, m.vStart)}${next}${t.slice(m.vEnd)}`;
}

function deletePath(text, path) {
  if (!Array.isArray(path) || !path.length) throw new JsonEditError('bad path');
  const parent = descend(String(text), path.slice(0, -1), false);
  if (!parent) return String(text);
  const t = parent.text;
  const { list } = members(t, parent.open);
  const idx = list.findIndex((x) => x.key === path[path.length - 1]);
  if (idx < 0) return t;
  const m = list[idx];
  if (idx > 0) {
    // Remove from the end of the previous value (its comma included) to the end
    // of this one: exactly what an insert after that sibling added.
    return `${t.slice(0, list[idx - 1].vEnd)}${t.slice(m.vEnd)}`;
  }
  if (list.length > 1) {
    // The first member: remove it and the separator after it up to the next key.
    return `${t.slice(0, m.keyStart)}${t.slice(list[1].keyStart)}`;
  }
  // The only member: the object becomes `{}`.
  const close = members(t, parent.open).close;
  return `${t.slice(0, parent.open)}{}${t.slice(close + 1)}`;
}

function getPath(text, path) {
  let v = JSON.parse(text);
  for (const seg of path) {
    if (!v || typeof v !== 'object') return undefined;
    v = v[seg];
  }
  return v;
}

module.exports = { setPath, deletePath, getPath, JsonEditError };
