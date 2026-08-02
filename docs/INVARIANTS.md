# Load-bearing invariants — long form

CLAUDE.md carries the one-line rule for each of these. This file carries the reasoning,
the measurements, and the failure that produced the rule. Read the entry before changing
the code it names.

## The composer must show what the chat is RUNNING (`syncSelects` + the thinking dial)

Reported as "every hard reload shows the wrong model and thinking", and reproduced: the
host said the chat was on `claude-opus-5` / `xhigh` while the selects read "default".
Three independent causes, and they are worth keeping apart:

1. **Effort had no fallback.** `syncSelects()` read it from `state.runMeta` alone — the
   runner's LIVE state — while model and mode each fell through to `state.sessionMeta`
   (what the host reports the chat is running). With no live run there is no runMeta, so
   effort was always the first option. The chain is now the same one mode uses: this
   turn's pick, then what this browser last chose for this chat, then what the host says.
2. **A partial paint blanked it** — see the preview entry above.
3. **The thinking dial is not on disk anywhere** (SDK-SIGNALS §I). It is a sticky
   preference in the runner's memory, re-applied at each turn's init, so a browser reload
   survives it but a master restart does not: the dial silently reads "Default" while the
   reader believes thinking is off. The browser now keeps its own per-chat copy and, when
   the host reports none on subscribe, **re-applies** it (`set-thinking`) rather than
   drawing it locally — the point of the control is what the engine does, and the server's
   echo is still what moves the segment.

Per-chat browser memory (localStorage, keyed like the draft and the permission mode) is a
HINT, never truth: the host's own value wins wherever it has one. Covered by
`tests/settings-restore.mjs`.

## A preview is a PAINT, and it is read from the TAIL (`lib/tail-read.js`, `lib/preview.js`)

Every surface that shows "the last fifteen messages" — a cache seed, the window pushed on
subscribe, `?tail=1` — used to be served by parsing the whole jsonl. Measured on the cloud
path: opening a 51 MB chat on termdeck.io took **2.8 s**, because the master pulled all
51 MB across the tunnel and JSON.parsed every line to display fifteen messages.

So a preview seeks to `size - budget`, walks forward to the next line boundary, and parses
only what follows. The parser already starts mid-file — that is what a `?since` delta is.

**`startLine` is the load-bearing number.** `totalLines = startLine + (the tail parse's
own)`, which is exactly what a full parse would have reported, and that number is the
cursor every later `?since` splice and every live push is anchored to. Off by one and the
client silently drops or repeats a line forever after. It is counted, never estimated
(`tests/tail-read.mjs` pins it, including against a torn final line).

**What a tail may not claim.** Two payload fields are properties of the WHOLE file: the
session's opening `cwd` (substituted with the current one — which is what the header shows
anyway) and `cumulativeUsage` (dropped, because a partial sum displayed as a session total
is a wrong COST on screen). Everything else the scanner reports is last-value-wins, and
the last value is in the tail by definition. `partial: true` says all of this on the wire.

**A paint carries less than a load, on purpose.** One real chat answered `?preview=15` with
1001 KB: 354 KB of it was four tool results holding inline base64 screenshots, and the
window itself had grown to 547 messages because the prompt anchor walked back to a prompt
547 messages away. A paint therefore drops inline images (keeping `imagesOmitted` so the
view can say what is coming), truncates any single oversized block, and takes the capped
anchor (`SEED_ANCHOR_CAP`) — every paint, not just a seed. The authoritative load behind it
carries all of it in full, which is exactly why cutting it here costs the reader nothing.
Same measured chat, after: a seed is **14 KB and 15 messages**.

**The first window is pushed, not fetched.** `subscribe` is answered with `subscribed` and
then a `transcript-window` frame. After, never inside: that frame carries the view-only
lock, the run snapshot and the queue, and none of them may wait on a file read. The browser
paints it only while `state.clientTotal === 0` (nothing applied yet), so it can never land
on top of fresher data. `needWindow: false` suppresses it for a browser that already had
the chat cached — on a phone that push is a chat's whole first screen, sent for nothing.

**Cloud specifics.** `readTail` is a root-confined agent capability (agent ≥ 0.0.46); an
older agent answers `AGENT_OUTDATED` and the master falls back to the whole-file read, so
an un-updated machine degrades instead of breaking. `tailReads` rides the sessions payload
per host, and the browser's seed pass keeps its old size budgets ONLY for a host that
cannot tail-read — one updated machine must not license a prefetch storm against one that
is still updating. The master also keeps a bounded warm window per session
(`windowCache`, invalidated where the parse memo is), checked against the INDEX's
(size, mtimeMs) rather than a fresh `stat`: measured, the browser→master leg of an open is
65 ms and the master→agent tunnel is ~470 ms, so a stat to prove freshness would hand most
of the saving straight back. A window one write out of date for a moment is precisely what
a paint is allowed to be.

**A tail knows what was said, not always what said it.** Claude repeats the model on every
assistant record and the permission mode whenever it changes, so its tail always carries
the current settings. A Codex rollout writes them in `session_meta`/`turn_context` records
at the HEAD — so a tail-only preview reported model/effort/mode all null, and the
composer's selects fell back to defaults until the full load landed. The reader therefore
also fetches a bounded HEAD slice for those engines and fills in ONLY what the tail could
not see (the tail is fresher wherever it has an answer — a `/model` mid-chat must win).
128 KB, measured not guessed: across the eight largest real rollouts on one box the first
`turn_context` sat between 34 KB and 84 KB in, so the obvious 64 KB missed most of them.

**And a paint may not blank what a load established.** `applyPayloadMeta` keeps the
previous value whenever a `partial` payload reports null, because the sequence on a cold
open is paint-then-load and a paint landing after a load would reset the composer to
defaults and drop the cost chip. That is only safe because every session switch clears
`state.sessionMeta` first — otherwise it would carry the previous chat's model into the
next one.

A compressed rollout (`.jsonl.zst`) has no tail to seek to and keeps the old path.

## Transcript cache (browser, `public/js/transcript-cache.js`)

A cached payload is a PAINT, never truth — the v1 cache (`transcript-store.js`, deleted
2026-07-23) restored a snapshot and stopped there, which is how it showed stale turns.
Every hit is followed by a fetch against the host, never by nothing.

Two entry kinds: **full** (a chat you opened; caught up with a `?since=<totalLines>`
delta — missed turns append with no repaint, a rewritten file returns `reset` and
repaints, a 404 drops the entry) and **seed** (5 messages of a chat you have NOT opened,
prefetched at boot by `public/js/transcript-seed.js`, so the FIRST open of any chat also
paints in-frame; opening one paints it and then runs the ordinary full load, which
promotes the entry).

**Two escape hatches wipe it wholesale.** A **hard refresh** (Ctrl/Cmd+Shift+R) clears
every cached chat and lets the seed pass rebuild — detected by `shouldClearOnBoot()`,
which reads the one dependable tell: browsers bypass the service worker for a hard
reload, so the page is uncontrolled while the worker is still registered
(`termdeck-sw-controlled` in localStorage records that a worker has ever driven this
browser, so a browser without one isn't wiped on every reload). It runs synchronously at
module scope in main.js, before boot opens anything. **Settings → Clear local data**
calls `transcriptCache.clear()` *before* `deleteDatabase('termdeck')` — that delete
cannot do it alone: this tab's open connection makes it fire `blocked` and wait
indefinitely (measured), and the data only disappeared because the immediate
`location.reload()` tore the connection down, i.e. the wipe depended on unload timing.
`clear()` empties the store, closes the connection, and gates reads behind the wipe.

Entries also expire after **2 days** (`TTL_MS`) — enforced on read and in the prune every
write runs; `sweep()` at boot does the expiry AND reports what is still cached, which is
the set the seed pass diffs against. Two layers — a synchronous in-memory LRU (chat
switches repaint in-frame; seeds never enter it, a 200-chat prefetch must not evict the
12 chats in use) over a lazily-read-by-key IndexedDB tail (reload / PWA cold start),
pruned to separate budgets per kind via a `['kind','savedAt']` index. Process state
(`live`, `activeStartedAt`) is never cached: the WS `subscribed` snapshot owns it, and a
stale `live` would lock the composer view-only against nobody.

**A 5-message preview costs a FULL PARSE of the transcript** — that is the number that
governs this whole feature. Measured 2026-07-26 on one real machine: 366 chats, 1,194 MB,
median 312 KB but p99 72 MB and a largest of 124 MB; on cloud each of those is a tunnel
read off the user's own uplink.

So the boot pass takes **both its scope and its order from the sidebar** —
`sidebar.visibleSessionKeys()` reads the rendered rows top to bottom (pinned → needs-you →
active → new → folder groups), skipping rows inside a collapsed `<details>`. Read, never
recomputed: which chats the sidebar shows is the product of the opt-in gate, archive
filter, text filter, `chatVisible` and the per-project `SESSION_CAP`, and a second
implementation drifts. There is deliberately **no fallback ordering** — an implicit "sort
by modifiedAt then" is what made the pass fetch chats that weren't in the sidebar before
ones that were; an empty sidebar seeds nothing. It re-arms when the visible set changes
(`seededOrder` signature, re-kicked from `onData`) so expanding a folder warms it.

On top of that it is bounded by **bytes, not count** (`SEED_BYTE_BUDGET` 10 MB,
`SEED_MAX_BYTES` 2 MB/chat), priced client-side from the session list's own `sizeBytes` so
nothing is requested to discover it was too expensive. It also sends **`?seed=1`**, which
does two things: caps the prompt anchor at `SEED_ANCHOR_CAP` (30, mirroring the client's
`SEED_MAX`) and makes the host read its parse memo without filling it. The anchor cap was
found by running it — on a real 118 MB chat `?preview=5` returned **92 messages / 8.3 MB,
byte-identical to `?preview=15`**, because one agentic turn ran 92 messages deep and the
anchor backed up the whole way; the client then stored 5 and threw away 87. Capped, that
seed is 5 messages / 0.57 MB. The anchor stays uncapped for a real open — landing on a
promptless wall of tool output is worse than the bytes (`{store:false}` in
`lib/parse-cache.js`; that memo is 64 MB against 124 MB transcripts, so a storing prefetch
evicts the chats you have open).

Everything the budget skips is carried by the **hover prefetch** (`prefetchTranscript` in
main.js → the `onPrefetch` hook `sidebar.js`/`board.js` have always had and main.js never
passed): a 120 ms hover-intent delay so sweeping a list costs one fetch and not one per
row, then the full open window, so the click opens on a `?since` delta. Beyond that the
seed pass is newest-first, 2-at-a-time, idle-scheduled, skips archived/offline/open chats,
and stands down while the tab is hidden.

**Debugging it:** `public/js/cache-log.js` narrates every hit/miss/seed/expiry to the
browser console under a `[cache]` prefix (on by default — the cache's job is to be
invisible, so there is nothing on screen to look at when it misbehaves);
`termdeck.cache()` tables what's stored, `termdeck.seed()` re-runs the prefetch,
`localStorage['termdeck-cache-log']='0'` silences it. Covered by
`tests/transcript-cache.mjs` + `tests/transcript-seed.mjs` (pure),
`tests/transcript-cache.spec.js` (browser), `tests/transcript-window.mjs` (guards the
wiring and the preview-window coupling).

## The turn's stdin stays open for the whole turn (`lib/cloud/remote-runner.js`)

The CLI is spawned in `--input-format stream-json` and its **stdin is held open until
the turn really ends**, so more user frames can be written while the turn runs. Two
separate things depend on that:

1. **Background Agent tasks.** A turn that launches one keeps running past its
   first `result`; with stdin already closed the CLI cannot send a
   `can_use_tool` control request, and every later permission dies instantly with
   "Tool permission request failed: AbortError: Stream closed". This is why the
   stream is held open at all — `pendingAsync` counts the extra results still owed.
2. **Mid-turn steering.** Because it is already open, a second user message can
   reach a RUNNING turn — no interrupt, same session id, CLI never killed.
   `MachineHost.steerTurn()` → the handle's `steer()` writes one. Measured on real
   turns: omitting `priority` absorbs the message into the current turn (**one**
   `result` frame) and never writes it to the jsonl; `priority:'now'` closes the
   current turn and answers in a new one (**two**). We send `'now'`
   **unconditionally** — an absorbed message is answered but never persisted, so a
   chat rendered from disk shows the model reacting to something the user cannot
   see, after their message was cleared from the composer. `pendingSteer` records
   the extra result each steer owes, with a timeout backstop so a steer that never
   lands can still let the turn finish rather than pinning the process.

**The child must still be reaped on every exit path.** A CLI left alive holds its
session in the live registry, which view-only-locks the chat for up to 48h;
`machine-host`'s orphan reaper is the backstop, and it only ever kills a pid it
watched serve a turn of ours.

Claude was believed to be un-steerable, so a mid-turn send **aborted the turn and
re-sent**, which the user saw as their own chat stopping and restarting with the
in-flight work discarded. Nothing required that. Which engines may steer is decided
in ONE place server-side (the per-engine branches of `MachineHost.steerTurn`) and
mirrored by the `steer` flags in `public/js/engines.js`; `tests/steer-capability.mjs`
fails if they drift, because a mismatch either offers a steer that always throws or
hides one that works. Grok stays out — it has no `turn/steer` analog in the ACP
surface. Covered by `tests/steer-claude.mjs` + `tests/steer-capability.mjs`.

## Preview windows are shared (`previewWindow` in `lib/transcript.js`)

The prompt-anchored last-N window. EVERY route in `master.js` that clamps `?preview`
must clamp it to the same number, and `readTranscript` must actually pass it through. It applied no window at all until
2026-07-26, so every cloud open shipped the whole transcript over the tunnel; with the
browser now seeding from previews that would be every transcript on the machine. A
`?since` delta is never windowed — it IS the tail the client is missing.

## Scroll-up history (`maybeAutoLoadEarlier` in `transcript-view.js`)

Reading back through a long chat keeps a **buffer** of rendered history above the viewport
(`AUTO_EARLIER_VIEWPORTS` 1.5, floor `AUTO_EARLIER_MIN_PX` 600) rather than triggering at
the very top. It used to fire only within 200px of the top, and both prepend paths anchor
`scrollTop` past that — so it was one batch per trip to the top, i.e. ~66 deliberate
scroll-to-top trips on a 1,000-message chat. The check re-runs after every prepend (both
paths end in `scheduleViewportPrompt`), so it tops the buffer up as the reader consumes it
and stops once there's a threshold's worth above — bounded by height, not a batch count.
It cannot fire on open: pinned to the bottom, `scrollTop` is `scrollHeight - clientHeight`,
which can't be both greater and less than the threshold. The `.load-more` buttons stay as
the fallback for a transcript too short to scroll, where no scroll event will ever come.
Covered by `tests/transcript-scroll.spec.js`.

## A delta may only be spliced onto the cursor it was fetched at (`applyDelta`, `resync`, `appendDelta`)

A `?since` delta is a **splice**, so it is valid only against the exact history it was
computed from. Every path that applies one carries the cursor it was FETCHED at and
refuses a mismatch — `view.applyDelta(payload, expectedFrom)`, `transcriptCache
.appendDelta(key, delta, expectedFrom)`, and `revalidateTranscript`'s explicit
`state.clientTotal !== since` check before either.

This is the duplicated-transcript bug, and the reason it took **two live chats** to see:
the WS push path never stops on a live chat, so a fetch issued while one is running is
almost certain to overlap it.

- **On screen.** `revalidateTranscript` (a chat opened from cache) read `state.clientTotal`,
  awaited a fetch, then spliced. Mid-flight, `transcript-append` applied its own delta at
  that same cursor. The fetch then landed carrying lines already rendered — they appeared a
  **second time**, and `state.clientTotal` was set *backwards* to the stale `totalLines`, so
  every later push mismatched too and the chat never reconciled again. `cacheCurrent()` then
  wrote the doubled list to the cache. `resync()` had the identical hole and could not heal
  it, being the thing that ran.
- **In the cache.** The pinned refresh read a cursor, fetched, and concatenated — but in
  that window the user can OPEN that chat, which hands the entry to the view and `save()`s a
  deeper one. Nothing ever revalidates a cache entry's *interior*, so the duplicated tail
  survived every subsequent open until the entry aged out.

`resync()` **loops** (`RESYNC_MAX_ROUNDS`) rather than dropping a superseded payload: it
refetches from the new cursor, so the gap between the push's `totalLines` and the host's is
still filled. Dropping silently would strand those lines until the next write.

Covered by `tests/transcript-window.mjs` (the guard in `revalidateTranscript`),
`tests/transcript-cache.mjs` (a stale-cursor `appendDelta` is refused and does not mutate
the entry), and `tests/pinned-live.mjs` (the cursor is passed through).

## Error frames are scoped to a session (`lib/cloud/hub.js` → `main.js`)

One browser socket drives every chat, so an `error` frame is a reply that may belong to a
chat you are not looking at — a queued turn that failed, or a permission answered from the
approvals inbox. Unstamped, it was rendered into whichever chat happened to be open and
could flip *that* chat's run state (`RUN_IN_PROGRESS` / `SESSION_ATTACHED`). Both hubs now
stamp `sessionId` from the request that caused it (a per-message `fail()` closure, so new
call sites get it for free); the browser toasts anything belonging elsewhere and leaves the
open chat alone. `permission-response` carries `sessionId` purely so `STALE_PERMISSION` can
be attributed — routing is still by `requestId`. Genuinely connection-level errors
(`BAD_JSON`, `UNKNOWN_HOST`) stay unstamped and keep the old behaviour.

## The chat list is one paged stream (`public/js/session-stream.js` + `sidebar.js`)

The sidebar below the Pinned / Needs you / Active / New trays is **one list, ordered by
time and nothing else**: every chat in every project you added in Settings → Projects, on
every reachable machine, newest first. There is no folder group, no device group and no
per-project cap — those all encoded "where a chat lives" into the shape of the list, and
the shape of the list is now only "when did it last move". A row therefore has to carry
its own context (folder name, the folder-health ⚠ that used to sit on the group header,
and the device chip on a multi-host hub), because nothing above it can.

**The window is the load-bearing part.** The pool is unbounded — a real box here is 600+
chats — so only `PAGE_SIZE` rows are rendered and an `IntersectionObserver` on the tail
adds a page as it comes within `PAGE_MARGIN` of the fold. That is not (only) a DOM budget:
`visibleSessionKeys()` reads the *rendered rows*, and the transcript seed pass follows it,
so **a chat costs a preview fetch only once it has been scrolled to**. A "just render them
all" change is silently also a "fetch a preview of every transcript on the box" change —
which on the cloud path is that pull over the customer's own uplink (see the seed budget
in `transcript-seed.js`). For the same reason paging in rows must fire
`termdeck-sidebar-paged`, or the chats you scrolled to are never seeded at all.

