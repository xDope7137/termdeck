'use strict';

// The machine's session index, kept BY the machine (features/04 phase 8).
//
// The master used to learn a machine's sessions by walking its transcript roots
// over the tunnel: one indexScan per root, a stat for Codex's rename index, and
// an indexHeads batch for every row whose head it had not parsed, all sequential
// and all repeated from scratch on every reconnect. This module is the agent's
// own copy of that answer, persisted under the agent's state dir, so that
//
//   * connecting costs ONE round trip (`indexSync`), and
//   * a reconnect whose generation is unchanged costs NONE: the hello carries
//     `{ epoch, gen }` and a master already holding that generation asks nothing.
//
// Generation: a counter that moves whenever anything the index answers moves (a
// file appears, changes size or mtime, disappears, gets a freshly parsed head,
// or Codex's rename index changes). Every file carries the generation it last
// changed at, and every removal leaves a tombstone, so "what changed since gen
// N" is a filter, not a diff. Epoch: minted when the state is created, and
// whenever it cannot be trusted (unreadable file, new agent version, a root
// that moved). A master holding another epoch gets the whole index.
//
// Deliberately NOT a watcher. The index is brought up to date by a local stat
// walk when it is asked (`sync`) and once per dial (`refresh`, before the hello
// goes out), which is the same walk indexScan always did, minus the tunnel. A
// second chokidar tree on every machine would double the inotify watches the
// master's own watch already costs, to save a walk that takes milliseconds.
//
// Shipped to agents by name (AGENT_FILES in master.js), so it may only require
// siblings. The fs, the clock and the head parser are injected for the tests.

const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { mapLimit } = require('./pool');

const STATE_VERSION = 1;
// Per root, the newest this many files. indexScan's cap was 4000 in readdir
// order; newest-first keeps the ones the sidebar actually shows.
const FILES_MAX = 4000;
// Heads are parsed for the newest `max` candidates plus this many. The walk's
// filter is coarse (a zst twin, a stray jsonl), so the exact top-N the master
// cuts can reach a little past the agent's; a row with no head here is read by
// the master's existing indexHeads fallback, so the slack only has to be enough
// to make that rare.
const HEAD_SLACK = 32;
// Removals remembered for delta answers. A master asking from before the oldest
// one gets the whole index instead.
const TOMBSTONES_MAX = 5000;
const PERSIST_DEBOUNCE_MS = 1000;

// The prompt the head parser is asked with (lib/index-head.js readIndexHead):
// the file, plus what the previous parse of it already knew, carried forward
// so a growing file re-reads only what grew. ONE spelling, used by the master's
// fallback (machine-host readHeads) and by this module.
function headAsk(row, prev) {
  return {
    path: row.path,
    engine: row.engine,
    zst: !!row.zst,
    sizeBytes: row.sizeBytes,
    ...(row.engine === 'codex' && prev && 'codexTurn' in prev ? {
      prevCodexTurn: prev.codexTurn ?? null,
    } : {}),
    // How big the file was when prevAt was read. Without it a carried prevAt
    // could not tell "no new prompt" from "a new prompt we never looked at".
    ...(prev && Number.isFinite(prev.sizeBytes) ? { prevSizeBytes: prev.sizeBytes } : {}),
    prevAt: prev ? prev.lastUserAt || null : null,
    prevActivityAt: prev ? prev.lastActivityAt || null : null,
    noPromptBelow: prev ? prev.noPromptBelow ?? null : null,
    noTitleBelow: prev ? prev.noTitleBelow ?? null : null,
  };
}

// Codex's TUI rename index: one {id, thread_name} per line, appended to.
function parseCodexTitles(text, into) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e && e.id && typeof e.thread_name === 'string' && e.thread_name.trim()) into.set(e.id, e.thread_name.trim());
  }
  return into;
}

function freshState(agentVersion) {
  return { v: STATE_VERSION, agentVersion: agentVersion || null, epoch: randomUUID(), gen: 0, floor: 0, roots: {}, removed: [], titles: null };
}

/**
 * opts:
 *   file        where the state persists (null: memory only)
 *   version     the agent version; heads parsed by another version are not kept
 *   candidate   (kind, root, dir, name) -> bool, the walk's coarse filter
 *   readHead    (ask) -> head | null, lib/index-head.js against local disk
 *   confined    (path) -> bool, the agent's transcript-root confinement
 */
