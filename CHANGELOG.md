# Changelog

Termdeck ships continuously — 266 production deploys in the first 31 days. This is the
curated version: the changes a user would notice, newest first. Agents self-update, so
anything marked *(agent)* reaches connected machines on its own.

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
