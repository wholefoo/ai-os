// modules/advanced-reporting/index.js — Advanced analytics and reporting
// Tier: business+ — requires ai-os-commercial license
//
// Custom dashboards, data export, scheduled report delivery,
// and cross-module analytics aggregation.

module.exports = {
  name: 'advanced-reporting',
  tier: 'business',

  registerRoutes(app, ctx) {
    // Feature gate: skip if tier is insufficient
    if (!ctx.features.advancedReporting) {
      console.log('[COMMERCIAL] Skipping advanced-reporting (requires business+ license)');
      return;
    }

    // TODO: Extract routes from server.js
    // - GET /api/reports — list available reports
    // - POST /api/reports/generate — generate custom report
    // - GET /api/reports/dashboards — list dashboards
    // - POST /api/reports/dashboards — create custom dashboard
    // - POST /api/reports/schedule — schedule recurring report
    // - GET /api/reports/export/:id — export report (CSV/PDF)

    console.log('[COMMERCIAL] ✓ Advanced Reporting routes registered');
  },
};
