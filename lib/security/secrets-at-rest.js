// Envelope encryption for secret fields in the JSON state files — SOC 2 gap item 12 (CC6.1/CC6.7).
//
// OPT-IN, and honest about what it is. The settings file has always been plaintext JSON, masked only
// in API responses, with a comment saying at-rest protection is the host's job. That stays true
// unless the operator sets AIOS_SECRETS_KEY. With it set, every secret-shaped string in the sealed
// stores (settings, email_secrets, integrations) is written as `enc:v1:<base64>` — AES-256-GCM,
// fresh 12-byte IV per value, 16-byte tag — and opened again on load. The live objects in memory
// are never encrypted; the model callers read plaintext exactly as before.
//
// WHAT THE KEY IS. AIOS_SECRETS_KEY is either 32 raw bytes (64 hex chars, or 44-char base64) or a
// passphrase of at least 16 characters, from which the key is derived with scrypt (N=2^15) and a
// fixed application salt. The fixed salt is a deliberate trade: there is exactly one key per
// instance and nothing to enumerate against, and it keeps the derivation reproducible across
// restarts without a second file to lose.
//
// WHAT LOSING IT MEANS, stated plainly because it is the reason this is opt-in: a sealed value
// cannot be opened without the key. On load, an undecryptable value becomes '' and its path is
// REPORTED (startup log + the settings API), so the failure is "this provider key needs re-entering"
// rather than a provider 401 nobody can explain. Nothing else in the file is affected.
//
// SECRET-SHAPED means the field NAME, not the value: `*_api_key`, `*_secret`, `*_token`, `token`,
// `password`, `unsubscribe` (the email unsubscribe HMAC secret). Names, because a value cannot be
// told from an id, and because a new provider key added tomorrow with the house naming is sealed
// without anyone remembering to list it. Public keys (`public_key_*`), ids and urls are not sealed.

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const SECRET_NAME = /(?:^|_)(api_key|secret|token|password|unsubscribe)$/i;
const NOT_SECRET = /^(public_key|.*_public_key|.*_id|.*_url)$/i;
const SALT = 'aios-secrets-at-rest-v1';

/** Derive the 32-byte key from the env value, or null when unset/unusable (with the reason). */
function keyFromEnv(raw) {
  const v = String(raw || '').trim();
  if (!v) return { key: null, reason: 'AIOS_SECRETS_KEY not set' };
  if (/^[0-9a-f]{64}$/i.test(v)) return { key: Buffer.from(v, 'hex'), reason: null, form: 'hex' };
  if (/^[A-Za-z0-9+/]{43}=$/.test(v) && Buffer.from(v, 'base64').length === 32) return { key: Buffer.from(v, 'base64'), reason: null, form: 'base64' };
  // N=2^15, r=8 needs 128*N*r = 33.5 MB; Node's default maxmem is 32 MB, so it is raised explicitly
  // rather than dropping N. Derivation runs once per boot.
  if (v.length >= 16) return { key: crypto.scryptSync(v, SALT, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }), reason: null, form: 'passphrase' };
  return { key: null, reason: 'AIOS_SECRETS_KEY must be 32 bytes (64 hex / 44 base64) or a passphrase of 16+ characters' };
}

const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);
const isSecretName = (name) => SECRET_NAME.test(name) && !NOT_SECRET.test(name);

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(sealed, key) {
  const buf = Buffer.from(String(sealed).slice(PREFIX.length), 'base64');
  if (buf.length < 28) throw new Error('sealed value too short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

/**
 * Deep copy of `data` with every secret-shaped non-empty string sealed. Already-sealed values are
 * left as they are, so a re-save never double-encrypts. Returns the input untouched when no key.
 */
function seal(data, key, _name = '') {
  if (!key) return data;
  if (Array.isArray(data)) return data.map((v) => seal(v, key, _name));
  if (data && typeof data === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = seal(v, key, k);
    return out;
  }
  if (typeof data === 'string' && data && isSecretName(_name) && !isSealed(data)) return encrypt(data, key);
  return data;
}

/**
 * Deep copy of `data` with sealed values opened. Values that cannot be opened (no key, wrong key,
 * tampered) become '' and are listed in `unreadable` by path. Non-sealed values pass through, so a
 * file written before encryption was enabled loads exactly as before.
 */
function open(data, key, _path = '', unreadable = []) {
  if (Array.isArray(data)) return data.map((v, i) => open(v, key, `${_path}[${i}]`, unreadable));
  if (data && typeof data === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = open(v, key, _path ? `${_path}.${k}` : k, unreadable);
    return out;
  }
  if (isSealed(data)) {
    if (!key) { unreadable.push(_path); return ''; }
    try { return decrypt(data, key); } catch { unreadable.push(_path); return ''; }
  }
  return data;
}

/** Count sealed values in a (raw, on-disk) object — for status reporting. */
function countSealed(data) {
  if (Array.isArray(data)) return data.reduce((n, v) => n + countSealed(v), 0);
  if (data && typeof data === 'object') return Object.values(data).reduce((n, v) => n + countSealed(v), 0);
  return isSealed(data) ? 1 : 0;
}

module.exports = { PREFIX, keyFromEnv, isSealed, isSecretName, encrypt, decrypt, seal, open, countSealed };
