# The Termdeck agent

This is the code that runs on your machine. It reads your coding-agent transcripts and
runs your CLIs, which is a lot of trust, so it is here to be read rather than shipped as
an opaque binary.

## Start here

**[`capabilities.js`](capabilities.js)** is the trust boundary. Every frame the master can
send is handled in that file, and nothing outside it is reachable over the tunnel. If you
are auditing what a connected machine will do, you only have to read one file.

| File | Lines | What it does |
|---|---:|---|
| [`capabilities.js`](capabilities.js) | 2,663 | the whole capability surface: what a machine will answer, and the confinement around it |
| [`engine-runs.js`](engine-runs.js) | 1,283 | runs Claude, Codex and Grok turns on the machine, with a numbered event log the master resubscribes to after any gap |
| [`limits.js`](limits.js) | 951 | reads rate-limit and usage state off the engines |
| [`agent.js`](agent.js) | 949 | dials out, reconnects, and self-updates with a rollback |
| [`agent-protocol.js`](agent-protocol.js) | 487 | the table of every frame the master and agent exchange; an unknown frame is refused by name |
| [`proc-tree.js`](proc-tree.js) | 227 | finds and stops a CLI's whole process tree, including behind Windows shims |
| [`persistence.js`](persistence.js) | 139 | checks the agent will survive logout and reboot, instead of going Offline the moment you close the session that installed it |
| [`log.js`](log.js) | 105 | bounded, rotated logging with the token redacted on the way in |

## Some files here are one-line stubs

You will notice files like this:

```js
module.exports = require('../lib/transcript');
```

Those are placeholders. The transcript parsers and disk primitives are **shared between the
master and the agent**, and the master distributes them to each machine at install and
update time (an `AGENT_FILES` manifest). An installed agent under `~/.termdeck/agent/` has
the full modules sitting flat next to `agent.js`; that is why the stub requires a sibling
path rather than a package.

The reason it works this way: two copies of a transcript parser drift, and a drifted parser
means a chat that renders differently depending on which side read it. One implementation,
run on either side, injected reader.

**So cloning this repo and running `node agent.js` will not work**: those requires have
nothing to resolve to here. Install with the one-liner from
[termdeck.io](https://termdeck.io/signup?ref=github) (Settings, then Machines and accounts), which
fetches a complete agent.

## What it guarantees

- **Confinement.** Reads are resolved against the transcript roots and the open chat's
  project folder (read only) and `realpath`'d, so a symlink inside a root that points outside
  it does not escape. Paths are never sent from the server: the master names a session id and
  the agent resolves it against its own disk. The writes are few and named: an attached file
  (into `~/.termdeck/uploads`, never the project), the project instruction file, checkpoint
  restore, and engine account switching.
- **Outbound only.** The agent dials the master over a reverse WebSocket. No inbound port,
  no firewall rule, no tunnel.
- **Reversible updates.** An update counts as done only once the new code connects back.
  Staged, compile-checked, snapshotted to `.rollback/`, with a marker and two watchdogs;
  a failed update is quarantined and the previous version is restored.
- **A log you can hand over.** The token is redacted on the way in and nothing the agent
  *serves* is ever logged. `~/.termdeck/logs/agent.log` is safe to attach to an issue.

Found something wrong with any of that? [SECURITY.md](../.github/SECURITY.md).
