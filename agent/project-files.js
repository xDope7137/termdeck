'use strict';

// Read-only browsing of a session's PROJECT folder — the customer's own checkout,
// which is deliberately outside the transcript roots every other read is confined
// to. So this module is the confinement, and it is written to be the whole of it.
//
// The posture is `restore`'s (agent/capabilities.js documents the original): the
// master names a CONFINED transcript and a RELATIVE path, never a cwd, never an
// absolute target, never bytes. The agent resolves the project root off the
// transcript's own head, realpaths it once, and every read below happens against
// the RESOLVED path — never the request string, which is the TOCTOU rule
// restore/mutate already model.
//
// Three separate gates, in this order, because each one is only sound if the
// previous already held:
//
//   1. validateRelPath — a pure string test that runs BEFORE any fs call. Length
//      is checked before anything is allocated: an uncaught throw in the agent
//      kills every live chat on the box, so this path never gets to be clever.
//   2. resolveTarget   — realpath + prefix containment, fail-closed. Symlinks are
//      resolved rather than rejected: one resolving back inside the root is a
//      legitimate part of the checkout, one resolving outside is refused by
//      construction, and neither case needs a rule of its own.
//   3. isHiddenOrSecret — dotfiles and secret-shaped names are dropped from
//      listings AND refused on read unless the project's owner has opted in, or
//      the read resolves to an IMAGE (see imageTypeFor, and the gate itself in
//      agent/capabilities.js). This is policy, not confinement; the two above
//      hold whatever it says.
//
// Every cap here is enforced on THIS side and never read from the request — a
// listing cap the caller could raise is not a cap.
//
// Shipped to agents by name (AGENT_FILES in master.js), so this module may only
// require SIBLINGS in lib/ — an installed agent has a flat directory. It requires
// none: node builtins only.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

// A path long enough to be worth truncating is not a path anyone typed. Checked
// first, on the raw string, before a split allocates anything from it.
const MAX_REL_LEN = 1024;
// Deep enough for any real checkout; shallow enough that a hostile request can't
// turn one call into thousands of segment comparisons.
const MAX_SEGMENTS = 32;
// One directory level per call (the tree expands on click), so this bounds ONE
// folder — not a walk. A node_modules with 3,000 entries reports 500 + truncated.
const MAX_ENTRIES = 500;
// Enough to read a source file; small enough that a 40 MB log doesn't cross the
// tunnel because someone tapped it.
const MAX_TEXT_BYTES = 256 * 1024;
// Images ride as base64 in a JSON frame, so the wire cost is ~4/3 of this: 5 MB
// of PNG is ~6.7 MB on the wire, well inside relay.js's 32 MB MAX_FRAME_BYTES.
// The number is the same ceiling chat attachments use (lib/cloud/feedback.js,
// composer.js), so one limit governs every image in the product rather than a
// screenshot being viewable in one panel and refused in the other.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// A NUL in the first few KB is the binary sniff. Text files that are genuinely
// UTF-16 will read as binary; that is the safe direction to be wrong in.
const SNIFF_BYTES = 8 * 1024;

// Rendered as <img> from a data: URI. SVG is deliberately NOT here — it is a
// scriptable document, and an <img> is only the safe half of that. It falls
// through to the text branch and renders as source, which is also what you want
// when you open one from a file tree.
const IMAGE_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
]);

// The media type this path would be READ as, or null for everything else. One
// lookup, exported, because two decisions are made from it and they must agree:
// readFileCapped below turns it into an <img>, and the hidden-file policy in
// agent/capabilities.js uses it to decide whether that policy applies at all.
// Always called on a RESOLVED path — a symlink named `shot.png` is whatever it
// points at, and this must answer for the file, not for the name.
const imageTypeFor = (p) => IMAGE_TYPES.get(path.extname(String(p || '')).toLowerCase()) || null;

// Secret-SHAPED, not secret-proven: the point is that a file tree opened on a
// phone must not casually surface a private key, so the test is the name. Paired
// with the dot-leading rule below it this covers .env/.git/.aws/.ssh and the key
// material that lives loose in a repo. Both are overridable per project — see
// the `includeHidden` note in agent/capabilities.js.
const SECRET_EXTS = new Set(['.pem', '.key', '.p12', '.pfx']);
const SECRET_NAMES = new Set(['.netrc']);
const SECRET_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa'];

