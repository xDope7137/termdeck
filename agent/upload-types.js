'use strict';

// What may be uploaded from a browser to a machine, and what each CLI can do
// with it once it lands.
//
// The rule this file exists to hold: TERMDECK DOES NOT READ AN UPLOAD. The bytes
// go to the machine's own staging dir and the engine is handed the PATH, so
// whatever the file turns out to be is the CLI's business and not ours. That is
// why the gate below is an extension allowlist and a byte cap rather than a
// sniff of the content: sniffing would mean opening the file, and the one thing
// this path promises is that nothing opens it between the file picker and the
// engine.
//
// It replaced an inliner. HTML and CSS attachments used to be read in the
// browser and pasted into the prompt inside a fence (lib/attachments.js), which
// is why the old list was two file types long: every new type meant a new way of
// rendering someone's file into text, and a 1 MB cap because the text went into
// the context window whether the model wanted it or not. A path costs ~60 tokens
// and the engine decides whether to spend the rest.
//
// One copy, three readers: the master validates with it before it forwards a
// byte, the agent validates with it again before it writes one (it ships in
// AGENT_FILES), and the SPA draws its file picker from public/js/logic/
// upload-types.js, which scripts/build-shared.mjs generates from this file
// (`npm run pages`). So this source must stay pure: no require(), no node
// globals. One list is the point: a picker that disagreed with the agent would
// offer a file type the machine then refuses, which reads to the user as a
// broken upload rather than an unsupported one.

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------
// Grouped by what the ENGINE does with the bytes, not by MIME family, because
// that is the only distinction any caller here acts on. `text` is the long tail:
// anything a CLI can open and read as characters, which is the same set its own
// Read/view tools already handle.
//
// Not on the list, deliberately: archives (.zip, .tar.gz) because no engine
// reads one natively, so shipping one means the model shelling out to unpack it
// behind an approval; executables and scripts (.exe, .dll, .so, .sh, .bat,
// .ps1) because the agent writing one to disk is a bigger favour to a
// compromised master than any of them is to a user. Both stay off until someone
// names the case that needs them.
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const PDF_EXTS = ['.pdf'];
const NOTEBOOK_EXTS = ['.ipynb'];
const TEXT_EXTS = [
  // prose and data
  '.md', '.markdown', '.txt', '.rst', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.svg', '.log',
  '.diff', '.patch',
  // web
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  // source
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.scala',
  '.cs', '.c', '.h', '.cc', '.cpp', '.hpp', '.m', '.mm', '.lua', '.pl', '.r',
  '.sql', '.graphql', '.gql', '.proto', '.tf',
];

// kind -> the extensions that mean it. Frozen because three modules read it and
// none of them owns it.
const KINDS = Object.freeze({
  image: Object.freeze(IMAGE_EXTS),
  pdf: Object.freeze(PDF_EXTS),
  notebook: Object.freeze(NOTEBOOK_EXTS),
  text: Object.freeze(TEXT_EXTS),
});

// ---------------------------------------------------------------------------
// What each engine can actually do with each kind
// ---------------------------------------------------------------------------
// Measured against the shipped CLIs, not assumed:
//
//   claude   Read handles images, .pdf (page ranges, 20 pages a request) and
//            .ipynb (cells with outputs) as first-class types, plus any text
//            file. Verified in the 2.1.270 binary's own tool description.
//   codex    Its app-server takes `localImage {path}` and `mention {name,path}`
//            input items (codex app-server generate-json-schema), so an image or
//            a file path is a native input. It has no PDF reader, so a .pdf is
//            a path to bytes it would read as mojibake: refused here rather
//            than sent to be misread.
//   grok     promptCapabilities.image is false at initialize (lib/grok-settings.js
//            says so where it drops them), so no image and no PDF. Text files it
//            can open like any other file on the box, which is why Grok has
//            attachments at all now: before this it had none.
//
// A kind missing from an engine's row is refused with a sentence naming the
// engine, because "unsupported" on its own reads as a bug.
const ENGINE_KINDS = Object.freeze({
  claude: Object.freeze(['image', 'pdf', 'notebook', 'text']),
  codex: Object.freeze(['image', 'notebook', 'text']),
  grok: Object.freeze(['notebook', 'text']),
});

