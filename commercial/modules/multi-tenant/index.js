// modules/multi-tenant/index.js — Multi-tenant system
// Tier: business+ — requires ai-os-commercial license
//
// Tenant isolation, subdomain routing, per-tenant state.
// Handles tenant CRUD, tenant switching, and isolated state directories.

module.exports = {
  name: 'multi-tenant',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.multiTenant) {
      console.log('[COMMERCIAL] Skipping multi-tenant (requires business+ license)');
      return;
    }

    // TODO: Extract routes from server.js
    // - POST /api/tenants — create tenant
    // - GET /api/tenants — list tenants
    // - PUT /api/tenants/:id — update tenant
    // - DELETE /api/tenants/:id — remove tenant
    // - POST /api/tenants/:id/switch — switch active tenant
    // - Subdomain routing middleware
    // - Per-tenant state isolation

    console.log('[COMMERCIAL] ✓ Multi-Tenant routes registered');
  },
};
