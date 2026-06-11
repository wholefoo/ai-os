// modules/white-label/index.js — White-label license management
// Tier: enterprise — requires ai-os-commercial license
//
// License participant management, stats, and admin routes
// for the white-label licensing program.

const { defaultTenantSettings } = require('../../../lib/default-settings');

module.exports = {
  name: 'white-label',
  tier: 'enterprise',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.whiteLabel) {
      console.log('[COMMERCIAL] Skipping white-label (requires enterprise license)');
      return;
    }

    const { requireAdmin, broadcast, logActivity, uuidv4, saveState,
            licenses, tenantRegistry, LICENSE_CONFIG,
            ensureTenantDir, saveTenantState,
            MASTER_TENANT_ID, DEMO_MODE } = ctx;

    // GET /api/license/participants — admin list of all franchise participants
    app.get('/api/license/participants', requireAdmin, (req, res) => {
      res.json(licenses);
    });

    // GET /api/license/participant/:id — single participant detail
    app.get('/api/license/participant/:id', requireAdmin, (req, res) => {
      const f = licenses.find(p => p.id === req.params.id);
      if (!f) return res.status(404).json({ error: 'Participant not found' });
      res.json(f);
    });

    // PUT /api/license/participant/:id — admin update participant (approve, reject, activate, notes)
    app.put('/api/license/participant/:id', requireAdmin, (req, res) => {
      const f = licenses.find(p => p.id === req.params.id);
      if (!f) return res.status(404).json({ error: 'Participant not found' });

      const { status, notes, territory, instanceUrl } = req.body;

      if (status) {
        const validTransitions = {
          pending: ['approved', 'rejected'],
          approved: ['payment', 'rejected'],
          payment: ['active', 'rejected'],
          active: ['suspended'],
          suspended: ['active'],
          rejected: ['pending'],
        };
        if (!validTransitions[f.status]?.includes(status)) {
          return res.status(400).json({ error: `Cannot transition from ${f.status} to ${status}` });
        }
        f.status = status;
        if (status === 'approved') f.approvedAt = new Date().toISOString();
        if (status === 'active') {
          f.activatedAt = new Date().toISOString();

          // Auto-provision tenant for newly activated license
          if (!f.tenantId) {
            const tenantId = uuidv4().substring(0, 12);
            const subdomain = (f.company || f.name).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').substring(0, 20);
            const tenant = {
              id: tenantId,
              name: f.company || f.name,
              domain: null,
              subdomain,
              ownerId: f.email,
              plan: 'franchise',
              status: 'active',
              branding: {
                companyName: f.company || f.name,
                tagline: 'Powered by AI OS',
                logo: null,
                primaryColor: '#3b82f6',
                accentColor: '#8b5cf6',
              },
              industry: f.industry || null,
              template: null,
              createdAt: new Date().toISOString(),
              franchiseId: f.id,
            };

            ensureTenantDir(tenantId);
            // Seed tenant admin
            saveTenantState(tenantId, 'users', [{
              email: f.email, passwordHash: null, plan: 'franchise', role: 'admin', tenantId, createdAt: new Date().toISOString(),
            }]);
            // Seed empty settings
            saveTenantState(tenantId, 'settings', defaultTenantSettings());

            tenantRegistry[tenantId] = tenant;
            saveState('tenant_registry', tenantRegistry);

            f.tenantId = tenantId;
            f.instanceUrl = `https://${subdomain}.${tenantRegistry[MASTER_TENANT_ID]?.domain || 'aiosorchestrationlab.com'}`;

            logActivity('license', `Tenant auto-provisioned for ${f.name}: ${tenantId} (${subdomain})`, { franchiseId: f.id, tenantId });
            broadcast({ event: 'tenant_provisioned', data: { id: tenantId, name: tenant.name, subdomain, franchiseId: f.id } });
          }
        }
      }

      if (notes !== undefined) f.notes = notes;
      if (territory) f.territory = territory;
      if (instanceUrl) f.instanceUrl = instanceUrl;

      saveState('licenses', licenses);
      logActivity('license', `Franchise ${f.status}: ${f.name} (${f.email})`, { id: f.id, status: f.status });
      broadcast({ event: 'license_updated', data: { id: f.id, status: f.status, name: f.name } });

      res.json({ ok: true, participant: f });
    });

    // GET /api/license/stats — license program stats
    app.get('/api/license/stats', requireAdmin, (req, res) => {
      const byStatus = {};
      licenses.forEach(f => { byStatus[f.status] = (byStatus[f.status] || 0) + 1; });

      const active = byStatus.active || 0;
      const revenue = active * LICENSE_CONFIG.tiers.lifetime.price;
      const remaining = LICENSE_CONFIG.maxLifetime - active - (byStatus.pending || 0) - (byStatus.approved || 0) - (byStatus.payment || 0);

      res.json({
        total: licenses.length,
        byStatus,
        active,
        remaining: Math.max(0, remaining),
        maxParticipants: LICENSE_CONFIG.maxLifetime,
        fee: LICENSE_CONFIG.tiers.lifetime.price,
        totalRevenue: revenue,
        projectedRevenue: LICENSE_CONFIG.maxLifetime * LICENSE_CONFIG.tiers.lifetime.price,
        fillRate: Math.round((active / LICENSE_CONFIG.maxLifetime) * 100),
      });
    });

    console.log('[COMMERCIAL] ✓ White Label routes registered');
  },
};
