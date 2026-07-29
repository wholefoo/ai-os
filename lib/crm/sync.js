// lib/crm/sync.js
// ============================================================
//  Reconcilers: READ the live platform JSON arrays (users / seoAudits / freeAuditLog /
//  webStudioSites) and upsert/enrich CRM contacts. They only WRITE the CRM tables —
//  never the JSON. Idempotent and re-runnable: upserts MERGE, activities are deduped,
//  stage only ever ADVANCES. Used by the one-time/boot backfill and (Phase 2) the live
//  seams that fire on free-audit / Stripe / site events.
// ============================================================

const repo = require('./repo');

// Funnel order. churned is terminal/manual — ranked high so auto-advance never overwrites
// it, and it is never an auto-advance target.
const STAGE_RANK = { lead: 0, audited: 1, onboarding: 2, customer: 3, churned: 5 };
function advanceStage(email, target) {
  const c = repo.contacts.findByEmail(email);
  if (!c) return;
  if ((STAGE_RANK[target] ?? 0) > (STAGE_RANK[c.stage] ?? 0)) {
    repo.contacts.upsertByEmail({ email, stage: target });
  }
}

function syncFromLeads(freeAuditLog = []) {
  let n = 0;
  for (const lead of freeAuditLog) {
    if (!lead || !lead.email) continue;
    repo.contacts.upsertByEmail({
      email: lead.email,
      name: lead.name || undefined,
      primary_domain: lead.domain || undefined,
      is_lead: 1,
      source: 'free-audit',
    });
    n++;
  }
  return n;
}

function syncFromAudits(seoAudits = []) {
  let n = 0;
  for (const a of seoAudits) {
    if (!a || !a.email) continue;
    repo.contacts.upsertByEmail({
      email: a.email,
      is_lead: 1,
      audit_score: a.compositeScore == null ? undefined : a.compositeScore,
      primary_domain: a.domain || undefined,
    });
    if (a.compositeScore != null && a.id) {
      const c = repo.contacts.findByEmail(a.email);
      if (c) repo.activities.add({
        contactId: c.id, type: 'audit',
        body: `SEO audit: ${a.domain || ''} scored ${a.compositeScore}`,
        meta: { auditId: a.id, score: a.compositeScore, domain: a.domain },
        author: 'system', dedupeKey: `audit:${a.id}`,
      });
    }
    advanceStage(a.email, 'audited');
    n++;
  }
  return n;
}

function syncFromUsers(users = []) {
  let n = 0;
  for (const u of users) {
    if (!u || !u.email) continue;
    const isLicense = u.plan === 'business' || u.plan === 'enterprise';
    repo.contacts.upsertByEmail({
      email: u.email,
      user_id: u.id || undefined,
      plan: u.plan || 'free',
      stripe_customer_id: u.stripeCustomerId || undefined,
      purchased_at: u.purchasedAt || undefined,
      is_license: isLicense ? 1 : 0,
      source: 'stripe',
    });
    if (u.plan && u.plan !== 'free') advanceStage(u.email, 'customer');
    n++;
  }
  return n;
}

function syncFromSites(webStudioSites = []) {
  // Match each site to a contact by ownerEmail first (the reliable key — stamped server-side
  // on every site since the client-workspace work), then fall back to domain. Anything still
  // unmatched surfaces in the dashboard "unassigned sites" worklist for manual linking.
  let linked = 0;
  for (const site of webStudioSites) {
    if (!site || !site.id) continue;
    let c = site.ownerEmail ? repo.contacts.findByEmail(site.ownerEmail) : null;
    if (!c && site.domain) c = repo.contacts.findByDomain(site.domain);
    if (c) { repo.links.add({ contactId: c.id, siteId: site.id, domain: site.domain || null }); linked++; }
  }
  return linked;
}

function backfillAll(sources = {}) {
  const leads = syncFromLeads(sources.freeAuditLog || []);
  const audits = syncFromAudits(sources.seoAudits || []);
  const users = syncFromUsers(sources.users || []);
  const sitesLinked = syncFromSites(sources.webStudioSites || []);
  return { leads, audits, users, sitesLinked };
}

module.exports = { backfillAll, syncFromLeads, syncFromAudits, syncFromUsers, syncFromSites, advanceStage };
