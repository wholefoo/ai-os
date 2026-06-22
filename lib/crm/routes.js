// lib/crm/routes.js
// ============================================================
//  CRM HTTP API. Mounted from server.js core (NOT a commercial module) so it is
//  available on ALL tiers, admin-only (requireAdmin). Site/contact resolution reads
//  the LIVE arrays passed in via ctx (never re-loadState — that reads a stale copy).
//    Phase 1: read (list/get/stats/unassigned-sites).
//    Phase 2: write (create/patch/notes/link-site/ingest-lead/sync).
// ============================================================

const repo = require('./repo');
const sync = require('./sync');

function registerCrmRoutes(app, ctx) {
  const { requireAdmin, webStudioSites, brandKits, broadcast = () => {}, users = [] } = ctx;
  const sites = () => webStudioSites || [];
  const kits = () => brandKits || [];
  const bump = (data) => { try { broadcast({ event: 'crm_update', data }); } catch {} };

  // ---------- reads ----------
  app.get('/api/crm/contacts', requireAdmin, (req, res) => {
    const { q, stage, plan, flag, owner, tag, limit, offset, sort } = req.query;
    res.json(repo.contacts.page({ q, stage, plan, flag, owner, tag, limit, offset, sort }));
  });

  app.get('/api/crm/stats', requireAdmin, (req, res) => {
    res.json(repo.contacts.stats());
  });

  app.get('/api/crm/unassigned-sites', requireAdmin, (req, res) => {
    const linked = repo.links.linkedSiteIds();
    const list = sites().filter((s) => s && s.id && !linked.has(s.id)).map((s) => ({
      id: s.id, name: s.name, domain: s.domain || null, status: s.status, createdAt: s.createdAt,
    }));
    res.json({ sites: list });
  });

  app.get('/api/crm/contacts/:id', requireAdmin, (req, res) => {
    const contact = repo.contacts.get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'not found' });
    const activities = repo.activities.forContact(contact.id);
    const linkedSites = repo.links.forContact(contact.id).map((l) => {
      const s = sites().find((x) => x.id === l.site_id);
      return s ? { id: s.id, name: s.name, domain: s.domain || l.domain, status: s.status, url: s.url || null } : null;
    }).filter(Boolean);
    // Also surface sites this contact OWNS by email (ownerEmail), even when never explicitly
    // linked — the domain-only sync misses client sites with no custom domain. Read-only union.
    const cEmail = String(contact.email || '').toLowerCase();
    const seenSiteIds = new Set(linkedSites.map((s) => s.id));
    for (const s of sites()) {
      if (s && s.id && !seenSiteIds.has(s.id) && s.ownerEmail && String(s.ownerEmail).toLowerCase() === cEmail) {
        linkedSites.push({ id: s.id, name: s.name, domain: s.domain || null, status: s.status, url: s.url || null });
        seenSiteIds.add(s.id);
      }
    }
    const ownedKits = kits().filter((k) => k && k.contactId === contact.id).map((k) => ({
      id: k.id, name: k.name, sourceUrl: k.sourceUrl || null, createdAt: k.createdAt,
    }));
    // Managed-client status, derived from the live users array (the contact row has no role/
    // managedPurchases). Drives the operator "Managed client" actions in the CRM detail panel.
    const u = (users || []).find((x) => x && x.email && String(x.email).toLowerCase() === cEmail);
    const managed = (u && u.role === 'client') ? {
      isClient: true,
      hasPassword: !!u.passwordHash,
      pendingInvite: !!u.setupToken,
      purchases: Array.isArray(u.managedPurchases) ? u.managedPurchases.length : 0,
    } : null;
    res.json({ contact, activities, sites: linkedSites, brandKits: ownedKits, managed });
  });

  // ---------- writes (Phase 2) ----------
  // Audit author ALWAYS comes from the authenticated session (requireAdmin sets req.session) — never
  // from a client-supplied body.author, which is spoofable. Every mutation logs an activity.
  const actorOf = (req) => (req.session && (req.session.email || req.session.name)) || 'admin';

  app.post('/api/crm/contacts', requireAdmin, (req, res) => {
    const { email, name, company, stage, owner, tags, source } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const id = repo.contacts.upsertByEmail({ email, name, company, stage, owner, tags, source: source || 'manual' });
    try { repo.activities.add({ contactId: id, type: 'system', body: 'Contact created', author: actorOf(req) }); } catch {}
    bump({ id });
    res.json({ ok: true, contact: repo.contacts.get(id) });
  });

  app.patch('/api/crm/contacts/:id', requireAdmin, (req, res) => {
    const before = repo.contacts.get(req.params.id);
    if (!before) return res.status(404).json({ error: 'not found' });
    const updated = repo.contacts.patch(req.params.id, req.body || {});
    const body = req.body || {};
    const author = actorOf(req);
    if (body.stage && body.stage !== before.stage) {
      repo.activities.add({ contactId: before.id, type: 'stage_change', body: `Stage: ${before.stage} → ${body.stage}`, author });
    }
    const changed = ['name', 'company', 'owner', 'tags', 'source'].filter((k) => body[k] !== undefined && String(body[k]) !== String(before[k] == null ? '' : before[k]));
    if (changed.length) {
      try { repo.activities.add({ contactId: before.id, type: 'note', body: `Edited ${changed.join(', ')}`, author }); } catch {}
    }
    bump({ id: before.id });
    res.json({ ok: true, contact: updated });
  });

  app.post('/api/crm/contacts/:id/notes', requireAdmin, (req, res) => {
    const c = repo.contacts.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const text = String((req.body || {}).body || '').trim();
    if (!text) return res.status(400).json({ error: 'note body required' });
    repo.activities.add({ contactId: c.id, type: 'note', body: text, author: actorOf(req) });
    bump({ id: c.id });
    res.json({ ok: true, activities: repo.activities.forContact(c.id) });
  });

  app.post('/api/crm/contacts/:id/link-site', requireAdmin, (req, res) => {
    const c = repo.contacts.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not found' });
    const s = sites().find((x) => x.id === (req.body || {}).siteId);
    if (!s) return res.status(400).json({ error: 'unknown siteId' });
    repo.links.add({ contactId: c.id, siteId: s.id, domain: s.domain || null });
    try { repo.activities.add({ contactId: c.id, type: 'system', body: `Linked site ${s.domain || s.id}`, author: actorOf(req) }); } catch {}
    bump({ id: c.id });
    res.json({ ok: true });
  });

  app.post('/api/crm/ingest-lead', requireAdmin, (req, res) => {
    const { email, name, domain, source } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email required' });
    const id = repo.contacts.upsertByEmail({ email, name, primary_domain: domain || undefined, is_lead: 1, source: source || 'manual' });
    bump({ id });
    res.json({ ok: true, id });
  });

  // Re-run the reconcilers from the JSON systems of record (refresh from sources).
  app.post('/api/crm/sync', requireAdmin, (req, res) => {
    const counts = sync.backfillAll({
      users: ctx.users || [], seoAudits: ctx.seoAudits || [],
      freeAuditLog: ctx.freeAuditLog || [], webStudioSites: webStudioSites || [],
    });
    bump({ synced: true });
    res.json({ ok: true, counts });
  });
}

module.exports = { registerCrmRoutes };
