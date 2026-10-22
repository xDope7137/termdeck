'use strict';

// Signed agent updates (security-audit.md S4). The master serves the agent's code,
// so without this a master that was broken into could push any file to every
// machine and the agent would run it. Instead every release carries
// agent/update-signature.json: the version and a sha256 per shipped file, signed
// offline with an Ed25519 key that never lives on the master. The agent installs a
// file set only when the signature checks out under the key pinned below, every
// downloaded body matches its hash, and the version is not older than its own.
//
// Signed by `node scripts/check-agent-version.mjs --write`, with the private key at
// ~/.config/termdeck/agent-signing.key (TERMDECK_AGENT_SIGNING_KEY overrides).
// Rotating the key is a release whose UPDATE_KEYS lists the new key, signed with
// the old one.
//
// Requires only node builtins: it ships flat beside agent.js.

const crypto = require('crypto');

// Base64 SPKI DER Ed25519 public keys. Any one of them may sign a release.
const UPDATE_KEYS = ['MCowBQYDK2VwAyEApKYs4C+jQpySky9LpFhWgMT86fL5rSde6qZGdO5WEEY='];

const FORMAT = 1;

const sha256 = (body) => crypto.createHash('sha256').update(body).digest('hex');

// The exact string that is signed. Names sorted, so the signature does not depend
// on the order anyone listed the files in.
function payloadFor(version, bodies) {
  const files = {};
  for (const name of Object.keys(bodies).sort()) files[name] = sha256(bodies[name]);
  return JSON.stringify({ format: FORMAT, version, files });
}

function sign(payload, privateKeyPem) {
  return { payload, sig: crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(privateKeyPem)).toString('base64') };
}

function publicKeyOf(privateKeyPem) {
  return crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'der' }).toString('base64');
}

// 1.2.10 vs 1.2.9, numerically. Anything that is not dotted digits compares as 0s.
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Throws with a sentence for the agent log, or returns { version, files } where
// files maps each name to the sha256 its body has to have.
function verifySigned(signed, { keys = UPDATE_KEYS, currentVersion = null } = {}) {
  if (!signed || typeof signed.payload !== 'string' || typeof signed.sig !== 'string') throw new Error('the update is not signed');
  const ok = keys.some((k) => {
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      return crypto.verify(null, Buffer.from(signed.payload), key, Buffer.from(signed.sig, 'base64'));
    } catch { return false; }
  });
  if (!ok) throw new Error('the update signature does not match the Termdeck release key');
  const p = JSON.parse(signed.payload);
  if (!p || p.format !== FORMAT || typeof p.version !== 'string' || !p.files || typeof p.files !== 'object') throw new Error('the signed update manifest has an unknown shape');
  if (currentVersion && compareVersions(p.version, currentVersion) < 0) throw new Error(`the signed update is ${p.version}, older than this machine's ${currentVersion}`);
  return { version: p.version, files: p.files };
}

function checkBody(files, name, body) {
  if (!Object.prototype.hasOwnProperty.call(files, name)) throw new Error(`${name}: not in the signed release`);
  if (sha256(body) !== files[name]) throw new Error(`${name}: does not match the signed release`);
}

module.exports = { UPDATE_KEYS, payloadFor, sign, publicKeyOf, verifySigned, checkBody, compareVersions, sha256 };
