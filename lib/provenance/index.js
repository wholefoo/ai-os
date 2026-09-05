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

// ---- The keyring: every key this instance has ever signed with ----------------------------------
// <keyDir>/keyring.json — [{ kid, fingerprint, public_key_pem, created_at, status, retired_at,
// revoked_at, reason }]. Public halves only. It is the record that makes three things possible
// which the bare key file could not (SOC 2 gap item 20):
//   ROTATION    a sidecar signed under a retired key still verifies, because its public half is here;
//   REVOCATION  a compromised key's signatures can be marked untrusted without touching the files;
//   LOSS        an instance that HAD a key and now has none is told so, instead of silently minting a
//               new identity that nothing already published will verify against.
const KEYRING = 'keyring.json';
const PRIV = 'ed25519-priv.pem';

function fingerprintOf(publicKey) {
  return crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url').slice(0, 16);
}
function loadKeyring(keyDir) {
  try { const r = JSON.parse(fs.readFileSync(path.join(keyDir, KEYRING), 'utf8')); return Array.isArray(r) ? r : []; } catch { return []; }
}
function saveKeyring(keyDir, ring) {
  fs.mkdirSync(keyDir, { recursive: true });
  const tmp = path.join(keyDir, KEYRING + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(ring, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, path.join(keyDir, KEYRING));
}
/** Record a public key as the active one (idempotent by fingerprint). Returns the ring. */
function registerActive(keyDir, publicKey, kid, now = new Date()) {
  const ring = loadKeyring(keyDir);
  const fp = fingerprintOf(publicKey);
  if (!ring.some((k) => k.fingerprint === fp)) {
    ring.push({ kid, fingerprint: fp, public_key_pem: getPublicKeyPem(publicKey), created_at: now.toISOString(), status: 'active', retired_at: null, revoked_at: null, reason: null });
    saveKeyring(keyDir, ring);
  }
  return ring;
}
/** The keyring entry for a kid (matched on the fingerprint fragment, so origin changes do not orphan it). */
function keyringEntry(ring, kid) {
  const fp = String(kid || '').split('#').pop().replace(/^urn:aios:provenance:/, '');
  return (ring || []).find((k) => k.fingerprint === fp) || null;
}

// Lazy-load or generate the server-wide Ed25519 keypair. Private key source, in order:
//   1. env AIOS_PROVENANCE_PRIVATE_KEY (PKCS8 PEM) — for prod / multi-instance secret management;
//   2. on-disk <keyDir>/ed25519-priv.pem (0600), generated ONCE on a fresh instance (auto-bootstrap).
// The public key is ALWAYS derived from the private key — never stored as the source of truth.
//
// NO SILENT REGENERATION. If the keyring says this instance has signed with a key before and the
// private key is now gone (file deleted, volume not restored, env var unset after a move), this
// returns { missing: true } and NO key. The caller must run without signing until the operator
// restores the key from backup (.magent/ is in deploy/backup.sh) or rotates explicitly — a new
// key minted here would sign new sites under an identity that nothing already published matches,
// and the failure would look exactly like success.
function ensureKeypair(keyDir, opts = {}) {
  let privateKey, generated = false;
  const env = process.env.AIOS_PROVENANCE_PRIVATE_KEY;
  const ring = loadKeyring(keyDir);
  if (env && env.trim()) {
    privateKey = crypto.createPrivateKey(env.trim());
  } else {
    const file = path.join(keyDir, PRIV);
    if (fs.existsSync(file)) {
      privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
    } else if (ring.some((k) => k.status === 'active') && !opts.allowRegenerate) {
      const active = ring.filter((k) => k.status === 'active').map((k) => k.kid);
      return { privateKey: null, publicKey: null, generated: false, missing: true, expectedKids: active };
    } else {
      const kp = crypto.generateKeyPairSync('ed25519');
      fs.mkdirSync(keyDir, { recursive: true });
      fs.writeFileSync(file, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      privateKey = kp.privateKey;
      generated = true;
    }
  }
  return { privateKey, publicKey: crypto.createPublicKey(privateKey), generated, missing: false, source: env && env.trim() ? 'env' : 'file' };
}

/**
 * Rotate: mint a new keypair, make it the active one, retire (or revoke) the current one. The old
 * PRIVATE key is destroyed — verification only ever needs the public half, which the keyring keeps —
 * so a rotation also ends any exposure the old key had. Refused when the key is env-managed: the
 * new private key could not be installed from here, and the next restart would resurrect the old.
 */
function rotateKeypair(keyDir, { issuerOrigin, reason, revokeCurrent = false, now = new Date() } = {}) {
  if (process.env.AIOS_PROVENANCE_PRIVATE_KEY && process.env.AIOS_PROVENANCE_PRIVATE_KEY.trim()) {
    return { ok: false, error: 'the signing key is env-managed (AIOS_PROVENANCE_PRIVATE_KEY): rotate it in your secret manager and restart; the new key registers itself on boot' };
  }
  const ring = loadKeyring(keyDir);
  const kp = crypto.generateKeyPairSync('ed25519');
  const file = path.join(keyDir, PRIV);
  const tmp = file + '.tmp';
  fs.mkdirSync(keyDir, { recursive: true });
  fs.writeFileSync(tmp, kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.renameSync(tmp, file); // atomic replace: the old private key is gone the moment the new one is in place
  for (const k of ring) {
    if (k.status === 'active') {
      k.status = revokeCurrent ? 'revoked' : 'retired';
      k[revokeCurrent ? 'revoked_at' : 'retired_at'] = now.toISOString();
      k.reason = reason || null;
    }
  }
  const publicKey = crypto.createPublicKey(kp.privateKey);
  const kid = getPublicKeyId(publicKey, issuerOrigin);
  ring.push({ kid, fingerprint: fingerprintOf(publicKey), public_key_pem: getPublicKeyPem(publicKey), created_at: now.toISOString(), status: 'active', retired_at: null, revoked_at: null, reason: null });
  saveKeyring(keyDir, ring);
  return { ok: true, privateKey: kp.privateKey, publicKey, kid, ring };
}

/** Revoke a non-active key by kid (the active key is revoked by rotating with revokeCurrent). */
function revokeKey(keyDir, kid, { reason, now = new Date() } = {}) {
  const ring = loadKeyring(keyDir);
  const k = keyringEntry(ring, kid);
  if (!k) return { ok: false, error: 'unknown key id' };
  if (k.status === 'active') return { ok: false, error: 'the active key is revoked by rotating with revokeCurrent: true' };
  if (k.status === 'revoked') return { ok: false, error: 'already revoked', revoked_at: k.revoked_at };
  k.status = 'revoked'; k.revoked_at = now.toISOString(); k.reason = reason || k.reason || null;
  saveKeyring(keyDir, ring);
  return { ok: true, key: k };
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

/**
 * Verify against the KEYRING, not just the current key: a sidecar signed under a retired key is
 * still a valid signature from this instance (status 'retired'); one signed under a revoked key
 * verifies cryptographically but is NOT trusted (status 'revoked'); an unknown kid is untrusted.
 * Returns { signature_valid, key_status, key_trusted, reasons }.
 */
function verifyWithKeyring(sidecar, ring) {
  const kid = sidecar && sidecar.signature && sidecar.signature.public_key_id;
  const entry = keyringEntry(ring, kid);
  if (!entry) return { signature_valid: false, key_status: 'unknown', key_trusted: false, reasons: ['key id is not in this instance\'s keyring'] };
  const v = verify(sidecar, crypto.createPublicKey(entry.public_key_pem));
  const trusted = v.ok && entry.status !== 'revoked';
  const reasons = [...v.reasons];
  if (v.ok && entry.status === 'revoked') reasons.push(`signed under a REVOKED key (${entry.revoked_at}${entry.reason ? ': ' + entry.reason : ''})`);
  if (v.ok && entry.status === 'retired') reasons.push(`signed under a retired key (rotated ${entry.retired_at}); still valid`);
  return { signature_valid: v.ok, key_status: entry.status, key_trusted: trusted, reasons };
}

module.exports = { sha256Hex, ensureKeypair, getPublicKeyPem, getPublicKeyId, sign, verify, loadKeyring, registerActive, keyringEntry, rotateKeypair, revokeKey, verifyWithKeyring };
