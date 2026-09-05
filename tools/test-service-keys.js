// Scoped service keys (lib/security/service-keys.js) — SOC 2 gap item 11.
//
// The static API_TOKEN is one credential for every automation: unscoped, unrotatable, and
// unattributable (every action reads "service@api-token"). This pins the replacement: hashed at
// rest, shown once, three scopes enforced by path AND method, expiry, rotation that revokes the
// old key in the same step, and a chain from new key to old. Behaviour is proven live in the
// commit's isolated-instance run; the shape and the pure decisions are pinned here.
const { assert, done, serverSource } = require('./test-util');
const K = require('../lib/security/service-keys');

// --- minting and lookup ----------------------------------------------------------------------------
const T0 = Date.parse('2026-09-05T00:00:00Z');
const v = K.validateNew({ label: '  n8n lead sync ', scope: 'agent', expiresInDays: 30 }, T0);
assert(!v.error && v.label === 'n8n lead sync' && v.scope === 'agent' && v.expiresAt === '2026-10-05T00:00:00.000Z', 'validateNew trims the label and computes expiry');
assert(K.validateNew({ label: '', scope: 'read' }).error, 'empty label refused');
assert(K.validateNew({ label: 'x'.repeat(81), scope: 'read' }).error, 'label over 80 refused');
assert(K.validateNew({ label: 'x', scope: 'root' }).error, 'unknown scope refused');
assert(K.validateNew({ label: 'x', scope: 'read', expiresInDays: 0 }).error && K.validateNew({ label: 'x', scope: 'read', expiresInDays: 366 }).error, 'expiry must be 1–365 days');
assert(!K.validateNew({ label: 'x', scope: 'read' }).error && K.validateNew({ label: 'x', scope: 'read' }).expiresAt === null, 'no expiry is allowed and explicit');