`shownCount` survives re-renders (`sessions-updated` fires many times a second during a
turn — a list that snapped back to page one under the reader would be unusable) and resets
only when the filter changes, which is a different list. The OPEN chat is paged to when it
sorts below the window, capped at `REVEAL_CAP` rows: past that, revealing the selection has
become rendering the fleet, and the filter is the way to reach a chat that old.

A chat appears **once**: the trays win, and the stream skips their keys. An unreachable
host contributes no rows and gets one `.host-down` line instead — its chats cannot be
listed, and silently omitting the machine reads as "you have no chats there".

Rules are pure and unit-tested in `tests/sidebar-stream.mjs` (`streamRows`, `pageLimit`);
what the page renders is pinned by `tests/sidebar-stream.spec.js`.

## A list REPAINTS, it is never rebuilt (`public/js/list-reconcile.js`)

The sidebar and the fleet board both used to render by emptying their container
(`list.textContent = ''`, `root.textContent = ''`) and appending a freshly built node for
every row. Correct, and the reason the UI read as unstable — the user's words were "chats
flicker and move around once getting started". Three separate symptoms, one cause:

* `.session-list` is the **scroller**. Emptying it collapses the content height to zero,
  the browser clamps `scrollTop` to 0, and re-appending does not put it back. A scrolled
  sidebar snapped to the top.
* The node under the pointer was destroyed mid-hover, taking focus, the open context menu
  and any in-flight CSS transition with it.
* A row's identity was thrown away and remade, so nothing could ever be animated — a chat
  moving into the Active tray was a delete in one place and a create in another.

And it happened **on a clock**: `sessions-updated` drives a render every 2s
(`REFRESH_MS`) for the whole length of a turn, plus a render each from `folderCheck`
resolving, the `newExpiryTimer`, and every prefs change.

So every child is keyed and kept. `reconcilePlan(currentKeys, desiredKeys)` is pure and
returns the minimal `{ removed, inserts }`; **a render where nothing moved performs zero
DOM operations**, and one where a row moved performs one. That property is the whole
module — `tests/list-reconcile.mjs` asserts it directly, and asserts the invariant the
applier leans on: every `before` names a key already in the container when its insertion
runs, or `insertBefore` would throw `NotFoundError` at runtime instead of failing a test.

**A row whose contents changed keeps its outer element anyway** (`morph`): attributes are
synced and the fresh children adopted. Those are exactly the rows that matter — a chat
growing a status pip is the one being hovered and the one about to be animated — and
everything durable about a row lives on the outer node (its click / middle-click / hover-
prefetch / context-menu listeners, its focus, and the identity FLIP measures against).
The children are disposable markup.

**Which is why a row's listeners read through a `ctx` holder, never through the arguments
of the render that built them.** `/api/sessions` hands back brand-new session and project
objects roughly twice a second; a node that outlives its payload would otherwise rename,
open and prefetch an object frozen at whatever the list said when it was first drawn.
`keep()` creates the holder once per key and passes the same one to every rebuild, so the
DOM is old and the data behind it never is.

Reuse is decided by comparing `outerHTML`, deliberately, rather than a hand-written
signature: a signature is a second description of what the row renders and it drifts the
first time someone adds a field and forgets it — the symptom being a row that silently
stops updating. The HTML is derived from the render itself, so it cannot disagree with it.

Two more things ride on keeping nodes: `anchorScroll`/`restoreScroll` (the list moves
around the reader instead of under them — native `overflow-anchor` does not cover a
promotion above the viewport), and `flipRead`/`flipPlay` (a row that genuinely changes
place slides there; skipped under `prefers-reduced-motion`, and skipped past
`FLIP_MAX_PX`, where it is a jump rather than a move).

Pinned in the browser by `tests/list-stability.spec.js`, which asserts **node identity** —
every symptom above reduces to it. Note how it repaints: via the app's own
`termdeck-overrides-bulk` event, because main.js imports `./sidebar.js?v=<deploy token>`
and a test's `import('/js/sidebar.js')` resolves to a *second copy of the module* with its
own empty node cache.

## The cached session list carries no liveness (`public/js/session-cache.js`)

The list-shaped sibling of the transcript cache, and it was not being held to that
module's contract. It used to be one raw `JSON.stringify(state.data)` in localStorage: no
schema version, no TTL, and — the part that hurt — it stored **process state**. `live`,
`webActive`, `recentlyActive`, `host.results` and `host.attention` all went to disk and
came back as fact on the next boot. That is the mistake `transcript-cache.js` documents at
`PAYLOAD_FIELDS` and does not make.

The visible failure: boot painted a Pinned / Needs-you / Active tray layout from **last
session's** liveness, then `/api/sessions` answered a few hundred ms later with the real
thing and every affected row moved. Chats appeared to shuffle themselves as the app
started.

**A cached list is a paint; the network answer may only ADD to it.** Everything only the
host can know right now is stripped on the way in, so a cached paint renders a plausible,
quiet list — no tray promotions, no status pips, no error badges — and the real payload
fills those in without ever having to take one back.

`ok: true` is the one deliberate optimism. An absent `ok` makes `sidebar.render` draw an
"unreachable" banner for every machine; a cached `ok: false` opens the app on a probably-
wrong outage. The fetch already in flight is what gets to say a box is down.

Also: versioned (`SCHEMA`) and expiring (`TTL_MS`, 2 days) so a shape change or a laptop
shut for a week is a miss rather than a wrong paint; bounded (`MAX_SESSIONS`, spent
newest-first **across** the fleet rather than per host) because the payload is O(all chats)
— 398 KB across 1,089 chats on one real box — and writing that is a synchronous
main-thread stall; and **whitelisted rather than blacklisted**, so a process-state field
added to the payload later cannot leak in by default. Unit-tested in
`tests/session-cache.mjs`.

## The opt-in gate is a PAINT too, or the cached list is worthless (`public/js/overrides-cache.js`)

The cache above did its job and it did not matter, because a second network-only store sat
in front of it. A project is "added" iff it carries a title override (`projects.js`
`isAdded`), `sidebar.js` and `board.js` gate **every row** on that, and the overrides map
was fetched fresh every boot. So for the length of one request every folder read as
unadded, the cached paint rendered zero rows, and the sidebar concluded it was looking at a
first-run box and said so. Measured on termdeck.io, warm shell and warm session cache:

```
t=107ms  rows=0   "No projects added yet — pick your folders in Settings → Projects."
  121ms  /api/overrides 200
t=221ms  rows=18                       <- the session cache, finally allowed through
  372ms  /api/sessions 200
t=424ms  rows=23
```

On a phone link that is the reported "3-4s of 'no projects added', then the chats appear".
The user is told their fleet is gone and pointed at a folder picker they have already used.

Same contract as the two caches above — **a cached map is a paint; the network answer
replaces it wholesale** — plus two deliberate differences, both because of what an override
*is*:

- **No field whitelist.** `session-cache.js` whitelists because its payload mixes user
  config with process state, and a cached claim about liveness is a wrong claim. An
  override has no such half: title/archived/pinned/web/path are all things this user set on
  some device. There is nothing to strip, and copying verbatim keeps a field added to the
  store later from being silently dropped in transit.
