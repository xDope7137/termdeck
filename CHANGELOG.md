# Changelog

Termdeck ships continuously: 906 production deploys in the first 90 days. This is the
curated version: the changes a user would notice, newest first. Agents self-update, so
anything marked *(agent)* reaches connected machines on its own.

## 0.1.115x · 2026-09-29/30

- **Every account starts with a card and a 14-day trial.** Pick Starter or Pro, and the first
  charge lands when the trial ends. The no-card trial and the free tier are gone.
- **A new look, Graphite**, across the sidebar, chat, composer, board, Settings, permission
  cards and the file dock.
- **Codex transcripts read like work.** Code-mode calls render as the commands and diffs they
  are rather than JavaScript, and reads, searches and web searches are counted as such.
- **Claude's limit-reset grants show on the usage pill** *(agent)*, lit when one is usable.
- **`@` file completion on the New chat page.**

## 0.1.11xx · 2026-09-27/28 · turns run on your machine

- **Every turn now runs on the machine it belongs to** *(agent)*. The agent spawns the CLI,
  reads its stream itself and keeps a numbered log of the run. A dropped link or a master
  restart is just a viewer going away: the turn carries on, and the dashboard picks up from
  the last event it saw. Codex and Grok each run one shared process per machine, the way
  their own desktop apps do.
- **The agent builds the session index** *(agent)*, so opening a machine is a small answer
  instead of a pile of file reads.
- **Claude runs with the 1M context window** wherever the model supports it.
- **Usage, Board, Approvals, Archive and Terminals share one page kit.**
- **Copy link copies the chat's short URL.**

## 0.1.10xx · 2026-09-14/23

- **Attach any file the CLI can read** *(agent)*. The file goes to the machine the chat runs
  on and the engine is handed its path, so it opens it with its own tools. Grok takes
  attachments too.
- **A refund and cancellation policy**, linked from every footer.

## 0.1.97x · 2026-09-01/06

- **The device you are looking at keeps the others quiet.** A focused window stops the same
  approval buzzing your phone as well.
- **Two devices on one chat know about each other**, and one of them is named the driver, so
  a message from the phone no longer lands in the middle of work the desktop started.
- **A per-chat switch takes Termdeck's own permission rules out of the loop**, and the
  composer says "rules off" while it is.
- **The sidebar's Active window** keeps recently busy chats together, on by default at 15
  minutes.
