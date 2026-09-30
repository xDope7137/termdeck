# FAQ

## Can I approve Claude Code permissions from my phone?

Yes. When a turn blocks on a tool approval, Web Push fires with no browser open. Tap
**Allow** or **Deny** on the notification itself, or open the session for the full card.
The run continues. Requests from every chat and machine also collect in one Approvals inbox.

This is the thing Termdeck exists for. An overnight run that stops at 2am on a one-tap
decision is the single most expensive failure in agentic coding, and it is entirely
avoidable.

## Can I use Claude Code from my phone?

Yes. The dashboard is a PWA. Install it to your home screen and you get a per-device push
subscription and the full composer: start new chats, reply to any past
session, switch model and reasoning effort, review diffs, stop a run.

## Does it work with OpenAI Codex CLI?

Yes, fully: turn driving over one shared `codex app-server` per machine, including native
plan mode, inline approvals and mid-turn steering.

Codex sessions group alongside Claude sessions by folder, so one project shows all of its
chats regardless of which engine ran them.

## Does it work with Grok?

Yes, via the Grok CLI (one shared `grok agent stdio` per machine) with your Grok
subscription. Grok takes text, data, source and notebook attachments but not images, has no
native plan mode (Plan behaves as read only), and cannot be steered mid-turn: a message sent
while it runs waits for the next turn.

## Does a session I drive from the browser still work in the terminal?

Yes. `claude --resume <id>`, `codex resume <id>`. Native storage, real cwd, no export step.

Round-trip parity is a hard rule, not a best effort: a Termdeck-started session must stay
natively resumable, and it is tested. One caveat: Termdeck sessions don't appear in the
terminal's interactive `/resume` *picker*, because the CLI force-remaps the entrypoint. The
explicit `--resume <id>` form works.

## Will it show sessions I started in a terminal?

Yes, all of them, once you add the project folder. Termdeck renders the CLI's own files on
disk, so it sees every session whether or not it started it. This is the main thing that separates it from wrapper-style
tools, which only see what they launched themselves.

A session currently attached to a terminal streams live in **view-only**, with a **Take
over** button that closes the idle terminal client and hands you the composer. That lock
exists to prevent two writers forking the same conversation.

## Is there a self-hosted version?

No, and deliberately. There is exactly one way to run Termdeck: connect a machine to your
account and drive it through the cloud.

Your code and transcripts stay on your machine (the agent reads and renders them in place),
but the control plane is hosted. If a self-hosted control plane is a hard
requirement for you, Termdeck is not your tool, and that is a fine answer.

## What can the agent access?

A fixed list of typed capabilities, not a shell. See
[`agent/capabilities.js`](../agent/capabilities.js): that file is the entire trust boundary.

- **Reads** are confined to the transcript roots and the open chat's project folder, read only.
- **Writes** are narrow and named: a file you attach (into `~/.termdeck/uploads`, never your
  project), the project instruction file, checkpoint restore, and the engine account switching
  you ask for.
- **Processes**: the engine CLIs it runs, and a terminal client you asked to take over.

Paths are never sent from the server. The master names a session id; the agent resolves it
against its own disk. The coding agent it drives is another matter: in full access mode it can
do anything you can, which is what the permission rules are for.

## Do I need to open a port or run a tunnel?

No. The agent dials **out** over a reverse WebSocket. No inbound port, no firewall rule, no
tunnel, no dynamic DNS.

## What operating systems are supported?

Linux, macOS and Windows. The agent installs as a user service: `systemd --user` (with a
`@reboot` cron fallback), `launchd`, or `schtasks` respectively. On Windows it runs windowless.

## Does the agent update itself?

Yes, and reversibly. An update is only considered done once the new code successfully
connects back. Every update is staged, compile-checked, and snapshotted to `.rollback/`,
with a marker and two watchdogs; a failed update is quarantined and the old version comes
back.

## What does it cost?

Starter is $9.99 a month ($99.99 a year) for 2 machines. Pro is $29.99 a month ($290 a year)
for 10. Both have unlimited sessions and the same features. Every account starts with a 14-day
trial; a card is needed, and the first charge is on day 15.

You bring your own Claude, Codex or Grok subscription. Termdeck never resells inference and
never sees your API keys: the CLIs on your machine use their own existing logins.

## How is this different from Anthropic's Remote Control?

Remote Control is good, and it comes with your Claude plan. Use it if it covers you.

It is Claude-only, and it shows only the sessions you switch it on for. Termdeck runs three
engines, renders every session on disk whether you opted in or not, terminal-started ones and
last month's included, and gives you one board across every machine you own. Termdeck is for the
case after Remote Control.

## How is this different from Happy?

Happy is free, MIT licensed and end-to-end encrypted, for Claude Code and Codex. It sees only
the sessions you start through its wrapper (`happy claude`, `happy codex`). Termdeck sees every
session on every connected machine, including plain terminal ones, and adds Grok. If you want
a self-hostable encrypted relay, Happy is the better fit.

## Can I see what a run cost?

Yes: API-equivalent cost per project, token totals, cache-read rate and model mix, plus
pace meters for your rolling and weekly limits so you can see a wall coming before you hit
it. Saved engine accounts each get their own meter.

## Something is broken. Where do I look first?

`~/.termdeck/logs/agent.log` on the machine in question. The token is redacted on the way in
and nothing the agent serves is ever logged, so it is safe to attach to an issue: it was
written to be handed to someone. [termdeck.io/fixes](https://termdeck.io/fixes?ref=github)
has a page per common error message.
