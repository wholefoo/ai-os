// lib/crm/index.js
// ============================================================
//  Public CRM facade. server.js requires THIS (one handle) and calls the single-record
//  live seams from its existing flows (free-audit / Stripe / audit / site).
//
//  Every live seam is wrapped: it no-ops until the DB is open and swallows its own
//  errors, so a CRM hiccup can NEVER break a core flow (a purchase still completes, a
//  free audit still runs) — the CRM is strictly additive. The reconcilers/repo are
//  re-exported for the routes + boot backfill.
// ============================================================

const db = require('./db');
const repo = require('./repo');
const sync = require('./sync');
const { registerCrmRoutes } = require('./routes');

let _ready = false;
function openDb(p) { db.openDb(p); _ready = true; }

function _safe(label, fn) {
  return (...args) => {
    if (!_ready) return null;
    try { return fn(...args); }
    catch (e) { try { console.error(`[crm] ${label}:`, e.message); } catch {} return null; }
  };
}

// Free-audit (and manual/bulk) lead capture — idempotent upsert by email.
const ingestLead = _safe('ingestLead', ({ email, name, domain, source = 'free-audit' } = {}) => {
  if (!email) return null;
  return repo.contacts.upsertByEmail({ email, name: name || undefined, primary_domain: domain || undefined, is_lead: 1, source });
});

// SEO audit finished — enrich the contact + log a deduped audit activity.
const attachAudit = _safe('attachAudit', ({ email, auditId, compositeScore, domain } = {}) => {
  if (!email) return null;
  repo.contacts.upsertByEmail({ email, is_lead: 1, audit_score: compositeScore == null ? undefined : compositeScore, primary_domain: domain || undefined });
  const c = repo.contacts.findByEmail(email);
  if (c && compositeScore != null && auditId) {
    repo.activities.add({ contactId: c.id, type: 'audit', body: `SEO audit: ${domain || ''} scored ${compositeScore}`, meta: { auditId, score: compositeScore, domain }, author: 'system', dedupeKey: `audit:${auditId}` });
  }
  sync.advanceStage(email, 'audited');
  return c ? c.id : null;
});

// Stripe purchase fulfilled — mirror plan/license, log a deduped purchase, advance stage.
const syncUser = _safe('syncUser', (user, { sessionId } = {}) => {
  if (!user || !user.email) return null;
  const isLicense = user.plan === 'business' || user.plan === 'enterprise';
  repo.contacts.upsertByEmail({
    email: user.email, user_id: user.id || undefined, plan: user.plan || 'free',
    stripe_customer_id: user.stripeCustomerId || undefined, purchased_at: user.purchasedAt || undefined,
    is_license: isLicense ? 1 : 0, source: 'stripe',
  });
  const c = repo.contacts.findByEmail(user.email);
  if (c) repo.activities.add({ contactId: c.id, type: 'purchase', body: `Purchase: ${user.plan}`, meta: { plan: user.plan, sessionId }, author: 'system', dedupeKey: sessionId ? `purchase:${sessionId}` : null });
  if (user.plan && user.plan !== 'free') sync.advanceStage(user.email, 'customer');
  return c ? c.id : null;
});

// Link / unlink a hosted site to a contact (by explicit id, or auto by domain).
const linkSite = _safe('linkSite', ({ contactId, clientId, siteId, domain } = {}) => {
  let cid = contactId || clientId;
  if (!cid && domain) { const c = repo.contacts.findByDomain(domain); if (c) cid = c.id; }
  if (!cid || !siteId) return false;
  repo.links.add({ contactId: cid, siteId, domain: domain || null });
  return true;
});
const unlinkSite = _safe('unlinkSite', (siteId) => { if (siteId) repo.links.unlinkSite(siteId); return true; });

// Per-site leads inbox (Manage tab). Ownership is enforced by the CALLER (wsFindSite) — this
// only scopes by siteId. Returns [] when the CRM is down so the dashboard degrades gracefully.
const leadsForSite = _safe('leadsForSite', (siteId, limit) => repo.activities.leadsForSite(siteId, limit));

function backfillAll(sources) {
  if (!_ready) return null;
  try { return sync.backfillAll(sources); } catch (e) { console.error('[crm] backfill:', e.message); return null; }
}

module.exports = {
  openDb, registerCrmRoutes, backfillAll,
  ingestLead, attachAudit, syncUser, linkSite, unlinkSite, leadsForSite,
  isReady: () => _ready, repo, sync,
};
