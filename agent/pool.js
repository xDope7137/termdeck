'use strict';

// Concurrency-capped Promise.all.
//
// The scan layers fan out one async job per session — head reads, tail reads,
// zstd decompression — with a bare `Promise.all(rows.map(...))` and no cap.
// Measured on one real machine: 714 Claude transcripts and 177 Codex rollouts,
// so fullScan() asked the OS for roughly a thousand file handles at once, every
// five minutes, for an index that is supposed to make steady-state reads free
// (KNOWN-BUGS #24). It is also how a big fleet runs into EMFILE.
//
// Same contract as Promise.all: results in input order, rejects on the first
// failure. Only the width changes.

const DEFAULT_LIMIT = 12;

async function mapLimit(items, fn, limit = DEFAULT_LIMIT) {
  const list = Array.isArray(items) ? items : [...items];
  if (list.length <= 1) return Promise.all(list.map(fn));
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker));
  return out;
}

module.exports = { mapLimit, DEFAULT_LIMIT };

// Self-check: node lib/pool.js — no disk, no network.
if (require.main === module) {
  const assert = require('assert');
  (async () => {
    // Order is input order, not completion order.
    const delays = [30, 5, 20, 1, 10, 15];
    const got = await mapLimit(delays, (ms) => new Promise((r) => setTimeout(() => r(ms), ms)), 2);
    assert.deepStrictEqual(got, delays, 'results come back in input order');

    // The cap is real: track how many run at once.
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 50 }, (_, i) => i), async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
    }, 4);
    assert.strictEqual(peak, 4, `at most 4 jobs may run at once, saw ${peak}`);

    // Everything runs, even when there are far more items than workers.
    const seen = await mapLimit(Array.from({ length: 37 }, (_, i) => i), async (n) => n * 2, 5);
    assert.strictEqual(seen.length, 37);
    assert.strictEqual(seen[36], 72);

    // Empty and single-item inputs are not special-cased into a hang.
    assert.deepStrictEqual(await mapLimit([], async () => 1), []);
    assert.deepStrictEqual(await mapLimit([7], async (n) => n + 1), [8]);

    // Rejects like Promise.all does.
    await assert.rejects(() => mapLimit([1, 2, 3], async (n) => { if (n === 2) throw new Error('boom'); return n; }, 2));

    console.log('ok');
  })();
}
