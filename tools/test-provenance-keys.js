// Provenance key lifecycle (lib/provenance keyring) — SOC 2 gap item 20 (CC6.8, CC7.5).
//
// Before: the signing key had no record of itself. Lose the file and boot minted a new identity,
// silently, so every site already published stopped verifying and nothing said so. And
// verification trusted only the CURRENT key id, so rotation would have broken every site too.
// The keyring fixes both. Every branch runs for real against a temp directory: real keypairs,
// real files, real signatures.
const fs = require('fs'), os = require('os'), path = require('path');
const { assert, done, serverSource, readRepoFile } = require('./test-util');
const P = require('../lib/provenance');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-keys-'));
const ORIGIN = 'https://example.test';
const savedEnv = process.env.AIOS_PROVENANCE_PRIVATE_KEY; delete process.env.AIOS_PROVENANCE_PRIVATE_KEY;
try {
  // --- bootstrap on a fresh instance ---------------------------------------------------------------
  const k1 = P.ensureKeypair(dir);
  assert(k1.generated === true && !k1.missing && k1.source === 'file', 'a fresh instance generates a key once (no keyring yet → bootstrap allowed)');
  const kid1 = P.getPublicKeyId(k1.publicKey, ORIGIN);
  assert(/^https:\/\/example\.test\/\.well-known\/provenance-keys\.json#[A-Za-z0-9_-]{16}$/.test(kid1), 'kid is origin-bound with a 16-char fingerprint fragment');
  let ring = P.registerActive(dir, k1.publicKey, kid1);
  assert(ring.length === 1 && ring[0].status === 'active' && ring[0].kid === kid1 && ring[0].public_key_pem.includes('PUBLIC KEY'), 'registerActive records the public half as active');
  assert(P.registerActive(dir, k1.publicKey, kid1).length === 1, 'registerActive is idempotent by fingerprint');
  assert(!fs.readFileSync(path.join(dir, 'keyring.json'), 'utf8').includes('PRIVATE'), 'the keyring never contains a private key');
  const k1again = P.ensureKeypair(dir);
  assert(k1again.generated === false && !k1again.missing, 'a second boot loads the same file, generates nothing');

  // --- LOSS: the file is gone, the keyring remembers ------------------------------------------------------
  const sidecar1 = P.sign({ '@context': 'x', content_binding: { hash: 'abc' } }, k1.privateKey, { publicKeyId: kid1 });
  fs.unlinkSync(path.join(dir, 'ed25519-priv.pem'));
  const lost = P.ensureKeypair(dir);
  assert(lost.missing === true && lost.privateKey === null && JSON.stringify(lost.expectedKids) === JSON.stringify([kid1]), 'with an active key in the keyring and no file, ensureKeypair reports MISSING and names the expected kid');
  assert(!fs.existsSync(path.join(dir, 'ed25519-priv.pem')), '...and generates NOTHING — the regression this exists to stop');
  assert(P.ensureKeypair(dir, { allowRegenerate: true }).generated === true, 'regeneration only with an explicit opt-in');
  fs.unlinkSync(path.join(dir, 'ed25519-priv.pem'));
  // verification of what was already published does not depend on the private key
  const vLost = P.verifyWithKeyring(sidecar1, P.loadKeyring(dir));
  assert(vLost.signature_valid && vLost.key_trusted && vLost.key_status === 'active', 'a sidecar signed before the loss still verifies from the keyring alone');

  // --- ROTATION ------------------------------------------------------------------------------------------
  // (restore a key first so rotation has something to retire — simulate the operator restoring from backup)
  fs.writeFileSync(path.join(dir, 'ed25519-priv.pem'), k1.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const rot = P.rotateKeypair(dir, { issuerOrigin: ORIGIN, reason: 'scheduled' });
  assert(rot.ok && rot.kid !== kid1, 'rotate mints a new key with a new kid');
  ring = P.loadKeyring(dir);
  assert(ring.length === 2 && ring[0].status === 'retired' && ring[0].retired_at && ring[0].reason === 'scheduled' && ring[1].status === 'active' && ring[1].kid === rot.kid, 'old key retired with reason and time; new key active');
  const onDisk = P.ensureKeypair(dir);
  assert(P.getPublicKeyId(onDisk.publicKey, ORIGIN) === rot.kid, 'the private key file now holds the NEW key (old private key destroyed)');
  const v1 = P.verifyWithKeyring(sidecar1, ring);
  assert(v1.signature_valid && v1.key_trusted && v1.key_status === 'retired' && /retired key/.test(v1.reasons.join(' ')), 'a sidecar signed under the RETIRED key still verifies and is trusted, with the status named');
  const sidecar2 = P.sign({ '@context': 'x', content_binding: { hash: 'def' } }, rot.privateKey, { publicKeyId: rot.kid });
  assert(P.verifyWithKeyring(sidecar2, ring).key_status === 'active', 'a sidecar signed under the new key verifies as active');
  const tampered = { ...sidecar2, content_binding: { hash: 'zzz' } };
  assert(P.verifyWithKeyring(tampered, ring).signature_valid === false, 'tampering still fails');
  const foreign = { ...sidecar2, signature: { ...sidecar2.signature, public_key_id: 'https://other.test/.well-known/provenance-keys.json#AAAAAAAAAAAAAAAA' } };
  const vf = P.verifyWithKeyring(foreign, ring);
  assert(vf.key_status === 'unknown' && vf.key_trusted === false && vf.signature_valid === false, 'an unknown kid is untrusted and not even checked against our keys');

  // --- REVOCATION -----------------------------------------------------------------------------------------
  const rv = P.revokeKey(dir, kid1, { reason: 'laptop stolen' });
  assert(rv.ok && rv.key.status === 'revoked', 'a retired key can be revoked');
  const v1r = P.verifyWithKeyring(sidecar1, P.loadKeyring(dir));
  assert(v1r.signature_valid === true && v1r.key_trusted === false && v1r.key_status === 'revoked' && /REVOKED/.test(v1r.reasons.join(' ')) && /laptop stolen/.test(v1r.reasons.join(' ')), 'a sidecar under a REVOKED key: signature valid, NOT trusted, reason carried');
  assert(P.revokeKey(dir, kid1, {}).ok === false && /already/.test(P.revokeKey(dir, kid1, {}).error), 'revoking twice is refused');
  assert(P.revokeKey(dir, rot.kid, {}).ok === false && /rotating/.test(P.revokeKey(dir, rot.kid, {}).error), 'the ACTIVE key cannot be revoked directly — rotate with revokeCurrent');
  assert(P.revokeKey(dir, 'nope', {}).error === 'unknown key id', 'unknown kid');
  const rot2 = P.rotateKeypair(dir, { issuerOrigin: ORIGIN, reason: 'compromise', revokeCurrent: true });
  ring = P.loadKeyring(dir);
  assert(rot2.ok && ring.find((k) => k.kid === rot.kid).status === 'revoked' && ring.filter((k) => k.status === 'active').length === 1, 'rotate with revokeCurrent revokes the outgoing key; exactly one active key remains');

  // --- env-managed keys ---------------------------------------------------------------------------------------
  process.env.AIOS_PROVENANCE_PRIVATE_KEY = rot2.privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert(P.ensureKeypair(dir).source === 'env', 'env var wins over the file');
  assert(P.rotateKeypair(dir, {}).ok === false && /env-managed/.test(P.rotateKeypair(dir, {}).error), 'rotation is refused for an env-managed key (rotate in the secret manager)');
  delete process.env.AIOS_PROVENANCE_PRIVATE_KEY;

  // keyring writes are atomic (tmp + rename), so a crash mid-write cannot leave a truncated ring
  assert(!fs.existsSync(path.join(dir, 'keyring.json.tmp')), 'no temp file left behind');
} finally {
  if (savedEnv !== undefined) process.env.AIOS_PROVENANCE_PRIVATE_KEY = savedEnv;
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- server wiring ---------------------------------------------------------------------------------------------
const s = serverSource();
const boot = s.slice(s.indexOf('let provenanceKeys = null;'), s.indexOf('const signProvenance ='));
assert(/if \(_kp\.missing\)/.test(boot) && /SIGNING KEY MISSING/.test(boot) && /Nothing was regenerated/.test(boot), 'boot refuses to regenerate and says so loudly');
assert(/installProvenanceKey\(_kp\.privateKey, _kp\.publicKey\)/.test(boot) && /registerActive\(PROVENANCE_DIR/.test(s), 'the loaded key is registered in the keyring on every boot (how an env rotation registers itself)');
assert(/const signProvenance = \(payload\) => \(provenanceKeys \?/.test(s), 'signProvenance reads the CURRENT key at call time — rotation needs no restart');
const verifyRoute = s.slice(s.indexOf("app.post('/api/provenance/verify'"), s.indexOf("app.get('/.well-known/provenance-keys.json'"));
assert(/verifyWithKeyring\(sidecar, provenanceLib\.loadKeyring\(PROVENANCE_DIR\)\)/.test(verifyRoute) && !/sigKid === provenanceKeys\.publicKeyId/.test(verifyRoute), 'the verify route consults the keyring, not only the current kid');
const wk = s.slice(s.indexOf("app.get('/.well-known/provenance-keys.json'"), s.indexOf("app.get('/api/admin/provenance'"));
assert(/status: k\.status/.test(wk) && /retired_at/.test(wk) && /revoked_at/.test(wk), 'the well-known document lists every key with status and dates');
assert(/if \(!ring\.length && !provenanceKeys\) return res\.status\(503\)/.test(wk), '...and is served while the private key is missing (verification must not depend on it)');
for (const r of ['/api/admin/provenance/rotate', '/api/admin/provenance/revoke']) {
  assert(new RegExp(`app\\.post\\('${r.replace(/[/:]/g, (c) => '\\' + c)}', requireAdmin, requireHuman`).test(s), `${r} is human-only`);
}
assert(/sendNotification\('Provenance signing key rotated'/.test(s), 'rotation notifies the operator');
assert(/rebuild a site to re-sign it/.test(s), 'the notification states the re-sign-on-rebuild rule');
const pub = s.slice(s.indexOf("app.post('/api/library/record/:id/publish'"), s.indexOf("app.post('/api/library/record/:id/publish'") + 800);
assert(/if \(!provenanceKeys\)/.test(pub) && /MISSING/.test(pub), 'the library publish route distinguishes a MISSING key from provenance never being enabled');
const pipe = readRepoFile('lib/web-studio/pipeline.js');
assert(/if \(!credential\) return null;/.test(pipe.slice(pipe.indexOf('function writeProvenanceSidecar'))), 'the site pipeline writes NO sidecar when signing returns null (never an unsigned one)');
const backup = readRepoFile('deploy/backup.sh');
assert(/\.magent/.test(backup), 'deploy/backup.sh includes .magent, where the private key lives');
// The status route names the FILE PATH as a backup hint; what it must never do is read or export
// the key itself, so the check is for key-material access, not for the filename.
assert(!/private_key_pem|privateKey\.export|readFileSync\(|PRIVATE KEY/.test(s.slice(s.indexOf("app.get('/api/admin/provenance'"), s.indexOf("app.post('/api/admin/provenance/rotate'"))), 'the admin status route never reads or returns private key material');

done();
