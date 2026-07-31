// Tests the P3 retention surface: how destroying a company record is classified, and the two
// invariants that must hold even when nobody is watching.
//
// The classification is not decoration. `library.delete-record` is 'critical' but deliberately NOT
// in ALWAYS_GATE (design doc D-ALWAYSGATE), which means in 'auto' mode the gate lets it through
// unattended. These assertions pin that down BECAUSE it is the uncomfortable half: if someone later
// assumes the gate always asks, the legalHold refusal in the executor is the only thing left, and
// they need to know that from the tests rather than from an incident.
const approval = require('../lib/safety/approval');
const readers = require('../lib/library/readers');
const catalog = require('../lib/library/catalog');
const { assert, done } = require('./test-util');

const H = 'a'.repeat(64);
const DESTRUCTIVE = ['library.delete-record', 'library.retention-dispose'];

// --- classification ------------------------------------------------------------------------------
for (const type of DESTRUCTIVE) {
  assert(approval.decide(type, 'manual').allow === false, `${type} is gated in manual mode`);
  assert(approval.decide(type, 'supervised').allow === false, `${type} is gated in supervised mode — the default`);
  assert(approval.decide(type, 'supervised').risk === 'critical', `${type} is classified critical, matching web-studio.delete-site`);

  // The uncomfortable one, asserted on purpose.
  assert(approval.decide(type, 'auto').allow === true,
    `${type} RUNS UNATTENDED in auto mode — it is critical but not in ALWAYS_GATE (D-ALWAYSGATE), so the executor's legalHold refusal is the last line, not a redundancy`);
}

// A destructive action must never be less guarded than a site teardown, the precedent it was
// modelled on. Asserted BEHAVIOURALLY — "is never allowed in a mode where the precedent is refused"
// — rather than by comparing internal risk levels. The module exports only { MODES, decide }, and a
// test that reached for a numeric level would both fail today and break the moment the scale is
// re-tuned. What matters is the guarantee, not the number behind it.
for (const type of DESTRUCTIVE) {
  for (const mode of Object.keys(approval.MODES)) {
    const precedent = approval.decide('web-studio.delete-site', mode);
    const mine = approval.decide(type, mode);
    assert(!(mine.allow && !precedent.allow),
      `${type} is never auto-allowed in '${mode}' mode where web-studio.delete-site is not`);
  }
}

// --- the record shape the executors depend on ----------------------------------------------------
const held = catalog.normalizeRecord({ title: 'Contract', store: 'org-docs', contentHash: H, source: 'company-doc', legalHold: true });
const free = catalog.normalizeRecord({ title: 'Notes', store: 'org-docs', contentHash: H, source: 'company-doc' });
assert(held.legalHold === true && free.legalHold === false, 'legalHold survives normalisation in both directions');
assert(catalog.normalizeRecord({ legalHold: 'yes' }).legalHold === false,
  "a truthy-but-not-true legalHold is FALSE — a string 'yes' must not be mistaken for a hold, and the strict === true is what makes the executor's check trustworthy");

assert(catalog.RETENTION_POLICIES.includes('keep') && catalog.RETENTION_POLICIES.includes('expire'),
  'the retention vocabulary the dispose route reads is the catalog\'s own');
assert(catalog.normalizeRecord({}).retention.policy === 'keep',
  'and an unlabelled record defaults to keep — dispose refuses it, so an un-curated record cannot be disposed by policy');

// --- provenance: a published record must be verifiable, not merely stamped -----------------------
const provenance = require('../lib/provenance');
// An EPHEMERAL keypair, not ensureKeypair(dir): a test must not read, create or depend on the
// instance's real signing key, and generating one here keeps the assertion about the sign/verify
// contract rather than about what happens to be on this disk.
const { privateKey, publicKey } = require('crypto').generateKeyPairSync('ed25519');
const sidecar = provenance.sign({
  claim_generator: 'AI OS Knowledge & Records',
  record_id: 'rec-1',
  content_hash: H,
}, privateKey, { publicKeyId: 'test-key' });

assert(sidecar.signature && sidecar.signature.alg === 'Ed25519', 'the sidecar is Ed25519-signed');
const v = provenance.verify(sidecar, publicKey);
assert(v.ok === true, 'and verifies against the instance public key — "signed" is worth nothing if it cannot be checked');

const tampered = { ...sidecar, content_hash: 'b'.repeat(64) };
assert(provenance.verify(tampered, publicKey).ok === false,
  'altering the content hash breaks verification — which is the entire point of signing the hash rather than the title');

// --- the operator override still stops at contributions, with retention in the mix ---------------
const contributed = catalog.normalizeRecord({
  title: 'Handover', store: 'org-docs', contentHash: H, source: 'personnel-contribution',
  retention: { policy: 'expire' },
});
assert(readers.operatorMayOverride(contributed) === false,
  'a contribution stays unreadable by the operator override even when its retention policy invites disposal — retention and readability are different questions');

done();
