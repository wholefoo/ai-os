// Scoped, rotatable, per-caller service keys — the replacement for handing every automation the
// one static API_TOKEN. SOC 2 gap item 11 (CC1.3 / CC6.1 / CC6.3): "give the static API_TOKEN a
// scoped, rotatable, per-caller-attributable identity; log its actions."
//
// Same construction as the A2A keys (server.js, `a2aKeys`), which already had the right shape:
// a random bearer token shown ONCE, only its SHA-256 stored, timing-safe comparison, revocation
// that never deletes the record (the audit trail keeps the label). What is new here is the SCOPE,
// which bounds what the key may reach through the general API:
//
//   read   GET/HEAD only. Dashboards, exporters, monitors.
//   agent  read + running work: agent/skill/pipeline execution, Hermes delegation, A2A. The
//          n8n-template case — a workflow that dispatches an agent must not be able to change a
//          setting, mint a key, or touch a user.
//   admin  everything the static token could do. Still a SERVICE principal: requireHuman refuses
//          it on approvals and mode changes exactly as it refuses the static token.
//
// A key is never a human. Whatever its scope, it cannot approve, retry, change the automation
// mode, request a deletion, or export a person — those routes check `session.service`.
//
// PURE. State (the key list) is passed in; the server owns persistence.

const crypto = require('crypto');

const PREFIX = 'aiossvc_';
const SCOPES = Object.freeze({
  read: 'GET and HEAD only',
  agent: 'read, plus running agents, skills, pipelines, Hermes delegation and A2A',
  admin: 'everything the static API token can do (never a human decision)',
});
const MAX_LABEL = 80;
const MAX_EXPIRY_DAYS = 365;

// What an `agent` key may POST to. Paths, not prefixes, so a new mutating route is closed to it
// until someone adds it here on purpose.
const AGENT_ALLOW = Object.freeze([
  /^\/api\/agent\/execute$/,
  /^\/api\/skills\/[^/]+\/execute$/,
  /^\/api\/pipelines\/[^/]+\/execute$/,
  /^\/api\/pipelines\/runs\/[^/]+\/(resume|export)$/,
  /^\/api\/hermes\/delegate$/,
  /^\/api\/a2a$/,
]);

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function hashEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** A fresh token. Shown once by the caller; only `sha256(token)` is ever stored. */
function mintToken() { return PREFIX + crypto.randomBytes(32).toString('hex'); }

/** Validate creation input. Returns { error } or { label, scope, expiresAt }. */
function validateNew({ label, scope, expiresInDays } = {}, now = Date.now()) {
  if (typeof label !== 'string' || !label.trim() || label.trim().length > MAX_LABEL) return { error: `label required (1–${MAX_LABEL} chars)` };
  if (!SCOPES[scope]) return { error: `scope must be one of: ${Object.keys(SCOPES).join(', ')}` };
  let expiresAt = null;
  if (expiresInDays !== undefined && expiresInDays !== null && expiresInDays !== '') {
    const d = Number(expiresInDays);
    if (!Number.isFinite(d) || d < 1 || d > MAX_EXPIRY_DAYS) return { error: `expiresInDays must be 1–${MAX_EXPIRY_DAYS}` };
    expiresAt = new Date(now + d * 86400000).toISOString();
  }
  return { label: label.trim(), scope, expiresAt };
}

/** Build a key record from validated input. Returns { key, token } — the token leaves this function once. */
function createKey({ id, label, scope, expiresAt, createdBy }, now = Date.now()) {
  const token = mintToken();
  const key = { id, label, scope, tokenHash: sha256(token), createdAt: new Date(now).toISOString(), createdBy: createdBy || null, expiresAt: expiresAt || null, lastUsedAt: null, revoked: false, revokedAt: null, rotatedFrom: null };
  return { key, token };
}

/** The live key for a bearer token, or null: unknown, revoked, expired, or not a service token at all. */
function findByToken(keys, token, now = Date.now()) {
  if (!token || typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  const h = sha256(token);
  const k = (keys || []).find((x) => x && !x.revoked && hashEq(x.tokenHash, h));
  if (!k) return null;
  if (k.expiresAt && new Date(k.expiresAt).getTime() <= now) return null;
  return k;
}

/** May this key make this request? `path` is the URL path without query. */
function decideScope(key, method, path) {
  const m = String(method || '').toUpperCase();
  const p = String(path || '').split('?')[0];
  if (!key || !SCOPES[key.scope]) return { allow: false, reason: 'unknown scope' };
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return { allow: true };
  if (key.scope === 'admin') return { allow: true };
  if (key.scope === 'agent' && AGENT_ALLOW.some((re) => re.test(p))) return { allow: true };
  return { allow: false, reason: `scope "${key.scope}" may not ${m} ${p}` };
}

/** What an admin sees. Never the hash. */
function publicView(k) {
  return { id: k.id, label: k.label, scope: k.scope, createdAt: k.createdAt, createdBy: k.createdBy, expiresAt: k.expiresAt, lastUsedAt: k.lastUsedAt, revoked: !!k.revoked, revokedAt: k.revokedAt || null, rotatedFrom: k.rotatedFrom || null };
}

module.exports = { PREFIX, SCOPES, sha256, validateNew, createKey, findByToken, decideScope, publicView };
