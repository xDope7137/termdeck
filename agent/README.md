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
| [`capabilities.js`](capabilities.js) | 3,006 | the whole capability surface: what a machine will answer, and the confinement around it |
| [`engine-runs.js`](engine-runs.js) | 1,642 | runs Claude, Codex and Grok turns on the machine, with a numbered event log the master resubscribes to after any gap |
| [`limits.js`](limits.js) | 958 | reads rate-limit and usage state off the engines |
| [`agent.js`](agent.js) | 1,287 | dials out, reconnects, and self-updates with a rollback |
| [`agent-protocol.js`](agent-protocol.js) | 502 | the table of every frame the master and agent exchange; an unknown frame is refused by name |
| [`proc-tree.js`](proc-tree.js) | 287 | finds and stops a CLI's whole process tree, including behind Windows shims |
| [`persistence.js`](persistence.js) | 209 | checks the agent will survive logout and reboot, instead of going Offline the moment you close the session that installed it |
| [`engine-install.js`](engine-install.js) | 160 | installs a missing Claude Code, Codex or Grok CLI when you ask from the machine card |
| [`endpoints.js`](endpoints.js) | 186 | when to move to the fallback address (edge.termdeck.io) and back, judged from numbered heartbeats |
| [`instance-lock.js`](instance-lock.js) | 146 | one agent per install: a second one started beside it waits instead of fighting for the connection |
| [`log.js`](log.js) | 105 | bounded, rotated logging with the token redacted on the way in |
| [`update-signature.js`](update-signature.js) | 76 | checks the offline Ed25519 signature on every update before a byte of it is installed |

## This folder is what gets installed

Every file here is byte for byte what termdeck.io serves to an installing machine, in the same
flat layout as `~/.termdeck/agent/`. Some modules (the transcript parsers, the session index, the
disk primitives) are shared with the master, which runs the same code: one implementation, so a
chat renders the same whichever side read it.

The supported install is the one-liner or `npx termdeck-agent install --token agt_...`; both
register a service so the agent survives logout and reboot. Running `npm install && node agent.js`
here works too, with `TERMDECK_AGENT_TOKEN` and `TERMDECK_MASTER_URL=https://termdeck.io` set,
but nothing restarts it.

## What it guarantees

- **Confinement.** Reads are resolved against the transcript roots and the open chat's
  project folder (read only) and `realpath`'d, so a symlink inside a root that points outside
  it does not escape. Paths are never sent from the server: the master names a session id and
  the agent resolves it against its own disk. The writes are few and named: an attached file
  (into `~/.termdeck/uploads`, never the project), the project instruction file, checkpoint
  restore, and engine account switching.
- **Outbound only.** The agent dials the master over a reverse WebSocket. No inbound port,
  no firewall rule, no tunnel. It reaches termdeck.io directly or through the fallback address
  edge.termdeck.io; a firewall that allow-lists hosts needs both.
- **Signed updates.** Each release is signed offline with an Ed25519 key that never lives on the
  master. The agent installs an update only when the signature and every file hash check out, so
  a compromised master still cannot push code to your machine.
- **Reversible updates.** An update counts as done only once the new code connects back.
  Staged, compile-checked, snapshotted to `.rollback/`, with a marker and two watchdogs;
  a failed update is quarantined and the previous version is restored.
- **A log you can hand over.** The token is redacted on the way in and nothing the agent
  *serves* is ever logged. `~/.termdeck/logs/agent.log` is safe to attach to an issue.

Found something wrong with any of that? [SECURITY.md](../.github/SECURITY.md).
