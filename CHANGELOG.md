# Changelog

Termdeck ships continuously: 1,013 production deploys in the first 112 days. This is the
curated version: the changes a user would notice, newest first. Agents self-update, so
anything marked *(agent)* reaches connected machines on its own.

## 0.1.149x · 2026-10-27

- **The faster route, not just the working one** *(agent)*. The agent times termdeck.io and
  edge.termdeck.io before it connects and uses whichever answers faster. It checks again every five
  minutes and moves when the other is clearly faster twice in a row. A failed connection still
  moves it at once, to the fastest address it has not tried. The browser does the same and
  remembers its pick for the next visit.
- **A second route to Termdeck** *(agent)*. Some internet providers route termdeck.io badly enough
  to drop the connection every few minutes while everything else works. The agent now moves to
  edge.termdeck.io on its own after two missed heartbeats or a minute of slow ones. The browser
  does the same for its live connection; the page stays on termdeck.io. If your firewall
  allow-lists hosts, allow both.
- **Drops are noticed in about 30 seconds**, down from up to 90, on the agent and in the browser.
- **A flaky network no longer rolls back a good update** *(agent)*. An update is only undone when
  Termdeck is reachable and the new version still cannot connect.

## 0.1.148x · 2026-10-26

- **Answer the questions Codex asks while it keeps working** *(agent)*. Codex now asks most of its
  questions without stopping. Each one appears in the chat as a **Codex asked** card: pick a
  choice or type an answer, and it goes into the running turn, or starts a new one if Codex has
  finished. You get a push and a bell alert for it as a question.
- **Codex questions read back as questions.** Reading a chat back, a question Codex asked shows
  the choices and the one you picked, or "not answered", instead of raw JSON.
- **A Codex question on your phone is a question**, not an approval: it notifies under Questions
  and plans, without Approve/Deny buttons.

## 0.1.147x · 2026-10-24

- **A Free plan.** Connect one machine with no card: one session at a time and 30 browser turns
  a month. A cancelled plan moves to Free and keeps your machines, chats and rules.
- **Settings, rebuilt.** One page with a searchable rail, in four groups: Preferences, Workspace,
  Account and Data. New pages:
  - **Profile**: your name and a year of activity as a heatmap, with streaks.
  - **Security & login**: change your password, see every browser signed in and sign any of
    them out.
  - **Billing**: your plan, payments and promo codes. A cancelled plan can be resumed.
  - **Keyboard shortcuts**: every key the app answers to.
  - **Machines**: a list, with a page of its own for each machine.
  - **Usage** and **Archived chats** now live in Settings too.
- **Notifications per event**: choose the in-app toast and sound separately for each kind of
  event, as push already allowed.
- **A short connection blip no longer fails a background shell's turn.** The turn picks up where
  it was instead of showing a false FAILED toast.
- **Terminals keep their chats on a reconnect** instead of blanking every pane to "Loading…".

## 0.1.145x · 2026-10-23

- **Stop all no longer leaves a chat stuck on "running"**: after stopping a background shell, the
  next message runs instead of waiting in the queue.
- **The file explorer opens cleanly on the first chat in a new folder** *(agent)*, instead of
  briefly showing a request error.

## 0.1.137x · 2026-10-12/22

- **`npx termdeck-agent`.** Install, check, repair or remove the agent with npm, the same way on
  macOS, Linux and Windows. It runs the same installer as the one-liners.
- **Live command output on Claude Code** *(agent)*: a running command's output shows under its row
  while it runs, now on Windows too.
- **New chats open at once**, and live turns and setting changes send fewer requests.

## 0.1.131x to 0.1.136x · 2026-10-08/11

- **Extensions in Settings** *(agent)*: list, health-check and switch MCP servers, plugins and
  skills on each machine, for Claude Code, Codex and Grok.
- **Hooks show in the chat**, each as one row saying what the hook said.
- **Codex sub-agents ask in their own chat and show live**, like Claude's. Running sub-agents and
  background shells sit in the composer tray.
- **A chat's runaway child can no longer take the agent down** *(agent)*: an OOM kill stops the
  child, not every running chat.
- **A Mac stays awake while a chat runs on it** *(agent)*.
- **Projects, pins, renames and archives reach every open tab live**, and every chat in an added
  folder is reachable however long the list gets.
- **Grok installs and detects xAI's own Grok CLI.**
- **Terminals open on the last few messages** and page back as you scroll; reads, searches and
  shell calls fold to one line.
- **Clear all** in the notifications panel.

## 0.1.116x to 0.1.130x · 2026-10-01/07

- **Install a missing Claude Code, Codex or Grok CLI from the machine card** *(agent)*.
- **A running command's output streams under its row** *(agent)*, and a pane's tray lists the
  chat's background shells with a stop on each.
- **Codex: approve commands like this one for the rest of the turn**, and `/compact` runs the
  app-server's own compaction with a live bar.
- **Code blocks name their language and are coloured in it**; an `@path` in a prompt is a chip
  that opens the file.
- **A plan remembers the mode it was approved into** *(agent)*.

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
