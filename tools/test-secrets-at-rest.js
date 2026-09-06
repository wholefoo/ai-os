// Secrets at rest (lib/security/secrets-at-rest.js) — SOC 2 gap item 12, opt-in.
//
// Pinned here: the key forms, that sealing is by field NAME and never touches ids/urls/public keys,
// that a re-save never double-encrypts, that loss of the key degrades to '' + a REPORTED path (not
// a provider 401 nobody can explain), that tampering is detected, and that with no key both
// directions are exact no-ops so a plaintext file from before loads unchanged.
const { assert, done, serverSource } = require('./test-util');
const S = require('../lib/security/secrets-at-rest');

// --- key forms ----------------------------------------------------------------------------------------
assert(S.keyFromEnv('').key === null && /not set/.test(S.keyFromEnv('').reason), 'unset → no key, reason says so');
assert(S.keyFromEnv('short').key === null && /16\+/.test(S.keyFromEnv('short').reason), 'a short passphrase is refused with the rule');
const hex = 'ab'.repeat(32);
assert(S.keyFromEnv(hex).form === 'hex' && S.keyFromEnv(hex).key.length === 32, '64 hex chars → 32-byte key');
const b64 = Buffer.alloc(32, 7).toString('base64');
assert(S.keyFromEnv(b64).form === 'base64' && S.keyFromEnv(b64).key.length === 32, '44-char base64 → 32-byte key');
const pp = S.keyFromEnv('correct horse battery staple');
assert(pp.form === 'passphrase' && pp.key.length === 32 && pp.key.equals(S.keyFromEnv('correct horse battery staple').key), 'a passphrase derives the SAME 32-byte key every time (fixed salt, scrypt)');
assert(!pp.key.equals(S.keyFromEnv('correct horse battery staples').key), '...and a different passphrase derives a different key');

// --- encrypt / decrypt -------------------------------------------------------------------------------------
const K = S.keyFromEnv(hex).key, K2 = S.keyFromEnv('cd'.repeat(32)).key;
const sealed = S.encrypt('sk-ant-secret-123', K);
assert(sealed.startsWith('enc:v1:') && S.decrypt(sealed, K) === 'sk-ant-secret-123', 'roundtrip');
assert(S.encrypt('x', K) !== S.encrypt('x', K), 'fresh IV per value — identical plaintexts seal differently');
let threw = false; try { S.decrypt(sealed, K2); } catch { threw = true; } assert(threw, 'wrong key → throws (GCM auth)');
threw = false; try { S.decrypt(sealed.slice(0, -4) + 'AAAA', K); } catch { threw = true; } assert(threw, 'tampered ciphertext → throws');
threw = false; try { S.decrypt('enc:v1:AAAA', K); } catch { threw = true; } assert(threw, 'truncated → throws, not garbage');

// --- what gets sealed: by NAME ---------------------------------------------------------------------------
for (const n of ['anthropic_api_key', 'livekit_api_secret', 'apify_api_token', 'token', 'password', 'unsubscribe', 'stripe_webhook_secret']) assert(S.isSecretName(n), `${n} is secret-shaped`);
for (const n of ['reasoning_mode', 'livekit_url', 'liveavatar_avatar_id', 'public_key_pem', 'provenance_public_key', 'demo_mode', 'cors_origin', 'label']) assert(!S.isSecretName(n), `${n} is NOT sealed`);

const settings = { ai: { reasoning_mode: 'balanced', anthropic_api_key: 'sk-ant-1', deepseek_api_key: '', livekit_url: 'wss://x', livekit_api_secret: 'lk-s' }, general: { demo_mode: false, api_token: 'tok' }, list: [{ token: 'a' }, { token: '' }] };
const out = S.seal(settings, K);
assert(out !== settings && out.ai !== settings.ai && settings.ai.anthropic_api_key === 'sk-ant-1', 'seal returns a deep COPY; the live object is untouched');
assert(S.isSealed(out.ai.anthropic_api_key) && S.isSealed(out.ai.livekit_api_secret) && S.isSealed(out.general.api_token) && S.isSealed(out.list[0].token), 'secret-shaped strings sealed, in nested objects and arrays');
assert(out.ai.reasoning_mode === 'balanced' && out.ai.livekit_url === 'wss://x' && out.general.demo_mode === false, 'non-secret fields untouched, non-strings untouched');
assert(out.ai.deepseek_api_key === '' && out.list[1].token === '', 'empty secrets stay empty (nothing to protect, and "" must still read as unconfigured)');
assert(S.countSealed(out) === 4, 'countSealed reports 4');
const again = S.seal(out, K);
assert(again.ai.anthropic_api_key === out.ai.anthropic_api_key, 'sealing an already-sealed copy is a no-op (no double encryption on re-save)');

