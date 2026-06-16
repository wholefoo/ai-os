// lib/crm/routes.js
// ============================================================
//  CRM HTTP API — Phase 1 (read-only). Mounted from server.js core (NOT a commercial
//  module) so it is available on ALL tiers, admin-only (requireAdmin). Site/contact
//  resolution reads the LIVE webStudioSites array passed in via ctx (never re-loadState
//  — that would read a stale copy).
// ============================================================

const repo = require('./repo');

function registerCrmRoutes(app, ctx) {
  const { requireAdmin, webStudioSites } = ctx;
  const sites = () => webStudioSites || [];

  // List / search / filter / paginate.
  app.get('/api/crm/contacts', requireAdmin, (req, res) => {
    const { q, stage, plan, flag, owner, tag, limit, offset, sort } = req.query;
    res.json(repo.contacts.page({ q, stage, plan, flag, owner, tag, limit, offset, sort }));
  });

  // Header stat cards.
  app.get('/api/crm/stats', requireAdmin, (req, res) => {
    res.json(repo.contacts.stats());
  });

  // Sites with no CRM contact link yet — the manual-linking worklist (legacy sites have
  // no owner field + often a null domain, so they auto-match nothing).
  app.get('/api/crm/unassigned-sites', requireAdmin, (req, res) => {
    const linked = repo.links.linkedSiteIds();
    const list = sites().filter((s) => s && s.id && !linked.has(s.id)).map((s) => ({
      id: s.id, name: s.name, domain: s.domain || null, status: s.status, createdAt: s.createdAt,
    }));
    res.json({ sites: list });
  });

  // One contact + its activity timeline + resolved linked sites.
  app.get('/api/crm/contacts/:id', requireAdmin, (req, res) => {
    const contact = repo.contacts.get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'not found' });
    const activities = repo.activities.forContact(contact.id);
    const linkedSites = repo.links.forContact(contact.id).map((l) => {
      const s = sites().find((x) => x.id === l.site_id);
      return s ? { id: s.id, name: s.name, domain: s.domain || l.domain, status: s.status, url: s.url || null }
        : null; // resolve-and-skip a site deleted out from under a stale link
    }).filter(Boolean);
    res.json({ contact, activities, sites: linkedSites });
  });
}

module.exports = { registerCrmRoutes };