// Credential stores under the user's home. Unlike the secret-SHAPED names above
// these are refused whatever `includeHidden` says: that switch is the owner's
// choice to see a project's dotfiles, and it travels from the master, so it
// cannot also be what stands between a request and ~/.ssh. A chat whose folder
// is home itself is real (people run a CLI in ~), which is exactly when these
// would otherwise be one click, or one forged frame, away.
// Relative to home, '/'-separated, matched as a path prefix.
const HOME_CREDENTIAL_PATHS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.azure', '.docker', '.netrc', '.git-credentials',
  '.pypirc', '.npmrc', '.grok', '.config/gcloud', '.config/gh', '.local/share/keyrings',
  '.claude/.credentials.json', '.claude.json', '.codex/auth.json', '.codex/config.toml',
  '.claude/settings.json', '.claude/settings.local.json',
  // The agent's own state: agent.env is the machine token, and the account vaults
  // hold every saved login. Uploads are the one part a chat legitimately names.
  '.termdeck',
];
const HOME_CREDENTIAL_ALLOW = ['.termdeck/uploads'];
let realHome = null;
function homeDir() {
  if (realHome) return realHome;
  try { realHome = fs.realpathSync(os.homedir()); } catch { realHome = path.resolve(os.homedir()); }
  return realHome;
}
const underRel = (rel, p) => rel === p || rel.startsWith(`${p}/`);
// Is this RESOLVED absolute path a credential store, or inside one?
function isCredentialStore(abs, { home = homeDir(), caseInsensitive = process.platform === 'win32' } = {}) {
  const a = caseInsensitive ? String(abs).toLowerCase() : String(abs);
  const h = caseInsensitive ? home.toLowerCase() : home;
  if (!a.startsWith(h + path.sep)) return false;
  const rel = a.slice(h.length + 1).split(path.sep).join('/');
  if (HOME_CREDENTIAL_ALLOW.some((p) => underRel(rel, p))) return false;
  return HOME_CREDENTIAL_PATHS.some((p) => underRel(rel, caseInsensitive ? p.toLowerCase() : p));
}

const badPath = (error) => ({ error, code: 'BAD_PATH' });

// The whole string test, in one place, run on BOTH sides (the master re-validates
// as defense in depth — an agent is the only thing that touches disk, but a
// request that could never be served should not reach it).
//
// Returns { segments } for a path that may be resolved, or { error, code }.
// An empty path is the project root itself, which is the listing the dock opens on.
function validateRelPath(relPath) {
  if (relPath == null || relPath === '') return { segments: [] };
  if (typeof relPath !== 'string') return badPath('path must be a string');
  // Before anything is allocated from it.
  if (relPath.length > MAX_REL_LEN) return badPath('path too long');
  // NUL truncates a C string, and control characters have no business in a name
  // we are about to echo back into a browser.
  if (/[\u0000-\u001f\u007f]/.test(relPath)) return badPath('path contains control characters');
  // Absolute in ANY form the two platforms recognise: posix root, Windows root,
  // drive-relative (`C:foo` is a real and surprising Windows path), and UNC.
  if (relPath[0] === '/' || relPath[0] === '\\') return badPath('path must be relative');
  if (/^[a-zA-Z]:/.test(relPath)) return badPath('path must be relative');

  // Split on BOTH separators whichever box this runs on: a Windows agent must
  // still reject `a/../b`, and a Linux agent must still reject `a\..\b` rather
  // than treating it as one oddly-named segment.
  const segments = relPath.split(/[/\\]/);
  if (segments.length > MAX_SEGMENTS) return badPath('path too deep');
  for (const seg of segments) {
    if (seg === '') return badPath('path has an empty segment');
    if (seg === '.' || seg === '..') return badPath('path may not traverse');
  }
  return { segments };
}

// Is this ONE name hidden or secret-shaped? Per-segment on purpose: a listing
// checks each child's own name, and a read checks every segment of the path it
// was given, so `.git/config` is refused by its first segment and never by a
// rule about the last one.
function isHiddenOrSecret(segment) {
  const name = String(segment || '');
  if (name.startsWith('.')) return true; // .env, .git, .aws, .ssh, .netrc, …
  const lower = name.toLowerCase();
  if (SECRET_NAMES.has(lower)) return true;
  if (SECRET_EXTS.has(path.extname(lower))) return true;
  return SECRET_PREFIXES.some((p) => lower.startsWith(p));
}

const hiddenSegment = (segments) => (segments || []).find((s) => isHiddenOrSecret(s)) || null;

// Windows paths are case-insensitive, and the browser can hand back a name in
// whatever case it rendered. A case-SENSITIVE comparison there is wrong in both
// directions: `C:\Proj\src` under root `C:\proj` would compare as outside (a
// spurious refusal), and once anything anywhere lowercases one side but not the
// other the same slack becomes a bypass. So the comparison follows the platform,
// and the caller says which — the master runs this against paths from a machine
// that may not be its own.
function contained(target, root, caseInsensitive) {
  const t = caseInsensitive ? target.toLowerCase() : target;
  const r = caseInsensitive ? root.toLowerCase() : root;
  return t === r || t.startsWith(r + path.sep);
}

// realpath + containment. `root` must ALREADY be a realpath (the caller resolves
// it once, off the transcript's own cwd) — comparing a resolved target against an
// unresolved root is how a symlinked project dir refuses its own files.
//
// Fail-closed on every error, including ENOENT: "does not exist" and "exists
// somewhere I may not look" are answered the same way for a path that never
// resolved, because we cannot tell them apart without looking.
async function resolveTarget(root, segments, { caseInsensitive = process.platform === 'win32' } = {}) {
  const requested = segments.length ? path.join(root, ...segments) : root;
  let target;
  try {
    target = await fsp.realpath(requested);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { error: 'File not found', code: 'NOT_FOUND' };
    return { error: 'path not permitted', code: 'OUT_OF_ROOT' };
  }
  // The prefix test needs the separator, or root `/tmp/proj` would contain
  // `/tmp/proj-evil`. `root + sep` is exactly what stops that.
  if (!contained(target, root, caseInsensitive)) return { error: 'path not permitted', code: 'OUT_OF_ROOT' };
  if (isCredentialStore(target, { caseInsensitive })) return { error: 'path not permitted', code: 'SECRET_BLOCKED' };
  return { target };
}

