# Changelog

Termdeck ships continuously — 417 production deploys in the first 37 days. This is the
curated version: the changes a user would notice, newest first. Agents self-update, so
anything marked *(agent)* reaches connected machines on its own.

## 0.1.54x — 2026-08-08

- **A documentation site at [/docs](https://termdeck.io/docs?ref=github).** Install, the three
  engines, permissions, machines and troubleshooting — instead of a README and a FAQ page.
- **A machine you removed stops stranding its agent.** That box kept dialling a master which
  no longer knew it. The owner is now told, on the machine card, with the fix.
- **Confirmation links outlive a weekend**, and you can ask for a second one when the first
  has expired instead of starting over.

## 0.1.53x — 2026-08-07

- **New chat is a page, not a modal.** The things the modal was gating — project, machine,
  engine, model — are the page now.
- **Every new account starts on Pro for 14 days**, no card.
- **Annual billing**, with existing subscriptions grandfathered by construction rather than
  by a migration anyone has to remember to run.

## 0.1.52x — 2026-08-06

- **The homepage leads with a run, not a screenshot of one.**
- **One house style for every date on screen**, rendered in the reader's own clock rather
  than the machine's.
- **An install that will not survive a reboot says so** *(agent)*, on the machine card —
  rather than the machine quietly going Offline the next time you log out.

## 0.1.50x — 2026-08-05

- **Machines & accounts is one machine-centric page**, with each engine account living
  inside the machine card it belongs to.
- **The connect wizard is a checkout, not a token dump.**
- **One permission-mode vocabulary across all three engines**, so a mode means the same
  thing whether the chat is Claude, Codex or Grok.
- **One shared dialog chrome**, and the last native `alert()`s are gone.

## 0.1.4xx — 2026-08-03/04 — deploys stop killing turns

- **A restart no longer kills the turn you are watching** *(agent)*. A dropped socket used to
  SIGKILL every CLI child on the machine, so a deploy, a Cloudflare idle drop or one missed
  pong murdered healthy in-flight runs. The link and the child now have independent
  lifetimes: the turn parks on your own box and re-attaches, making a master restart a pause
  of a few seconds instead of lost work. Codex and Grok survive link gaps the same way.
- **A message you queued survives a master restart** too.
- **A restart says goodbye** rather than vanishing mid-stream.

## 0.1.388 — 2026-08-02

- **A missing worktree folder is a notice, not a lock.** The composer went dead behind
  "this chat can't run" while the turn was visibly still running. A folder probe is not
  proof a chat is dead — the CLI holds its own working directory. Recovery buttons stay;
  the lock is gone.
- **A chat is named by what it is about, not by its opening line.** Claude's own title now
  outranks the truncated first prompt. A rename you typed still wins over everything.
- **"continue" is never a title.** Typing `continue` to restart a stalled run used to
  rename the whole chat; it now falls back to the title the chat already had.
- **A chat that enters a worktree stops hiding it.** `EnterWorktree` moves a running
  session's files mid-turn; the header and worktree panel follow it now.

## 0.1.38x — 2026-08-01

- **The thinking dial lives on the machine** *(agent)*, so a master restart stops silently
  reverting it to Default.
- **The composer shows what the chat is actually running** — model, effort and mode, read
  from the session rather than guessed from a global default.
- **A notification is something that needs you.** Finished turns say what the turn actually
  did, in one line, instead of `[object Object]`.
- **The session index is joined, never raced** — no more empty sidebar for a beat after a
  restart.

## 0.1.37x — late July 2026

- **Cross-machine fixes:** renaming a machine carries all of its settings, a re-added
  machine can adopt the old one's, and Claude Code's per-connection `ssh-<uuid>` project
  dirs fold together instead of showing as dozens of projects.
- **An idle dashboard stopped tearing down its own WebSocket every 75 seconds**, and the
  agent gained the mirror-image watchdog for a dead link that never closes *(agent)*.
- **One folder is one project.** A trailing slash used to make `/w/Ai/` and `/w/Ai` two
  separate projects for one directory.
- **A model failure now names the machine and the fix** rather than failing silently with
  a stale hardcoded model list.

## 0.1.36x — mid July 2026

- **One time-sorted chat stream**, paged as you scroll, across every project and machine.
- **The chat list repaints instead of being rebuilt** — no more scroll jumps and lost hover
  twice a second for the length of every turn.
- **`/rewind` works on a remote machine** *(agent)*: one restore point per prompt, not one
  per edit.
- **Branch a conversation from a checkpoint.**
- **Renaming a chat renames it in the terminal too** *(agent)*.
- **The sidebar sorts by your last message**, not the file's mtime.

## 0.1.3xx — engine signals

A run of work exposing what the engines already report and nobody surfaces:

- The activity fold says what a run was **for**, not how many tool calls it made.
- A stall reads as a stall, and a model refusal stops being invisible.
- A chat says which account is paying for it.
- A dead MCP server stops looking exactly like a healthy one.
- Stop one sub-agent, and see what stopping it costs.
- A thinking dial that applies to the turn already running.
- A spend ceiling the engine enforces on itself.
- The context strip says what is filling the window, not just "83% full".