// How the bytes reach the engine:
//
//   'inline'  base64 in the turn payload itself. Only images, and only where the
//             engine takes an image content block. It is a straight upgrade on a
//             path for vision (the model sees the picture without spending a
//             tool call on it) and it writes nothing to the user's disk, so it
//             stays exactly as it was before uploads existed.
//   'path'    written to the staging dir, named in the prompt. The file is never
//             opened by Termdeck on either side of the tunnel.
const DELIVERY = Object.freeze({
  claude: Object.freeze({ image: 'inline', pdf: 'path', notebook: 'path', text: 'path' }),
  codex: Object.freeze({ image: 'inline', notebook: 'path', text: 'path' }),
  grok: Object.freeze({ notebook: 'path', text: 'path' }),
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
// The inline ceiling is the Anthropic per-image base64 limit and predates this
// file (public/js/logic/image-attach.js). The staged ceiling is a transport
// number: a staged file crosses the tunnel base64'd inside one JSON frame,
// because agent.js parses JSON and only JSON on receive, so 10 MB of file is
// ~13.4 MB on the wire against relay.js's 32 MB frame cap. Raising it past ~20
// MB means teaching the agent to decode a binary frame first.
const INLINE_MAX_BYTES = 5 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
// Per message. Ten staged paths is already a prompt that reads like a directory
// listing; the cap is here so a dropped folder fails as a sentence rather than
// as twenty tunnel round-trips.
const UPLOAD_MAX_FILES = 10;
// Under ~/.termdeck (TERMDECK_HOME), never inside the user's project: an upload
// that landed in the repo would show up in git status, in a diff the engine
// reads back, and in whatever the user pushes next.
const UPLOAD_DIR = 'uploads';
// A staging bucket nobody has touched for this long is deleted on the next
// upload to that machine. Uploads are inputs to a turn, not a filing cabinet.
const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function extOf(name) {
  const base = String(name || '').toLowerCase();
  const at = base.lastIndexOf('.');
  return at > 0 ? base.slice(at) : '';
}

/** 'image' | 'pdf' | 'notebook' | 'text', or null for anything not on the list. */
function kindFor(name) {
  const ext = extOf(name);
  if (!ext) return null;
  for (const [kind, exts] of Object.entries(KINDS)) if (exts.includes(ext)) return kind;
  return null;
}

/** 'inline' | 'path' | null, where null means this engine cannot take the file at all. */
function deliveryFor(engine, name) {
  const kind = kindFor(name);
  if (!kind) return null;
  const table = DELIVERY[engine];
  return (table && table[kind]) || null;
}

function supports(engine, name) {
  return deliveryFor(engine, name) != null;
}

/** The byte ceiling for this file on this engine. 0 when it cannot be sent at all. */
function maxBytesFor(engine, name) {
  const delivery = deliveryFor(engine, name);
  if (!delivery) return 0;
  return delivery === 'inline' ? INLINE_MAX_BYTES : UPLOAD_MAX_BYTES;
}

/** Every extension this engine accepts, for an <input accept> or a doc table. */
function extsFor(engine) {
  const kinds = ENGINE_KINDS[engine] || [];
  return kinds.flatMap((kind) => KINDS[kind] || []);
}

function acceptFor(engine) {
  return extsFor(engine).join(',');
}

/** One line of UI copy naming what this engine takes. */
function helpFor(engine) {
  const kinds = new Set(ENGINE_KINDS[engine] || []);
  const parts = [];
  if (kinds.has('image')) parts.push('PNG/JPEG/GIF/WebP images');
  if (kinds.has('pdf')) parts.push('PDFs');
  if (kinds.has('notebook')) parts.push('notebooks');
  if (kinds.has('text')) parts.push('text, data and source files');
  if (!parts.length) return 'no attachments';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// The name the file gets on the machine. Everything that could make it point
// somewhere else is removed rather than escaped: separators, drive letters,
// control characters, the two directory names, and a leading dot (a dotfile in
// the staging dir is a file the user cannot see when they go looking).
//
// Returns '' for a name with nothing usable left, and the caller refuses. This
// runs on the master AND on the agent, on the same string, for the same reason
// validateRelPath does in lib/project-files.js: the second run is the one that
// matters, because it is the only one the user's own machine performs.
function safeUploadName(name) {
  let base = String(name || '').replace(/\\/g, '/');
  base = base.slice(base.lastIndexOf('/') + 1);
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\x00-\x1f\x7f]/g, '').replace(/^[.\s]+/, '').trim();
  base = base.replace(/[:*?"<>|]/g, '_');
  if (!base || base === '.' || base === '..') return '';
  if (base.length <= 120) return base;
  // Keep the extension: it is what every consumer of this file dispatches on.
  const ext = extOf(base);
  return base.slice(0, 120 - ext.length) + ext;
}

// The staging bucket a machine writes into. A session id where there is one, a
// minted id where there is not (the New chat page has no session until its first
// turn lands). Validated the same way on both sides; anything else is refused
// rather than coerced, so the bucket can never climb out of the uploads dir.
const BUCKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validBucket(bucket) {
  return typeof bucket === 'string' && BUCKET_RE.test(bucket) && !bucket.includes('..');
}

module.exports = {
  KINDS,
  ENGINE_KINDS,
  DELIVERY,
  INLINE_MAX_BYTES,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_DIR,
  UPLOAD_TTL_MS,
  BUCKET_RE,
  extOf,
  kindFor,
  deliveryFor,
  supports,
  maxBytesFor,
  extsFor,
  acceptFor,
  helpFor,
  safeUploadName,
  validBucket,
};