const { key, token } = K.createKey({ id: 'k1', ...v, createdBy: 'admin@x' }, T0);
assert(token.startsWith(K.PREFIX) && token.length === K.PREFIX.length + 64, 'token is the prefix + 64 hex chars (32 random bytes)');
assert(key.tokenHash === K.sha256(token) && !('token' in key), 'only the hash is stored on the record');
assert(!JSON.stringify(K.publicView(key)).includes(key.tokenHash), 'publicView never carries the hash');
const keys = [key];
assert(K.findByToken(keys, token, T0) === key, 'the token finds its key');
assert(K.findByToken(keys, token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'), T0) === null, 'one changed character finds nothing');
assert(K.findByToken(keys, 'aiosa2a_' + 'f'.repeat(64), T0) === null, 'an A2A-prefixed token is not a service key');
assert(K.findByToken(keys, token, Date.parse('2026-10-05T00:00:00Z')) === null, 'expired at exactly expiresAt');
assert(K.findByToken(keys, token, Date.parse('2026-10-04T23:59:59Z')) === key, 'still valid one second before');
key.revoked = true;
assert(K.findByToken(keys, token, T0) === null, 'a revoked key is not found — the record stays for the audit trail');
key.revoked = false;

// --- the scope matrix ------------------------------------------------------------------------------
const d = (scope, method, path) => K.decideScope({ scope }, method, path).allow;
for (const scope of ['read', 'agent', 'admin']) {
  assert(d(scope, 'GET', '/api/settings') && d(scope, 'HEAD', '/api/health'), `${scope}: GET/HEAD allowed`);
}
assert(!d('read', 'POST', '/api/agent/execute') && !d('read', 'PUT', '/api/settings/ai') && !d('read', 'DELETE', '/api/org/members/x'), 'read: every mutation refused');
assert(d('agent', 'POST', '/api/agent/execute') && d('agent', 'POST', '/api/skills/seo-audit/execute') && d('agent', 'POST', '/api/pipelines/daily-brief/execute') && d('agent', 'POST', '/api/pipelines/runs/abc/resume') && d('agent', 'POST', '/api/pipelines/runs/abc/export') && d('agent', 'POST', '/api/hermes/delegate') && d('agent', 'POST', '/api/a2a'), 'agent: the work routes are allowed');
assert(!d('agent', 'POST', '/api/pipelines/runs/abc/approve') && !d('agent', 'PUT', '/api/settings/automation') && !d('agent', 'POST', '/api/admin/service-keys') && !d('agent', 'POST', '/api/org/members') && !d('agent', 'DELETE', '/api/a2a/keys/x'), 'agent: approvals, settings, keys, users refused');
assert(!d('agent', 'POST', '/api/agent/execute/extra') && !d('agent', 'POST', '/api/agent/executeX'), 'agent allowlist is exact paths, not prefixes');
assert(d('agent', 'POST', '/api/agent/execute?dry=1'), 'a query string does not defeat the match');
assert(d('admin', 'PUT', '/api/settings/ai') && d('admin', 'POST', '/api/org/members'), 'admin: mutations allowed by scope (human-only routes still refuse via session.service)');
assert(!K.decideScope({ scope: 'nope' }, 'GET', '/api/x').allow && !K.decideScope(null, 'GET', '/api/x').allow, 'an unknown scope or no key allows nothing');
assert(/may not POST \/api\/agent\/execute/.test(K.decideScope({ scope: 'read' }, 'POST', '/api/agent/execute').reason), 'the refusal names method and path');

// --- server wiring -----------------------------------------------------------------------------------
const s = serverSource();
const auth = s.slice(s.indexOf('function authMiddleware('), s.indexOf("app.use('/api/', authMiddleware);"));
assert(/serviceKeyFor\(bearerToken\)/.test(auth) && /req\.isServiceToken = true; req\.serviceKey = sk;/.test(auth), 'authMiddleware accepts a service key and marks it as service');
assert(auth.indexOf('bearerToken === API_TOKEN') < auth.indexOf('serviceKeyFor(bearerToken)'), 'the static token is checked first (it is not prefixed; a key is)');
assert(/sk\.lastUsedAt\.slice\(0, 10\) !== day/.test(auth), 'lastUsedAt is persisted once a day, not once a request');
const guard = s.slice(s.indexOf("app.use('/api/', authMiddleware);"), s.indexOf("app.use('/api/', require('./lib/security/csrf')"));
assert(/serviceKeys\.decideScope\(req\.serviceKey, req\.method, req\.originalUrl\)/.test(guard) && /status\(403\)/.test(guard), 'the scope guard runs right after auth and refuses with 403');
assert(/Refused: service key "\$\{req\.serviceKey\.label\}" out of scope/.test(guard), 'out-of-scope attempts are logged with the label');
assert(/Service key "\$\{req\.serviceKey\.label\}": \$\{req\.method\}/.test(guard) && /req\.method !== 'GET'/.test(guard), 'every MUTATION by a key is logged with the label; reads are not');
const rs = s.slice(s.indexOf('function resolveSession('), s.indexOf('function requireAdmin('));
assert(/email: `service:\$\{sk\.label\}`, plan: 'enterprise', role: 'admin', service: true, serviceKey:/.test(rs), 'resolveSession yields a NAMED service principal — actor fields carry the label');
for (const r of ['/api/admin/service-keys', '/api/admin/service-keys/:id/revoke', '/api/admin/service-keys/:id/rotate']) {
  assert(new RegExp(`app\\.post\\('${r.replace(/[/:]/g, (c) => '\\' + c)}', requireAdmin, requireHuman`).test(s), `${r} is human-only`);
}
assert(/app\.get\('\/api\/admin\/service-keys', requireAdmin, \(req/.test(s), 'listing is admin-readable (public views only)');
const rot = s.slice(s.indexOf("app.post('/api/admin/service-keys/:id/rotate'"), s.indexOf("app.get('/api/admin/retention'"));
assert(/key\.rotatedFrom = old\.id/.test(rot) && /old\.revoked = true/.test(rot) && rot.indexOf('old.revoked = true') < rot.indexOf('saveServiceKeys()'), 'rotate issues the new key, revokes the old, links them, persists once');
assert(/cannot rotate a revoked key/.test(rot), 'a revoked key cannot be rotated (mint a new one)');
const ws = s.slice(s.indexOf('function wsCredential('), s.indexOf('function wsHasQueryToken('));
assert(/sk\.scope === 'admin' \? \{ kind: 'api-token' \} : \{ kind: 'service-key', session: null \}/.test(ws), 'WebSocket: admin-scope key is an operator socket; other scopes are least-privilege');
assert(/master credential\. Prefer scoped service keys/.test(s), 'startup names the static token as a master credential and points at service keys');

done();