// ONE level of one directory. Expand-on-click, never a tree walk: a recursive
// listing of a real checkout is a node_modules-shaped denial of service against
// the customer's own uplink, and the panel only ever renders what is open.
async function listDir(root, target, { includeHidden = false, caseInsensitive = process.platform === 'win32' } = {}) {
  const ents = await fsp.readdir(target, { withFileTypes: true });
  const entries = [];
  let truncated = false;
  for (const e of ents) {
    if (!includeHidden && isHiddenOrSecret(e.name)) continue;
    if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
    const full = path.join(target, e.name);
    const symlink = e.isSymbolicLink();
    // A symlink is followed to classify it, so one pointing out of the root would
    // otherwise report an outside file's size and mtime. Reading it is already
    // refused (resolveTarget runs again on the click), but a listing that names
    // it has still answered a question about a file we may not look at.
    if (symlink) {
      let real;
      try { real = await fsp.realpath(full); } catch { continue; }
      if (!contained(real, root, caseInsensitive)) continue;
    }
    if (isCredentialStore(full, { caseInsensitive })) continue;
    let st;
    try { st = await fsp.stat(full); } catch { continue; } // broken link, race, EPERM — not classifiable, not listed
    const type = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
    if (!type) continue; // sockets, fifos, devices: nothing this panel can do with them
    entries.push({ name: e.name, type, size: type === 'file' ? st.size : 0, mtimeMs: st.mtimeMs, ...(symlink ? { symlink: true } : {}) });
  }
  // Directories first, then by name — the shape every file tree has, applied
  // here rather than in the browser so the two never disagree about a page.
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { entries, truncated };
}

// One decimal, MB only: every size this formats is within an order of magnitude
// of the cap, so a unit ladder would spend code on ranges that cannot occur.
const mb = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

// Read one file, capped, and say WHAT it is. Three shapes, because the panel
// renders three things and "we could not show this" is a real answer:
//   { kind:'text',   content, size, truncated }
//   { kind:'image',  mediaType, base64, size }
//   { kind:'binary', size }
// A file that is too big to send as an image is an error rather than a silent
// downgrade — half a PNG is not a smaller PNG.
async function readFileCapped(target) {
  let st;
  try { st = await fsp.stat(target); } catch { return { error: 'File not found', code: 'NOT_FOUND' }; }
  if (st.isDirectory()) return { error: 'That is a folder', code: 'IS_DIR' };
  if (!st.isFile()) return { error: 'Not a regular file', code: 'NOT_A_FILE' };

  const mediaType = imageTypeFor(target);
  if (mediaType) {
    // Name both numbers. "Too large" on its own leaves the reader unable to tell
    // a 6 MB screenshot from a 900 MB one, and so unable to guess whether
    // resizing it is worth trying.
    if (st.size > MAX_IMAGE_BYTES) {
      return { error: `Image is ${mb(st.size)}, over the ${mb(MAX_IMAGE_BYTES)} preview limit`, code: 'TOO_LARGE', size: st.size, limit: MAX_IMAGE_BYTES };
    }
    const buf = await readCapped(target, MAX_IMAGE_BYTES);
    return { kind: 'image', mediaType, base64: buf.toString('base64'), size: st.size };
  }

  // Read the cap, not the file: a 40 MB log costs 256 KB here, and a device node
  // that would never reach EOF costs the same. The sniff then runs over what we
  // actually hold rather than over a second read of the same bytes.
  const buf = await readCapped(target, MAX_TEXT_BYTES);
  const sniff = buf.subarray(0, SNIFF_BYTES);
  if (sniff.includes(0)) return { kind: 'binary', size: st.size };
  return { kind: 'text', content: buf.toString('utf8'), size: st.size, truncated: st.size > buf.length };
}

// Explicit length, from a file descriptor: fsp.readFile on a fifo or /dev/zero
// never returns, and "the caller asked for a file in their own project" is not
// a guarantee that it is one.
async function readCapped(target, maxBytes) {
  const fd = await fsp.open(target, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fd.close();
  }
}

module.exports = {
  validateRelPath,
  resolveTarget,
  contained, // exported for its own test: it is the comparison, and on a case-sensitive box no fs call can reach the win32 branch

  isHiddenOrSecret,
  isCredentialStore,
  hiddenSegment,
  imageTypeFor,
  listDir,
  readFileCapped,
  MAX_REL_LEN,
  MAX_SEGMENTS,
  MAX_ENTRIES,
  MAX_TEXT_BYTES,
  MAX_IMAGE_BYTES,
};