function createSessionIndex(opts = {}) {
  const file = opts.file || null;
  const version = opts.version || null;
  const candidate = opts.candidate || (() => true);
  const readHead = opts.readHead || (async () => null);
  const confined = opts.confined || (async () => true);
  let state = null;
  let chain = Promise.resolve();
  let persistTimer = null;

  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function load() {
    if (state) return state;
    if (file) {
      try {
        const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (raw && raw.v === STATE_VERSION && raw.agentVersion === version && typeof raw.epoch === 'string') {
          for (const r of Object.values(raw.roots || {})) r.files = new Map(r.files || []);
          if (raw.titles) raw.titles.entries = new Map(raw.titles.entries || []);
          state = raw;
        }
      } catch { /* missing or unreadable: start over under a new epoch */ }
    }
    if (!state) state = freshState(version);
    return state;
  }

  function schedulePersist() {
    if (!file || persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; persist().catch(() => {}); }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  }

  async function persist() {
    if (!file || !state) return;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    const out = {
      ...state,
      roots: Object.fromEntries(Object.entries(state.roots).map(([k, r]) => [k, { ...r, files: [...r.files] }])),
      titles: state.titles ? { ...state.titles, entries: [...state.titles.entries] } : null,
    };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(out));
    await fsp.rename(tmp, file);
  }

  // The same walk indexScan does: every candidate file under one root, as
  // rel -> [size, mtimeMs], newest FILES_MAX kept.
  async function walk(kind, root) {
    let ents;
    try { ents = await fsp.readdir(root, { recursive: true, withFileTypes: true }); } catch { return { files: new Map(), truncated: false, missing: true }; }
    const picked = [];
    for (const e of ents) {
      if (!e.isFile()) continue;
      const dir = e.parentPath || e.path || root;
      if (!candidate(kind, root, dir, e.name)) continue;
      picked.push(path.join(dir, e.name));
    }
    const stats = await mapLimit(picked, async (full) => {
      try { const st = await fsp.stat(full); return [path.relative(root, full), st.size, st.mtimeMs]; } catch { return null; }
    }, 32);
    let list = stats.filter(Boolean);
    const truncated = list.length > FILES_MAX;
    if (truncated) list = list.sort((a, b) => b[2] - a[2]).slice(0, FILES_MAX);
    return { files: new Map(list.map(([rel, s, m]) => [rel, [s, m]])), truncated, missing: false };
  }

  // Bring the state up to date with the disk. `max` null: stats only (the dial
  // walk); otherwise the newest `max` files also get their heads parsed.
  // Returns true when anything moved (and the generation with it).
  async function update(roots, max, codexIndex) {
    const st = await load();
    const changed = []; // entries to stamp with the next generation
    const removed = []; // [kind, rel]
    let titlesMoved = false;
    let rootsMoved = false;
    const wantKinds = new Set(roots.map((r) => r.kind));
    for (const kind of Object.keys(st.roots)) if (!wantKinds.has(kind)) rootsMoved = true;
    for (const r of roots) if (st.roots[r.kind] && st.roots[r.kind].root !== r.root) rootsMoved = true;
    if (rootsMoved) {
      // A different set of roots is a different index. Start over.
      state = freshState(version);
      return update(roots, max, codexIndex);
    }
    for (const { kind, root } of roots) {
      const w = await walk(kind, root);
      let rec = st.roots[kind];
      if (!rec) { rec = st.roots[kind] = { root, files: new Map(), truncated: false }; }
      rec.truncated = w.truncated;
      for (const [rel, [s, m]] of w.files) {
        const cur = rec.files.get(rel);
        if (cur && cur.s === s && cur.m === m) continue;
        const next = { s, m, g: 0, h: cur ? cur.h : null };
        rec.files.set(rel, next);
        changed.push(next);
      }
      for (const rel of [...rec.files.keys()]) {
        if (w.files.has(rel)) continue;
        rec.files.delete(rel);
        removed.push([kind, rel]);
      }
    }
    if (max != null && max > 0) {
      const all = [];
      for (const [kind, rec] of Object.entries(st.roots)) {
        for (const [rel, e] of rec.files) all.push({ kind, rel, e, root: rec.root });
      }
      all.sort((a, b) => b.e.m - a.e.m);
      const top = all.slice(0, max + HEAD_SLACK).filter(({ e }) => !e.h || e.h.s !== e.s || e.h.m !== e.m);
      await mapLimit(top, async ({ kind, rel, e, root }) => {
        const full = path.join(root, rel);
        if (!(await confined(full))) return;
        const prev = e.h ? { ...e.h, sizeBytes: e.h.s } : null;
        let head = null;
        try {
          head = await readHead(headAsk({ path: full, engine: kind, zst: rel.endsWith('.zst'), sizeBytes: e.s }, prev));
        } catch { head = null; }
        // A read that failed is not a fact about the file; the master's
        // fallback asks again rather than this pinning a null title.
        if (!head || head.failed) return;
        e.h = { ...head, s: e.s, m: e.m };
        if (!changed.includes(e)) changed.push(e);
      });
    }
    if (codexIndex) {
      let tst = null;
      try { tst = await fsp.stat(codexIndex); } catch {}
      const cur = st.titles;
      if (!tst) {
        // No rename index yet: empty is the answer, and it is news only once.
        if (!cur || cur.path !== codexIndex || cur.s !== -1) {
          st.titles = { path: codexIndex, s: -1, m: -1, g: 0, entries: new Map() };
          titlesMoved = true;
        }
      } else if (!cur || cur.path !== codexIndex || cur.s !== tst.size || cur.m !== tst.mtimeMs) {
        // Append-only in practice: read what grew. Shorter than before means it
        // was rewritten, and then the whole (small) file is the answer.
        const grew = cur && cur.path === codexIndex && cur.s >= 0 && tst.size > cur.s;
        const from = grew ? cur.s : 0;
        let text = '';
        try {
          const fd = await fsp.open(codexIndex, 'r');
          try {
            const len = Math.max(0, tst.size - from);
            const buf = Buffer.alloc(len);
            const { bytesRead } = len ? await fd.read(buf, 0, len, from) : { bytesRead: 0 };
            text = buf.subarray(0, bytesRead).toString('utf8');
          } finally { await fd.close(); }
        } catch { text = null; }
        if (text != null) {
          // A partial last line waits for the next read: stop at the last newline.
          const cut = text.lastIndexOf('\n') + 1;
          const entries = grew ? new Map(cur.entries) : new Map();
          parseCodexTitles(text.slice(0, cut), entries);
          st.titles = { path: codexIndex, s: from + Buffer.byteLength(text.slice(0, cut)), m: tst.mtimeMs, g: 0, entries };
          // A torn tail leaves `s` short of the file, so the next ask reads it again.
          if (st.titles.s !== tst.size) st.titles.m = -1;
          titlesMoved = true;
        }
      }
    }
    if (!changed.length && !removed.length && !titlesMoved) return false;
    st.gen += 1;
    for (const e of changed) e.g = st.gen;
    for (const [kind, rel] of removed) st.removed.push([kind, rel, st.gen]);
    if (st.removed.length > TOMBSTONES_MAX) {
      const drop = st.removed.length - TOMBSTONES_MAX;
      st.floor = st.removed[drop - 1][2];
      st.removed = st.removed.slice(drop);
    }
    if (titlesMoved) st.titles.g = st.gen;
    schedulePersist();
    return true;
  }

  // The master's one round trip. `roots`: [{ kind, path }] as the master joins
  // them. `since`/`epoch`: the generation the master already holds, or nothing.
  function sync({ roots, since = null, epoch = null, max = 200, codexIndex = null } = {}) {
    return serial(async () => {
      const list = [];
      for (const r of Array.isArray(roots) ? roots : []) {
        if (!r || typeof r.path !== 'string') continue;
        const kind = r.kind === 'codex' || r.kind === 'grok' ? r.kind : 'claude';
        if (!(await confined(r.path))) continue;
        list.push({ kind, root: path.resolve(r.path) });
      }
      const idx = codexIndex && typeof codexIndex === 'string' && (await confined(codexIndex)) ? codexIndex : null;
      await update(list, Math.max(0, Math.min(Number(max) || 0, 1000)), idx);
      const st = state;
      const base = { epoch: st.epoch, gen: st.gen };
      const sameEpoch = epoch === st.epoch && Number.isInteger(since) && since >= 0 && since <= st.gen;
      if (sameEpoch && since === st.gen) return { ...base, unchanged: true };
      const delta = sameEpoch && since >= st.floor;
      // Heads only for the top the master will show, so a full answer on a
      // machine with years of history stays the size of a page, not a year.
      const topCut = (() => {
        const ms = [];
        for (const rec of Object.values(st.roots)) for (const e of rec.files.values()) ms.push(e.m);
        ms.sort((a, b) => b - a);
        const n = Math.max(0, Math.min(Number(max) || 0, 1000)) + HEAD_SLACK;
        return ms.length > n ? ms[n - 1] : -Infinity;
      })();
      const out = [];
      for (const [kind, rec] of Object.entries(st.roots)) {
        const files = [];
        for (const [rel, e] of rec.files) {
          if (delta && e.g <= since) continue;
          const head = e.h && e.h.s === e.s && e.h.m === e.m && e.m >= topCut ? stripHead(e.h) : null;
          files.push(head ? [rel, e.s, e.m, head] : [rel, e.s, e.m]);
        }
        const gone = delta ? st.removed.filter(([k, , g]) => k === kind && g > since).map(([, rel]) => rel) : [];
        out.push({ kind, root: rec.root, files, ...(gone.length ? { removed: gone } : {}), ...(rec.truncated ? { truncated: true } : {}) });
      }
      const t = st.titles;
      const titles = t && (!delta || t.g > since) ? { size: t.s, mtimeMs: t.m, entries: [...t.entries] } : undefined;
      return { ...base, [delta ? 'delta' : 'full']: true, sep: path.sep, roots: out, ...(titles ? { codexTitles: titles } : {}) };
    });
  }

  // Once per dial, before the hello: catch up with whatever was written while
  // nobody was connected, stats only. Null when there is nothing to vouch for
  // (never synced, or the walk failed), which the hello reads as "ask me".
  function refresh() {
    return serial(async () => {
      const st = await load();
      const roots = Object.entries(st.roots).map(([kind, r]) => ({ kind, root: r.root }));
      if (!roots.length) return null;
      await update(roots, null, st.titles ? st.titles.path : null);
      return { epoch: st.epoch, gen: st.gen };
    }).catch(() => null);
  }

  return { sync, refresh, persist: () => serial(persist), _state: () => state };
}

// What crosses the wire of a head: the parse's answer, not this module's stamps.
function stripHead(h) {
  const { s, m, ...rest } = h;
  return rest;
}

module.exports = { createSessionIndex, headAsk };
