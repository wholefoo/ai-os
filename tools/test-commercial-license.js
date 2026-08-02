// Tests commercial/lib/license-validator: only 64-bit signatures are accepted, and the removed
// legacy path cannot be revived by an env var.
//
// SKIPS when commercial/ is absent — the public core is checked out without it.
//
// Background: keys used to carry a 4-hex (16-bit) checksum, which is 65,536 possibilities and
// forgeable offline in the time it takes to write the loop. The hardened generator emits 16 hex
// chars, but validation kept accepting the short form unless AIOS_LICENSE_STRICT=true — so the
// weak path was live by default. It is now deleted rather than defaulted off, because an env var
// that re-opens a forgeable path is a switch someone flips while debugging and never flips back.
//
// Worth stating plainly, since these assertions are the only place it is enforced: for self-hosted
// software the runtime AND the signing secret are on the licensee's machine, so this is
// anti-casual-forgery, not a security boundary. The tests below are about the former.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assert, done } = require('./test-util');

const modPath = path.join(__dirname, '..', 'commercial', 'lib', 'license-validator.js');
if (!fs.existsSync(modPath)) {
  console.log('ok  : commercial/ not present (Community checkout) — licence suite skipped');
  done();
  return;
}

// A throwaway secret, set before the module loads: it reads SIGNING_SECRET at require time, and a
// test must never depend on (or reveal) the real one from .env.
process.env.AIOS_SIGNING_SECRET = 'test-only-secret-not-the-real-one';
const v = require(modPath);

// --- a freshly generated key round-trips ---------------------------------------------------------
for (const [code, tier] of [['ENT', 'enterprise'], ['BIZ', 'business']]) {
  const key = v.generateLicenseKey(code);
  const parts = key.split('-');
  assert(parts.length === 5 && parts[0] === 'AIOS', `${code}: the key has the documented five-part shape`);
  assert(parts[4].length === 16, `${code}: the signature is 16 hex chars (64-bit), not the old 4`);
  const r = v.validateLicenseKey(key);
  assert(r.valid === true && r.tier === tier, `${code}: it validates and reports the right tier`);
  assert(r.issuedAt instanceof Date && !Number.isNaN(r.issuedAt.getTime()), `${code}: and carries a real issue date`);
}

// --- the legacy form is refused, with an actionable message --------------------------------------
// Built by TRUNCATING a valid signature, so it is not merely a wrong checksum — it is what an
// actual pre-hardening key looked like, correctly signed as far as it goes.
const real = v.generateLicenseKey('ENT');
const [, tierCode, ts, rand, sig] = real.split('-');
const legacy = `AIOS-${tierCode}-${ts}-${rand}-${sig.slice(0, 4)}`;
const legacyResult = v.validateLicenseKey(legacy);
assert(legacyResult.valid === false, 'a correctly-signed 4-hex legacy key is REFUSED');
assert(/re-issue/i.test(legacyResult.error),
  '...and the error tells the holder what to do about it, rather than just "invalid"');

// --- no env var brings it back --------------------------------------------------------------------
// The point of deleting the branch rather than defaulting it off. If someone reintroduces the
// toggle, this fails.
for (const value of ['false', 'true', '0', '']) {
  process.env.AIOS_LICENSE_STRICT = value;
  assert(v.validateLicenseKey(legacy).valid === false,
    `AIOS_LICENSE_STRICT=${JSON.stringify(value)} does NOT re-open the legacy path — the branch is gone, not toggled`);
}
delete process.env.AIOS_LICENSE_STRICT;
assert(!/AIOS_LICENSE_STRICT/.test(fs.readFileSync(modPath, 'utf8').replace(/^\s*\/\/.*$/gm, '')),
  'and the variable appears nowhere in the module except in comments explaining its removal');

// --- tampering and malformed input ---------------------------------------------------------------
const tampered = `AIOS-${tierCode}-${ts}-${rand}-${'0'.repeat(16)}`;
assert(v.validateLicenseKey(tampered).valid === false, 'a wrong 16-hex signature is refused');

// Tier escalation — the forgery with an actual motive: turn a paid Business key into Enterprise.
// Generated as BIZ on purpose; an earlier version of this assertion edited an ENT key looking for
// "-BIZ-", found nothing, changed nothing, and passed while testing precisely zero.
const bizKey = v.generateLicenseKey('BIZ');
assert(v.validateLicenseKey(bizKey).tier === 'business', 'the BIZ key starts as business');
const escalated = bizKey.replace('-BIZ-', '-ENT-');
assert(escalated !== bizKey, 'the tier code was actually swapped (guard against a no-op edit)');
assert(v.validateLicenseKey(escalated).valid === false,
  'editing BIZ to ENT invalidates the signature — the tier is part of the signed payload, so a Business licensee cannot promote themselves');

// Lengths other than 16 must not reach timingSafeEqual, which THROWS on unequal buffers. A throw
// here would crash boot rather than refuse a key, so these assert "returns false", not "rejects".
for (const bad of [
  `AIOS-ENT-${ts}-${rand}-${sig.slice(0, 8)}`,      // 8 chars
  `AIOS-ENT-${ts}-${rand}-${sig}AA`,                 // 18 chars
  `AIOS-ENT-${ts}-${rand}-ZZZZZZZZZZZZZZZZ`,         // right length, not hex
  'AIOS-ENT-x-y',                                    // too few parts
  'AIOS-XXX-1-2-3',                                  // unknown tier
  'not-a-key', '', null, undefined, 42, {},
]) {
  let threw = false, res = null;
  try { res = v.validateLicenseKey(bad); } catch { threw = true; }
  assert(!threw, `${JSON.stringify(bad)} is REFUSED rather than throwing — a throw at boot takes the process down instead of falling back to Community`);
  assert(res.valid === false, `${JSON.stringify(bad)} is invalid`);
  assert(typeof res.error === 'string' && res.error.length > 0, `${JSON.stringify(bad)} explains why`);
}

// --- the signature genuinely depends on the secret ------------------------------------------------
// Proves the HMAC is doing work: the same payload under a different secret must not validate.
const otherSig = crypto.createHmac('sha256', 'a-different-secret')
  .update(`${tierCode}-${ts}-${rand}`).digest('hex').substring(0, 16).toUpperCase();
assert(v.validateLicenseKey(`AIOS-${tierCode}-${ts}-${rand}-${otherSig}`).valid === false,
  'a key signed with a different secret is refused — otherwise the signature is decoration');

done();
