# FAQ

## Can I approve Claude Code permissions from my phone?

Yes. When a turn blocks on a tool approval, Web Push fires with no browser open, deep-links
straight into the session, and you tap **Allow once**, **Always this session**, or **Deny**.
The run continues. Median 1.4s from the agent asking to the notification landing.

This is the thing Termdeck exists for. An overnight run that stops at 2am on a one-tap
decision is the single most expensive failure in agentic coding, and it is entirely
avoidable.

## Can I use Claude Code from my phone?

Yes — the dashboard is a PWA. Install it to your home screen and you get the offline shell,
a per-device push subscription, and the full composer: start new chats, reply to any past
session, switch model and reasoning effort, review diffs, stop a run.

## Does it work with OpenAI Codex CLI?

Yes, fully — turn driving over a long-lived `codex app-server` JSON-RPC child, including
native plan mode, inline approvals and mid-turn steering. Termdeck is the only web UI that
drives both Claude Code and Codex.

Codex sessions group alongside Claude sessions by folder, so one project shows all of its
chats regardless of which engine ran them.

## Does it work with Grok?

Yes, via the Grok CLI (`grok agent stdio`) with your Grok subscription. Grok chats are
text-only — no attachments — and have no native plan mode.

## Does a session I drive from the browser still work in the terminal?

Yes. `claude --resume <id>`, `codex resume <id>`. Native storage, real cwd, no export step.

Round-trip parity is a hard rule, not a best effort: a Termdeck-started session must stay
natively resumable, and it is tested. One caveat — Termdeck sessions don't appear in the
terminal's interactive `/resume` *picker*, because the CLI force-remaps the entrypoint. The
explicit `--resume <id>` form works.

## Will it show sessions I started in a terminal?

Yes, all of them. Termdeck renders the CLI's own files on disk, so it sees every session
whether or not it started it. This is the main thing that separates it from wrapper-style
tools, which only see what they launched themselves.

A session currently attached to a terminal streams live in **view-only**, with a **Take
over** button that closes the idle terminal client and hands you the composer. That lock
exists to prevent two writers forking the same conversation.

## Is there a self-hosted version?

No, and deliberately. There is exactly one way to run Termdeck: connect a machine to your
account and drive it through the cloud.

Your code and transcripts never leave your machine — the agent reads and renders them in
place — but the control plane is hosted. If a self-hosted control plane is a hard
requirement for you, Termdeck is not your tool, and that is a fine answer.

## What can the agent access?

The transcript roots, and nothing else. See [`agent/capabilities.js`](../agent/capabilities.js) —
that file is the entire trust boundary.

Paths are never sent from the server. The master names a session id; the agent resolves it
against its own disk. The single write outside those roots is checkpoint restore, which
works the same way: ids in, never paths, never bytes.

## Do I need to open a port or run a tunnel?

No. The agent dials **out** over a reverse WebSocket. No inbound port, no firewall rule, no
tunnel, no dynamic DNS.

## What operating systems are supported?

Linux, macOS and Windows. The agent installs as a user service — `systemd --user`,
`launchd`, or `schtasks` respectively. On Windows it runs windowless.

## Does the agent update itself?

Yes, and reversibly. An update is only considered done once the new code successfully
connects back. Every update is staged, compile-checked, and snapshotted to `.rollback/`,
with a marker and two watchdogs; a failed update is quarantined and the old version comes
back.

## What does it cost?

Free while you connect one machine. Paid plans add machines and concurrent sessions.

You bring your own Claude, Codex or Grok subscription. Termdeck never resells inference and
never sees your API keys — the CLIs on your machine use their own existing logins.

## How is this different from Anthropic's Remote Control?

Remote Control is good, and it is free with Pro. Use it if it covers you.

It is Claude-only, it shows only the sessions you explicitly opted in, and it is one
machine at a time. Termdeck runs three engines, renders every session on disk whether you
opted in or not, and gives you one board across every machine you own. Termdeck is for the
case after Remote Control.

## How is this different from Happy or claudecodeui?

Both are Claude-only. Happy sees only sessions it started itself. Neither has a
multi-machine fleet board, and neither drives Codex.

## Can I see what a run cost?

Yes — API-equivalent cost per project, token totals, cache-read rate and model mix, plus
pace meters for your 5-hour, weekly and daily limits so you can see a wall coming before
you hit it.

## Something is broken. Where do I look first?

`~/.termdeck/agent.log` on the machine in question. The token is redacted on the way in and
nothing the agent serves is ever logged, so it is safe to attach to an issue — it was
written to be handed to someone.
