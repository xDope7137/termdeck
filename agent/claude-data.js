'use strict';

// Claude Code naming rules shared by the agent and the master: how a cwd becomes a
// ~/.claude/projects/<slug> directory name, how a title is trimmed, how session rows sort.
// Dependency-free on purpose: this file ships to agent boxes (AGENT_FILES in master.js).

const TITLE_MAX_WORDS = 6;

// Sort key for a session row: "when did I last type here", falling back to file
// mtime when we couldn't recover a user-input timestamp. Shared by every list
// sort (hub + cloud) so ordering is identical everywhere.
const sortAt = (s) => (s ? s.lastUserAt || s.modifiedAt || 0 : 0);

// Of two fork siblings (same firstUserUuid), the one to keep: the branch in active
// use (newest input), larger transcript as tiebreak.
const forkWinner = (a, b) => {
  const at = sortAt(a), bt = sortAt(b);
  if (at !== bt) return at > bt ? a : b;
  return (a.sizeBytes || 0) >= (b.sizeBytes || 0) ? a : b;
};

// A folder's identity is its path with the trailing separators taken off.
// Slugging is a straight character substitution over the RAW string, so
// "/home/u/Work/Ai/" and "/home/u/Work/Ai" encode to two different slugs — one
// folder, two projects in the sidebar, each with its own name and its own chats.
// That is exactly what production had ("-home-x-work-ai-" sitting beside
// "-home-x-work-ai"), and it starts wherever a path reaches us with a trailing
// slash: a folder picker, a pasted path, a typed cwd for a new chat. Normalise
// before slugging and the two collapse into one. A root — "/", "C:\",
// "\\server\share" — is all separator and has nothing to strip.
// MUST stay byte-identical to the client's copy in public/js/worktree-fold.js.
function normalizeCwd(cwd) {
  const raw = String(cwd == null ? '' : cwd).trim();
  if (!raw) return '';
  const lead = /^[\\/]{2}(?![\\/])/.test(raw) ? raw.slice(0, 2) : ''; // UNC \\server\share
  let s = raw.slice(lead.length).replace(/([\\/])[\\/]+/g, '$1');
  while (s.length > 1 && /[\\/]$/.test(s) && !/^[A-Za-z]:[\\/]$/.test(s)) s = s.slice(0, -1);
  return lead + s;
}

// Same encoding Claude Code uses for ~/.claude/projects/ dir names
// (verified in the phase-2 spike: C:\Work\Ai\tmp\termdeck-test ->
// C--Work-Ai-tmp-termdeck-test). The CLI itself slugs process.cwd(), which is
// already normalised — so normalising here only ever changes the answer for a
// path that reached US untidy, and never breaks parity with a real dir name.
function slugForCwd(cwd) {
  return normalizeCwd(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

function cleanTitle(text) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  return words.slice(0, TITLE_MAX_WORDS).join(' ');
}

module.exports = {
  slugForCwd,
  normalizeCwd,
  cleanTitle,
  sortAt,
  forkWinner,
};