- **A 30-day TTL** (vs the session list's 2 days). This is configuration, not observations
  of a moving world. An expired entry costs exactly the bug above, so erring long is the
  safe direction.

Three rules the shape forces:

- **A failed fetch keeps the paint.** `catch { map = {} }` used to be free — the map was
  empty anyway — but against a cache it throws away the only copy this browser has and
  hides every chat behind the opt-in gate because one request failed.
- **A patch is never merged onto a paint.** `setOverride` merges onto the current value and
  PUTs the result, and the cache is bounded — patching an entry the cap dropped would PUT
  away its other fields (a pin quietly eating a custom title). `setOverride` awaits
  `settled()` first. Project keys are exempt from the cap for the same family of reason:
  they are the allowlist this cache exists to carry.
- **Two flags, not one.** `answered` (the host replied) guards writes; `attempted` (the
  request finished, either way) guards the empty-state *claim*. Gating "no projects added
  yet" on `answered` would leave a genuine first-run user staring at a blank sidebar with
  nothing to click whenever the fetch failed. Neither is `isAdded` — that reads the map.

Unit-tested in `tests/overrides-cache.mjs`. A machine rename drops this cache
(`host-rekey.js`) for the same reason it drops the session list: every key embeds the host
name, and rewriting a cache is how a cache starts lying.

## The index asks the machine a QUESTION, not for its bytes (`lib/index-head.js`)

Rebuilding the session index used to mean streaming transcripts to the master and parsing
them there. Measured against a real box (200 sessions, 2,675 files under `~/.claude`):

```
listTree      2 calls    0.79 MB   <- EVERY rebuild, whether anything changed or not
readFile    581 calls  124.17 MB   <- cold index
                                      3.1s on loopback, ~67s over a home uplink
```

124 MB to learn 200 titles and 200 timestamps. The head probe read up to 128 KB hunting a
cwd that is in the first 4 KB of 165 of those 200 files; the widening tail scan walked back
through megabytes hunting the last user prompt. And the walk was the WHOLE tree — ~1,900 of
those 2,675 entries were subagent transcripts and sidecars the master discards on arrival.

On the user's side that was a reload sitting at 3–4s, because `/api/sessions` is what the
sidebar waits for, and the index is dirty whenever a chat is being worked on — which is
always, on the machine you are using.

Two capabilities, both gated on agent >= 0.0.51 with a fallback to the old path:

- **`indexScan`** — the walk, filtered agent-side to plausible session files and sent as
  paths relative to the root. 0.79 MB -> 0.10 MB. The filter is deliberately COARSE and
  structural: the master still owns the exact shape rules and re-checks every survivor, so
  this never becomes a second copy of `UUID_JSONL`/`ROLLOUT_RE` drifting on its own.
- **`indexHeads`** — the head/tail PARSE, run where the disk is. The answer crosses the
  tunnel instead of the file. Same trade `lib/tail-read.js` already documents for previews.

**The parse is ONE module.** `lib/index-head.js` takes its reader injected, and runs on the
agent against local fs or on the master against Transport for an agent too old to have it.
Two copies would be two sets of title/cwd rules drifting apart. `scripts/index-head-check.js`
builds the same fixtures both ways and fails on any difference; `tests/agent-manifest.mjs`
pins the shipped set, because an installed agent's directory is FLAT and a module that
requires a dep nobody shipped is a crash-loop on boot, not a degraded capability.

Result on the same box: cold index 3.1s -> 0.87s, rebuild 135ms -> 50ms, and the recurring
0.79 MB per rebuild is gone.

## The thinking dial lives on the MACHINE (`lib/session-settings.js`)

SDK-SIGNALS §I says the dial is sticky because there is one `Query` per turn, so
`setMaxThinkingTokens` has to be re-applied at every init. What it did not have was
anywhere to live: the value sat in `MachineHost.stickyThinking` and nowhere else. Every
backend deploy restarts the master, so the dial silently reverted to "Default" while the
reader believed thinking was off — and a second device never knew about it at all. The
browser's `termdeck-thinking:<key>` localStorage copy is a HINT that covers one browser.

So the machine stores it, written by the agent (>= 0.0.52).

**A sidecar, not a transcript record.** Renames take the other route —
`lib/session-title.js` APPENDS a `custom-title` line to the chat's own jsonl — and that is
safe *precisely because* `custom-title` is the CLI's own record type, one it already writes
and reads. There is no CLI record for a thinking dial. Inventing a type and writing it into
Claude Code's transcript would put bytes the CLI never wrote into the file it owns and
resumes from, to save a sidecar. Not worth it for a preference. The file is
`.termdeck-session-settings.json`, INSIDE a transcript root for the same reason the agent's
`.termdeck-trash` dir is: a compromised master still cannot make the agent write outside
`~/.claude`.

**The master names a session id and a typed value, never a path** — the agent resolves the
file against its own roots, and builds the record with the same module the master validates
with. Same posture as `restore` and the title/tag ops.

Rules the shape forces:

- **Clearing REMOVES the row**, it does not store a row of nulls — an entry asserting
  defaults would out-rank a future default change, and a restart would resurrect a dial the
  user turned off.
- **The write-through is not awaited.** A preference must never make the call that set it
  feel slow, and the in-memory copy is updated regardless, so a machine that refused the
  write still behaves correctly until the next restart.
- **Live memory outranks the machine's copy** (`thinkingFor`): only the master knows about a
  `rekeyRun` mid-turn.
- **Every read failure is a MISS, and a file we did not write is left alone.** It is the
  user's machine; an unparseable sidecar is not ours to delete.
- Bounded (`MAX_SESSIONS`) because the file is read whole, and tmp+rename so a reader never
  sees half of it.

Still not solved, and not solvable this way: a chat driven ONLY from the terminal has no
dial to record, because nothing set one through Termdeck. It reads "Default" because that is
the honest answer. `scripts/thinking-persist-check.js` drives the real path against a real
agent, including that the chat's own transcript is not written to.

## A build in flight is JOINED, never raced (`MachineHost.refresh`)

`buildIndex()` clears `dirty` on its FIRST line, deliberately: an fs event landing mid-walk
has to re-mark the index rather than be swallowed by the walk already running. The cost is
a window where `dirty` is false and `this.rows` has not been written yet — and `refresh()`
read exactly that as freshness:

```
refresh  fresh=false  -> starts buildIndex        (dirty cleared immediately)
refresh  fresh=TRUE   building=true builtAt=0     -> returns WITHOUT waiting
buildIndex END        all=1 rows=1                -> too late, the caller already answered
```

So a caller arriving mid-build got the index as it stood BEFORE the build, which on the
first build is the empty map: right after a master restart the first `/api/sessions` for a
machine came back with no chats at all, and only the next request was correct. The browser
recovers on its own two seconds later, which is exactly why it went unnoticed for so long —
an empty sidebar for one beat reads as slowness, not as a wrong answer.

**"Not dirty" during a build means already CLAIMED, not ready.** `refresh()` returns the
in-flight `this.building` before consulting freshness at all.

And **`builtAt` is the only proof a build FINISHED**. A build that throws leaves `dirty`
false with no index behind, which without that check reads as permanently fresh and
permanently empty until some unrelated file event happens to re-mark it — on an idle machine,
possibly never. Freshness now requires `builtAt > 0`.

`scripts/index-first-build-check.js` pins both, and both of its assertions were verified to
FAIL with the fix reverted. It deliberately carries no "concurrent callers" case: two
synthetic versions were written and both passed against the un-fixed code (one because a warm
rebuild outran the followers, the other because an earlier build was still in flight so the
stub never ran). A case that cannot fail is worse than no case — it reads as coverage.

## An optimistic claim must OUTLIVE the refetch (`public/js/session-optimistic.js`)

`sidebar.refresh()` is `state.data = await fetchJSON('/api/sessions')` — a **wholesale
replacement**, every two seconds for the length of a turn. So any UI code that patched
`state.data` to paint something instantly had a life expectancy of exactly one refetch.
Two places did: `markLive` (a turn started — set `webActive`, pull the row to the top of
the time sort) and `markSessionSeen` (you opened the chat — drop its unseen result).

Reported as "every new chat goes down in the list, then comes back up":

1. the turn starts → `webActive: true`, `lastUserAt: now` → the row jumps into the Active
   tray at the top;
2. the refetch lands. The host has not seen the turn yet — over the cloud tunnel the
   transcript is still being written and scanned — so it answers `webActive: false` and
   whatever `lastUserAt` the file last parsed to, which for a brand-new chat is older than
   our claim or missing entirely. The patch is gone; the row falls out of the tray and down
   the list;
3. seconds later the host catches up and the row climbs back.

Opening an errored chat did the same through `markSessionSeen`: the row left "Needs you",
the refetch put the result back, and it returned.

**The fix is not to patch harder.** A claim is RECORDED, re-applied to every payload that
arrives, and **retired the moment the host agrees** — after which the host drives, which
is the only rule that cannot drift. Every ingest goes through one `ingest()` in
`sidebar.js` (stubs + patches together), because a path that forgets one is a path where
the UI silently reverts.

Two kinds of claim, with deliberately different rules:

* `webActive` / `seen` — a boolean about right now. Overrides the payload until the payload
  says the same thing **once**, then it is dropped. A half-confirmed patch never retires
  its other half: that is how a row would revert mid-turn.
* `since` — a timestamp **FLOOR**, never an override (`max(host, ours)`). A floor cannot
  move a row backwards, so the worst a wrong one does is hold a chat too high for a few
  seconds; an override could park it in the future indefinitely. Note a turn ENDING claims
  nothing about *when* — it is not "you just typed here".

Everything expires (`CONFIRM_TIMEOUT_MS`). A claim the host never confirms was wrong (the
turn died, the socket dropped, the session was deleted), and holding it would be exactly
the stale-liveness lie [the session cache](#the-cached-session-list-carries-no-liveness-publicjssession-cachejs)
refuses to tell. A claim for a session the payload does not carry **yet** is kept, though —
a just-created chat is precisely that case. Unit-tested in `tests/session-optimistic.mjs`.

## "Not in the list" is not "does not exist" (`handleHash` + `sidebar.dataIsFresh`)

`#/<session id>` resolves by scanning `state.data`, and a miss used to call
`closeSession()`. Boot paints from the cached session list first (`paintCached`, then
`handleHash` against it), and that list is a couple of seconds behind and never carries a
chat created since it was written — so reloading on a chat you had just started resolved
to nothing and dropped you on the board, with nothing to re-run the route once the real
payload landed.

`dataIsFresh()` is the distinction: false until the HOST has answered. A miss against a
non-fresh list parks the hash in `pendingHash` and returns; sidebar's `onData` re-runs the
route once the payload lands, guarded on the hash not having changed under it. A miss
against a fresh list is a dead link and still closes. Demo mode calls `markDataFresh()`,
because its fixture is as authoritative as it gets and there is no fetch coming.
Pinned by `tests/deep-link-resolve.spec.js`.

## Promotion into a tray is instant; demotion is held (`trayMembership` in `session-stream.js`)

The trays are the one place a row legitimately moves, and the flags behind Active flap:
`webActive` clears between a turn ending and the next starting, and `recentlyActive` is a
rollout-growth heuristic that goes quiet on its own poll interval. Without a floor a chat
mid-conversation bounces between the tray and the stream.

Promotion stays instant — that is the feedback that the send worked. Demotion is held for
`TRAY_HOLD_MS`, and the hold returns its `until` so the render that finally releases the
row can be **scheduled**, rather than waiting for whatever data push happens along next.
Settings → Chats "active retention" (`activeLingerMin`) is the same idea under the user's
control and can only make it longer; this is the floor when it is off.

## Pinned chats follow the host live (`public/js/pinned-live.js`)

The rest of the cache makes a chat fast to PAINT; a pinned chat also has to be *current*
the moment you open it. It rides the **`sessions-updated`** broadcast (the hub sends it to
every client on any watcher-dirty; the cloud master forwards it per machine), so it needs
**no protocol change** — server-side `state.sub` is singular, so only the OPEN chat gets a
real subscription and that's left alone. On the push it fetches a `?since` delta per
pinned chat and `transcriptCache.appendDelta()` appends it, mirroring `applyDelta` exactly
(append as sent, take `totalLines` as the new cursor) so there are no new merge rules.

**Four things keep it affordable**, since `sessions-updated` fires on every write:
pinned-only (a user-curated set — the tabstrip), a 500 ms trailing debounce (one delta per
burst, not per token), sequential (a fan of parallel requests per burst is the failure
mode), and **tail-only** — `cursorFor()` returning 0 means no cache entry yet, and it skips
rather than pulling a whole transcript (first contact is the seed pass's job). Narrowed to
the event's own host; skips the open chat (the view owns that entry); a `reset` drops the
entry rather than splicing two transcripts; never promotes into the memory LRU (a few
pinned chats must not evict the 12 in use). Covered by `tests/pinned-live.mjs` + a browser
test that pins mid-run.

## Activity fold (`transcript-view.js`)

Consecutive non-prose blocks (`OPENS_ACTIVITY`: tool calls, thinking, checklists, local
command output; `JOINS_ACTIVITY`: results and task notifications, which only ever join a
fold already open) mount into a single collapsed `<details class="activity-fold">` with a
per-tool summary. The blocks themselves render **unchanged** — only where they are mounted
moves, which is what keeps the tool_use → `toolSlots` → tool_result pairing working (a
closed `<details>` keeps its children in the DOM).

Three rules make the ordering come out right, and each is a bug that was hit:

- **Prose delimits the run, not the message.** An assistant message is one jsonl line per
  content block, so one turn arrives as many records and has to render bubble/fold/bubble.
- **The message frame is built lazily** and appended when a prose block actually lands in
  it. Appending it after the block loop (as it did) puts the frame BELOW a fold its own
  blocks opened.
- **A message that folded anything stops being the assistant-merge target.** Otherwise the
  next record for that same `message.id` renders back into the bubble *above* the fold and
  the turn reads backwards.

`clear()`, `renderWindowed()` and `emitTurnDuration()` all `closeActivity()`.

The CSS must stay scoped to `.workspace-app .transcript` and placed after that shell's own
restatement of the tool-call theme — unscoped it loses to `.workspace-app .transcript
details.fold[open]` regardless of how many classes it stacks, and the open fold computes to
a bordered `rgb(23,23,23)` container nested inside the tool rows' own boxes. The spec
asserts the **computed** style for exactly that reason. Covered by
`tests/activity-fold.spec.js`.

## Loading ring (`setLoading` in `transcript-view.js`)

One conic-arc spinner (`.tx-loader` / `.tx-spinner`, ember to match the composer's focus
ring) placed where the fetch is — **top** when history is being pulled in above the reader
(scroll-up `loadEarlier`, and the "load the rest" half of a *seed* open, since what's
missing there is above), **bottom** when messages arrive below (cold open, `?since`
revalidate). Position is the whole point: a centred spinner says something is happening,
an edge one says what you're waiting for. It replaced the "Loading earlier messages…"
button and the "Loading <title>…" notice. `setLoading` mutates one element rather than
re-rendering (a rebuild would cost the reader their scroll), but `renderWindowed` re-emits
it so a rebuild doesn't drop it; `clear()` resets it, it survives the 404 retry loop
without blinking, and it's appended after `bubblesToEnd` so a streaming bubble never sits
below it. Alone in an empty pane it takes `min(60vh,420px)` and centres. Covered by
`tests/transcript-loader.spec.js`.

## Agent self-update is reversible (`agent/agent.js` + `lib/cloud/relay.js`)

A customer machine must never need hands on it, so an update is not "done" when the files
land — it is done when the new code gets a **`welcome`** frame back from the master. Four
rules hold that up. The whole file set is **staged and compile-checked** (`vm.Script` /
`JSON.parse`) before anything is overwritten; the old loop wrote each file as it arrived,
so a 502 on file 7 of 12 left a half-new agent that ran fine until the next restart and
*then* crash-looped. The set that was running is **snapshotted to `.rollback/`** before the
swap. An in-flight update leaves a **marker** (`.update-state.json`) that only `welcome`
clears, watched by two watchdogs — a boot counter for code that crash-loops (plus an
immediate undo if `require('./capabilities')` throws) and a 5-minute timer for code that
runs but never hand-shakes. A version that fails is **quarantined** so the same push can't
be taken twice (`force` is the operator's override for that and for `busy`). The heal
block sits ABOVE every other require on purpose: the files it restores are the ones a bad
update makes unloadable.

Master-side, convergence is on version **inequality**, not "older than" — a bad release
has to be recallable, and `verLt` could only ever roll forward. Rolling back lands the
agent on code too old to honour a quarantine, so `nextPush` bounds the retry from the
master's side (doubling from 60s, capped at 30m, reset on convergence, in-memory so a
master restart is the reset button). Covered by `scripts/agent-selfheal-check.js`, which
drives the real agent binary through a corrupt download and a release that cannot come up.

## Repair is the escalation, never the first move (`deploy/heal.{sh,ps1}` + `public/js/machine-health.js`)

The fleet fixes itself first (invariant above); this is what happens when it can't.
`lib/cloud/relay.js`'s `healthOf` only reports `ok:false` after **three** failed pushes, or
when a machine took an update and vanished for longer than its own rollback window (8 min
> the agent's 5-min handshake watchdog + a restart, deliberately — its rollback gets its
full chance before a human is bothered). That flag rides on `/cloud/api/machines` as
`health`, and the dashboard turns it into one modal: numbered steps, one command, and a
third step that **watches the machine reconnect and says so**, so nobody has to come back
and check.

The command is `curl .../heal.sh | sh` / `iwr .../heal.ps1 | iex` — uninstall + reinstall
in one, and it **recovers the token from `~/.termdeck/agent.env` (or the launchd plist, or
`agent.env.cmd`) itself**, which is the whole point: a repair that starts with "go find
your token" is a repair that ends in a support ticket, and a fresh token would orphan the
machine's chats under a new id. It retries the install 3× (`TERMDECK_HEAL_RETRY_SECS` is
the test seam) and then prints the three things to check, in likelihood order. heal drives
the real `install.sh` rather than duplicating it — `TERMDECK_NO_PROMPT=1` skips its
source-review prompt, and that flag must survive install.ps1's UAC relaunch or the elevated
child stops to ask. Covered by `scripts/agent-heal-check.js` (drives the real shell script
against a fake master: token recovery, unattended install, exactly-three-then-stop) and
`tests/machine-health.spec.js`.

## The agent log is written to be handed to us (`agent/log.js`)

`~/.termdeck/logs/agent.log`, the file support asks a customer to send. Two rules make
that safe. The machine token is redacted **on the way in** (`redact()` inside `write()`),
not left to callers to remember — one future log of an error object is all a leak would
take. And nothing the agent *serves* is ever written there: no transcript contents,
prompts, file bodies or chat titles; versions, timings and connection state only. It is
bounded (1 MB, one rotation kept) and `tail()` reaches back into the rotated file so a
rotation seconds before someone asks doesn't hand them a blank page. Every line is written
to be read by the machine's owner, not by us — a close code becomes "Termdeck restarted
(usually a Termdeck update being released)" rather than `1000`.

**"Why did it restart" is the point:** a deliberate exit writes `logs/last-exit` and the
next boot consumes it exactly once, so a restart is reported as *applying update to X* /
*rolled back from X* / — when the marker is absent — *ended without stopping on purpose*,
with `isFirstRun()` keeping a fresh install from accusing itself of crashing. Read from
the dashboard via the **`agentLog`** capability (one fixed file, no path parameter —
deliberately NOT the root-confined `readFile`) → `transport.agentLog` → `GET
/cloud/api/machines/:id/logs`; **a new reply type must also be added to `onFrame`'s switch
in `lib/cloud/transport.js` or the reply is silently dropped and the request times out.**
Offline machines can't be fetched from, which is exactly when support needs the file, so
the dialog hands over the path instead. Covered by `tests/agent-log.mjs`, the log
assertions in `scripts/agent-selfheal-check.js`, and the end-to-end route check in
`scripts/agent-dialin-check.js`.

## The Windows agent runs windowless (`deploy/install.ps1`)

The scheduled task launches `wscript.exe run.vbs`, whose `sh.Run …, 0, True` starts
`run.cmd` with no console at all. A task with an Interactive principal running `cmd.exe`
puts a console on the user's desktop and leaves it there forever, and neither
`-WindowStyle Hidden` nor a `/min` setting removes it (they hide a window that already
exists, and cmd re-shows it each loop). Two details are load-bearing: **`bWaitOnReturn`
must be `True`** so the shim blocks for the life of the agent the way cmd.exe used to —
otherwise the task completes instantly, `MultipleInstances=IgnoreNew` stops suppressing
anything, and the 2-minute watchdog trigger starts a SECOND agent every 2 minutes; and
`run.cmd` uses `ping -n 4` rather than `timeout`, which reads the console and fails
outright ("input redirection is not supported") once there is no usable stdin.
`uninstall.ps1` kills the `wscript.exe` shim too, or its loop just respawns node.

## Stale-run self-heal

The composer stays locked in "generating" while `state.run.status` is starting/running. A
turn started by a process Termdeck doesn't own (a VS Code chat, a `/loop`, a leaked
runner) can die without a run-complete and wedge it. A 5s client watchdog
(`public/js/run-watchdog.js` holds the pure `shouldReapStaleRun` decision; `composer.js`
drives it) reaps such a run — resets it to idle, drops the queue, adds a transcript notice
— once the socket is up, the session isn't view-only, the server reports NO live owner
(`state.live` null), and no progress has arrived for 20s. Gated on `!state.live` so an
owned turn (its runner keeps a non-null `sdk-cli` registry entry) is never reaped;
`noteRunAlive()` (main.js, on stream/tool/run-status) bumps the 20s clock. Covered by
`tests/run-watchdog.mjs`.

Since 0.1.335 the engine can answer the question that 20s window was guessing at:
`system/session_state_changed` (`idle | running | requires_action`, SDK-SIGNALS §4) is
mapped by `noteEngineState()` in `lib/cloud/machine-host.js`
and rides the existing `run-status` frame as `engineState` — reusing that frame rather than
inventing one, because every consumer (browser, board poke, the hub's `lastRunStatus`
dedupe, `lib/cloud/transport.js`'s reply switch) already handles it. When the engine says
`idle`, `shouldReapStaleRun` drops the quiet-window wait — **and only that wait**. Three
rules keep it from making the watchdog worse:

- **`idle` never becomes `run.status`.** The run is ours until the result frame lands and
  `finishRun()`/`finishTurn()` releases the transcript and the live-registry entry. The
  engine calling a session idle says nothing about whether the CLI child has exited;
  unlocking the composer on its word would let a second writer into a live session — the
  fork the view-only rule exists to prevent. It is a hint that tightens the watchdog, never
  authority on ownership.
- **Every other guard still holds** under `engineIdle`: live owner, ws down, view-only,
  awaiting-permission, and the send→registry start grace all still block a reap.
- **The one status change it may make** is promoting a run parked on `starting` to
  `running` — a turn whose own `system/init` hasn't landed yet is demonstrably running
  (the compacting branch promotes the same stuck status the same way). `requires_action`
  deliberately promotes nothing: adopting it as `awaiting-permission` with no pending
  approval would *silence* the watchdog (it treats that status as a legit pause), turning
  a signal meant to reduce wedges into one that causes them.

Covered by `tests/engine-state.mjs` (mapping, both transports) and the `engineIdle` block
of `tests/run-watchdog.mjs`. Codex and Grok never send it; `engineState` is absent there
and the 20s window governs exactly as before.

## `run-complete` is append-only, and its extras come from one normaliser (`lib/result-fields.js`)

`run-complete` is the most widely consumed frame in the protocol: the transcript's cost
chip, the fleet board's "done, not yet seen" pill, push copy (`lib/push-copy.js`), the
approvals inbox, the cloud master's `turn.error` ops event, and the turn-queue drain all
read it. **Adding a key is safe; renaming or reshaping an existing one is not** — every one
of those consumers reads fields by name off a spread payload, so a rename fails silently in
five places at once rather than throwing in one.

Two producers build it from the engine's `result` frame and they must not drift: the hub
(`lib/cloud/machine-host.js` `finishTurn`) and the cloud master
(`lib/cloud/machine-host.js` `finishTurn`, off the raw stream-json relayed over the
tunnel). It is the same CLI emitting the same frame on both paths, so the additive half —
`ttftMs`, `stopReason`, `terminalReason`, `fastModeState`, `permissionDenials`,
`modelUsage` (docs/SDK-SIGNALS.md §5) — is extracted by one shared `resultExtras()` rather
than hand-copied. The twin `usage` blocks immediately above those two call sites are the
duplication this exists to stop repeating.

Three properties the normaliser owes its callers, each guarding a real failure:

- **Everything is nullable.** A customer box on an older CLI just omits these fields, and a
  turn that errors has no `ttft_ms` at all. `null` is an ordinary reading — never a `0`, a
  `NaN`, or a thrown error. `resultExtras(null)` is a legitimate call (`machine-host` can
  finish a turn whose CLI died before emitting a result).
- **The payload is bounded.** A denied `Write` carries its entire file body in
  `tool_input`, and this frame fans out to every subscribed browser *and* every
  watch-flagged control socket. Denials ship as a capped list of capped previews
  (`inputPreview` + `DENIAL_PREVIEW_MAX`/`MAX_DENIALS`); the raw input never rides the wire.
  The full call is on disk in the transcript regardless — disk is truth.
- **Empty collections normalise to `null`,** so an ordinary turn doesn't push `[]` and `{}`
  to every socket for nothing.

On the render side, a *normal* ending must stay invisible: `fmtRunEnd()` (`public/js/util.js`)
maps `completed`/`end_turn`/`tool_use` — and any unknown value from a newer CLI — to `null`,
so the cost chip a user reads a hundred times a day never grew a `· completed` tail. It
prefers `terminal_reason` (the engine's verdict on the whole turn) over `stop_reason` (the
API's verdict on the last response): a turn can end on `max_turns` with every individual
stop reason perfectly normal. Denials render as their own `.denial-line` notice, in ember
rather than `--err`, on the success path *and* the error path — the turn may well have
succeeded, and the denials are precisely what explain a turn that looks like it did
nothing. Covered by `tests/result-fields.mjs`.

## A notification says what the turn DID, and every engine can answer (`lastMessage`)

For a year every finished turn pushed the same five words — "Finished — ready for you" —
while all three engines were handing us the answer and all three call sites dropped it:

- **Claude** — the raw stream-json `result` frame's own `result` field IS the closing
  assistant message. `finishTurn` read it only on the failure path (as error text).
- **Codex** — app-server has no result frame; the closing message exists only as the text
  blocks `item/agentMessage/delta` streamed, which the runner already holds in
  `run.inflight`. (The CLI's *own* `notify` hook payload carries
  `last-assistant-message` — proof the engine considers this the notification-worthy
  field — but Termdeck drives app-server, not the notify hook.)
- **Grok** — `turn_completed` is `{stop_reason, agent_result, usage}` and the runner read
  `usage` alone, discarding both the summary and the turn's own verdict. `stop_reason` is
  now also the fallback for a `session/prompt` response that omits `stopReason`, which
  otherwise reports an ordinary finished turn to the user as a failure.

Rules, each guarding a real failure mode:

- **One extractor, three shapes** (`lastMessageText` in `lib/result-fields.js`). Claude
  hands over a string, Codex/Grok a streamed block, Grok's `agent_result` an object or a
  content array. Anything unparseable must read as *no message* — never `[object Object]`
  on somebody's phone. It drops fenced code whole, skips headings and rules (taking the
  first paragraph verbatim produced bodies that read "Summary"), and hard-caps at
  `LAST_MESSAGE_MAX`.
- **Only a successful frame has prose in it.** On a Claude error subtype the same `result`
  field is the failure text, which `finishTurn` already reports as `error` — quoting it
  would print one failure twice under two labels. Hence `lastMessage` is null unless
  `status === 'ok'`.
- **An unclean ending is never dressed up as "Finished."** A limit, a refusal or a pile of
  denied calls gets a lead (`okLead` in `lib/push-copy.js`) — the model itself often does
  not know it was cut off, so its closing words cannot be trusted to say so.
- **`bodyShort` is the same notification minus the agent's prose.** A transcript line on a
  lock screen is a per-*device* choice, so `notifyUser` picks the body per subscription row
  rather than once for the fan-out; the `summary` pref rides the existing per-device events
  blob (it is NOT an event and is never matched against one). The failure text is exempt —
  it is Termdeck's own words, and a silent "something failed" is worse than useless.
- **The toast and the push must read alike.** `copyFor()` in `public/js/notifier.js` is a
  hand-maintained twin of `lib/push-copy.js`, and it had already drifted: a risky approval
  toasted "High risk: rm -rf build" while the push for the same call said "High risk: Bash
  — rm -rf build". `tests/push-copy.mjs` runs both over the same payloads, which is the
  only thing that keeps them together.

## Live rate limits fold in the BROWSER, not on the server (`public/js/limits-live.js`)

`rate_limit_event` is the engine stating the account's quota outright, mid-turn — versus
`agent/limits.js`, which infers the same windows by polling a profile endpoint every 60s.
Both describe the same meter, so the pushed event is *folded into* the polled snapshot
rather than replacing it: one event describes ONE window, and the other windows' polled
readings stay perfectly good.

**The fold is client-side on purpose,** against what SDK-SIGNALS §2 sketched. On the cloud
path anything the master caches is the **operator's** Anthropic account, not the
customer's — folding a customer's pushed event there would corrupt the operator's own
meter with a stranger's numbers. The per-user snapshot only exists in the browser
(`lastData` in `limits.js`, assembled per-request by `master.js`'s `/api/limits` from that
user's machines), so that is the only place the fold is correct on **both** products. It
also avoids a third copy of a normaliser that is already a hand-maintained fork
(`agent/limits.js` is the machine's own reading). Servers forward, they never fold.

Four rules, each a silent-wrong-number failure — worse than no meter at all:

- **Never resurrect a stale window.** An event whose `resetsAt` is EARLIER than the one
  held describes a window that has since rolled over; arriving late (slow tunnel, queued
  frame) it would drag a fresh 2% back to the 100% the previous window ended on.
- **Monotonic within a window, free across the boundary.** Same `resetsAt` ⇒ usage only
  climbs. A LATER `resetsAt` is a new window and may legitimately read lower, or a genuine
  reset never shows. A held window whose reset has already passed is superseded outright.
- **`utilization` is 0-100 and used verbatim.** Never rescale a small value as if it were a
  fraction — that is KNOWN-BUGS #11, which painted the real sub-1% readings you get just
  after a reset as a full red bar. See `tests/limits-percent.mjs`.
- **`resetsAt` must come out as an ISO string.** The SDK gives a number (unit unstated —
  both epoch seconds and ms are accepted); the panel reads every reset with
  `Date.parse(lim.resetsAt)`, so a raw number renders nothing at all.

The frame is **account-scoped**, and `main.js` routes it deliberately *past* the
`isCurrent` gate the rest of `onMessage` uses: a limit hit in one chat is the same
account's limit in all of them. It still carries `sessionId` (every frame does), that just
isn't what decides whether it applies. Both hubs forward it with `forwardWithWatchers`, so
a browsing hub's control socket learns its agent hit a wall with no browser subscribed.
`foldRateLimit` returns the SAME reference when nothing applied, so a no-op costs no
re-render. Reuse the existing hold (`limits-reset-hold.js`) if a hold is ever needed here;
do not add a second one. Covered by `tests/limits-live.mjs`.

## Sub-agent telemetry is a PATCH stream (`lib/task-registry.js`)

The four `system/task_*` events (SDK-SIGNALS §3) are patches, not snapshots:
`task_progress` omits everything it isn't changing, `task_updated` carries a literal
`patch` object, and the strip needs the accumulated row. So they are folded ONCE
server-side — in `lib/cloud/machine-host.js`, through the same
`TaskRegistry` — rather than forwarded raw for the browser to reassemble twice.

Folding server-side is also what makes the state recoverable: the registry rides the
`subscribed` snapshot (`run.tasks`), and since this is ephemeral aliveness that is never
written to disk, **nothing else could rebuild it after a reload**.

Three rules, each a real failure mode:

- **Any event creates the row it names.** Order is not guaranteed — a `task_progress` can
  outrun the `task_started` that introduces its task — and duplicates are normal. A late
  `task_started` enriches the existing row instead of blanking what progress already said.
- **A terminal status is sticky.** Once completed/failed/killed/stopped, a late
  `task_progress` may still correct the usage but must never restore `running`. A finished
  agent that flips back to running is a bug the user cannot dismiss, because nothing will
  finish it a second time. The one permitted move out of a terminal status is into another
  terminal one (a late error reclassifying a completion). Usage is likewise monotonic: an
  out-of-order frame describes an earlier moment, not a task that un-spent its tokens.
- **Bounded, finished-first.** The registry rides a snapshot, so it is capped; eviction
  drops completed rows before live ones, and a live agent is never the one dropped.

`tool_progress` is separate and is a **live clock**: the engine pushes it repeatedly for
the same call, so it is throttled per `tool_use_id` **before fan-out** — a long `Bash`
would otherwise flood every subscribed socket for a number that only needs to be right to
the second. The first frame for a call always passes, so the clock appears at once.
Neither frame overloads `tool-activity`, whose consumers assume start/running/end phases.
Both are forwarded to subscribed clients only (`forward`, not `forwardWithWatchers`): an
elapsed clock is worth nothing to a control socket with no browser reading it. `main.js`
keeps the existing split — a frame carrying `parentToolUseId` belongs to a sub-agent's
strip, never the main ticker. The clock renders only past 5s: the fold already says which
tool is live, so a number on every call is noise while one at 5s is information. Covered by
`tests/task-registry.mjs`.

## A tool summary must name the calls it covers (`lib/tool-summaries.js`)

`tool_use_summary` (SDK-SIGNALS §A) is the engine's own sentence about a stretch of tool
calls — "Traced the double-render back to the parse cache" where the activity fold could
previously only count ("Ran 5 commands, read 3 files"), because a count is all
`transcript-view.js` can derive from the blocks it mounted.

**The `preceding_tool_use_ids` are what make it usable, so a summary carrying none is
dropped at the registry** — hub, cloud and the `subscribed` snapshot then inherit one rule
instead of three. Without an anchor the only way to place it is to guess which fold is
"current", and the guess is wrong exactly when it matters: a summary landing after its own
fold closed would label the *next* run. For the same reason the browser matches by id
(`activity.toolIds`, populated as blocks mount) and repaints **every** mounted fold, not
just the open one — a summary can arrive after prose has already delimited the run it
describes.

**A live tool outranks it.** The summary describes work that has FINISHED; letting it take
the label mid-run would replace the one thing on screen saying the turn is still moving.
The counted label stays as the fallback underneath both — a summary may never arrive.

It is **ephemeral, and stays that way**. Swept the 87 project transcripts on this box:
zero `tool_use_summary` records, against 7 on-disk `model_refusal_fallback` ones — so
nothing can rebuild it from the jsonl, and it rides `run.summaries` on the `subscribed`
snapshot exactly like `run.tasks`. It follows that summaries **die with the turn**: once
the run is gone the fold goes back to counting. That is the correct ending, not a gap —
a label outliving the snapshot would be a cache of something that was never on disk, which
is the one thing these signals may not become. Both runners fold through the same registry
so the frame is byte-identical on either transport; `remote-runner.js` passes the whole
frame as `ev.message` (not `ev.summary` — the frame has a `summary` field of its own, and
naming the envelope after one of its fields is how a caller ends up passing the string).
Covered by `tests/tool-summaries.mjs`, `tests/tool-summary-wiring.mjs` and
`tests/activity-fold.spec.js`.

## A retry is transient; a refusal is on disk (`lib/engine-notice.js`)

SDK-SIGNALS §B grouped `api_retry` with the two `model_refusal_*` frames as one ephemeral
notice. **They have different lifetimes, so they got different homes**, and conflating them
again would break one of the two.

`api_retry` answers the question the UI genuinely could not — *is it stuck, or working?* A
stalled turn used to look identical to a wedged one; the stale-run watchdog
(`public/js/run-watchdog.js`) exists precisely because nothing said why nothing was
happening. It is **not on disk** and is worth nothing once it succeeds, so it rides an
`engine-notice` frame into the fold's label, above even the live tool: while the engine is
retrying, "Editing lib/transcript.js" describes a call that is *not* progressing, which is the
misreading this frame exists to correct.

**It must be cleared by the next sign of progress** — a tool starting or ending, a token
arriving, the turn settling. This is what makes it safe to show at all: it is a claim about
*right now*, and nothing else will ever come along to contradict it. A "retrying…" that
outlives its retry becomes the stuck-looking state it was added to explain. Both runners
normalise through the one `noticeFromRetry` so the two transports cannot drift.

The refusals are **written to disk** — 7 records across this box's transcripts, `type:
"system"` with camelCase fields — so they are parsed in `lib/transcript.js` as
`role: 'refusal'` and rendered as a durable row. That is strictly better than a notice:
it survives a reload, shows for chats made in the terminal, and reaches the cloud path for
free because the transcript already travels there. It also dissolves the plan's biggest
gotcha. `retractedMessageUuids` was expected to name messages the transcript still
contained; measured across **all 8** retracted uuids on this box, not one survives as a
record — the CLI never persists a retracted message, so a disk-rendered refusal has nothing
to evict. Retraction remains a live-stream concern only. The parser reads both camelCase
(disk) and snake_case (stream) spellings, since neither is contractual. Covered by
`tests/engine-notice.mjs` and `tests/activity-fold.spec.js`.

## A periodic feed needs a THROTTLE, not a debounce (`public/js/util.js`)

The sidebar refetched the entire session list **twice a second for the whole length of every
turn** — measured at **398 KB across 1,089 chats** on one real box — while looking, in code
and in its own comment, like it was rate-limited.

**`debounce` resets its timer on every call, so it only coalesces calls arriving FASTER than
its window.** What feeds `sidebar.refresh` is not bursty, it is PERIODIC: `markDirty()` in
`lib/cloud/machine-host.js` is a leading-guard throttle on a fixed `DIRTY_DEBOUNCE_MS = 500`, so
`sessions-updated` arrives on a metronome. A 300ms debounce against a 500ms period coalesces
**exactly nothing** — every poke gets its own fetch, 300ms late. Two rate limiters, composing
to none.

Nothing about this is visible from either side alone, which is why it survived: the server
looks throttled, the client looks debounced, and the comment on the client said pokes arrived
"many times a second" (they cannot — the server caps them at two).

`throttle()` is leading + trailing: it fires immediately, then at most once per window, and
the last call in a window always runs. All three parts are load-bearing. The **leading** edge
is why this is also better UX than what it replaced — most callers of `sidebar.refresh()` are
user actions (deleting a machine, a host reconnecting), and the old debounce delayed every one
of them by its full window. The **trailing** call is what keeps the settled state from being
dropped once writes stop, so the result is coarser, never stale. And a trailing call must open
its OWN window, or a steady stream leads again immediately and runs at double the intended
rate.

The payload is O(all chats) while the change is O(1 chat), so the deeper fix is a delta or a
version stamp on `/api/sessions` — the server already knows which session moved, it just says
"something changed". Compression is NOT the lever: Cloudflare already serves the cloud path
zstd-encoded, and on the hub this is loopback, where the cost is `JSON.parse` plus a re-render
at 2 Hz rather than bytes. Covered by `tests/throttle.mjs`, which drives both shapes at the
real 500ms period and fails if anyone swaps it back.

## A fork is a duplicate that stops (SDK-SIGNALS §F)

Termdeck could already DETECT forks — the terminal makes them, and `chainParents`/
`firstUserUuid` collapsing in `watcher.js` handles them — but it could not make one. It
turned out to need almost no new machinery: the existing **duplicate** already clones a
transcript under a fresh id, so a fork is that plus `upTo`, a uuid to stop at.

**§F's own listed gotcha was already solved, and staying solved is the point.** The
fork-family collapse (`forkWinner`, keyed on the first message's uuid) HIDES sibling forks in
the sidebar, so a clone that kept the source's uuid chain is a sibling and exactly one of the
two vanishes — with *which one* decided by timestamps, so a fork the user deliberately made
can disappear the moment they touch either chat. `rewriteDuplicateTranscript` already
rebuilds the whole uuid/parentUuid/leafUuid chain for that reason; `tests/session-fork.mjs`
proves a TRUNCATED clone keeps it, against the real `forkWinner`.

**An unknown fork point throws.** Cloning the whole conversation when the uuid is not found
would be a "branch from here" that branched from the end — a wrong copy the user would only
catch by reading it. Measured before wiring the button: across 201 transcripts on this box,
**2,250 of 2,251** checkpoint `messageId`s resolve to a record uuid in the same file, so the
error path is the 0.04% case and not the normal one.

**The button lives on the checkpoint line, beside Restore**, because they are the two halves
of one undo — restore puts the FILES back, branching puts the CONVERSATION back — and a
checkpoint is exactly the point you would want to take a different path from. Unlike Restore
there is no confirm dialog: forking only ever WRITES a new transcript, so there is no data
loss to gate, and it navigates to the branch rather than toasting (carrying on from there is
the whole point). The rewriter lives on the AGENT — it reads and rewrites the transcript on
the machine's own disk — so `tests/session-fork.mjs` drives that copy directly. It reuses the
`duplicate` route and the `mutate` duplicate op with one more field rather than inventing
either.

## One restore point per PROMPT (`lib/transcript.js` + `lib/checkpoints.js`)

The engine writes a checkpoint record every time it backs a file up, and the viewer rendered
each one where it landed. Measured across this box's 422 transcripts: **3,520 rows for 1,801
real restore points** — a "checkpoint · 1 file · Restore files" line after every edit, most of
them pointing at the very same restore point, all of them mid-turn while the files were still
moving. A restore control after every change is not granularity, it is a decision nobody
wants to make; the turn is the only unit the reader thinks in.

**The prompt is the anchor.** A row is parked directly ABOVE the prompt whose turn produced
it, and the position is what says what the button does — restoring puts the files back to how
they were before that prompt ran. It also has to be built that way, because two record shapes
scatter checkpoints differently and both must land on the same row:

- **SDK (current CLI)** — an EMPTY `file-history-snapshot` at turn start, then one
  `file-history-delta` per file. All carry the same id, and that id is the uuid of the user
  record that opened the turn. The empty snapshot is therefore KEPT by the parser (it is the
  only record that knows the moment being restored to); the scanner's fold drops a checkpoint
  that never gained a file, since by then it knows.
- **interactive TUI** — a fresh checkpoint per EDIT, keyed on the assistant record that made
  it. These name no prompt at all, so they fold onto the turn that was open when they were
  written — a decision only safe at `finish()`, once no later line can still turn the id into
  a prompt of its own.

**A row therefore carries a LIST of ids, and restore reads all of them.** `resolveCheckpoint`
takes the earliest backup of each file across the turn: restoring only the first id would
silently leave any file first touched later in the turn edited, under a button that claims the
prompt was rolled back. Each id is resolved on its own first — an id's snapshot updates
supersede that id's earlier snapshot, but across ids a snapshot is a separate checkpoint, and
merging them into one bucket let the turn-opening EMPTY snapshot swallow every populated one
after it (a real 7-checkpoint turn resolved 0 files instead of 6). A single id resolves
exactly as it always did.

**On cloud, restore is the one capability that writes OUTSIDE the transcript roots**, because
the files it rolls back are the customer's own checkout — so the boundary is drawn on
different terms and has to hold on its own. The master names a TRANSCRIPT (confined like every
other path it may name), a session id and a list of checkpoint ids, and *nothing else*: which
files exist, where they live and what bytes go into them are all read on the agent's box, from
its own records and its own `~/.claude/file-history` blobs. There is no path and no content in
the request, so the worst a compromised master can do with it is roll a real checkpoint of a
real session back, which is the feature. `cwd` is deliberately not accepted from the wire
either — `resolveCheckpoint` reads it out of the transcript, and a delta's `realParentDir`
beats even that. Needs agent ≥ 0.0.47, gated on the reported version rather than discovered by
timeout: an older agent has no case for the frame, so the request would sit for a minute
before failing, and nobody waits that long to be told their machine is behind. A live turn is
refused (409) for the same reason delete is — the engine is editing those files right now.
`scripts/relay-restore-check.js` drives all of it over a real reverse-WS, including the
refusals.

**Anchoring also has to survive the preview window.** `previewWindow` starts at a prompt so a
chat never opens on a wall of tool output; the row is one above that prompt, so the window
takes it too, or the newest turn looks like it never made a restore point. 1,781 of 1,801 real
restore points get a row; the remainder open with a record the viewer does not render, and a
row with nowhere honest to sit is dropped rather than parked. Covered by
`tests/checkpoint-fold.mjs` (both shapes, both arrival orders, every `?since` split) and
`tests/checkpoints-delta.mjs` (the turn-wide restore).

## A rename is another LINE, and the override stays (`lib/session-title.js`)

Termdeck's renames were local: `lib/overrides.js` in `~/.termdeck/overrides.json`, so a chat
renamed in the web UI still showed its old generated title in `claude --resume`. Termdeck was
already READING the CLI's own mechanism — `lib/claude-data.js` and `lib/cloud/remote-sessions.js`
both scan the transcript tail for a `custom-title` record — it simply never wrote one
(SDK-SIGNALS §E).

**Append-only, never a rewrite.** The transcript is the source of truth for the whole app.
Rewriting it to "update" a title would race the watcher's incremental parse, the `size+mtime`
parse cache, and any live CLI holding the same file. Readers already take the LAST such
record, so a rename is one more line and clearing a tag writes an EMPTY tag rather than
deleting anything.

**The override is NOT cleared on success** — the safe half of the plan's gotcha. It is what
keeps a rename visible for Codex and Grok, which have no such record, and what keeps the
whole thing reversible; `lib/claude-data.js` resolves the override first, so the two agreeing
is the normal state and neither can silently vanish. The write-through runs AFTER the
response and never fails the request: the override is what the UI renders, and a rename must
not appear to fail because a transcript was unwritable.

**One module, shipped to the agent.** The SDK exports `renameSession`/`tagSession` and both do
exactly this append, but the thin agent has no SDK — only `ws` and `chokidar` — and a second
implementation there is how the two paths write different bytes. `lib/session-title.js` goes
in BOTH `AGENT_FILES` manifests (a file missing from either is an agent that crash-loops on
require after a self-update), which is why `agent/package.json` is bumped. The agent op is
narrow and typed like `limits` and `models`: the master names the **session and the string**,
never the record, so it cannot append arbitrary JSON to a customer's transcript, and the
session id is validated as a uuid on both sides because the agent turns it into a file path.
It rides the existing `mutate` reply type rather than inventing one — an unlisted `t` in
`lib/cloud/transport.js`'s `onFrame` is dropped and the request times out.

**`tagSession` is plumbed but has no caller yet.** The write works end to end on both paths
and its record shape is pinned by the tests; nothing reads `tag` records back, because
grouping the sidebar by tag is a new information architecture rather than a signal read, and
that decision is not made. Covered by `tests/session-title.mjs`.

## A recalled memory may be its own only copy (`lib/memory-recall.js`)

§1's context panel says what memory files COST. `system/memory_recall` (SDK-SIGNALS §G) says
which were actually surfaced, which is the question people have about memory — was the thing
I wrote down used? The panel marks those rows `used`, so loaded-and-used stops looking like
loaded-and-idle.

**The plan's gotcha is half wrong, and following it literally loses data.** It says content
can be large, so carry paths and scopes and fetch content on demand. True for file-backed
`select` entries — where the frame omits `content` anyway, and the file is authoritative and
always current. **False for two kinds that have no file behind them at all:** `mode:
'synthesize'`, whose `path` is a sentinel of the form `<synthesis:DIR>`, and `scope:
'organization'`, whose path is an https URL. The SDK guarantees `content` is present for both
*precisely because* there is nothing to lazy-load from. Dropping it leaves a row that can
never be filled — and the bug reads as an empty tooltip, not as a lost field. So content is
carried exactly when it is the only copy, capped, and flagged when cut.

An empty recall is a real answer ("memory ran and matched nothing") and renders; a frame with
no `memories` array at all is malformed and is dropped. Ephemeral — zero `memory_recall` and
zero `files_persisted` records across the 1,363 transcripts on this box — so it rides
`getSnapshot` and dies with the turn, like `tool_use_summary` before it.

**`files_persisted` is plumbed for its `failed[]`.** The successes only sharpen something the
changes panel already approximated (it refetched on transcript movement, a proxy for "something
changed"; this is the event). A file that did NOT persist is invisible today and the turn
carries on as though it had, so those become a sticky notification. `file_id` identifies
nothing the browser can act on and does not travel, and an event with neither successes nor
failures is dropped rather than refetching the diff panel for nothing. Covered by
`tests/memory-recall.mjs`.

## The thinking dial is STICKY, or it lasts one turn (SDK-SIGNALS §I)

The composer already had effort, which is chosen before a turn and takes effect on the next
one. `setMaxThinkingTokens(n, display)` is the finer control and the LIVE one — it is a
`Query` method, so it applies to the turn already running, and `thinkingDisplay: 'omitted'`
stops the engine producing thinking at all rather than merely hiding it after the fact.

**There is one `Query` per turn, so applying it only to the live one is a bug that looks like
a success.** The preference is kept per session and re-applied in each transport's `init`
branch; without that, "hide thinking" would take, and then silently come back on the next
message. It also has to survive `rekeyRun` — a chat whose id moved would otherwise start
showing thinking again with nothing to explain why — and it rides `getSnapshot`, because
nothing on disk records that thinking was hidden and a reload has no other source.

**`null` means default and CLEARS.** Three states, not two: "we have not asked" is real and
distinct from "summarized", and it matches the SDK signature where null is unset. On the wire
BOTH fields are sent every time — omitting `max_thinking_tokens` does not mean "leave it
alone", it means null, so a partial write would silently clear the other half.

**The browser paints from the server's echo, never optimistically.** This is a real engine
call an older CLI can refuse, and a toggle that shows the new state before it took is exactly
how a setting looks applied while doing nothing. Applying it is best-effort on both paths: a
display preference must not fail a customer's turn.

**No numeric budget control shipped alongside it.** Effort already IS the thinking budget —
the levels map onto one inside the engine — so a second numeric field would be two controls
fighting over one number with no defined precedence. `maxTokens` is carried through the whole
protocol so a real use can be wired without another trip through all four transports. Covered
by `tests/control-signals-wiring.mjs`.

## Stopping one sub-agent is not free, and the button says so (SDK-SIGNALS §H)

§3 shipped per-sub-agent spend and duration; the only control was still aborting the whole
turn, so watching one agent burn tokens on the wrong thing meant killing the other three
with it. `stopTask(taskId)` is the per-agent one.

**No stop control without a `taskId`.** That is the only handle the engine accepts, and it
comes from the `task_*` telemetry — a strip row built purely from transcript blocks (an
`Agent` tool_use with no telemetry yet) has none. Offering a button that could only fail is
worse than offering none.

**Stopping a FOREGROUND agent ends the turn it is blocked on**, so the label reads *"Stop
(ends this turn)"* rather than "Stop". Whether an agent is backgrounded is learned in exactly
one place: `run_in_background` returns an `Async agent launched successfully` ack as its
*immediate* tool_result, which `subagents.js` already recognises to avoid marking the agent
finished. That branch now also records `background: true` — it is the only signal available,
so it is load-bearing for the label.

**There is no success reply frame.** The engine answers by emitting `task_updated` with
`status: 'stopped'`, which `lib/task-registry.js` already folds and the strip already renders.
An ack would be a second source of truth for the same fact, and terminal status is sticky —
two writers for one transition is how a strip ends up disagreeing with itself. Only failure is
worth saying, and the session-scoped `error` frame says it. On cloud the ack is read from
`controlAck`, not from the payload, because `stop_task` succeeds **empty**. Covered by
`tests/control-signals-wiring.mjs`.

## The account chip must say WHICH claim it is making (`lib/account-info.js`)

Nothing on a chat ever said which login was driving it, and on the cloud that is the
customer's own Anthropic spend on the customer's own machine (SDK-SIGNALS §C).

**There are two sources, and the plan assumed only one.** `Query.accountInfo()` is what the
engine resolved for the turn *running right now* — but it has **no control_request subtype**.
The SDK reads it off the `initialize` handshake response, so the plan's "cloud reaches it by
control_request on the existing stdin writer" does not exist. The raw CLI *does* answer a bare
`control_request { subtype: 'initialize' }` (verified against 2.1.220, no API spend), but
issuing one mid-turn would re-run initialization for the **running** turn with an empty
payload — no hooks, no `systemPrompt`, no sdkMcpServers. Silently losing the system prompt on
a customer's turn is far worse than a slightly less precise label, so the cloud path uses the
second source instead: `claude auth status --json`, already wrapped by `lib/accounts.js`
(`listAccounts().active`) and already reachable through the agent's existing `accounts`
capability — the same CLI reading the same config, with **no agent change at all**.

Both normalise to one shape carrying `source`, and the chip puts it in the tooltip: *"resolved
by the running turn"* and *"from the CLI's own auth status"* are different claims, and the chip
must not quietly upgrade the second into the first.

**Nothing identifying is no answer.** A 3P provider (bedrock/vertex) authenticates externally
and carries no email and no org, so `fromEngine`/`fromCli` return null rather than an account
with a blank name — a blank chip reads as a broken lookup either way, and rendering one is
strictly worse than rendering none. `apiProvider` alone still counts: "running on bedrock" is
a fact worth showing.

**The answer is cached per HOST, never per session** — a login belongs to a machine, so the
frame is stamped with the host it describes and the browser drops it on a host switch. The
cache is single-flight (a fresh page open must not spawn the CLI once per chat) and stamps
`at` from the **same clock the TTL is measured against**; stamping from `Date.now()` while
comparing against an injected `now` makes every entry look infinitely fresh, which would name
a switched account by its old login until the process restarted. A failed lookup caches
nothing — "unknown" is safe to show, last week's login named as current is not — and
`switchAccount` invalidates, so the one action that is about changing the account doesn't wait
out a TTL. Asked on `subscribed` rather than folded INTO it: the answer can cost a CLI spawn,
and blocking a chat from opening on it trades what people notice for what they don't. Covered
by `tests/account-info.mjs`.

## The MCP panel may never invent a green light (`lib/mcp-status.js`)

The panel shipped in U8 read the CONFIG files and said so out loud — *"connection status
isn't reported by the CLI"*. It is (SDK-SIGNALS §D): `mcpServerStatus()` returns per-server
state, the failure reason, and the tools that actually loaded. Until this landed, a server
that was dead and a server that was fine rendered identically, which is the whole bug.

**`status: null` is not `connected`.** A configured server the engine has never mentioned
keeps a null status end to end, and the panel renders "not reported" in grey. Defaulting an
absent reading to healthy would recreate the original bug behind a pill that now *looks*
authoritative — strictly worse than the old honest silence. The same rule points the other
way: a server the engine loaded at runtime (`setMcpServers`) but that is in no config file
is **appended**, because showing fewer servers than the engine loaded is the same lie.

**`config` is dropped entirely, not redacted.** `McpServerStatus.config` is the server's raw
configuration including its URL, and a URL can carry userinfo. `lib/mcp-config.js` goes to
real trouble to redact exactly that before anything reaches a browser; passing the engine's
unredacted copy through a second field would undo it invisibly. The panel already has a
redacted `target`, so nothing is lost. Tool `description`s go for size, not secrecy.

**The coarse init reading is what makes the panel usable at all.** Like the context
breakdown this is a method on the SDK's `Query`, and there is no `Query` between turns — but
unlike the context breakdown, *nobody opens this panel mid-turn*. They open it because a tool
didn't work. So every turn's `system/init` frame, which already carries
`mcp_servers: [{ name, status }]` for free on both transports, is recorded as a coarse
reading: a session that has run even once can answer *is this server dead?*, even when it
cannot answer why. Rich beats coarse **only where they agree** — a cached "failed:
ECONNREFUSED" stays while init keeps saying failed, and is dropped the moment init says
anything else, because a stale reason is worse than no reason.

**The controls need a live turn and say so.** `reconnectMcpServer`/`toggleMcpServer` have no
honest fallback: with no `Query` there is no engine to reconnect anything *in*. The buttons
disable themselves with the reason in the tooltip rather than failing on click.
`setMcpServers()` is deliberately not wired to anything — it REPLACES the whole dynamic set,
so hanging it off a per-row control would silently delete every other runtime-registered
server. Actions never paint a status from their own ack; the engine reconnects
asynchronously, so the browser re-reads. On the cloud path the ack is carried separately
from the payload (`controlRaw` in `remote-runner.js`) because these succeed **empty** —
collapsing both into "resolved with null" would make a CLI too old to know the subtype
indistinguishable from one that carried the request out. Read state rides the existing
`/api/mcp-servers` response rather than a new frame; only the write is a WS message.
Covered by `tests/mcp-status.mjs`.

## The spend ceiling is enforced by the ENGINE (`lib/budget.js`)

`--max-budget-usd` (SDK `maxBudgetUsd`; the flag was **verified** on `claude --help` and in
the SDK bundle, not assumed — `enableFileCheckpointing` turned out to have no flag at all
and to be an env var instead) makes the turn stop *itself*, ending with
`subtype: 'error_max_budget_usd'`.

This is the one limit Termdeck does not check *around* the runner, because spend cannot be:
by the time a between-operations check sees $12, $12 is already spent. Enforcing at the
source is the only way a ceiling is actually a ceiling — the failure mode of every
after-the-fact reconciliation.

**It is not a plan gate,** against what SDK-SIGNALS §6 sketched. On the cloud path the turn
runs on the CUSTOMER's machine under the CUSTOMER's own Anthropic subscription; Termdeck
never pays for those tokens. Deriving the ceiling from their Termdeck tier would ration
quota we do not sell them, and would cut a Free user off mid-turn on credits they bought
from Anthropic. So it is a **safety rail the user sets for themselves** (Settings → Chats →
Safety, `maxBudgetUsd`, off by default) plus `TERMDECK_MAX_BUDGET_USD` as an operator
ceiling for a shared hub. `lib/cloud/billing.js`'s plan table is deliberately not consulted.

Resolution rules, all in one pure `resolveBudget()` both runners call:

- **Off stays off.** Absent, `0`, negative and junk all mean unlimited — never "stop
  immediately". Unlimited is the historical behaviour and the default: a ceiling nobody
  asked for that silently ended a long turn is far worse than no ceiling.
- **The operator's ceiling is a ceiling, not a default.** It clamps a larger request and
  applies when the browser sends nothing, but never raises a stricter per-turn setting.
  Because it resolves server-side, a tampered frame can only ever end up *stricter*.
- **Clamped to [`MIN_USD`, `MAX_USD`] and quantised to cents,** so a fat-fingered `0.001`
  clamps up to the floor rather than killing every turn the instant it starts.
- **Resolved ONCE, onto the run,** so the number that ends the turn is the number the
  message quotes.

A turn stopped at the line must say so: the partial turn on disk is fine (disk is truth,
the session stays resumable) but the transcript simply *ends*, which reads as a crash.
`budgetStopMessage()` is wired into `errMessage()` on the hub and `finishTurn`'s
`resultError` on the cloud, ahead of the generic error path, and deliberately contains no
"error"/"failed" wording — the engine did exactly what it was told. Covered by
`tests/budget.mjs`.

## The context breakdown is live-turn-only, and says so (`lib/context-usage.js`)

The context strip has always been one number scanned off disk — "83% full" — which says a
window is filling but never WHAT is filling it. `getContextUsage()` answers that:
categories, which `CLAUDE.md` costs what, which MCP server is eating the window, plus
`autoCompactThreshold`, the number that predicts *when* the chat will compact.

**It only works mid-turn, and that is not engineerable around.** The call is a method on
the SDK's `Query`, and there is no `Query` between turns — one `query({resume})` per user
turn, disposed when the turn ends. So both runners return `{ data, at, live }` and cache
the last answer per session (`lastContextUsage`, mirroring `lastResult`). The panel renders
`live` or `as of <when>`; **a cached reading is never presented as current.** A panel whose
entire job is to be trusted about occupancy must not quietly show a stale number, and an
empty box whenever you actually want to look is nearly as bad — hence cache *and* label.
No answer at all is a sentence, never silence.

**Fetched on demand, never pushed.** The response carries every MCP tool, every memory file
and every skill; pushing it per turn would spend real bytes — on cloud, the customer's own
uplink — on a panel nobody has opened. `main.js` asks only when the `.ctx-fold` opens.

**The cloud path writes its first `control_request`.** `remote-runner.js` has always *read*
`control_request` frames (`can_use_tool`) and answered them; this is the first one it
*issues*, so it keeps a `pendingControl` map keyed by `request_id` — the CLI answers out of
order, and a second request must not steal the first one's answer. Every pending entry is
settled to `null` on a timeout (an older CLI without the subtype never answers at all) and
when the turn finishes, or a panel promise hangs forever. It needed **no new agent reply
type**: it rides the CLI's existing stdin/stdout on the already-spawned process, so
`lib/cloud/transport.js`'s `onFrame` switch and `agent/` are untouched.

Normalising is mostly about **size**, and both ways of getting it wrong are silent:
`gridRows` is dropped *entirely* (the CLI's TUI square grid — hundreds of cells of pure
presentation for a different UI, and the largest field in the payload), and every list is
sorted by cost **before** capping. Truncating an unsorted list keeps whichever entries came
first, which for "what is eating my window" is exactly backwards and looks entirely
plausible on screen. Each capped list reports its own tail (`more`/`moreTokens`) so the
panel can say "+18 more" instead of implying it showed everything. Covered by
`tests/context-usage.mjs` and `scripts/context-usage-check.js`.

## Raw-CLI facts (spike-verified — header of `lib/cloud/remote-runner.js` documents all of them)

The cloud path drives the `claude` CLI directly in `--input-format stream-json`; the
Claude Agent SDK is NOT a dependency any more (it went with the self-hosted hub on
2026-08-01) and must not be reintroduced. What the spikes established:

Resume does NOT fork (same sessionId, same jsonl). A turn's stdin must stay open for the
whole turn — closing it on the first `result` means a turn woken back up by a background
Agent task can't send a permission request any more, and every tool after it dies with
"Tool permission request failed: AbortError: Stream closed". Steering is another `user`
frame on that same stdin, always `priority:'now'` (see the stdin invariant above).
`system/init` carries the session_id; `can_use_tool` arrives as a `control_request` that
BLOCKS until answered; `interrupt` and `set_permission_mode` are control requests on the
same channel, correlated back by `request_id`. `scripts/spike-streamjson.mjs` and
`scripts/spike-rawcli-steer.mjs` reproduce these against the live CLI (real API spend).

## Account switching (`lib/accounts.js` = Claude, `lib/codex-accounts.js` = ChatGPT/Codex)

One shared surface — same routes, same preflight/probe/rollback contract, same settings
card, `orgId` carrying whichever id that engine uses — so the UI is literally one
implementation. Two Codex-only rules are load-bearing.

**The app-server must be recycled on every switch:** `codex-runner` keeps ONE long-lived
child that read `auth.json` at spawn and holds the tokens in memory, so writing a new
`auth.json` under it changes nothing and the switch reports success while every turn keeps
running on the old account. The hub kills its own child via the `reloadCodex` hook; on the
cloud path that child belongs to the MASTER (RemoteCodexRunner spawned it through the
agent's `spawn` capability), so `machine-host.js` recycles it there — on switch AND once
after a completed login — and passes the in-flight turn count in, because the agent process
cannot see turns it did not start. Since the switch kills the child, in-flight turns *end*;
preflight says so rather than calling it a risk.

**A spent refresh token is radioactive:** OpenAI does refresh-token reuse detection, so
replaying a token that has already been exchanged invalidates the whole family including
the newest one — measured by killing a real login, after which `codex exec` returns
"refresh token was revoked". Every successful `probeCredentials` result MUST be persisted
before anything else, and `refresh_token_invalidated` counts as dead alongside
`invalid_grant`/`token_expired`. Identity comes from decoding the `id_token` claims, not
the CLI (`codex login status` prints only "Logged in using ChatGPT"), and adding an account
uses `codex login --device-auth` because plain `codex login` only completes in a browser on
that same box (localhost:1455 callback).

## One folder is one project (`normalizeCwd` in `lib/claude-data.js` + `public/js/worktree-fold.js`)

A project slug is a raw character substitution over whatever cwd string reached the engine
(`[^A-Za-z0-9] -> '-'`), so `/home/u/Work/Ai/` and `/home/u/Work/Ai` are two different
project dirs for one folder. Production had exactly that: `ai:-home-xdope-work-ai-` sitting
next to `ai:-home-xdope-work-ai` in the overrides table, the same folder listed twice in
Settings, each half with its own name, its own chats and its own Remove button. A trailing
separator gets in wherever a path is handed to us rather than read back from a process —
the folder picker, a typed cwd, a pasted path.

Two halves, and both are needed:

* **Normalise before slugging.** `normalizeCwd` trims whitespace, collapses doubled
  separators (keeping a UNC `\\server\share` prefix) and drops trailing separators, except
  on a root that is all separator (`/`, `C:\`). `slugForCwd` runs it first on BOTH sides —
  the client copy in `worktree-fold.js` must stay byte-identical to the server's, which
  `tests/folder-picker.mjs` pins. This is safe against real dir names because the CLI slugs
  `process.cwd()`, which is already normalised; it only ever changes an untidy input.
  Applied where a path enters: `machine-host`'s head parse (so a codex/grok `cwd` cannot
  mint its own group), `cwdCheck`, `startNew`, and `addCustomProject`.
* **Fold what is already on disk.** The stray dir cannot be renamed, so
  `foldSamePathProjects` merges any two projects on one machine whose `displayPath`
  normalises to the same string. ONLY real paths merge — a group whose cwd was never
  resolved falls back to its slug as `displayPath`, and two lossy slugs that look alike are
  not evidence of one folder. Each SESSION keeps its own slug (that is where its transcript
  actually lives, and what every `/api/hosts/:host/...` route is addressed by); only the
  grouping moves. The survivor is chosen deterministically all the way down (added ->
  canonical slug -> most chats -> lowest slug): the payload is ordered by RECENCY, so an
  order-dependent tie hands the row a different slug as chats move, and the name the user
  typed lives under a slug. The case that forced this is Claude Code's SSH sessions — every
  connection to the same remote folder gets its own `ssh-<uuid>` project dir, so no
  candidate is canonical and the tiebreak is all there is (production had two of them for
  one repo). The row the user NAMED wins the merge — dropping it would take the
  project out of their sidebar — so `mergeCustomProjects` passes `isAdded` in, and Remove
  clears the merged siblings' overrides too or the folder simply comes back.

## A model failure must name the machine and the fix (`agent/capabilities.js` + `/api/models`)

There is deliberately no hardcoded catalog, so "Failed to fetch models" was the whole error
the browser had — for a signed-out box, an expired token, a proxy install and a sleeping
laptop alike. Three real causes were invisible behind it:

* A subscription access token is only refreshed when the CLI itself runs, so a machine that
  had not started a chat since it lapsed read as *no credential at all*. The agent now
  nudges `claude auth status --json` once (single-flight, ≤60s apart, 8s cap) and re-reads
  `.credentials.json` — the CLI owns the refresh. We never POST the refresh token
  ourselves: a rotated refresh token replayed by two writers is how a login gets revoked
  outright (the lesson `lib/codex-accounts.js` is built around).
* An agent installed as a service does not inherit the shell that exported
  `ANTHROPIC_API_KEY`, but Claude Code reads its own `env` block from `settings.json` —
  which we now read too, `ANTHROPIC_BASE_URL` included, so a gateway install is asked at
  its own endpoint instead of 401ing against `api.anthropic.com`.
* Nothing said WHICH machine failed. The agent's failure carries a plain-language `reason`,
  `lib/cloud/transport.js` preserves it (an unlisted field is dropped), and `/api/models`
  502s with `detail` + per-machine `machines[]`. `modelsErrorFor()` in `engines.js` is where
  all three pickers read it.

The direct question — is each CLI installed, and is its login working? — is
`GET /api/hosts/:host/cli-status` (agent `cliStatus`, read-only: a `--version` probe plus
whatever each engine already wrote to disk about its own login; no turn, no refresh, no
switch), rendered as the first card in Settings → Accounts. `loggedIn: null` means "could
not tell" and must never paint as signed out.

## A machine NAME is an identity (`lib/cloud/overrides.js` rekeyHost + `public/js/host-rekey.js`)

Every stored setting is keyed by the machine's name: `"<machine>/<slug>/<sessionId>"` for a
chat (custom title, pin, archive, the Termdeck-started marker) and `"<machine>:<slug>"` for
a project (`public/js/projects.js`'s `projectKey`). The name is also the `:host` segment of
every route and the `#/<host>/...` deep link. So changing it is an identity change, and it
has exactly two shapes:

* **Rename** — the settings move with the machine, ALL of them, inside `updateMachine`'s
  transaction. The rewrite that shipped matched `"<name>/"` only, so chat titles and pins
  followed a rename and the added-projects list did not: renaming a machine emptied its
  sidebar of folders, with the chats still there. `rekeyHost` walks BOTH separators. A
  collision (leftovers already sitting under the destination name) resolves in favour of the
  live machine being renamed — it is carrying its own settings.
* **Delete, then reconnect the box under a different name** — a new row with a new id, and
  every stored key still names the old one. Nothing could move them and nothing said so, so
  it read as "my settings are gone" (this is what happened to a customer on 2026-08-02: the
  machine came back as `vps`, its whole `pc:` project list stranded). `GET
  /cloud/api/machines/orphans` reports every name nothing answers to, counted per kind;
  `POST /cloud/api/machines/:id/adopt {from}` moves them; `DELETE
  /cloud/api/machines/orphans/:name` throws them away. Adoption is a RECOVERY, so the
  destination machine's own rows win a collision and the skipped count is reported, never
  hidden — the opposite of the rename rule, for the opposite reason. Adopting from a name
  that still belongs to a live machine is refused (409): that would take settings off a box
  still using them.

The browser keeps its own name-keyed hints — draft, permission mode, effort, thinking dial,
pinned tab order — and `rekeyLocalHost` carries them on rename and on adopt. They live in
ONE module so the list is in one place; anything new keyed by session key belongs there too.
The cached session list is dropped rather than rewritten (a cache we edit is a cache that
can lie; the next fetch replaces it wholesale).

## A chat can change its FOLDER mid-turn (`MachineHost.relocateSubs` + `session-relocated`)

Claude Code's `EnterWorktree` switches a running session's cwd into a fresh git worktree,
and the CLI then renames the transcript out of `~/.claude/projects/<baseSlug>/` into
`~/.claude/projects/<baseSlug>--claude-worktrees-<name>/`. Same sessionId, new path, new
slug, mid-conversation. Verified on disk: a real relocated chat's file sits under the
worktree slug and contains the pre-worktree opening of the conversation, with nothing left
behind under the base slug.

Two independent things break, and both read to the user as "the UI doesn't know I'm in a
worktree until I reload":

* **The stream goes silent.** Everything about streaming a live chat is keyed by absolute
  PATH — `subs`, the byte cursor in `fileCache`, and the gate in `onFsEvent` that decides
  whether a write is worth parsing. The rename orphans all three, so canonical appends stop
  for the rest of the turn. The ephemeral stream bubble keeps painting (that is the runner's
  stdout, on its own path) but nothing settles it, so the transcript stops gaining rows.
  `relocateSubs` moves the refcount, the byte cursor and the id map onto the new path, and
  because a rename does not change the bytes the cursor stays valid — the next delta reads
  only what was appended instead of re-shipping the transcript over the tunnel.
* **The location never travels.** `currentCwd` was tracked only on a full parse, while
  `gitBranch` — one line below it in the same scanner — was tracked on deltas. So the branch
  chip could follow a chat into a worktree but the header path and the worktree panel could
  not, and both of those are read off the cwd (`effectiveWorktree` in `main.js` synthesizes
  the whole panel from it). `cwd` stays full-parse-only on purpose: it is the chat's HOME
  project and it is first-wins, so a delta's first record is not the FILE's first record.

The rebind rides the index REBUILD, not the raw fs event: chokidar reports a rename as an
unlink and an add with no ordering and no link between them, so an event-driven rebind can
just as easily follow the unlink of the path it was replacing and walk the subscription
backwards. The freshly built index is the one place that knows where the session lives now.

But the rebuild has to be ASKED for, and forced. `refresh()` is a freshness check, and
freshness is the wrong question here — the event is positive evidence the index is stale in
the one way that matters. Two measured failures behind `rebindMovedSession`: with watches
degraded, `refresh()` takes its TTL branch and calls a 4-second-old index fresh, so the move
went unnoticed until something unrelated happened to rebuild (in the harness, with no
browser polling the session list, that was never); and `refresh()` returns a build ALREADY
IN FLIGHT, so a build that started before the rename finishes with the pre-rename rows and
one completed build is not proof the move was seen. Hence forced, and join-then-retry.

On the browser side a slug is half of every per-chat key it holds — the transcript cache
entry, the pin, the custom title, the draft, the permission mode, the effort and the
thinking dial — and `sidebar.js` and `tabstrip.js` both match the open chat on slug. So
`session-relocated` moves them together (`rekeySessionKey` for the localStorage hints,
`overrides.rekeySession` for the pin and title) or the chat and its own sidebar row become
two different chats. A partial move would be worse than none. The two cached paints are
deliberately kept, unlike a machine rename: every other row in them is still true.

REST reads never needed any of this — `readTranscript` resolves by sessionId through
`rowFor` and ignores the slug for path resolution, which is exactly why a manual reload
always repaired the chat and made this look cosmetic.

## A keepalive the browser can SEE (`PING_MS` in `lib/cloud/hub.js` + `public/js/ws.js`)

A WebSocket ping is a CONTROL frame. The browser answers it down in the protocol layer and
fires no event, so page JavaScript cannot observe it at all — there is no API for it.
`public/js/ws.js` meanwhile recycles any socket that has produced no `message` for 75s,
because a socket killed upstream sits in `readyState === OPEN` forever and silence is the
only tell it has (KNOWN-BUGS #28). The hub sent nothing but pings on an idle socket, so the
two together made an idle dashboard tear down its own connection every ~75 seconds, show
"Connection lost — reconnecting…", reconnect, and repeat — for as long as nobody touched
it. Every cycle also re-ran the whole `onUp` path (resubscribe, resync, approvals inbox,
sidebar refresh).

Measured on prod before the fix: 200 seconds idle on `wss://termdeck.io/ws` produced seven
pings and ZERO data frames — and Cloudflare had not dropped a thing, so the tunnel was
never the problem here. (The AGENT link had already learned this the other way round, for
Cloudflare's ~100s idle timer, which also ignores control frames — hence the `{t:'keepalive'}`
data frame in `lib/cloud/relay.js` and the agent's own 25s `heartbeat`.)

A dead link does not have to CLOSE the socket, and that cuts both ways. The master
terminates an agent after 60s without a pong (`lib/cloud/relay.js`), but the agent's own
socket can sit in `readyState === OPEN` long after, heartbeating into nothing, until the OS
TCP stack gives up — measured on prod: 71 seconds on one machine and six minutes on
another, both boxes healthy, every chat on them dark for the duration. `agent/agent.js`
therefore runs the same watchdog the browser does: any inbound frame (keepalive, capability
request, even a protocol ping — the agent, unlike a browser, can see those) refreshes
`lastFrameAt`, and 75s of silence on an OPEN socket means `terminate()` + redial.
`terminate`, not `close`: a half-open socket never completes a closing handshake.
`TERMDECK_AGENT_DEAD_MS` overrides the window for `scripts/agent-deadlink-check.js`, which
stands a silent server up in place of a dead master. Recovery is now bounded by us instead
of by Windows.

So the beat is a DATA frame, `{type:'keepalive'}`, sent alongside the ping every `PING_MS`.
It must stay under both windows (75s browser, ~100s Cloudflare) with room for a missed beat,
and it must name NO host and NO session — an unrouted frame the browser's `onMessage`
default branch ignores, which is the only reason it cannot be mistaken for one chat's
traffic. `TERMDECK_WS_PING_MS` overrides the interval for tests only
(`scripts/ws-keepalive-check.js`).

## Cross-tool resumability

Termdeck-started sessions do NOT appear in the terminal `claude` **/resume picker** — newer
CLI builds (verified on 2.1.201) force-remap `CLAUDE_CODE_ENTRYPOINT` to `sdk-cli` for any
headless/non-TTY spawn, clobbering any value we set, so the old trick of stamping
`CLAUDE_CODE_ENTRYPOINT=cli` (removed from `agent/capabilities.js`) no
longer works and there's no known env-var workaround. Sessions are still resumable
regardless — `claude --resume <id>` bypasses the picker's filter entirely; only the
pick-from-list UX is unavailable.

## Settings is a full-viewport page (`public/js/settings/`)

Not a modal: `shell.js` owns the grouped nav, the cross-section search and the mobile
drill-down; `ui.js` is the row/card/group vocabulary every section is built from (one
setting = one row, its explanation is the row's `desc`, never a floating `<p>`); `bus.js`
lets a section ask the shell to re-render it without importing the shell. The route is
`#/settings/<sectionId>` and it persists, so deep links and refresh both land on the right
section (`layout`/`account`/`machines` are aliased to their new ids). `#settings` lives
OUTSIDE `.app` in index.html on purpose — `.main` is its own stacking context, so a
settings layer nested in it paints under the sidebar's z-indexed chrome at any z-index.
Machines and Accounts still render from `pages.js` because `renderMachinesSection` is
shared with the Account page.

## Deploy script flags (`deploy/deploy-web.sh`)

Ships committed frontend to `termdeck.io` (Plesk box `german`, systemd `termdeck-master`):
stamps `?v=`/`public/VERSION`, pushes `origin/main`, box `git reset --hard origin/main`.
Default = NO restart (static files go live on pull, active chats safe). `--full` restarts
master to apply backend/`lib`/`agent` changes and SIGKILLs in-flight remote turns.
`--bust` forces a `sw.js` CACHE bump so a JS-only change lands on already-open tabs
immediately (drops the 0-RTT offline shell once); otherwise the auto CACHE bump is scoped
to `public/index.html` changes and a JS-only change still reaches open tabs on the next
visit via the SW's stale-while-revalidate. `--force` commits a dirty tree, `--dry-run`
previews. Full flow + one-time box setup are in the script header.

## Test-suite rules (`test.mjs`)

- **A green run prints one line per tier.** The cost of a suite is its output, not its
  runtime. On failure it names every failing file, then reruns only those with a verbose
  reporter and strips `at ...` frames. `--verbose` disables the trimming.
- **`// @live` at the start of a comment line quarantines a file** from every default run.
  It means the file spawns a real engine CLI (real API spend, real `~/.claude` writes) or
  asserts against this box's real on-disk history. The marker must be an annotation, not a
  mention — `tests/harness.mjs` pins that rule along with the whole live set.
- **Never add a test that spawns a real CLI.** Point `TERMDECK_CLAUDE_EXE` at
  `tests/fixtures/fake-claude.mjs`, which speaks the same stream-json protocol (init,
  deltas, thinking, tool_use, `can_use_tool` round-trip, result). `relay-turn-check.js`
  does this and proves the whole relay write path offline in seconds.
- **Hermetic or nothing.** Temp `TERMDECK_HOME`, port 0, and scrub `PATH` — `lib/which.js`
  asks the OS (`command -v claude`) before it falls back to homedir guesses, so a faked
  `HOME` alone does NOT stop a test from finding the real authed binary.
- `tests/dom-shim.mjs` is preloaded into the unit tier, so a node test can import
  `public/js/*` directly instead of paying for a browser. It exists to let modules load,
  not to simulate one — real DOM behaviour belongs in the Playwright tier.
- Non-test neighbours must live where the glob cannot see them (`tests/fixtures/`,
  `scripts/`) or be listed in `NOT_A_TEST`. A stdin-waiting helper picked up as a test
  costs a full 90s timeout.
