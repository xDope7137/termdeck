<div align="center">

# Termdeck

### The agents are running. Go live your life.

**Web control plane for the coding-agent CLIs already on your machines.**
Claude Code, OpenAI Codex CLI and Grok: one fleet board, every device, tool approvals on your phone.

[**termdeck.io**](https://termdeck.io?ref=github) · [Install](#install) · [How it works](#how-it-works) · [FAQ](#faq)

<br />

[![Commits](https://img.shields.io/badge/commits-2%2C580-e2611b?style=flat-square)](https://termdeck.io?ref=github)
[![Deploys](https://img.shields.io/badge/production%20deploys-906-e2611b?style=flat-square)](https://termdeck.io?ref=github)
[![Invariants](https://img.shields.io/badge/documented%20invariants-53-3f9142?style=flat-square)](docs/INVARIANTS.md)
[![Engines](https://img.shields.io/badge/engines-Claude%20%C2%B7%20Codex%20%C2%B7%20Grok-1f2937?style=flat-square)](#three-engines-one-ui)
[![Agent license](https://img.shields.io/badge/agent-MIT-1f2937?style=flat-square)](LICENSE)
[![Instagram](https://img.shields.io/badge/instagram-%40termdeck-E4405F?style=flat-square&logo=instagram&logoColor=white)](https://instagram.com/termdeck)

<br />

<img src="media/termdeck-demo.gif" alt="Termdeck demo: the fleet board across three machines, approving a Claude Code tool permission from a phone, answering the agent's question inline, and Claude Code, Codex CLI and Grok running in parallel" width="880" />

</div>

<br />

## The minute after

The agents already run fine. That was never the hard part.

The hard part is the minute after. A run stops on a tool approval and **sits there** until you
happen to wander back to the terminal. Overnight runs die at 2am on a one-tap decision. Three
sessions across two machines become three terminals you have to remember to check. A laptop lid
closes and the SSH session goes with it.

Termdeck is the board that watches all of it, and pushes you the one moment that needs a human.

<br />

## Disk is the source of truth

This is the design, and it is the one claim a wrapper cannot copy.

Termdeck does not run agents in its own sandbox and it does not keep its own copy of your
conversations. It renders **the CLI's own session files, on your machine**:
`~/.claude/projects/<slug>/<id>.jsonl`, `$CODEX_HOME/sessions`, `~/.grok`.

Three things fall out of that, for free:

- **Every session shows up.** Not just the ones you started through Termdeck. Add a project folder
  and its whole terminal history is already there, months of it, searchable.
- **Round-trip parity is 100%.** A session you unblocked from your phone on the train still opens with
  `claude --resume <id>` at your desk. Native storage, real cwd, no export step.
- **A terminal-attached session streams live**, in view-only, with a **Take over** button that closes
  the idle terminal client and hands you the composer.

<br />

## Three engines, one UI

| | Claude Code | OpenAI Codex CLI | Grok |
|---|:---:|:---:|:---:|
| Render every past session | ● | ● | ● |
| Drive turns from the browser | ● | ● | ● |
| Inline tool approvals | ● | ● | ● |
| Steer a running turn mid-flight | ● | ● | ○ |
| Model + reasoning effort per turn | ● | ● | ● |
| Native plan mode | ● | ● | ○ |
| Resumable in its own CLI afterwards | ● | ● | ● |

The engine is picked per chat. They share one sidebar, one transcript renderer and one permission
card, so there is nothing new to learn when you switch.

<br />

## What you get

|  | |
|---|---|
| **One fleet board** | Every machine you connect: laptop, desktop, VM, the box under the desk. Sessions sorted by who needs you, not by which terminal they live in. |
| **Approve from your phone** | Web Push fires with no browser open. Allow or Deny on the notification itself, or tap through to the session. |
| **One approvals inbox** | Every request waiting on you, across chats and machines, in one list you can answer in bulk. |
| **Answer the agent inline** | `AskUserQuestion` renders as real options. No switching to a terminal to type `2`. |
| **Take over a terminal session** | The view-only lock, released. Close the idle CLI client and drive from the web. |
| **Switch model and effort mid-run** | Per turn. Drop to a cheap model for the mechanical part, jump to the big one for the hard part. |
| **Docked diff review** | Changed files with +/− counts, next to the transcript, and a pull request opened from the same dock. |
| **Terminals canvas** | Every chat as a live pane on one grid, across machines. |
| **Background shells** | A dev server a chat started keeps running after the reply, and the chat picks up when a shell finishes. |
| **Fleet-wide search** | Every session on every machine, by prompt, project or host. |
| **Cost and pace meters** | API-equivalent cost per project, token totals, cache-read rate, and rolling and weekly limit pacing before you hit the wall. |
| **Switch accounts** | Saved engine logins per machine, each with its own usage meter. |
| **Install to your home screen** | PWA with a push subscription per device. The device you are looking at keeps the others quiet. |

<br />

## Install

Two minutes, and no inbound port on your machine.

**1.** Sign up at [termdeck.io/signup](https://termdeck.io/signup?ref=github) with GitHub, or email and password,
and start the 14-day trial.

**2.** Add a machine (Settings, then Machines and accounts). You get a one-liner carrying that
machine's token:

```bash
curl -fsSL https://termdeck.io/install.sh | TERMDECK_AGENT_TOKEN=agt_… sh
```

```powershell
$env:TERMDECK_AGENT_TOKEN="agt_…"; iwr https://termdeck.io/install.ps1 | iex
```

**3.** Add a project folder. Its sessions are already there.

macOS, Linux and Windows. The agent installs as a user service (`launchd` / `systemd --user` /
`schtasks`, with a `@reboot` cron fallback) and keeps itself updated. Full unit templates in [deploy/AGENT-SETUP.md](deploy/AGENT-SETUP.md).

<br />

## How it works

The agent **dials out** over a reverse WebSocket. There is no inbound port, no firewall rule and no
tunnel on your side. Turns run on your machine: the agent spawns the CLI, reads its stream and keeps
a numbered log, so a dropped link or a restart of the master is a viewer going away, not a lost run.

```
your machine                          termdeck.io
┌────────────────────────┐            ┌──────────────────────────┐
│ ~/.claude  ~/.codex    │            │  master                  │
│      ▲                 │            │   ├─ session list cache  │
│      │ watch + read    │            │   ├─ browser WebSocket   │
│ ┌────┴─────┐           │            │   └─ Web Push            │
│ │  agent   │ ──── reverse WS ────▶  │                          │
│ │  index,  │           │            │                          │
│ │  runs    │           │            │                          │
│ └────┬─────┘   (dial-out, TLS)      └───────────┬──────────────┘
│      │ spawn                                    │
│  claude / codex / grok                      your browser
└────────────────────────┘                    (phone, laptop, tablet)
```

**The agent is in this repo.** Read it before you run it. That is why it is here. It is a fixed list
of typed capabilities, not a remote shell: reads confined to the transcript roots and the open
chat's project folder, a few narrow named writes, processes it started itself. It redacts its own
token out of its logs, never logs anything it serves, and stages every self-update behind a compile
check with a `.rollback/` snapshot and two watchdogs.

Start at [`agent/agent.js`](agent/agent.js) and [`agent/capabilities.js`](agent/capabilities.js).
The second one is the whole list of what a machine will answer.

<br />

## Built in the open, and written down

**53 load-bearing invariants**, each one carrying the failure that produced it:
[docs/INVARIANTS.md](docs/INVARIANTS.md).

> **A preview is a PAINT, read from the TAIL.** Seeds and `?tail=1` parse only the file's last bytes;
> `startLine` keeps `totalLines` exact, because it is the cursor every `?since` splice rides.

> **A delta may only be spliced onto the cursor it was fetched at.** A live push landing inside a
> `?since` fetch is what duplicated the transcript, on screen *and* in the cache, whenever a second
> chat was live.

<div align="center">

**2,580** commits · **906** production deploys · **90** days
**169k** lines · **611** test files · **53** invariants · **0** build steps

</div>

<br />

## Compared to

| | Termdeck | Happy | Claude Remote Control |
|---|:---:|:---:|:---:|
| Claude Code | ● | ● | ● |
| OpenAI Codex CLI | ● | ● | ○ |
| Grok | ● | ○ | ○ |
| Sees sessions it didn't start | ● | ○ | ○ |
| Push approval to phone | ● | ● | ● |
| Take over a terminal session | ● | ○ | ○ |
| No extra subscription | ○ | ● | ● |

Anthropic's Remote Control is good and it comes with your Claude plan, if you run one engine and
only the sessions you switch it on for. Happy is free, open source and end-to-end encrypted, for
sessions you start through its wrapper. Termdeck is for every session, on every machine, in all
three engines. Longer write-ups: [termdeck.io/vs](https://termdeck.io/vs?ref=github).

<br />

## FAQ

#### Can I approve Claude Code permissions from my phone?

Yes. That is the feature the product exists for. When a turn blocks on a tool approval, Web Push
fires with no browser open. Tap Allow or Deny on the notification, or open the session for the full
card. The run continues from your pocket.

#### Is there a self-hosted version?

No, and deliberately. There is one way to run Termdeck: connect a machine to your account and drive
it through the cloud. Your code and your transcripts never leave your machine (the agent reads and
renders them in place), but the control plane is hosted.

#### Does a session I drive from the browser still work in the terminal?

Yes. `claude --resume <id>` and `codex resume <id>`. Native storage, real cwd, and Codex resumes the
thread before every web turn so terminal appends are picked up. Round-trip parity is a hard rule, and
it is tested.

#### Does it work with Codex CLI?

Yes. Full turn driving over one shared `codex app-server` per machine, including native plan mode,
with Claude Code and Grok in the same sidebar.

#### What can the agent actually touch?

A fixed list of typed capabilities, not a shell. Reads are confined to the transcript roots and the
open chat's project folder (read only). Paths are never sent from the server: the master names a
session id and the agent resolves it against its own disk. The writes are narrow and named: a file
you attach (into `~/.termdeck/uploads`, never your project), the project instruction file, checkpoint
restore, and the engine account switching you ask for. Processes it may signal are ones it started,
plus a terminal client you asked to take over. The code is in
[`agent/capabilities.js`](agent/capabilities.js); [termdeck.io/docs/security](https://termdeck.io/docs/security?ref=github) is the long version.

The coding agent it drives is another matter: in full access mode it can do anything you can. That
is what the permission rules are for.

#### What does it cost?

Starter is $9.99 a month for 2 machines, Pro is $29.99 for 10, both with unlimited sessions and the
same features. Every account starts with a 14-day trial; a card is needed and the first charge is
on day 15. You bring your own Claude / Codex / Grok subscription; Termdeck never resells inference.

<br />

## What's in this repo

This repo is the **agent and the documentation**: the parts that run on your machine, so you can
read them before you trust them. The hosted control plane (session index, browser WebSocket, push,
billing) is not open source.

```
agent/                 the thin agent: root-confined capabilities, self-update, log redaction
install.sh / .ps1      the one-liners the dashboard hands you
deploy/                systemd / launchd / schtasks units, heal + uninstall scripts
docs/ARCHITECTURE.md   how the pieces fit
docs/INVARIANTS.md     53 load-bearing rules and the failure behind each one
```

### Why some `agent/` files are one line

Several modules in `agent/` are stubs that read:

```js
module.exports = require('../lib/transcript');
```

They are placeholders, not the implementation. The transcript parsers and disk primitives
are **shared between the master and the agent**, and the master distributes them to each
machine at install and update time (an `AGENT_FILES` manifest), so an installed agent under
`~/.termdeck/agent/` has the full modules sitting flat beside `agent.js`.

There is one copy of those rules, on purpose. Two copies of a transcript parser drift, and
a drifted parser is how you get a chat that renders differently depending on which side read
it. The stub is what keeps a repo-run agent pointing at the same file rather than a fork of
it.

The practical consequence: **cloning this repo and running `node agent/agent.js` will not
work**. Those requires have nothing to resolve to here. Install via the one-liner above,
which fetches a complete agent. What is fully present in this repo is the agent's own code:

| File | Lines | What it is |
|---|---:|---|
| [`agent/capabilities.js`](agent/capabilities.js) | 2,622 | the entire capability surface, the trust boundary |
| [`agent/engine-runs.js`](agent/engine-runs.js) | 1,283 | runs each engine's turns on the machine, with a numbered event log |
| [`agent/limits.js`](agent/limits.js) | 951 | rate-limit and usage reading |
| [`agent/agent.js`](agent/agent.js) | 949 | dial-out, reconnect, self-update with rollback |
| [`agent/agent-protocol.js`](agent/agent-protocol.js) | 487 | the frame table between the master and the agent |
| [`agent/log.js`](agent/log.js) | 105 | bounded, rotated, token-redacted logging |

If you are auditing what a Termdeck machine will do, `capabilities.js` is the file. Nothing
outside it is reachable over the tunnel.

<br />

<div align="center">

### Your agents are already running.

**[Start at termdeck.io →](https://termdeck.io?ref=github)**

If this is the thing you keep wishing existed, a ⭐ helps other people find it.

<sub>Built by <a href="https://bhavikp.in">Bhavik Patel</a> · <a href="https://termdeck.io?ref=github">termdeck.io</a> · <a href="https://instagram.com/termdeck">@termdeck</a></sub>

</div>
