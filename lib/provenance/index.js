// lib/provenance/index.js
// ============================================================
//  Content-provenance signing for AI-generated output. Pure Node built-in crypto (Ed25519) —
//  NO native deps (the project deliberately avoids them; see lib/crm/db.js).
//
//  This produces a C2PA-VOCABULARY-ALIGNED, Ed25519-signed JSON provenance credential (a
//  "sidecar"). It is intentionally NOT an embedded C2PA manifest — a real C2PA manifest is a
//  COSE_Sign1/CBOR/JUMBF structure carrying an X.509 cert chain on a recognized trust list, which
//  requires the c2pa Rust lib + PKI this project does not take on. So we REUSE C2PA + IPTC
//  vocabulary (digitalSourceType URIs, c2pa.actions / cawg.training-mining labels) for
//  forward-compatibility and machine meaning, but the artifact is Ed25519-signed JSON, verifiable
//  by AI OS's own verifier — not by generic Content Credentials tools. Trust rests on
//  key-to-domain binding (public key published at /.well-known), NOT a CA trust list.
// ============================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Deterministic, RFC-8785-style canonical JSON: recursively sorted object keys, no insignificant
// whitespace. The SINGLE serializer both sign() and verify() use, so the exact signed bytes are
// reproducible. Our payloads are strings / ints / enums only (hashes, ISO timestamps) — no floats —
// so JSON.stringify's number formatting is not a concern here.
function canonStr(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonStr).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonStr(v[k])).join(',') + '}';
}
function canonicalize(value) {
  return Buffer.from(canonStr(value), 'utf8');
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Lazy-load or generate the server-wide Ed25519 keypair. Private key source, in order:
//   1. env AIOS_PROVENANCE_PRIVATE_KEY (PKCS8 PEM) — for prod / multi-instance secret management;
//   2. on-disk <keyDir>/ed25519-priv.pem (0600), generated once if missing (auto-bootstrap).
// The public key is ALWAYS derived from the private key — never stored as the source of truth.
function ensureKeypair(keyDir) {
  let privateKey, generated = false;
  const env = process.env.AIOS_PROVENANCE_PRIVATE_KEY;
  if (env && env.trim()) {
    privateKey = crypto.createPrivateKey(env.trim());
  } else {
    const file = path.join(keyDir, 'ed25519-priv.pem');
    if (fs.existsSync(file)) {
      privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
    } else {
      const kp = crypto.generateKeyPairSync('ed25519');
      fs.mkdirSync(keyDir, { recursive: true });
      fs.writeFileSync(file, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      privateKey = kp.privateKey;
      generated = true;
    }
  }
  return { privateKey, publicKey: crypto.createPublicKey(privateKey), generated };
}

function getPublicKeyPem(publicKey) {
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

// Stable key id bound to the issuing origin: "<origin>/.well-known/provenance-keys.json#<fp>",
// or a "urn:aios:provenance:<fp>" when no public origin is configured.
function getPublicKeyId(publicKey, issuerOrigin) {
  const fp = crypto.createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64url').slice(0, 16);
  const origin = String(issuerOrigin || '').replace(/\/+$/, '');
  return origin ? `${origin}/.well-known/provenance-keys.json#${fp}` : `urn:aios:provenance:${fp}`;
}

// Sign an unsigned sidecar payload -> a new object with an appended `signature` block. The signed
// bytes are canonicalize(payload) (everything EXCEPT the signature block).
function sign(payload, privateKey, opts = {}) {
  const signature = crypto.sign(null, canonicalize(payload), privateKey).toString('base64'); // Ed25519 ⇒ alg null
  return { ...payload, signature: { alg: 'Ed25519', public_key_id: opts.publicKeyId || null, signature, signed_at: new Date().toISOString() } };
}

// Verify a signed sidecar's Ed25519 signature against a public key. Signature-only — callers add
// content-hash + key-trust checks. Returns { ok, reasons[] }.
function verify(sidecar, publicKey) {
  const reasons = [];
  if (!sidecar || typeof sidecar !== 'object') return { ok: false, reasons: ['not an object'] };
  const sig = sidecar.signature;
  if (!sig || !sig.signature) return { ok: false, reasons: ['no signature block'] };
  if (sig.alg !== 'Ed25519') reasons.push(`unexpected alg: ${sig.alg}`);
  const { signature, ...payload } = sidecar; // eslint-disable-line no-unused-vars
  let ok = false;
  try { ok = crypto.verify(null, canonicalize(payload), publicKey, Buffer.from(sig.signature, 'base64')); }
  catch (e) { reasons.push(`verify error: ${e.message}`); }
  if (!ok && !reasons.length) reasons.push('signature does not match');
  return { ok: !!ok, reasons };
}

module.exports = { sha256Hex, ensureKeypair, getPublicKeyPem, getPublicKeyId, sign, verify };