- **[/fixes](https://termdeck.io/fixes?ref=github)**: a page per error message, saying which
  process actually printed it.

## 0.1.8xx · 2026-08-24/30

- **A deploy no longer costs you a cold index**, and one slow machine no longer blanks the
  whole sidebar.
- **Per-account usage meters** in Machines and accounts.
- **Image previews up to 5 MB, with a lightbox**, and a draggable explorer/reader split on a
  phone.
- **A background tab keeps following the machine**, so switching back is instant.

## 0.1.6xx · 2026-08-12/17

- **Sub-agents get their own pane**: every sub-agent a chat has spawned, as tabs, with a live
  workbench while they run.
- **Claude's native Auto permission mode.**
- **Start a chat in a git worktree**, and pick which one. A Codex chat follows itself into
  the worktree it made.
- **Every path an agent writes is a link** that opens the file in the dock.
- **The slash palette says what each command does**, and skills get badges.
- **A theme picker in Settings.**
- **Reopening a chat you just read costs no fetch**, and scroll-back pages in.
- **Usage says why a limit is being spent**, not just how much is left.
- **A machine tells you when an update is scheduled, and when it lands.**

## 0.1.55x · 2026-08-08/09

- **Background shells survive their turn** *(agent)*. A dev server a chat started keeps
  running after the reply, with a panel to see and stop it.
- **A guided tour** runs once on a new account's first sign-in.

## 0.1.54x · 2026-08-08

- **A documentation site at [/docs](https://termdeck.io/docs?ref=github).** Install, the three
  engines, permissions, machines and troubleshooting, instead of a README and a FAQ page.
- **A machine you removed stops stranding its agent.** That box kept dialling a master which
  no longer knew it. The owner is now told, on the machine card, with the fix.
- **Confirmation links outlive a weekend**, and you can ask for a second one when the first
  has expired instead of starting over.

## 0.1.53x · 2026-08-07

- **New chat is a page, not a modal.** The things the modal was gating (project, machine,
  engine, model) are the page now.
- **Every new account starts on Pro for 14 days**, no card.
- **Annual billing**, with existing subscriptions grandfathered by construction rather than
  by a migration anyone has to remember to run.

## 0.1.52x · 2026-08-06

- **The homepage leads with a run, not a screenshot of one.**
- **One house style for every date on screen**, rendered in the reader's own clock rather
  than the machine's.
- **An install that will not survive a reboot says so** *(agent)*, on the machine card,
  rather than the machine quietly going Offline the next time you log out.

## 0.1.50x · 2026-08-05

- **Machines & accounts is one machine-centric page**, with each engine account living
  inside the machine card it belongs to.
- **The connect wizard is a checkout, not a token dump.**
- **One permission-mode vocabulary across all three engines**, so a mode means the same
  thing whether the chat is Claude, Codex or Grok.
- **One shared dialog chrome**, and the last native `alert()`s are gone.

## 0.1.4xx · 2026-08-03/04 · deploys stop killing turns

- **A restart no longer kills the turn you are watching** *(agent)*. A dropped socket used to
  SIGKILL every CLI child on the machine, so a deploy, a Cloudflare idle drop or one missed
  pong murdered healthy in-flight runs. The link and the child now have independent
  lifetimes: the turn parks on your own box and re-attaches, making a master restart a pause
  of a few seconds instead of lost work. Codex and Grok survive link gaps the same way.
- **A message you queued survives a master restart** too.
- **A restart says goodbye** rather than vanishing mid-stream.

## 0.1.388 · 2026-08-02

- **A missing worktree folder is a notice, not a lock.** The composer went dead behind
  "this chat can't run" while the turn was visibly still running. A folder probe is not
  proof a chat is dead: the CLI holds its own working directory. Recovery buttons stay;
  the lock is gone.
- **A chat is named by what it is about, not by its opening line.** Claude's own title now
  outranks the truncated first prompt. A rename you typed still wins over everything.
- **"continue" is never a title.** Typing `continue` to restart a stalled run used to
  rename the whole chat; it now falls back to the title the chat already had.
- **A chat that enters a worktree stops hiding it.** `EnterWorktree` moves a running
  session's files mid-turn; the header and worktree panel follow it now.

## 0.1.38x · 2026-08-01

- **The thinking dial lives on the machine** *(agent)*, so a master restart stops silently
  reverting it to Default.
- **The composer shows what the chat is actually running**: model, effort and mode, read
  from the session rather than guessed from a global default.
- **A notification is something that needs you.** Finished turns say what the turn actually
  did, in one line, instead of `[object Object]`.
- **The session index is joined, never raced**: no more empty sidebar for a beat after a
  restart.

## 0.1.37x · late July 2026

- **Cross-machine fixes:** renaming a machine carries all of its settings, a re-added
  machine can adopt the old one's, and Claude Code's per-connection `ssh-<uuid>` project
  dirs fold together instead of showing as dozens of projects.
- **An idle dashboard stopped tearing down its own WebSocket every 75 seconds**, and the
  agent gained the mirror-image watchdog for a dead link that never closes *(agent)*.
- **One folder is one project.** A trailing slash used to make `/w/Ai/` and `/w/Ai` two
  separate projects for one directory.
- **A model failure now names the machine and the fix** rather than failing silently with
  a stale hardcoded model list.

## 0.1.36x · mid July 2026

- **One time-sorted chat stream**, paged as you scroll, across every project and machine.
- **The chat list repaints instead of being rebuilt**: no more scroll jumps and lost hover
  twice a second for the length of every turn.
- **`/rewind` works on a remote machine** *(agent)*: one restore point per prompt, not one
  per edit.
- **Branch a conversation from a checkpoint.**
- **Renaming a chat renames it in the terminal too** *(agent)*.
- **The sidebar sorts by your last message**, not the file's mtime.

## 0.1.3xx · engine signals

A run of work exposing what the engines already report and nobody surfaces:

- The activity fold says what a run was **for**, not how many tool calls it made.
- A stall reads as a stall, and a model refusal stops being invisible.
- A chat says which account is paying for it.
- A dead MCP server stops looking exactly like a healthy one.
- Stop one sub-agent, and see what stopping it costs.
- A thinking dial that applies to the turn already running.
- A spend ceiling the engine enforces on itself.
- The context strip says what is filling the window, not just "83% full".
