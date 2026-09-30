# Architecture

The one idea everything else follows from: **disk is the source of truth.**

Claude Code, Codex CLI and Grok each persist their sessions to files on *your* machine.
Termdeck renders from those files. It does not run agents in its own sandbox, and it keeps
no transcript of its own. The live stream layers only ephemeral aliveness on top: token
deltas, the tool ticker, permission prompts.

That is why a session driven from your phone still opens with `claude --resume <id>` in
your terminal, and why a session you started in a terminal months ago shows up in the
dashboard without you having opted in to anything.

## The shape

```
your machine                                    termdeck.io
┌──────────────────────────────┐                ┌────────────────────────────┐
│  ~/.claude/projects/*.jsonl  │                │  master                    │
│  $CODEX_HOME/sessions/*      │                │   ├─ per-machine session   │
│  ~/.grok/...                 │                │   │  list + incremental    │
│         ▲         ▲          │                │   │  transcript parsing    │
│  watch  │         │ read     │                │   ├─ browser WebSocket:    │
│    ┌────┴─────────┴────┐     │                │   │  subscriptions,        │
│    │ agent: index, runs│ ───── reverse WS ──▶ │   │  fan-out, snapshots    │
│    └────┬──────────────┘     │   (dial-out)   │   ├─ REST for initial load │
│         │ spawn              │                │   └─ Web Push              │
│  claude / codex / grok       │                └─────────────┬──────────────┘
└──────────────────────────────┘                              │
                                                        your browser
                                                  (phone, laptop, tablet)
```

The agent **dials out**. No inbound port, no firewall rule, no tunnel on your side. It runs
as your logged-in user, because it has to read that user's `~/.claude` / `~/.codex` /
`~/.grok` and spawn their CLIs.

## Where each engine's data lives

| | Transcripts | Liveness | Titles |
|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<slug>/<sessionId>.jsonl`: one JSON record per line; assistant turns are one line **per content block** | `~/.claude/sessions/<pid>.json`; liveness is *pid alive*, `updatedAt` is not a heartbeat | `~/.claude/history.jsonl`, plus `ai-title` / `custom-title` records in the transcript |
| **Codex CLI** | `$CODEX_HOME/sessions` rollouts, id from filename, `.jsonl.zst` supported | no pid registry, a rollout-growth heuristic | rollout head + `session_index.jsonl` renames |
| **Grok** | `updates.jsonl` per session dir | attached pid | `summary.json` sibling |

All three normalise to one block vocabulary, so the sidebar, transcript renderer and
permission card are written once.

## The agent

Everything the agent will do is in [`agent/capabilities.js`](../agent/capabilities.js).
That file is the whole trust boundary, and it is short on purpose.

- **Typed and confined.** Reads resolve against the transcript roots and the open chat's
  project folder (read only), and nothing else. Paths are never sent from the server: the
  master names a *session id*, and the agent resolves it against its own disk. The writes
  are few and named: an attached file (into `~/.termdeck/uploads`, never the project), the
  project instruction file, checkpoint restore, and engine account switching.
- **The index lives on the machine.** Rebuilding a session index by streaming raw
  transcripts to the server measured at 124 MB across 581 reads to learn 200 titles. The
  agent now owns the index (`~/.termdeck/session-index.json`) and returns a few hundred
  bytes of answer. The parse module
  is shared, injected-reader style, so there is exactly one copy of the rules.
- **Self-update is reversible.** An update is only "done" once the new code gets a
  `welcome` frame back. Staged, compile-checked, `.rollback/` snapshot, a marker plus two
  watchdogs, and quarantine on failure.
- **The log is written to be handed to someone.** The token is redacted on the way in,
  nothing the agent *serves* is ever logged, and it is bounded and rotated.

## Turn driving

Turns run **on the machine**, in [`agent/engine-runs.js`](../agent/engine-runs.js). The
agent spawns the CLI, reads its stream itself, translates it into one engine-event format
and keeps a numbered log per run. The master subscribes from a sequence number, so a
dropped link or a master restart is just a subscriber going away: the run carries on, and
the next subscriber asks for everything after the last event it saw.

- **Claude** runs as raw `stream-json` against the machine's own CLI, one process per run.
  No SDK. A CLI that still owns background shells when its turn ends is kept as the chat's
  shell host, so a dev server outlives the reply. Every other exit path reaps it, since a
  leaked CLI would lock the session view-only.
- **Codex** runs as one shared `codex app-server` per machine (JSON-RPC over stdio), the way
  Codex Desktop does. A run is one turn on one thread, with `thread/resume` before every web
  turn so terminal appends are picked up. Stop interrupts the turn rather than killing the
  shared child.
- **Grok** runs as one shared `grok agent stdio` per machine (Agent Client Protocol). A run
  is one prompt on one session; Stop is `session/cancel`.

For Claude, the prompt stream stays open for the whole turn. That is what keeps stdin alive for
background agent permissions, and what lets a message be pushed into an already-running
turn (Steer), rather than only being queued for the next one. Codex steers natively; Grok
has no mid-turn input, so its messages queue.

## Streaming reconciliation

The subtle part, and the source of the most-cited bug class.

Stream deltas render into an ephemeral bubble keyed by the API `message.id`. Claude Code
writes one jsonl line per *completed content block*, so each canonical append pops one
settled block off the bubble. Get this wrong and every message renders twice.

The same care applies to deltas: a `?since` delta may only be spliced onto the cursor it
was fetched at. A live push landing inside an in-flight fetch is what used to duplicate a
transcript, on screen and in the browser's cache, whenever a second chat was live.

## Further reading

[docs/INVARIANTS.md](INVARIANTS.md): 53 load-bearing rules, each with the failure that
produced it. It is the honest version of this document.