// --- open ----------------------------------------------------------------------------------------------------
const un = [];
const back = S.open(out, K, 'settings', un);
assert(JSON.stringify(back) === JSON.stringify(settings) && un.length === 0, 'open(seal(x)) === x, nothing unreadable');
const lost = [];
const noKey = S.open(out, null, 'settings', lost);
assert(noKey.ai.anthropic_api_key === '' && noKey.ai.reasoning_mode === 'balanced' && JSON.stringify(lost) === JSON.stringify(['settings.ai.anthropic_api_key', 'settings.ai.livekit_api_secret', 'settings.general.api_token', 'settings.list[0].token']), `no key → sealed values become '' and every path is REPORTED: ${JSON.stringify(lost)}`);
const wrong = [];
S.open(out, K2, 'settings', wrong);
assert(wrong.length === 4, 'wrong key → same: 4 unreadable, reported');
const plainFile = { ai: { anthropic_api_key: 'plain-from-before' } };
assert(JSON.stringify(S.open(plainFile, K, 's', [])) === JSON.stringify(plainFile) && JSON.stringify(S.seal(plainFile, null)) === JSON.stringify(plainFile), 'a plaintext file opens unchanged; with no key seal is a no-op');
assert(S.open({ a: [] }, null, '', []).a.length === 0 && S.open(null, K, '', []) === null, 'empty / null shapes survive');

// --- server wiring ---------------------------------------------------------------------------------------------
const s = serverSource();
const block = s.slice(s.indexOf('// --- Secrets at rest (opt-in via AIOS_SECRETS_KEY'), s.indexOf('function saveState(key, data)'));
assert(/SEALED_STORES = new Set\(\['settings', 'email_secrets', 'integrations'\]\)/.test(block), 'exactly the three credential stores are sealed');
assert(s.indexOf('const secretsAtRest = require') < s.indexOf("const users = loadState('users'"), 'the secrets block is declared BEFORE the first state load (TDZ — the smoke boot caught the first placement)');
const save = s.slice(s.indexOf('function saveState(key, data)'), s.indexOf('function loadState(key, fallback)'));
assert(/const payload = SEALED_STORES\.has\(key\) \? secretsAtRest\.seal\(data, _secretsKey\.key\) : data;/.test(save) && /JSON\.stringify\(payload/.test(save), 'saveState seals a COPY and writes that; the live object is not mutated');
const load = s.slice(s.indexOf('function loadState(key, fallback)'), s.indexOf('function loadState(key, fallback)') + 2200);
assert(/secretsAtRest\.open\(data, _secretsKey\.key, key, unreadable\)/.test(load) && /secretsAtRestStatus\.unreadable\.push/.test(load) && /re-enter them in Settings, or restore the key/.test(load), 'loadState opens, records unreadable paths on the status object, and tells the operator what to do');
assert(/secrets_at_rest: \{/.test(s) && /Set AIOS_SECRETS_KEY/.test(s), 'GET /api/settings reports the at-rest status and how to enable it');
assert(/\[SECRETS\] at-rest encryption: \$\{secretsAtRestStatus\.enabled \? /.test(s), 'startup line states ON/OFF and why');
assert(!/are NOT encrypted at rest — at-rest protection is the operator's/.test(s) && /UNLESS the operator sets AIOS_SECRETS_KEY/.test(s), 'the settings comment now describes the real behaviour');

done();
